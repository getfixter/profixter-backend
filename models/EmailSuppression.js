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
  },
  { timestamps: true }
);

module.exports = mongoose.model("EmailSuppression", EmailSuppressionSchema);
