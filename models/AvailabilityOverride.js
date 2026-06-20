const mongoose = require("mongoose");
const {
  dateValidator,
  validateIntervals,
  validateStarts,
} = require("../utils/availabilityValidation");

const OverrideIntervalSchema = new mongoose.Schema(
  {
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
  },
  { _id: false }
);

const OverrideStartSchema = new mongoose.Schema(
  {
    time: { type: String, required: true },
    capacity: { type: Number, min: 0, default: null },
  },
  { _id: false }
);

const AvailabilityOverrideSchema = new mongoose.Schema(
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
    mode: {
      type: String,
      enum: ["closed", "custom_hours", "open"],
      required: true,
    },
    intervals: {
      type: [OverrideIntervalSchema],
      default: [],
      validate: {
        validator: validateIntervals,
        message: "Override contains invalid or overlapping intervals",
      },
    },
    starts: {
      type: [OverrideStartSchema],
      default: [],
      validate: {
        validator: (value) => validateStarts(value, { allowCapacity: true }),
        message: "Override contains invalid or duplicate appointment starts",
      },
    },
    reason: { type: String, trim: true, maxlength: 200, default: "" },
    notes: { type: String, trim: true, maxlength: 2000, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

AvailabilityOverrideSchema.pre("validate", function validateScope(next) {
  if (this.scopeType === "technician" && !this.technicianId) {
    return next(new Error("technicianId is required for technician overrides"));
  }
  if (this.scopeType === "company" && this.technicianId) {
    return next(new Error("Company overrides cannot have technicianId"));
  }
  if (
    this.mode === "custom_hours" &&
    !this.intervals.length &&
    !this.starts.length
  ) {
    return next(
      new Error("custom_hours requires at least one appointment start")
    );
  }
  return next();
});

AvailabilityOverrideSchema.index(
  { scopeType: 1, technicianId: 1, date: 1 },
  { unique: true, name: "one_availability_override_per_scope_date" }
);
AvailabilityOverrideSchema.index({ date: 1, scopeType: 1 });

module.exports = mongoose.model(
  "AvailabilityOverride",
  AvailabilityOverrideSchema
);
