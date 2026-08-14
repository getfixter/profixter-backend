const mongoose = require("mongoose");

const ACTIVE_STATUSES = ["held", "reserved"];
const VISIT_DURATION_MINUTES = 90;
// Matches ReservationTimeBucket: a reservation has to divide into whole buckets
// or the buckets that enforce it would not cover it exactly.
const BUCKET_MINUTES = 15;
const MAX_FULL_DAY_MS = 24 * 60 * 60 * 1000;

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
    /*
     * What kind of block this reservation is.
     *
     * A visit is the 90 minutes this model has always meant, and every document
     * written before Full Day existed reads as one because that is the default.
     * A full_day covers a Fixter's whole configured workday, which is why the
     * duration rule below has to branch: the 90-minute check is not a detail of
     * the schema, it is the guarantee that a visit is a visit, so it stays exact
     * for visits rather than being loosened for everyone.
     */
    kind: {
      type: String,
      enum: ["visit", "full_day"],
      default: "visit",
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
  const durationMs = this.slotEnd.getTime() - this.slotStart.getTime();
  if (this.kind === "full_day") {
    if (durationMs <= 0 || durationMs % (BUCKET_MINUTES * 60 * 1000) !== 0) {
      return next(
        new Error("Full day reservations must span whole 15-minute buckets")
      );
    }
    if (durationMs > MAX_FULL_DAY_MS) {
      return next(
        new Error("Full day reservations cannot exceed a single 24-hour day")
      );
    }
  } else if (durationMs !== VISIT_DURATION_MINUTES * 60 * 1000) {
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
