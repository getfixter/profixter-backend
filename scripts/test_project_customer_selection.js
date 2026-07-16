const assert = require("assert");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const {
  buildCustomerSearchQuery,
  buildCustomerSnapshot,
  buildMembershipSummary,
  buildPropertySnapshot,
  normalizeCursor,
  normalizeLimit,
  serializeCustomerForProjectSelector,
} = require("../utils/projectCustomerSelection");
const Project = require("../models/Project");
const User = require("../models/User");

const addressA = new mongoose.Types.ObjectId();
const addressB = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();

function subscription(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    user: userId,
    addressId: addressA,
    subscriptionType: "premium",
    status: "active",
    accessStatus: "active",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function queryRegexes(query) {
  return query.$or.map((entry) => Object.values(entry)[0]).filter((value) => value instanceof RegExp);
}

const firstNameQuery = buildCustomerSearchQuery("Ava");
assert(firstNameQuery, "first-name query should be built");
assert.strictEqual(firstNameQuery.role, "customer");
assert.strictEqual(firstNameQuery.isActive, true);
assert(firstNameQuery.$or.some((entry) => entry["search.names"]), "name should use indexed search field");
assert(firstNameQuery.$or.some((entry) => entry["search.emails"]), "email should use indexed search field");
assert(firstNameQuery.$or.some((entry) => entry["search.addresses"]), "address should use indexed search field");

const phoneQuery = buildCustomerSearchQuery("6315551111");
assert(
  queryRegexes(phoneQuery).some((regex) => regex.test("6315551111")),
  "formatted and unformatted phone search should normalize to indexed digits"
);

assert.strictEqual(buildCustomerSearchQuery("a"), null, "short searches should not enumerate users");
assert.strictEqual(normalizeLimit(1000), 20, "limit should be capped");
assert.strictEqual(normalizeCursor(999999), 5000, "cursor should be capped");

const searchIndexNames = new Set(
  User.schema.indexes().map(([_key, options]) => options?.name).filter(Boolean)
);
[
  "user_customer_search_names_idx",
  "user_customer_search_emails_idx",
  "user_customer_search_phone_idx",
  "user_customer_search_addresses_idx",
].forEach((name) => assert(searchIndexNames.has(name), `${name} should be declared`));
User.schema.indexes().forEach(([key, options]) => {
  if (!String(options?.name || "").startsWith("user_customer_search_")) return;
  const multikeyFields = Object.keys(key).filter((field) =>
    ["search.names", "search.emails", "search.addresses"].includes(field)
  );
  assert(multikeyFields.length <= 1, `${options.name} should not combine multiple array fields`);
});

const activeOnSelected = buildMembershipSummary({
  subscriptions: [subscription()],
  selectedAddressId: addressA,
  defaultAddressId: addressA,
});
assert.strictEqual(activeOnSelected.overallStatus, "active");
assert.strictEqual(activeOnSelected.planName, "Premium");
assert.strictEqual(activeOnSelected.selectedAddressStatus, "active");
assert.strictEqual(activeOnSelected.selectedAddressPlanName, "Premium");

const scheduled = buildMembershipSummary({
  subscriptions: [subscription({ cancelAtPeriodEnd: true })],
  selectedAddressId: addressA,
});
assert.strictEqual(scheduled.selectedAddressStatus, "scheduled_for_cancellation");

const activeElsewhere = buildMembershipSummary({
  subscriptions: [subscription({ addressId: addressB, subscriptionType: "basic" })],
  selectedAddressId: addressA,
});
assert.strictEqual(activeElsewhere.selectedAddressStatus, "none");
assert.strictEqual(activeElsewhere.activeMembershipAtAnotherAddress, true);

const canceled = buildMembershipSummary({
  subscriptions: [
    subscription({
      status: "canceled",
      accessStatus: "inactive",
      currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
    }),
  ],
  selectedAddressId: addressA,
});
assert.strictEqual(canceled.overallStatus, "canceled");
assert.strictEqual(canceled.planName, null);

const serialized = serializeCustomerForProjectSelector(
  {
    _id: userId,
    userId: "12345678",
    name: "Ava Campfield",
    firstName: "Ava",
    lastName: "Campfield",
    email: "ava@example.com",
    phone: "+16315551111",
    defaultAddressId: addressA,
    password: "secret",
    stripeCustomerId: "cus_secret",
    addresses: [
      {
        _id: addressA,
        label: "Home",
        line1: "63 Lee Avenue",
        city: "Babylon",
        state: "NY",
        zip: "11702",
      },
      {
        _id: addressB,
        label: "Rental",
        line1: "10 Main Street",
        city: "Lindenhurst",
        state: "NY",
        zip: "11757",
      },
    ],
  },
  [subscription()],
  { query: "Lee" }
);
assert.strictEqual(serialized.addresses.length, 2);
assert.strictEqual(serialized.matchingAddress.formattedAddress, "63 Lee Avenue, Babylon, NY 11702");
assert.strictEqual(serialized.password, undefined);
assert.strictEqual(serialized.stripeCustomerId, undefined);

assert.deepStrictEqual(buildCustomerSnapshot({
  customerName: "Manual Lead",
  email: "LEAD@EXAMPLE.COM",
  phone: "6315550000",
}), {
  fullName: "Manual Lead",
  email: "lead@example.com",
  phone: "6315550000",
});
assert.deepStrictEqual(buildPropertySnapshot({
  line1: "1 Oak Street",
  city: "Babylon",
  state: "NY",
  zip: "11702",
  formattedAddress: "1 Oak Street, Babylon, NY 11702",
}), {
  addressLine1: "1 Oak Street",
  addressLine2: "",
  city: "Babylon",
  state: "NY",
  postalCode: "11702",
  formattedAddress: "1 Oak Street, Babylon, NY 11702",
});

assert(Project.schema.path("customerId"), "Project should support customerId");
assert(Project.schema.path("addressId"), "Project should support addressId");
assert(Project.schema.path("customerSnapshot.fullName"), "Project should preserve customer snapshot");
assert(Project.schema.path("propertySnapshot.formattedAddress"), "Project should preserve property snapshot");

const routeSource = fs.readFileSync(path.join(__dirname, "..", "routes", "projects.js"), "utf8");
assert(routeSource.includes('router.get("/customer-search"'), "customer search endpoint should exist");
assert(routeSource.includes("router.use(auth, ...requirePermission(PERMISSIONS.ADMIN))"), "customer search must be admin guarded");
assert(!routeSource.includes("stripeCustomerId") && !routeSource.includes("stripeSubscriptionId"), "project customer search route must not return Stripe identifiers");

console.log("Project customer selection tests passed.");
