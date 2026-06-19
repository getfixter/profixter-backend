const mongoose = require("mongoose");
const { weeklyScheduleValidator } = require("../utils/availabilityValidation");

const IntervalSchema = new mongoose.Schema(
  {
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    capacity: { type: Number, min: 0, default: null },
  },
  { _id: false }
);

const WeeklyDaySchema = new mongoose.Schema(
  {
    weekday: { type: Number, required: true, min: 0, max: 6 },
    enabled: { type: Boolean, default: true },
    intervals: { type: [IntervalSchema], default: [] },
  },
  { _id: false }
);

const CompanyAvailabilityTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: "Company Schedule" },
    timezone: { type: String, required: true, default: "America/New_York" },
    slotMinutes: { type: Number, required: true, min: 15, max: 240, default: 60 },
    visitDurationMinutes: {
      type: Number,
      required: true,
      min: 90,
      max: 90,
      default: 90,
    },
    minLeadMinutes: { type: Number, required: true, min: 0, max: 43200, default: 2880 },
    maxAdvanceDays: { type: Number, required: true, min: 1, max: 730, default: 120 },
    defaultCapacity: { type: Number, required: true, min: 0, max: 100, default: 1 },
    weeklySchedule: {
      type: [WeeklyDaySchema],
      default: [],
      validate: {
        validator: (value) =>
          weeklyScheduleValidator(value, { allowCapacity: true }),
        message: "Weekly schedule contains invalid or overlapping intervals",
      },
    },
    active: { type: Boolean, required: true, default: true },
    version: { type: Number, required: true, min: 1, default: 1 },
    legacyImportCompletedAt: { type: Date, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

CompanyAvailabilityTemplateSchema.index(
  { active: 1 },
  {
    unique: true,
    partialFilterExpression: { active: true },
    name: "one_active_company_availability_template",
  }
);

module.exports = mongoose.model(
  "CompanyAvailabilityTemplate",
  CompanyAvailabilityTemplateSchema
);
