const mongoose = require("mongoose");

const BookingChangeSchema = new mongoose.Schema(
  {
    field: { type: String, required: true, maxlength: 80 },
    label: { type: String, required: true, maxlength: 120 },
    oldValue: { type: String, default: "", maxlength: 10000 },
    newValue: { type: String, default: "", maxlength: 10000 },
  },
  { _id: false }
);

const BookingHistorySchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    actorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    actorName: { type: String, required: true, maxlength: 200 },
    actorEmail: { type: String, default: "", maxlength: 254 },
    actorRole: { type: String, default: "system", maxlength: 40 },
    actorPosition: { type: String, default: "", maxlength: 80 },
    actionType: {
      type: String,
      enum: [
        "status_changed",
        "booking_edited",
        "assigned_fixter_changed",
        "booking_confirmed",
        "booking_canceled",
        "booking_created",
        "note_added",
      ],
      required: true,
      index: true,
    },
    changes: { type: [BookingChangeSchema], default: [] },
    summary: { type: String, required: true, maxlength: 500 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

BookingHistorySchema.index({ bookingId: 1, createdAt: -1 });

module.exports = mongoose.model("BookingHistory", BookingHistorySchema);
