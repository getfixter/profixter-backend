const mongoose = require("mongoose");
const Counter = require("./Counter");

const PROJECT_TYPES = [
  "Roofing",
  "Siding",
  "Bathroom",
  "Kitchen",
  "Handyman",
  "Other",
];

const PROJECT_STATUSES = [
  "Lead",
  "Estimate Sent",
  "Follow Up",
  "Won",
  "In Progress",
  "Completed",
  "Lost",
];

const LEAD_MODELS = ["Request", "EstimateLead"];

const PunchListItemSchema = new mongoose.Schema(
  {
    text: { type: String, trim: true, maxlength: 500, required: true },
    done: { type: Boolean, default: false },
    doneAt: { type: Date, default: null },
    doneBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    createdAt: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: true }
);

const StatusHistorySchema = new mongoose.Schema(
  {
    from: { type: String, trim: true, default: "" },
    to: { type: String, trim: true, required: true },
    at: { type: Date, default: Date.now },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorName: { type: String, trim: true, maxlength: 160, default: "" },
    reason: { type: String, trim: true, maxlength: 1000, default: "" },
    source: { type: String, enum: ["manual", "lead_conversion"], default: "manual" },
  },
  { _id: true }
);

/*
 * One claim per billable schedule row, so "Create deposit invoice" or "Bill
 * milestone 2" can never produce two invoices for the same row, whatever the
 * phone does with retries. A claim whose invoice is later voided may be
 * re-billed.
 */
const BillingClaimSchema = new mongoose.Schema(
  {
    claimKey: { type: String, trim: true, required: true },
    kind: { type: String, enum: ["deposit", "milestone"], required: true },
    scheduleIndex: { type: Number, default: null },
    contractId: { type: mongoose.Schema.Types.ObjectId, ref: "Contract", required: true },
    idempotencyKey: { type: String, trim: true, maxlength: 200, default: "" },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null },
    claimedAt: { type: Date, default: Date.now },
    claimedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: true }
);

const ProjectSchema = new mongoose.Schema(
  {
    projectNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: PROJECT_STATUSES,
      default: "Lead",
      required: true,
      index: true,
    },
    customerName: { type: String, required: true, trim: true, maxlength: 160, index: true },
    phone: { type: String, trim: true, maxlength: 40, default: "" },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
    address: { type: String, required: true, trim: true, maxlength: 500 },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    addressId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    customerSnapshot: {
      fullName: { type: String, trim: true, maxlength: 160, default: "" },
      email: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
      phone: { type: String, trim: true, maxlength: 40, default: "" },
    },
    propertySnapshot: {
      addressLine1: { type: String, trim: true, maxlength: 240, default: "" },
      addressLine2: { type: String, trim: true, maxlength: 120, default: "" },
      city: { type: String, trim: true, maxlength: 120, default: "" },
      state: { type: String, trim: true, maxlength: 40, default: "" },
      postalCode: { type: String, trim: true, maxlength: 40, default: "" },
      formattedAddress: { type: String, trim: true, maxlength: 500, default: "" },
    },
    projectType: {
      type: String,
      enum: PROJECT_TYPES,
      required: true,
      index: true,
    },
    estimateAmount: { type: Number, min: 0, default: 0 },
    depositAmount: { type: Number, min: 0, default: 0 },
    balanceDue: { type: Number, min: 0, default: 0 },
    notes: { type: String, trim: true, maxlength: 10000, default: "" },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    deleteReason: { type: String, trim: true, maxlength: 1000, default: "" },

    /* Where the project came from, when it was converted from a lead. */
    leadRef: {
      model: { type: String, enum: [...LEAD_MODELS, null], default: null },
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    /*
     * The homeowner's own answers at inquiry time, copied verbatim from the
     * lead (budget, timeline, financing, scope answers, the price range they
     * were shown). A record of what they said, never recalculated.
     */
    qualification: { type: mongoose.Schema.Types.Mixed, default: undefined },

    /* Visits for this project (site visits, measures, work days). Mirrors Booking.projectId. */
    linkedBookingIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Booking" }], default: [] },
    siteVisitBookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null },

    scheduledStart: { type: Date, default: null },
    scheduledEnd: { type: Date, default: null },
    assignedFixterIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], default: [] },

    /* Set only by the explicit "Mark substantially complete" action. */
    substantialCompletionAt: { type: Date, default: null },
    substantialCompletionBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    /* Derived from the agreement's warranty terms at that moment; null when the terms define none. */
    warrantyEndsAt: { type: Date, default: null },
    warrantyTermsVersion: { type: String, trim: true, default: "" },
    punchList: { type: [PunchListItemSchema], default: [] },

    statusHistory: { type: [StatusHistorySchema], default: [] },
    billingClaims: { type: [BillingClaimSchema], default: [] },
  },
  { timestamps: true }
);

// One project per lead: a second conversion finds the first.
ProjectSchema.index(
  { "leadRef.model": 1, "leadRef.id": 1 },
  { unique: true, partialFilterExpression: { "leadRef.id": { $type: "objectId" } }, name: "project_lead_ref_unique" }
);

ProjectSchema.index({ createdAt: -1 });
ProjectSchema.index({ isDeleted: 1, createdAt: -1 });
ProjectSchema.index({ customerName: "text", address: "text", email: "text", phone: "text" });

ProjectSchema.statics.nextProjectNumber = async function nextProjectNumber() {
  const year = new Date().getUTCFullYear();
  const counter = await Counter.findOneAndUpdate(
    { key: `project:${year}` },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return `PRJ-${year}-${String(counter.value).padStart(5, "0")}`;
};

ProjectSchema.pre("validate", async function assignProjectNumber() {
  if (!this.projectNumber) {
    this.projectNumber = await this.constructor.nextProjectNumber();
  }
});

module.exports = mongoose.model("Project", ProjectSchema);
module.exports.PROJECT_TYPES = PROJECT_TYPES;
module.exports.PROJECT_STATUSES = PROJECT_STATUSES;
module.exports.LEAD_MODELS = LEAD_MODELS;
