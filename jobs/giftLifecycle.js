const cron = require("node-cron");

const GiftMembership = require("../models/GiftMembership");
const { CLAIM_REMINDER_DAYS, ENDING_SOON_DAYS, TIMEZONE, giftsEnabled } = require("../utils/gifts/giftConfig");
const { giftAccessState } = require("../utils/gifts/giftAccess");
const { issueInvitation } = require("../utils/gifts/giftService");
const {
  sendGiftClaimReminder,
  sendGiftEndingSoon,
  sendGiftExpired,
} = require("../utils/gifts/giftEmails");

/**
 * The gift lifecycle sweep.
 *
 * IT DOES NOT GRANT OR REVOKE ACCESS, AND NOTHING DEPENDS ON IT RUNNING.
 *
 * Whether a gift works right now is computed from its own dates, every time it
 * is asked, in utils/gifts/giftAccess. So if this job is delayed an hour, a
 * day, or stops entirely, a customer holding a valid gift still books their
 * visit and a customer whose gift has ended still cannot. Nothing about
 * entitlement waits on a cron tick.
 *
 * What this does is the work that genuinely has to be initiated by something:
 * sending reminder emails, and stamping bookkeeping fields so the same email
 * is not sent twice. Every one of those writes is idempotent and none of them
 * changes what a customer can do.
 *
 * That separation is the whole point. The obvious design — a job that flips
 * gifts to "active" at midnight — means one missed run silently locks paying
 * customers out of something they hold, and nobody notices until somebody
 * tries to book.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 100;

function errorDetails(error) {
  return { message: String(error?.message || "Unknown error").slice(0, 300), name: error?.name || "" };
}

/**
 * Nudge gifts nobody has claimed.
 *
 * Only while the invitation link still works: reminding somebody about a gift
 * with a dead link would send them to an error page. Once the link has expired
 * the gift is intact but needs an Admin re-issue, which is a human decision
 * and is surfaced on the admin screen instead.
 */
async function sendClaimReminders(now, stats, Model = GiftMembership) {
  for (const days of CLAIM_REMINDER_DAYS) {
    const windowStart = new Date(now.getTime() - (days + 1) * DAY_MS);
    const windowEnd = new Date(now.getTime() - days * DAY_MS);

    const candidates = await Model.find({
      status: "invited",
      recipient: null,
      invitedAt: { $gte: windowStart, $lt: windowEnd },
      claimTokenExpiresAt: { $gt: now },
      [`reminderSentDay${days}`]: { $in: [null, undefined] },
    })
      .limit(BATCH_LIMIT)
      .lean();

    for (const gift of candidates) {
      /*
       * A reminder needs a working link, and the one that was emailed cannot
       * be recovered — only its hash is stored. So a fresh one is minted,
       * which also supersedes the old link. That is the correct behaviour:
       * the most recent invitation should be the one that works.
       */
      const invitation = await issueInvitation({ ...gift, claimTokenVersion: gift.claimTokenVersion }, { Model });
      await sendGiftClaimReminder(gift, invitation);
      await Model.updateOne({ _id: gift._id }, { $set: { [`reminderSentDay${days}`]: now } });
      stats.claimReminders += 1;
    }
  }
}

/** Offer a membership of their own, shortly before the gift runs out. */
async function sendEndingSoon(now, stats, Model = GiftMembership) {
  const horizon = new Date(now.getTime() + ENDING_SOON_DAYS * DAY_MS);

  const candidates = await Model.find({
    status: "claimed",
    endAt: { $gt: now, $lte: horizon },
    endingSoonEmailAt: null,
  })
    .limit(BATCH_LIMIT)
    .lean();

  for (const gift of candidates) {
    // Only for a gift that is actually running. One still queued behind paid
    // coverage has not started, so telling them it is ending would be nonsense.
    if (giftAccessState(gift, now).state !== "active") continue;
    await sendGiftEndingSoon(gift);
    await Model.updateOne({ _id: gift._id }, { $set: { endingSoonEmailAt: now } });
    stats.endingSoon += 1;
  }
}

/** Tell somebody their gift has finished, once. */
async function sendExpiries(now, stats, Model = GiftMembership) {
  const candidates = await Model.find({
    status: "claimed",
    endAt: { $lte: now },
    expiredEmailAt: null,
  })
    .limit(BATCH_LIMIT)
    .lean();

  for (const gift of candidates) {
    await sendGiftExpired(gift);
    await Model.updateOne({ _id: gift._id }, { $set: { expiredEmailAt: now } });
    stats.expired += 1;
  }
}

/**
 * Pull a queued gift forward when the coverage ahead of it ended early.
 *
 * BOOKKEEPING, NOT GATING. A gift queued behind a paid membership is given a
 * start date at claim time from what was known then; if the customer cancels
 * early, that date is now later than it needs to be and they would wait for
 * time they already own.
 *
 * The access check does not depend on this having run — it reads whatever
 * dates the record holds. This only improves them, and only ever earlier,
 * never later, so a customer's entitlement can never be pushed back by a
 * sweep.
 */
async function reconcileQueuedGifts(now, stats, Model = GiftMembership) {
  const Subscription = require("../models/Subscription");

  const queued = await Model.find({
    status: "claimed",
    startAt: { $gt: now },
  })
    .limit(BATCH_LIMIT)
    .lean();

  for (const gift of queued) {
    if (!gift.recipient || !gift.addressId) continue;

    const paid = await Subscription.exists({
      user: gift.recipient,
      addressId: gift.addressId,
      status: { $in: ["active", "trialing"] },
    });

    // Anything else queued in front of this one still has to run first.
    const ahead = await Model.exists({
      _id: { $ne: gift._id },
      recipient: gift.recipient,
      addressId: gift.addressId,
      status: "claimed",
      endAt: { $gt: now, $lte: gift.startAt },
    });

    if (paid || ahead) continue;

    const durationMs = new Date(gift.endAt).getTime() - new Date(gift.startAt).getTime();
    await Model.updateOne(
      { _id: gift._id, startAt: gift.startAt },
      { $set: { startAt: now, endAt: new Date(now.getTime() + durationMs) } }
    );
    stats.pulledForward += 1;

    console.log(
      JSON.stringify({
        event: "gift_pulled_forward",
        giftNumber: gift.giftNumber,
        reason: "coverage_ahead_ended_early",
      })
    );
  }
}

async function runGiftLifecycleCycle(now = new Date(), { Model = GiftMembership } = {}) {
  const stats = { claimReminders: 0, endingSoon: 0, expired: 0, pulledForward: 0, errors: [] };

  // Registered either way, gated here, so enabling the feature is a config
  // change rather than a deploy — the same pattern the marketing and SMS
  // sweeps already use.
  if (!giftsEnabled()) return { ran: false, reason: "gifts_disabled", ...stats };

  for (const [name, fn] of [
    ["claimReminders", sendClaimReminders],
    ["endingSoon", sendEndingSoon],
    ["expiries", sendExpiries],
    ["reconcile", reconcileQueuedGifts],
  ]) {
    try {
      await fn(now, stats, Model);
    } catch (error) {
      stats.errors.push(name);
      console.error(
        JSON.stringify({ event: "gift_lifecycle_step_failed", step: name, error: errorDetails(error) })
      );
    }
  }

  if (stats.claimReminders || stats.endingSoon || stats.expired || stats.pulledForward || stats.errors.length) {
    console.log(JSON.stringify({ event: "gift_lifecycle_cycle", at: now.toISOString(), ...stats }));
  }
  return { ran: true, ...stats };
}

function startGiftLifecycle() {
  let running = false;

  // Hourly. Nothing here is time-critical, because nothing here gates access.
  cron.schedule(
    "25 * * * *",
    async () => {
      if (running) return;
      running = true;
      try {
        await runGiftLifecycleCycle(new Date());
      } catch (error) {
        console.error(JSON.stringify({ event: "gift_lifecycle_failed", error: errorDetails(error) }));
      } finally {
        running = false;
      }
    },
    { timezone: TIMEZONE }
  );

  console.log(
    JSON.stringify({
      event: "gift_lifecycle_started",
      schedule: "25 * * * *",
      timezone: TIMEZONE,
      giftsEnabled: giftsEnabled(),
    })
  );
}

module.exports = {
  reconcileQueuedGifts,
  runGiftLifecycleCycle,
  sendClaimReminders,
  sendEndingSoon,
  sendExpiries,
  startGiftLifecycle,
};
