const express = require("express");
const multer = require("multer");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission, permissionsForUser } = require("../middleware/authorize");
const User = require("../models/User");
const CommConversation = require("../models/CommConversation");
const CommMessage = require("../models/CommMessage");
const { CommBulkSend, CommBulkRecipient, CommSavedReply, CommSettings, CommImportRun, CommHealthEvent } = require("../models/Comms");
const { createAdminActivityLog } = require("../utils/adminActivityLog");
const core = require("../utils/comms/core");
const read = require("../utils/comms/read");
const send = require("../utils/comms/send");
const bulk = require("../utils/comms/bulk");
const imports = require("../utils/comms/imports");
const media = require("../utils/comms/media");
const { checkCommsSend } = require("../utils/comms/eligibility");
const { findActiveBlockForUser } = require("../utils/customerBlock");
const { toE164 } = require("../utils/sms/smsPhone");

/**
 * Communications: the shared inbox, customer history, manual and bulk texts.
 *
 * Every route checks its permission on the server (utils/adminAccess.js):
 *   comms.read  read conversations, threads, timelines, media
 *   comms.send  send one-to-one, notes, read/archive/assign, link numbers
 *   comms.bulk  prepare bulk texts (only the owner approves)
 *   admin.all   settings, sender refresh, history imports, approvals
 * Field Fixters hold none of these. Message text is never logged.
 */
const router = express.Router();
const canRead = requirePermission(PERMISSIONS.COMMS_READ);
const canSend = requirePermission(PERMISSIONS.COMMS_SEND);
const canBulk = requirePermission(PERMISSIONS.COMMS_BULK);
const ownerOnly = requirePermission(PERMISSIONS.ADMIN);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

router.use(auth);

const isOwner = (req) => req.accessRole === "admin";
const actorOf = (req) => req.accessUser;
const oid = (v) => new mongoose.Types.ObjectId(String(v));

function fail(res, error) {
  if (error?.status && error?.code) {
    return res.status(error.status).json({ message: error.message, code: error.code, ...(error.reason ? { reason: error.reason } : {}), ...(error.warnings ? { warnings: error.warnings } : {}), ...(error.conversationId ? { conversationId: error.conversationId } : {}) });
  }
  if (error?.status && error.status < 500) return res.status(error.status).json({ message: error.message });
  console.error(JSON.stringify({ event: "comms_route_error", message: String(error?.message || "").slice(0, 200) }));
  return res.status(500).json({ message: "Something went wrong. Try again." });
}

const log = (req, action, entityType, entityId, entityName, details = {}) =>
  createAdminActivityLog(req, { action, entityType, entityId, entityName, details }).catch(() => {});

async function loadConversation(req, res) {
  if (!core.isObjectId(req.params.id)) return void res.status(404).json({ message: "Conversation not found." });
  const conv = await CommConversation.findById(req.params.id);
  if (!conv) return void res.status(404).json({ message: "Conversation not found." });
  return conv;
}

/* ============================================================ bootstrap */

/** Everything the screen needs once: who you are allowed to be, lines, switches, saved replies, teammates. */
router.get("/bootstrap", ...canRead, async (req, res) => {
  try {
    const settings = await core.getSettings();
    const perms = req.permissions;
    const owner = isOwner(req);
    const [lines, manual, bulkState, replies, team] = await Promise.all([
      core.senders(),
      send.sendingState("manual"),
      send.sendingState("bulk"),
      CommSavedReply.find({ archived: false }).sort({ title: 1 }).lean(),
      assignableTeam(),
    ]);
    res.json({
      me: { id: String(actorOf(req)._id), name: core.displayNameOf(actorOf(req)) },
      can: {
        read: true,
        send: owner || perms.includes(PERMISSIONS.COMMS_SEND),
        bulk: owner || perms.includes(PERMISSIONS.COMMS_BULK),
        approve: owner,
        settings: owner,
      },
      lines: lines.map((l) => ({ number: l.number, label: l.label || "", mms: Boolean(l.mms) })),
      sending: { manual, bulk: bulkState },
      inboundAutoReply: settings.inboundAutoReply,
      registration: settings.registration || {},
      savedReplies: replies.map((r) => ({ id: String(r._id), title: r.title, body: r.body, purpose: r.purpose })),
      team,
      segments: bulk.SEGMENTS,
      counts: await read.inboxCounts(actorOf(req)._id),
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    fail(res, error);
  }
});

async function assignableTeam() {
  const staff = await User.find({ $or: [{ role: "admin" }, { role: "employee", isActive: { $ne: false } }] })
    .select("_id name firstName lastName email role employeePosition adminSections isActive")
    .lean();
  return staff
    .filter((u) => u.role === "admin" || permissionsForUser(u).includes(PERMISSIONS.COMMS_READ))
    .map((u) => ({ id: String(u._id), name: core.displayNameOf(u) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ======================================================== conversations */

router.get("/conversations", ...canRead, async (req, res) => {
  try {
    res.json(await read.listConversations({ ...req.query, actorId: actorOf(req)._id }));
  } catch (error) {
    fail(res, error);
  }
});

/** Live updates: conversations changed since the token (the inbox polls this). */
router.get("/changes", ...canRead, async (req, res) => {
  try {
    res.json(await read.changesSince({ since: req.query.since, actorId: actorOf(req)._id }));
  } catch (error) {
    fail(res, error);
  }
});

router.get("/search", ...canRead, async (req, res) => {
  try {
    res.json(await read.search({ q: req.query.q }));
  } catch (error) {
    fail(res, error);
  }
});

router.get("/conversations/:id", ...canRead, async (req, res) => {
  try {
    const conv = await loadConversation(req, res);
    if (!conv) return;
    await core.revalidateLink(conv);
    const users = await read.usersById([conv.user, ...(conv.candidateUsers || [])]);
    const candidates = (conv.candidateUsers || []).map((id) => users.get(String(id))).filter(Boolean).map((u) => ({ id: String(u._id), name: core.displayNameOf(u), email: u.email || "" }));
    res.json({
      conversation: read.conversationDto(conv.toObject(), users),
      customer: conv.user ? await read.customerPanel(conv.user) : null,
      candidates,
    });
  } catch (error) {
    fail(res, error);
  }
});

router.get("/conversations/:id/messages", ...canRead, async (req, res) => {
  try {
    const conv = await loadConversation(req, res);
    if (!conv) return;
    res.json(await read.threadPage({ conversationId: conv._id, before: req.query.before, after: req.query.after, limit: req.query.limit }));
  } catch (error) {
    fail(res, error);
  }
});

router.get("/conversations/:id/changes", ...canRead, async (req, res) => {
  try {
    const conv = await loadConversation(req, res);
    if (!conv) return;
    res.json(await read.threadChanges({ conversationId: conv._id, since: req.query.since }));
  } catch (error) {
    fail(res, error);
  }
});

/** Opening a thread with Send rights marks it read for everyone (shared inbox). */
router.post("/conversations/:id/read", ...canSend, async (req, res) => {
  try {
    const conv = await core.bump(req.params.id, { unreadCount: 0 });
    if (!conv) return res.status(404).json({ message: "Conversation not found." });
    res.json({ conversation: read.conversationDto(conv.toObject(), await read.usersById([conv.user])) });
  } catch (error) {
    fail(res, error);
  }
});

const SINGLE_ACTIONS = {
  unread: () => ({ unreadCount: 1 }),
  archive: () => ({ archived: true, archivedAt: new Date() }),
  reopen: () => ({ archived: false, archivedAt: null }),
  done: () => ({ needsReply: false }),
};

router.post("/conversations/:id/:action(unread|archive|reopen|done)", ...canSend, async (req, res) => {
  try {
    const conv = await core.bump(req.params.id, SINGLE_ACTIONS[req.params.action]());
    if (!conv) return res.status(404).json({ message: "Conversation not found." });
    res.json({ conversation: read.conversationDto(conv.toObject(), await read.usersById([conv.user])) });
  } catch (error) {
    fail(res, error);
  }
});

async function assigneeFields(userId) {
  if (!userId) return { assignedTo: null, assignedToName: "" };
  if (!core.isObjectId(userId)) throw Object.assign(new Error("Choose a teammate."), { status: 400 });
  const team = await assignableTeam();
  const person = team.find((t) => t.id === String(userId));
  if (!person) throw Object.assign(new Error("That person can't see Communications."), { status: 400 });
  return { assignedTo: oid(person.id), assignedToName: person.name };
}

router.post("/conversations/:id/assign", ...canSend, async (req, res) => {
  try {
    const fields = await assigneeFields(req.body?.userId || null);
    const conv = await core.bump(req.params.id, fields);
    if (!conv) return res.status(404).json({ message: "Conversation not found." });
    res.json({ conversation: read.conversationDto(conv.toObject(), await read.usersById([conv.user])) });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Bulk inbox actions on explicit ids, or on "everything matching" a filter.
 * The caller states how many it expects to change; a mismatch (the list moved
 * under them) is refused instead of touching a different set.
 */
router.post("/conversations/bulk", ...canSend, async (req, res) => {
  try {
    const { action, ids, matching, expectedCount, userId } = req.body || {};
    const updates = { read: { unreadCount: 0 }, unread: { unreadCount: 1 }, archive: { archived: true, archivedAt: new Date() }, reopen: { archived: false, archivedAt: null }, done: { needsReply: false } };
    let set = updates[action];
    if (action === "assign") set = await assigneeFields(userId || null);
    if (!set) return res.status(400).json({ message: "Unknown action." });
    let filter;
    if (Array.isArray(ids)) {
      const clean = ids.filter(core.isObjectId).slice(0, 500);
      if (!clean.length) return res.status(400).json({ message: "Select at least one conversation." });
      filter = { _id: { $in: clean.map(oid) } };
    } else if (matching && typeof matching === "object") {
      filter = read.FILTERS.includes(matching.filter) ? buildMatchingFilter(matching, actorOf(req)._id) : null;
      if (!filter) return res.status(400).json({ message: "Unknown filter." });
    } else return res.status(400).json({ message: "Choose conversations." });
    const count = await CommConversation.countDocuments(filter);
    if (Number(expectedCount) !== count) return res.status(409).json({ code: "COUNT_CHANGED", message: `That selection is now ${count} conversations, not ${expectedCount}. Review it and try again.`, count });
    if (count > 2000) return res.status(400).json({ message: "Narrow the selection to 2,000 conversations or fewer." });
    const r = await CommConversation.updateMany(filter, { $set: { ...set, changedAt: new Date() }, $inc: { version: 1 } });
    log(req, "Conversations Updated", "comms", "", "", { action, count: r.modifiedCount });
    res.json({ updated: r.modifiedCount });
  } catch (error) {
    fail(res, error);
  }
});

function buildMatchingFilter(matching, actorId) {
  // Same rules as the list (utils/comms/read.js conversationQuery), re-stated through its export.
  const q = { archived: matching.filter === "archived" };
  if (matching.filter === "unread") q.unreadCount = { $gt: 0 };
  if (matching.filter === "needs_reply") q.needsReply = true;
  if (matching.filter === "mine") q.assignedTo = oid(actorId);
  if (matching.filter === "unassigned") q.assignedTo = null;
  if (matching.filter === "problems") q.deliveryProblem = true;
  if (matching.filter === "unmatched") q.linkState = { $in: ["unknown", "ambiguous"] };
  if (matching.filter !== "unmatched" && matching.filter !== "archived") q.$or = [{ importOnly: { $ne: true } }, { linkState: "linked" }];
  if (matching.line && toE164(matching.line)) q.lines = toE164(matching.line);
  if (matching.channel) q.channels = String(matching.channel);
  q.lastMessageAt = { $ne: null };
  return q;
}

/**
 * Link an unknown or ambiguous number to a customer, explicitly. History in
 * this thread is moved to that customer only when applyToHistory is true.
 */
router.post("/conversations/:id/link", ...canSend, async (req, res) => {
  try {
    const conv = await loadConversation(req, res);
    if (!conv) return;
    const userId = req.body?.userId;
    if (!core.isObjectId(userId)) return res.status(400).json({ message: "Choose a customer." });
    const user = await User.findOne({ _id: userId, role: { $ne: "employee" } }).select("_id name firstName lastName email").lean();
    if (!user) return res.status(404).json({ message: "Customer not found." });
    if (conv.linkState === "linked" && String(conv.user) !== String(user._id) && req.body?.replace !== true) {
      return res.status(409).json({ code: "ALREADY_LINKED", message: "This number is linked to a different customer. Confirm to relink it." });
    }
    const previous = conv.user ? String(conv.user) : null;
    await core.touch(conv, { user: user._id, linkState: "linked", candidateUsers: [], linkedBy: actorOf(req)._id, linkedAt: new Date(), displayName: core.displayNameOf(user) });
    let moved = 0;
    if (req.body?.applyToHistory !== false) {
      const r = await CommMessage.updateMany({ conversation: conv._id }, { $set: { user: user._id } });
      moved = r.modifiedCount;
    }
    await CommMessage.create({
      conversation: conv._id,
      user: user._id,
      channel: "system",
      direction: "internal",
      kind: "system",
      body: `${core.displayNameOf(actorOf(req))} linked this number to ${core.displayNameOf(user)}.`,
      status: "logged",
      origin: "manual",
      occurredAt: new Date(),
    });
    log(req, "Conversation Linked", "comms", conv._id, core.displayNameOf(user), { previous, movedMessages: moved });
    res.json({ conversation: read.conversationDto(conv.toObject(), await read.usersById([user._id])), moved });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/conversations/:id/unlink", ...canSend, async (req, res) => {
  try {
    const conv = await loadConversation(req, res);
    if (!conv) return;
    const previous = conv.user;
    await core.touch(conv, { user: null, linkState: "unknown", linkedBy: null, linkedAt: null });
    if (req.body?.applyToHistory === true && previous) await CommMessage.updateMany({ conversation: conv._id, user: previous }, { $set: { user: null } });
    log(req, "Conversation Unlinked", "comms", conv._id, "", { previous: previous ? String(previous) : null });
    res.json({ conversation: read.conversationDto(conv.toObject(), new Map()) });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/conversations/:id/notes", ...canSend, async (req, res) => {
  try {
    const { message, duplicate } = await send.addNote({ actor: actorOf(req), conversationId: req.params.id, body: req.body?.body, idempotencyKey: req.body?.idempotencyKey });
    res.status(duplicate ? 200 : 201).json({ message: read.messageDto(message), duplicate });
  } catch (error) {
    fail(res, error);
  }
});

/* ================================================================ sending */

/** Preflight for the composer: can this number be texted for this purpose, and from which lines? */
router.get("/eligibility", ...canRead, async (req, res) => {
  try {
    const purpose = req.query.purpose === "marketing" ? "marketing" : "service";
    let phone = toE164(req.query.phone);
    let user = null;
    if (core.isObjectId(req.query.conversationId)) {
      const conv = await CommConversation.findById(req.query.conversationId).lean();
      if (conv) {
        phone = conv.externalPhone;
        if (conv.user) user = await User.findById(conv.user);
      }
    } else if (core.isObjectId(req.query.userId)) {
      user = await User.findOne({ _id: req.query.userId, role: { $ne: "employee" } });
    }
    if (!phone) return res.json({ eligible: false, text: "Choose a number to text.", warnings: [] });
    const blocked = user ? Boolean(await findActiveBlockForUser(user).catch(() => null)) : false;
    const verdict = await checkCommsSend({ purpose, phone, user, mode: "manual", blocked });
    res.json({ ...verdict, sending: await send.sendingState("manual") });
  } catch (error) {
    fail(res, error);
  }
});

/** The numbers on record for a customer, and their existing conversations. */
router.get("/customers/:userId/contact", ...canRead, async (req, res) => {
  try {
    if (!core.isObjectId(req.params.userId)) return res.status(404).json({ message: "Customer not found." });
    const panel = await read.customerPanel(req.params.userId);
    if (!panel) return res.status(404).json({ message: "Customer not found." });
    const convs = await CommConversation.find({ user: req.params.userId }).select("_id externalPhone lineNumber lastMessageAt").lean();
    res.json({ customer: panel, conversations: convs.map((c) => ({ id: String(c._id), phone: c.externalPhone, lineNumber: c.lineNumber, lastMessageAt: c.lastMessageAt })) });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/send", ...canSend, async (req, res) => {
  try {
    const b = req.body || {};
    const { message, duplicate } = await send.sendText({
      actor: actorOf(req),
      conversationId: b.conversationId || null,
      userId: b.userId || null,
      toPhone: b.toPhone || "",
      lineNumber: b.lineNumber,
      body: b.body,
      mediaIds: b.mediaIds || [],
      purpose: b.purpose === "marketing" ? "marketing" : "service",
      idempotencyKey: b.idempotencyKey,
      quietHoursAck: b.quietHoursAck === true,
    });
    if (!duplicate) log(req, "Text Sent", "comms", message.conversation, "", { status: message.status, purpose: message.purpose, line: message.lineNumber });
    res.status(duplicate ? 200 : 201).json({ message: read.messageDto(message), conversationId: String(message.conversation), duplicate });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/messages/:id/retry", ...canSend, async (req, res) => {
  try {
    const { message, duplicate } = await send.retryText({ actor: actorOf(req), messageId: req.params.id, idempotencyKey: req.body?.idempotencyKey, quietHoursAck: req.body?.quietHoursAck === true });
    if (!duplicate) log(req, "Text Retried", "comms", message.conversation, "", { retryOf: req.params.id, status: message.status });
    res.status(duplicate ? 200 : 201).json({ message: read.messageDto(message), duplicate });
  } catch (error) {
    fail(res, error);
  }
});

/* ================================================================== media */

router.post("/media", ...canSend, upload.single("file"), async (req, res) => {
  try {
    const row = await media.storeUpload({ buffer: req.file?.buffer, contentType: req.file?.mimetype, name: req.file?.originalname, user: actorOf(req) });
    res.status(201).json({ id: String(row._id), name: row.name, size: row.size, contentType: row.contentType });
  } catch (error) {
    fail(res, error);
  }
});

/** A picture in a message: only through here, only with Read permission. */
router.get("/messages/:id/media/:index", ...canRead, async (req, res) => {
  try {
    if (!core.isObjectId(req.params.id)) return res.status(404).end();
    const m = await CommMessage.findById(req.params.id).select("media").lean();
    const item = m?.media?.[Number(req.params.index)];
    if (!item?.key) return res.status(404).json({ message: "This picture is kept in the original source." });
    const buffer = await media.readObject(item.key);
    res.set({ "Content-Type": item.contentType || "application/octet-stream", "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" });
    res.send(buffer);
  } catch (error) {
    fail(res, error);
  }
});

/* ============================================================== timeline */

router.get("/customers/:userId/timeline", ...canRead, async (req, res) => {
  try {
    if (!core.isObjectId(req.params.userId)) return res.status(404).json({ message: "Customer not found." });
    const out = await read.customerTimeline({ userId: req.params.userId, channel: req.query.channel, before: req.query.before, limit: req.query.limit });
    if (!out) return res.status(404).json({ message: "Customer not found." });
    res.json(out);
  } catch (error) {
    fail(res, error);
  }
});

/* ========================================================= saved replies */

router.post("/saved-replies", ...canSend, async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const body = String(req.body?.body || "").trim();
    if (!title || !body) return res.status(400).json({ message: "Give the saved reply a title and text." });
    const row = await CommSavedReply.create({ title: title.slice(0, 80), body: body.slice(0, 1000), purpose: req.body?.purpose === "marketing" ? "marketing" : "service", createdBy: actorOf(req)._id });
    res.status(201).json({ reply: { id: String(row._id), title: row.title, body: row.body, purpose: row.purpose } });
  } catch (error) {
    fail(res, error);
  }
});

router.delete("/saved-replies/:id", ...canSend, async (req, res) => {
  try {
    if (!core.isObjectId(req.params.id)) return res.status(404).end();
    await CommSavedReply.updateOne({ _id: req.params.id }, { $set: { archived: true } });
    res.json({ ok: true });
  } catch (error) {
    fail(res, error);
  }
});

/* ================================================================== bulk */

const bulkDto = (b, extra = {}) => ({
  id: String(b._id),
  number: b.number,
  name: b.name,
  purpose: b.purpose,
  lineNumber: b.lineNumber,
  body: b.body,
  audience: { type: b.audience?.type, segment: b.audience?.segment || "", label: b.audience?.label || "", count: (b.audience?.userIds || []).length },
  status: b.status,
  scheduledFor: b.scheduledFor,
  snapshotAt: b.snapshotAt,
  confirmedCount: b.confirmedCount,
  counts: b.counts,
  exclusions: Object.fromEntries(b.exclusions instanceof Map ? b.exclusions : Object.entries(b.exclusions || {})),
  createdByName: b.createdByName,
  approvedByName: b.approvedByName,
  confirmedAt: b.confirmedAt,
  approvedAt: b.approvedAt,
  canceledAt: b.canceledAt,
  startedAt: b.startedAt,
  completedAt: b.completedAt,
  createdAt: b.createdAt,
  version: b.version,
  ...extra,
});

router.get("/bulk", ...canBulk, async (req, res) => {
  try {
    const rows = await CommBulkSend.find({}).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ items: rows.map((b) => bulkDto(b)) });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/bulk", ...canBulk, async (req, res) => {
  try {
    const row = await bulk.createDraft({ actor: actorOf(req), ...req.body });
    log(req, "Bulk Text Drafted", "comms_bulk", row._id, row.number, { purpose: row.purpose, audience: row.audience?.label });
    res.status(201).json({ bulk: bulkDto(row) });
  } catch (error) {
    fail(res, error);
  }
});

router.get("/bulk/:id", ...canBulk, async (req, res) => {
  try {
    if (!core.isObjectId(req.params.id)) return res.status(404).json({ message: "Not found." });
    const row = await CommBulkSend.findById(req.params.id).lean();
    if (!row) return res.status(404).json({ message: "Not found." });
    res.json({ bulk: bulkDto(row, { recipientCounts: await bulk.recipientCounts(row._id) }) });
  } catch (error) {
    fail(res, error);
  }
});

router.put("/bulk/:id", ...canBulk, async (req, res) => {
  try {
    const row = await bulk.updateDraft({ id: req.params.id, patch: req.body || {} });
    res.json({ bulk: bulkDto(row) });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/bulk/:id/preview", ...canBulk, async (req, res) => {
  try {
    const out = await bulk.preview({ id: req.params.id });
    res.json({ bulk: bulkDto(out.bulk), samples: out.samples, maxSegments: out.maxSegments, exclusions: out.exclusions });
  } catch (error) {
    fail(res, error);
  }
});

router.get("/bulk/:id/recipients", ...canBulk, async (req, res) => {
  try {
    if (!core.isObjectId(req.params.id)) return res.status(404).json({ message: "Not found." });
    const q = { bulk: oid(req.params.id) };
    if (req.query.status) q.status = String(req.query.status);
    if (req.query.after && core.isObjectId(req.query.after)) q._id = { $gt: oid(req.query.after) };
    const rows = await CommBulkRecipient.find(q).sort({ _id: 1 }).limit(101).lean();
    const page = rows.slice(0, 100);
    res.json({
      items: page.map((r) => ({ id: String(r._id), customerId: r.user ? String(r.user) : null, name: r.name, phone: r.phone, status: r.status, reason: r.reason ? (bulk.exclusionText(r.reason) !== r.reason ? bulk.exclusionText(r.reason) : r.reason) : "", body: r.body, retryOf: r.retryOf ? String(r.retryOf) : null, messageId: r.message ? String(r.message) : null, processedAt: r.processedAt })),
      next: rows.length > 100 ? String(page[page.length - 1]._id) : null,
    });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/bulk/:id/confirm", ...canBulk, async (req, res) => {
  try {
    const row = await bulk.confirm({ id: req.params.id, actor: actorOf(req), isOwner: isOwner(req), expectedEligible: req.body?.expectedEligible, scheduledFor: req.body?.scheduledFor || null, confirmKey: req.body?.confirmKey });
    log(req, "Bulk Text Confirmed", "comms_bulk", row._id, row.number, { recipients: row.confirmedCount, status: row.status, scheduledFor: row.scheduledFor, line: row.lineNumber, purpose: row.purpose });
    res.json({ bulk: bulkDto(row) });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/bulk/:id/approve", ...ownerOnly, async (req, res) => {
  try {
    const row = await bulk.approve({ id: req.params.id, actor: actorOf(req) });
    log(req, "Bulk Text Approved", "comms_bulk", row._id, row.number, { recipients: row.confirmedCount });
    res.json({ bulk: bulkDto(row) });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/bulk/:id/cancel", ...canBulk, async (req, res) => {
  try {
    const out = await bulk.cancel({ id: req.params.id, actor: actorOf(req) });
    log(req, "Bulk Text Canceled", "comms_bulk", out.bulk._id, out.bulk.number, { canceledRecipients: out.canceled });
    res.json({ bulk: bulkDto(out.bulk), canceled: out.canceled });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/bulk/:id/retry-failed", ...canBulk, async (req, res) => {
  try {
    const out = await bulk.retryFailed({ id: req.params.id });
    log(req, "Bulk Text Failures Retried", "comms_bulk", req.params.id, "", out);
    res.json(out);
  } catch (error) {
    fail(res, error);
  }
});

/* ============================================================= settings */

router.get("/settings", ...ownerOnly, async (req, res) => {
  try {
    const s = await core.getSettings({ fresh: true });
    const runs = await CommImportRun.find({}).lean();
    res.json({
      settings: { manualSendingEnabled: s.manualSendingEnabled, bulkSendingEnabled: s.bulkSendingEnabled, inboundAutoReply: s.inboundAutoReply, ghlSyncEnabled: s.ghlSyncEnabled, sendersRefreshedAt: s.sendersRefreshedAt, registration: s.registration || {}, version: s.version },
      lines: await core.senders(),
      sending: { manual: await send.sendingState("manual"), bulk: await send.sendingState("bulk") },
      imports: imports.SOURCES.map((source) => {
        const r = runs.find((x) => x.source === source) || { source, status: "idle", counts: {} };
        return { source, status: r.status, counts: r.counts || {}, earliestAt: r.earliestAt || null, latestAt: r.latestAt || null, startedAt: r.startedAt || null, finishedAt: r.finishedAt || null, lastError: r.lastError || "", heartbeatAt: r.heartbeatAt || null };
      }),
      ghlConfigured: require("../utils/ghl/client").ghl.config().configured,
      health: await healthSummary(),
    });
  } catch (error) {
    fail(res, error);
  }
});

router.put("/settings", ...ownerOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const set = {};
    for (const k of ["manualSendingEnabled", "bulkSendingEnabled", "ghlSyncEnabled"]) if (typeof b[k] === "boolean") set[k] = b[k];
    if (b.inboundAutoReply === "on" || b.inboundAutoReply === "off") set.inboundAutoReply = b.inboundAutoReply;
    if (!Object.keys(set).length) return res.status(400).json({ message: "Nothing to change." });
    const filter = { _id: "comms" };
    if (Number.isInteger(b.version)) filter.version = b.version;
    const s = await CommSettings.findOneAndUpdate(filter, { $set: { ...set, updatedBy: actorOf(req)._id }, $inc: { version: 1 } }, { new: true, upsert: !Number.isInteger(b.version) });
    if (!s) return res.status(409).json({ code: "CHANGED", message: "Settings changed in another window. Reload them first." });
    core.clearSettingsCache();
    log(req, "Communications Settings Changed", "comms_settings", "comms", "Communications", set);
    res.json({ ok: true, version: s.version });
  } catch (error) {
    fail(res, error);
  }
});

/** Read-only: refresh the Profixter lines and A2P registration status from Twilio. */
router.post("/settings/refresh-senders", ...ownerOnly, async (req, res) => {
  try {
    const provider = require("../utils/sms/twilioProvider");
    const { twilioCredentials } = require("../utils/sms/smsConfig");
    const ms = twilioCredentials().messagingServiceSid;
    if (!ms) return res.status(409).json({ message: "No Messaging Service is configured on the server." });
    const nums = await provider.twilioGet(`/IncomingPhoneNumbers.json?PageSize=100`);
    const pool = await provider.twilioGet(`https://messaging.twilio.com/v1/Services/${ms}/PhoneNumbers?PageSize=50`);
    const inPool = new Set((pool.phone_numbers || []).map((p) => p.phone_number));
    const senders = (nums.incoming_phone_numbers || [])
      .filter((n) => inPool.has(n.phone_number) && n.capabilities?.sms)
      .map((n) => ({ number: n.phone_number, label: n.friendly_name || "", messagingServiceSid: ms, sms: true, mms: Boolean(n.capabilities?.mms) }));
    let registration = { checkedAt: new Date(), campaignStatus: "", usecase: "", error: "" };
    try {
      const a2p = await provider.twilioGet(`https://messaging.twilio.com/v1/Services/${ms}/Compliance/Usa2p?PageSize=20`);
      const c = (a2p.compliance || [])[0];
      registration = { checkedAt: new Date(), campaignStatus: c?.campaign_status || "none", usecase: c?.us_app_to_person_usecase || "", error: "" };
    } catch (e) {
      registration.error = String(e.message || "").slice(0, 200);
    }
    await CommSettings.updateOne({ _id: "comms" }, { $set: { senders, sendersRefreshedAt: new Date(), registration }, $inc: { version: 1 } }, { upsert: true });
    core.clearSettingsCache();
    log(req, "Texting Lines Refreshed", "comms_settings", "comms", "Communications", { lines: senders.length, campaign: registration.campaignStatus });
    res.json({ lines: senders, registration });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/imports/:source/:action(start|pause|reset)", ...ownerOnly, async (req, res) => {
  try {
    const { source, action } = req.params;
    if (!imports.SOURCES.includes(source)) return res.status(404).json({ message: "Unknown import." });
    const run = await imports[action]({ source, actor: actorOf(req) });
    log(req, `History Import ${action[0].toUpperCase()}${action.slice(1)}`, "comms_import", source, source, {});
    res.json({ run });
  } catch (error) {
    fail(res, error);
  }
});

async function healthSummary() {
  const since = new Date(Date.now() - 24 * 3600e3);
  const events = await CommHealthEvent.aggregate([{ $match: { at: { $gte: since } } }, { $group: { _id: "$type", n: { $sum: 1 }, last: { $max: "$at" } } }]);
  const [unknownSends, stuckBulk, lastInbound, failedToday] = await Promise.all([
    CommMessage.countDocuments({ status: "unknown" }),
    CommBulkSend.countDocuments({ status: "sending", updatedAt: { $lt: new Date(Date.now() - 15 * 60 * 1000) } }),
    CommMessage.findOne({ direction: "inbound", origin: "twilio_webhook" }).sort({ occurredAt: -1 }).select("occurredAt").lean(),
    CommMessage.countDocuments({ status: { $in: ["failed", "undelivered"] }, occurredAt: { $gte: since }, direction: "outbound" }),
  ]);
  const staleImports = await CommImportRun.countDocuments({ status: "running", heartbeatAt: { $lt: new Date(Date.now() - 20 * 60 * 1000) } });
  return { events: events.map((e) => ({ type: e._id, count: e.n, last: e.last })), unknownSends, stuckBulk, staleImports, failedToday, lastInboundAt: lastInbound?.occurredAt || null };
}

module.exports = router;
module.exports.healthSummary = healthSummary;
