/**
 * GoHighLevel → Profixter, the smallest reliable sync (reports/TELEMARKETER-AUDIT.md §9).
 *
 * Telemarketers call and text in GHL. Profixter receives, per mapped contact:
 *   - ContactDndUpdate        do-not-disturb turned on → a Profixter suppression
 *                             (most restrictive wins: GHL turning DND OFF never
 *                             lifts a Profixter restriction; only the owner can)
 *   - InboundMessage /        call and text METADATA as lead activity: time,
 *     OutboundMessage         direction, channel, status, duration, ids. Message
 *                             bodies and recordings are never stored. An inbound
 *                             STOP-type keyword also suppresses texting at once.
 * Everything else is acknowledged and ignored.
 *
 * Mapping is explicit: SalesLead.ghlContactId (set by the employee or owner).
 * Nothing is ever matched by phone or email. Unmapped events are kept, visible
 * to the owner, and re-processed when the contact is mapped.
 *
 * Safety:
 *   - OFF unless GHL_SALES_SYNC_ENABLED is exactly "true" (503 otherwise).
 *   - Every delivery must carry a valid X-GHL-Signature (Ed25519 over the raw
 *     body, GHL's published public key in GHL_WEBHOOK_PUBLIC_KEY, PEM).
 *   - Each delivery is stored once (eventId unique): GHL retries and replays
 *     are no-ops. Processing failures are kept with the error and retried with
 *     backoff (retryFailed, run by a job); the owner sees them.
 *   - Nothing here sends anything to GHL or to a customer.
 */
const crypto = require("crypto");
const { GhlWebhookEvent, SalesLead, SalesActivity } = require("../../models/Sales");
const { addSuppression } = require("./leads");

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke", "optout", "opt out", "opt-out"]);
const MAX_ATTEMPTS = 6;

const enabled = () => process.env.GHL_SALES_SYNC_ENABLED === "true";

function publicKey() {
  const raw = String(process.env.GHL_WEBHOOK_PUBLIC_KEY || "").replace(/\\n/g, "\n").trim();
  if (!raw) return null;
  try {
    return crypto.createPublicKey(raw);
  } catch {
    return null;
  }
}

function verifySignature(rawBody, signature, key = publicKey()) {
  if (!key || !signature || !Buffer.isBuffer(rawBody)) return false;
  try {
    return crypto.verify(null, rawBody, key, Buffer.from(String(signature), "base64"));
  } catch {
    return false;
  }
}

/** Keep only what Profixter needs; message text is dropped here, before anything is stored. */
function metadataOnly(body) {
  const pick = (k) => (body[k] === undefined ? undefined : body[k]);
  const dnd = body.dndSettings && typeof body.dndSettings === "object" ? Object.fromEntries(Object.entries(body.dndSettings).map(([ch, v]) => [ch, { status: v?.status || null }])) : undefined;
  return {
    type: pick("type"),
    locationId: pick("locationId"),
    contactId: pick("contactId") || pick("id"),
    conversationId: pick("conversationId"),
    messageId: pick("messageId"),
    messageType: pick("messageType"),
    direction: pick("direction"),
    status: pick("status"),
    callDuration: pick("callDuration"),
    callStatus: pick("callStatus"),
    userId: pick("userId"),
    dateAdded: pick("dateAdded"),
    dnd: typeof body.dnd === "boolean" ? body.dnd : undefined,
    dndSettings: dnd,
    stopKeyword: typeof body.body === "string" && STOP_WORDS.has(body.body.trim().toLowerCase()) ? true : undefined,
  };
}

function eventIdOf(body, rawBody) {
  const id = body.webhookId || body.eventId || null;
  if (id) return String(id).slice(0, 120);
  return `sha256:${crypto.createHash("sha256").update(rawBody).digest("hex")}`;
}

/** Express handler for POST /api/ghl/webhook (raw body). */
async function receive(req, res) {
  if (!enabled()) return res.status(503).json({ code: "SYNC_DISABLED", message: "GoHighLevel sync is not enabled." });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : "");
  if (!verifySignature(raw, req.get("x-ghl-signature"))) return res.status(401).json({ code: "BAD_SIGNATURE" });
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ code: "BAD_JSON" });
  }
  const payload = metadataOnly(body || {});
  const eventId = eventIdOf(body || {}, raw);
  let doc;
  try {
    doc = await GhlWebhookEvent.create({ eventId, type: String(payload.type || ""), contactId: payload.contactId ? String(payload.contactId) : null, payload });
  } catch (error) {
    if (error?.code === 11000) return res.json({ ok: true, duplicate: true });
    console.error("ghl webhook store failed:", error.message);
    return res.status(500).json({ code: "STORE_FAILED" });
  }
  await processEvent(doc._id);
  return res.json({ ok: true });
}

const ACTIVE = (v) => String(v?.status || "").toLowerCase() === "active";

async function handle(doc) {
  const p = doc.payload || {};
  const type = String(p.type || doc.type || "");
  if (!["ContactDndUpdate", "InboundMessage", "OutboundMessage"].includes(type)) return { status: "ignored", outcome: `type ${type || "unknown"} not used` };
  if (!p.contactId) return { status: "ignored", outcome: "no contact id" };
  const lead = await SalesLead.findOne({ ghlContactId: String(p.contactId), status: { $in: ["active", "intake"] } }).lean();
  if (!lead) return { status: "unmapped", outcome: "no lead is mapped to this GHL contact" };
  const at = p.dateAdded && !Number.isNaN(new Date(p.dateAdded).getTime()) ? new Date(p.dateAdded) : doc.receivedAt;

  if (type === "ContactDndUpdate") {
    const s = p.dndSettings || {};
    const call = p.dnd === true || ACTIVE(s.Call);
    const sms = p.dnd === true || ACTIVE(s.SMS);
    if (call || sms) {
      await addSuppression({ phone: lead.phone, channel: call && sms ? "all" : call ? "call" : "sms", source: "ghl", reason: "Do-not-disturb turned on in GoHighLevel", lead, ghlEventId: doc.eventId, at });
      await SalesActivity.create({ lead: lead._id, actorRole: "ghl", kind: "ghl_dnd", body: `GHL do-not-disturb on (${call && sms ? "calls and texts" : call ? "calls" : "texts"})`, source: "ghl", ghl: { eventId: doc.eventId }, at });
      return { status: "processed", outcome: "suppressed" };
    }
    await SalesActivity.create({ lead: lead._id, actorRole: "ghl", kind: "ghl_dnd", body: "GHL do-not-disturb turned off. Profixter restrictions stay until the owner lifts them.", source: "ghl", ghl: { eventId: doc.eventId }, at });
    return { status: "processed", outcome: "dnd_off_noted" };
  }

  const mt = String(p.messageType || "").toUpperCase();
  const channel = mt.includes("CALL") || mt.includes("VOICEMAIL") ? "call" : mt.includes("SMS") ? "sms" : null;
  if (!channel) return { status: "ignored", outcome: `message type ${mt || "unknown"} not used` };
  const direction = type === "InboundMessage" ? "inbound" : "outbound";
  try {
    await SalesActivity.create({
      lead: lead._id,
      actorRole: "ghl",
      kind: channel === "call" ? "ghl_call" : "ghl_sms",
      body: `${direction === "inbound" ? "Inbound" : "Outbound"} ${channel === "call" ? "call" : "text"}${p.callStatus || p.status ? ` (${p.callStatus || p.status})` : ""}${p.callDuration ? `, ${p.callDuration}s` : ""}`,
      source: "ghl",
      ghl: { eventId: doc.eventId, direction, channel, status: p.callStatus || p.status || null, durationSec: Number(p.callDuration) || null, conversationId: p.conversationId || null, messageId: p.messageId || null },
      at,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  if (direction === "inbound" && channel === "sms" && p.stopKeyword) {
    await addSuppression({ phone: lead.phone, channel: "sms", source: "ghl", reason: "Replied with an opt-out keyword in GoHighLevel", lead, ghlEventId: doc.eventId, at });
  }
  if (p.conversationId && !lead.ghlConversationId) await SalesLead.updateOne({ _id: lead._id, ghlConversationId: null }, { $set: { ghlConversationId: String(p.conversationId) } });
  await SalesLead.updateOne({ _id: lead._id }, { $max: { lastActivityAt: at } });
  return { status: "processed", outcome: `${direction}_${channel}` };
}

async function processEvent(id) {
  const doc = await GhlWebhookEvent.findById(id);
  if (!doc || doc.status === "processed" || doc.status === "ignored") return doc;
  doc.attempts += 1;
  try {
    const r = await handle(doc.toObject());
    doc.status = r.status;
    doc.outcome = r.outcome;
    doc.lastError = "";
    doc.nextAttemptAt = null;
    doc.processedAt = new Date();
  } catch (error) {
    doc.status = "failed";
    doc.lastError = String(error?.message || error).slice(0, 500);
    doc.nextAttemptAt = doc.attempts >= MAX_ATTEMPTS ? null : new Date(Date.now() + Math.min(6 * 3600, 60 * 2 ** doc.attempts) * 1000);
  }
  await doc.save();
  return doc;
}

/*
 * While sync is OFF nothing is processed at all: not new deliveries (503 above),
 * not the 10-minute retry job, not the owner's Retry button, and not the replay
 * that mapping a contact would start. Stored events simply wait. This keeps the
 * whole GHL path inert until its live setup is verified and the flag is set.
 */

/** Retry failed events whose backoff has passed (and unmapped ones, now possibly mapped). */
async function retryFailed({ limit = 100 } = {}) {
  if (!enabled()) return 0;
  const due = await GhlWebhookEvent.find({ status: "failed", nextAttemptAt: { $ne: null, $lte: new Date() } }).limit(limit).select("_id").lean();
  for (const d of due) await processEvent(d._id);
  return due.length;
}

/** After a contact is mapped: replay its unmapped events. */
async function replayUnmapped(contactId) {
  if (!enabled()) return 0;
  const list = await GhlWebhookEvent.find({ contactId: String(contactId), status: "unmapped" }).select("_id").lean();
  for (const d of list) {
    await GhlWebhookEvent.updateOne({ _id: d._id, status: "unmapped" }, { $set: { status: "received" } });
    await processEvent(d._id);
  }
  return list.length;
}

async function syncStatus() {
  const counts = await GhlWebhookEvent.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
  const failures = await GhlWebhookEvent.find({ status: "failed" }).sort({ updatedAt: -1 }).limit(20).select("eventId type contactId attempts lastError nextAttemptAt receivedAt").lean();
  const unmapped = await GhlWebhookEvent.aggregate([{ $match: { status: "unmapped" } }, { $group: { _id: "$contactId", n: { $sum: 1 }, last: { $max: "$receivedAt" } } }, { $sort: { last: -1 } }, { $limit: 20 }]);
  const last = await GhlWebhookEvent.findOne({}).sort({ receivedAt: -1 }).select("receivedAt").lean();
  return {
    enabled: enabled(),
    signatureKeyConfigured: Boolean(publicKey()),
    locationConfigured: Boolean(process.env.GHL_LOCATION_ID),
    liveVerified: false,
    liveNote: "Live GHL delivery has not been verified. The account, the webhook subscription and the public key must be confirmed before enabling.",
    counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
    lastReceivedAt: last?.receivedAt || null,
    failures,
    unmapped: unmapped.map((u) => ({ contactId: u._id, events: u.n, lastAt: u.last })),
  };
}

async function retryOne(id) {
  if (!enabled()) {
    const { SalesError } = require("./ledger");
    throw new SalesError("SYNC_DISABLED", "GoHighLevel sync is off. Events are kept and processed only after the live setup is verified and sync is turned on.", 409);
  }
  const doc = await GhlWebhookEvent.findById(id);
  if (!doc) return null;
  if (doc.status === "failed" || doc.status === "unmapped") {
    doc.status = "received";
    doc.nextAttemptAt = null;
    await doc.save();
  }
  return processEvent(doc._id);
}

module.exports = { receive, verifySignature, metadataOnly, processEvent, retryFailed, replayUnmapped, syncStatus, retryOne, MAX_ATTEMPTS };
