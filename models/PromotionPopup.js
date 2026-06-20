const mongoose = require("mongoose");

const PromotionPopupSchema = new mongoose.Schema(
  {
    singletonKey: {
      type: String,
      default: "active",
      unique: true,
      immutable: true,
    },
    enabled: { type: Boolean, default: false },
    eyebrow: { type: String, trim: true, default: "Profixter update" },
    title: { type: String, trim: true, default: "" },
    message: { type: String, trim: true, default: "" },
    promoCode: { type: String, trim: true, uppercase: true, default: "" },
    ctaText: { type: String, trim: true, default: "" },
    ctaUrl: { type: String, trim: true, default: "" },
    secondaryText: { type: String, trim: true, default: "" },
    secondaryUrl: { type: String, trim: true, default: "" },
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    target: {
      type: String,
      enum: ["homepage", "all_public"],
      default: "homepage",
    },
    internalNote: { type: String, trim: true, default: "" },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PromotionPopup", PromotionPopupSchema);
