const mongoose = require("mongoose");

const RepAttributionSchema = new mongoose.Schema(
  {
    // ─────────────────────────────
    // Rep ownership
    // ─────────────────────────────
    repName: { type: String, required: true, trim: true, index: true },
    repUserId: { type: String, default: null, index: true }, // GHL user id later if available
    repPhoneNumber: { type: String, default: null },

    // ─────────────────────────────
    // GHL identity / sync fields
    // ─────────────────────────────
    ghlContactId: { type: String, index: true, sparse: true },
    ghlLocationId: { type: String, index: true, sparse: true },
    ghlOpportunityId: { type: String, default: null, index: true, sparse: true },
    ghlPipelineId: { type: String, default: null },
    ghlStageId: { type: String, default: null },

    // ─────────────────────────────
    // Lead identity
    // ─────────────────────────────
    firstName: { type: String, default: "" },
    lastName: { type: String, default: "" },
    fullName: { type: String, default: "" },

    emailRaw: { type: String, default: "" },
    emailNormalized: { type: String, index: true, default: null },

    phoneRaw: { type: String, default: "" },
    phoneNormalized: { type: String, required: true, index: true },

    // ─────────────────────────────
    // Assignment metadata
    // ─────────────────────────────
    attributionSource: { type: String, default: "cold_call", index: true },
    assignmentSource: { type: String, default: "ghl" },
    campaignName: { type: String, default: "" },
    listName: { type: String, default: "" },
    tags: { type: [String], default: [] },

    // Snapshot only — not source of truth
    cityAtAssignment: { type: String, default: "" },
    countyAtAssignment: { type: String, default: "" },
    stateAtAssignment: { type: String, default: "" },

    // ─────────────────────────────
    // Lifecycle status
    // ─────────────────────────────
    status: {
      type: String,
      enum: ["active", "registered", "subscribed", "lost", "archived"],
      default: "active",
      index: true,
    },

    conversionType: {
      type: String,
      enum: ["none", "registered", "subscribed"],
      default: "none",
      index: true,
    },

    assignedAt: { type: Date, default: Date.now, index: true },
    registeredAt: { type: Date, default: null, index: true },
    subscribedAt: { type: Date, default: null, index: true },

    // ─────────────────────────────
    // Subscription / sale data
    // ─────────────────────────────
    subscriptionPlan: { type: String, default: null, index: true }, // basic / plus / premium / elite
    subscriptionBillingCycle: {
      type: String,
      enum: ["monthly", "annual", null],
      default: null,
      index: true,
    },
    subscriptionValue: { type: Number, default: 0 }, // actual tracked sale value
    commissionRate: { type: Number, default: 0.5 }, // 50%
    commissionAmount: { type: Number, default: 0 },
    commissionStatus: {
      type: String,
      enum: ["unpaid", "paid", "void"],
      default: "unpaid",
      index: true,
    },
    commissionPaidAt: { type: Date, default: null },

    // ─────────────────────────────
    // Links to your internal system
    // ─────────────────────────────
    matchedUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    matchedSubscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscription",
      default: null,
      index: true,
    },

    // ─────────────────────────────
    // Control / audit
    // ─────────────────────────────
    isPrimary: { type: Boolean, default: true, index: true },
    notes: { type: String, default: "" },
    lastSyncedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Fast lookup indexes
RepAttributionSchema.index({ phoneNormalized: 1, status: 1, assignedAt: -1 });
RepAttributionSchema.index({ emailNormalized: 1, status: 1, assignedAt: -1 });
RepAttributionSchema.index({ repName: 1, subscribedAt: -1 });
RepAttributionSchema.index({ repName: 1, commissionStatus: 1, subscribedAt: -1 });

// One GHL contact should map to one attribution record
RepAttributionSchema.index(
  { ghlContactId: 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model("RepAttribution", RepAttributionSchema);