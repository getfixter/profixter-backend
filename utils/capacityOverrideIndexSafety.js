const CapacityOverride = require("../models/CapacityOverride");

const UNIQUE_INDEX_NAME = "one_capacity_override_per_scope_date_range";
const AUDIT_COMMAND = "node scripts/audit_capacity_override_duplicates.js";

function isDuplicateKeyIndexError(error) {
  return (
    error?.code === 11000 ||
    error?.code === 11001 ||
    error?.codeName === "DuplicateKey" ||
    /\bE11000\b.*duplicate key/i.test(String(error?.message || ""))
  );
}

async function ensureCapacityOverrideIndexes({
  model = CapacityOverride,
  logger = console,
} = {}) {
  let duplicateRecords = false;
  for (const [fields, options] of model.schema.indexes()) {
    const indexOptions = { ...options };
    delete indexOptions._autoIndex;
    try {
      await model.collection.createIndex(fields, indexOptions);
    } catch (error) {
      const isProtectedUniqueIndex = indexOptions.name === UNIQUE_INDEX_NAME;
      if (!isProtectedUniqueIndex || !isDuplicateKeyIndexError(error)) {
        throw error;
      }

      duplicateRecords = true;
      logger.warn(
        [
          "CapacityOverride unique index was not created because duplicate shadow records exist.",
          `Collection: ${model.collection.name}.`,
          `Index: ${UNIQUE_INDEX_NAME}.`,
          `Run: ${AUDIT_COMMAND}`,
        ].join(" ")
      );
    }
  }

  if (!duplicateRecords) {
    logger.log(
      `CapacityOverride indexes ready (${model.collection.name}/${UNIQUE_INDEX_NAME})`
    );
  }
  return { ready: !duplicateRecords, duplicateRecords };
}

module.exports = {
  AUDIT_COMMAND,
  UNIQUE_INDEX_NAME,
  ensureCapacityOverrideIndexes,
  isDuplicateKeyIndexError,
};
