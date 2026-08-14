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
      season: t.season || null,
      ctaRoute: t.ctaRoute,
      gated: [
        t.requiresFreeVisitEligible && "free_visit_eligible",
        t.requiresAnnualPricingWorking && "annual_pricing_working",
        t.requiresUpgradeAvailable && "upgrade_available",
        t.requiresMonthlyBilling && "monthly_billing",
      ].filter(Boolean),
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

module.exports = router;
