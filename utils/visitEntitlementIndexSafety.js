const VisitEntitlement = require("../models/VisitEntitlement");

const CHECKOUT_SESSION_INDEX_NAME = "visit_entitlement_unique_checkout_session";
const PAYMENT_INTENT_INDEX_NAME = "visit_entitlement_unique_payment_intent";

const STRIPE_ID_INDEXES = [
  {
    field: "stripeCheckoutSessionId",
    keys: { stripeCheckoutSessionId: 1 },
    options: {
      unique: true,
      name: CHECKOUT_SESSION_INDEX_NAME,
      partialFilterExpression: {
        stripeCheckoutSessionId: { $type: "string" },
      },
    },
  },
  {
    field: "stripePaymentIntentId",
    keys: { stripePaymentIntentId: 1 },
    options: {
      unique: true,
      name: PAYMENT_INTENT_INDEX_NAME,
      partialFilterExpression: {
        stripePaymentIntentId: { $type: "string" },
      },
    },
  },
];

const MEMBERSHIP_BENEFIT_INDEX_NAME = "one_membership_benefit_per_period";

/*
 * Additive only, and deliberately kept apart from the Stripe specs above.
 *
 * The Stripe list is allowed to drop and rebuild indexes because a wrong unique
 * index on a payment identifier is worse than a brief window without one. This
 * list is never allowed to drop anything. It is created on a live collection
 * holding real entitlements, and its partial filter requires periodStart to be
 * a date, so every document written before Full Day existed sits outside the
 * index entirely. Nothing needs migrating and nothing can be orphaned by it.
 */
const ADDITIVE_INDEXES = [
  {
    keys: {
      user: 1,
      addressId: 1,
      kind: 1,
      source: 1,
      periodStart: 1,
    },
    options: {
      unique: true,
      name: MEMBERSHIP_BENEFIT_INDEX_NAME,
      partialFilterExpression: {
        source: "membership_benefit",
        periodStart: { $type: "date" },
        status: { $in: ["pending_payment", "paid", "consumed"] },
      },
    },
  },
];

let defaultEnsurePromise = null;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = stable(value[key]);
      return acc;
    }, {});
}

function sameObject(left, right) {
  return JSON.stringify(stable(left || {})) === JSON.stringify(stable(right || {}));
}

function isSingleFieldIndex(index, field) {
  const keys = index?.key || {};
  const keyNames = Object.keys(keys);
  return keyNames.length === 1 && keyNames[0] === field && Number(keys[field]) === 1;
}

function indexMatchesSpec(index, spec) {
  return (
    index?.name === spec.options.name &&
    index?.unique === true &&
    isSingleFieldIndex(index, spec.field) &&
    sameObject(index.partialFilterExpression, spec.options.partialFilterExpression)
  );
}

function isStaleStripeIdIndex(index, spec) {
  if (index?.name === "_id_") return false;
  if (indexMatchesSpec(index, spec)) return false;

  const hasProtectedName = index?.name === spec.options.name;
  const isUniqueSingleFieldStripeIndex =
    index?.unique === true && isSingleFieldIndex(index, spec.field);

  return hasProtectedName || isUniqueSingleFieldStripeIndex;
}

function isDuplicateKeyIndexError(error) {
  return (
    error?.code === 11000 ||
    error?.code === 11001 ||
    error?.codeName === "DuplicateKey" ||
    /\bE11000\b.*duplicate key/i.test(String(error?.message || ""))
  );
}

async function listIndexes(collection) {
  try {
    return await collection.indexes();
  } catch (error) {
    if (
      error?.codeName === "NamespaceNotFound" ||
      /ns not found|namespace.*not found/i.test(String(error?.message || ""))
    ) {
      return [];
    }
    throw error;
  }
}

async function ensureVisitEntitlementIndexes({
  model = VisitEntitlement,
  logger = console,
} = {}) {
  const collection = model.collection;
  const dropped = [];
  const created = [];
  let existingIndexes = await listIndexes(collection);

  for (const spec of STRIPE_ID_INDEXES) {
    const staleIndexes = existingIndexes.filter((index) =>
      isStaleStripeIdIndex(index, spec)
    );

    for (const index of staleIndexes) {
      logger.warn(
        `Dropping stale VisitEntitlement index ${index.name} on ${collection.name}`
      );
      await collection.dropIndex(index.name);
      dropped.push(index.name);
    }

    if (staleIndexes.length) {
      existingIndexes = await listIndexes(collection);
    }
  }

  for (const spec of STRIPE_ID_INDEXES) {
    try {
      await collection.createIndex(spec.keys, spec.options);
      created.push(spec.options.name);
    } catch (error) {
      if (isDuplicateKeyIndexError(error)) {
        error.message = [
          error.message,
          `VisitEntitlement could not create ${spec.options.name}.`,
          `Duplicate non-null ${spec.field} values must be repaired before this unique index can be created.`,
        ].join(" ");
      }
      throw error;
    }
  }

  for (const spec of ADDITIVE_INDEXES) {
    try {
      await collection.createIndex(spec.keys, spec.options);
      created.push(spec.options.name);
    } catch (error) {
      if (isDuplicateKeyIndexError(error)) {
        error.message = [
          error.message,
          `VisitEntitlement could not create ${spec.options.name}.`,
          "A customer already holds more than one membership-benefit entitlement for the same billing period; repair the duplicates before this index can exist.",
        ].join(" ");
      }
      throw error;
    }
  }

  logger.log(
    `VisitEntitlement Stripe ID indexes ready (${collection.name})`
  );
  return { ready: true, dropped, created };
}

function ensureVisitEntitlementIndexesOnce(options = {}) {
  const model = options.model || VisitEntitlement;
  if (model !== VisitEntitlement) {
    return ensureVisitEntitlementIndexes(options);
  }

  if (!defaultEnsurePromise) {
    defaultEnsurePromise = ensureVisitEntitlementIndexes(options).catch((error) => {
      defaultEnsurePromise = null;
      throw error;
    });
  }
  return defaultEnsurePromise;
}

module.exports = {
  ADDITIVE_INDEXES,
  CHECKOUT_SESSION_INDEX_NAME,
  MEMBERSHIP_BENEFIT_INDEX_NAME,
  PAYMENT_INTENT_INDEX_NAME,
  STRIPE_ID_INDEXES,
  ensureVisitEntitlementIndexes,
  ensureVisitEntitlementIndexesOnce,
  indexMatchesSpec,
  isDuplicateKeyIndexError,
  isStaleStripeIdIndex,
};
