require("dotenv").config();
const mongoose = require("mongoose");
const { ensureVisitEntitlementIndexes } = require("../utils/visitEntitlementIndexSafety");
const VisitEntitlement = require("../models/VisitEntitlement");

async function run() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI or MONGODB_URI is required");
  }

  await mongoose.connect(mongoUri, { autoIndex: false });
  const before = await VisitEntitlement.collection.indexes().catch((error) => {
    if (/ns not found|namespace.*not found/i.test(String(error?.message || ""))) {
      return [];
    }
    throw error;
  });

  console.log(
    "VisitEntitlement indexes before:",
    before.map((index) => ({
      name: index.name,
      key: index.key,
      unique: !!index.unique,
      partialFilterExpression: index.partialFilterExpression || null,
    }))
  );

  const result = await ensureVisitEntitlementIndexes({ model: VisitEntitlement });
  const after = await VisitEntitlement.collection.indexes();

  console.log("VisitEntitlement index repair result:", result);
  console.log(
    "VisitEntitlement indexes after:",
    after.map((index) => ({
      name: index.name,
      key: index.key,
      unique: !!index.unique,
      partialFilterExpression: index.partialFilterExpression || null,
    }))
  );
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
