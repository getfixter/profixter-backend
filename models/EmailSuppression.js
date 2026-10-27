const mongoose = require("mongoose");

const EmailSuppressionSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    reason: {
      type: String,
      required: true,
      enum: ["manual_blacklist", "unsubscribe", "bounce", "complaint"],
      index: true,
    },
    source: { type: String, default: "" },
    detail: { type: String, default: "" },
    suppressedAt: { type: Date, default: Date.now, required: true },
    /*
     * A customer who unsubscribed and later turned marketing email back on
     * themselves. The row is kept, so the unsubscribe stays on record; the
     * later of the two dates wins, like a STOP and a START. Only an
     * "unsubscribe" can be lifted this way - never a bounce, a complaint or a
     * manual block.
     */
    resubscribedAt: { type: Date, default: null },
    resubscribeSource: { type: String, default: "" },
  },
  { timestamps: true }
);

/** Is this row still keeping marketing email away? */
EmailSuppressionSchema.statics.isActive = function isActive(row) {
  if (!row) return false;
  if (!row.resubscribedAt) return true;
  return new Date(row.resubscribedAt).getTime() < new Date(row.suppressedAt).getTime();
};

module.exports = mongoose.model("EmailSuppression", EmailSuppressionSchema);
