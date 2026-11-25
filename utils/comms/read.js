const mongoose = require("mongoose");
const User = require("../../models/User");
const Booking = require("../../models/Booking");
const Subscription = require("../../models/Subscription");
const EmailLog = require("../../models/EmailLog");
const CommConversation = require("../../models/CommConversation");
const CommMessage = require("../../models/CommMessage");
const { optOutFor } = require("../sms/smsEligibility");
const { marketingSmsBasis } = require("../consent/marketingSmsBasis");
const { toE164 } = require("../sms/smsPhone");
const core = require("./core");

/**
 * What Admin reads: conversation rows, thread pages, the customer panel, the
 * unified timeline and search. Every list is indexed and paginated by cursor.
 */

/* ================================================================ DTOs */

function conversationDto(c, users = new Map()) {
  const u = c.user ? users.get(String(c.user)) : null;
  return {
    id: String(c._id),
    name: u ? core.displayNameOf(u) : c.displayName || c.externalPhone || c.externalEmail || "Unknown",
    phone: c.externalPhone || "",
    email: c.externalEmail || "",
    customerId: c.user ? String(c.user) : null,
    linkState: c.linkState,
    candidateCount: (c.candidateUsers || []).length,
    lineNumber: c.lineNumber || "",
    lastMessageAt: c.lastMessageAt,
    lastPreview: c.lastPreview || "",
    lastDirection: c.lastDirection || "",
    lastKind: c.lastKind || "",
    lastChannel: c.lastChannel || "",
    unreadCount: c.unreadCount || 0,
    needsReply: Boolean(c.needsReply),
    archived: Boolean(c.archived),
    assignedTo: c.assignedTo ? String(c.assignedTo) : null,
    assignedToName: c.assignedToName || "",
    deliveryProblem: Boolean(c.deliveryProblem),
    channels: c.channels || [],
    importOnly: Boolean(c.importOnly),
    version: c.version || 0,
  };
}

function messageDto(m) {
  return {
    id: String(m._id),
    conversationId: m.conversation ? String(m.conversation) : null,
    channel: m.channel,
    channelLabel: m.channelLabel || "",
    direction: m.direction,
    kind: m.kind,
    body: m.body || "",
    subject: m.subject || "",
    media: (m.media || []).map((x, i) => ({ index: i, name: x.name || `Picture ${i + 1}`, contentType: x.contentType || "", available: Boolean(x.key), external: Boolean(x.external) })),
    metadataOnly: Boolean(m.metadataOnly),
    from: m.fromAddress || "",
    to: m.toAddress || "",
    lineNumber: m.lineNumber || "",
    authorName: m.authorName || "",
    automationType: m.automationType || "",
    purpose: m.purpose || "",
    status: m.status,
    errorCode: m.errorCode || "",
    errorMessage: m.errorMessage || "",
    segments: m.segments || 0,
    source: m.provider === "ghl" ? "GoHighLevel" : m.origin === "twilio_import" ? "Twilio history" : m.provider === "twilio" ? "Twilio" : "Profixter",
    call: m.channel === "call" ? { durationSec: m.call?.durationSec || 0, status: m.call?.status || "", hasRecording: Boolean(m.call?.hasRecording) } : null,
    retryable: m.channel === "sms" && m.direction === "outbound" && ["manual", "bulk"].includes(m.kind) && ["failed", "undelivered"].includes(m.status) && !(m.media || []).length,
    occurredAt: m.occurredAt,
  };
}

async function usersById(ids) {
  const list = [...new Set(ids.filter(Boolean).map(String))];
  if (!list.length) return new Map();
  const rows = await User.find({ _id: { $in: list } }).select("_id name firstName lastName email phone").lean();
  return new Map(rows.map((u) => [String(u._id), u]));
}

/* ======================================================= conversations */

const FILTERS = ["all", "unread", "needs_reply", "mine", "unassigned", "archived", "problems", "unmatched"];

function conversationQuery({ filter = "all", line = "", channel = "", actorId }) {
  const q = {};
  if (filter === "archived") q.archived = true;
  else q.archived = false;
  if (filter === "unread") q.unreadCount = { $gt: 0 };
  if (filter === "needs_reply") q.needsReply = true;
  if (filter === "mine") q.assignedTo = new mongoose.Types.ObjectId(String(actorId));
  if (filter === "unassigned") q.assignedTo = null;
  if (filter === "problems") q.deliveryProblem = true;
  if (filter === "unmatched") q.linkState = { $in: ["unknown", "ambiguous"] };
  // History-only contacts that nobody has linked stay out of the everyday inbox (Unmatched shows them).
  if (filter !== "unmatched" && filter !== "archived") q.$or = [{ importOnly: { $ne: true } }, { linkState: "linked" }];
  if (line && core.lineNumber(line)) q.lines = core.lineNumber(line);
  if (channel) q.channels = channel;
  q.lastMessageAt = { $ne: null };
  return q;
}

/** cursor = "<ISO lastMessageAt>|<id>" */
function decodeCursor(cursor) {
  const [at, id] = String(cursor || "").split("|");
  const d = new Date(at);
  return at && id && core.isObjectId(id) && !Number.isNaN(d.getTime()) ? { at: d, id: new mongoose.Types.ObjectId(id) } : null;
}

async function listConversations({ filter = "all", line = "", channel = "", cursor = "", limit = 30, actorId }) {
  if (!FILTERS.includes(filter)) filter = "all";
  const q = conversationQuery({ filter, line, channel, actorId });
  const c = decodeCursor(cursor);
  if (c) q.$and = [{ $or: [{ lastMessageAt: { $lt: c.at } }, { lastMessageAt: c.at, _id: { $lt: c.id } }] }];
  const n = Math.min(Math.max(Number(limit) || 30, 1), 60);
  const [rows, total] = await Promise.all([
    CommConversation.find(q).sort({ lastMessageAt: -1, _id: -1 }).limit(n + 1).lean(),
    // The first page also says how many match, so "select all matching" can show (and confirm) the exact number.
    c ? Promise.resolve(null) : CommConversation.countDocuments(conversationQuery({ filter, line, channel, actorId })),
  ]);
  const page = rows.slice(0, n);
  const users = await usersById(page.map((r) => r.user));
  const last = page[page.length - 1];
  return {
    ...(total === null ? {} : { total }),
    items: page.map((r) => conversationDto(r, users)),
    nextCursor: rows.length > n && last ? `${new Date(last.lastMessageAt).toISOString()}|${last._id}` : null,
  };
}

async function inboxCounts(actorId) {
  const base = { archived: false, lastMessageAt: { $ne: null }, $or: [{ importOnly: { $ne: true } }, { linkState: "linked" }] };
  const [unread, needsReply, mine, problems, unmatched] = await Promise.all([
    CommConversation.countDocuments({ ...base, unreadCount: { $gt: 0 } }),
    CommConversation.countDocuments({ ...base, needsReply: true }),
    CommConversation.countDocuments({ ...base, assignedTo: new mongoose.Types.ObjectId(String(actorId)) }),
    CommConversation.countDocuments({ ...base, deliveryProblem: true }),
    CommConversation.countDocuments({ archived: false, lastMessageAt: { $ne: null }, linkState: { $in: ["unknown", "ambiguous"] } }),
  ]);
  return { unread, needsReply, mine, problems, unmatched };
}

/** Conversations changed since a moment (5s overlap absorbs clock skew between servers). */
async function changesSince({ since, actorId, limit = 100 }) {
  const d = new Date(since);
  const from = Number.isNaN(d.getTime()) ? new Date(Date.now() - 60000) : new Date(d.getTime() - 5000);
  const rows = await CommConversation.find({ changedAt: { $gt: from } }).sort({ changedAt: 1 }).limit(limit).lean();
  const users = await usersById(rows.map((r) => r.user));
  const latest = rows.length ? rows[rows.length - 1].changedAt : d && !Number.isNaN(d.getTime()) ? d : new Date();
  return { items: rows.map((r) => conversationDto(r, users)), token: new Date(latest).toISOString(), counts: await inboxCounts(actorId), serverTime: new Date().toISOString() };
}

/* =============================================================== threads */

/** A page of a thread, newest first. `before`/`after` are message ids. */
async function threadPage({ conversationId, before = "", after = "", limit = 40 }) {
  const n = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const q = { conversation: new mongoose.Types.ObjectId(String(conversationId)) };
  if (before && core.isObjectId(before)) {
    const ref = await CommMessage.findById(before).select("occurredAt").lean();
    if (ref) q.$or = [{ occurredAt: { $lt: ref.occurredAt } }, { occurredAt: ref.occurredAt, _id: { $lt: ref._id } }];
  } else if (after && core.isObjectId(after)) {
    const ref = await CommMessage.findById(after).select("occurredAt").lean();
    if (ref) q.$or = [{ occurredAt: { $gt: ref.occurredAt } }, { occurredAt: ref.occurredAt, _id: { $gt: ref._id } }];
  }
  const rows = await CommMessage.find(q).sort({ occurredAt: -1, _id: -1 }).limit(n + 1).lean();
  return { items: rows.slice(0, n).map(messageDto), hasMore: rows.length > n };
}

/** Messages updated since a moment in one thread (status changes, new arrivals). */
async function threadChanges({ conversationId, since }) {
  const d = new Date(since);
  const from = Number.isNaN(d.getTime()) ? new Date(Date.now() - 60000) : new Date(d.getTime() - 5000);
  const rows = await CommMessage.find({ conversation: conversationId, updatedAt: { $gt: from } }).sort({ updatedAt: 1 }).limit(200).lean();
  return { items: rows.map(messageDto), token: rows.length ? rows[rows.length - 1].updatedAt.toISOString() : Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString() };
}

/* ======================================================== customer panel */

async function customerPanel(userId) {
  const user = await User.findById(userId).select("_id name firstName lastName email phone userId smsPreferences excludeFromMarketing createdAt role").lean();
  if (!user || user.role === "employee") return null;
  const phones = await core.phonesForUser(user);
  const optOuts = await Promise.all(phones.map((p) => optOutFor(p.phone)));
  const subs = await Subscription.find({ user: user._id }).select("subscriptionType status billingCycle currentPeriodEnd cancelAtPeriodEnd addressSnapshot").sort({ createdAt: -1 }).limit(6).lean();
  const bookings = await Booking.find({ $or: [{ user: user._id }, ...(user.userId ? [{ userId: user.userId }] : [])] })
    .select("bookingNumber date status service bookingType visitType address scheduledStart")
    .sort({ date: -1 })
    .limit(6)
    .lean();
  const prefs = user.smsPreferences || {};
  const basis = marketingSmsBasis(user);
  return {
    id: String(user._id),
    name: core.displayNameOf(user),
    email: user.email || "",
    customerNumber: user.userId || "",
    phones: phones.map((p, i) => ({ ...p, optedOut: Boolean(optOuts[i]) })),
    consent: {
      serviceTexts: prefs.transactionalEnabled === true ? "on" : prefs.transactionalEnabled === false ? "off" : "not_given",
      serviceSince: prefs.transactionalConsentAt || null,
      serviceSource: prefs.transactionalConsentSource || "",
      marketingTexts: prefs.marketingEnabled === true ? (basis.status === "qualifies" ? "on" : "unconfirmed") : prefs.marketingEnabled === false ? "off" : "not_given",
      marketingBasis: basis.status,
      optedOut: optOuts.some(Boolean),
      optedOutAt: prefs.optedOutAt || null,
    },
    memberships: subs.map((s) => ({ plan: s.subscriptionType || "", status: s.status || "", cycle: s.billingCycle || "", renews: s.cancelAtPeriodEnd ? null : s.currentPeriodEnd, endsAt: s.cancelAtPeriodEnd ? s.currentPeriodEnd : null, address: s.addressSnapshot?.line1 || "" })),
    bookings: bookings.map((b) => ({ number: b.bookingNumber, date: b.scheduledStart || b.date, status: b.status, service: b.service || "", type: b.visitType || b.bookingType || "" })),
    customerSince: user.createdAt,
  };
}

/* ============================================================== timeline */

const TIMELINE_CHANNELS = ["all", "sms", "call", "email", "chat", "note", "booking"];

/**
 * One customer's history across sources, newest first: Communications
 * entries (texts, calls, notes, imported chats and emails), the emails
 * Profixter sent (EmailLog), and booking milestones. Cursor = ISO time.
 */
async function customerTimeline({ userId, channel = "all", before = "", limit = 30 }) {
  const user = await User.findById(userId).select("_id email userId").lean();
  if (!user) return null;
  if (!TIMELINE_CHANNELS.includes(channel)) channel = "all";
  const n = Math.min(Math.max(Number(limit) || 30, 1), 60);
  const b = before ? new Date(before) : null;
  const beforeQ = b && !Number.isNaN(b.getTime()) ? { $lt: b } : null;
  const tasks = [];

  if (channel !== "booking") {
    const q = { user: user._id };
    if (channel !== "all" && channel !== "email") q.channel = channel;
    if (channel === "email") q.channel = "email";
    if (beforeQ) q.occurredAt = beforeQ;
    tasks.push(
      CommMessage.find(q).sort({ occurredAt: -1 }).limit(n + 1).lean().then((rows) => rows.map((m) => ({ ...messageDto(m), entry: "message" })))
    );
  }
  if (channel === "all" || channel === "email") {
    const or = [{ userId: user._id }, { userId: String(user._id) }];
    if (user.email) or.push({ customerEmail: user.email }, { recipientEmail: user.email });
    const q = { $or: or };
    if (beforeQ) q.createdAt = beforeQ;
    tasks.push(
      EmailLog.find(q)
        .select("subject templateKey status createdAt sentAt text recipientEmail source emailType errorMessage")
        .sort({ createdAt: -1 })
        .limit(n + 1)
        .lean()
        .then((rows) =>
          rows.map((e) => ({
            id: `email:${e._id}`,
            entry: "email_log",
            channel: "email",
            direction: "outbound",
            kind: e.source === "campaign" || e.emailType === "marketing" ? "bulk" : "automation",
            subject: e.subject || "",
            body: String(e.text || "").slice(0, 600),
            status: e.status || "",
            errorMessage: e.errorMessage || "",
            authorName: e.templateKey ? `Email: ${e.templateKey}` : "Email",
            source: "Profixter email",
            to: e.recipientEmail || "",
            occurredAt: e.sentAt || e.createdAt,
          }))
        )
    );
  }
  if (channel === "all" || channel === "booking") {
    const q = { $or: [{ user: user._id }, ...(user.userId ? [{ userId: user.userId }] : [])] };
    if (beforeQ) q.createdAt = beforeQ;
    tasks.push(
      Booking.find(q)
        .select("bookingNumber date status service createdAt completedAt")
        .sort({ createdAt: -1 })
        .limit(n + 1)
        .lean()
        .then((rows) =>
          rows.map((bk) => ({
            id: `booking:${bk._id}`,
            entry: "booking",
            channel: "booking",
            direction: "internal",
            kind: "system",
            body: `Booking ${bk.bookingNumber} created for ${new Date(bk.date).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" })} (${bk.service || "visit"}). Status now: ${bk.status || "Pending"}.`,
            status: bk.status || "",
            source: "Profixter bookings",
            bookingNumber: bk.bookingNumber,
            occurredAt: bk.createdAt,
          }))
        )
    );
  }
  const all = (await Promise.all(tasks)).flat().filter((x) => x.occurredAt);
  all.sort((x, y) => new Date(y.occurredAt) - new Date(x.occurredAt));
  const page = all.slice(0, n);
  const last = page[page.length - 1];
  const sources = await historyRange(user._id);
  return { items: page, nextCursor: all.length > n && last ? new Date(last.occurredAt).toISOString() : null, sources };
}

/** Per source: how far back this customer's history goes. */
async function historyRange(userId) {
  const rows = await CommMessage.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(String(userId)) } },
    { $group: { _id: { origin: "$origin", provider: "$provider" }, first: { $min: "$occurredAt" }, count: { $sum: 1 } } },
  ]);
  const label = (o, p) => (p === "ghl" ? "GoHighLevel" : o === "twilio_import" ? "Twilio history" : o === "sms_mirror" ? "Profixter automated texts" : o === "manual" || o === "bulk" ? "Sent from Communications" : "Profixter (live)");
  const merged = {};
  for (const r of rows) {
    const k = label(r._id.origin, r._id.provider);
    if (!merged[k] || r.first < merged[k].first) merged[k] = { source: k, first: r.first, count: (merged[k]?.count || 0) + r.count };
    else merged[k].count += r.count;
  }
  return Object.values(merged);
}

/* ================================================================ search */

/**
 * One search box: customers (whether or not they were ever texted) and
 * message history. Phone numbers are matched however they are typed.
 */
async function search({ q, limit = 8 }) {
  const query = String(q || "").trim().slice(0, 120);
  if (query.length < 2) return { customers: [], messages: [], contacts: [] };
  const { searchCustomers } = require("../admin/customerDirectory");
  const found = await searchCustomers({ q: query, filter: "all", limit, includeArchived: false }).catch(() => ({ items: [] }));
  const items = found.items || [];
  const ids = items.map((c) => c.id || c._id).filter(Boolean);
  const convs = ids.length ? await CommConversation.find({ user: { $in: ids } }).select("_id user lastMessageAt").sort({ lastMessageAt: -1 }).lean() : [];
  const convFor = new Map();
  for (const c of convs) if (!convFor.has(String(c.user))) convFor.set(String(c.user), String(c._id));
  const customers = items.map((c) => ({
    id: String(c.id || c._id),
    name: c.name || "",
    email: c.email || "",
    phone: c.phone || "",
    town: c.town || "",
    plan: (c.addresses || []).map((a) => a.plan).find(Boolean) || null,
    blocked: Boolean(c.blocked),
    conversationId: convFor.get(String(c.id || c._id)) || null,
  }));

  // Contacts not in the customer list (unknown numbers, GHL contacts).
  const digits = query.replace(/\D/g, "");
  const contactQ = digits.length >= 4 && /^[\d\s()+.\-]+$/.test(query) ? { externalPhone: new RegExp(digits.slice(-10)) } : { displayName: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") };
  const contactRows = await CommConversation.find({ ...contactQ, user: null }).select("_id displayName externalPhone externalEmail linkState").limit(limit).lean();
  const contacts = contactRows.map((c) => ({ conversationId: String(c._id), name: c.displayName || c.externalPhone || c.externalEmail, phone: c.externalPhone || "", linkState: c.linkState }));

  let messages = [];
  if (query.length >= 3) {
    const rows = await CommMessage.find({ $text: { $search: query }, channel: { $in: ["sms", "note", "email", "chat", "call"] } }, { score: { $meta: "textScore" } })
      .sort({ score: { $meta: "textScore" }, occurredAt: -1 })
      .limit(limit)
      .lean()
      .catch(() => []);
    const convIds = rows.map((r) => r.conversation).filter(Boolean);
    const convRows = convIds.length ? await CommConversation.find({ _id: { $in: convIds } }).select("_id user displayName externalPhone").lean() : [];
    const users = await usersById(convRows.map((c) => c.user));
    const byId = new Map(convRows.map((c) => [String(c._id), c]));
    messages = rows.map((m) => {
      const c = byId.get(String(m.conversation));
      const u = c?.user ? users.get(String(c.user)) : null;
      const body = String(m.body || m.subject || "");
      const at = body.toLowerCase().indexOf(query.toLowerCase().split(/\s+/)[0]);
      const start = Math.max(0, at - 40);
      return {
        messageId: String(m._id),
        conversationId: m.conversation ? String(m.conversation) : null,
        name: u ? core.displayNameOf(u) : c?.displayName || c?.externalPhone || "",
        channel: m.channel,
        snippet: `${start > 0 ? "…" : ""}${body.slice(start, start + 140)}`,
        occurredAt: m.occurredAt,
      };
    });
  }
  return { customers, messages, contacts };
}

module.exports = { FILTERS, changesSince, conversationDto, customerPanel, customerTimeline, inboxCounts, listConversations, messageDto, search, threadChanges, threadPage, usersById };
