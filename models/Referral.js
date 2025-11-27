const mongoose = require("mongoose");

const ReferralSchema = new mongoose.Schema({
  referrer: {
    userId: { type: String, required: true },
    name: { type: String, required: true },
    address: { type: String, required: true },
  },
  receiver: {
    userId: { type: String, required: true },
    name: { type: String, required: true },
    address: { type: String, required: true },
  },
  acceptedAt: {
    type: Date,
    default: Date.now,
  }
});

module.exports = mongoose.model("Referral", ReferralSchema);
