const mongoose = require("mongoose");
require("dotenv").config();

const User = require("../models/User");
const {
  buildCustomerSearchQuery,
  projectSelectableCustomerEligibilityQuery,
} = require("../utils/projectCustomerSelection");

const SEARCH_INDEX_NAMES = new Set([
  "user_customer_search_names_idx",
  "user_customer_search_emails_idx",
  "user_customer_search_phone_idx",
  "user_customer_search_addresses_idx",
]);

const INTENDED_INDEXES = [
  {
    name: "user_customer_search_names_idx",
    key: { role: 1, isActive: 1, "search.names": 1 },
  },
  {
    name: "user_customer_search_emails_idx",
    key: { role: 1, isActive: 1, "search.emails": 1 },
  },
  {
    name: "user_customer_search_phone_idx",
    key: { role: 1, isActive: 1, "search.phone": 1 },
  },
  {
    name: "user_customer_search_addresses_idx",
    key: { role: 1, isActive: 1, "search.addresses": 1 },
  },
];

function keySignature(key = {}) {
  return Object.entries(key)
    .map(([field, direction]) => `${field}:${direction}`)
    .join("|");
}

function collectIndexNamesFromPlan(node, names = new Set()) {
  if (!node || typeof node !== "object") return names;
  if (node.indexName) names.add(node.indexName);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => collectIndexNamesFromPlan(item, names));
    else if (value && typeof value === "object") collectIndexNamesFromPlan(value, names);
  }
  return names;
}

function collectStagesFromPlan(node, stages = new Set()) {
  if (!node || typeof node !== "object") return stages;
  if (node.stage) stages.add(node.stage);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => collectStagesFromPlan(item, stages));
    else if (value && typeof value === "object") collectStagesFromPlan(value, stages);
  }
  return stages;
}

function indexKeyMatches(actual = {}, intended = {}) {
  return JSON.stringify(actual) === JSON.stringify(intended);
}

function phoneDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function formatPhone(value) {
  const digits = phoneDigits(value);
  if (digits.length !== 10) return value;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function firstUsefulToken(value, fallback) {
  const token = String(value || "")
    .split(/[^A-Za-z0-9@.]+/)
    .map((part) => part.trim())
    .find((part) => part.length >= 3);
  return token || fallback;
}

function addressTermForUser(user = {}) {
  const address = Array.isArray(user.addresses) && user.addresses.length
    ? user.addresses.find((entry) => entry?.line1 || entry?.city || entry?.zip) || user.addresses[0]
    : null;
  return firstUsefulToken(
    address?.line1 || user.address || address?.city || user.city || address?.zip || user.zip,
    "Lee"
  );
}

async function representativeTerms() {
  const sample = await User.findOne({
    ...projectSelectableCustomerEligibilityQuery(),
    $or: [
      { name: { $type: "string", $ne: "" } },
      { email: { $type: "string", $ne: "" } },
      { phone: { $type: "string", $ne: "" } },
      { address: { $type: "string", $ne: "" } },
      { "addresses.line1": { $type: "string", $ne: "" } },
    ],
  })
    .select("name email phone address city state zip addresses")
    .sort({ createdAt: -1, _id: -1 })
    .lean();

  const rawPhone = process.env.PROJECT_CUSTOMER_SEARCH_PHONE || sample?.phone || "6315551111";
  const unformattedPhone = phoneDigits(rawPhone) || "6315551111";
  return {
    name: process.env.PROJECT_CUSTOMER_SEARCH_NAME || firstUsefulToken(sample?.name, "Ava"),
    email: process.env.PROJECT_CUSTOMER_SEARCH_EMAIL || sample?.email || "ava@example.com",
    phone_unformatted: unformattedPhone,
    phone_formatted: process.env.PROJECT_CUSTOMER_SEARCH_PHONE_FORMATTED || formatPhone(unformattedPhone),
    address: process.env.PROJECT_CUSTOMER_SEARCH_ADDRESS || addressTermForUser(sample),
  };
}

async function ensureIntendedIndexes(actualIndexes) {
  const existing = new Map(actualIndexes.map((index) => [index.name, index]));
  const created = [];
  for (const intended of INTENDED_INDEXES) {
    const actual = existing.get(intended.name);
    if (actual && indexKeyMatches(actual.key, intended.key)) continue;
    await User.collection.createIndex(intended.key, {
      name: intended.name,
      background: true,
    });
    created.push(intended.name);
  }
  return created;
}

function staticIndexAudit() {
  const declared = User.schema.indexes().map(([key, options]) => ({
    key,
    name: options?.name || keySignature(key),
  }));
  const duplicateKeys = declared
    .map((index) => keySignature(index.key))
    .filter((signature, index, signatures) => signatures.indexOf(signature) !== index);
  const searchIndexes = declared.filter((index) => SEARCH_INDEX_NAMES.has(index.name));
  const harmfulMultikey = searchIndexes.filter((index) => {
    const fields = Object.keys(index.key);
    return fields.filter((field) => ["search.names", "search.emails", "search.addresses"].includes(field)).length > 1;
  });

  return {
    declaredIndexCount: declared.length,
    searchIndexes: searchIndexes.map((index) => ({ name: index.name, key: index.key })),
    duplicateKeys,
    harmfulMultikeyIndexes: harmfulMultikey.map((index) => index.name),
    intendedIndexesDeclared: INTENDED_INDEXES.map((index) => index.name).every((name) =>
      searchIndexes.some((index) => index.name === name)
    ),
    queryShapes: {
      name: buildCustomerSearchQuery("Ava"),
      email: buildCustomerSearchQuery("ava@example.com"),
      phone_unformatted: buildCustomerSearchQuery("6315551111"),
      phone_formatted: buildCustomerSearchQuery("(631) 555-1111"),
      address: buildCustomerSearchQuery("Lee"),
    },
  };
}

async function explainSearches() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  const report = { staticAudit: staticIndexAudit(), liveExplain: null };

  if (!uri) {
    report.liveExplain = {
      skipped: true,
      reason: "MONGO_URI/MONGODB_URI is not set in this shell.",
    };
    return report;
  }

  await mongoose.connect(uri, { autoIndex: false });
  let actualIndexes = await User.collection.indexes();
  const createdIndexes = process.argv.includes("--ensure-indexes")
    ? await ensureIntendedIndexes(actualIndexes)
    : [];
  if (createdIndexes.length) {
    actualIndexes = await User.collection.indexes();
  }
  const actualSearchIndexes = actualIndexes
    .filter((index) => SEARCH_INDEX_NAMES.has(index.name))
    .map((index) => ({ name: index.name, key: index.key }));
  const missingIndexes = INTENDED_INDEXES
    .filter((intended) => !actualSearchIndexes.some(
      (actual) => actual.name === intended.name && indexKeyMatches(actual.key, intended.key)
    ))
    .map((index) => index.name);
  const terms = await representativeTerms();
  const explains = {};

  for (const [label, term] of Object.entries(terms)) {
    const query = buildCustomerSearchQuery(term);
    const explain = await User.find(query)
      .select("_id name email phone addresses defaultAddressId")
      .sort({ name: 1, email: 1, createdAt: -1 })
      .limit(12)
      .explain("executionStats");
    const stages = Array.from(collectStagesFromPlan(explain.queryPlanner?.winningPlan));
    explains[label] = {
      indexesUsed: Array.from(collectIndexNamesFromPlan(explain.queryPlanner?.winningPlan)),
      stages,
      collectionScanUsed: stages.includes("COLLSCAN"),
      totalDocsExamined: explain.executionStats?.totalDocsExamined,
      totalKeysExamined: explain.executionStats?.totalKeysExamined,
      executionTimeMillis: explain.executionStats?.executionTimeMillis,
      nReturned: explain.executionStats?.nReturned,
      winningPlanStage: explain.queryPlanner?.winningPlan?.stage,
    };
  }

  await mongoose.disconnect();
  report.liveExplain = {
    skipped: false,
    database: mongoose.connection.name,
    indexesEnsured: createdIndexes,
    actualIndexes: actualSearchIndexes,
    missingIndexes,
    allIntendedIndexesExist: missingIndexes.length === 0,
    explains,
    normalSearchesUseCollectionScan: Object.values(explains).some((entry) => entry.collectionScanUsed),
  };
  return report;
}

explainSearches()
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
  })
  .catch(async (error) => {
    console.error(error);
    try {
      await mongoose.disconnect();
    } catch (_disconnectError) {
      // Ignore cleanup errors in audit script.
    }
    process.exit(1);
  });
