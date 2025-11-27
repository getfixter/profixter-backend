const mongoose = require("mongoose");

const BlacklistSchema = new mongoose.Schema(
  {
    user:   { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    userId: { type: String },
    name:   { type: String },
    email:  { type: String, index: true },
    phone:  { type: String },
    address:{ type: String },
    city:   { type: String },
    county: { type: String },
    state:  { type: String },
    zip:    { type: String },
    reason: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

module.exports = mongoose.model("Blacklist", BlacklistSchema);
