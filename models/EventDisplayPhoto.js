const mongoose = require("mongoose");

/**
 * An admin's decision about one booking photo for the event display.
 *
 * This is the only thing the feature stores. The photo itself stays where the
 * booking put it; `url` is kept so a decision can be audited without the booking.
 * No row means "not reviewed", and an unreviewed photo is never displayed.
 */
const EventDisplayPhotoSchema = new mongoose.Schema(
  {
    photoId: { type: String, required: true, unique: true },
    url: { type: String, required: true },
    status: { type: String, enum: ["approved", "hidden"], required: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EventDisplayPhoto", EventDisplayPhotoSchema);
