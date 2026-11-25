const mongoose = require("mongoose");
const User = require("../../models/User");
const Booking = require("../../models/Booking");
const CommConversation = require("../../models/CommConversation");
const CommMessage = require("../../models/CommMessage");
const { CommSettings, CommHealthEvent } = require("../../models/Comms");
const { toE164, userPhoneQuery } = require("../sms/smsPhone");
const { twilioCredentials } = require("../sms/smsConfig");

/**
 * The shared core of Communications: settings and lines, who a phone number
 * belongs to, and keeping a conversation's summary in step with its messages.
 */

/* ============================================================ settings */

let settingsCache = null;
let settingsCacheAt = 0;

async function getSettings({ fresh = false } = {}) {
  if (!fresh && settingsCache && Date.now() - settingsCacheAt < 5000) return settingsCache;
  const doc = await CommSettings.findOneAndUpdate({ _id: "comms" }, { $setOnInsert: { _id: "comms" } }, { upsert: true, new: true }).lean();
  settingsCache = doc;
  settingsCacheAt = Date.now();
  return doc;
}
function clearSettingsCache() {
  settingsCache = null;
}

/**
 * The Profixter lines Admin may text from.
 *
 * From the owner's last read-only refresh of the Twilio sender pool, or, until
 * then, the one number configured on the server. Each line is sent through
 * the Messaging Service with that number as From, so the customer sees exactly
 * the number chosen and the service's opt-out handling still applies.
 */
async function senders() {
  const s = await getSettings();
  const creds = twilioCredentials();
  if (s.senders?.length) return s.senders.map((x) => ({ ...x, messagingServiceSid: x.messagingServiceSid || creds.messagingServiceSid }));
  const n = toE164(creds.phoneNumber);
  return n ? [{ number: n, label: "Profixter texts", messagingServiceSid: creds.messagingServiceSid, sms: true, mms: true }] : [];
}

async function senderFor(number) {
  const e = toE164(number);
  return (await senders()).find((x) => x.number === e) || null;
}

/* =========================================================== contacts */

/** Customer accounts that use this number (never staff accounts). */
async function usersForPhone(phone, { select = "_id name firstName lastName email phone userId isActive" } = {}) {
  const q = userPhoneQuery(phone);
  if (!q) return [];
  return User.find({ ...q, role: { $ne: "employee" } }).select(select).limit(10).lean();
}

/**
 * Every number a customer can be texted on: the account's number and the
 * numbers given on their bookings, newest first, each labelled.
 */
async function phonesForUser(user) {
  const out = [];
  const add = (phone, label) => {
    const e = toE164(phone);
    if (e && !out.some((p) => p.phone === e)) out.push({ phone: e, label });
  };
  add(user.phone, "Account");
  const bookings = await Booking.find({ $or: [{ user: user._id }, ...(user.userId ? [{ userId: user.userId }] : [])] })
    .select("phone bookingNumber createdAt")
    .sort({ createdAt: -1 })
    .limit(25)
    .lean();
  for (const b of bookings) add(b.phone, `Booking ${b.bookingNumber || ""}`.trim());
  return out;
}

const displayNameOf = (u) => (u ? String(u.name || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || "").trim() : "");

/* ======================================================= conversations */

const contactKeyForPhone = (phone) => {
  const e = toE164(phone);
  return e ? `tel:${e}` : "";
};

/**
 * Find or create the conversation for a phone number, and decide who it is.
 *
 * Exactly one customer on the number links it. Several make it ambiguous with
 * the candidates listed. A conversation an admin linked keeps that link, unless
 * the linked customer no longer uses the number and somebody else does now (a
 * recycled number): then it becomes ambiguous again, so a stranger's new
 * messages never land on the old customer's history.
 */
async function conversationForPhone(phone, { lineNumber = "", displayName = "" } = {}) {
  const e164 = toE164(phone);
  if (!e164) throw new Error("conversationForPhone needs a valid phone");
  const key = contactKeyForPhone(e164);
  let conv = await CommConversation.findOne({ contactKey: key });
  if (!conv) {
    const matches = await usersForPhone(e164);
    const doc = {
      contactKey: key,
      externalPhone: e164,
      lineNumber: toE164(lineNumber) || "",
      displayName: displayName || "",
      ...linkFromMatches(matches),
    };
    try {
      conv = await CommConversation.create(doc);
    } catch (err) {
      if (err?.code !== 11000) throw err;
      conv = await CommConversation.findOne({ contactKey: key });
    }
    return conv;
  }
  await revalidateLink(conv);
  return conv;
}

function linkFromMatches(matches) {
  if (matches.length === 1) return { user: matches[0]._id, linkState: "linked", candidateUsers: [], displayName: displayNameOf(matches[0]) };
  if (matches.length > 1) return { user: null, linkState: "ambiguous", candidateUsers: matches.map((m) => m._id) };
  return { user: null, linkState: "unknown", candidateUsers: [] };
}

async function revalidateLink(conv) {
  if (!conv.externalPhone) return conv;
  const matches = await usersForPhone(conv.externalPhone);
  if (conv.linkState === "linked" && conv.user) {
    const stillThere = matches.some((m) => String(m._id) === String(conv.user));
    // Admin-linked contacts whose number lives only on a booking stay linked.
    if (stillThere || !matches.length || conv.linkedBy) return conv;
    Object.assign(conv, { user: null, linkState: "ambiguous", candidateUsers: matches.map((m) => m._id) });
    await touch(conv);
    await healthEvent("link_revoked_number_reassigned", String(conv._id));
    return conv;
  }
  if (conv.linkState !== "linked") {
    const next = linkFromMatches(matches);
    const changed = next.linkState !== conv.linkState || String(next.user || "") !== String(conv.user || "") || String(next.candidateUsers) !== String(conv.candidateUsers || []);
    if (changed) {
      Object.assign(conv, next);
      await touch(conv);
    }
  }
  return conv;
}

/** Save with a version bump and changedAt, so the live inbox notices. */
async function touch(conv, extra = {}) {
  Object.assign(conv, extra);
  conv.version = Number(conv.version || 0) + 1;
  conv.changedAt = new Date();
  await conv.save();
  return conv;
}

/** Bump a conversation by id (atomic), for writers that hold no document. */
async function bump(conversationId, set = {}, inc = {}) {
  return CommConversation.findByIdAndUpdate(
    conversationId,
    { $set: { ...set, changedAt: new Date() }, $inc: { version: 1, ...inc } },
    { new: true }
  );
}

const preview = (m) =>
  m.channel === "note"
    ? `Note: ${m.body}`.slice(0, 140)
    : m.channel === "call"
      ? `${m.direction === "inbound" ? "Incoming" : "Outgoing"} call${m.call?.durationSec ? ` · ${Math.round(m.call.durationSec / 60) || "<1"} min` : ""}`
      : String(m.body || (m.media?.length ? "Picture" : m.subject || "")).replace(/\s+/g, " ").slice(0, 140);

/**
 * Fold one new message into its conversation's summary (atomic $max/$set so
 * concurrent writers cannot move "last message" backwards).
 */
async function applyToConversation(message, { countUnread = true } = {}) {
  if (!message.conversation) return null;
  const at = message.occurredAt || new Date();
  const set = {};
  const inc = {};
  const conv = await CommConversation.findById(message.conversation).select("lastMessageAt importOnly").lean();
  if (!conv) return null;
  const newest = !conv.lastMessageAt || at >= new Date(conv.lastMessageAt);
  if (newest && message.channel !== "system") {
    Object.assign(set, {
      lastMessageAt: at,
      lastPreview: preview(message),
      lastDirection: message.direction,
      lastKind: message.kind,
      lastChannel: message.channel,
    });
  }
  const isLive = !String(message.origin || "").endsWith("_import");
  // A conversation is history-only (hidden from the everyday inbox unless linked) until a live message arrives.
  if (isLive) set.importOnly = false;
  const update = { $set: { ...set, changedAt: new Date() }, $inc: { version: 1 }, $addToSet: { channels: message.channel } };
  if (message.lineNumber) {
    update.$addToSet.lines = message.lineNumber;
    if (newest && message.channel === "sms") update.$set.lineNumber = message.lineNumber;
  }
  if (message.direction === "inbound" && message.kind === "customer") {
    update.$max = { lastInboundAt: at };
    if (isLive) {
      update.$set.archived = false; // a reply brings an archived conversation back
      update.$set.needsReply = true;
      if (countUnread) inc.unreadCount = 1;
    }
  }
  if (message.direction === "outbound" && (message.kind === "manual" || message.kind === "bulk")) {
    update.$max = { ...(update.$max || {}), lastManualOutboundAt: at };
    update.$set.needsReply = false;
  }
  if (["failed", "undelivered"].includes(message.status)) update.$set.deliveryProblem = true;
  if (message.status === "delivered" && message.kind !== "customer") update.$set.deliveryProblem = false;
  Object.assign(update.$inc, inc);
  if (!Object.keys(update.$addToSet).length) delete update.$addToSet;
  return CommConversation.findByIdAndUpdate(message.conversation, update, { new: true });
}

/* ============================================================== health */

async function healthEvent(type, detail = "") {
  try {
    await CommHealthEvent.create({ type, detail: String(detail).slice(0, 200) });
  } catch {
    /* monitoring must never break the thing it watches */
  }
}

const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && String(new mongoose.Types.ObjectId(String(v))) === String(v);

module.exports = {
  CommConversation,
  CommMessage,
  applyToConversation,
  bump,
  clearSettingsCache,
  contactKeyForPhone,
  conversationForPhone,
  displayNameOf,
  getSettings,
  healthEvent,
  isObjectId,
  linkFromMatches,
  phonesForUser,
  preview,
  revalidateLink,
  senderFor,
  senders,
  touch,
  usersForPhone,
};
