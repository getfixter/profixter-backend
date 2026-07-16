const mongoose = require("mongoose");
const {
  selectCurrentSubscription,
  subscriptionGrantsAccess,
} = require("./subscriptionManagement");
const {
  buildUserSearchFields,
  normalizeSearchPhone,
  normalizeSearchText,
} = require("./userSearchFields");

const PROJECT_CUSTOMER_ROLE_VALUES = [
  "customer",
  "member",
  "homeowner",
  "subscriber",
  "client",
  "user",
];
const EXCLUDED_PROJECT_CUSTOMER_ROLES = new Set([
  "admin",
  "employee",
  "fixter",
  "general fixter",
  "general_fixter",
  "technician",
  "tech",
  "staff",
  "system",
  "service",
  "internal",
]);

function cleanString(value, maxLength = 500) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function escapeRegex(value) {
  return cleanString(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePhoneDigits(value) {
  return normalizeSearchPhone(value);
}

function normalizeLimit(value, fallback = 12) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, 20));
}

function normalizeCursor(value) {
  const parsed = Number.parseInt(String(value || "0"), 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(parsed, 5000));
}

function normalizeRole(value) {
  return cleanString(value, 80).toLowerCase().replace(/[_-]+/g, " ");
}

function isProjectSelectableCustomer(user = {}) {
  const role = normalizeRole(user.role);
  const employeePosition = cleanString(user.employeePosition, 80);
  if (EXCLUDED_PROJECT_CUSTOMER_ROLES.has(role)) return false;
  if (employeePosition) return false;
  if (user.isActive === false) return false;
  if (user.isDeleted === true || user.deleted === true || user.accountDeleted === true) return false;
  if (user.deletedAt || user.accountDeletedAt || user.removedAt) return false;
  if (user.isBlocked === true || user.blocked === true) return false;
  if (["blocked", "deleted", "removed", "inactive"].includes(normalizeRole(user.status))) return false;
  if (!role) return true;
  return PROJECT_CUSTOMER_ROLE_VALUES.includes(role);
}

function projectSelectableCustomerEligibilityQuery() {
  return {
    $and: [
      {
        $or: [
          { role: { $in: PROJECT_CUSTOMER_ROLE_VALUES } },
          { role: null },
          { role: "" },
          { role: { $exists: false } },
        ],
      },
      {
        $or: [
          { employeePosition: null },
          { employeePosition: "" },
          { employeePosition: { $exists: false } },
        ],
      },
      {
        $or: [
          { isActive: { $ne: false } },
          { isActive: { $exists: false } },
        ],
      },
      { isDeleted: { $ne: true } },
      { deleted: { $ne: true } },
      { accountDeleted: { $ne: true } },
      { deletedAt: null },
      { accountDeletedAt: null },
      { removedAt: null },
      {
        $or: [
          { status: { $exists: false } },
          { status: null },
          { status: "" },
          { status: { $nin: ["blocked", "deleted", "removed", "inactive"] } },
        ],
      },
    ],
  };
}

function searchFieldClauses(rawQuery) {
  const q = cleanString(rawQuery, 120);
  if (q.length < 2) return [];

  const normalized = normalizeSearchText(q);
  const phoneDigits = normalizePhoneDigits(q);
  if (!normalized && phoneDigits.length < 3) return [];

  const escaped = escapeRegex(normalized);
  const prefixRegex = new RegExp(`^${escaped}`);
  const clauses = normalized
    ? [
        { "search.names": prefixRegex },
        { "search.emails": prefixRegex },
        { "search.addresses": prefixRegex },
      ]
    : [];

  if (phoneDigits.length >= 3) {
    clauses.push({ "search.phone": new RegExp(`^${escapeRegex(phoneDigits)}`) });
  }

  return clauses;
}

function buildCustomerSearchQuery(rawQuery) {
  const clauses = searchFieldClauses(rawQuery);
  if (!clauses.length) return null;

  return {
    ...projectSelectableCustomerEligibilityQuery(),
    $or: clauses,
  };
}

function flexiblePhoneRegex(phoneDigits) {
  if (!phoneDigits || phoneDigits.length < 3) return null;
  const pattern = phoneDigits
    .split("")
    .map((digit) => escapeRegex(digit))
    .join("\\D*");
  return new RegExp(pattern);
}

function buildCustomerFallbackSearchQuery(rawQuery, excludedIds = []) {
  const q = cleanString(rawQuery, 120);
  if (q.length < 2) return null;

  const textRegex = new RegExp(escapeRegex(q), "i");
  const normalized = normalizeSearchText(q);
  const normalizedRegex = normalized ? new RegExp(escapeRegex(normalized), "i") : textRegex;
  const phoneRegex = flexiblePhoneRegex(normalizePhoneDigits(q));
  const clauses = [
    { name: textRegex },
    { firstName: textRegex },
    { lastName: textRegex },
    { email: textRegex },
    { address: textRegex },
    { city: textRegex },
    { state: textRegex },
    { zip: textRegex },
    { county: textRegex },
    { "addresses.line1": textRegex },
    { "addresses.city": textRegex },
    { "addresses.state": textRegex },
    { "addresses.zip": textRegex },
    { "addresses.county": textRegex },
    { "search.names": normalizedRegex },
    { "search.emails": normalizedRegex },
    { "search.addresses": normalizedRegex },
  ];
  if (phoneRegex) clauses.push({ phone: phoneRegex });

  return {
    ...projectSelectableCustomerEligibilityQuery(),
    ...(excludedIds.length ? { _id: { $nin: excludedIds } } : {}),
    $or: clauses,
  };
}

function fullNameForUser(user = {}) {
  const first = cleanString(user.firstName, 80);
  const last = cleanString(user.lastName, 80);
  return cleanString(user.name || [first, last].filter(Boolean).join(" "), 160);
}

function addressStringsForUser(user = {}) {
  const saved = Array.isArray(user.addresses)
    ? user.addresses.flatMap((address) => [
        address?.line1,
        address?.city,
        address?.state,
        address?.zip,
        addressToFormatted(address),
      ])
    : [];
  return [
    user.address,
    user.city,
    user.state,
    user.zip,
    legacyAddressToFormatted(user),
    ...saved,
  ].filter(Boolean);
}

function scoreProjectCustomerSearchMatch(user = {}, rawQuery = "") {
  const normalized = normalizeSearchText(rawQuery);
  const phoneDigits = normalizePhoneDigits(rawQuery);
  const email = normalizeSearchText(user.email);
  const fullName = normalizeSearchText(fullNameForUser(user));
  const firstName = normalizeSearchText(user.firstName);
  const lastName = normalizeSearchText(user.lastName);
  const userPhone = normalizePhoneDigits(user.phone);
  const search = buildUserSearchFields(user);
  const addresses = [...addressStringsForUser(user), ...(search.addresses || [])]
    .map(normalizeSearchText)
    .filter(Boolean);

  if (normalized && email === normalized) return 0;
  if (phoneDigits && userPhone === phoneDigits) return 1;
  if (normalized && fullName === normalized) return 2;
  if (
    normalized &&
    [fullName, firstName, lastName, ...(search.names || [])].some((name) =>
      normalizeSearchText(name).startsWith(normalized)
    )
  ) {
    return 3;
  }
  if (normalized && addresses.some((address) => address.includes(normalized))) return 4;
  if (
    normalized &&
    [fullName, firstName, lastName, email, ...(search.names || []), ...(search.emails || [])]
      .map(normalizeSearchText)
      .some((value) => value.includes(normalized))
  ) {
    return 5;
  }
  if (phoneDigits && userPhone.includes(phoneDigits)) return 6;
  return 50;
}

function isSearchFieldsCurrent(user = {}) {
  const expected = buildUserSearchFields(user);
  const current = user.search || {};
  return JSON.stringify({
    names: current.names || [],
    emails: current.emails || [],
    phone: current.phone || "",
    addresses: current.addresses || [],
  }) === JSON.stringify(expected);
}

function titleCase(value) {
  return cleanString(value, 80)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function addressToFormatted(address = {}) {
  return [
    cleanString(address.line1, 240),
    cleanString(address.city, 120),
    [cleanString(address.state, 40), cleanString(address.zip, 40)].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
}

function legacyAddressToFormatted(user = {}) {
  return [
    cleanString(user.address, 240),
    cleanString(user.city, 120),
    [cleanString(user.state, 40), cleanString(user.zip, 40)].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
}

function subscriptionStatus(subscription) {
  if (!subscription) return "none";
  if (subscriptionGrantsAccess(subscription)) {
    return subscription.cancelAtPeriodEnd ? "scheduled_for_cancellation" : String(subscription.status || "active");
  }
  const status = String(subscription.status || "").toLowerCase();
  if (status === "past_due") return "past_due";
  if (["canceled", "expired", "unpaid", "incomplete_expired"].includes(status)) return "canceled";
  return "none";
}

function planName(subscription) {
  return subscription?.subscriptionType ? titleCase(subscription.subscriptionType) : null;
}

function subscriptionsForAddress(subscriptions = [], addressId = null, defaultAddressId = null) {
  const requested = String(addressId || "");
  const defaultId = String(defaultAddressId || "");
  const hasAnyAddressSubscriptions = subscriptions.some((subscription) => subscription.addressId);

  return subscriptions.filter((subscription) => {
    const subscriptionAddressId = String(subscription.addressId || "");
    if (requested && subscriptionAddressId === requested) return true;
    if (
      requested &&
      requested === defaultId &&
      !hasAnyAddressSubscriptions &&
      !subscriptionAddressId
    ) {
      return true;
    }
    return false;
  });
}

function buildMembershipSummary({
  subscriptions = [],
  selectedAddressId = null,
  defaultAddressId = null,
} = {}) {
  const selectedOverall = selectCurrentSubscription(subscriptions);
  const selectedAddressSubscription = selectedAddressId
    ? selectCurrentSubscription(
        subscriptionsForAddress(subscriptions, selectedAddressId, defaultAddressId)
      )
    : null;
  const selectedAddressGrantsAccess =
    selectedAddressSubscription && subscriptionGrantsAccess(selectedAddressSubscription);
  const activeElsewhere = Boolean(
    selectedAddressId &&
      subscriptions.some(
        (subscription) =>
          subscriptionGrantsAccess(subscription) &&
          String(subscription.addressId || "") !== String(selectedAddressId)
      )
  );

  return {
    overallStatus: subscriptionStatus(selectedOverall),
    planName: subscriptionGrantsAccess(selectedOverall) ? planName(selectedOverall) : null,
    selectedAddressStatus: selectedAddressId
      ? subscriptionStatus(selectedAddressSubscription)
      : null,
    selectedAddressPlanName: selectedAddressGrantsAccess
      ? planName(selectedAddressSubscription)
      : null,
    addressId: selectedAddressId ? String(selectedAddressId) : null,
    activeMembershipAtAnotherAddress: activeElsewhere,
  };
}

function serializeAddress(address, { user = null, subscriptions = [] } = {}) {
  const id = String(address?._id || "");
  const summary = buildMembershipSummary({
    subscriptions,
    selectedAddressId: id || null,
    defaultAddressId: user?.defaultAddressId || null,
  });
  return {
    id,
    _id: id,
    label: cleanString(address?.label || "Address", 80),
    line1: cleanString(address?.line1, 240),
    city: cleanString(address?.city, 120),
    state: cleanString(address?.state || "NY", 40),
    zip: cleanString(address?.zip, 40),
    county: cleanString(address?.county, 120),
    formattedAddress: addressToFormatted(address),
    isDefault: String(user?.defaultAddressId || "") === id,
    membershipSummary: summary,
  };
}

function serializeLegacyAddress(user, subscriptions = []) {
  const formattedAddress = legacyAddressToFormatted(user);
  if (!formattedAddress) return null;
  const id = user.defaultAddressId ? String(user.defaultAddressId) : "";
  const summary = buildMembershipSummary({
    subscriptions,
    selectedAddressId: id || null,
    defaultAddressId: user.defaultAddressId || null,
  });
  return {
    id,
    _id: id,
    label: "Primary address",
    line1: cleanString(user.address, 240),
    city: cleanString(user.city, 120),
    state: cleanString(user.state || "NY", 40),
    zip: cleanString(user.zip, 40),
    county: cleanString(user.county, 120),
    formattedAddress,
    isDefault: true,
    membershipSummary: summary,
  };
}

function addressMatchesQuery(address, rawQuery) {
  const q = cleanString(rawQuery, 120).toLowerCase();
  if (!q) return false;
  return [
    address?.label,
    address?.line1,
    address?.city,
    address?.state,
    address?.zip,
    address?.formattedAddress,
  ]
    .map((value) => cleanString(value).toLowerCase())
    .some((value) => value.includes(q));
}

function serializeCustomerForProjectSelector(user, subscriptions = [], options = {}) {
  const addresses = Array.isArray(user?.addresses)
    ? user.addresses.map((address) => serializeAddress(address, { user, subscriptions }))
    : [];
  const legacyAddress = addresses.length ? null : serializeLegacyAddress(user, subscriptions);
  if (legacyAddress) addresses.push(legacyAddress);

  const selectedAddressId =
    options.selectedAddressId ||
    user?.defaultAddressId ||
    addresses.find((address) => address.isDefault)?.id ||
    addresses[0]?.id ||
    null;
  const membershipSummary = buildMembershipSummary({
    subscriptions,
    selectedAddressId,
    defaultAddressId: user?.defaultAddressId || null,
  });
  const matchingAddress =
    addresses.find((address) => addressMatchesQuery(address, options.query)) ||
    addresses.find((address) => address.id && String(address.id) === String(selectedAddressId)) ||
    addresses.find((address) => address.isDefault) ||
    addresses[0] ||
    null;

  return {
    id: String(user?._id || ""),
    customerId: String(user?._id || ""),
    userId: cleanString(user?.userId, 80),
    name: cleanString(user?.name, 160),
    firstName: cleanString(user?.firstName, 80),
    lastName: cleanString(user?.lastName, 80),
    email: cleanString(user?.email, 254).toLowerCase(),
    phone: cleanString(user?.phone, 40),
    defaultAddressId: user?.defaultAddressId ? String(user.defaultAddressId) : null,
    addresses,
    matchingAddress,
    membershipSummary,
  };
}

function buildCustomerSnapshot(input = {}) {
  return {
    fullName: cleanString(input.fullName ?? input.customerName, 160),
    email: cleanString(input.email, 254).toLowerCase(),
    phone: cleanString(input.phone, 40),
  };
}

function buildPropertySnapshot(input = {}) {
  const formattedAddress = cleanString(input.formattedAddress ?? input.address, 500);
  return {
    addressLine1: cleanString(input.addressLine1 ?? input.line1 ?? formattedAddress, 240),
    addressLine2: cleanString(input.addressLine2, 120),
    city: cleanString(input.city, 120),
    state: cleanString(input.state, 40),
    postalCode: cleanString(input.postalCode ?? input.zip, 40),
    formattedAddress,
  };
}

function normalizeOptionalObjectId(value, field, errors) {
  if (value === "" || value === null || value === undefined) return null;
  if (!mongoose.isValidObjectId(value)) {
    errors.push(`${field} is invalid`);
    return null;
  }
  return value;
}

module.exports = {
  addressToFormatted,
  buildCustomerFallbackSearchQuery,
  buildCustomerSearchQuery,
  buildCustomerSnapshot,
  buildMembershipSummary,
  buildPropertySnapshot,
  buildUserSearchFields,
  cleanString,
  isProjectSelectableCustomer,
  isSearchFieldsCurrent,
  normalizeCursor,
  normalizeLimit,
  normalizeOptionalObjectId,
  normalizePhoneDigits,
  normalizeSearchText,
  projectSelectableCustomerEligibilityQuery,
  PROJECT_CUSTOMER_ROLE_VALUES,
  scoreProjectCustomerSearchMatch,
  serializeCustomerForProjectSelector,
  subscriptionStatus,
};
