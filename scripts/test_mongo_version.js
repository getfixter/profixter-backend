/**
 * Which MongoDB the backend suite really runs against, stated and enforced.
 *
 * The suite runs on mongodb-memory-server. In CI the version is pinned with
 * MONGOMS_VERSION (.github/workflows/deploy-eb.yml); this starts the same
 * server the other suites start, reads the server's own buildInfo, prints it,
 * and fails when it differs from the pinned version. A run against a system
 * binary of another major (MONGOMS_SYSTEM_BINARY) is reported plainly, so a
 * local substitute is never mistaken for CI's version.
 *
 *   node scripts/test_mongo_version.js
 */
const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

(async () => {
  const pinned = String(process.env.MONGOMS_VERSION || "").trim();
  const system = String(process.env.MONGOMS_SYSTEM_BINARY || "").trim();
  const repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri());
  let failed = 0;
  try {
    const info = await mongoose.connection.db.admin().buildInfo();
    console.log(`MongoDB under test: ${info.version}${system ? ` (system binary ${system})` : " (mongodb-memory-server download)"}${pinned ? `, pinned ${pinned}` : ", not pinned"}`);
    if (pinned) assert.strictEqual(info.version, pinned, `the suite must run on the pinned MongoDB ${pinned}, not ${info.version}`);
    console.log("  PASS  MongoDB version stated" + (pinned ? " and equal to the pinned one" : ""));
  } catch (error) {
    failed = 1;
    console.log(`  FAIL  ${error.message}`);
  } finally {
    await mongoose.disconnect();
    await repl.stop();
  }
  console.log(failed ? "\n0 passed, 1 failed" : "\n1 passed, 0 failed");
  process.exit(failed);
})();
