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
      // Somebody on the home page who wants membership explained on the phone.
      // The same Lead record as every other enquiry, so it lands in the one
      // Leads list the admin already works from.
      "membership_interest",
    ],
  },
  sourcePage: { type: String, trim: true, default: "" },
  status: {
    type: String,
    trim: true,
    default: "new",
    enum: ["new", "contacted", "won", "lost"],
  },

  /**
   * Collapses repeat submissions of the same enquiry into one lead.
   *
   * A read-then-write check cannot do this: three taps arrive together, all
   * three read "nothing yet", and all three insert. Only a unique index
   * serialises them, so the key is written on the document and the database
   * refuses the second.
   *
   * Sparse, so every request that does not set one is unaffected, and scoped to
   * a short time window by its caller so a genuine later enquiry still lands.
   */
  dedupeKey: {
    type: String,
    trim: true,
    default: undefined,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

RequestSchema.index(
  { dedupeKey: 1 },
  { unique: true, sparse: true, name: "request_dedupe_key_idx" }
);

module.exports = mongoose.model("Request", RequestSchema);