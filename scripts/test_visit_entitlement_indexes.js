const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const VisitEntitlement = require("../models/VisitEntitlement");
const {
  CHECKOUT_SESSION_INDEX_NAME,
  PAYMENT_INTENT_INDEX_NAME,
  STRIPE_ID_INDEXES,
  ensureVisitEntitlementIndexes,
  indexMatchesSpec,
  isStaleStripeIdIndex,
} = require("../utils/visitEntitlementIndexSafety");

function requiredEntitlementFields(suffix = "") {
  return {
    user: new mongoose.Types.ObjectId(),
    userId: `PF-${suffix || crypto.randomUUID()}`,
    addressId: new mongoose.Types.ObjectId(),
    status: "pending_payment",
  };
}

function findSchemaIndex(name) {
  return VisitEntitlement.schema
    .indexes()
    .find(([, options]) => options?.name === name);
}

function makeFakeCollection(indexes) {
  const state = {
    indexes: indexes.map((index) => ({ ...index, key: { ...index.key } })),
    dropped: [],
    created: [],
  };

  return {
    name: "visitentitlements",
    async indexes() {
      return state.indexes.map((index) => ({
        ...index,
        key: { ...index.key },
        partialFilterExpression: index.partialFilterExpression
          ? JSON.parse(JSON.stringify(index.partialFilterExpression))
          : undefined,
      }));
    },
    async dropIndex(name) {
      state.dropped.push(name);
      state.indexes = state.indexes.filter((index) => index.name !== name);
    },
    async createIndex(keys, options) {
      state.created.push({ keys, options });
      state.indexes = state.indexes.filter((index) => index.name !== options.name);
      state.indexes.push({
        name: options.name,
        key: keys,
        unique: !!options.unique,
        partialFilterExpression: options.partialFilterExpression,
      });
      return options.name;
    },
    state,
  };
}

async function testSchemaIndexes() {
  for (const spec of STRIPE_ID_INDEXES) {
    const schemaIndex = findSchemaIndex(spec.options.name);
    assert(schemaIndex, `Missing schema index ${spec.options.name}`);
    assert.deepEqual(schemaIndex[0], spec.keys);
    assert.equal(schemaIndex[1].unique, true);
    assert.deepEqual(
      schemaIndex[1].partialFilterExpression,
      spec.options.partialFilterExpression
    );
  }
}

async function testPendingEntitlementsCanHaveNullStripeIds() {
  const first = new VisitEntitlement(requiredEntitlementFields("one"));
  const second = new VisitEntitlement(requiredEntitlementFields("two"));

  await first.validate();
  await second.validate();

  assert.equal(first.stripeCheckoutSessionId, null);
  assert.equal(second.stripeCheckoutSessionId, null);
  assert.equal(first.stripePaymentIntentId, null);
  assert.equal(second.stripePaymentIntentId, null);
}

async function testStaleIndexRepair() {
  const collection = makeFakeCollection([
    { name: "_id_", key: { _id: 1 }, unique: true },
    {
      name: CHECKOUT_SESSION_INDEX_NAME,
      key: { stripeCheckoutSessionId: 1 },
      unique: true,
    },
    {
      name: "stripePaymentIntentId_1",
      key: { stripePaymentIntentId: 1 },
      unique: true,
    },
  ]);

  const model = {
    collection,
  };

  assert.equal(
    isStaleStripeIdIndex(collection.state.indexes[1], STRIPE_ID_INDEXES[0]),
    true
  );

  const result = await ensureVisitEntitlementIndexes({
    model,
    logger: { log() {}, warn() {} },
  });

  assert.deepEqual(result.dropped.sort(), [
    CHECKOUT_SESSION_INDEX_NAME,
    "stripePaymentIntentId_1",
  ].sort());
  assert.equal(collection.state.created.length, 2);

  const repaired = await collection.indexes();
  for (const spec of STRIPE_ID_INDEXES) {
    const index = repaired.find((entry) => entry.name === spec.options.name);
    assert(indexMatchesSpec(index, spec), `${spec.options.name} was not repaired`);
  }
}

async function testLiveMongoBehaviorIfConfigured() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.log("MONGO_URI not set; skipped live VisitEntitlement insert/index probe.");
    return;
  }

  const collectionName = `_visit_entitlement_index_probe_${Date.now()}`;
  await mongoose.connect(mongoUri, { autoIndex: false });

  const Probe = mongoose.model(
    `VisitEntitlementIndexProbe_${Date.now()}`,
    VisitEntitlement.schema.clone(),
    collectionName
  );

  try {
    await Probe.init();
    await Probe.create(requiredEntitlementFields("live-one"));
    await Probe.create(requiredEntitlementFields("live-two"));

    await Probe.create({
      ...requiredEntitlementFields("live-three"),
      stripeCheckoutSessionId: "cs_duplicate_probe",
    });

    await assert.rejects(
      Probe.create({
        ...requiredEntitlementFields("live-four"),
        stripeCheckoutSessionId: "cs_duplicate_probe",
      }),
      /E11000|duplicate key/i
    );

    await Probe.create({
      ...requiredEntitlementFields("live-five"),
      stripePaymentIntentId: "pi_duplicate_probe",
    });

    await assert.rejects(
      Probe.create({
        ...requiredEntitlementFields("live-six"),
        stripePaymentIntentId: "pi_duplicate_probe",
      }),
      /E11000|duplicate key/i
    );

    console.log("Live VisitEntitlement index probe passed");
  } finally {
    await mongoose.connection.dropCollection(collectionName).catch(() => {});
    await mongoose.disconnect().catch(() => {});
  }
}

async function run() {
  await testSchemaIndexes();
  await testPendingEntitlementsCanHaveNullStripeIds();
  await testStaleIndexRepair();
  await testLiveMongoBehaviorIfConfigured();
  console.log("VisitEntitlement index tests passed");
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
