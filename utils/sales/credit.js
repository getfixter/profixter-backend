/**
 * From a verified sale to sales credit, and the owner's reviews.
 *
 * AUTOMATIC CREDIT (routine sales) needs all of:
 *   - the payment is tied to the account by a verified Stripe relationship
 *     (the account's own Stripe customer, or the account id our checkout put on it)
 *   - the account is linked to an active lead by a verified link (never by
 *     matching an email or phone)
 *   - an assignment of that lead was open at the payment time; its
 *     creditEmployee (chosen by the manager at any reassignment) gets the credit
 *   - nobody else has a claim (another employee's referral link on the account)
 *   - the customer is not returning (never paid for a membership before)
 * Otherwise the credit is HELD for the owner, or NONE (unattributed / returning
 * customer, which the employee can claim with Request sales credit).
 *
 * One SalesCredit and at most one commission entry per sale (sourceKey
 * commission:<sale>), so a purchase can never be credited twice by any path.
 */
const { SalesCredit, SalesCreditRequest, SalesEvent, SalesLead, LeadAssignment, SalesReferral, SalesReview, CommissionEntry } = require("../../models/Sales");
const User = require("../../models/User");
const { addEntry, SalesError } = require("./ledger");
const { evaluateBonus } = require("./bonus");
const { computeCommission, ruleAt, ruleKeyForSale, dollars, label } = require("./rules");
const { effectiveRole } = require("../../middleware/authorize");

const isMembershipSale = (sale) => sale.kind === "membership_first_paid";

/** Write a verified money fact once. */
async function recordSale(fields) {
  try {
    const sale = await SalesEvent.create(fields);
    return { sale: sale.toObject(), created: true };
  } catch (error) {
    if (error?.code === 11000) {
      const sale = await SalesEvent.findOne({ sourceKey: fields.sourceKey }).lean();
      if (sale) return { sale, created: false };
      // A second first-paid event for the same subscription under another key: keep the first.
      const bySub = fields.stripe?.subscriptionId && (await SalesEvent.findOne({ kind: "membership_first_paid", "stripe.subscriptionId": fields.stripe.subscriptionId }).lean());
      if (bySub) return { sale: bySub, created: false };
    }
    throw error;
  }
}

async function assignmentAt(leadId, at) {
  return LeadAssignment.findOne({ lead: leadId, startedAt: { $lte: at }, $or: [{ endedAt: null }, { endedAt: { $gt: at } }] }).lean();
}

/** What the sale would earn now, with the rule snapshot. */
async function previewCommission(sale) {
  const rule = await ruleAt(ruleKeyForSale(sale), sale.paidAt);
  return { rule, computed: computeCommission(sale, rule) };
}

/** Create the commission entry for a credited sale (idempotent per sale) and re-count the bonus. */
async function creditEntry(sale, credit, { employeeId, createdBy = null, createdByName = "", amountCents = null, countsForBonus, explainPrefix = "" }) {
  const { rule, computed } = await previewCommission(sale);
  const amount = amountCents === null ? computed.amountCents : Math.trunc(amountCents);
  if (!(amount > 0)) return null;
  const product = sale.kind === "full_day_paid" ? "full_day" : sale.cycle === "annual" ? "membership_annual" : "membership_monthly";
  const { entry } = await addEntry({
    sourceKey: `commission:${sale._id}`,
    employee: employeeId,
    kind: "commission",
    product,
    amountCents: amount,
    sale: sale._id,
    credit: credit._id,
    user: sale.user,
    countsForBonus: countsForBonus === undefined ? isMembershipSale(sale) : Boolean(countsForBonus),
    calc: {
      regularCents: sale.amounts.regularCents,
      discountCents: sale.amounts.discountCents,
      discountSource: sale.discount?.source || "",
      paidPreTaxCents: sale.amounts.paidPreTaxCents,
      taxCents: sale.amounts.taxCents,
      method: computed.method || rule.params.method,
      explain: `${explainPrefix}${amountCents === null ? computed.explain : `${computed.explain || ""}${computed.explain ? "; " : ""}owner approved ${dollars(amount)}`}`,
      rule,
    },
    paidAt: sale.paidAt,
    earnedAt: sale.paidAt,
    createdBy,
    createdByName,
  });
  await evaluateBonus(employeeId);
  return entry;
}

async function openReview(fields) {
  try {
    return (await SalesReview.create(fields)).toObject();
  } catch (error) {
    if (error?.code === 11000) return SalesReview.findOne({ key: fields.key }).lean();
    throw error;
  }
}

/**
 * Decide credit for a newly verified sale. Idempotent: a sale that already has
 * a credit decision keeps it.
 */
async function creditForSale(saleOrId) {
  const sale = saleOrId?._id ? saleOrId : await SalesEvent.findById(saleOrId).lean();
  if (!sale || !["membership_first_paid", "full_day_paid", "membership_change_paid"].includes(sale.kind)) return null;
  const existing = await SalesCredit.findOne({ sale: sale._id }).lean();
  if (existing) return existing;

  const claimants = [];
  const holdReasons = [];
  const lead = sale.user ? await SalesLead.findOne({ linkedUser: sale.user, status: "active" }).lean() : null;
  const assignment = lead ? await assignmentAt(lead._id, sale.paidAt) : null;
  if (assignment) claimants.push({ employee: assignment.creditEmployee, basis: "assignment", detail: assignment.creditDecision === "keep_previous" ? "credit kept with this employee at reassignment" : "assigned at the time of payment" });
  const referral = sale.user ? await SalesReferral.findOne({ user: sale.user }).lean() : null;
  if (referral && !claimants.some((c) => String(c.employee) === String(referral.employee))) {
    claimants.push({ employee: referral.employee, basis: "referral", detail: `account created through referral link ${referral.code}` });
  }

  let ownerAssisted = false;
  if (sale.seller) {
    const seller = await User.findById(sale.seller).select("email role").lean();
    ownerAssisted = Boolean(seller && effectiveRole(seller) === "admin");
  }

  const base = { sale: sale._id, user: sale.user, lead: lead?._id || null, claimants, ownerAssisted, countsForBonus: isMembershipSale(sale) };
  if (sale.kind === "membership_change_paid") {
    // A plan change is never a new sale on its own: only a credit request can turn it into one.
    return upsertCredit({ ...base, status: "none", basis: "none", reason: "plan_change", countsForBonus: false });
  }
  if (sale.returningCustomer) {
    return upsertCredit({ ...base, status: "none", basis: "none", reason: "returning_customer" });
  }
  if (!claimants.length) return upsertCredit({ ...base, status: "none", basis: "none", reason: "unattributed" });

  if (sale.identity === "unverified") holdReasons.push("identity_unverified");
  const distinct = [...new Set(claimants.map((c) => String(c.employee)))];
  if (distinct.length > 1) holdReasons.push("competing_claims");
  if (!assignment) holdReasons.push("referral_only");
  const employee = await User.findById(claimants[0].employee).select("isActive employeePosition role name").lean();
  if (!employee || employee.isActive === false) holdReasons.push("employee_inactive");

  if (holdReasons.length) {
    const credit = await upsertCredit({ ...base, status: "held", basis: assignment ? "assignment" : "referral", employee: null, holdReasons, reason: holdReasons.join(",") });
    const who = await namesOf(distinct);
    await openReview({
      kind: "credit_hold",
      key: `hold:${sale._id}`,
      sale: sale._id,
      credit: credit._id,
      summary: `${saleLabel(sale)} on ${sale.paidAt.toISOString().slice(0, 10)}: ${holdReasons.map(holdText).join("; ")}. Claims: ${claimants.map((c) => `${who.get(String(c.employee)) || "employee"} (${c.basis})`).join(", ")}.`,
      effects: { holdReasons, claimants: claimants.map((c) => ({ ...c, employee: String(c.employee) })) },
    });
    return credit;
  }

  const credit = await upsertCredit({ ...base, status: "credited", basis: "assignment", employee: claimants[0].employee, reason: "assigned_at_payment" });
  await creditEntry(sale, credit, { employeeId: claimants[0].employee });
  return credit;
}

async function upsertCredit(fields) {
  try {
    return (await SalesCredit.create(fields)).toObject();
  } catch (error) {
    if (error?.code === 11000) return SalesCredit.findOne({ sale: fields.sale }).lean();
    throw error;
  }
}

async function namesOf(ids) {
  const users = await User.find({ _id: { $in: ids } }).select("name").lean();
  return new Map(users.map((u) => [String(u._id), u.name || ""]));
}

const HOLD_TEXT = {
  identity_unverified: "the payment is not tied to the account by a verified Stripe relationship",
  competing_claims: "more than one employee has a claim",
  referral_only: "only a referral link, no assignment",
  employee_inactive: "the employee is no longer active",
  linked_after_sale: "the lead was linked to this account after the payment",
};
const holdText = (r) => HOLD_TEXT[r] || r;

function saleLabel(sale) {
  if (sale.kind === "full_day_paid") return "Full Day";
  if (sale.kind === "membership_change_paid") return `${label(sale.plan)} plan change`;
  return `${label(sale.plan)} ${sale.cycle || "monthly"} membership`;
}

/**
 * The owner's decision on a held credit: credit one employee, or nobody. The
 * entry is dated by the PAYMENT, so a late decision lands on the next open
 * statement as a late line, and in the bonus period of the payment.
 */
async function resolveHold(reviewId, { decision, employeeId, reason }, actor) {
  const review = await SalesReview.findById(reviewId);
  if (!review || review.kind !== "credit_hold") throw new SalesError("NOT_FOUND", "Review not found.", 404);
  if (review.status !== "open") throw new SalesError("ALREADY_RESOLVED", "This review is already resolved.", 409);
  if (!String(reason || "").trim()) throw new SalesError("REASON_REQUIRED", "Give a reason for the decision.");
  const credit = await SalesCredit.findById(review.credit);
  const sale = await SalesEvent.findById(review.sale).lean();
  if (!credit || credit.status !== "held") throw new SalesError("NOT_HELD", "This credit is no longer held.", 409);
  let entry = null;
  if (decision === "credit") {
    const allowed = credit.claimants.map((c) => String(c.employee));
    if (!allowed.includes(String(employeeId))) throw new SalesError("NOT_A_CLAIMANT", "Choose one of the employees with a claim.");
    credit.status = "credited";
    credit.basis = "owner_decision";
    credit.employee = employeeId;
  } else if (decision === "no_credit") {
    credit.status = "rejected";
    credit.basis = "owner_decision";
  } else throw new SalesError("BAD_DECISION", "Decide credit or no credit.");
  credit.decidedBy = actor._id;
  credit.decidedAt = new Date();
  credit.reason = String(reason).trim().slice(0, 500);
  await credit.save();
  if (decision === "credit") entry = await creditEntry(sale, credit.toObject(), { employeeId, createdBy: actor._id, createdByName: actor.name || "", explainPrefix: "Owner decision: " });
  review.status = "resolved";
  review.resolution = { action: decision, reason: credit.reason, by: actor._id, byName: actor.name || "", at: new Date(), adjustment: entry?._id || null };
  await review.save();
  return { review: review.toObject(), credit: credit.toObject(), entry };
}

/* ------------------------------------------------------- credit requests */

const REQUEST_KINDS = ["recovery", "upgrade", "missed_link", "other"];

/** What approving a claim on this sale would pay (the owner may change it). */
async function proposalFor(sale) {
  if (sale.kind === "membership_change_paid") {
    const rule = await ruleAt("membership_monthly", sale.paidAt);
    const amount = Math.floor((Math.max(0, sale.amounts.paidPreTaxCents) * rule.params.rateBps + 5000) / 10000);
    return {
      amountCents: amount,
      method: "upgrade_percent_of_paid_pre_tax",
      detail: `Plan change payment ${dollars(sale.amounts.paidPreTaxCents)} excluding tax; proposed 50% = ${dollars(amount)}. A plan change does not count toward the bonus unless you choose so.`,
      countsForBonusDefault: false,
    };
  }
  const { computed } = await previewCommission(sale);
  return { amountCents: computed.amountCents, method: computed.method || "", detail: computed.explain, countsForBonusDefault: isMembershipSale(sale) };
}

async function createRequest(employee, { leadId, saleId, kind, explanation, evidence = [] }) {
  if (!REQUEST_KINDS.includes(kind)) throw new SalesError("BAD_KIND", "Choose what kind of credit this is.");
  const text = String(explanation || "").trim();
  if (text.length < 10) throw new SalesError("EXPLAIN", "Explain your contribution (at least a sentence).");
  const lead = await SalesLead.findById(leadId).lean();
  const open = lead && (await LeadAssignment.findOne({ lead: lead._id, employee: employee._id, endedAt: null }).lean());
  if (!lead || !open) throw new SalesError("NOT_FOUND", "Lead not found.", 404);
  if (!lead.linkedUser) throw new SalesError("NOT_LINKED", "This lead is not linked to a customer account yet. Ask the owner to link it.", 409);
  const sale = await SalesEvent.findById(saleId).lean();
  if (!sale || String(sale.user) !== String(lead.linkedUser) || !["membership_first_paid", "membership_change_paid", "full_day_paid"].includes(sale.kind)) {
    throw new SalesError("NOT_FOUND", "That purchase is not on this customer's account.", 404);
  }
  const credit = await SalesCredit.findOne({ sale: sale._id }).lean();
  if (credit && credit.status === "credited") throw new SalesError("ALREADY_CREDITED", "This purchase already has sales credit.", 409);
  if (credit && credit.status === "held") throw new SalesError("UNDER_REVIEW", "This purchase is already waiting for the owner's decision.", 409);
  const proposed = await proposalFor(sale);
  try {
    const doc = await SalesCreditRequest.create({
      employee: employee._id,
      lead: lead._id,
      user: lead.linkedUser,
      sale: sale._id,
      kind,
      explanation: text.slice(0, 3000),
      evidence,
      proposed,
      decisions: [{ action: "submitted", by: employee._id, byName: employee.name || "", reason: "" }],
    });
    return doc.toObject();
  } catch (error) {
    if (error?.code === 11000) throw new SalesError("ALREADY_REQUESTED", "Someone has already asked for credit on this purchase.", 409);
    throw error;
  }
}

async function decideRequest(requestId, { action, reason, amountCents, countsForBonus }, actor) {
  const req = await SalesCreditRequest.findById(requestId);
  if (!req) throw new SalesError("NOT_FOUND", "Request not found.", 404);
  if (!["pending", "needs_info"].includes(req.status)) throw new SalesError("ALREADY_DECIDED", "This request is already decided.", 409);
  const why = String(reason || "").trim();
  if (!why) throw new SalesError("REASON_REQUIRED", "Give a reason.");
  if (action === "needs_info" || action === "rejected") {
    req.status = action;
    req.decisions.push({ action, by: actor._id, byName: actor.name || "", reason: why.slice(0, 1000) });
    await req.save();
    return { request: req.toObject(), entry: null };
  }
  if (action !== "approved") throw new SalesError("BAD_ACTION", "Approve, reject or ask for more information.");
  const sale = await SalesEvent.findById(req.sale).lean();
  const amount = amountCents === undefined || amountCents === null || amountCents === "" ? req.proposed.amountCents : Number(amountCents);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 1000000) throw new SalesError("BAD_AMOUNT", "The commission must be a positive amount in cents.");
  if (sale.kind === "membership_change_paid" && typeof countsForBonus !== "boolean") {
    throw new SalesError("BONUS_CHOICE_REQUIRED", "For a plan change, say whether it counts toward the 20-membership bonus.");
  }
  const counts = typeof countsForBonus === "boolean" ? countsForBonus : req.proposed.countsForBonusDefault;
  let credit = await SalesCredit.findOne({ sale: sale._id });
  if (credit && credit.status === "credited") throw new SalesError("ALREADY_CREDITED", "This purchase already has sales credit.", 409);
  if (!credit) credit = new SalesCredit({ sale: sale._id, user: sale.user, lead: req.lead, status: "none", basis: "none" });
  credit.status = "credited";
  credit.basis = "credit_request";
  credit.employee = req.employee;
  credit.request = req._id;
  credit.countsForBonus = counts;
  credit.decidedBy = actor._id;
  credit.decidedAt = new Date();
  credit.reason = why.slice(0, 500);
  await credit.save();
  const entry = await creditEntry(sale, credit.toObject(), {
    employeeId: req.employee,
    createdBy: actor._id,
    createdByName: actor.name || "",
    amountCents: amount === req.proposed.amountCents && sale.kind !== "membership_change_paid" ? null : amount,
    countsForBonus: counts,
    explainPrefix: `Approved credit request (${req.kind}): `,
  });
  req.status = "approved";
  req.decisions.push({ action: "approved", by: actor._id, byName: actor.name || "", reason: why.slice(0, 1000), amountCents: amount, countsForBonus: counts });
  await req.save();
  return { request: req.toObject(), entry };
}

/* ------------------------------------------------- refunds and disputes */

/** What a refund or dispute touches, for the owner to see. Nothing is deducted. */
async function effectsOf(sale) {
  if (!sale) return { found: false };
  const entries = await CommissionEntry.find({ sale: sale._id }).lean();
  const bonuses = entries.length ? await CommissionEntry.find({ kind: "bonus", "bonus.countedEntries": { $in: entries.map((e) => e._id) } }).lean() : [];
  return {
    found: true,
    sale: { id: String(sale._id), kind: sale.kind, plan: sale.plan, cycle: sale.cycle, paidAt: sale.paidAt, paidPreTaxCents: sale.amounts.paidPreTaxCents },
    commissions: entries.map((e) => ({ id: String(e._id), employee: String(e.employee), amountCents: e.amountCents, status: e.status, statementWeek: e.statementWeek })),
    bonuses: bonuses.map((b) => ({ id: String(b._id), employee: String(b.employee), amountCents: b.amountCents, status: b.status, periodIndex: b.bonus?.periodIndex })),
    note: "Nothing is deducted automatically. Previously earned commission and bonuses stay as they are unless you record an adjustment.",
  };
}

async function saleForCharge({ chargeId, paymentIntentId, invoiceId }) {
  const or = [];
  if (chargeId) or.push({ "stripe.chargeId": chargeId });
  if (paymentIntentId) or.push({ "stripe.paymentIntentId": paymentIntentId });
  if (invoiceId) or.push({ "stripe.invoiceId": invoiceId });
  if (!or.length) return null;
  return SalesEvent.findOne({ kind: { $in: ["membership_first_paid", "full_day_paid", "membership_change_paid"] }, $or: or }).lean();
}

async function recordRefund(charge) {
  if (!charge?.id) return [];
  const sale = await saleForCharge({ chargeId: charge.id, paymentIntentId: charge.payment_intent ? String(charge.payment_intent?.id || charge.payment_intent) : null, invoiceId: charge.invoice ? String(charge.invoice?.id || charge.invoice) : null });
  if (!sale) return [];
  const refunds = Array.isArray(charge.refunds?.data) && charge.refunds.data.length ? charge.refunds.data : [{ id: `${charge.id}:${charge.amount_refunded}`, amount: charge.amount_refunded, created: charge.created }];
  const out = [];
  for (const r of refunds) {
    if (!r?.id || !(r.amount > 0)) continue;
    const { sale: ev, created } = await recordSale({
      sourceKey: `refund:${r.id}`,
      kind: "refund",
      user: sale.user,
      identity: sale.identity,
      plan: sale.plan,
      cycle: sale.cycle,
      stripe: { chargeId: charge.id, refundId: r.id, paymentIntentId: sale.stripe.paymentIntentId, invoiceId: sale.stripe.invoiceId, subscriptionId: sale.stripe.subscriptionId },
      amounts: { amountCents: r.amount },
      relatesTo: sale._id,
      paidAt: new Date((r.created || charge.created || Date.now() / 1000) * 1000),
      paidAtSource: "stripe_refund",
    });
    if (created) {
      const effects = await effectsOf(sale);
      await openReview({ kind: "refund", key: `refund:${r.id}`, sale: sale._id, event: ev._id, summary: `${dollars(r.amount)} refunded on a ${saleLabel(sale)} paid ${sale.paidAt.toISOString().slice(0, 10)}.`, effects });
    }
    out.push(ev);
  }
  return out;
}

async function recordDispute(dispute, phase) {
  if (!dispute?.id) return null;
  const sale = await saleForCharge({ chargeId: dispute.charge ? String(dispute.charge?.id || dispute.charge) : null, paymentIntentId: dispute.payment_intent ? String(dispute.payment_intent?.id || dispute.payment_intent) : null });
  if (!sale) return null;
  const kind = phase === "closed" ? "dispute_closed" : "dispute_opened";
  const { sale: ev, created } = await recordSale({
    sourceKey: `${kind}:${dispute.id}`,
    kind,
    user: sale.user,
    identity: sale.identity,
    plan: sale.plan,
    cycle: sale.cycle,
    stripe: { chargeId: sale.stripe.chargeId, disputeId: dispute.id, paymentIntentId: sale.stripe.paymentIntentId, invoiceId: sale.stripe.invoiceId, subscriptionId: sale.stripe.subscriptionId },
    amounts: { amountCents: dispute.amount || 0 },
    disputeStatus: dispute.status || null,
    relatesTo: sale._id,
    paidAt: new Date((dispute.created || Date.now() / 1000) * 1000),
    paidAtSource: "stripe_dispute",
  });
  if (created) {
    const effects = await effectsOf(sale);
    await openReview({
      kind: "dispute",
      key: `${kind}:${dispute.id}`,
      sale: sale._id,
      event: ev._id,
      summary: phase === "closed"
        ? `Chargeback on a ${saleLabel(sale)} closed: ${dispute.status || "unknown outcome"}.`
        : `Chargeback opened on a ${saleLabel(sale)} (${dollars(dispute.amount || 0)}).`,
      effects,
    });
  }
  return ev;
}

/**
 * The owner's decision on a refund or dispute review: leave earnings as they
 * are, or record an explicit adjustment (on the next open statement). This is
 * the only way a refund ever changes what someone earned.
 */
async function resolveMoneyReview(reviewId, { action, amountCents, employeeId, reason }, actor) {
  const review = await SalesReview.findById(reviewId);
  if (!review || !["refund", "dispute"].includes(review.kind)) throw new SalesError("NOT_FOUND", "Review not found.", 404);
  if (review.status !== "open") throw new SalesError("ALREADY_RESOLVED", "This review is already resolved.", 409);
  const why = String(reason || "").trim();
  if (!why) throw new SalesError("REASON_REQUIRED", "Give a reason for the decision.");
  let entry = null;
  if (action === "adjust") {
    const amount = Number(amountCents);
    if (!Number.isInteger(amount) || amount === 0) throw new SalesError("BAD_AMOUNT", "Enter the adjustment in whole cents (negative to reduce).");
    if (!employeeId) throw new SalesError("EMPLOYEE_REQUIRED", "Choose whose statement the adjustment goes on.");
    ({ entry } = await addEntry({
      sourceKey: `adjust:review:${review._id}`,
      employee: employeeId,
      kind: "adjustment",
      product: "adjustment",
      amountCents: amount,
      sale: review.sale,
      review: review._id,
      reason: why.slice(0, 500),
      calc: { method: "owner_adjustment", explain: `Owner adjustment after ${review.kind}: ${why.slice(0, 200)}` },
      earnedAt: new Date(),
      createdBy: actor._id,
      createdByName: actor.name || "",
    }));
  } else if (action !== "no_change") throw new SalesError("BAD_ACTION", "Choose no change or an adjustment.");
  review.status = "resolved";
  review.resolution = { action, reason: why.slice(0, 500), by: actor._id, byName: actor.name || "", at: new Date(), adjustment: entry?._id || null };
  await review.save();
  return { review: review.toObject(), entry };
}

/** A manual adjustment by the owner (correction, goodwill): always explicit, never silent. */
async function createAdjustment({ employeeId, amountCents, reason, idempotencyKey, relatedEntry = null }, actor) {
  const amount = Number(amountCents);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000000) throw new SalesError("BAD_AMOUNT", "Enter the adjustment in whole cents (negative to reduce).");
  const why = String(reason || "").trim();
  if (why.length < 3) throw new SalesError("REASON_REQUIRED", "Give a reason.");
  const key = String(idempotencyKey || "").trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new SalesError("KEY_REQUIRED", "Missing request key.");
  const employee = await User.findById(employeeId).select("role employeePosition").lean();
  if (!employee || employee.employeePosition !== "Telemarketer") throw new SalesError("NOT_FOUND", "Employee not found.", 404);
  const { entry, created } = await addEntry({
    sourceKey: `adjust:manual:${key}`,
    employee: employeeId,
    kind: "adjustment",
    product: "adjustment",
    amountCents: amount,
    related: relatedEntry,
    reason: why.slice(0, 500),
    calc: { method: "owner_adjustment", explain: `Owner adjustment: ${why.slice(0, 200)}` },
    earnedAt: new Date(),
    createdBy: actor._id,
    createdByName: actor.name || "",
  });
  return { entry, created };
}

/** After the owner links a lead to an account: earlier unattributed sales inside its assignment go to review, never straight to credit. */
async function reviewSalesAfterLink(lead) {
  const sales = await SalesEvent.find({ user: lead.linkedUser, kind: { $in: ["membership_first_paid", "full_day_paid"] } }).lean();
  for (const sale of sales) {
    const credit = await SalesCredit.findOne({ sale: sale._id });
    if (!credit || credit.status !== "none" || credit.reason !== "unattributed") continue;
    const a = await assignmentAt(lead._id, sale.paidAt);
    if (!a) continue;
    credit.status = "held";
    credit.basis = "assignment";
    credit.lead = lead._id;
    credit.claimants = [{ employee: a.creditEmployee, basis: "assignment", detail: "assigned at the time of payment; linked later" }];
    credit.holdReasons = ["linked_after_sale"];
    credit.reason = "linked_after_sale";
    await credit.save();
    await openReview({ kind: "credit_hold", key: `hold:${sale._id}`, sale: sale._id, credit: credit._id, summary: `${saleLabel(sale)} paid ${sale.paidAt.toISOString().slice(0, 10)}: ${holdText("linked_after_sale")}.`, effects: { holdReasons: ["linked_after_sale"] } });
  }
}

module.exports = {
  recordSale,
  creditForSale,
  previewCommission,
  resolveHold,
  proposalFor,
  createRequest,
  decideRequest,
  recordRefund,
  recordDispute,
  resolveMoneyReview,
  createAdjustment,
  reviewSalesAfterLink,
  effectsOf,
  saleLabel,
  holdText,
  REQUEST_KINDS,
};
