// backend/models/Lead.js
const mongoose = require("mongoose");

const LeadSchema = new mongoose.Schema(
  {
    name: String,
    email: { type: String, index: true },
    phone: String,
    address_line1: String,
    city: String,
    state: String,
    zip: String,
    county: String,       // Nassau or Suffolk
    channel: String,      // web | messenger | sms
    source: String,       // landing page, ad, etc.
    status: {
      type: String,
      enum: ["new", "engaged", "converted", "out_of_area", "waitlist"],
      default: "new",
    },

    // --- Follow-up automation tracking ---
    lastContactAt: Date,     // last time they interacted with us
    followup1SentAt: Date,   // ~2 hours after creation if not subscribed
    followup2SentAt: Date,   // ~48 hours after creation if still not subscribed
    convertedAt: Date,       // when they subscribed (you can set this from your subs flow later)

    tags: [String],
    notes: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("Lead", LeadSchema);
