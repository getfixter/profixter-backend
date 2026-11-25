const mongoose = require("mongoose");
const SmsMessage = require("../../models/SmsMessage");
const CommMessage = require("../../models/CommMessage");
const { getTypeSpec } = require("../sms/smsTypes");
const { toE164, maskPhone } = require("../sms/smsPhone");
const core = require("./core");
const { drainPending, rankOf } = require("./status");

/**
 * Everything that enters Communications from Profixter's own pipes:
 *   - inbound texts (Twilio webhook) and inbound calls (voice webhook)
 *   - every automated text the existing SMS pipeline records (SmsMessage),
 *     mirrored into the customer's thread so automation shows in history
 *     exactly as it was sent, without touching how it is sent.
 * All writes are keyed by a unique provider id or SmsMessage id, so replays
 * and overlapping runs are harmless.
 */

/* ======================================================= inbound texts */

/**
 * Record one inbound text. Returns { message, duplicate }. Pictures are
 * listed immediately and copied into private storage in the background (the
 * webhook must answer Twilio quickly).
 */
async function recordInboundSms(params, { now = new Date() } = {}) {
  const sid = String(params.MessageSid || params.SmsSid || "").trim();
  const from = toE164(params.From);
  const to = toE164(params.To) || "";
  if (!sid || !from) return { message: null, duplicate: false };
  const existing = await CommMessage.findOne({ provider: "twilio", providerId: sid });
  if (existing) return { message: existing, duplicate: true };

  const conv = await core.conversationForPhone(from, { lineNumber: to });
  const numMedia = Math.min(Number(params.NumMedia || 0) || 0, 10);
  const mediaUrls = [];
  for (let i = 0; i < numMedia; i++) if (params[`MediaUrl${i}`]) mediaUrls.push({ url: params[`MediaUrl${i}`], contentType: String(params[`MediaContentType${i}`] || "") });

  let message;
  try {
    message = await CommMessage.create({
      conversation: conv._id,
      user: conv.user || null,
      channel: "sms",
      direction: "inbound",
      kind: "customer",
      body: String(params.Body || "").slice(0, 5000),
      media: mediaUrls.map((m, i) => ({ key: "", contentType: m.contentType, name: `picture-${i + 1}`, external: true })),
      fromAddress: from,
      toAddress: to,
      lineNumber: to,
      status: "received",
      statusRank: rankOf("received"),
      provider: "twilio",
      providerId: sid,
      providerStatus: "received",
      origin: "twilio_webhook",
      occurredAt: now,
    });
  } catch (err) {
    if (err?.code === 11000) return { message: await CommMessage.findOne({ provider: "twilio", providerId: sid }), duplicate: true };
    throw err;
  }
  await core.applyToConversation(message);
  if (mediaUrls.length) copyInboundMedia(message._id, sid, mediaUrls).catch((e) => core.healthEvent("inbound_media_failed", e.message));
  console.log(JSON.stringify({ event: "comms_inbound_sms", from: maskPhone(from), media: mediaUrls.length, linked: conv.linkState }));
  return { message, duplicate: false };
}

async function copyInboundMedia(messageId, sid, mediaUrls) {
  const provider = require("../sms/twilioProvider");
  const media = require("./media");
  const stored = [];
  for (let i = 0; i < mediaUrls.length; i++) {
    try {
      const { buffer, contentType } = await provider.fetchMedia(mediaUrls[i].url);
      stored.push(await media.storeInbound({ buffer, contentType: mediaUrls[i].contentType || contentType, sid, index: i }));
    } catch (e) {
      stored.push({ key: "", contentType: mediaUrls[i].contentType, name: `picture-${i + 1}`, external: true });
      await core.healthEvent("inbound_media_failed", e.message);
    }
  }
  const updated = await CommMessage.findByIdAndUpdate(messageId, { $set: { media: stored } }, { new: true });
  if (updated?.conversation) await core.bump(updated.conversation);
}

/** A STOP/START shown in the thread, so nobody misses why texting stopped. */
async function recordKeywordEvent(phone, action) {
  const e164 = toE164(phone);
  if (!e164) return;
  const conv = await core.conversationForPhone(e164);
  const message = await CommMessage.create({
    conversation: conv._id,
    user: conv.user || null,
    channel: "system",
    direction: "internal",
    kind: "system",
    body: action === "stop" ? "Replied STOP: opted out of all texts." : "Replied START: unblocked at the carrier. Their saved text preferences are unchanged.",
    status: "logged",
    origin: "twilio_webhook",
    occurredAt: new Date(),
  });
  await core.applyToConversation(message, { countUnread: false });
}

/* ======================================================= inbound calls */

/** A call to a Profixter Twilio number (metadata only; no recording exists). */
async function recordInboundCall(params, { now = new Date() } = {}) {
  const sid = String(params.CallSid || "").trim();
  const from = toE164(params.From);
  if (!sid || !from) return null;
  const to = toE164(params.To) || "";
  const conv = await core.conversationForPhone(from, { lineNumber: to });
  try {
    const message = await CommMessage.create({
      conversation: conv._id,
      user: conv.user || null,
      channel: "call",
      direction: "inbound",
      kind: "customer",
      body: "Called the Profixter texting number and heard the recorded message pointing to 631-599-1363.",
      metadataOnly: true,
      fromAddress: from,
      toAddress: to,
      lineNumber: to,
      status: "logged",
      provider: "twilio",
      providerId: sid,
      call: { status: String(params.CallStatus || ""), durationSec: 0 },
      origin: "twilio_webhook",
      occurredAt: now,
    });
    await core.applyToConversation(message, { countUnread: false });
    return message;
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
}

/* ============================================ automated text mirroring */

const MIRROR_STATUS = {
  sent: "queued",
  delivered: "delivered",
  undelivered: "undelivered",
  failed: "failed",
  retry_scheduled: "sending",
  suppressed: "suppressed",
  simulated: "suppressed",
};

function automationLabel(type) {
  try {
    return getTypeSpec(type).description || type;
  } catch {
    return type;
  }
}

/**
 * Mirror one SmsMessage into Communications. Safe to call any number of
 * times; only moves status forward. Rows still pending/sending are skipped
 * (the next state change mirrors them).
 */
async function mirrorSmsMessage(smsMessageOrId, { importRun = null } = {}) {
  // An ObjectId has an _id getter that returns itself, so test for a real record by its fields.
  const isRecord = smsMessageOrId && typeof smsMessageOrId === "object" && "status" in smsMessageOrId && "toPhone" in smsMessageOrId;
  const sms = isRecord ? smsMessageOrId : await SmsMessage.findById(smsMessageOrId).lean();
  if (!sms) return null;
  const status = MIRROR_STATUS[sms.status];
  if (!status) return null;
  const phone = toE164(sms.toPhone);
  if (!phone) return null;
  const conv = await core.conversationForPhone(phone);
  const sid = sms.providerMessageSid || "";
  const rank = rankOf(status);
  const fields = {
    conversation: conv._id,
    user: sms.user || conv.user || null,
    channel: "sms",
    direction: "outbound",
    kind: "automation",
    body: sms.body || "",
    toAddress: phone,
    automationType: sms.notificationType,
    authorName: `Automated: ${automationLabel(sms.notificationType)}`,
    purpose: sms.channelClass === "marketing" ? "marketing" : "service",
    segments: sms.segments || 0,
    booking: sms.booking || null,
    origin: "sms_mirror",
    importRun,
    occurredAt: sms.sentAt || sms.attemptedAt || sms.createdAt || new Date(),
  };
  const statusFields = {
    status,
    statusRank: rank,
    errorCode: String(sms.providerErrorCode || "").slice(0, 20),
    errorMessage:
      sms.status === "simulated"
        ? "Not sent: texting was switched off at the time."
        : sms.status === "suppressed"
          ? `Not sent: ${sms.suppressionReason || "not eligible"}.`
          : String(sms.providerErrorMessage || "").slice(0, 300),
    ...(sms.deliveredAt ? { deliveredAt: sms.deliveredAt } : {}),
  };
  if (sid) Object.assign(fields, { provider: "twilio", providerId: sid, providerStatus: sms.providerStatus || "" });

  let doc = await CommMessage.findOne(sid ? { $or: [{ smsMessage: sms._id }, { provider: "twilio", providerId: sid }] } : { smsMessage: sms._id });
  if (!doc) {
    try {
      doc = await CommMessage.create({ ...fields, ...statusFields, smsMessage: sms._id });
      await core.applyToConversation(doc, { countUnread: false });
      if (sid) await drainPending(sid);
      return { message: doc, inserted: true };
    } catch (err) {
      if (err?.code !== 11000) throw err;
      doc = await CommMessage.findOne(sid ? { $or: [{ smsMessage: sms._id }, { provider: "twilio", providerId: sid }] } : { smsMessage: sms._id });
      if (!doc) return null;
    }
  }
  const set = { smsMessage: sms._id, automationType: fields.automationType, authorName: fields.authorName, kind: "automation" };
  if (sid && !doc.providerId) Object.assign(set, { provider: "twilio", providerId: sid });
  if (rank > (doc.statusRank || 0)) Object.assign(set, statusFields);
  const updated = await CommMessage.findByIdAndUpdate(doc._id, { $set: set }, { new: true });
  if (rank > (doc.statusRank || 0)) await core.applyToConversation(updated, { countUnread: false });
  return { message: updated, inserted: false };
}

/**
 * Called by utils/sms/smsService after it writes. Only with the real model and
 * a live connection, and never allowed to fail the send that called it.
 */
async function mirrorAfterWrite(id, MessageModel) {
  if (MessageModel && MessageModel !== SmsMessage) return;
  if (mongoose.connection.readyState !== 1) return;
  try {
    await mirrorSmsMessage(id);
  } catch (error) {
    await core.healthEvent("mirror_failed", String(error?.message || "").slice(0, 120));
  }
}

module.exports = { mirrorAfterWrite, mirrorSmsMessage, recordInboundCall, recordInboundSms, recordKeywordEvent };
