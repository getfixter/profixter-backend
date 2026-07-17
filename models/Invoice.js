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
