// models/EstimateLead.js
const mongoose = require("mongoose");

const EstimateLeadSchema = new mongoose.Schema(
  {
    // ── Service ────────────────────────────────────────────────────────────
    service: {
      type: String,
      enum: [
        "roofing",
        "siding",
        "roofing_siding",
        "both",
        "bathroom",
        "kitchen",
        "full-house",
        "build-new-house",
        "basement",
        "interior",
        "community-partnership",
        "other",
      ],
      required: true,
      index: true,
    },

    // ── Contact info ───────────────────────────────────────────────────────
    name:        { type: String, required: true },
    phone:       { type: String, required: true },
    email:       { type: String, required: true, lowercase: true, trim: true, index: true },
    address:     { type: String, required: true },
    contactPref: { type: String, enum: ["phone", "call", "text", "email"], default: "phone" },
    bestTime:    { type: String, default: "any" },
    sourcePage:  { type: String, default: "" },
    notes:       { type: String, default: "" },

    // ── Estimate range shown to homeowner ─────────────────────────────────
    estimateLow:  { type: Number },
    estimateHigh: { type: Number },

    // ── Roofing answers ────────────────────────────────────────────────────
    roofScope:     String, // replacement | repair
    roofSize:      String, // small | medium | large | xlarge
    roofMaterial:  String, // asphalt | flat | wood | metal
    roofUrgency:   String, // active-leak | storm | aging | planning
    roofInsurance: String, // yes | maybe | no
    roofFinish:    String, // standard | premium | ultra

    // ── Bathroom answers ───────────────────────────────────────────────────
    bathroomScope:    String,   // full | partial
    bathroomSize:     String,   // small | medium | large
    bathroomItems:    [String], // shower, tub, vanity, tile, flooring, toilet, lighting, plumbing
    bathroomFinish:   String,   // standard | premium | luxury
    bathroomPlumbing: String,   // yes | maybe | no

    // ── Kitchen answers ────────────────────────────────────────────────────
    kitchenScope:    String,   // full | partial
    kitchenSize:     String,   // small | medium | large
    kitchenItems:    [String], // cabinets, countertops, backsplash, flooring, island, appliances, lighting, plumbing, painting
    kitchenFinish:   String,   // standard | premium | luxury
    kitchenLayout:   String,   // yes | no | unsure
    kitchenPlumbing: String,   // yes | maybe | no

    // ── Common answers ─────────────────────────────────────────────────────
    timeline:  String, // asap | 1month | 1-3months | planning
    budgetRange: String,
    financing: String, // yes | maybe | no

    // ── Metadata ───────────────────────────────────────────────────────────
    source: { type: String, default: "estimate_builder" },
    status: {
      type: String,
      enum: ["new", "contacted", "qualified", "won", "lost"],
      default: "new",
    },

    // ── Future GHL integration ─────────────────────────────────────────────
    ghlContactId: { type: String, default: null },
    ghlSyncedAt:  { type: Date,   default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EstimateLead", EstimateLeadSchema);
