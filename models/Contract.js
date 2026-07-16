const mongoose = require("mongoose");
const Counter = require("./Counter");
const {
  CANCELLATION_NOTICE_TERMS_VERSION,
  CONTRACT_STATUSES,
  CONTRACT_TERMS_VERSION,
  WORK_TYPES,
} = require("../config/premiumIslandHomesContract");

const PaymentScheduleSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, maxlength: 160, required: true },
    amountCents: { type: Number, min: 0, required: true },
    dueCondition: { type: String, trim: true, maxlength: 500, required: true },
    order: { type: Number, min: 0, default: 0 },
  },
  { _id: true }
);

const DiscountSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 160, required: true },
    type: { type: String, enum: ["fixed", "percentage"], required: true },
    value: { type: Number, min: 0, required: true },
    calculatedAmountCents: { type: Number, min: 0, required: true },
    note: { type: String, trim: true, maxlength: 1000, default: "" },
    order: { type: Number, min: 0, default: 0 },
  },
  { _id: true }
);

const AuditEventSchema = new mongoose.Schema(
  {
    event: { type: String, required: true, trim: true, maxlength: 120 },
    at: { type: Date, default: Date.now, required: true },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    adminEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: true }
);

const ContractSchema = new mongoose.Schema(
  {
    contractNumber: {
      type: String,
      required: true,
      index: true,
      immutable: true,
    },
    version: { type: Number, required: true, min: 1, default: 1, index: true },
    current: { type: Boolean, default: true, index: true },
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: CONTRACT_STATUSES.filter((status) => status !== "No Contract"),
      default: "Draft",
      required: true,
      index: true,
    },
    termsVersion: {
      type: String,
      default: CONTRACT_TERMS_VERSION,
      required: true,
      immutable: true,
    },
    legalNoticeVersion: {
      type: String,
      default: CANCELLATION_NOTICE_TERMS_VERSION,
      required: true,
      immutable: true,
    },
    customerSnapshot: {
      fullName: { type: String, trim: true, maxlength: 160, required: true },
      email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
      phone: { type: String, trim: true, maxlength: 40, default: "" },
      customerId: { type: String, trim: true, maxlength: 120, default: "" },
    },
    propertySnapshot: {
      address: { type: String, trim: true, maxlength: 500, required: true },
      projectId: { type: String, trim: true, maxlength: 80, default: "" },
      projectNumber: { type: String, trim: true, maxlength: 80, default: "" },
    },
    workType: { type: String, enum: WORK_TYPES, required: true },
    otherWorkType: { type: String, trim: true, maxlength: 120, default: "" },
    projectDescription: { type: String, trim: true, maxlength: 10000, required: true },
    scopeText: { type: String, trim: true, maxlength: 30000, required: true },
    originalContractPriceCents: { type: Number, min: 0, default: 0 },
    totalPriceCents: { type: Number, min: 0, required: true },
    discounts: { type: [DiscountSchema], default: [] },
    totalDiscountAmountCents: { type: Number, min: 0, default: 0 },
    adjustedContractPriceCents: { type: Number, min: 0, default: 0 },
    depositAmountCents: { type: Number, min: 0, required: true },
    fullDepositConfirmed: { type: Boolean, default: false },
    zeroAdjustedPriceConfirmed: { type: Boolean, default: false },
    remainingBalanceCents: { type: Number, min: 0, required: true },
    paymentSchedule: { type: [PaymentScheduleSchema], default: [] },
    dates: {
      contractDate: { type: Date, required: true },
      estimatedStartDate: { type: Date, default: null },
      estimatedCompletionDate: { type: Date, default: null },
      cancellationDeadline: { type: Date, default: null },
    },
    optionalDetails: {
      materialsAllowances: { type: String, trim: true, maxlength: 12000, default: "" },
      exclusions: { type: String, trim: true, maxlength: 12000, default: "" },
      permitResponsibility: { type: String, trim: true, maxlength: 5000, default: "" },
      specialInstructions: { type: String, trim: true, maxlength: 12000, default: "" },
      additionalNotes: { type: String, trim: true, maxlength: 12000, default: "" },
    },
    generatedPdf: {
      key: { type: String, trim: true, default: "" },
      url: { type: String, trim: true, default: "" },
      fileName: { type: String, trim: true, maxlength: 240, default: "" },
      size: { type: Number, min: 0, default: 0 },
      generatedAt: { type: Date, default: null },
      generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    signedPdf: {
      key: { type: String, trim: true, default: "" },
      url: { type: String, trim: true, default: "" },
      fileName: { type: String, trim: true, maxlength: 240, default: "" },
      size: { type: Number, min: 0, default: 0 },
      uploadedAt: { type: Date, default: null },
      uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    emailHistory: {
      type: [
        {
          recipient: { type: String, trim: true, lowercase: true, maxlength: 254, required: true },
          subject: { type: String, trim: true, maxlength: 240, required: true },
          message: { type: String, trim: true, maxlength: 10000, default: "" },
          sentAt: { type: Date, default: Date.now },
          sentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
          providerResponse: { type: String, trim: true, maxlength: 500, default: "" },
        },
      ],
      default: [],
    },
    auditHistory: { type: [AuditEventSchema], default: [] },
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

ContractSchema.index(
  { contractNumber: 1, version: 1 },
  { unique: true, name: "unique_contract_number_version" }
);
ContractSchema.index({ projectId: 1, current: 1 });
ContractSchema.index({ projectId: 1, version: -1 });

ContractSchema.statics.nextContractNumber = async function nextContractNumber() {
  const year = new Date().getUTCFullYear();
  const counter = await Counter.findOneAndUpdate(
    { key: `pih-contract:${year}` },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return `PIH-${year}-${String(counter.value).padStart(4, "0")}`;
};

ContractSchema.pre("validate", async function assignContractNumber() {
  if (!this.contractNumber) {
    this.contractNumber = await this.constructor.nextContractNumber();
  }
  const original = Number(this.originalContractPriceCents || this.totalPriceCents || 0);
  const totalDiscount = Array.isArray(this.discounts)
    ? this.discounts.reduce((sum, discount) => sum + Number(discount.calculatedAmountCents || 0), 0)
    : Number(this.totalDiscountAmountCents || 0);
  const adjusted = Math.max(original - totalDiscount, 0);
  this.originalContractPriceCents = original;
  this.totalPriceCents = original;
  this.totalDiscountAmountCents = totalDiscount;
  this.adjustedContractPriceCents = Number(this.adjustedContractPriceCents || adjusted);
  if (this.adjustedContractPriceCents !== adjusted) {
    this.adjustedContractPriceCents = adjusted;
  }
  this.remainingBalanceCents = Math.max(
    Number(this.adjustedContractPriceCents || 0) - Number(this.depositAmountCents || 0),
    0
  );
});

ContractSchema.methods.addAuditEvent = function addAuditEvent(event, req, details = {}) {
  const actor = req?.accessUser || req?.authUser || {};
  this.auditHistory.push({
    event,
    at: new Date(),
    adminId: req?.user?.id || actor?._id || null,
    adminEmail: String(actor?.email || "").toLowerCase(),
    details,
  });
};

module.exports = mongoose.model("Contract", ContractSchema);
module.exports.CONTRACT_STATUSES = CONTRACT_STATUSES;
module.exports.WORK_TYPES = WORK_TYPES;
