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
  },
  { timestamps: true }
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
