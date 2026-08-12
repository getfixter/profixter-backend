const mongoose = require("mongoose");
const Counter = require("./Counter");
const {
  DUE_TERMS,
  INVOICE_STATUSES,
  LINE_ITEM_CATEGORIES,
  PAYMENT_METHODS,
  TAX_TREATMENTS,
  applyInvoiceCalculations,
} = require("../utils/invoiceValidation");

const LineItemSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true, maxlength: 500 },
    quantity: { type: Number, required: true, min: 0 },
    unitPriceCents: { type: Number, required: true, min: 0 },
    amountCents: { type: Number, required: true, min: 0 },
    category: { type: String, enum: LINE_ITEM_CATEGORIES, default: "Other" },
    order: { type: Number, min: 0, default: 0 },
  },
  { _id: true }
);

const DiscountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    type: { type: String, enum: ["fixed", "percentage", "credit"], required: true },
    value: { type: Number, required: true, min: 0 },
    calculatedAmountCents: { type: Number, required: true, min: 0 },
    note: { type: String, trim: true, maxlength: 1000, default: "" },
    order: { type: Number, min: 0, default: 0 },
  },
  { _id: true }
);

const PaymentSchema = new mongoose.Schema(
  {
    amountCents: { type: Number, required: true, min: 1 },
    paymentDate: { type: Date, required: true },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    reference: { type: String, trim: true, maxlength: 120, default: "" },
    note: { type: String, trim: true, maxlength: 1000, default: "" },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    recordedByEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },

    /*
     * Where this payment came from. "manual" is an admin recording a cheque,
     * cash or a transfer that happened outside the system; "stripe" is money
     * collected online. Existing payments have no provider field and read as
     * manual, which is what they are.
     */
    provider: { type: String, enum: ["manual", "stripe"], default: "manual", index: true },

    /*
     * Stripe identifiers. The PaymentIntent is the idempotency key: it is
     * stable across webhook retries and across the several event types that can
     * announce the same payment, so it is what stops one payment being recorded
     * twice.
     */
    stripePaymentIntentId: { type: String, trim: true, maxlength: 120, default: "" },
    stripeInvoiceId: { type: String, trim: true, maxlength: 120, default: "" },
    /** The event that produced this record, kept for audit rather than matching. */
    stripeEventId: { type: String, trim: true, maxlength: 120, default: "" },
    /**
     * What Stripe actually collected, which is not always what we applied.
     * If an offline payment landed after the Stripe invoice was issued, we
     * apply only what was still owed and record the full collected amount here
     * so the difference is visible rather than lost.
     */
    providerAmountCents: { type: Number, min: 0, default: 0 },
  },
  { _id: true, timestamps: true }
);

const GeneratedPdfSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, min: 1 },
    key: { type: String, trim: true, required: true },
    url: { type: String, trim: true, default: "" },
    fileName: { type: String, trim: true, maxlength: 240, required: true },
    size: { type: Number, min: 0, default: 0 },
    generatedAt: { type: Date, default: Date.now },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    status: {
      type: String,
      enum: ["Current", "Superseded", "Voided"],
      default: "Current",
      required: true,
    },
  },
  { _id: true }
);

const EmailHistorySchema = new mongoose.Schema(
  {
    recipient: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    subject: { type: String, required: true, trim: true, maxlength: 240 },
    message: { type: String, trim: true, maxlength: 10000, default: "" },
    pdfVersion: { type: Number, min: 1, default: 1 },
    sentAt: { type: Date, default: Date.now },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    providerResponse: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { _id: true }
);

const EventSchema = new mongoose.Schema(
  {
    event: { type: String, required: true, trim: true, maxlength: 120 },
    at: { type: Date, default: Date.now, required: true },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    adminEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: true }
);

const InvoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
      immutable: true,
    },
    version: { type: Number, required: true, min: 1, default: 1, index: true },
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
      immutable: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    contractId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contract",
      default: null,
      index: true,
    },
    source: { type: String, enum: ["manual", "contract"], default: "manual", index: true },
    status: {
      type: String,
      enum: INVOICE_STATUSES,
      default: "Draft",
      required: true,
      index: true,
    },
    customerSnapshot: {
      fullName: { type: String, trim: true, maxlength: 160, required: true },
      email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
      phone: { type: String, trim: true, maxlength: 40, default: "" },
      customerId: { type: String, trim: true, maxlength: 120, default: "" },
    },
    propertySnapshot: {
      address: { type: String, trim: true, maxlength: 500, required: true },
      addressLine1: { type: String, trim: true, maxlength: 240, default: "" },
      addressLine2: { type: String, trim: true, maxlength: 120, default: "" },
      city: { type: String, trim: true, maxlength: 120, default: "" },
      state: { type: String, trim: true, maxlength: 40, default: "" },
      postalCode: { type: String, trim: true, maxlength: 40, default: "" },
      formattedAddress: { type: String, trim: true, maxlength: 500, default: "" },
    },
    projectSnapshot: {
      projectId: { type: String, trim: true, maxlength: 80, default: "" },
      projectNumber: { type: String, trim: true, maxlength: 80, required: true },
      workType: { type: String, trim: true, maxlength: 120, default: "" },
      projectDescription: { type: String, trim: true, maxlength: 10000, default: "" },
    },
    contractSnapshot: {
      contractId: { type: String, trim: true, maxlength: 80, default: "" },
      contractNumber: { type: String, trim: true, maxlength: 80, default: "" },
      finalContractPriceCents: { type: Number, min: 0, default: 0 },
      importedAt: { type: Date, default: null },
    },
    /**
     * The project's approved financial position at the moment this invoice was
     * issued.
     *
     * This is what makes an issued invoice immutable in the way that matters:
     * once a later Change Order executes, the project's current approved value
     * moves, but this invoice keeps reporting the figures it was actually
     * issued against. The PDF renders from here, never from live project state.
     *
     * Optional and never backfilled - invoices issued before this existed have
     * no snapshot and continue to render exactly as they always have.
     *
     * Only EXECUTED change orders appear here. A pending one is not approved
     * value and must never be frozen into an invoice as though it were.
     */
    projectFinancialSnapshot: {
      agreementId: { type: String, trim: true, maxlength: 80, default: "" },
      agreementNumber: { type: String, trim: true, maxlength: 80, default: "" },
      agreementVersion: { type: Number, min: 1, default: 1 },
      originalAgreementCents: { type: Number, min: 0, default: 0 },
      executedChangeOrders: {
        type: [
          {
            changeOrderId: { type: String, trim: true, maxlength: 80, default: "" },
            changeOrderNumber: { type: String, trim: true, maxlength: 80, default: "" },
            title: { type: String, trim: true, maxlength: 240, default: "" },
            /** Signed cents: negative for a deduction, zero for no-cost. */
            netAdjustmentCents: { type: Number, default: 0 },
          },
        ],
        default: [],
      },
      executedChangeOrderCents: { type: Number, default: 0 },
      approvedAgreementCents: { type: Number, min: 0, default: 0 },
      previouslyInvoicedCents: { type: Number, min: 0, default: 0 },
      previouslyPaidCents: { type: Number, min: 0, default: 0 },
      uninvoicedApprovedCents: { type: Number, min: 0, default: 0 },
      capturedAt: { type: Date, default: null },
    },

    /**
     * The online payment destination for this invoice.
     *
     * ProFixter stays the source of truth: this records only how the customer
     * can pay and what Stripe was told to collect. `amountDueCents` is the
     * figure the Stripe invoice was finalized for, and it is what makes staleness
     * detectable - if the invoice is edited or an offline payment lands, the
     * outstanding balance no longer matches this, and the destination must be
     * voided and reissued rather than left collecting the wrong amount.
     */
    onlinePayment: {
      provider: { type: String, enum: ["stripe", ""], default: "" },
      stripeInvoiceId: { type: String, trim: true, maxlength: 120, default: "" },
      stripeCustomerId: { type: String, trim: true, maxlength: 120, default: "" },
      /** The Stripe Hosted Invoice Page. Safe to email; not a secret, but not guessable. */
      hostedInvoiceUrl: { type: String, trim: true, maxlength: 1000, default: "" },
      /** Stripe's own state, kept separate from the ProFixter invoice status. */
      stripeStatus: { type: String, trim: true, maxlength: 40, default: "" },
      /** Cents the Stripe invoice was finalized to collect. */
      amountDueCents: { type: Number, min: 0, default: 0 },
      finalizedAt: { type: Date, default: null },
      voidedAt: { type: Date, default: null },
      lastSyncedAt: { type: Date, default: null },
      /** Set when provisioning failed, so the admin sees why no Pay button was sent. */
      lastError: { type: String, trim: true, maxlength: 500, default: "" },
      /**
       * Money Stripe collected that could not be applied because the balance
       * had already been reduced offline. Never silently dropped: it is surfaced
       * to the admin as a reconciliation condition.
       */
      unappliedCents: { type: Number, min: 0, default: 0 },
    },

    lineItems: {
      type: [LineItemSchema],
      required: true,
      validate: {
        validator: (items) => Array.isArray(items) && items.length > 0,
        message: "At least one invoice line item is required",
      },
    },
    discounts: { type: [DiscountSchema], default: [] },
    taxTreatment: {
      type: String,
      enum: TAX_TREATMENTS,
      default: "Not Determined",
      required: true,
    },
    taxRateBasisPoints: { type: Number, min: 0, default: 0 },
    subtotalCents: { type: Number, min: 0, default: 0 },
    totalDiscountCents: { type: Number, min: 0, default: 0 },
    taxableAmountCents: { type: Number, min: 0, default: 0 },
    taxAmountCents: { type: Number, min: 0, default: 0 },
    invoiceTotalCents: { type: Number, min: 0, default: 0 },
    payments: { type: [PaymentSchema], default: [] },
    totalPaidCents: { type: Number, min: 0, default: 0 },
    remainingBalanceCents: { type: Number, min: 0, default: 0 },
    dueTerm: { type: String, enum: DUE_TERMS, default: "due_on_receipt" },
    dates: {
      invoiceDate: { type: Date, required: true },
      /**
       * True when an admin deliberately set the invoice date rather than
       * accepting today's. Entering an invoice raised last week is a real
       * need, so a deliberate choice is never rolled forward at issue.
       */
      invoiceDateIsManual: { type: Boolean, default: false },
      dueDate: { type: Date, required: true },
      serviceDate: { type: Date, default: null },
      paidInFullAt: { type: Date, default: null },
    },
    publicNote: { type: String, trim: true, maxlength: 10000, default: "" },
    internalNote: { type: String, trim: true, maxlength: 10000, default: "" },
    paymentInstructions: { type: String, trim: true, maxlength: 2000, default: "" },
    generatedPdfs: { type: [GeneratedPdfSchema], default: [] },
    requiresRegeneration: { type: Boolean, default: false, index: true },
    sentAt: { type: Date, default: null },
    lastEmailedAt: { type: Date, default: null },
    emailHistory: { type: [EmailHistorySchema], default: [] },
    eventHistory: { type: [EventSchema], default: [] },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    voidReason: { type: String, trim: true, maxlength: 1000, default: "" },
    isArchived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
      index: true,
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

InvoiceSchema.index({ projectId: 1, createdAt: -1 });
InvoiceSchema.index({ projectId: 1, status: 1, createdAt: -1 });
InvoiceSchema.index(
  { projectId: 1, contractId: 1, isArchived: 1 },
  {
    name: "project_contract_invoice_lookup",
    partialFilterExpression: { contractId: { $type: "objectId" } },
  }
);

InvoiceSchema.statics.nextInvoiceNumber = async function nextInvoiceNumber() {
  const counter = await Counter.findOneAndUpdate(
    { key: "pih-invoice" },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return String(counter.value).padStart(6, "0");
};

InvoiceSchema.pre("validate", async function assignInvoiceNumberAndTotals() {
  if (!this.invoiceNumber) {
    this.invoiceNumber = await this.constructor.nextInvoiceNumber();
  }
  const financials = applyInvoiceCalculations(this);
  if (financials.errors.length) {
    financials.errors.forEach((message, index) => {
      this.invalidate(`invoiceCalculation.${index}`, message);
    });
  }
});

InvoiceSchema.methods.addEvent = function addEvent(event, req, details = {}) {
  const actor = req?.accessUser || req?.authUser || {};
  this.eventHistory.push({
    event,
    at: new Date(),
    adminId: req?.user?.id || actor?._id || null,
    adminEmail: String(actor?.email || "").toLowerCase(),
    details,
  });
};

InvoiceSchema.methods.currentPdf = function currentPdf() {
  return [...(this.generatedPdfs || [])]
    .filter((pdf) => pdf.status === "Current")
    .sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0] || null;
};

module.exports = mongoose.model("Invoice", InvoiceSchema);
module.exports.INVOICE_STATUSES = INVOICE_STATUSES;
module.exports.LINE_ITEM_CATEGORIES = LINE_ITEM_CATEGORIES;
module.exports.PAYMENT_METHODS = PAYMENT_METHODS;
module.exports.TAX_TREATMENTS = TAX_TREATMENTS;
