const User = require("../../models/User");
const { CommBulkSend, CommBulkRecipient } = require("../../models/Comms");
const CommMessage = require("../../models/CommMessage");
const { toE164 } = require("../sms/smsPhone");
const { estimateSegments } = require("../sms/smsPhone");
const { blockedUserIdSet } = require("../customerBlock");
const directory = require("../admin/customerDirectory");
const core = require("./core");
const { checkCommsSend, bulkWindowOpen, textFor } = require("./eligibility");
const send = require("./send");

/**
 * Bulk SMS: compose, preview the exact audience, confirm, (approve), send in
 * the background, inspect every recipient.
 *
 * NEVER LARGER THAN CONFIRMED. The audience is resolved and frozen into
 * CommBulkRecipient rows at PREVIEW. Confirm must quote the eligible count the
 * person saw (and the preview must be under 30 minutes old). The worker sends
 * only to those rows, re-checking each person's eligibility immediately
 * before their text (an opt-out after scheduling is honoured), so a bulk send
 * can shrink after confirmation but can never grow.
 *
 * DURABLE AND RESUMABLE. Recipients are claimed one at a time with a lock;
 * each send's idempotency key is derived from the recipient row, so a worker
 * that dies mid-send and is picked up again lands on the text already sent.
 */
const crypto = require("crypto");
const MAX_AUDIENCE = 5000;
const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
const RECIPIENT_LOCK_MS = 2 * 60 * 1000;
const BULK_LOCK_MS = 60 * 1000;

class BulkError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

/* ================================================================ audiences */

const SEGMENTS = [
  { key: "all", label: "All customers with a phone number" },
  { key: "members", label: "Members (active, trialing, payment issue or ending)" },
  { key: "non_members", label: "Customers without a membership" },
  { key: "payment_issue", label: "Members with a payment issue" },
  { key: "ending", label: "Members whose membership is ending" },
  ...directory.PLANS.map((p) => ({ key: `plan:${p}`, label: `${p[0].toUpperCase()}${p.slice(1)} members` })),
];

async function audienceUsers(audience) {
  const select = "_id name firstName lastName email phone userId role isActive smsPreferences excludeFromMarketing";
  if (audience.type === "selected") {
    const ids = (audience.userIds || []).filter(core.isObjectId).slice(0, MAX_AUDIENCE + 1);
    return User.find({ _id: { $in: ids }, role: { $ne: "employee" } }).select(select).lean();
  }
  const key = String(audience.segment || "");
  if (!SEGMENTS.some((s) => s.key === key)) throw new BulkError(400, "BAD_SEGMENT", "Choose a customer group.");
  const ctx = {};
  const base = directory.customerBaseQuery({});
  let clauses = [];
  if (key === "members" || key === "payment_issue" || key === "ending") clauses = await directory.filterClauses(key, "", ctx);
  else if (key.startsWith("plan:")) clauses = await directory.filterClauses("members", key.slice(5), ctx);
  else if (key === "non_members") {
    const members = await directory.filterClauses("members", "", ctx);
    clauses = [{ $nor: members }];
  }
  return User.find({ $and: [base, ...clauses] }).select(select).limit(MAX_AUDIENCE + 1).lean();
}

/** {firstName} {name}: the only fields, resolved per recipient, with a safe fallback. */
function personalize(template, user) {
  const first = String(user.firstName || String(user.name || "").split(" ")[0] || "there").trim() || "there";
  return String(template).replace(/\{\s*firstName\s*\}/g, first).replace(/\{\s*name\s*\}/g, String(user.name || first).trim());
}

/* ======================================================= exact-audience lock */

/**
 * The fingerprint of exactly what a person previewed and approved.
 *
 * Not a count: the line, the purpose, the message, and each recipient's
 * customer id, phone number and personalised text, in a fixed order. Two
 * audiences of the same size (Alice + Bob vs Alice + Carol) or the same people
 * with a different message produce different fingerprints. Only the confirmed
 * audience's rows count (round 0, not excluded); their identity never changes
 * after preview, so the fingerprint stays valid while statuses move.
 */
function snapshotDigest(bulk, rows) {
  const recipients = rows
    .filter((r) => r.status !== "excluded" && !(r.round > 0))
    .map((r) => [String(r.user || ""), String(r.phone || ""), String(r.body || "")])
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const material = JSON.stringify({ line: bulk.lineNumber, purpose: bulk.purpose, body: bulk.body, recipients });
  return crypto.createHash("sha256").update(material).digest("hex");
}

async function currentDigest(bulk) {
  const rows = await CommBulkRecipient.find({ bulk: bulk._id }).select("user phone body status round").lean();
  return snapshotDigest(bulk, rows);
}

function assertSameSnapshot(bulk, expectedHash, current) {
  if (!expectedHash || expectedHash !== bulk.snapshotHash) {
    throw new BulkError(409, "SNAPSHOT_CHANGED", "This isn't the audience and message you reviewed (it was previewed again since). Review the current preview before confirming.");
  }
  if (current !== bulk.snapshotHash) {
    throw new BulkError(409, "SNAPSHOT_CHANGED", "The recipients or message changed after the preview. Preview again before confirming.");
  }
}

/* ============================================================== lifecycle */

async function nextNumber() {
  const n = (await CommBulkSend.countDocuments()) + 1;
  return `BS-${String(n).padStart(4, "0")}`;
}

function validateDraft({ purpose, lineNumber, body, audience }) {
  if (!["service", "marketing"].includes(purpose)) throw new BulkError(400, "PURPOSE", "Choose whether this is a service message or a promotion.");
  if (!core.lineNumber(lineNumber)) throw new BulkError(400, "LINE", "Choose a Profixter number to send from.");
  const text = String(body || "").trim();
  if (!text) throw new BulkError(400, "EMPTY", "Write the message.");
  if (text.length > 1000) throw new BulkError(400, "TOO_LONG", "Keep bulk messages under 1,000 characters.");
  if (!audience || !["selected", "segment"].includes(audience.type)) throw new BulkError(400, "AUDIENCE", "Choose who gets this message.");
  if (audience.type === "selected" && !(audience.userIds || []).length) throw new BulkError(400, "AUDIENCE", "Select at least one customer.");
  if (audience.type === "selected" && audience.userIds.length > MAX_AUDIENCE) throw new BulkError(400, "AUDIENCE", `At most ${MAX_AUDIENCE} customers per bulk send.`);
}

async function createDraft({ actor, name, purpose, lineNumber, body, audience, savedReply = null }) {
  validateDraft({ purpose, lineNumber, body, audience });
  if (!(await core.senderFor(lineNumber))) throw new BulkError(400, "LINE", "That isn't one of Profixter's texting numbers.");
  const label = audience.type === "segment" ? SEGMENTS.find((s) => s.key === audience.segment)?.label || "" : `${audience.userIds.length} selected customers`;
  for (let i = 0; i < 5; i++) {
    try {
      return await CommBulkSend.create({
        number: await nextNumber(),
        name: String(name || "").slice(0, 120),
        purpose,
        lineNumber: core.lineNumber(lineNumber),
        body: String(body).trim(),
        savedReply: core.isObjectId(savedReply) ? savedReply : null,
        audience: { type: audience.type, userIds: audience.type === "selected" ? audience.userIds.filter(core.isObjectId) : [], segment: audience.segment || "", label },
        status: "draft",
        createdBy: actor._id,
        createdByName: core.displayNameOf(actor),
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new BulkError(500, "NUMBER", "Couldn't number the bulk send. Try again.");
}

async function loadBulk(id) {
  const bulk = core.isObjectId(id) ? await CommBulkSend.findById(id) : null;
  if (!bulk) throw new BulkError(404, "NOT_FOUND", "Bulk send not found.");
  return bulk;
}

async function updateDraft({ id, patch }) {
  const bulk = await loadBulk(id);
  if (!["draft", "previewed"].includes(bulk.status)) throw new BulkError(409, "LOCKED", "This bulk send can no longer be edited.");
  const next = { purpose: patch.purpose ?? bulk.purpose, lineNumber: patch.lineNumber ?? bulk.lineNumber, body: patch.body ?? bulk.body, audience: patch.audience ?? bulk.audience };
  validateDraft(next);
  Object.assign(bulk, { name: patch.name ?? bulk.name, purpose: next.purpose, lineNumber: core.lineNumber(next.lineNumber), body: String(next.body).trim(), status: "draft", snapshotAt: null, counts: { total: 0, eligible: 0, excluded: 0 }, exclusions: {} });
  if (patch.audience) bulk.audience = { type: next.audience.type, userIds: next.audience.type === "selected" ? (next.audience.userIds || []).filter(core.isObjectId) : [], segment: next.audience.segment || "", label: next.audience.type === "segment" ? SEGMENTS.find((s) => s.key === next.audience.segment)?.label || "" : `${(next.audience.userIds || []).length} selected customers` };
  bulk.version += 1;
  await bulk.save();
  await CommBulkRecipient.deleteMany({ bulk: bulk._id });
  return bulk;
}

/**
 * Resolve and FREEZE the audience. Every exclusion is recorded with its
 * reason: no phone, duplicate number, blocked, STOP, no consent for this
 * purpose, undeliverable.
 */
async function preview({ id, now = new Date() }) {
  const bulk = await loadBulk(id);
  if (!["draft", "previewed"].includes(bulk.status)) throw new BulkError(409, "LOCKED", "This bulk send has already been confirmed.");
  const users = await audienceUsers(bulk.audience);
  if (users.length > MAX_AUDIENCE) throw new BulkError(400, "TOO_MANY", `This audience has more than ${MAX_AUDIENCE} customers. Narrow it down.`);
  const blocked = await blockedUserIdSet(users);
  const seen = new Set();
  const rows = [];
  const exclusions = {};
  const exclude = (u, phone, reason) => {
    exclusions[reason] = (exclusions[reason] || 0) + 1;
    rows.push({ bulk: bulk._id, user: u._id, name: core.displayNameOf(u), phone: "", status: "excluded", reason, body: "" });
    // the phone is not stored on excluded rows (keeps the unique index for real sends)
    void phone;
  };
  for (const u of users) {
    const phone = toE164(u.phone);
    if (!phone) {
      exclude(u, "", "no_valid_phone");
      continue;
    }
    if (seen.has(phone)) {
      exclude(u, phone, "duplicate_phone");
      continue;
    }
    const verdict = await checkCommsSend({ purpose: bulk.purpose, phone, user: u, mode: "bulk", now, blocked: blocked.has(String(u._id)) });
    if (!verdict.eligible) {
      exclude(u, phone, verdict.reason);
      continue;
    }
    seen.add(phone);
    rows.push({ bulk: bulk._id, user: u._id, name: core.displayNameOf(u), phone, status: "eligible", body: send.withOptOut(personalize(bulk.body, u), bulk.purpose) });
  }
  await CommBulkRecipient.deleteMany({ bulk: bulk._id });
  if (rows.length) await CommBulkRecipient.insertMany(rows, { ordered: false });
  const eligible = rows.filter((r) => r.status === "eligible");
  bulk.status = "previewed";
  bulk.snapshotAt = now;
  bulk.snapshotHash = snapshotDigest(bulk, rows);
  bulk.counts = { total: users.length, eligible: eligible.length, excluded: users.length - eligible.length };
  bulk.exclusions = exclusions;
  bulk.version += 1;
  await bulk.save();
  return {
    bulk,
    samples: eligible.slice(0, 3).map((r) => ({ name: r.name, body: r.body, segments: estimateSegments(r.body) })),
    maxSegments: eligible.reduce((m, r) => Math.max(m, estimateSegments(r.body)), 0),
    exclusions: Object.entries(exclusions).map(([reason, count]) => ({ reason, count, text: exclusionText(reason) })),
  };
}

function exclusionText(reason) {
  if (reason === "duplicate_phone") return "Same phone number as another customer in this list (texted once).";
  if (reason === "texted_by_another_bulk_today") return "Already received a bulk text in the last 24 hours.";
  return textFor(reason);
}

/**
 * Confirm the frozen audience. The caller must quote the eligible count they
 * saw. The owner's confirmation schedules it; anyone else's waits for the
 * owner's approval.
 */
async function confirm({ id, actor, isOwner, expectedEligible, expectedHash, scheduledFor = null, confirmKey, now = new Date() }) {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(String(confirmKey || ""))) throw new BulkError(400, "KEY", "Missing confirmation key.");
  const replay = await CommBulkSend.findOne({ confirmKey });
  if (replay) return replay;
  const bulk = await loadBulk(id);
  if (bulk.status !== "previewed") throw new BulkError(409, "NOT_PREVIEWED", "Preview the audience before confirming.");
  if (!bulk.snapshotAt || now - bulk.snapshotAt > SNAPSHOT_TTL_MS) throw new BulkError(409, "STALE", "The preview is more than 30 minutes old. Preview again so you confirm today's audience.");
  if (Number(expectedEligible) !== bulk.counts.eligible) throw new BulkError(409, "COUNT_CHANGED", `The audience is ${bulk.counts.eligible} people, not ${expectedEligible}. Review the preview again.`);
  if (bulk.counts.eligible < 1) throw new BulkError(409, "EMPTY", "Nobody in this audience can receive it.");
  // The exact people and message, not just how many: a same-size swap is refused.
  assertSameSnapshot(bulk, expectedHash, await currentDigest(bulk));
  const state = await send.sendingState("bulk");
  if (!state.on) throw new BulkError(409, "SENDING_OFF", state.reason);
  let when = now;
  if (scheduledFor) {
    when = new Date(scheduledFor);
    if (Number.isNaN(when.getTime())) throw new BulkError(400, "WHEN", "Choose a valid date and time.");
    if (when.getTime() < now.getTime() - 60000) throw new BulkError(400, "WHEN", "Choose a time in the future.");
    if (when.getTime() > now.getTime() + 30 * 864e5) throw new BulkError(400, "WHEN", "Schedule within the next 30 days.");
  }
  const updated = await CommBulkSend.findOneAndUpdate(
    { _id: bulk._id, status: "previewed", version: bulk.version, snapshotHash: expectedHash },
    {
      $set: {
        status: isOwner ? "scheduled" : "pending_approval",
        scheduledFor: when,
        confirmedCount: bulk.counts.eligible,
        confirmedBy: actor._id,
        confirmedAt: now,
        confirmKey,
        ...(isOwner ? { approvedBy: actor._id, approvedByName: core.displayNameOf(actor), approvedAt: now } : {}),
      },
      $inc: { version: 1 },
    },
    { new: true }
  );
  if (!updated) throw new BulkError(409, "CHANGED", "This bulk send changed while you were confirming. Review it again.");
  return updated;
}

/**
 * The owner approves the exact audience and message they are looking at: the
 * fingerprint shown with the recipients must match what was confirmed and what
 * is stored now.
 */
async function approve({ id, actor, expectedHash, now = new Date() }) {
  const pending = await loadBulk(id);
  if (pending.status !== "pending_approval") throw new BulkError(409, "NOT_PENDING", "This bulk send isn't waiting for approval.");
  assertSameSnapshot(pending, expectedHash, await currentDigest(pending));
  const bulk = await CommBulkSend.findOneAndUpdate(
    { _id: id, status: "pending_approval", snapshotHash: expectedHash },
    { $set: { status: "scheduled", approvedBy: actor._id, approvedByName: core.displayNameOf(actor), approvedAt: now }, $inc: { version: 1 } },
    { new: true }
  );
  if (!bulk) throw new BulkError(409, "NOT_PENDING", "This bulk send isn't waiting for approval.");
  if (bulk.scheduledFor < now) {
    bulk.scheduledFor = now;
    await bulk.save();
  }
  return bulk;
}

/**
 * Cancel: every recipient not yet handed to Twilio is canceled. Texts already
 * handed to Twilio may still be delivered; the screen says so.
 */
async function cancel({ id, actor, now = new Date() }) {
  const bulk = await CommBulkSend.findOneAndUpdate(
    { _id: id, status: { $in: ["draft", "previewed", "pending_approval", "scheduled", "sending"] } },
    { $set: { status: "canceled", canceledBy: actor._id, canceledAt: now }, $inc: { version: 1 } },
    { new: true }
  );
  if (!bulk) throw new BulkError(409, "NOT_CANCELABLE", "This bulk send has already finished or been canceled.");
  const r = await CommBulkRecipient.updateMany({ bulk: bulk._id, status: "eligible" }, { $set: { status: "canceled", reason: "Canceled before sending", processedAt: now } });
  return { bulk, canceled: r.modifiedCount || 0 };
}

/**
 * Retry confirmed failures, once each, as new recipient rows linked to the
 * old ones. Never adds a person who was not in the confirmed audience.
 */
async function retryFailed({ id, now = new Date() }) {
  const bulk = await loadBulk(id);
  if (!["completed", "sending", "scheduled"].includes(bulk.status) || !bulk.startedAt) throw new BulkError(409, "NOT_RETRYABLE", "Only a sent bulk send can retry failures.");
  const state = await send.sendingState("bulk");
  if (!state.on) throw new BulkError(409, "SENDING_OFF", state.reason);
  const failed = await CommBulkRecipient.find({ bulk: bulk._id, status: { $in: ["failed", "undelivered"] } }).lean();
  let created = 0;
  for (const f of failed) {
    if (await CommBulkRecipient.exists({ retryOf: f._id })) continue;
    try {
      await CommBulkRecipient.create({ bulk: bulk._id, user: f.user, name: f.name, phone: f.phone, body: f.body, status: "eligible", retryOf: f._id, round: (f.round || 0) + 1 });
      created += 1;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  if (created) await CommBulkSend.updateOne({ _id: bulk._id }, { $set: { status: "scheduled", scheduledFor: now, completedAt: null }, $inc: { version: 1 } });
  return { created };
}

/* ================================================================== worker */

async function claimBulk(now) {
  return CommBulkSend.findOneAndUpdate(
    {
      status: { $in: ["scheduled", "sending"] },
      scheduledFor: { $lte: now },
      $or: [{ lockExpiresAt: null }, { lockExpiresAt: { $lte: now } }],
    },
    { $set: { lockExpiresAt: new Date(now.getTime() + BULK_LOCK_MS) } },
    { new: true, sort: { scheduledFor: 1 } }
  );
}

async function claimRecipient(bulkId, now) {
  // Reclaim a recipient whose worker died mid-send; its idempotency key makes the resend a no-op.
  await CommBulkRecipient.updateMany({ bulk: bulkId, status: "sending", lockExpiresAt: { $lte: now } }, { $set: { status: "eligible" } });
  return CommBulkRecipient.findOneAndUpdate(
    { bulk: bulkId, status: "eligible" },
    { $set: { status: "sending", lockExpiresAt: new Date(now.getTime() + RECIPIENT_LOCK_MS) }, $inc: { attempts: 1 } },
    { new: true, sort: { _id: 1 } }
  );
}

const RECIPIENT_STATUS = { queued: "sent", sending: "sent", sent: "sent", delivered: "delivered", undelivered: "undelivered", failed: "failed", unknown: "unknown" };

async function processRecipient(bulk, r, now) {
  const fresh = r.user ? await User.findById(r.user).select("_id name firstName phone smsPreferences excludeFromMarketing role").lean() : null;
  const blocked = fresh ? (await blockedUserIdSet([fresh])).has(String(fresh._id)) : false;
  // Recheck at send time: an opt-out, a withdrawn consent or a changed number after scheduling is honoured.
  const verdict = await checkCommsSend({ purpose: bulk.purpose, phone: r.phone, user: fresh, mode: "bulk", now, blocked });
  const skip = async (reason, text) => CommBulkRecipient.updateOne({ _id: r._id }, { $set: { status: "skipped", reason: text || reason, processedAt: now, lockExpiresAt: null } });
  if (!fresh) return skip("no_customer", "The customer account no longer exists.");
  if (toE164(fresh.phone) !== r.phone) return skip("phone_changed", "The customer's number changed after the preview.");
  if (!verdict.eligible) return skip(verdict.reason, verdict.text);
  const since = new Date(now.getTime() - 24 * 3600e3);
  const recent = await CommMessage.exists({ kind: "bulk", toAddress: r.phone, bulkSend: { $ne: bulk._id }, occurredAt: { $gte: since }, status: { $nin: ["failed", "canceled"] } });
  if (recent) return skip("texted_by_another_bulk_today", exclusionText("texted_by_another_bulk_today"));
  try {
    const conv = await core.conversationForPhone(r.phone);
    if (conv.linkState === "linked" && String(conv.user) !== String(fresh._id)) return skip("phone_belongs_to_other", "This number's conversation is linked to a different customer.");
    const { message } = await send.sendText({
      actor: { _id: bulk.approvedBy || bulk.createdBy, name: bulk.approvedByName || bulk.createdByName },
      userId: String(fresh._id),
      toPhone: r.phone,
      lineNumber: bulk.lineNumber,
      body: r.body,
      purpose: bulk.purpose,
      idempotencyKey: `bulk-${String(r._id)}`,
      kind: "bulk",
      bulkSend: bulk._id,
      bulkRecipient: r._id,
    });
    await CommBulkRecipient.updateOne({ _id: r._id }, { $set: { status: RECIPIENT_STATUS[message.status] || "sent", reason: message.errorMessage || "", message: message._id, processedAt: now, lockExpiresAt: null } });
  } catch (error) {
    // Sending switched off mid-run: the recipient waits (not skipped) and the run pauses.
    if (error instanceof send.SendError && error.code === "SENDING_OFF") {
      await CommBulkRecipient.updateOne({ _id: r._id }, { $set: { status: "eligible", lockExpiresAt: null } });
      return "paused";
    }
    if (error instanceof send.SendError) return skip(error.code, error.message);
    await CommBulkRecipient.updateOne({ _id: r._id }, { $set: { status: "eligible", lockExpiresAt: null } });
    throw error;
  }
}

/**
 * One worker tick (jobs/comms.js, every 30 seconds): at most `perMinute/2`
 * texts per bulk send per tick, only inside the purpose's send window.
 */
async function runBulkTick({ now = new Date(), maxBulks = 3 } = {}) {
  const out = { bulks: 0, processed: 0, completed: 0, waitingForWindow: 0 };
  for (let i = 0; i < maxBulks; i++) {
    const bulk = await claimBulk(now);
    if (!bulk) break;
    out.bulks += 1;
    try {
      const state = await send.sendingState("bulk");
      if (!state.on) continue;
      if (!bulkWindowOpen(bulk.purpose, now)) {
        out.waitingForWindow += 1;
        continue;
      }
      // Integrity: the rows about to be sent must still be exactly the approved snapshot.
      if ((await currentDigest(bulk)) !== bulk.snapshotHash) {
        await CommBulkSend.updateOne({ _id: bulk._id }, { $set: { status: "halted", haltedReason: "The recipients or message no longer match what was approved. Nothing more was sent." }, $inc: { version: 1 } });
        await CommBulkRecipient.updateMany({ bulk: bulk._id, status: "eligible" }, { $set: { status: "canceled", reason: "Halted: the audience no longer matched the approval." } });
        await core.healthEvent("bulk_halted_integrity", String(bulk._id));
        out.halted = (out.halted || 0) + 1;
        continue;
      }
      if (bulk.status === "scheduled") await CommBulkSend.updateOne({ _id: bulk._id, status: "scheduled" }, { $set: { status: "sending", startedAt: bulk.startedAt || now }, $inc: { version: 1 } });
      const budget = Math.max(1, Math.floor((bulk.perMinute || 30) / 2));
      for (let n = 0; n < budget; n++) {
        const live = await CommBulkSend.findById(bulk._id).select("status").lean();
        if (!live || live.status === "canceled") break;
        const r = await claimRecipient(bulk._id, now);
        if (!r) break;
        if ((await processRecipient(bulk, r, now)) === "paused") break;
        out.processed += 1;
      }
      const remaining = await CommBulkRecipient.countDocuments({ bulk: bulk._id, status: { $in: ["eligible", "sending"] } });
      if (!remaining) {
        const done = await CommBulkSend.updateOne({ _id: bulk._id, status: "sending" }, { $set: { status: "completed", completedAt: now }, $inc: { version: 1 } });
        if (done.modifiedCount) out.completed += 1;
      }
    } finally {
      await CommBulkSend.updateOne({ _id: bulk._id }, { $set: { lockExpiresAt: null } });
    }
  }
  return out;
}

/** Live counts per recipient status, for the bulk detail screen. */
async function recipientCounts(bulkId) {
  const rows = await CommBulkRecipient.aggregate([{ $match: { bulk: bulkId } }, { $group: { _id: "$status", n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}

module.exports = {
  BulkError,
  MAX_AUDIENCE,
  SEGMENTS,
  approve,
  cancel,
  confirm,
  createDraft,
  exclusionText,
  personalize,
  preview,
  recipientCounts,
  retryFailed,
  runBulkTick,
  updateDraft,
};
