/**
 * The membership-volume bonus: $500 for every 20 qualifying membership sales
 * in an employee's month-long period, no cap (20 → $500, 40 → $1,000, 60 → $1,500).
 *
 * Counted: approved commission entries for membership sales (monthly or
 * annual, each counts once), including approved recovery sales, each placed in
 * the period of its VERIFIED PAYMENT DATE. Not counted: renewals (they never
 * create entries), Full Days, free or unpaid purchases, upgrades the owner did
 * not mark as counting.
 *
 * Periods: see utils/sales/time.js. The anchor is fixed the first time a
 * qualifying sale is counted and is never moved afterwards (moving it would
 * reshuffle bonuses already paid). A sale approved later whose payment is
 * BEFORE the anchor (a late-approved recovery) counts in the month-long period
 * of the same anniversary calendar that contains its payment date (index -1,
 * -2, ...), never in period 0 with sales from a different month.
 *
 * A bonus entry, once created, is never removed automatically. A refund of a
 * counted sale only opens a review (utils/sales/credit.js).
 */
const crypto = require("crypto");
const { BonusPeriod, CommissionEntry, SalesCredit, SalesCreditRequest, SalesEvent, SalesLock } = require("../../models/Sales");
const { addEntry } = require("./ledger");
const { ruleAt } = require("./rules");
const { bonusPeriod, bonusPeriodIndexFor, nyDate } = require("./time");

async function withLock(key, fn, { waitMs = 15000 } = {}) {
  const owner = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const now = new Date();
    try {
      const got = await SalesLock.findOneAndUpdate(
        { _id: key, $or: [{ until: { $lt: now } }, { owner }] },
        { $set: { owner, until: new Date(now.getTime() + 30000) } },
        { upsert: true, new: true }
      );
      if (got && got.owner === owner) break;
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    if (Date.now() > deadline) throw new Error(`lock ${key} busy`);
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
  }
  try {
    return await fn();
  } finally {
    await SalesLock.deleteOne({ _id: key, owner }).catch(() => {});
  }
}

async function qualifyingEntries(employeeId) {
  return CommissionEntry.find({ employee: employeeId, kind: "commission", countsForBonus: true })
    .sort({ paidAt: 1, _id: 1 })
    .lean();
}

async function ensurePeriod(employeeId, anchorDate, index) {
  const existing = await BonusPeriod.findOne({ employee: employeeId, index }).lean();
  if (existing) return existing;
  const p = bonusPeriod(anchorDate, index);
  const rule = await ruleAt("bonus_volume", p.startsAt);
  try {
    return (await BonusPeriod.create({ employee: employeeId, index, anchorDate, startsAt: p.startsAt, endsAt: p.endsAt, rule })).toObject();
  } catch (error) {
    if (error?.code === 11000) return BonusPeriod.findOne({ employee: employeeId, index }).lean();
    throw error;
  }
}

async function anchorFor(employeeId) {
  const first = await BonusPeriod.findOne({ employee: employeeId, index: 0 }).lean();
  return first ? first.anchorDate : null;
}

/** Which period a payment falls in (negative before the anchor: see the header). */
const periodIndexOf = (anchor, paidAt) => bonusPeriodIndexFor(anchor, paidAt);
const periodName = (index, p) => (index >= 0 ? `bonus month ${index + 1} (${p.firstDay} – ${p.lastDay})` : `the bonus month ${p.firstDay} – ${p.lastDay}, before your first counted sale's month`);

/**
 * Create every bonus the employee has earned and does not yet have. Safe to
 * call any number of times, concurrently: bonus entries are keyed by
 * employee, period and block, and evaluation runs under a per-employee lock.
 */
async function evaluateBonus(employeeId) {
  return withLock(`bonus:${employeeId}`, async () => {
    const entries = await qualifyingEntries(employeeId);
    if (!entries.length) return { created: [] };
    let anchor = await anchorFor(employeeId);
    if (!anchor) {
      anchor = nyDate(entries[0].paidAt);
      await ensurePeriod(employeeId, anchor, 0);
    }
    const byPeriod = new Map();
    for (const e of entries) {
      const i = periodIndexOf(anchor, e.paidAt);
      if (!byPeriod.has(i)) byPeriod.set(i, []);
      byPeriod.get(i).push(e);
    }
    const created = [];
    for (const [index, list] of [...byPeriod.entries()].sort((a, b) => a[0] - b[0])) {
      const period = await ensurePeriod(employeeId, anchor, index);
      const { threshold, amountCents } = period.rule.params;
      const blocks = Math.floor(list.length / threshold);
      for (let block = 1; block <= blocks; block += 1) {
        const counted = list.slice((block - 1) * threshold, block * threshold);
        const last = counted[counted.length - 1];
        // Earned at the block's last sale (its payment time). If that week is already approved, addEntry puts it on the next open statement, marked late.
        const earnedAt = last.earnedAt;
        const p = bonusPeriod(anchor, index);
        const { entry, created: isNew } = await addEntry({
          sourceKey: `bonus:${employeeId}:${index}:${block}`,
          employee: employeeId,
          kind: "bonus",
          product: "bonus",
          amountCents: Math.trunc(amountCents),
          countsForBonus: false,
          earnedAt,
          paidAt: last.paidAt,
          calc: {
            method: "volume_bonus",
            explain: `${block * threshold} qualifying memberships in ${periodName(index, p)}: bonus ${block} of ${(amountCents / 100).toFixed(0)}`,
            rule: period.rule,
          },
          bonus: { period: period._id, periodIndex: index, block, countedEntries: counted.map((c) => c._id) },
        });
        if (isNew) created.push(entry);
      }
    }
    return { created };
  });
}

/**
 * The single source of truth for bonus progress. The employee's screen, the
 * manager's team row, the employee detail and the tests all read this.
 */
async function bonusProgress(employeeId, at = new Date()) {
  const anchor = await anchorFor(employeeId);
  const pending = await pendingQualifying(employeeId);
  const bonusEntries = await CommissionEntry.find({ employee: employeeId, kind: "bonus" }).lean();
  const sum = (list) => list.reduce((s, e) => s + e.amountCents, 0);
  const allTime = {
    earnedCents: sum(bonusEntries),
    paidCents: sum(bonusEntries.filter((e) => e.status === "paid")),
    awaitingPaymentCents: sum(bonusEntries.filter((e) => e.status !== "paid")),
    count: bonusEntries.length,
  };
  if (!anchor) {
    const rule = await ruleAt("bonus_volume", at);
    return {
      started: false,
      threshold: rule.params.threshold,
      amountCents: rule.params.amountCents,
      pendingCount: pending.length,
      allTime,
      message: "Your first verified membership sale starts your bonus month.",
    };
  }
  const index = periodIndexOf(anchor, at);
  const period = await ensurePeriod(employeeId, anchor, index);
  const p = bonusPeriod(anchor, index);
  const { threshold, amountCents } = period.rule.params;
  const entries = (await qualifyingEntries(employeeId)).filter((e) => periodIndexOf(anchor, e.paidAt) === index);
  const verified = entries.length;
  const pendingHere = pending.filter((x) => periodIndexOf(anchor, x.paidAt) === index);
  const inBlock = verified % threshold;
  const remaining = threshold - inBlock;
  const periodBonuses = bonusEntries.filter((e) => e.bonus?.periodIndex === index);
  const msLeft = Math.max(0, p.endsAt.getTime() - new Date(at).getTime());
  return {
    started: true,
    anchorDate: anchor,
    period: { index, number: index + 1, firstDay: p.firstDay, lastDay: p.lastDay, startsAt: p.startsAt, endsAt: p.endsAt, msLeft },
    threshold,
    amountCents,
    verifiedCount: verified,
    pendingCount: pendingHere.length,
    pendingItems: pendingHere.map((x) => ({ kind: x.kind, paidAt: x.paidAt })),
    inBlock,
    remaining,
    nextBonusAt: verified - inBlock + threshold,
    bonusesThisPeriod: periodBonuses.length,
    earnedThisPeriodCents: sum(periodBonuses),
    paidThisPeriodCents: sum(periodBonuses.filter((e) => e.status === "paid")),
    awaitingPaymentThisPeriodCents: sum(periodBonuses.filter((e) => e.status !== "paid")),
    /* Milestones inside the current block of 20 (the block restarts after each bonus). */
    milestones: [5, 10, 15, threshold].map((m) => ({ at: m, reached: inBlock >= m })),
    countedSales: entries.map((e) => ({ entry: e._id, sale: e.sale, user: e.user, product: e.product, paidAt: e.paidAt })),
    allTime,
    message: encouragement({ verified, inBlock, remaining, threshold, msLeft, amountCents }),
  };
}

/** Membership sales waiting for the owner: held credits and open credit requests, for this employee. */
async function pendingQualifying(employeeId) {
  const out = [];
  const held = await SalesCredit.find({ status: "held", "claimants.employee": employeeId }).lean();
  const reqs = await SalesCreditRequest.find({ employee: employeeId, status: { $in: ["pending", "needs_info"] } }).lean();
  const saleIds = [...held.map((h) => h.sale), ...reqs.map((r) => r.sale)];
  const sales = new Map((await SalesEvent.find({ _id: { $in: saleIds } }).lean()).map((s) => [String(s._id), s]));
  for (const h of held) {
    const s = sales.get(String(h.sale));
    if (s && s.kind === "membership_first_paid") out.push({ kind: "held_credit", paidAt: s.paidAt });
  }
  for (const r of reqs) {
    const s = sales.get(String(r.sale));
    if (s && r.proposed?.countsForBonusDefault) out.push({ kind: "credit_request", paidAt: s.paidAt });
  }
  return out;
}

function encouragement({ verified, inBlock, remaining, threshold, msLeft, amountCents }) {
  const prize = `$${(amountCents / 100).toFixed(0)}`;
  const days = Math.ceil(msLeft / 86400000);
  if (verified >= threshold && inBlock === 0) return `You earned your ${prize} bonus${verified > threshold ? "es" : ""}! ${verified} memberships this bonus month.`;
  if (verified === 0) return `Your next ${prize} starts with one membership.`;
  if (remaining === 1) return `One more membership earns ${prize}.`;
  if (days <= 3 && msLeft > 0) return `${days} day${days === 1 ? "" : "s"} left: ${remaining} more for ${prize}.`;
  if (inBlock >= 15) return `${remaining} to go.`;
  if (inBlock >= 10) return `More than halfway to ${prize}.`;
  if (inBlock >= 5) return `${inBlock} down: a quarter of the way there and counting.`;
  return `${inBlock} membership${inBlock === 1 ? "" : "s"} so far: ${remaining} to your next ${prize}.`;
}

module.exports = { evaluateBonus, bonusProgress, withLock };
