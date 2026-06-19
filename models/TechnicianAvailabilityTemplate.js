const mongoose = require("mongoose");
const { weeklyScheduleValidator } = require("../utils/availabilityValidation");

const TechnicianIntervalSchema = new mongoose.Schema(
  {
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
  },
  { _id: false }
);

const TechnicianWeeklyDaySchema = new mongoose.Schema(
  {
    weekday: { type: Number, required: true, min: 0, max: 6 },
    enabled: { type: Boolean, default: true },
    intervals: { type: [TechnicianIntervalSchema], default: [] },
  },
  { _id: false }
);

const TechnicianAvailabilityTemplateSchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    inheritCompanyHours: { type: Boolean, required: true, default: true },
    weeklySchedule: {
      type: [TechnicianWeeklyDaySchema],
      default: [],
      validate: {
        validator: (value) => weeklyScheduleValidator(value),
        message: "Weekly schedule contains invalid or overlapping intervals",
      },
    },
    active: { type: Boolean, required: true, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

TechnicianAvailabilityTemplateSchema.index(
  { technicianId: 1, active: 1 },
  {
    unique: true,
    partialFilterExpression: { active: true },
    name: "one_active_availability_template_per_technician",
  }
);

module.exports = mongoose.model(
  "TechnicianAvailabilityTemplate",
  TechnicianAvailabilityTemplateSchema
);
