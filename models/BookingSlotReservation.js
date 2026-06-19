const mongoose = require("mongoose");

const ACTIVE_STATUSES = ["held", "reserved"];
const VISIT_DURATION_MINUTES = 90;

const BookingSlotReservationSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    slotStart: { type: Date, required: true, index: true },
    slotEnd: { type: Date, required: true },
    timezone: {
      type: String,
      required: true,
      enum: ["America/New_York"],
      default: "America/New_York",
    },
    status: {
      type: String,
      enum: ["held", "reserved", "released"],
      required: true,
      default: "reserved",
      index: true,
    },
    holdExpiresAt: { type: Date, default: null, index: true },
    createdByType: {
      type: String,
      enum: ["customer", "admin", "system"],
      required: true,
      default: "system",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    releasedAt: { type: Date, default: null },
    releaseReason: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { timestamps: true }
);

BookingSlotReservationSchema.pre("validate", function validateReservation(next) {
  if (!(this.slotStart instanceof Date) || Number.isNaN(this.slotStart.getTime())) {
    return next(new Error("Reservation requires a valid slotStart"));
  }
  if (!(this.slotEnd instanceof Date) || Number.isNaN(this.slotEnd.getTime())) {
    return next(new Error("Reservation requires a valid slotEnd"));
  }
  if (
    this.slotEnd.getTime() - this.slotStart.getTime() !==
    VISIT_DURATION_MINUTES * 60 * 1000
  ) {
    return next(new Error("Reservation visit duration must be exactly 90 minutes"));
  }
  if (this.status === "held" && !this.holdExpiresAt) {
    return next(new Error("Held reservations require holdExpiresAt"));
  }
  if (this.status !== "held") this.holdExpiresAt = null;
  if (this.status === "released" && !this.releasedAt) {
    this.releasedAt = new Date();
  }
  return next();
});

BookingSlotReservationSchema.index(
  { bookingId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      $or: [{ status: "held" }, { status: "reserved" }],
    },
    name: "one_active_reservation_per_booking",
  }
);
BookingSlotReservationSchema.index(
  { technicianId: 1, slotStart: 1 },
  {
    unique: true,
    partialFilterExpression: {
      $or: [{ status: "held" }, { status: "reserved" }],
    },
    name: "one_active_reservation_per_technician_start",
  }
);
BookingSlotReservationSchema.index({ holdExpiresAt: 1 });
BookingSlotReservationSchema.index({ slotStart: 1, status: 1 });
BookingSlotReservationSchema.index({
  technicianId: 1,
  status: 1,
  slotStart: 1,
  slotEnd: 1,
});

BookingSlotReservationSchema.statics.ACTIVE_STATUSES = ACTIVE_STATUSES;
BookingSlotReservationSchema.statics.VISIT_DURATION_MINUTES =
  VISIT_DURATION_MINUTES;

module.exports = mongoose.model(
  "BookingSlotReservation",
  BookingSlotReservationSchema
);
