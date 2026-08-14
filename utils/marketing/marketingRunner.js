const User = require("../../models/User");
const MarketingSend = require("../../models/MarketingSend");
const { sendRaw } = require("../emailService");
const { BATCH, BUSINESS, TIMEZONE, marketingEnabled } = require("./marketingConfig");
const { BY_ID } = require("./marketingLibrary");
const { buildProfile, personEligible, templateEligible } = require("./marketingEligibility");
const {
  annualPricingHealthy,
  inSendWindow,
  selectCampaign,
} = require("./marketingScheduler");
const { renderMarketingEmail } = require("./marketingRenderer");

/**
 * The marketing send cycle.
 *
 * One run: find candidates, choose a campaign for each, claim it, re-check
 * everything, send, record. Nothing here decides policy; it executes what the
 * scheduler chose, and refuses when the world has changed underneath it.
 *
 * The same function backs the cron and the dry run, so what the dry run reports
 * is what production would actually do rather than an approximation of it.
 */

function log(level, event, payload = {}) {
  const line = JSON.stringify({ level, event, scope: "marketing", ...payload });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Emails are personal data. Enough to trace a send, not enough to leak a list. */
function maskEmail(email) {
  const [local, domain] = String(email || "").split("@");
  if (!domain) return "invalid";
  return `${local.slice(0, 2)}***@${domain}`;
}

function startOfLocalDay(now = new Date()) {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  // Midnight New York is 04:00 or 05:00 UTC; a small overshoot only ever makes
  // the daily cap stricter, which is the safe direction to be wrong in.
  return new Date(`${ymd}T00:00:00-05:00`);
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A claim left behind by a dying process is released after this long. */
const STALE_CLAIM_MS = 15 * 60 * 1000;

/**
 * Who might get an email in this run.
 *
 * Anybody who heard from marketing in the last 7 days is removed in the query
 * rather than the loop, because the frequency cap disqualifies most of the
 * database most of the time and there is no point building profiles for them.
 * personEligible checks the cap again anyway; this is only an optimisation.
 */
async function findCandidates(now, limit) {
  const recentlyMailed = await MarketingSend.distinct("user", {
    status: { $in: ["sent", "claimed"] },
    createdAt: { $gte: new Date(now.getTime() - 7 * DAY_MS) },
  });

  return User.find({
    _id: { $nin: recentlyMailed },
    // $in with null matches records where the field is absent too, which is how
    // the legacy accounts that predate the role field get included.
    role: { $in: ["customer", null] },
    isActive: { $ne: false },
    employeePosition: { $in: [null, ""] },
    email: { $regex: /.+@.+\..+/ },
    // Nobody hears from marketing on the day they sign up.
    createdAt: { $lte: new Date(now.getTime() - 2 * DAY_MS) },
  })
    .sort({ createdAt: 1 })
    .limit(limit * 4)
    .lean();
}

/**
 * Claim a campaign for a person.
 *
 * The unique index is the arbiter. Several instances may reach the same person
 * and campaign in the same second; exactly one insert wins and the rest see
 * E11000 and move on. No locks, no leader election, no coordination.
 */
async function claim(user, template, profile, now) {
  /*
   * The cycle number is what makes a deliberate resend possible without giving
   * up the duplicate defence. Two servers that both see "they have had this
   * once" both compute cycle 1 and collide on the unique index, so one wins.
   * A year later the same campaign is cycle 2, a different key, and goes out
   * again on purpose.
   *
   * Deliberately its own unbounded query rather than reading the profile's
   * history, which only covers the reuse window plus a margin. An older send
   * that has aged out of that window would otherwise reset the count to zero,
   * collide with its own historic row forever, and quietly make the campaign
   * unreachable for the rest of that person's life. That is the exact defect
   * this whole change set exists to remove, so it must not come back through
   * the back door.
   */
  const highest = await MarketingSend.findOne({
    user: user._id,
    campaignId: template.id,
    // Delivered attempts only. Counting in-flight claims would let two racing
    // workers compute different cycle numbers, both insert successfully, and
    // send the same campaign to the same person twice. Ignoring them makes both
    // compute the same number, so the unique index decides the winner.
    status: { $in: ["sent", "failed"] },
  })
    .sort({ cycle: -1 })
    .select("cycle")
    .lean();
  const cycle = highest ? (highest.cycle || 0) + 1 : 0;

  const insert = () =>
    MarketingSend.create({
      user: user._id,
      userId: String(user.userId || user._id),
      email: user.email,
      campaignId: template.id,
      cycle,
      // The recipient's audience at send time, not the template's. A campaign
      // may serve several audiences, and history has to say which one this was.
      audience: profile.audience,
      category: template.category,
      kind: template.kind,
      topic: template.topic,
      status: "claimed",
      claimedAt: now,
      attempts: 1,
      subject: typeof template.subject === "function" ? "" : template.subject,
    });

  try {
    return await insert();
  } catch (error) {
    if (error?.code !== 11000) throw error;

    /*
     * Somebody else holds this cycle. Usually that is another worker in the
     * same second, which is the whole point and we simply move on.
     *
     * But it can also be a claim abandoned when a process died mid-send. That
     * row would sit in the index forever and make the campaign permanently
     * unreachable for this person, which is precisely the class of defect this
     * change set exists to remove. So a claim older than the stale threshold is
     * released and the insert is retried once.
     */
    const blocking = await MarketingSend.findOne({
      user: user._id, campaignId: template.id, cycle, status: "claimed",
    }).select("claimedAt").lean();

    const staleBy = blocking ? now.getTime() - new Date(blocking.claimedAt).getTime() : 0;
    if (!blocking || staleBy < STALE_CLAIM_MS) return null;

    const released = await MarketingSend.updateOne(
      { _id: blocking._id, status: "claimed" },
      { $set: { status: "cancelled", cancelledReason: "stale_claim_released" } }
    );
    if (released.modifiedCount !== 1) return null;
    log("warn", "marketing_stale_claim_released", {
      campaignId: template.id, cycle, ageMinutes: Math.round(staleBy / 60000),
    });

    try {
      return await insert();
    } catch (retryError) {
      if (retryError?.code === 11000) return null;
      throw retryError;
    }
  }
}

/**
 * The master safety rule.
 *
 * Between choosing a campaign and sending it, the person may have unsubscribed,
 * bought a membership, cancelled a booking or used their free visit. Everything
 * is read again from the database and judged again. A claim is permission to
 * try, never permission to send.
 */
async function stillEligible(user, template, options, excludeSendId) {
  const fresh = await buildProfile(user, new Date(), { excludeSendId });
  const person = await personEligible(fresh);
  if (!person.eligible) return { ok: false, reason: `recheck_${person.reason}`, profile: fresh };

  const verdict = templateEligible(template, fresh, options);
  if (!verdict.eligible) return { ok: false, reason: `recheck_${verdict.reason}`, profile: fresh };

  return { ok: true, reason: "", profile: fresh };
}

/**
 * Run one marketing cycle.
 *
 * dryRun writes nothing and sends nothing. It is the only mode used before
 * activation, and it reports exactly what the live run would have done.
 */
async function runMarketingCycle(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const limit = Number(options.limit || BATCH.maxPerRun);

  const result = {
    startedAt: now.toISOString(),
    dryRun,
    considered: 0,
    selected: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    cancelled: 0,
    stoppedBecause: "",
    byCampaign: {},
    skipReasons: {},
    plans: [],
  };

  if (!BUSINESS.addressLine) {
    result.stoppedBecause = "no_postal_address";
    log("error", "marketing_blocked", { reason: result.stoppedBecause });
    return result;
  }
  if (!marketingEnabled() && !dryRun) {
    result.stoppedBecause = "disabled";
    return result;
  }
  if (!inSendWindow(now) && !force) {
    result.stoppedBecause = "outside_send_window";
    return result;
  }

  const sentToday = await MarketingSend.countDocuments({
    status: "sent",
    sentAt: { $gte: startOfLocalDay(now) },
  });
  if (sentToday >= BATCH.maxPerDay && !dryRun) {
    result.stoppedBecause = "daily_cap";
    log("warn", "marketing_daily_cap_reached", { sentToday });
    return result;
  }

  const selectionOptions = { annualPricingWorking: await annualPricingHealthy(now) };
  result.annualPricingWorking = selectionOptions.annualPricingWorking;

  const candidates = await findCandidates(now, limit);
  const remainingToday = Math.max(0, BATCH.maxPerDay - sentToday);
  const runLimit = Math.min(limit, dryRun ? limit : remainingToday);

  for (const user of candidates) {
    if (result.selected >= runLimit) {
      result.stoppedBecause = result.stoppedBecause || "batch_limit";
      break;
    }
    result.considered += 1;

    try {
      const profile = await buildProfile(user, now);
      const person = await personEligible(profile);
      if (!person.eligible) {
        result.skipped += 1;
        result.skipReasons[person.reason] = (result.skipReasons[person.reason] || 0) + 1;
        continue;
      }

      const { template } = selectCampaign(profile, selectionOptions);
      if (!template) {
        result.skipped += 1;
        result.skipReasons.no_eligible_campaign =
          (result.skipReasons.no_eligible_campaign || 0) + 1;
        continue;
      }

      result.selected += 1;
      result.byCampaign[template.id] = (result.byCampaign[template.id] || 0) + 1;
      result.plans.push({
        email: maskEmail(user.email),
        audience: profile.audience,
        campaignId: template.id,
        subject: typeof template.subject === "function" ? "(dynamic)" : template.subject,
      });

      if (dryRun) continue;

      const record = await claim(user, template, profile, now);
      if (!record) {
        result.skipped += 1;
        result.skipReasons.claimed_elsewhere = (result.skipReasons.claimed_elsewhere || 0) + 1;
        continue;
      }

      const recheck = await stillEligible(user, template, selectionOptions, record._id);
      if (!recheck.ok) {
        await MarketingSend.updateOne(
          { _id: record._id },
          { $set: { status: "cancelled", cancelledReason: recheck.reason } }
        );
        result.cancelled += 1;
        result.skipReasons[recheck.reason] = (result.skipReasons[recheck.reason] || 0) + 1;
        log("info", "marketing_send_cancelled", {
          campaignId: template.id,
          reason: recheck.reason,
        });
        continue;
      }

      const rendered = renderMarketingEmail(template, {
        name: String(user.firstName || user.name || "there").split(" ")[0],
        email: user.email,
        audience: profile.audience,
      });

      try {
        const info = await sendRaw({
          to: user.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          headers: {
            // One-click unsubscribe. Mailbox providers treat its absence on bulk
            // mail as a spam signal, and its presence keeps complaints from
            // becoming reputation damage.
            "List-Unsubscribe": `<${rendered.unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
          logContext: {
            templateKey: `marketing:${template.id}`,
            emailType: "marketing",
            source: "marketing_engine",
            userId: user.userId || String(user._id),
            recipientName: user.firstName || user.name || "",
          },
        });

        await MarketingSend.updateOne(
          { _id: record._id },
          {
            $set: {
              status: "sent",
              sentAt: new Date(),
              subject: rendered.subject,
              providerMessageId: String(info?.messageId || "").trim(),
            },
          }
        );
        result.sent += 1;
        log("info", "marketing_sent", {
          campaignId: template.id,
          audience: profile.audience,
          to: maskEmail(user.email),
        });
      } catch (sendError) {
        await MarketingSend.updateOne(
          { _id: record._id },
          {
            $set: {
              status: "failed",
              failedAt: new Date(),
              failureReason: String(sendError?.message || "").slice(0, 300),
            },
          }
        );
        result.failed += 1;
        log("error", "marketing_send_failed", {
          campaignId: template.id,
          message: sendError?.message || "",
        });
      }

      if (BATCH.delayBetweenSendsMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, BATCH.delayBetweenSendsMs));
      }
    } catch (error) {
      result.failed += 1;
      log("error", "marketing_candidate_failed", { message: error?.message || "" });
    }
  }

  result.finishedAt = new Date().toISOString();
  if (!dryRun && (result.sent || result.failed || result.cancelled)) {
    log("info", "marketing_cycle", {
      sent: result.sent,
      failed: result.failed,
      cancelled: result.cancelled,
      skipped: result.skipped,
    });
  }
  return result;
}

/** Render one campaign without sending it, for the admin preview. */
function previewCampaign(campaignId, { name = "Sam", email = "preview@profixter.com" } = {}) {
  const template = BY_ID.get(campaignId);
  if (!template) throw new Error(`Unknown campaign: ${campaignId}`);
  return { template, ...renderMarketingEmail(template, { name, email }) };
}

module.exports = { maskEmail, previewCampaign, runMarketingCycle, startOfLocalDay };
