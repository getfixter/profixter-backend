const mongoose = require("mongoose");

const BUCKET_MINUTES = 15;

const ReservationTimeBucketSchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    bucketStart: { type: Date, required: true },
    bucketEnd: { type: Date, required: true },
    reservationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BookingSlotReservation",
      required: true,
      index: true,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["held", "reserved"],
      required: true,
    },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ReservationTimeBucketSchema.pre("validate", function validateBucket(next) {
  if (
    !(this.bucketStart instanceof Date) ||
    Number.isNaN(this.bucketStart.getTime()) ||
    !(this.bucketEnd instanceof Date) ||
    Number.isNaN(this.bucketEnd.getTime())
  ) {
    return next(new Error("Reservation bucket requires valid start and end"));
  }
  if (
    this.bucketEnd.getTime() - this.bucketStart.getTime() !==
    BUCKET_MINUTES * 60 * 1000
  ) {
    return next(new Error("Reservation bucket must be exactly 15 minutes"));
  }
  if (this.status === "held" && !this.expiresAt) {
    return next(new Error("Held reservation buckets require expiresAt"));
  }
  if (this.status === "reserved") this.expiresAt = null;
  return next();
});

ReservationTimeBucketSchema.index(
  { technicianId: 1, bucketStart: 1 },
  {
    unique: true,
    name: "one_reservation_bucket_per_technician_time",
  }
);
ReservationTimeBucketSchema.index({ reservationId: 1, bucketStart: 1 });
ReservationTimeBucketSchema.index(
  { expiresAt: 1 },
  {
    expireAfterSeconds: 0,
    name: "expire_held_reservation_buckets",
  }
);

ReservationTimeBucketSchema.statics.BUCKET_MINUTES = BUCKET_MINUTES;

module.exports = mongoose.model(
  "ReservationTimeBucket",
  ReservationTimeBucketSchema
);
