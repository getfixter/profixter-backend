const crypto = require("crypto");
const cron = require("node-cron");

const EmailCampaign = require("../models/EmailCampaign");
const EmailCampaignRecipient = require("../models/EmailCampaignRecipient");
const EmailSuppression = require("../models/EmailSuppression");
const Blacklist = require("../models/Blacklist");
const { renderCampaignEmail } = require("../utils/campaignEmail");
const emailService = require("../utils/emailService");

/**
 * Durable email campaign sender.
 *
 * POST /api/admin/campaigns/send no longer sends inside the HTTP request. It
 * queues an EmailCampaign and snapshots its recipients into
 * EmailCampaignRecipient rows; this worker sends them.
 *
 * Guarantees:
 *  - One worker at a time per campaign: a Mongo lease (leaseOwner/leaseUntil)
 *    is claimed with an atomic findOneAndUpdate and renewed every batch.
 *  - No recipient is ever emailed twice. A row is claimed pending -> sending
 *    atomically before the send and closed sent/failed after it. A row found
 *    in "sending" when a new worker takes over belongs to a worker that died
 *    mid-send; the email may or may not have left, so it is closed as failed
 *    ("interrupted") and never retried.
 *  - A crash or deploy only pauses a campaign: once the lease runs out, the
 *    minute sweep (or POST /campaigns/:id/resume) continues with the rows
 *    still pending.
 *  - Consent is re-checked at send time: an address suppressed or blacklisted
 *    after the campaign was queued is skipped, never sent.
 */

const BATCH_SIZE = () => Math.max(1, Number(process.env.EMAIL_BATCH_SIZE || 10));
const BATCH_DELAY_MS = () => Math.max(0, Number(process.env.EMAIL_BATCH_DELAY_MS || 300));
const LEASE_MS = () => Math.max(5000, Number(process.env.CAMPAIGN_LEASE_MS || 2 * 60 * 1000));
const ACTIVE_STATUSES = ["queued", "sending"];

const WORKER_ID = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

/** Atomically take the lease on one campaign (or any due campaign when no id). */
async function claimCampaign({ campaignId = null, owner = WORKER_ID, now = new Date() } = {}) {
  const filter = {
    status: { $in: ACTIVE_STATUSES },
    // Never before the admin copy went out: that is the campaign's go signal.
    adminCopySent: true,
    $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }],
  };
  if (campaignId) filter._id = campaignId;
  return EmailCampaign.findOneAndUpdate(
    filter,
    {
      $set: {
        status: "sending",
        leaseOwner: owner,
        leaseUntil: new Date(now.getTime() + LEASE_MS()),
      },
    },
    { new: true, sort: { createdAt: 1 } }
  );
}

async function renewLease(campaignId, owner) {
  const result = await EmailCampaign.updateOne(
    { _id: campaignId, leaseOwner: owner, status: "sending" },
    { $set: { leaseUntil: new Date(Date.now() + LEASE_MS()), lastProgressAt: new Date() } }
  );
  return result.modifiedCount > 0 || result.matchedCount > 0;
}

/** Rows a dead worker left mid-send are closed, never resent. */
async function closeInterruptedRows(campaignId) {
  const result = await EmailCampaignRecipient.updateMany(
    { campaignId, status: "sending" },
    {
      $set: {
        status: "failed",
        error: "interrupted: the sender stopped during this send; not retried to avoid a duplicate",
      },
    }
  );
  return result.modifiedCount || 0;
}

async function blockedEmailSet(emails) {
  if (!emails.length) return new Set();
  const [suppressions, blacklist] = await Promise.all([
    EmailSuppression.find({ email: { $in: emails } })
      .select("email reason suppressedAt resubscribedAt providerSuppressed")
      .lean(),
    Blacklist.find({ email: { $in: emails } }).select("email").lean(),
  ]);
  const blocked = new Set();
  for (const row of suppressions) {
    if (EmailSuppression.isActive({ suppressedAt: row.suppressedAt || new Date(0), ...row })) {
      blocked.add(normalizeEmail(row.email));
    }
  }
  for (const row of blacklist) blocked.add(normalizeEmail(row.email));
  return blocked;
}

async function sendOne(campaign, row) {
  const recipient = { ...(row.recipient || {}), email: row.email };
  const rendered = renderCampaignEmail({
    subject: campaign.subject,
    body: campaign.body,
    ctaText: campaign.ctaText,
    ctaUrl: campaign.ctaUrl,
    recipient,
  });
  const headers = rendered.unsubscribeUrl
    ? {
        "List-Unsubscribe": `<${rendered.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }
    : {};
  return emailService.sendPromo(recipient.email, {
    ...rendered,
    headers,
    logContext: {
      templateKey: "campaign",
      campaignId: campaign._id,
      campaignNumber: campaign.campaignNumber,
      recipientName: recipient.name || recipient.fullName || "",
      recipientEmail: recipient.email,
      customerName: recipient.name || recipient.fullName || "",
      customerEmail: recipient.email,
      userId: recipient._id || recipient.userId || null,
      emailType: "campaign",
      source: "adminCampaignSend",
    },
  });
}

async function processRow(campaign, row, owner, blocked) {
  const claimed = await EmailCampaignRecipient.findOneAndUpdate(
    { _id: row._id, status: "pending" },
    { $set: { status: "sending", claimedAt: new Date(), claimedBy: owner }, $inc: { attempts: 1 } },
    { new: true }
  );
  if (!claimed) return null;

  if (blocked.has(claimed.email)) {
    await EmailCampaignRecipient.updateOne(
      { _id: claimed._id, status: "sending" },
      { $set: { status: "skipped", error: "unsubscribed or blocked after the campaign was queued" } }
    );
    return "skipped";
  }

  try {
    const info = await sendOne(campaign, claimed);
    await EmailCampaignRecipient.updateOne(
      { _id: claimed._id, status: "sending" },
      { $set: { status: "sent", sentAt: new Date(), providerMessageId: info?.messageId || "", error: "" } }
    );
    return "sent";
  } catch (error) {
    await EmailCampaignRecipient.updateOne(
      { _id: claimed._id, status: "sending" },
      { $set: { status: "failed", error: String(error?.message || "Email send failed").slice(0, 500) } }
    );
    return "failed";
  }
}

async function countsFor(campaignId) {
  const rows = await EmailCampaignRecipient.aggregate([
    { $match: { campaignId } },
    { $group: { _id: "$status", n: { $sum: 1 } } },
  ]);
  const counts = { pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of rows) counts[row._id] = row.n;
  counts.total = counts.pending + counts.sending + counts.sent + counts.failed + counts.skipped;
  return counts;
}

async function syncCounts(campaign) {
  const counts = await countsFor(campaign._id);
  await EmailCampaign.updateOne(
    { _id: campaign._id },
    {
      $set: {
        sentCount: counts.sent,
        failedCount: counts.failed,
        skippedCount: (campaign.excludedCount || 0) + counts.skipped,
        lastProgressAt: new Date(),
      },
    }
  );
  return counts;
}

async function finalize(campaign, owner) {
  const counts = await syncCounts(campaign);
  if (counts.pending || counts.sending) return { finished: false, counts };

  const rows = await EmailCampaignRecipient.find({ campaignId: campaign._id })
    .sort({ index: 1 })
    .select("email status providerMessageId error")
    .lean();
  const recipientResults = rows.map((row) => ({
    email: row.email,
    status: row.status === "skipped" ? "skipped" : row.status,
    providerMessageId: row.providerMessageId || "",
    error: row.error || "",
  }));
  const errorsSummary = rows
    .filter((row) => row.error)
    .slice(0, 50)
    .map((row) => `${row.email}: ${row.error}`);
  const status =
    counts.failed && !counts.sent ? "failed" : counts.failed ? "completed_with_errors" : "completed";

  await EmailCampaign.updateOne(
    { _id: campaign._id, leaseOwner: owner },
    {
      $set: {
        status,
        recipientResults,
        errorsSummary,
        completedAt: new Date(),
        leaseOwner: "",
        leaseUntil: null,
      },
    }
  );
  console.log(
    JSON.stringify({
      event: "email_campaign_completed",
      campaignNumber: campaign.campaignNumber,
      status,
      sent: counts.sent,
      failed: counts.failed,
      skipped: counts.skipped,
    })
  );
  return { finished: true, status, counts };
}

/**
 * Send one campaign to completion, or until its lease is lost.
 * Safe to call concurrently from anywhere: only the lease holder sends.
 */
async function processCampaign(campaignId, { owner = WORKER_ID, stopAfter = Infinity } = {}) {
  const campaign = await claimCampaign({ campaignId, owner });
  if (!campaign) return { claimed: false };
  return runClaimed(campaign, owner, { stopAfter });
}

async function runClaimed(campaign, owner, { stopAfter = Infinity } = {}) {
  await EmailCampaign.updateOne(
    { _id: campaign._id, startedAt: null },
    { $set: { startedAt: new Date() } }
  );
  const interrupted = await closeInterruptedRows(campaign._id);
  if (interrupted) {
    console.warn(
      JSON.stringify({ event: "email_campaign_interrupted_rows", campaignNumber: campaign.campaignNumber, interrupted })
    );
  }

  let processed = 0;
  for (;;) {
    const batch = await EmailCampaignRecipient.find({ campaignId: campaign._id, status: "pending" })
      .sort({ index: 1 })
      .limit(BATCH_SIZE())
      .lean();
    if (!batch.length) break;

    const blocked = await blockedEmailSet(batch.map((row) => row.email));
    const take = Math.min(batch.length, stopAfter - processed);
    await Promise.all(batch.slice(0, take).map((row) => processRow(campaign, row, owner, blocked)));
    processed += take;
    await syncCounts(campaign);

    if (processed >= stopAfter) return { claimed: true, finished: false, stopped: true };
    if (!(await renewLease(campaign._id, owner))) {
      return { claimed: true, finished: false, leaseLost: true };
    }
    if (batch.length === BATCH_SIZE()) await sleep(BATCH_DELAY_MS());
  }

  const result = await finalize(campaign, owner);
  return { claimed: true, ...result };
}

/** One sweep: resume every queued campaign, or one whose worker died. */
async function runCampaignSenderCycle({ owner = WORKER_ID, maxCampaigns = 5 } = {}) {
  const results = [];
  for (let i = 0; i < maxCampaigns; i += 1) {
    const campaign = await claimCampaign({ owner });
    if (!campaign) break;
    results.push(await runClaimed(campaign, owner));
  }
  return results;
}

function startCampaignSender() {
  let running = false;
  cron.schedule("* * * * *", async () => {
    if (running) return;
    running = true;
    try {
      await runCampaignSenderCycle();
    } catch (error) {
      console.error(
        JSON.stringify({ event: "email_campaign_sender_failed", error: String(error?.message || error).slice(0, 300) })
      );
    } finally {
      running = false;
    }
  });
  console.log(JSON.stringify({ event: "email_campaign_sender_started", schedule: "* * * * *" }));
}

module.exports = {
  WORKER_ID,
  claimCampaign,
  countsFor,
  processCampaign,
  runCampaignSenderCycle,
  startCampaignSender,
};
