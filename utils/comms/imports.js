const SmsMessage = require("../../models/SmsMessage");
const CommMessage = require("../../models/CommMessage");
const { CommImportRun } = require("../../models/Comms");
const { toE164, maskPhone } = require("../sms/smsPhone");
const { twilioCredentials } = require("../sms/smsConfig");
const core = require("./core");
const { FROM_TWILIO, rankOf } = require("./status");
const { mirrorSmsMessage } = require("./ingest");

/**
 * History imports (backfills), resumable and read-only on every source.
 *
 *   sms_mirror       Profixter's own automated-text records (SmsMessage)
 *   twilio_messages  Twilio's message log for the Profixter Messaging Service:
 *                    recovers the inbound replies that were never stored, and
 *                    any sends older than SmsMessage. Messages sent through
 *                    any other service (the Verify service's sign-in codes)
 *                    are skipped and never imported.
 *   twilio_calls     calls to and from Profixter's Twilio numbers (metadata)
 *   ghl              GoHighLevel conversations: texts, calls, emails, chats
 *
 * A run is started by the owner and advanced by the comms job, one bounded
 * slice per tick. The checkpoint is saved after every page; message ids are
 * unique, so re-reading a page (after a crash between write and checkpoint)
 * only counts duplicates. Nothing here sends, writes to a source, or marks
 * anything read.
 */
const SOURCES = ["sms_mirror", "twilio_messages", "twilio_calls", "ghl"];
const RUN_LOCK_MS = 3 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runFor(source) {
  return CommImportRun.findOneAndUpdate({ source }, { $setOnInsert: { source, status: "idle" } }, { upsert: true, new: true });
}

async function start({ source, actor }) {
  if (!SOURCES.includes(source)) throw Object.assign(new Error("Unknown import."), { status: 400 });
  if (source === "ghl" && !require("../ghl/client").ghl.config().configured) throw Object.assign(new Error("GoHighLevel isn't connected on the server."), { status: 409 });
  await runFor(source);
  return CommImportRun.findOneAndUpdate(
    { source, status: { $ne: "running" } },
    { $set: { status: "running", startedBy: actor?._id || null, startedAt: new Date(), finishedAt: null, lastError: "" } },
    { new: true }
  ).then((r) => r || CommImportRun.findOne({ source }));
}

async function pause({ source }) {
  return CommImportRun.findOneAndUpdate({ source, status: "running" }, { $set: { status: "paused" } }, { new: true });
}

/** Start over from the beginning (dedupe keeps it safe). */
async function reset({ source }) {
  return CommImportRun.findOneAndUpdate({ source, status: { $ne: "running" } }, { $set: { cursor: null, status: "idle", counts: {}, earliestAt: null, latestAt: null, finishedAt: null } }, { new: true });
}

function widen(run, at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return;
  if (!run.earliestAt || d < run.earliestAt) run.earliestAt = d;
  if (!run.latestAt || d > run.latestAt) run.latestAt = d;
}

/* ============================================================ sms_mirror */

async function sliceSmsMirror(run, { pages = 5 } = {}) {
  for (let p = 0; p < pages; p++) {
    const q = run.cursor ? { _id: { $gt: run.cursor } } : {};
    const rows = await SmsMessage.find(q).sort({ _id: 1 }).limit(200).lean();
    if (!rows.length) return true;
    for (const sms of rows) {
      run.counts.fetched += 1;
      try {
        const r = await mirrorSmsMessage(sms, { importRun: run._id });
        if (!r) run.counts.skipped += 1;
        else if (r.inserted) run.counts.inserted += 1;
        else run.counts.duplicates += 1;
        widen(run, sms.createdAt);
      } catch {
        run.counts.errors += 1;
      }
    }
    run.cursor = rows[rows.length - 1]._id;
    run.counts.pages += 1;
    run.heartbeatAt = new Date();
    await run.save();
  }
  return false;
}

/* ======================================================= twilio messages */

async function importTwilioMessage(run, x, ourService) {
  const provider = "twilio";
  if (await CommMessage.exists({ provider, providerId: x.sid })) {
    run.counts.duplicates += 1;
    return;
  }
  // Only Profixter's messaging service. Verify (sign-in codes) and anything else are never imported.
  if (!x.messaging_service_sid || x.messaging_service_sid !== ourService) {
    run.counts.skipped += 1;
    return;
  }
  const inbound = String(x.direction || "").startsWith("inbound");
  if (!inbound) {
    const sms = await SmsMessage.findOne({ providerMessageSid: x.sid }).lean();
    if (sms) {
      const r = await mirrorSmsMessage(sms, { importRun: run._id });
      run.counts[r?.inserted ? "inserted" : "duplicates"] += 1;
      return;
    }
  }
  const external = toE164(inbound ? x.from : x.to);
  if (!external) {
    run.counts.skipped += 1;
    return;
  }
  const conv = await core.conversationForPhone(external, { lineNumber: inbound ? x.to : x.from });
  const status = inbound ? "received" : FROM_TWILIO[x.status] || "sent";
  try {
    const m = await CommMessage.create({
      conversation: conv._id,
      user: conv.user || null,
      channel: "sms",
      direction: inbound ? "inbound" : "outbound",
      kind: inbound ? "customer" : "automation",
      authorName: inbound ? "" : "Sent from Profixter (Twilio history)",
      body: String(x.body || ""),
      media: Number(x.num_media) > 0 ? [{ name: "Picture (kept in Twilio)", external: true }] : [],
      fromAddress: toE164(x.from) || "",
      toAddress: toE164(x.to) || "",
      lineNumber: toE164(inbound ? x.to : x.from) || "",
      status,
      statusRank: rankOf(status),
      errorCode: x.error_code ? String(x.error_code) : "",
      segments: Number(x.num_segments) || 0,
      provider,
      providerId: x.sid,
      providerStatus: x.status,
      origin: "twilio_import",
      importRun: run._id,
      occurredAt: new Date(x.date_sent || x.date_created),
    });
    await core.applyToConversation(m, { countUnread: false });
    run.counts.inserted += 1;
    run.counts[conv.linkState === "linked" ? "matched" : "unmatched"] += 1;
  } catch (err) {
    if (err?.code === 11000) run.counts.duplicates += 1;
    else throw err;
  }
}

async function sliceTwilio(run, kind, { pages = 3 } = {}) {
  const provider = require("../sms/twilioProvider");
  const ourService = twilioCredentials().messagingServiceSid;
  for (let p = 0; p < pages; p++) {
    const path = run.cursor || (kind === "twilio_messages" ? "/Messages.json?PageSize=200" : "/Calls.json?PageSize=200");
    const json = await provider.twilioGet(path);
    const items = kind === "twilio_messages" ? json.messages || [] : json.calls || [];
    for (const x of items) {
      run.counts.fetched += 1;
      try {
        if (kind === "twilio_messages") await importTwilioMessage(run, x, ourService);
        else await importTwilioCall(run, x);
        widen(run, x.date_sent || x.date_created || x.start_time);
      } catch {
        run.counts.errors += 1;
      }
    }
    run.counts.pages += 1;
    run.heartbeatAt = new Date();
    if (!json.next_page_uri) {
      run.cursor = null;
      await run.save();
      return true;
    }
    run.cursor = json.next_page_uri;
    await run.save();
  }
  return false;
}

async function importTwilioCall(run, c) {
  if (await CommMessage.exists({ provider: "twilio", providerId: c.sid })) {
    run.counts.duplicates += 1;
    return;
  }
  const inbound = String(c.direction || "").startsWith("inbound");
  const external = toE164(inbound ? c.from : c.to);
  if (!external) {
    run.counts.skipped += 1;
    return;
  }
  const conv = await core.conversationForPhone(external, { lineNumber: inbound ? c.to : c.from });
  try {
    const m = await CommMessage.create({
      conversation: conv._id,
      user: conv.user || null,
      channel: "call",
      direction: inbound ? "inbound" : "outbound",
      kind: inbound ? "customer" : "automation",
      body: inbound ? "Called the Profixter texting number (recorded message)." : "Outgoing call from a Profixter Twilio number.",
      metadataOnly: true,
      fromAddress: toE164(c.from) || "",
      toAddress: toE164(c.to) || "",
      lineNumber: toE164(inbound ? c.to : c.from) || "",
      status: "logged",
      provider: "twilio",
      providerId: c.sid,
      call: { status: c.status || "", durationSec: Number(c.duration) || 0 },
      origin: "twilio_import",
      importRun: run._id,
      occurredAt: new Date(c.start_time || c.date_created),
    });
    await core.applyToConversation(m, { countUnread: false });
    run.counts.inserted += 1;
  } catch (err) {
    if (err?.code === 11000) run.counts.duplicates += 1;
    else throw err;
  }
}

/* ================================================================== GHL */

const GHL_TYPES = "TYPE_SMS,TYPE_CALL,TYPE_EMAIL,TYPE_FACEBOOK,TYPE_INSTAGRAM,TYPE_WHATSAPP,TYPE_GMB,TYPE_LIVE_CHAT,TYPE_ACTIVITY_APPOINTMENT";
const GHL_CHANNEL = {
  TYPE_SMS: ["sms", "Text (GoHighLevel)"],
  TYPE_CALL: ["call", "Call (GoHighLevel)"],
  TYPE_EMAIL: ["email", "Email (GoHighLevel)"],
  TYPE_FACEBOOK: ["chat", "Facebook"],
  TYPE_INSTAGRAM: ["chat", "Instagram"],
  TYPE_WHATSAPP: ["chat", "WhatsApp"],
  TYPE_GMB: ["chat", "Google Business"],
  TYPE_LIVE_CHAT: ["chat", "Website chat"],
  TYPE_WEBCHAT: ["chat", "Website chat"],
  TYPE_ACTIVITY_APPOINTMENT: ["system", "Appointment (GoHighLevel)"],
};
const GHL_STATUS = { delivered: "delivered", sent: "sent", failed: "failed", undelivered: "undelivered", read: "read", pending: "queued", connected: "logged", completed: "logged", voicemail: "logged", "no-answer": "logged", busy: "logged" };
const stripHtml = (s) => String(s || "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** Which conversation a GHL contact belongs to: by phone first, then a unique email, else its own key. */
async function conversationForGhl(c) {
  const phone = toE164(c.phone);
  if (phone) {
    const conv = await core.conversationForPhone(phone, { displayName: c.contactName || c.fullName || "" });
    if (!conv.ghlContactId && c.contactId) await core.touch(conv, { ghlContactId: c.contactId, displayName: conv.displayName || c.contactName || c.fullName || "" });
    return conv;
  }
  const key = `ghl:${c.contactId}`;
  let conv = await core.CommConversation.findOne({ contactKey: key });
  if (conv) return conv;
  const email = String(c.email || "").trim().toLowerCase();
  let link = { user: null, linkState: "unknown", candidateUsers: [] };
  if (email) {
    const User = require("../../models/User");
    const users = await User.find({ email, role: { $ne: "employee" } }).select("_id name").limit(3).lean();
    link = core.linkFromMatches(users);
  }
  try {
    conv = await core.CommConversation.create({ contactKey: key, externalEmail: email, ghlContactId: c.contactId, displayName: c.contactName || c.fullName || email || "GoHighLevel contact", ...link });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    conv = await core.CommConversation.findOne({ contactKey: key });
  }
  return conv;
}

function mapGhlMessage(m, conv, run) {
  const [channel, label] = GHL_CHANNEL[m.messageType] || ["chat", String(m.messageType || "Other").replace(/^TYPE_/, "")];
  const inbound = m.direction === "inbound";
  const automated = ["workflow", "campaign", "bulk_actions", "automation", "trigger"].includes(String(m.source || "").toLowerCase());
  const body = channel === "email" ? stripHtml(m.body || m.meta?.email?.body || "") : String(m.body || "");
  const status = GHL_STATUS[String(m.status || "").toLowerCase()] || (inbound ? "received" : "logged");
  return {
    conversation: conv._id,
    user: conv.user || null,
    channel,
    channelLabel: label,
    direction: channel === "system" ? "internal" : inbound ? "inbound" : "outbound",
    kind: channel === "system" ? "system" : inbound ? "customer" : automated ? "automation" : "manual",
    authorName: inbound ? "" : automated ? "GoHighLevel automation" : "GoHighLevel user",
    body: body.slice(0, 5000),
    subject: String(m.meta?.email?.subject || m.subject || "").slice(0, 300),
    metadataOnly: !body && channel !== "system",
    media: (m.attachments || []).slice(0, 10).map((u, i) => ({ name: `Attachment ${i + 1} (kept in GoHighLevel)`, external: true })),
    call: channel === "call" ? { durationSec: Number(m.meta?.call?.duration) || 0, status: String(m.meta?.call?.status || m.status || ""), hasRecording: Boolean(m.meta?.call?.recordingUrl || (m.attachments || []).length) } : undefined,
    status,
    statusRank: rankOf(status),
    provider: "ghl",
    providerId: String(m.id),
    providerStatus: String(m.status || ""),
    origin: "ghl_import",
    importRun: run._id,
    occurredAt: new Date(m.dateAdded),
  };
}

async function importGhlConversation(run, c) {
  const { ghl } = require("../ghl/client");
  const conv = await conversationForGhl(c);
  run.counts[conv.linkState === "linked" ? "matched" : "unmatched"] += 1;
  let lastMessageId;
  for (let page = 0; page < 50; page++) {
    const res = await ghl.getMessages(c.id, { lastMessageId, limit: 100, type: GHL_TYPES });
    const box = res?.messages || {};
    const items = Array.isArray(box) ? box : box.messages || [];
    for (const m of items) {
      run.counts.fetched += 1;
      if (!m?.id || !m.dateAdded) {
        run.counts.skipped += 1;
        continue;
      }
      try {
        const doc = await CommMessage.create(mapGhlMessage(m, conv, run));
        await core.applyToConversation(doc, { countUnread: false });
        run.counts.inserted += 1;
        widen(run, m.dateAdded);
      } catch (err) {
        if (err?.code === 11000) run.counts.duplicates += 1;
        else run.counts.errors += 1;
      }
    }
    if (!box.nextPage || !items.length) break;
    lastMessageId = box.lastMessageId || items[items.length - 1].id;
    await sleep(120);
  }
}

async function sliceGhl(run, { conversations = 25 } = {}) {
  const { ghl } = require("../ghl/client");
  const res = await ghl.searchConversations({ startAfterDate: run.cursor || undefined, limit: conversations });
  const list = res?.conversations || [];
  if (!list.length) return true;
  for (const c of list) {
    try {
      await importGhlConversation(run, c);
    } catch (err) {
      run.counts.errors += 1;
      run.lastError = String(err?.message || "").slice(0, 200);
      if (err?.status === 429) {
        await run.save();
        return false; // rate limited: resume next tick from the same checkpoint
      }
    }
    run.cursor = Array.isArray(c.sort) ? c.sort[0] : c.lastMessageDate;
    run.heartbeatAt = new Date();
    await run.save();
    await sleep(120);
  }
  run.counts.pages += 1;
  await run.save();
  return list.length < conversations;
}

/* ================================================================ runner */

/**
 * Advance every running import by one slice. Each run is claimed with a
 * lock so two servers never work the same import at once.
 */
async function runImportsTick({ now = new Date() } = {}) {
  const out = {};
  for (const source of SOURCES) {
    const run = await CommImportRun.findOneAndUpdate(
      { source, status: "running", $or: [{ lockExpiresAt: null }, { lockExpiresAt: { $lte: now } }] },
      { $set: { lockExpiresAt: new Date(now.getTime() + RUN_LOCK_MS) } },
      { new: true }
    );
    if (!run) continue;
    try {
      const finished =
        source === "sms_mirror" ? await sliceSmsMirror(run) : source === "ghl" ? await sliceGhl(run) : await sliceTwilio(run, source);
      if (finished) {
        // GHL keeps its checkpoint so the next run only reads newer activity; the others start over safely.
        Object.assign(run, { status: "done", finishedAt: new Date() });
      }
      out[source] = { finished, counts: run.counts };
    } catch (err) {
      run.lastError = String(err?.message || "").slice(0, 200);
      run.counts.errors += 1;
      if (err?.status === 401 || err?.status === 403) run.status = "failed";
      await core.healthEvent("import_error", `${source}: ${run.lastError}`);
      out[source] = { error: run.lastError };
    } finally {
      run.lockExpiresAt = null;
      await run.save();
    }
  }
  return out;
}

/**
 * Keep new GoHighLevel activity flowing once the owner has switched sync on:
 * re-runs the GHL import from its checkpoint (newer activity sorts after it).
 */
async function ghlIncrementalTick() {
  const settings = await core.getSettings();
  if (!settings.ghlSyncEnabled) return { skipped: true };
  const run = await runFor("ghl");
  if (run.status === "done" || run.status === "idle") await CommImportRun.updateOne({ _id: run._id }, { $set: { status: "running" } });
  return { resumed: true };
}

void maskPhone;
module.exports = { SOURCES, ghlIncrementalTick, mapGhlMessage, pause, reset, runImportsTick, start };
