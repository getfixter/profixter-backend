const User = require("../../models/User");
const CommMessage = require("../../models/CommMessage");
const { CommMediaUpload } = require("../../models/Comms");
const provider = require("../sms/twilioProvider");
const phoneStatus = require("../sms/smsPhoneStatus");
const { recordProviderOptOut } = require("../sms/smsService");
const { smsEnabled, twilioConfigured } = require("../sms/smsConfig");
const { estimateSegments, maskPhone, toE164 } = require("../sms/smsPhone");
const { findActiveBlockForUser } = require("../customerBlock");
const core = require("./core");
const { checkCommsSend } = require("./eligibility");
const { drainPending, isConfirmedFailure, FROM_TWILIO, rankOf } = require("./status");
const media = require("./media");

/**
 * Sending a text from Communications (one-to-one, and each bulk recipient).
 *
 * NEVER TWICE. The client sends an idempotency key with every Send; the
 * message row is INSERTED with that key before Twilio is called, so a
 * double-click, a reconnect or a retried request lands on the row that already
 * exists and is answered with it. Twilio's API has no idempotency key of its
 * own, so the one ambiguous case (our request timed out: did Twilio accept
 * it?) is marked "unknown" and settled by asking Twilio (reconcileUnknown),
 * never by sending again. Retrying is an explicit action, allowed only after a
 * CONFIRMED failure, and only once per failed message.
 */
const OPT_OUT_LINE = "Reply STOP to opt out.";
const MAX_BODY = 1600;
const KEY_RE = /^[A-Za-z0-9_-]{16,100}$/;

class SendError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Whether texts may leave from Communications right now, and if not, why. */
async function sendingState(kind = "manual") {
  const settings = await core.getSettings();
  if (!twilioConfigured()) return { on: false, reason: "Twilio isn't configured on the server." };
  if (!smsEnabled()) return { on: false, reason: "Texting is switched off on the server (SMS_ENABLED)." };
  if (kind === "bulk" ? !settings.bulkSendingEnabled : !settings.manualSendingEnabled) {
    return { on: false, reason: `${kind === "bulk" ? "Bulk" : "Manual"} texting is switched off. The owner can turn it on in Communications settings.` };
  }
  return { on: true, reason: "" };
}

function withOptOut(body, purpose) {
  if (purpose !== "marketing") return body;
  return /\bstop\b/i.test(body) ? body : `${body.trim()} ${OPT_OUT_LINE}`;
}

/**
 * Resolve who and where: an existing conversation, or a customer plus one of
 * their numbers. A number whose conversation belongs to a DIFFERENT customer
 * is refused, so starting a text from one customer can never write into
 * another customer's history.
 */
async function resolveTarget({ actor, conversationId, userId, toPhone }) {
  let conv = null;
  let user = null;
  if (conversationId) {
    if (!core.isObjectId(conversationId)) throw new SendError(400, "BAD_CONVERSATION", "Unknown conversation.");
    conv = await core.CommConversation.findById(conversationId);
    if (!conv || !conv.externalPhone) throw new SendError(404, "NO_CONVERSATION", "This conversation has no phone number to text.");
    if (toPhone && toE164(toPhone) !== conv.externalPhone) throw new SendError(400, "PHONE_MISMATCH", "That number doesn't belong to this conversation.");
    await core.revalidateLink(conv);
    if (conv.user) user = await User.findById(conv.user);
  } else {
    if (!core.isObjectId(userId)) throw new SendError(400, "CUSTOMER_REQUIRED", "Choose a customer.");
    user = await User.findOne({ _id: userId, role: { $ne: "employee" } });
    if (!user) throw new SendError(404, "NO_CUSTOMER", "Customer not found.");
    const phones = await core.phonesForUser(user);
    const e164 = toE164(toPhone) || phones[0]?.phone;
    if (!e164 || !phones.some((p) => p.phone === e164)) throw new SendError(400, "PHONE_NOT_ON_RECORD", "Choose one of this customer's numbers on record.");
    conv = await core.conversationForPhone(e164);
    if (conv.linkState === "linked" && String(conv.user) !== String(user._id)) {
      throw new SendError(409, "PHONE_BELONGS_TO_OTHER", "This number's conversation is linked to a different customer. Open that conversation or relink it first.", { conversationId: String(conv._id) });
    }
    if (conv.linkState !== "linked") {
      await core.touch(conv, { user: user._id, linkState: "linked", candidateUsers: [], linkedBy: actor._id, linkedAt: new Date(), displayName: core.displayNameOf(user) });
    }
  }
  return { conv, user };
}

async function mediaFor(mediaIds, actor) {
  const ids = (Array.isArray(mediaIds) ? mediaIds : []).slice(0, 5);
  if (!ids.length) return [];
  if (!ids.every(core.isObjectId)) throw new SendError(400, "BAD_MEDIA", "Unknown picture.");
  const rows = await CommMediaUpload.find({ _id: { $in: ids }, uploadedBy: actor._id, usedBy: null }).lean();
  if (rows.length !== ids.length) throw new SendError(400, "BAD_MEDIA", "A picture is missing or was already sent. Attach it again.");
  return rows;
}

/**
 * Send one text. Returns { message, duplicate }. Throws SendError for a
 * refusal (with the plain-English reason in .message).
 */
async function sendText({
  actor,
  conversationId = null,
  userId = null,
  toPhone = "",
  lineNumber,
  body,
  mediaIds = [],
  purpose = "service",
  idempotencyKey,
  quietHoursAck = false,
  kind = "manual",
  bulkSend = null,
  bulkRecipient = null,
  retryOf = undefined,
}) {
  if (!KEY_RE.test(String(idempotencyKey || ""))) throw new SendError(400, "IDEMPOTENCY_KEY_REQUIRED", "Missing idempotency key.");
  const existing = await CommMessage.findOne({ idempotencyKey });
  if (existing) return { message: existing, duplicate: true };

  const text = String(body || "").replace(/\r\n/g, "\n").trim();
  if (!text && !(mediaIds || []).length) throw new SendError(400, "EMPTY", "Type a message.");
  if (text.length > MAX_BODY) throw new SendError(400, "TOO_LONG", `Keep it under ${MAX_BODY} characters.`);

  const state = await sendingState(kind === "bulk" ? "bulk" : "manual");
  if (!state.on) throw new SendError(409, "SENDING_OFF", state.reason);

  const line = await core.senderFor(lineNumber);
  if (!line) throw new SendError(400, "UNKNOWN_LINE", "Choose a Profixter number to send from.");
  const uploads = await mediaFor(mediaIds, actor);
  if (uploads.length && !line.mms) throw new SendError(400, "NO_MMS", "This Profixter number can't send pictures.");

  const { conv, user } = await resolveTarget({ actor, conversationId, userId, toPhone });
  const blocked = user ? Boolean(await findActiveBlockForUser(user).catch(() => null)) : false;
  const verdict = await checkCommsSend({ purpose, phone: conv.externalPhone, user, mode: kind === "bulk" ? "bulk" : "manual", blocked });
  if (!verdict.eligible) throw new SendError(422, "NOT_ELIGIBLE", verdict.text, { reason: verdict.reason });
  const needsAck = verdict.warnings.filter((w) => w.requiresAck);
  if (needsAck.length && !quietHoursAck) throw new SendError(409, "NEEDS_CONFIRMATION", needsAck[0].text, { warnings: verdict.warnings });

  const finalBody = withOptOut(text, purpose);
  const now = new Date();
  let message;
  try {
    message = await CommMessage.create({
      conversation: conv._id,
      user: conv.user || null,
      channel: "sms",
      direction: "outbound",
      kind,
      body: finalBody,
      media: uploads.map((u) => ({ key: u.key, contentType: u.contentType, size: u.size, name: u.name })),
      fromAddress: line.number,
      toAddress: conv.externalPhone,
      lineNumber: line.number,
      author: actor._id,
      authorName: core.displayNameOf(actor),
      purpose,
      status: "sending",
      statusRank: 0,
      segments: estimateSegments(finalBody),
      provider: "twilio",
      idempotencyKey,
      retryOf,
      bulkSend,
      bulkRecipient,
      origin: kind === "bulk" ? "bulk" : "manual",
      attemptedAt: now,
      occurredAt: now,
    });
  } catch (err) {
    if (err?.code === 11000) {
      const again = await CommMessage.findOne(retryOf ? { $or: [{ idempotencyKey }, { retryOf }] } : { idempotencyKey });
      if (again) return { message: again, duplicate: true };
    }
    throw err;
  }
  if (uploads.length) await CommMediaUpload.updateMany({ _id: { $in: uploads.map((u) => u._id) } }, { $set: { usedBy: message._id } });
  await core.applyToConversation(message, { countUnread: false });

  try {
    const result = await provider.sendMessage({
      to: conv.externalPhone,
      body: finalBody,
      from: line.number,
      mediaUrls: uploads.map((u) => media.signedMediaUrl(u._id)),
      notificationType: kind === "bulk" ? "COMMS_BULK" : "COMMS_MANUAL",
    });
    const status = FROM_TWILIO[result.status] || "queued";
    message = await CommMessage.findByIdAndUpdate(
      message._id,
      { $set: { providerId: result.sid, providerStatus: result.status, status, statusRank: Math.max(rankOf(status), 1), segments: result.numSegments || message.segments } },
      { new: true }
    );
    await drainPending(result.sid);
    message = (await CommMessage.findById(message._id)) || message;
    console.log(JSON.stringify({ event: "comms_sms_sent", kind, sid: result.sid, to: maskPhone(conv.externalPhone) }));
  } catch (error) {
    // A timeout or dropped connection may have reached Twilio: never assume either way.
    const ambiguous = error?.reason === "provider_unreachable";
    if (provider.isOptOutError(error)) await recordProviderOptOut(conv.externalPhone);
    if (!ambiguous) await phoneStatus.recordFailure(conv.externalPhone, { code: error?.providerErrorCode, reason: error?.reason, notificationType: "COMMS_MANUAL" }).catch(() => {});
    message = await CommMessage.findByIdAndUpdate(
      message._id,
      {
        $set: {
          status: ambiguous ? "unknown" : "failed",
          statusRank: ambiguous ? 2 : 6,
          errorCode: String(error?.providerErrorCode || error?.reason || "").slice(0, 20),
          errorMessage: ambiguous
            ? "Twilio didn't answer in time. Checking whether it was sent; it will not be resent automatically."
            : String(error?.message || "Twilio refused the message.").slice(0, 300),
        },
      },
      { new: true }
    );
    await core.applyToConversation(message, { countUnread: false });
    await core.healthEvent(ambiguous ? "send_ambiguous" : "send_failed", String(error?.providerErrorCode || error?.reason || ""));
    console.warn(JSON.stringify({ event: "comms_sms_send_failed", kind, ambiguous, code: error?.providerErrorCode || "", reason: error?.reason || "" }));
  }
  return { message, duplicate: false };
}

/** Retry a confirmed failure, once, as a new message linked to the old one. */
async function retryText({ actor, messageId, idempotencyKey, quietHoursAck = false }) {
  if (!core.isObjectId(messageId)) throw new SendError(400, "BAD_MESSAGE", "Unknown message.");
  const original = await CommMessage.findById(messageId);
  if (!original || original.channel !== "sms" || original.direction !== "outbound" || !["manual", "bulk"].includes(original.kind)) {
    throw new SendError(404, "NO_MESSAGE", "Only texts sent from Communications can be retried.");
  }
  if (original.status === "unknown") throw new SendError(409, "STILL_CHECKING", "Still checking with Twilio whether this was sent. Retry becomes available if it wasn't.");
  if (!isConfirmedFailure(original.status)) throw new SendError(409, "NOT_FAILED", "Only a text that failed can be retried.");
  const prior = await CommMessage.findOne({ retryOf: original._id });
  if (prior) return { message: prior, duplicate: true };
  if (original.media?.length) throw new SendError(409, "MEDIA_RETRY", "Pictures can't be retried. Send a new message with the picture attached.");
  return sendText({
    actor,
    conversationId: original.conversation,
    lineNumber: original.lineNumber,
    body: original.body,
    purpose: original.purpose || "service",
    idempotencyKey,
    quietHoursAck,
    kind: original.kind,
    bulkSend: original.bulkSend,
    retryOf: original._id,
  });
}

/** An internal note. Never sent to anyone. */
async function addNote({ actor, conversationId, body, idempotencyKey }) {
  if (!KEY_RE.test(String(idempotencyKey || ""))) throw new SendError(400, "IDEMPOTENCY_KEY_REQUIRED", "Missing idempotency key.");
  const text = String(body || "").trim();
  if (!text) throw new SendError(400, "EMPTY", "Type a note.");
  if (text.length > 4000) throw new SendError(400, "TOO_LONG", "Keep notes under 4,000 characters.");
  const conv = core.isObjectId(conversationId) ? await core.CommConversation.findById(conversationId) : null;
  if (!conv) throw new SendError(404, "NO_CONVERSATION", "Unknown conversation.");
  const existing = await CommMessage.findOne({ idempotencyKey });
  if (existing) return { message: existing, duplicate: true };
  try {
    const message = await CommMessage.create({
      conversation: conv._id,
      user: conv.user || null,
      channel: "note",
      direction: "internal",
      kind: "note",
      body: text,
      author: actor._id,
      authorName: core.displayNameOf(actor),
      status: "logged",
      origin: "manual",
      idempotencyKey,
      occurredAt: new Date(),
    });
    await core.applyToConversation(message, { countUnread: false });
    return { message, duplicate: false };
  } catch (err) {
    if (err?.code === 11000) return { message: await CommMessage.findOne({ idempotencyKey }), duplicate: true };
    throw err;
  }
}

/**
 * Settle texts whose send request timed out, by asking Twilio. Adopts the
 * matching Twilio message when there is one; after 15 minutes with none, the
 * text is marked failed (Twilio never accepted it), which makes an explicit
 * retry available. Never resends.
 */
async function reconcileUnknown({ now = new Date(), limit = 25 } = {}) {
  const rows = await CommMessage.find({ status: "unknown", attemptedAt: { $lte: new Date(now.getTime() - 60 * 1000) } }).sort({ attemptedAt: 1 }).limit(limit);
  const out = { checked: 0, adopted: 0, failed: 0, errors: 0 };
  for (const m of rows) {
    out.checked += 1;
    try {
      const since = new Date(m.attemptedAt.getTime() - 2 * 60 * 1000);
      const found = await provider.findSentMessages({ to: m.toAddress, from: m.lineNumber, since });
      const want = String(m.body || "").trim();
      let match = null;
      for (const x of found) {
        if (String(x.body || "").trim() !== want) continue;
        if (new Date(x.date_created).getTime() < since.getTime()) continue;
        if (await CommMessage.exists({ provider: "twilio", providerId: x.sid })) continue;
        match = x;
        break;
      }
      if (match) {
        const status = FROM_TWILIO[match.status] || "queued";
        await CommMessage.updateOne({ _id: m._id, status: "unknown" }, { $set: { providerId: match.sid, providerStatus: match.status, status, statusRank: rankOf(status), errorCode: "", errorMessage: "" } });
        await drainPending(match.sid);
        out.adopted += 1;
      } else if (now.getTime() - m.attemptedAt.getTime() > 15 * 60 * 1000) {
        await CommMessage.updateOne({ _id: m._id, status: "unknown" }, { $set: { status: "failed", statusRank: 6, errorCode: "NOT_AT_PROVIDER", errorMessage: "Twilio has no record of this text, so it was not sent. You can retry it." } });
        out.failed += 1;
      }
      const fresh = await CommMessage.findById(m._id);
      if (fresh) await core.applyToConversation(fresh, { countUnread: false });
    } catch (error) {
      out.errors += 1;
      await core.healthEvent("reconcile_error", String(error?.message || "").slice(0, 120));
    }
  }
  return out;
}

module.exports = { OPT_OUT_LINE, SendError, addNote, reconcileUnknown, retryText, sendText, sendingState, withOptOut };
