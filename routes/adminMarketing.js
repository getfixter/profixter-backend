const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const MarketingSend = require("../models/MarketingSend");
const {
  BATCH,
  BUSINESS,
  COOLDOWN_DAYS,
  HELP_TARGET,
  enabledAudiences,
  marketingEnabled,
} = require("../utils/marketing/marketingConfig");
const { ALL_TEMPLATES, BY_ID } = require("../utils/marketing/marketingLibrary");
const {
  annualPricingDetail,
  annualPricingHealthy,
  inSendWindow,
  localClock,
} = require("../utils/marketing/marketingScheduler");
const { previewCampaign, runMarketingCycle } = require("../utils/marketing/marketingRunner");

/**
 * Admin visibility into the marketing engine.
 *
 * Read and preview only. There is deliberately no "send now" button: every
 * marketing send goes through the same eligibility path as the cron, so there
 * is no route here that can put an email in front of somebody who was not
 * chosen by the rules.
 */

router.use(auth, requirePermission(PERMISSIONS.ADMIN));

/** Is marketing on, is it due to run, and is anything blocking it. */
router.get("/status", async (req, res) => {
  try {
    const now = new Date();
    const [annualHealthy, sentToday, totalSent] = await Promise.all([
      annualPricingHealthy(now),
      MarketingSend.countDocuments({
        status: "sent",
        sentAt: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      }),
      MarketingSend.countDocuments({ status: "sent" }),
    ]);

    return res.json({
      enabled: marketingEnabled(),
      enabledAudiences: [...enabledAudiences()],
      inSendWindow: inSendWindow(now),
      newYorkClock: localClock(now),
      postalAddress: BUSINESS.addressLine || null,
      annualPricingWorking: annualHealthy,
      annualPricingDetail: annualPricingDetail(),
      templates: ALL_TEMPLATES.length,
      limits: {
        maxPerRun: BATCH.maxPerRun,
        maxPerDay: BATCH.maxPerDay,
        campaignReuseDays: COOLDOWN_DAYS.campaignReuse,
        helpTarget: HELP_TARGET,
      },
      sentLast24h: sentToday,
      sentAllTime: totalSent,
    });
  } catch (error) {
    console.error("Marketing status failed:", error?.message || error);
    return res.status(500).json({ message: "Server error" });
  }
});

/** The whole library, with the metadata that decides who gets what. */
router.get("/campaigns", (req, res) => {
  return res.json({
    campaigns: ALL_TEMPLATES.map((t) => ({
      id: t.id,
      audience: t.audience,
      category: t.category,
      topic: t.topic,
      priority: t.priority,
      subject: t.subject,
      altSubject: t.altSubject,
      lifecycleDay: t.lifecycleDay ?? null,
      activationDay: t.activationDay ?? null,
      trackBDay: t.trackBDay ?? null,
      season: t.season || null,
      ctaRoute: t.ctaRoute,
      gated: [
        t.requiresFreeVisitEligible && "free_visit_eligible",
        t.requiresAnnualPricingWorking && "annual_pricing_working",
        t.requiresUpgradeAvailable && "upgrade_available",
        t.requiresMonthlyBilling && "monthly_billing",
      ].filter(Boolean),
      /* Plain English for the Communications screen, built from the same
         fields the scheduler actually enforces so the two cannot drift. */
      lifecycle: describeLifecycle(t),
    })),
  });
});

/** Render one campaign exactly as a customer would receive it. */
router.get("/campaigns/:id/preview", (req, res) => {
  if (!BY_ID.has(req.params.id)) {
    return res.status(404).json({ message: "Unknown campaign" });
  }
  try {
    const preview = previewCampaign(req.params.id, {
      name: String(req.query.name || "Sam"),
      email: String(req.query.email || "preview@profixter.com"),
    });
    if (req.query.format === "html") {
      return res.type("html").send(preview.html);
    }
    return res.json({
      id: req.params.id,
      subject: preview.subject,
      preheader: preview.preheader,
      html: preview.html,
      text: preview.text,
      ctaUrl: preview.ctaUrl,
    });
  } catch (error) {
    return res.status(500).json({ message: error?.message || "Preview failed" });
  }
});

/** What would go out right now. Sends nothing, writes nothing. */
router.get("/dry-run", async (req, res) => {
  try {
    const result = await runMarketingCycle({
      now: new Date(),
      dryRun: true,
      force: req.query.window !== "true",
      limit: Math.min(Number(req.query.limit || BATCH.maxPerRun), 200),
    });
    return res.json(result);
  } catch (error) {
    console.error("Marketing dry run failed:", error?.message || error);
    return res.status(500).json({ message: "Server error" });
  }
});

/** Recent history, newest first. */
router.get("/history", async (req, res) => {
  try {
    const rows = await MarketingSend.find({})
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(req.query.limit || 100), 500))
      .select("campaignId audience category topic status sentAt failedAt cancelledReason subject email")
      .lean();
    return res.json({ sends: rows });
  } catch (error) {
    console.error("Marketing history failed:", error?.message || error);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * What an admin needs to know about a lifecycle campaign, in words.
 *
 * Derived from the template's own fields rather than written out by hand:
 * a description maintained separately from the rule it describes is a
 * description that is eventually wrong.
 */
function describeLifecycle(t) {
  if (t.trackBDay !== undefined) {
    return {
      track: "B",
      audience: "Completed the Free First Visit, not a member",
      trigger: "The free visit was marked Completed",
      timing: `Day ${t.trackBDay}, counted from the visit`,
      channel: "Email",
      stopConditions: [
        "An active membership begins",
        "Unsubscribed or suppressed",
        "Re-checked immediately before sending",
      ],
    };
  }
  if (t.requiresFreeVisitEligible) {
    return {
      track: "A",
      audience: "Registered, free visit unused and unbooked, not a member",
      trigger: "Account registration",
      timing: `Day ${t.lifecycleDay}, counted from registration`,
      channel: "Email",
      stopConditions: [
        "A free visit is booked",
        "A free visit is completed",
        "An active membership begins",
        "Unsubscribed or suppressed",
        t.finalFreeVisitReminder
          ? "This is the last reminder; the sequence closes after it"
          : "The final reminder has already been sent",
      ],
    };
  }
  return null;
}

/**
 * Did the lifecycle do anything?
 *
 * Deliberately a report over data we already keep rather than a funnel
 * product: MarketingSend records who received what and when, Booking knows
 * when a free visit was booked and completed, Subscription knows when
 * somebody joined. The only thing missing was somebody asking.
 *
 * "After" means strictly after the send, so a booking made an hour before
 * the email cannot be credited to it.
 */
router.get("/lifecycle-report", async (req, res) => {
  try {
    const Booking = require("../models/Booking");
    const Subscription = require("../models/Subscription");

    const trackA = ALL_TEMPLATES.filter((t) => t.requiresFreeVisitEligible).map((t) => t.id);
    const trackB = ALL_TEMPLATES.filter((t) => t.trackBDay !== undefined).map((t) => t.id);

    const report = async (campaignIds, kind) => {
      const rows = [];
      for (const campaignId of campaignIds) {
        const sends = await MarketingSend.find({ campaignId, status: "sent" })
          .select("user sentAt")
          .lean();

        let bookedAfter = 0;
        let completedAfter = 0;
        let subscribedAfter = 0;

        for (const send of sends) {
          const after = { $gt: send.sentAt };
          if (kind === "A") {
            if (await Booking.exists({ user: send.user, isFreeFirstVisit: true, createdAt: after })) {
              bookedAfter += 1;
            }
            if (await Booking.exists({ user: send.user, isFreeFirstVisit: true, completedAt: after })) {
              completedAfter += 1;
            }
          }
          if (await Subscription.exists({ user: send.user, createdAt: after })) {
            subscribedAfter += 1;
          }
        }

        rows.push({
          campaignId,
          sent: sends.length,
          recipients: new Set(sends.map((s) => String(s.user))).size,
          ...(kind === "A" ? { freeVisitBookedAfter: bookedAfter, freeVisitCompletedAfter: completedAfter } : {}),
          membershipStartedAfter: subscribedAfter,
        });
      }
      return rows;
    };

    /* How many people are standing in each track right now. */
    const completedFreeVisitUsers = await Booking.distinct("user", {
      isFreeFirstVisit: true,
      $or: [{ completedAt: { $ne: null } }, { status: { $regex: /^(completed|complete|done)$/i } }],
    });
    const activeMemberUsers = await Subscription.distinct("user", {
      status: { $in: ["active", "trialing"] },
    });
    const memberSet = new Set(activeMemberUsers.map(String));
    const trackBStanding = completedFreeVisitUsers.filter((u) => u && !memberSet.has(String(u))).length;

    return res.json({
      trackA: { campaigns: await report(trackA, "A") },
      trackB: {
        standing: trackBStanding,
        campaigns: await report(trackB, "B"),
      },
    });
  } catch (error) {
    console.error("Marketing lifecycle report failed:", error?.message || error);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
