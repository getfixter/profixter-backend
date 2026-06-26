const mongoose = require("mongoose");

const OneTimeVisitSettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: "default",
      enum: ["default"],
      unique: true,
      required: true,
    },
    enabled: { type: Boolean, default: true },
    priceCents: { type: Number, default: 9900, min: 0 },
    currency: { type: String, default: "usd", lowercase: true },
    durationMinutes: { type: Number, default: 90, min: 1 },
    stripePriceId: { type: String, default: "" },
    holdMinutes: { type: Number, default: 30, min: 30 },
    cancellationPhone: { type: String, default: "631-599-1363" },
    allowedServices: { type: [String], default: undefined },
    excludedServices: { type: [String], default: undefined },
    promoNote: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "OneTimeVisitSettings",
  OneTimeVisitSettingsSchema
);
