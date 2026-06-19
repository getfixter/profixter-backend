const mongoose = require("mongoose");
const Counter = require("./Counter");

const ESTIMATE_STATUSES = [
  "Draft",
  "Sent",
  "Accepted",
  "Rejected",
  "Expired",
];

const EstimateLineItemSchema = new mongoose.Schema(
  {
    description: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    total: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: true }
);

const EstimateSchema = new mongoose.Schema(
  {
    estimateNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
      immutable: true,
    },
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: ESTIMATE_STATUSES,
      default: "Draft",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 5000,
      default: "",
    },
    lineItems: {
      type: [EstimateLineItemSchema],
      required: true,
      validate: {
        validator: (items) => Array.isArray(items) && items.length > 0,
        message: "At least one line item is required",
      },
    },
    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },
    tax: {
      type: Number,
      default: 0,
      min: 0,
    },
    discount: {
      type: Number,
      default: 0,
      min: 0,
    },
    total: {
      type: Number,
      required: true,
      min: 0,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 10000,
      default: "",
    },
    expirationDate: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
      index: true,
    },
  },
  { timestamps: true }
);

EstimateSchema.index({ projectId: 1, createdAt: -1 });
EstimateSchema.index({ status: 1, createdAt: -1 });

EstimateSchema.pre("validate", function calculateTotals() {
  const roundMoney = (value) =>
    Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

  this.lineItems.forEach((item) => {
    item.total = roundMoney(
      Number(item.quantity || 0) * Number(item.unitPrice || 0)
    );
  });

  this.subtotal = roundMoney(
    this.lineItems.reduce((sum, item) => sum + Number(item.total || 0), 0)
  );
  this.tax = roundMoney(this.tax);
  this.discount = roundMoney(this.discount);

  if (this.discount > roundMoney(this.subtotal + this.tax)) {
    this.invalidate("discount", "Discount cannot exceed subtotal plus tax");
  }

  this.total = roundMoney(this.subtotal + this.tax - this.discount);
});

EstimateSchema.statics.nextEstimateNumber = async function nextEstimateNumber() {
  const year = new Date().getUTCFullYear();
  const counter = await Counter.findOneAndUpdate(
    { key: `estimate:${year}` },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return `EST-${year}-${String(counter.value).padStart(5, "0")}`;
};

EstimateSchema.pre("validate", async function assignEstimateNumber() {
  if (!this.estimateNumber) {
    this.estimateNumber = await this.constructor.nextEstimateNumber();
  }
});

module.exports = mongoose.model("Estimate", EstimateSchema);
module.exports.ESTIMATE_STATUSES = ESTIMATE_STATUSES;
