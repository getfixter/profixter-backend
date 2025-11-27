const mongoose = require("mongoose");

const SubscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  userId: { type: String, required: true }, // 8-digit public ID

  subscriptionType: {
    type: String,
    required: true,
    enum: ["basic", "plus", "premium", "elite"],
  },

  // NEW — the specific address covered by this subscription
  addressId: { type: mongoose.Schema.Types.ObjectId, default: null },

  // Snapshot for emails/admin
  addressSnapshot: {
    line1: String, city: String, state: String, zip: String, county: String
  },

  startDate: { type: Date, required: true },
  latestPaymentDate: { type: Date, required: true },
  nextPaymentDate: { type: Date, required: true },

  status: { type: String, enum: ["active", "canceled", "expired"], default: "active" },
  cancellationDate: Date,
  cancellationReason: String,
  renewalAttempts: { type: Number, default: 0 },
  planPrice: Number,
  paymentMethod: String,
});

module.exports = mongoose.model("Subscription", SubscriptionSchema);
