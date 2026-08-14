const mongoose = require("mongoose");

/**
 * Settings for the Full Day Fixter product.
 *
 * Deliberately a sibling of OneTimeVisitSettings rather than a field added to
 * it: the two products have different prices, different durations and different
 * Stripe prices, and folding them together would mean every read of one had to
 * know about the other. Same shape, same singleton pattern, same env-backed
 * defaults, so anyone who has read one file already knows how this one works.
 */
const FullDayVisitSettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: "default",
      enum: ["default"],
      unique: true,
      required: true,
    },
    enabled: { type: Boolean, default: true },
    priceCents: { type: Number, default: 49900, min: 0 },
    currency: { type: String, default: "usd", lowercase: true },
    /**
     * How long the customer is told the day is. The capacity actually
     * reserved comes from the technician's configured workday, not from this
     * number, so the two cannot drift into overbooking if the copy changes.
     */
    approximateHours: { type: Number, default: 8, min: 1 },
    stripePriceId: { type: String, default: "" },
    holdMinutes: { type: Number, default: 30, min: 30 },
    cancellationPhone: { type: String, default: "631-599-1363" },
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "FullDayVisitSettings",
  FullDayVisitSettingsSchema
);
