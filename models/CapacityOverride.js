const mongoose = require("mongoose");
const {
  dateValidator,
  timeToMinutes,
} = require("../utils/availabilityValidation");

const CapacityOverrideSchema = new mongoose.Schema(
  {
    scopeType: {
      type: String,
      enum: ["company", "technician"],
      required: true,
      index: true,
    },
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    date: {
      type: String,
      required: true,
      validate: { validator: dateValidator, message: "Date must be YYYY-MM-DD" },
      index: true,
    },
    startTime: { type: String, default: null },
    endTime: { type: String, default: null },
    mode: {
      type: String,
      enum: ["set_capacity", "adjust_capacity", "block_spots"],
      required: true,
    },
    value: { type: Number, required: true },
    reason: { type: String, trim: true, maxlength: 200, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: true,
    // Built explicitly during startup so duplicate shadow rows can be reported
    // without taking down the application before the audit can be run.
    autoIndex: false,
  }
);

CapacityOverrideSchema.pre("validate", function validateCapacity(next) {
  if (this.scopeType === "technician" && !this.technicianId) {
    return next(new Error("technicianId is required for technician capacity overrides"));
  }
  if (this.scopeType === "company" && this.technicianId) {
    return next(new Error("Company capacity overrides cannot have technicianId"));
  }
  if ((this.startTime && !this.endTime) || (!this.startTime && this.endTime)) {
    return next(new Error("startTime and endTime must be provided together"));
  }
  if (this.startTime) {
    const start = timeToMinutes(this.startTime);
    const end = timeToMinutes(this.endTime);
    if (start === null || end === null || start >= end) {
      return next(new Error("Capacity override time range is invalid"));
    }
  }
  if (
    ["set_capacity", "block_spots"].includes(this.mode) &&
    (!Number.isInteger(this.value) || this.value < 0)
  ) {
    return next(new Error(`${this.mode} requires a nonnegative integer value`));
  }
  if (this.mode === "adjust_capacity" && !Number.isInteger(this.value)) {
    return next(new Error("adjust_capacity requires an integer value"));
  }
  return next();
});

CapacityOverrideSchema.index(
  {
    scopeType: 1,
    technicianId: 1,
    date: 1,
    startTime: 1,
    endTime: 1,
  },
  {
    unique: true,
    name: "one_capacity_override_per_scope_date_range",
  }
);
CapacityOverrideSchema.index({ date: 1, scopeType: 1 });

module.exports = mongoose.model("CapacityOverride", CapacityOverrideSchema);
