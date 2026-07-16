const mongoose = require("mongoose");

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@.\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function addressSearchParts(address = {}) {
  const line1 = normalizeSearchText(address.line1);
  const city = normalizeSearchText(address.city);
  const state = normalizeSearchText(address.state);
  const zip = normalizeSearchText(address.zip);
  const formatted = [line1, city, [state, zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(" ");
  const tokens = [line1, city, state, zip]
    .join(" ")
    .split(/\s+/)
    .filter((token) => token.length >= 2);
  return [formatted, line1, city, state, zip, ...tokens].filter(Boolean);
}

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
    isDefaultFixter: { type: Boolean, default: false },
    employeeAvailabilityStatus: {
      type: String,
      enum: ["Available", "Busy", "Vacation", "Sick", "Training", "Inactive"],
      default: "Available",
      index: true,
    },

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

    search: {
      names: { type: [String], default: [] },
      emails: { type: [String], default: [] },
      phone: { type: String, default: "" },
      addresses: { type: [String], default: [] },
    },

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

UserSchema.index(
  { isDefaultFixter: 1 },
  {
    unique: true,
    partialFilterExpression: { isDefaultFixter: true },
  }
);
UserSchema.index({ role: 1, isActive: 1, "search.names": 1 }, { name: "user_customer_search_names_idx" });
UserSchema.index({ role: 1, isActive: 1, "search.emails": 1 }, { name: "user_customer_search_emails_idx" });
UserSchema.index({ role: 1, isActive: 1, "search.phone": 1 }, { name: "user_customer_search_phone_idx" });
UserSchema.index({ role: 1, isActive: 1, "search.addresses": 1 }, { name: "user_customer_search_addresses_idx" });

UserSchema.pre("validate", function populateSearchFields(next) {
  const fullName = normalizeSearchText(this.name);
  const firstName = normalizeSearchText(this.firstName);
  const lastName = normalizeSearchText(this.lastName);
  const email = normalizeSearchText(this.email);
  const emailParts = email.includes("@") ? email.split("@") : [email];
  const legacyAddress = addressSearchParts({
    line1: this.address,
    city: this.city,
    state: this.state,
    zip: this.zip,
  });
  const savedAddresses = (this.addresses || []).flatMap(addressSearchParts);

  this.search = {
    names: Array.from(
      new Set([
        fullName,
        firstName,
        lastName,
        [firstName, lastName].filter(Boolean).join(" "),
        [lastName, firstName].filter(Boolean).join(" "),
      ].filter(Boolean))
    ),
    emails: Array.from(new Set([email, ...emailParts].filter(Boolean))),
    phone: normalizeSearchPhone(this.phone),
    addresses: Array.from(new Set([...legacyAddress, ...savedAddresses].filter(Boolean))),
  };
  next();
});

module.exports = mongoose.model("User", UserSchema);
