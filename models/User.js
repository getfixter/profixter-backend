const mongoose = require("mongoose");

const AddressSchema = new mongoose.Schema(
  {
    label: { type: String, default: "Address" },
    line1: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, required: true, default: "NY" },
    zip: { type: String, required: true },
    county: { type: String, default: "" },
  },
  { _id: true, timestamps: false }
);

const UserSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: false }, // Optional for Google OAuth users
    phone: { type: String, required: false }, // Optional for Google OAuth users
    firstName: { type: String, trim: true, default: "" },
    lastName: { type: String, trim: true, default: "" },
    role: {
      type: String,
      enum: ["customer", "employee", "admin"],
      default: "customer",
      required: true,
      index: true,
    },
    employeePosition: {
      type: String,
      enum: ["Fixter", "General Fixter", null],
      default: null,
    },
    isActive: { type: Boolean, default: true, required: true, index: true },
    mustChangePassword: { type: Boolean, default: false },

    // Google OAuth
    googleId: { type: String, unique: true, sparse: true }, // Google user ID

    // Legacy primary address (kept for backward compatibility)
    address: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    zip: { type: String, default: "" },
    county: { type: String, default: "" },

    // NEW: multi-address support
    addresses: { type: [AddressSchema], default: [] },
    defaultAddressId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // Stripe
    stripeCustomerId: { type: String },

    // Legacy single subscription flag (kept for older code/compat)
    subscription: { type: String, default: null },
    subscriptionExpiry: { type: Date, default: null },
    subscriptionStart: { type: Date, default: null },

    // ✅ Added: store latest purchase data for confirmation page tracking
    lastPurchase: {
      token: { type: String, default: null },
      stripeSessionId: { type: String, default: null },
      plan: { type: String, default: null },
      value: { type: Number, default: 0 },
      currency: { type: String, default: "USD" },
      createdAt: { type: Date, default: null },
    },

    // Non-subscriber nurture sequence tracking
    nurture: {
      email1SentAt: { type: Date, default: null },
      email2SentAt: { type: Date, default: null },
      email3SentAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", UserSchema);
