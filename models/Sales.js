/**
 * Telemarketer sales desk: leads, assignments, activity, tasks, verified sales,
 * sales credit, the commission ledger, bonus periods and Friday payouts.
 *
 * Design (reports/TELEMARKETER-AUDIT.md and reports/TELEMARKETER-CRM.md):
 * - Money facts come from Stripe events only (SalesEvent). An employee can
 *   never mark something "sold".
 * - Four questions are kept in four places:
 *     original source ........ SalesLead.source / sourcedBy (never changes)
 *     current assignee ........ LeadAssignment (open row, one per lead)
 *     sales-credit owner ...... LeadAssignment.creditEmployee (chosen by the
 *                               manager at reassignment) and, per sale, SalesCredit
 *     follow-up owner ......... SalesTask.assignee
 * - The ledger (CommissionEntry) holds APPROVED money only. Pending claims are
 *   SalesCredit (status held) and SalesCreditRequest (pending); they are shown
 *   separately and never summed into earnings.
 * - Amounts are integer cents. Ledger entries, activities and decisions are
 *   append-only: their money and facts can never be updated or deleted.
 */
const mongoose = require("mongoose");

const { Schema } = mongoose;
const Id = Schema.Types.ObjectId;

const UPDATE_OPS = ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"];
const DELETE_OPS = ["deleteOne", "deleteMany", "findOneAndDelete"];

/** Refuse every update and delete, and any save of an existing document. */
function appendOnly(schema, name) {
  const refuse = () => {
    throw new Error(`${name} is append-only: record a new entry instead of changing one`);
  };
  for (const op of [...UPDATE_OPS, ...DELETE_OPS]) schema.pre(op, refuse);
  schema.pre("save", function onlyNew(next) {
    if (!this.isNew) return next(new Error(`${name} is append-only: record a new entry instead of changing one`));
    return next();
  });
}

/**
 * Refuse deletes, and refuse any update that touches a frozen field. Updates
 * may only move the listed fields (status, placement) forward.
 */
function frozenFields(schema, name, allowed) {
  for (const op of DELETE_OPS) {
    schema.pre(op, () => {
      throw new Error(`${name} cannot be deleted`);
    });
  }
  const check = function check() {
    const update = this.getUpdate() || {};
    const touched = new Set();
    for (const [k, v] of Object.entries(update)) {
      if (k === "$setOnInsert") continue; // only applies when inserting (timestamps add createdAt here)
      if (k.startsWith("$")) for (const f of Object.keys(v || {})) touched.add(f.split(".")[0]);
      else touched.add(k.split(".")[0]);
    }
    for (const f of touched) {
      if (!allowed.includes(f)) throw new Error(`${name}.${f} is frozen once written`);
    }
  };
  for (const op of UPDATE_OPS) schema.pre(op, check);
  schema.pre("save", function savedOnlyAllowed(next) {
    if (this.isNew) return next();
    const bad = this.modifiedPaths().filter((p) => !allowed.includes(p.split(".")[0]));
    if (bad.length) return next(new Error(`${name}.${bad[0]} is frozen once written`));
    return next();
  });
}

/* ------------------------------------------------------------------ leads */

const SalesLeadSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /* E.164; the duplicate key. A lead is a person to call, so one lead per phone. */
    phone: { type: String, required: true },
    email: { type: String, default: null, lowercase: true, trim: true },
    town: { type: String, default: "", maxlength: 80 },
    zip: { type: String, default: "", maxlength: 10 },
    /* Original source: never changes after creation. */
    source: { type: String, enum: ["owner", "employee_intake", "existing_customer", "web_request", "referral_signup"], required: true },
    sourcedBy: { type: Id, ref: "User", default: null },
    createdBy: { type: Id, ref: "User", required: true },
    sourceNote: { type: String, default: "", maxlength: 1000 },
    requestId: { type: Id, ref: "Request", default: null },
    /*
     * intake: added by an employee, waiting for the owner (no one may work it yet)
     * active: workable
     * rejected: intake refused (kept for the record and the duplicate check history)
     * archived: closed by the owner
     */
    status: { type: String, enum: ["intake", "active", "rejected", "archived"], default: "active", index: true },
    intakeDecision: {
      by: { type: Id, ref: "User", default: null },
      byName: { type: String, default: "" },
      at: { type: Date, default: null },
      reason: { type: String, default: "" },
    },
    /* The stages Profixter cannot see on its own. Everything from "registered" on is derived from records. */
    stage: { type: String, enum: ["new", "contacted", "interested", "not_interested", "lost"], default: "new" },
    /*
     * The customer account this lead is. Set only by a VERIFIED link: the owner
     * choosing the account, the account being created through this employee's
     * referral link, or the lead being created from the account. A phone match
     * is only ever a suggestion for the owner; it never links (and so never pays).
     */
    linkedUser: { type: Id, ref: "User", default: null },
    link: {
      method: { type: String, enum: ["owner", "referral_signup", "from_account", null], default: null },
      by: { type: Id, ref: "User", default: null },
      at: { type: Date, default: null },
      reason: { type: String, default: "" },
    },
    /* GoHighLevel contact id: the stable mapping, set by the employee or the owner. */
    ghlContactId: { type: String, default: null, trim: true },
    ghlConversationId: { type: String, default: null, trim: true },
    /* Self-referral check on an employee-added lead (its phone or email is the employee's own). A flag for the owner, never a refusal. */
    intakeFlags: { type: [String], default: [] },
    lastActivityAt: { type: Date, default: null },
  },
  { timestamps: true }
);
// One live lead per phone and per account; rejected and archived leads do not block a new one.
SalesLeadSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { status: { $in: ["intake", "active"] } } });
SalesLeadSchema.index({ linkedUser: 1 }, { unique: true, partialFilterExpression: { linkedUser: { $type: "objectId" }, status: { $in: ["intake", "active"] } } });
SalesLeadSchema.index({ ghlContactId: 1 }, { unique: true, partialFilterExpression: { ghlContactId: { $type: "string" }, status: { $in: ["intake", "active"] } } });
SalesLeadSchema.index({ status: 1, createdAt: -1 });
SalesLeadSchema.index({ sourcedBy: 1, createdAt: -1 });

/**
 * Who works a lead, and who holds its sales credit. Exactly one open row per
 * lead (endedAt null). A reassignment closes the row and opens a new one; the
 * manager must say who keeps credit (creditEmployee) and why.
 */
const LeadAssignmentSchema = new Schema(
  {
    lead: { type: Id, ref: "SalesLead", required: true },
    employee: { type: Id, ref: "User", required: true },
    /* Whoever receives credit for sales on this lead while this row is open. Usually `employee`. */
    creditEmployee: { type: Id, ref: "User", required: true },
    creditDecision: { type: String, enum: ["first_assignment", "new_assignee", "keep_previous"], required: true },
    startedAt: { type: Date, required: true, default: Date.now },
    startedBy: { type: Id, ref: "User", required: true },
    startedByName: { type: String, default: "" },
    reason: { type: String, default: "", maxlength: 500 },
    endedAt: { type: Date, default: null },
    endedBy: { type: Id, ref: "User", default: null },
    endReason: { type: String, default: "" },
  },
  { timestamps: true }
);
LeadAssignmentSchema.index({ lead: 1 }, { unique: true, partialFilterExpression: { endedAt: null } });
LeadAssignmentSchema.index({ employee: 1, endedAt: 1 });
LeadAssignmentSchema.index({ lead: 1, startedAt: 1 });
frozenFields(LeadAssignmentSchema, "LeadAssignment", ["endedAt", "endedBy", "endReason", "updatedAt"]);

/**
 * What happened with a lead, as entered by a person or received from GHL.
 * Append-only. A correction is a new row (kind "correction") pointing at the old one.
 */
const SalesActivitySchema = new Schema(
  {
    lead: { type: Id, ref: "SalesLead", required: true },
    actor: { type: Id, ref: "User", default: null },
    actorName: { type: String, default: "" },
    actorRole: { type: String, enum: ["telemarketer", "owner", "system", "ghl"], required: true },
    kind: {
      type: String,
      enum: [
        "attempt", "voicemail", "reached_interested", "reached_not_interested", "call_back", "wrong_number",
        "do_not_contact", "note", "coaching", "correction", "assigned", "reassigned", "linked", "intake_approved",
        "ghl_call", "ghl_sms", "ghl_dnd",
      ],
      required: true,
    },
    body: { type: String, default: "", maxlength: 2000 },
    /* Owner coaching notes are never shown to the employee unless shared. */
    visibility: { type: String, enum: ["team", "owner"], default: "team" },
    source: { type: String, enum: ["manual", "ghl", "system"], default: "manual" },
    corrects: { type: Id, ref: "SalesActivity", default: null },
    /* GHL metadata only: never message text or recordings. */
    ghl: {
      eventId: { type: String, default: null },
      direction: { type: String, default: null },
      channel: { type: String, default: null },
      status: { type: String, default: null },
      durationSec: { type: Number, default: null },
      conversationId: { type: String, default: null },
      messageId: { type: String, default: null },
    },
    at: { type: Date, required: true, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
SalesActivitySchema.index({ lead: 1, at: -1 });
SalesActivitySchema.index({ actor: 1, at: -1 });
SalesActivitySchema.index({ "ghl.eventId": 1 }, { unique: true, partialFilterExpression: { "ghl.eventId": { $type: "string" } } });
appendOnly(SalesActivitySchema, "SalesActivity");

const SalesTaskSchema = new Schema(
  {
    lead: { type: Id, ref: "SalesLead", required: true },
    assignee: { type: Id, ref: "User", required: true },
    createdBy: { type: Id, ref: "User", required: true },
    kind: { type: String, enum: ["call", "text", "check_booking", "other"], default: "call" },
    note: { type: String, default: "", maxlength: 500 },
    dueAt: { type: Date, required: true },
    status: { type: String, enum: ["open", "done", "canceled"], default: "open" },
    doneAt: { type: Date, default: null },
  },
  { timestamps: true }
);
SalesTaskSchema.index({ assignee: 1, status: 1, dueAt: 1 });
SalesTaskSchema.index({ lead: 1, status: 1 });

/**
 * Do-not-contact, per phone and channel. Append-only events; the current state
 * is the latest event per (phone, channel). The most restrictive state wins:
 * an employee or GHL can add a restriction; only the owner can lift one, with a reason.
 */
const ContactSuppressionSchema = new Schema(
  {
    phone: { type: String, required: true },
    channel: { type: String, enum: ["call", "sms", "all"], required: true },
    action: { type: String, enum: ["suppress", "lift"], required: true },
    source: { type: String, enum: ["telemarketer", "owner", "ghl", "customer"], required: true },
    reason: { type: String, default: "", maxlength: 500 },
    by: { type: Id, ref: "User", default: null },
    byName: { type: String, default: "" },
    lead: { type: Id, ref: "SalesLead", default: null },
    ghlEventId: { type: String, default: null },
    at: { type: Date, required: true, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
ContactSuppressionSchema.index({ phone: 1, channel: 1, at: -1 });
appendOnly(ContactSuppressionSchema, "ContactSuppression");

/* An employee's personal referral code (a link the customer may use; evidence, not proof). */
const SalesReferralCodeSchema = new Schema(
  {
    employee: { type: Id, ref: "User", required: true },
    code: { type: String, required: true },
    active: { type: Boolean, default: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
SalesReferralCodeSchema.index({ code: 1 }, { unique: true });
SalesReferralCodeSchema.index({ employee: 1, active: 1 });

/* An account created through an employee's referral link (written once, at signup). */
const SalesReferralSchema = new Schema(
  {
    user: { type: Id, ref: "User", required: true },
    employee: { type: Id, ref: "User", required: true },
    code: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
SalesReferralSchema.index({ user: 1 }, { unique: true });
appendOnly(SalesReferralSchema, "SalesReferral");

/* ----------------------------------------------------------- money facts */

/**
 * A verified money fact from Stripe, written once (sourceKey is unique, so a
 * duplicate or replayed webhook can never write it twice). `paidAt` is
 * Stripe's own payment time, never the webhook's arrival time.
 */
const SalesEventSchema = new Schema(
  {
    sourceKey: { type: String, required: true },
    kind: {
      type: String,
      /* membership_change_paid: a paid plan change (upgrade). Never credited automatically; claimable by request. */
      enum: ["membership_first_paid", "membership_change_paid", "full_day_paid", "refund", "dispute_opened", "dispute_closed"],
      required: true,
    },
    user: { type: Id, ref: "User", default: null },
    /* How the account was tied to the payment. Only stripe_customer and checkout_account are verified. */
    identity: { type: String, enum: ["stripe_customer", "checkout_account", "unverified"], required: true },
    plan: { type: String, default: null },
    cycle: { type: String, enum: ["monthly", "annual", null], default: null },
    stripe: {
      customerId: { type: String, default: null },
      subscriptionId: { type: String, default: null },
      invoiceId: { type: String, default: null },
      chargeId: { type: String, default: null },
      paymentIntentId: { type: String, default: null },
      checkoutSessionId: { type: String, default: null },
      refundId: { type: String, default: null },
      disputeId: { type: String, default: null },
      priceId: { type: String, default: null },
      billingReason: { type: String, default: null },
      /* Stripe's card fingerprint (a hash, not card data): only for the self-referral check, never sent to a browser. */
      cardFingerprint: { type: String, default: null },
    },
    /* For a sale: the regular price, the discount and the payment excluding tax. For a refund/dispute: its amount. */
    amounts: {
      regularCents: { type: Number, default: 0 },
      /* The plan's regular MONTHLY price at the time of sale (the annual commission), snapshotted. */
      regularMonthlyCents: { type: Number, default: null },
      discountCents: { type: Number, default: 0 },
      paidPreTaxCents: { type: Number, default: 0 },
      taxCents: { type: Number, default: 0 },
      amountCents: { type: Number, default: 0 },
    },
    discount: {
      source: { type: String, default: "" },
      code: { type: String, default: "" },
      couponId: { type: String, default: "" },
    },
    /* Paid sales: was this account a paying member before? (then it is a recovery, not automatic). */
    returningCustomer: { type: Boolean, default: false },
    /* For refunds and disputes: the sale it touches. */
    relatesTo: { type: Id, ref: "SalesEvent", default: null },
    disputeStatus: { type: String, default: null },
    booking: { type: Id, ref: "Booking", default: null },
    entitlement: { type: Id, ref: "VisitEntitlement", default: null },
    subscription: { type: Id, ref: "Subscription", default: null },
    paidAt: { type: Date, required: true },
    paidAtSource: { type: String, enum: ["stripe_invoice", "stripe_charge", "stripe_refund", "stripe_dispute", "event_created"], required: true },
    seller: { type: Id, ref: "User", default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
SalesEventSchema.index({ sourceKey: 1 }, { unique: true });
SalesEventSchema.index({ user: 1, paidAt: -1 });
SalesEventSchema.index({ "stripe.chargeId": 1 });
SalesEventSchema.index({ "stripe.paymentIntentId": 1 });
SalesEventSchema.index({ "stripe.invoiceId": 1 });
SalesEventSchema.index({ "stripe.cardFingerprint": 1 }, { partialFilterExpression: { "stripe.cardFingerprint": { $type: "string" } } });
// A Stripe subscription can produce exactly one first-paid sale.
SalesEventSchema.index(
  { "stripe.subscriptionId": 1 },
  { unique: true, partialFilterExpression: { kind: "membership_first_paid", "stripe.subscriptionId": { $type: "string" } } }
);
appendOnly(SalesEventSchema, "SalesEvent");

/**
 * Who gets credit for one sale. One row per sale (unique), so a purchase can
 * never be credited twice, from any path.
 *   credited  approved: a ledger entry exists
 *   held      waiting for the owner (conflict, unverified identity, referral only)
 *   none      nobody: unattributed, or a returning customer (use Request sales credit)
 *   rejected  the owner decided no credit
 */
const SalesCreditSchema = new Schema(
  {
    sale: { type: Id, ref: "SalesEvent", required: true },
    user: { type: Id, ref: "User", default: null },
    lead: { type: Id, ref: "SalesLead", default: null },
    employee: { type: Id, ref: "User", default: null },
    status: { type: String, enum: ["credited", "held", "none", "rejected"], required: true },
    basis: {
      type: String,
      enum: ["assignment", "credit_request", "owner_decision", "referral", "none"],
      required: true,
    },
    reason: { type: String, default: "" },
    holdReasons: { type: [String], default: [] },
    claimants: { type: [{ employee: { type: Id, ref: "User" }, basis: String, detail: String }], default: [] },
    countsForBonus: { type: Boolean, default: false },
    ownerAssisted: { type: Boolean, default: false },
    decidedBy: { type: Id, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
    request: { type: Id, ref: "SalesCreditRequest", default: null },
  },
  { timestamps: true }
);
SalesCreditSchema.index({ sale: 1 }, { unique: true });
SalesCreditSchema.index({ employee: 1, status: 1 });
SalesCreditSchema.index({ status: 1, createdAt: -1 });

/**
 * "Request sales credit": an employee's claim on a purchase the rules do not
 * credit automatically (a returning customer, an upgrade, a missed link).
 * Decisions are appended; the row's status follows the latest decision.
 */
const SalesCreditRequestSchema = new Schema(
  {
    employee: { type: Id, ref: "User", required: true },
    lead: { type: Id, ref: "SalesLead", default: null },
    user: { type: Id, ref: "User", required: true },
    sale: { type: Id, ref: "SalesEvent", required: true },
    kind: { type: String, enum: ["recovery", "upgrade", "missed_link", "other"], required: true },
    explanation: { type: String, required: true, maxlength: 3000 },
    evidence: {
      type: [
        {
          kind: { type: String, enum: ["ghl_reference", "note", "file"], required: true },
          text: { type: String, default: "", maxlength: 1000 },
          fileKey: { type: String, default: null },
          fileName: { type: String, default: "" },
          mime: { type: String, default: "" },
          size: { type: Number, default: 0 },
          addedAt: { type: Date, default: Date.now },
          addedBy: { type: Id, ref: "User" },
        },
      ],
      default: [],
    },
    /* What approval would pay, computed by the server from the sale (never typed by the employee). */
    proposed: {
      amountCents: { type: Number, default: 0 },
      method: { type: String, default: "" },
      detail: { type: String, default: "" },
      countsForBonusDefault: { type: Boolean, default: false },
    },
    /* Self-referral signals found by the server (utils/sales/selfReferral.js). A flag for the owner, never a refusal. */
    checks: {
      selfReferral: { type: [{ code: String, strength: String, text: String }], default: [] },
      checkedAt: { type: Date, default: null },
    },
    status: { type: String, enum: ["pending", "needs_info", "approved", "rejected", "withdrawn"], default: "pending" },
    decisions: {
      type: [
        {
          action: { type: String, enum: ["submitted", "needs_info", "employee_reply", "approved", "rejected", "withdrawn"] },
          by: { type: Id, ref: "User" },
          byName: String,
          reason: { type: String, default: "" },
          amountCents: { type: Number, default: null },
          countsForBonus: { type: Boolean, default: null },
          /* On approval of a flagged request: the owner confirmed they checked the self-referral signals. */
          selfReferralCleared: { type: Boolean, default: null },
          at: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);
// One live request per purchase, across all employees.
SalesCreditRequestSchema.index({ sale: 1 }, { unique: true, partialFilterExpression: { status: { $in: ["pending", "needs_info", "approved"] } } });
SalesCreditRequestSchema.index({ employee: 1, createdAt: -1 });
SalesCreditRequestSchema.index({ status: 1, createdAt: -1 });

/**
 * Something the owner must look at: competing claims, unverified identity,
 * referral-only credit, refunds, disputes. Resolutions are appended.
 */
const SalesReviewSchema = new Schema(
  {
    kind: { type: String, enum: ["credit_hold", "refund", "dispute"], required: true },
    key: { type: String, required: true },
    sale: { type: Id, ref: "SalesEvent", default: null },
    event: { type: Id, ref: "SalesEvent", default: null },
    credit: { type: Id, ref: "SalesCredit", default: null },
    employee: { type: Id, ref: "User", default: null },
    summary: { type: String, default: "" },
    effects: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ["open", "resolved"], default: "open" },
    resolution: {
      action: { type: String, default: null },
      reason: { type: String, default: "" },
      by: { type: Id, ref: "User", default: null },
      byName: { type: String, default: "" },
      at: { type: Date, default: null },
      adjustment: { type: Id, ref: "CommissionEntry", default: null },
    },
  },
  { timestamps: true }
);
SalesReviewSchema.index({ key: 1 }, { unique: true });
SalesReviewSchema.index({ status: 1, createdAt: -1 });

/* --------------------------------------------------------------- ledger */

/** Versioned commission rules. A rule is never edited once used; a change is a new version. */
const CommissionRuleSchema = new Schema(
  {
    key: { type: String, enum: ["membership_monthly", "membership_annual", "full_day", "bonus_volume"], required: true },
    version: { type: Number, required: true },
    params: { type: Schema.Types.Mixed, required: true },
    effectiveFrom: { type: Date, required: true },
    note: { type: String, default: "" },
    createdBy: { type: Id, ref: "User", default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
CommissionRuleSchema.index({ key: 1, version: 1 }, { unique: true });
appendOnly(CommissionRuleSchema, "CommissionRule");

/**
 * The ledger: approved earnings only. Money, kind, calculation and the week it
 * was earned are frozen at insert. Only its placement (statementWeek, while
 * still open) and its payout state move.
 *
 * earnedWeek     the Friday–Thursday week of the payment (or of the decision, for adjustments)
 * statementWeek  the statement it is paid on: the earned week if still open,
 *                otherwise the next open one (late = true, shown as an adjustment line)
 */
const CommissionEntrySchema = new Schema(
  {
    sourceKey: { type: String, required: true },
    employee: { type: Id, ref: "User", required: true },
    kind: { type: String, enum: ["commission", "bonus", "adjustment"], required: true },
    amountCents: { type: Number, required: true, validate: Number.isInteger },
    product: { type: String, enum: ["membership_monthly", "membership_annual", "full_day", "bonus", "adjustment"], required: true },
    sale: { type: Id, ref: "SalesEvent", default: null },
    credit: { type: Id, ref: "SalesCredit", default: null },
    user: { type: Id, ref: "User", default: null },
    countsForBonus: { type: Boolean, default: false },
    calc: {
      regularCents: { type: Number, default: 0 },
      discountCents: { type: Number, default: 0 },
      discountSource: { type: String, default: "" },
      paidPreTaxCents: { type: Number, default: 0 },
      taxCents: { type: Number, default: 0 },
      method: { type: String, default: "" },
      explain: { type: String, default: "" },
      rule: { key: String, version: Number, params: Schema.Types.Mixed },
    },
    bonus: {
      period: { type: Id, ref: "BonusPeriod", default: null },
      periodIndex: { type: Number, default: null },
      block: { type: Number, default: null },
      countedEntries: { type: [Id], default: [] },
    },
    related: { type: Id, ref: "CommissionEntry", default: null },
    review: { type: Id, ref: "SalesReview", default: null },
    reason: { type: String, default: "" },
    paidAt: { type: Date, default: null },
    earnedAt: { type: Date, required: true },
    earnedWeek: { type: String, required: true },
    statementWeek: { type: String, required: true },
    late: { type: Boolean, default: false },
    status: { type: String, enum: ["open", "approved", "paid"], default: "open" },
    batch: { type: Id, ref: "PayoutBatch", default: null },
    createdBy: { type: Id, ref: "User", default: null },
    createdByName: { type: String, default: "" },
  },
  { timestamps: true }
);
CommissionEntrySchema.index({ sourceKey: 1 }, { unique: true });
CommissionEntrySchema.index({ employee: 1, statementWeek: 1 });
CommissionEntrySchema.index({ statementWeek: 1, status: 1 });
CommissionEntrySchema.index({ employee: 1, kind: 1, earnedAt: 1 });
frozenFields(CommissionEntrySchema, "CommissionEntry", ["statementWeek", "late", "status", "batch", "updatedAt"]);

/**
 * One month-long bonus period of one employee. Period 0 starts on the New York
 * date of the employee's first verified qualifying membership sale; every
 * later period starts on the calendar-month anniversary of that ORIGINAL date
 * (a 31st becomes the last day of a shorter month), back to back, end-exclusive.
 */
const BonusPeriodSchema = new Schema(
  {
    employee: { type: Id, ref: "User", required: true },
    index: { type: Number, required: true },
    anchorDate: { type: String, required: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    rule: { key: String, version: Number, params: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
BonusPeriodSchema.index({ employee: 1, index: 1 }, { unique: true });
appendOnly(BonusPeriodSchema, "BonusPeriod");

/**
 * One Friday payday (covering the Friday–Thursday week before it).
 *   open      entries still accrue to it
 *   approved  the owner froze it; lines and totals never change again
 * Each line's payment is recorded by hand (no transfers are made from Profixter).
 */
const PayoutBatchSchema = new Schema(
  {
    week: { type: String, required: true },
    weekStartsAt: { type: Date, required: true },
    weekEndsAt: { type: Date, required: true },
    payday: { type: String, required: true },
    status: { type: String, enum: ["open", "approved"], default: "open" },
    writes: { type: Number, default: 0 },
    approvedBy: { type: Id, ref: "User", default: null },
    approvedByName: { type: String, default: "" },
    approvedAt: { type: Date, default: null },
    lines: {
      type: [
        {
          employee: { type: Id, ref: "User" },
          employeeName: String,
          commissionCents: Number,
          bonusCents: Number,
          adjustmentCents: Number,
          totalCents: Number,
          entries: [{ type: Id, ref: "CommissionEntry" }],
          payment: {
            status: { type: String, enum: ["unpaid", "paid"], default: "unpaid" },
            paidOn: { type: String, default: null },
            method: { type: String, default: "" },
            reference: { type: String, default: "" },
            recordedBy: { type: Id, ref: "User", default: null },
            recordedByName: { type: String, default: "" },
            recordedAt: { type: Date, default: null },
          },
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);
PayoutBatchSchema.index({ week: 1 }, { unique: true });
PayoutBatchSchema.pre(DELETE_OPS, () => {
  throw new Error("PayoutBatch cannot be deleted");
});

/* ----------------------------------------------------------------- misc */

/** Owner-set weekly goals for an employee (outcomes, not dial counts). */
const SalesGoalSchema = new Schema(
  {
    employee: { type: Id, ref: "User", required: true },
    weeklyMemberships: { type: Number, default: 0 },
    weeklyFreeVisits: { type: Number, default: 0 },
    note: { type: String, default: "", maxlength: 500 },
    setBy: { type: Id, ref: "User", default: null },
  },
  { timestamps: true }
);
SalesGoalSchema.index({ employee: 1 }, { unique: true });

/** GoHighLevel webhook inbox: every delivery stored once, processed idempotently, retried on failure. */
const GhlWebhookEventSchema = new Schema(
  {
    eventId: { type: String, required: true },
    type: { type: String, default: "" },
    contactId: { type: String, default: null },
    /* Metadata only (message bodies are dropped before storage). */
    payload: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ["received", "processed", "ignored", "unmapped", "failed"], default: "received" },
    outcome: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: "" },
    nextAttemptAt: { type: Date, default: null },
    receivedAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
GhlWebhookEventSchema.index({ eventId: 1 }, { unique: true });
GhlWebhookEventSchema.index({ status: 1, nextAttemptAt: 1 });
GhlWebhookEventSchema.index({ contactId: 1, receivedAt: -1 });

/* A short-lived lock (bonus evaluation per employee, week approval). */
const SalesLockSchema = new Schema(
  { _id: String, owner: { type: String, required: true }, until: { type: Date, required: true } },
  { versionKey: false }
);
SalesLockSchema.index({ until: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

/**
 * The ledger clock: one document that every ledger write (addEntry) and every
 * week approval increments inside its transaction. Two such transactions can
 * therefore never interleave, so an entry is either on the statement being
 * approved or placed after it, never on an older week nobody will approve.
 */
const SalesLedgerClockSchema = new Schema({ _id: String, n: { type: Number, default: 0 } }, { versionKey: false });

const model = (name, schema, collection) => mongoose.models[name] || mongoose.model(name, schema, collection);

module.exports = {
  SalesLead: model("SalesLead", SalesLeadSchema),
  LeadAssignment: model("LeadAssignment", LeadAssignmentSchema),
  SalesActivity: model("SalesActivity", SalesActivitySchema),
  SalesTask: model("SalesTask", SalesTaskSchema),
  ContactSuppression: model("ContactSuppression", ContactSuppressionSchema),
  SalesReferralCode: model("SalesReferralCode", SalesReferralCodeSchema),
  SalesReferral: model("SalesReferral", SalesReferralSchema),
  SalesEvent: model("SalesEvent", SalesEventSchema),
  SalesCredit: model("SalesCredit", SalesCreditSchema),
  SalesCreditRequest: model("SalesCreditRequest", SalesCreditRequestSchema),
  SalesReview: model("SalesReview", SalesReviewSchema),
  CommissionRule: model("CommissionRule", CommissionRuleSchema),
  CommissionEntry: model("CommissionEntry", CommissionEntrySchema),
  BonusPeriod: model("BonusPeriod", BonusPeriodSchema),
  PayoutBatch: model("PayoutBatch", PayoutBatchSchema),
  SalesGoal: model("SalesGoal", SalesGoalSchema),
  GhlWebhookEvent: model("GhlWebhookEvent", GhlWebhookEventSchema),
  SalesLock: model("SalesLock", SalesLockSchema, "sales_locks"),
  SalesLedgerClock: model("SalesLedgerClock", SalesLedgerClockSchema, "sales_ledger_clock"),
};
