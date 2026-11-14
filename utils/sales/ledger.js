/**
 * The commission ledger and Friday payouts.
 *
 * addEntry() is the only way money enters the ledger. It is idempotent on
 * sourceKey, and it places the entry on a statement inside a transaction that
 * also writes that week's PayoutBatch document; approving a week writes the
 * same document, so an entry and an approval can never interleave. An entry
 * whose earned week is already approved goes to the next open week, marked
 * late, so a frozen statement never changes.
 *
 * Payday: the Friday immediately after the Friday–Thursday week (no extra hold).
 * No money is moved from here. "Paid" is the owner recording a payment they
 * made outside Profixter.
 */
const mongoose = require("mongoose");
const { CommissionEntry, PayoutBatch } = require("../../models/Sales");
const User = require("../../models/User");
const { payWeekOf, weekFromStart, nextWeekKey } = require("./time");

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
  try {
    const entry = await inTransaction(async (session) => {
      let week = earned.week;
      let late = false;
      for (let i = 0; i < 520; i += 1) {
        const batch = await touchWeek(week, session);
        if (batch.status === "open") break;
        week = nextWeekKey(week);
        late = true;
      }
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
  return inTransaction(async (session) => {
    const batch = await touchWeek(week, session);
    if (batch.status !== "open") throw new SalesError("ALREADY_APPROVED", "This payout week is already approved.", 409);
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

module.exports = { SalesError, inTransaction, addEntry, weekView, approveWeek, recordPayment, batchCsv, csvCell, money };
