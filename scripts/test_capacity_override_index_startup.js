const assert = require("node:assert/strict");
const {
  AUDIT_COMMAND,
  UNIQUE_INDEX_NAME,
  ensureCapacityOverrideIndexes,
} = require("../utils/capacityOverrideIndexSafety");

function fakeModel() {
  return {
    collection: { name: "capacityoverrides" },
    schema: {
      indexes: () => [
        [{ scopeType: 1 }, {}],
        [
          {
            scopeType: 1,
            technicianId: 1,
            date: 1,
            startTime: 1,
            endTime: 1,
          },
          { unique: true, name: UNIQUE_INDEX_NAME },
        ],
        [{ date: 1, scopeType: 1 }, {}],
      ],
    },
  };
}

async function run() {
  const messages = [];
  const logger = {
    log: (message) => messages.push({ level: "log", message }),
    warn: (message) => messages.push({ level: "warn", message }),
  };

  const ready = await ensureCapacityOverrideIndexes({
    model: {
      ...fakeModel(),
      collection: {
        name: "capacityoverrides",
        createIndex: async () => undefined,
      },
    },
    logger,
  });
  assert.deepEqual(ready, { ready: true, duplicateRecords: false });

  const duplicate = Object.assign(
    new Error("E11000 duplicate key error collection: test.capacityoverrides"),
    { code: 11000 }
  );
  const attemptedIndexes = [];
  const protectedResult = await ensureCapacityOverrideIndexes({
    model: {
      ...fakeModel(),
      collection: {
        name: "capacityoverrides",
        createIndex: async (fields, options) => {
          attemptedIndexes.push({ fields, options });
          if (options.name === UNIQUE_INDEX_NAME) throw duplicate;
        },
      },
    },
    logger,
  });
  assert.deepEqual(protectedResult, {
    ready: false,
    duplicateRecords: true,
  });
  assert.equal(attemptedIndexes.length, 3);
  const warning = messages.find((entry) => entry.level === "warn")?.message || "";
  assert.match(warning, /capacityoverrides/);
  assert.match(warning, new RegExp(UNIQUE_INDEX_NAME));
  assert.match(
    warning,
    new RegExp(AUDIT_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );

  await assert.rejects(
    ensureCapacityOverrideIndexes({
      model: {
        ...fakeModel(),
        collection: {
          name: "capacityoverrides",
          createIndex: async (_fields, options) => {
            if (!options.name) throw duplicate;
          },
        },
      },
      logger,
    }),
    (error) => error === duplicate
  );

  const serious = Object.assign(new Error("not authorized to create index"), {
    code: 13,
  });
  await assert.rejects(
    ensureCapacityOverrideIndexes({
      model: {
        ...fakeModel(),
        collection: {
          name: "capacityoverrides",
          createIndex: async () => {
            throw serious;
          },
        },
      },
      logger,
    }),
    (error) => error === serious
  );

  console.log("CapacityOverride startup index safety smoke test passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
