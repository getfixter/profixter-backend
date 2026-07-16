const mongoose = require("mongoose");
const {
  selectCurrentSubscription,
  subscriptionGrantsAccess,
} = require("./subscriptionManagement");

function cleanString(value, maxLength = 500) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function escapeRegex(value) {
  return cleanString(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSearchText(value) {
  return cleanString(value, 120)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@.\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePhoneDigits(value) {
  return cleanString(value, 80).replace(/\D/g, "");
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

function buildCustomerSearchQuery(rawQuery) {
  const q = cleanString(rawQuery, 120);
  if (q.length < 2) return null;

  const normalized = normalizeSearchText(q);
  const escaped = escapeRegex(normalized);
  const prefixRegex = new RegExp(`^${escaped}`);
  const phoneDigits = normalizePhoneDigits(q);
  const clauses = [
    { "search.names": prefixRegex },
    { "search.emails": prefixRegex },
    { "search.addresses": prefixRegex },
  ];

  if (phoneDigits.length >= 3) {
    clauses.push({ "search.phone": new RegExp(`^${escapeRegex(phoneDigits)}`) });
  }

  return {
    role: "customer",
    isActive: true,
    $or: clauses,
  };
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
  buildCustomerSearchQuery,
  buildCustomerSnapshot,
  buildMembershipSummary,
  buildPropertySnapshot,
  cleanString,
  normalizeCursor,
  normalizeLimit,
  normalizeOptionalObjectId,
  normalizePhoneDigits,
  normalizeSearchText,
  serializeCustomerForProjectSelector,
  subscriptionStatus,
};
