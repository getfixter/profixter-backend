const express = require("express");
const router = express.Router();

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const Counter = require("../models/Counter");
const EmailCampaign = require("../models/EmailCampaign");
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

const onlyAdmin = requirePermission(PERMISSIONS.ADMIN);
const ADMIN_EMAIL = String(
  process.env.MAIL_ADMIN || "getfixter@gmail.com"
).trim().toLowerCase();
const SEND_BATCH_SIZE = Math.max(1, Number(process.env.EMAIL_BATCH_SIZE || 10));
const SEND_BATCH_DELAY_MS = Math.max(
  0,
  Number(process.env.EMAIL_BATCH_DELAY_MS || 300)
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

router.get("/segments", auth, ...onlyAdmin, async (_req, res) => {
  try {
    return res.json(await resolveAudienceCounts());
  } catch (error) {
    console.error("Load email segments failed:", error);
    return res.status(500).json({ message: "Failed to load email audiences" });
  }
});

router.get("/campaigns/variables", auth, ...onlyAdmin, (_req, res) => {
  return res.json({ groups: MERGE_TAG_GROUPS });
});

router.get("/campaigns/recipients", auth, ...onlyAdmin, async (req, res) => {
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

router.post("/campaigns/preview", auth, ...onlyAdmin, async (req, res) => {
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

router.post("/campaigns/test", auth, ...onlyAdmin, async (req, res) => {
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

router.post("/campaigns/send", auth, ...onlyAdmin, async (req, res) => {
  let campaign = null;
  try {
    if (req.body?.testOnly === true) {
      return res.status(400).json({
        message: "Test sends must use the dedicated /api/admin/campaigns/test endpoint",
      });
    }

    const input = validateCampaignInput(req.body);
    const {
      recipients,
      excludedRecipients,
      eligibleBeforeExclusions,
    } = await resolveAudience(input.segment, input);
    const campaignNumber = await nextCampaignNumber();
    campaign = await EmailCampaign.create({
      campaignNumber,
      subject: input.subject,
      body: input.body,
      ctaText: input.ctaText,
      ctaUrl: input.ctaUrl,
      selectedSegment: input.segment,
      resolvedRecipientCount: eligibleBeforeExclusions,
      actorUserId: req.authUser?._id || req.user?.id || null,
      actorName: req.authUser?.name || "",
      actorEmail: req.authUser?.email || "",
      status: "sending",
      startedAt: new Date(),
    });

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
    campaign.adminCopySent = true;
    await campaign.save();

    const results = [];
    for (let index = 0; index < recipients.length; index += SEND_BATCH_SIZE) {
      const batch = recipients.slice(index, index + SEND_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (recipient) => {
          try {
            const rendered = renderCampaignEmail({ ...input, recipient });
            const headers = rendered.unsubscribeUrl
              ? {
                  "List-Unsubscribe": `<${rendered.unsubscribeUrl}>`,
                  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
                }
              : {};
            const info = await sendPromo(recipient.email, {
              ...rendered,
              headers,
              logContext: {
                templateKey: "campaign",
                campaignId: campaign._id,
                campaignNumber,
                recipientName: recipient.name || recipient.fullName || "",
                recipientEmail: recipient.email,
                customerName: recipient.name || recipient.fullName || "",
                customerEmail: recipient.email,
                userId: recipient._id || recipient.userId || null,
                emailType: "campaign",
                source: "adminCampaignSend",
              },
            });
            return {
              email: recipient.email,
              status: "sent",
              providerMessageId: info?.messageId || "",
              error: "",
            };
          } catch (error) {
            return {
              email: recipient.email,
              status: "failed",
              providerMessageId: "",
              error: String(error?.message || "Email send failed").slice(0, 500),
            };
          }
        })
      );
      results.push(...batchResults);
      if (index + SEND_BATCH_SIZE < recipients.length) {
        await sleep(SEND_BATCH_DELAY_MS);
      }
    }

    const sentCount = results.filter((item) => item.status === "sent").length;
    const failedCount = results.filter((item) => item.status === "failed").length;
    const errorsSummary = results
      .filter((item) => item.error)
      .slice(0, 50)
      .map((item) => `${item.email}: ${item.error}`);

    campaign.sentCount = sentCount;
    campaign.failedCount = failedCount;
    campaign.skippedCount = excludedRecipients.length;
    campaign.status = failedCount ? "completed_with_errors" : "completed";
    campaign.errorsSummary = errorsSummary;
    campaign.recipientResults = results;
    campaign.completedAt = new Date();
    await campaign.save();

    return res.json({
      campaignId: campaign.campaignNumber,
      segment: input.segment,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      skipped: excludedRecipients.length,
      excluded: excludedRecipients.length,
      adminCopySent: true,
      status: campaign.status,
      errors: results
        .filter((item) => item.status === "failed")
        .map(({ email, error }) => ({ email, error })),
    });
  } catch (error) {
    console.error("Campaign send failed:", error);
    if (campaign) {
      campaign.status = "failed";
      campaign.completedAt = new Date();
      campaign.errorsSummary = [String(error?.message || "Campaign failed")];
      await campaign.save().catch(() => {});
    }
    return res
      .status(error.statusCode || 500)
      .json({ message: error.message || "Failed to send campaign" });
  }
});

router.get("/campaigns/:campaignNumber", auth, ...onlyAdmin, async (req, res) => {
  const campaign = await EmailCampaign.findOne({
    campaignNumber: req.params.campaignNumber,
  }).lean();
  if (!campaign) return res.status(404).json({ message: "Campaign not found" });
  return res.json({ campaign });
});

module.exports = router;
