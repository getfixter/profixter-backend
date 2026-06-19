const mongoose = require("mongoose");

const ReservationCapacityBucketSchema = new mongoose.Schema(
  {
    bucketStart: { type: Date, required: true },
    bucketEnd: { type: Date, required: true },
    capacityUnit: { type: Number, required: true, min: 1, max: 100 },
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

ReservationCapacityBucketSchema.pre("validate", function validateBucket(next) {
  if (
    !(this.bucketStart instanceof Date) ||
    Number.isNaN(this.bucketStart.getTime()) ||
    !(this.bucketEnd instanceof Date) ||
    Number.isNaN(this.bucketEnd.getTime())
  ) {
    return next(new Error("Capacity bucket requires valid start and end"));
  }
  if (this.bucketEnd.getTime() - this.bucketStart.getTime() !== 15 * 60 * 1000) {
    return next(new Error("Capacity bucket must be exactly 15 minutes"));
  }
  if (this.status === "held" && !this.expiresAt) {
    return next(new Error("Held capacity buckets require expiresAt"));
  }
  if (this.status === "reserved") this.expiresAt = null;
  return next();
});

ReservationCapacityBucketSchema.index(
  { bucketStart: 1, capacityUnit: 1 },
  {
    unique: true,
    name: "one_reservation_per_company_capacity_bucket",
  }
);
ReservationCapacityBucketSchema.index({ reservationId: 1, bucketStart: 1 });
ReservationCapacityBucketSchema.index(
  { expiresAt: 1 },
  {
    expireAfterSeconds: 0,
    name: "expire_held_company_capacity_buckets",
  }
);

module.exports = mongoose.model(
  "ReservationCapacityBucket",
  ReservationCapacityBucketSchema
);
