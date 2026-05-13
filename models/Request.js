// 📁 backend/models/Request.js
const mongoose = require("mongoose");

const RequestSchema = new mongoose.Schema({
  // old fields (kept so you do not break existing usage)
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  password: { type: String, default: "" },
  phone: { type: String, trim: true },
  address: { type: String, trim: true, default: "" },
  city: { type: String, trim: true, default: "" },
  state: { type: String, trim: true, default: "" },
  zip: { type: String, trim: true, default: "" },
  county: { type: String, trim: true, default: "" },

  // new fields for public service-request forms
  message: { type: String, trim: true, default: "" },
  serviceType: {
    type: String,
    trim: true,
    default: "general",
    enum: [
      "general",
      "address_request",
      "on_demand",
      "general_contractor",
      "home_improvement",
    ],
  },
  sourcePage: { type: String, trim: true, default: "" },
  status: {
    type: String,
    trim: true,
    default: "new",
    enum: ["new", "contacted", "won", "lost"],
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Request", RequestSchema);