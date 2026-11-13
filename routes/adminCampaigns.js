const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const Counter = require("../models/Counter");
const EmailCampaign = require("../models/EmailCampaign");
const EmailCampaignRecipient = require("../models/EmailCampaignRecipient");
const { countsFor, processCampaign } = require("../jobs/campaignSender");
const { createAdminActivityLog } = require("../utils/adminActivityLog");
const {
  normalizeSegment,
  publicRecipient,
  resolveAudience,
  resolveAudienceCounts,
} = require("../utils/campaignAudience");
const { renderCampaignEmail } = require("../utils/campaignEmail");
const {
  MERGE_TAG_GROUPS,
  valuesForRecipient,
} = require("../utils/campaignMergeTags");
const { sendPromo } = require("../utils/emailService");

const sectionAccess = requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE);
const ADMIN_EMAIL = String(
  process.env.MAIL_ADMIN || "getfixter@gmail.com"
).trim().toLowerCase();

function validateCampaignInput(body = {}) {
  const segment = normalizeSegment(body.segment || "all");
  const subject = String(body.subject || "").trim();
  const message = String(body.body || "").trim();
  const ctaText = String(body.ctaText || "").trim();
  const ctaUrl = String(body.ctaUrl || "").trim();

  if (!subject || subject.length > 180) {
    const error = new Error("Subject is required and must be 180 characters or fewer");
    error.statusCode = 400;
    throw error;
  }
  if (!message || message.length > 30000) {
    const error = new Error("Message is required and must be 30,000 characters or fewer");
    error.statusCode = 400;
    throw error;
  }
  if (ctaText.length > 80) {
    const error = new Error("CTA text must be 80 characters or fewer");
    error.statusCode = 400;
    throw error;
  }
  if (ctaUrl && !/^https?:\/\/[^\s]+$/i.test(ctaUrl)) {
    const error = new Error("CTA URL must be a valid http or https URL");
    error.statusCode = 400;
    throw error;
  }
  return {
    segment,
    subject,
    body: message,
    ctaText,
    ctaUrl,
    excludedUserIds: Array.isArray(body.excludedUserIds)
      ? body.excludedUserIds.map((value) => String(value || "").trim()).filter(Boolean)
      : [],
    excludedEmails: Array.isArray(body.excludedEmails)
      ? body.excludedEmails.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
      : [],
  };
}

function segmentLabel(segment) {
  return {
    all: "All Customers",
    subscribed: "Subscribed",
    not_subscribed: "Not Subscribed",
    basic: "Basic",
    plus: "Plus",
    premium: "Premium",
    elite: "Elite",
  }[segment];
}

function planFilter(segment) {
  return ["basic", "plus", "premium", "elite"].includes(segment)
    ? segmentLabel(segment)
    : "None";
}

function adminMetadata({ mode, campaignNumber, input, count, actor, timestamp }) {
  return {
    notice:
      mode === "test"
        ? "TEST ONLY — no customer received this email."
        : "This is your admin copy of the campaign sent to customers.",
    Audience: segmentLabel(input.segment),
    "Plan filter": planFilter(input.segment),
    "Recipient count": String(count),
    Subject: input.subject,
    "Send time": timestamp,
    "Created by": actor,
    "Campaign ID": campaignNumber || "Test only",
  };
}

function sampleRecipient(recipients) {
  return (
    recipients[0] || {
      email: ADMIN_EMAIL,
      name: "Profixter Customer",
      fullName: "Taylor Morgan",
      firstName: "Taylor",
      lastName: "Morgan",
      userId: "00000000",
      phone: "(631) 555-0142",
      plans: ["premium"],
      subscriptionStatuses: ["active"],
      memberSince: "2025-01-15T12:00:00.000Z",
      address: "125 Harbor Lane",
      city: "Huntington",
      state: "NY",
      zip: "11743",
    }
  );
}

async function nextCampaignNumber() {
  const year = new Date().getUTCFullYear();
  const counter = await Counter.findOneAndUpdate(
    { key: `emailCampaign:${year}` },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return `EML-${year}-${String(counter.value).padStart(5, "0")}`;
}

router.get("/segments", auth, ...sectionAccess, async (_req, res) => {
  try {
    return res.json(await resolveAudienceCounts());
  } catch (error) {
    console.error("Load email segments failed:", error);
    return res.status(500).json({ message: "Failed to load email audiences" });
  }
});

router.get("/campaigns/variables", auth, ...sectionAccess, (_req, res) => {
  return res.json({ groups: MERGE_TAG_GROUPS });
});

router.get("/campaigns/recipients", auth, ...sectionAccess, async (req, res) => {
  try {
    const segment = normalizeSegment(req.query.segment || "all");
    const excludedUserIds = String(req.query.excludedUserIds || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const excludedEmails = String(req.query.excludedEmails || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const {
      recipients,
      excludedRecipients,
      eligibleBeforeExclusions,
    } = await resolveAudience(segment, { excludedUserIds, excludedEmails });

    return res.json({
      segment,
      includedCount: recipients.length,
      excludedCount: excludedRecipients.length,
      eligibleBeforeExclusions,
      recipients: recipients.map(publicRecipient),
      excludedRecipients: excludedRecipients.map(publicRecipient),
    });
  } catch (error) {
    console.error("Load campaign recipients failed:", error);
    return res
      .status(error.statusCode || 500)
      .json({ message: error.message || "Failed to load campaign recipients" });
  }
});

router.post("/campaigns/preview", auth, ...sectionAccess, async (req, res) => {
  try {
    const input = validateCampaignInput(req.body);
    const {
      recipients,
      excludedRecipients,
      eligibleBeforeExclusions,
    } = await resolveAudience(input.segment, input);
    const rendered = renderCampaignEmail({
      ...input,
      recipient: sampleRecipient(recipients),
    });
    return res.json({
      segment: input.segment,
      recipientCount: recipients.length,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      sampleValues: valuesForRecipient(sampleRecipient(recipients)),
      includedRecipients: recipients.map(publicRecipient),
      excludedRecipientCount: excludedRecipients.length,
      eligibleBeforeExclusions,
    });
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ message: error.message || "Failed to preview campaign" });
  }
});

router.post("/campaigns/test", auth, ...sectionAccess, async (req, res) => {
  try {
    const input = validateCampaignInput(req.body);
    const { recipients, excludedRecipients } = await resolveAudience(
      input.segment,
      input
    );
    const timestamp = new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
      dateStyle: "medium",
      timeStyle: "short",
    });
    const rendered = renderCampaignEmail({
      ...input,
      recipient: sampleRecipient(recipients),
      metadata: adminMetadata({
        mode: "test",
        input,
        count: recipients.length,
        actor: req.authUser?.name || req.authUser?.email || "Admin",
        timestamp,
      }),
    });
    const info = await sendPromo(ADMIN_EMAIL, {
      ...rendered,
      logContext: {
        templateKey: "campaign_test",
        recipientEmail: ADMIN_EMAIL,
        customerEmail: ADMIN_EMAIL,
        emailType: "campaign",
        source: "adminCampaignTest",
      },
    });
    return res.json({
      testOnly: true,
      recipient: ADMIN_EMAIL,
      estimatedRecipientCount: recipients.length,
      excludedRecipientCount: excludedRecipients.length,
      providerMessageId: info?.messageId || "",
    });
  } catch (error) {
    console.error("Campaign test failed:", error);
    return res
      .status(error.statusCode || 500)
      .json({ message: error.message || "Failed to send test email" });
  }
});

/*
 * How long POST /campaigns/send waits for the background sender before it
 * answers. The send itself is durable either way (jobs/campaignSender); the
 * wait only lets a small campaign report its final counts in the response, as
 * the inline sender used to. Larger campaigns answer "sending" and are
 * followed with GET /campaigns/:id.
 */
const SEND_RESPONSE_WAIT_MS = () =>
  Math.max(0, Number(process.env.CAMPAIGN_SEND_RESPONSE_WAIT_MS ?? 20000));
const DUPLICATE_WINDOW_STATUSES = ["queued", "sending"];

function readIdempotencyKey(req) {
  const raw = req.body?.idempotencyKey ?? req.get?.("Idempotency-Key") ?? "";
  const key = String(raw || "").trim();
  if (!key) return "";
  if (key.length > 200) {
    const error = new Error("idempotencyKey must be 200 characters or fewer");
    error.statusCode = 400;
    error.code = "INVALID_IDEMPOTENCY_KEY";
    throw error;
  }
  return key;
}

async function campaignResponse(campaignId, extra = {}) {
  const campaign = await EmailCampaign.findById(campaignId).lean();
  const counts = await countsFor(campaign._id);
  const failures = await EmailCampaignRecipient.find({ campaignId: campaign._id, status: "failed" })
    .sort({ index: 1 })
    .limit(200)
    .select("email error")
    .lean();
  const finished = !DUPLICATE_WINDOW_STATUSES.includes(campaign.status);
  return {
    // Unchanged fields the current Admin composer reads.
    campaignId: campaign.campaignNumber,
    segment: campaign.selectedSegment,
    total: campaign.totalRecipients || counts.total,
    sent: counts.sent,
    failed: counts.failed,
    skipped: campaign.excludedCount + counts.skipped,
    excluded: campaign.excludedCount,
    adminCopySent: Boolean(campaign.adminCopySent),
    status: campaign.status,
    errors: failures.map(({ email, error }) => ({ email, error })),
    // Background sending.
    id: String(campaign._id),
    campaignNumber: campaign.campaignNumber,
    pending: counts.pending + counts.sending,
    finished,
    queued: !finished,
    ...extra,
  };
}

async function waitForCampaign(promise) {
  const waitMs = SEND_RESPONSE_WAIT_MS();
  if (!waitMs) return;
  let timer;
  await Promise.race([
    promise.catch(() => {}),
    new Promise((resolve) => {
      timer = setTimeout(resolve, waitMs);
    }),
  ]);
  clearTimeout(timer);
}

function kickSender(campaignId) {
  // CAMPAIGN_SEND_IMMEDIATE=false leaves all sending to the minute sweep.
  if (process.env.CAMPAIGN_SEND_IMMEDIATE === "false") return Promise.resolve();
  return processCampaign(campaignId).catch((error) => {
    // The minute sweep picks the campaign up again once the lease runs out.
    console.error(
      JSON.stringify({
        event: "email_campaign_kick_failed",
        campaignId: String(campaignId),
        error: String(error?.message || error).slice(0, 300),
      })
    );
  });
}

router.post("/campaigns/send", auth, ...sectionAccess, async (req, res) => {
  let campaign = null;
  try {
    if (req.body?.testOnly === true) {
      return res.status(400).json({
        message: "Test sends must use the dedicated /api/admin/campaigns/test endpoint",
      });
    }

    const input = validateCampaignInput(req.body);
    const idempotencyKey = readIdempotencyKey(req);

    // A retried request (same key) returns the campaign it already created.
    if (idempotencyKey) {
      const existing = await EmailCampaign.findOne({ idempotencyKey }).select("_id").lean();
      if (existing) return res.json(await campaignResponse(existing._id, { duplicate: true }));
    }
    // A second press of Send while the same campaign is still going out.
    const inFlight = await EmailCampaign.findOne({
      status: { $in: DUPLICATE_WINDOW_STATUSES },
      selectedSegment: input.segment,
      subject: input.subject,
      $or: [{ adminCopySent: true }, { leaseUntil: { $gt: new Date() } }],
    })
      .select("_id")
      .lean();
    if (inFlight) {
      return res.json(
        await campaignResponse(inFlight._id, {
          duplicate: true,
          code: "CAMPAIGN_ALREADY_SENDING",
          message: "This campaign is already being sent. Showing its progress instead of sending it again.",
        })
      );
    }

    const {
      recipients,
      excludedRecipients,
      eligibleBeforeExclusions,
    } = await resolveAudience(input.segment, input);
    const campaignNumber = await nextCampaignNumber();
    try {
      campaign = await EmailCampaign.create({
        campaignNumber,
        subject: input.subject,
        body: input.body,
        ctaText: input.ctaText,
        ctaUrl: input.ctaUrl,
        selectedSegment: input.segment,
        resolvedRecipientCount: eligibleBeforeExclusions,
        totalRecipients: recipients.length,
        excludedCount: excludedRecipients.length,
        skippedCount: excludedRecipients.length,
        actorUserId: req.authUser?._id || req.user?.id || null,
        actorName: req.authUser?.name || "",
        actorEmail: req.authUser?.email || "",
        status: "queued",
        ...(idempotencyKey ? { idempotencyKey } : {}),
        // Held by this request until the snapshot and admin copy are done,
        // so the background sender cannot start on a half-written list.
        leaseOwner: "request",
        leaseUntil: new Date(Date.now() + 5 * 60 * 1000),
      });
    } catch (error) {
      if (error?.code === 11000 && idempotencyKey) {
        const existing = await EmailCampaign.findOne({ idempotencyKey }).select("_id").lean();
        if (existing) return res.json(await campaignResponse(existing._id, { duplicate: true }));
      }
      throw error;
    }

    if (recipients.length) {
      await EmailCampaignRecipient.insertMany(
        recipients.map((recipient, index) => ({
          campaignId: campaign._id,
          index,
          email: recipient.email,
          recipient,
        })),
        { ordered: false }
      );
    }

    const timestamp = new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
      dateStyle: "medium",
      timeStyle: "short",
    });
    const adminRendered = renderCampaignEmail({
      ...input,
      recipient: sampleRecipient(recipients),
      metadata: adminMetadata({
        mode: "full",
        campaignNumber,
        input,
        count: recipients.length,
        actor: req.authUser?.name || req.authUser?.email || "Admin",
        timestamp,
      }),
    });
    // The admin copy goes first, as before: if it cannot be sent, no customer is emailed.
    await sendPromo(ADMIN_EMAIL, {
      ...adminRendered,
      logContext: {
        templateKey: "campaign_admin_copy",
        campaignId: campaign._id,
        campaignNumber,
        recipientEmail: ADMIN_EMAIL,
        customerEmail: ADMIN_EMAIL,
        emailType: "campaign",
        source: "adminCampaignSend",
      },
    });
    await EmailCampaign.updateOne(
      { _id: campaign._id },
      { $set: { adminCopySent: true, leaseOwner: "", leaseUntil: null } }
    );

    await createAdminActivityLog(req, {
      action: "email_campaign_queued",
      entityType: "EmailCampaign",
      entityId: campaign._id,
      entityName: campaignNumber,
      details: {
        campaignNumber,
        segment: input.segment,
        subject: input.subject,
        recipientCount: recipients.length,
        excludedCount: excludedRecipients.length,
        idempotencyKey: idempotencyKey || "",
      },
    }).catch((error) => console.error("Campaign activity log failed:", error?.message));

    await waitForCampaign(kickSender(campaign._id));
    return res.json(await campaignResponse(campaign._id));
  } catch (error) {
    console.error("Campaign send failed:", error);
    if (campaign) {
      // Nothing was sent to customers: the admin copy or the snapshot failed first.
      await EmailCampaign.updateOne(
        { _id: campaign._id, adminCopySent: false },
        {
          $set: {
            status: "failed",
            completedAt: new Date(),
            leaseOwner: "",
            leaseUntil: null,
            errorsSummary: [String(error?.message || "Campaign failed")],
          },
        }
      ).catch(() => {});
      await EmailCampaignRecipient.updateMany(
        { campaignId: campaign._id, status: "pending" },
        { $set: { status: "skipped", error: "campaign failed before sending" } }
      ).catch(() => {});
    }
    return res
      .status(error.statusCode || 500)
      .json({ message: error.message || "Failed to send campaign", code: error.code || "CAMPAIGN_SEND_FAILED" });
  }
});

async function findCampaign(idOrNumber) {
  const value = String(idOrNumber || "").trim();
  if (mongoose.isValidObjectId(value) && /^[a-f0-9]{24}$/i.test(value)) {
    const byId = await EmailCampaign.findById(value).lean();
    if (byId) return byId;
  }
  return EmailCampaign.findOne({ campaignNumber: value }).lean();
}

/** Progress of one campaign, by id or campaign number (EML-YYYY-NNNNN). */
router.get("/campaigns/:campaignId", auth, ...sectionAccess, async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.campaignId);
    if (!campaign) return res.status(404).json({ message: "Campaign not found", code: "NOT_FOUND" });
    const counts = await countsFor(campaign._id);
    const recentFailures = await EmailCampaignRecipient.find({ campaignId: campaign._id, status: "failed" })
      .sort({ updatedAt: -1 })
      .limit(50)
      .select("email error updatedAt")
      .lean();
    const finished = !DUPLICATE_WINDOW_STATUSES.includes(campaign.status);
    return res.json({
      campaign: {
        _id: String(campaign._id),
        campaignNumber: campaign.campaignNumber,
        status: campaign.status,
        subject: campaign.subject,
        segment: campaign.selectedSegment,
        total: campaign.totalRecipients || counts.total,
        sent: counts.sent,
        failed: counts.failed,
        skipped: (campaign.excludedCount || 0) + counts.skipped,
        excluded: campaign.excludedCount || 0,
        pending: counts.pending + counts.sending,
        adminCopySent: Boolean(campaign.adminCopySent),
        actorName: campaign.actorName || campaign.actorEmail || "",
        createdAt: campaign.createdAt,
        startedAt: campaign.startedAt,
        completedAt: campaign.completedAt,
        lastProgressAt: campaign.lastProgressAt || null,
        finished,
      },
      recentFailures: recentFailures.map((row) => ({
        email: row.email,
        error: row.error,
        at: row.updatedAt,
      })),
      allowedActions: {
        resume: counts.pending > 0 && !(campaign.leaseUntil && new Date(campaign.leaseUntil) > new Date()),
      },
    });
  } catch (error) {
    console.error("Load campaign failed:", error);
    return res.status(500).json({ message: "Failed to load campaign", code: "CAMPAIGN_LOAD_FAILED" });
  }
});

/**
 * Continue a campaign that stopped (crash, deploy, failure). Only rows still
 * pending are sent; anything sent, failed or interrupted is never resent.
 */
router.post("/campaigns/:campaignId/resume", auth, ...sectionAccess, async (req, res) => {
  try {
    const campaign = await findCampaign(req.params.campaignId);
    if (!campaign) return res.status(404).json({ message: "Campaign not found", code: "NOT_FOUND" });
    if (!campaign.adminCopySent) {
      return res.status(409).json({
        message: "This campaign never started (its admin copy was not sent). Create a new campaign instead.",
        code: "INVALID_TRANSITION",
      });
    }
    const counts = await countsFor(campaign._id);
    if (!counts.pending) {
      return res.status(409).json({ message: "Nothing left to send for this campaign.", code: "NOTHING_TO_RESUME" });
    }
    const now = new Date();
    const updated = await EmailCampaign.findOneAndUpdate(
      {
        _id: campaign._id,
        $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }],
      },
      { $set: { status: "queued", completedAt: null, leaseOwner: "", leaseUntil: null } },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({ message: "This campaign is already sending.", code: "CAMPAIGN_ALREADY_SENDING" });
    }
    await createAdminActivityLog(req, {
      action: "email_campaign_resumed",
      entityType: "EmailCampaign",
      entityId: campaign._id,
      entityName: campaign.campaignNumber,
      details: { campaignNumber: campaign.campaignNumber, pending: counts.pending, previousStatus: campaign.status },
    }).catch((error) => console.error("Campaign activity log failed:", error?.message));

    await waitForCampaign(kickSender(campaign._id));
    return res.json(await campaignResponse(campaign._id));
  } catch (error) {
    console.error("Resume campaign failed:", error);
    return res.status(500).json({ message: "Failed to resume campaign", code: "CAMPAIGN_RESUME_FAILED" });
  }
});

module.exports = router;
