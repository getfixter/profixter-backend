const mongoose = require("mongoose");

const TechnicianTimeOffSchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["vacation", "sick", "personal", "training", "other"],
      required: true,
      index: true,
    },
    startAt: { type: Date, required: true, index: true },
    endAt: { type: Date, required: true, index: true },
    allDay: { type: Boolean, required: true, default: true },
    reason: { type: String, trim: true, maxlength: 500, default: "" },
    status: {
      type: String,
      enum: ["approved", "canceled"],
      required: true,
      default: "approved",
      index: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

TechnicianTimeOffSchema.pre("validate", function validateRange(next) {
  if (!(this.startAt instanceof Date) || !(this.endAt instanceof Date)) {
    return next(new Error("Time off requires valid startAt and endAt"));
  }
  if (this.startAt >= this.endAt) {
    return next(new Error("Time off endAt must be after startAt"));
  }
  return next();
});

TechnicianTimeOffSchema.index({ technicianId: 1, startAt: 1, endAt: 1 });
TechnicianTimeOffSchema.index({ status: 1, startAt: 1, endAt: 1 });

module.exports = mongoose.model("TechnicianTimeOff", TechnicianTimeOffSchema);
