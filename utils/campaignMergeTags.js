const MERGE_TAG_GROUPS = Object.freeze([
  {
    id: "customer",
    label: "Customer",
    variables: [
      { key: "firstName", tag: "{{firstName}}", description: "Customer first name" },
      { key: "lastName", tag: "{{lastName}}", description: "Customer last name" },
      { key: "fullName", tag: "{{fullName}}", description: "Customer full name" },
      { key: "email", tag: "{{email}}", description: "Customer email address" },
      { key: "phone", tag: "{{phone}}", description: "Customer phone number" },
    ],
  },
  {
    id: "membership",
    label: "Membership",
    variables: [
      { key: "planName", tag: "{{planName}}", description: "Current active plan name" },
      {
        key: "subscriptionStatus",
        tag: "{{subscriptionStatus}}",
        description: "Current subscription status",
      },
      {
        key: "memberSince",
        tag: "{{memberSince}}",
        description: "Date the customer account was created",
      },
    ],
  },
  {
    id: "address",
    label: "Primary address",
    variables: [
      { key: "address", tag: "{{address}}", description: "Primary street address" },
      { key: "city", tag: "{{city}}", description: "Primary address city" },
      { key: "state", tag: "{{state}}", description: "Primary address state" },
      { key: "zip", tag: "{{zip}}", description: "Primary address ZIP code" },
    ],
  },
]);

const SUPPORTED_KEYS = new Set(
  MERGE_TAG_GROUPS.flatMap((group) => group.variables.map((variable) => variable.key))
);

function titleCase(value = "") {
  return String(value)
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function splitName(recipient = {}) {
  const fullName = String(recipient.fullName || recipient.name || "").trim();
  const parts = fullName.split(/\s+/).filter(Boolean);
  return {
    firstName: String(recipient.firstName || parts[0] || "").trim(),
    lastName: String(
      recipient.lastName || (parts.length > 1 ? parts.slice(1).join(" ") : "")
    ).trim(),
    fullName,
  };
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function valuesForRecipient(recipient = {}) {
  const names = splitName(recipient);
  const plans = Array.isArray(recipient.plans) ? recipient.plans : [];
  const statuses = Array.isArray(recipient.subscriptionStatuses)
    ? recipient.subscriptionStatuses
    : [];

  return {
    firstName: names.firstName,
    lastName: names.lastName,
    fullName: names.fullName,
    email: String(recipient.email || "").trim(),
    phone: String(recipient.phone || "").trim(),
    planName: plans.map(titleCase).join(", "),
    subscriptionStatus: statuses.map(titleCase).join(", "),
    memberSince: formatDate(recipient.memberSince),
    address: String(recipient.address || "").trim(),
    city: String(recipient.city || "").trim(),
    state: String(recipient.state || "").trim(),
    zip: String(recipient.zip || "").trim(),
  };
}

function personalize(value = "", recipient = {}) {
  const values = valuesForRecipient(recipient);
  const legacyAliases = {
    name: values.fullName,
    plan: values.planName,
    userId: String(recipient.userId || ""),
  };

  return replaceTags(value, (key) => {
    if (SUPPORTED_KEYS.has(key)) return values[key] || "";
    if (Object.prototype.hasOwnProperty.call(legacyAliases, key)) {
      return legacyAliases[key] || "";
    }
    return "";
  });
}

function replaceTags(value, resolver) {
  return String(value).replace(
    /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g,
    (_match, key) => resolver(key)
  );
}

function personalizeUrl(value = "", recipient = {}) {
  const values = valuesForRecipient(recipient);
  const legacyAliases = {
    name: values.fullName,
    plan: values.planName,
    userId: String(recipient.userId || ""),
  };
  return replaceTags(value, (key) => {
    if (SUPPORTED_KEYS.has(key)) return encodeURIComponent(values[key] || "");
    if (Object.prototype.hasOwnProperty.call(legacyAliases, key)) {
      return encodeURIComponent(legacyAliases[key] || "");
    }
    return "";
  });
}

module.exports = {
  MERGE_TAG_GROUPS,
  personalize,
  personalizeUrl,
  valuesForRecipient,
};
