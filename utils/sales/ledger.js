/**
 * The commission ledger and Friday payouts.
 *
 * addEntry() is the only way money enters the ledger. It is idempotent on
 * sourceKey (one entry per sale, per bonus block, per adjustment key).
 *
 * NOTHING OMITTED, NOTHING TWICE
 * - addEntry and approveWeek both increment the single ledger clock document
 *   inside their transactions, so they never interleave: an entry is either on
 *   the week being approved (and frozen with it) or placed after it.
 * - An entry is placed on its earned week only if no week from there on is
 *   approved; otherwise on the first open week after the latest approved one,
 *   marked late. So no entry can ever land on an old week nobody will approve,
 *   and a frozen statement never changes.
 * - Weeks are approved oldest first: approving a week is refused while an
 *   earlier week still has open entries.
 * - Approval takes every open entry of the week, once (status open -> approved,
 *   with the batch id); a payment is recorded once per line and moves exactly
 *   that line's entries approved -> paid. ledgerIntegrity() proves all of this
 *   on the stored data (tests, and the nightly job).
 *
 * Payday: the Friday immediately after the Friday–Thursday week (no extra hold).
 * No money is moved from here. "Paid" is the owner recording a payment they
 * made outside Profixter.
 */
const mongoose = require("mongoose");
const { CommissionEntry, PayoutBatch, SalesLedgerClock } = require("../../models/Sales");
const User = require("../../models/User");
const { payWeekOf, weekFromStart, nextWeekKey, shortDay } = require("./time");

class SalesError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.statusCode = status;
    this.extra = extra;
  }
}

async function inTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

const CLOCK = "ledger";

/** Create the clock once, outside any transaction (an upsert race inside one is not retried). */
async function ensureClock() {
  try {
    await SalesLedgerClock.updateOne({ _id: CLOCK }, { $setOnInsert: { n: 0 } }, { upsert: true });
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
}
/** Every ledger transaction writes the clock: concurrent ones conflict, and one is retried after the other commits. */
const tick = (session) => SalesLedgerClock.updateOne({ _id: CLOCK }, { $inc: { n: 1 } }, { session });

/** Touch the week's batch (creating it open) and return it; inside the caller's transaction. */
async function touchWeek(week, session) {
  const w = weekFromStart(week);
  return PayoutBatch.findOneAndUpdate(
    { week },
    { $inc: { writes: 1 }, $setOnInsert: { week, weekStartsAt: w.startsAt, weekEndsAt: w.endsAt, payday: w.payday, status: "open" } },
    { upsert: true, new: true, session }
  );
}

/**
 * Add one approved ledger entry. `earnedAt` decides the earned week (for a sale:
 * Stripe's payment time). Returns { entry, created }.
 */
async function addEntry(fields) {
  if (!Number.isInteger(fields.amountCents)) throw new SalesError("BAD_AMOUNT", "Amounts are whole cents.");
  const existing = await CommissionEntry.findOne({ sourceKey: fields.sourceKey });
  if (existing) return { entry: existing, created: false };
  const earned = payWeekOf(fields.earnedAt);
  await ensureClock();
  try {
    const entry = await inTransaction(async (session) => {
      await tick(session);
      let week = earned.week;
      const latest = await PayoutBatch.findOne({ status: { $ne: "open" } }).sort({ week: -1 }).select("week").session(session).lean();
      if (latest && latest.week >= week) week = nextWeekKey(latest.week);
      for (let i = 0; i < 520; i += 1) {
        const batch = await touchWeek(week, session);
        if (batch.status === "open") break;
        week = nextWeekKey(week);
      }
      const late = week !== earned.week;
      const [doc] = await CommissionEntry.create(
        [{ ...fields, earnedWeek: earned.week, statementWeek: week, late: late || Boolean(fields.late), status: "open" }],
        { session }
      );
      return doc;
    });
    return { entry, created: true };
  } catch (error) {
    if (error?.code === 11000) {
      const entry = await CommissionEntry.findOne({ sourceKey: fields.sourceKey });
      if (entry) return { entry, created: false };
    }
    throw error;
  }
}

function linesFrom(entries, names) {
  const by = new Map();
  for (const e of entries) {
    const k = String(e.employee);
    if (!by.has(k)) by.set(k, { employee: e.employee, employeeName: names.get(k) || "", commissionCents: 0, bonusCents: 0, adjustmentCents: 0, totalCents: 0, entries: [] });
    const line = by.get(k);
    if (e.kind === "commission") line.commissionCents += e.amountCents;
    else if (e.kind === "bonus") line.bonusCents += e.amountCents;
    else line.adjustmentCents += e.amountCents;
    line.totalCents += e.amountCents;
    line.entries.push(e._id);
  }
  return [...by.values()].sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}

async function namesFor(ids) {
  const users = await User.find({ _id: { $in: ids } }).select("name").lean();
  return new Map(users.map((u) => [String(u._id), u.name || ""]));
}

/** A week's statement lines: frozen if approved, otherwise computed live from its open entries. */
async function weekView(week, { employee = null } = {}) {
  const w = weekFromStart(week);
  const batch = await PayoutBatch.findOne({ week }).lean();
  const filter = { statementWeek: week, ...(employee ? { employee } : {}) };
  const entries = await CommissionEntry.find(filter).sort({ earnedAt: 1 }).lean();
  if (batch && batch.status === "approved") {
    const lines = (batch.lines || []).filter((l) => !employee || String(l.employee) === String(employee));
    return { ...w, status: "approved", approvedAt: batch.approvedAt, approvedByName: batch.approvedByName, lines, entries };
  }
  const names = await namesFor([...new Set(entries.map((e) => String(e.employee)))]);
  const now = Date.now();
  return { ...w, status: now >= w.endsAt.getTime() ? "ready" : "accruing", lines: linesFrom(entries, names), entries };
}

/**
 * Freeze a finished week. After this, its lines and totals never change; any
 * entry for it arriving later is placed on the next open week (late).
 */
async function approveWeek(week, actor) {
  const w = weekFromStart(week);
  if (Date.now() < w.endsAt.getTime()) throw new SalesError("WEEK_NOT_FINISHED", `This week ends Thursday ${w.lastDay} at midnight; it can be approved from payday, ${w.payday}.`, 409);
  await ensureClock();
  return inTransaction(async (session) => {
    await tick(session);
    const batch = await touchWeek(week, session);
    if (batch.status !== "open") throw new SalesError("ALREADY_APPROVED", "This payout week is already approved.", 409);
    const earlier = (await CommissionEntry.distinct("statementWeek", { statementWeek: { $lt: week }, status: "open" }).session(session)).sort();
    if (earlier.length) {
      const list = earlier.map((w) => `week of ${shortDay(w)}`).join(", ");
      throw new SalesError("EARLIER_WEEK_OPEN", `Approve the earlier payout week${earlier.length === 1 ? "" : "s"} first (${list}). Weeks are approved oldest first so no earnings are skipped.`, 409, { weeks: earlier });
    }
    const entries = await CommissionEntry.find({ statementWeek: week, status: "open" }).session(session);
    const names = await namesFor([...new Set(entries.map((e) => String(e.employee)))]);
    const lines = linesFrom(entries, names);
    await PayoutBatch.updateOne(
      { _id: batch._id, status: "open" },
      { $set: { status: "approved", approvedBy: actor._id, approvedByName: actor.name || "", approvedAt: new Date(), lines } },
      { session }
    );
    if (entries.length) {
      await CommissionEntry.updateMany({ _id: { $in: entries.map((e) => e._id) }, status: "open" }, { $set: { status: "approved", batch: batch._id } }, { session });
    }
    return PayoutBatch.findById(batch._id).session(session).lean();
  });
}

/** Record that the owner paid one employee's line (outside Profixter). Once only. */
async function recordPayment(week, employeeId, { paidOn, method, reference }, actor) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(paidOn || ""))) throw new SalesError("BAD_DATE", "Enter the date you paid.");
  const m = String(method || "").trim();
  if (!m) throw new SalesError("METHOD_REQUIRED", "Say how it was paid (for example payroll, check or transfer).");
  return inTransaction(async (session) => {
    const batch = await PayoutBatch.findOne({ week }).session(session);
    if (!batch || batch.status !== "approved") throw new SalesError("NOT_APPROVED", "Approve the week before recording payments.", 409);
    const line = batch.lines.find((l) => String(l.employee) === String(employeeId));
    if (!line) throw new SalesError("NO_LINE", "This employee has nothing on this week's statement.", 404);
    if (line.payment?.status === "paid") throw new SalesError("ALREADY_PAID", "This payment is already recorded.", 409);
    line.payment = { status: "paid", paidOn, method: m.slice(0, 60), reference: String(reference || "").slice(0, 120), recordedBy: actor._id, recordedByName: actor.name || "", recordedAt: new Date() };
    batch.writes += 1;
    await batch.save({ session });
    await CommissionEntry.updateMany({ _id: { $in: line.entries }, status: "approved" }, { $set: { status: "paid" } }, { session });
    return batch.toObject();
  });
}

/**
 * Prove the payout invariants on the stored ledger. Returns { ok, problems }.
 *   - every approved week's lines hold exactly its approved/paid entries, each once, with matching totals
 *   - no entry appears in two lines or two weeks; no entry is approved or paid without a week
 *   - no open entry sits on or before the latest approved week (it would never be paid)
 *   - a paid line's entries are all paid, an unpaid line's none
 */
async function ledgerIntegrity() {
  const problems = [];
  const batches = await PayoutBatch.find({ status: "approved" }).sort({ week: 1 }).lean();
  const seen = new Map();
  for (const b of batches) {
    const inBatch = await CommissionEntry.find({ batch: b._id }).lean();
    const byId = new Map(inBatch.map((e) => [String(e._id), e]));
    const listed = new Set();
    for (const l of b.lines || []) {
      let total = 0;
      for (const id of l.entries || []) {
        const k = String(id);
        if (seen.has(k)) problems.push(`entry ${k} is listed on week ${seen.get(k)} and on week ${b.week}`);
        seen.set(k, b.week);
        listed.add(k);
        const e = byId.get(k);
        if (!e) {
          problems.push(`week ${b.week} lists entry ${k}, which is not in that week's batch`);
          continue;
        }
        if (String(e.employee) !== String(l.employee)) problems.push(`entry ${k} is on another employee's line`);
        if (e.statementWeek !== b.week) problems.push(`entry ${k} belongs to week ${e.statementWeek} but is listed on ${b.week}`);
        const paid = l.payment?.status === "paid";
        if (paid && e.status !== "paid") problems.push(`entry ${k} is on a paid line but is ${e.status}`);
        if (!paid && e.status !== "approved") problems.push(`entry ${k} is on an unpaid line but is ${e.status}`);
        total += e.amountCents;
      }
      if (total !== l.totalCents) problems.push(`week ${b.week}, ${l.employeeName}: the line says ${l.totalCents} cents, its entries sum to ${total}`);
    }
    for (const e of inBatch) if (!listed.has(String(e._id))) problems.push(`entry ${e._id} is in week ${b.week}'s batch but on no line`);
  }
  const orphan = await CommissionEntry.countDocuments({ status: { $in: ["approved", "paid"] }, batch: null });
  if (orphan) problems.push(`${orphan} approved or paid entries have no payout week`);
  const latest = batches[batches.length - 1];
  if (latest) {
    const stranded = await CommissionEntry.find({ status: "open", statementWeek: { $lte: latest.week } }).select("_id statementWeek").lean();
    for (const e of stranded) problems.push(`open entry ${e._id} is on week ${e.statementWeek}, on or before the approved week ${latest.week}: it would never be paid`);
  }
  return { ok: problems.length === 0, problems, approvedWeeks: batches.length, checkedEntries: seen.size };
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const money = (c) => (c / 100).toFixed(2);

/** The payroll export for an approved week: one row per employee, no customer data. */
function batchCsv(batch) {
  const rows = [["week_start", "week_end", "payday", "employee", "commission", "bonus", "adjustments", "total", "payment_status", "paid_on", "method", "reference"]];
  const w = weekFromStart(batch.week);
  for (const l of batch.lines || []) {
    rows.push([batch.week, w.lastDay, w.payday, l.employeeName, money(l.commissionCents), money(l.bonusCents), money(l.adjustmentCents), money(l.totalCents), l.payment?.status || "unpaid", l.payment?.paidOn || "", l.payment?.method || "", l.payment?.reference || ""]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

module.exports = { SalesError, inTransaction, addEntry, weekView, approveWeek, recordPayment, ledgerIntegrity, batchCsv, csvCell, money };
