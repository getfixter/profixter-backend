require("dotenv").config();
const crypto = require("node:crypto");
const mongoose = require("mongoose");

const COLLECTION_NAME = "_mongo_transaction_probe";

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  return error;
}

function topologySummary(hello) {
  const isMongos = hello?.msg === "isdbgrid";
  const replicaSetName = hello?.setName || null;
  return {
    isMongos,
    replicaSetName,
    appearsTransactionCapable: isMongos || !!replicaSetName,
    type: isMongos
      ? "mongos/sharded cluster"
      : replicaSetName
        ? "replica set"
        : "standalone or unknown",
  };
}

async function readTopology(admin) {
  try {
    return await admin.command({ hello: 1 });
  } catch (error) {
    if (
      error?.code === 59 ||
      error?.codeName === "CommandNotFound" ||
      /no such command.*hello/i.test(String(error?.message || ""))
    ) {
      return admin.command({ isMaster: 1 });
    }
    throw error;
  }
}

async function insertInTransaction(collection, document, commit) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction({
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    });
    await collection.insertOne(document, { session });
    if (commit) {
      await session.commitTransaction();
    } else {
      await session.abortTransaction();
    }
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction().catch(() => {});
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

async function run() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw fail(
      "FAIL: MONGO_URI is required. Run this from EB or another environment with the production MONGO_URI.",
      2
    );
  }
  if (
    String(process.env.ENABLE_RESERVATION_ENGINE || "false").toLowerCase() ===
    "true"
  ) {
    throw fail(
      "FAIL: ENABLE_RESERVATION_ENGINE must remain false while running this probe.",
      2
    );
  }

  const probeId = `${Date.now()}-${crypto.randomUUID()}`;
  const abortedId = `abort-${probeId}`;
  const committedId = `commit-${probeId}`;
  let collection;

  try {
    await mongoose.connect(mongoUri, {
      autoIndex: false,
      serverSelectionTimeoutMS: 10000,
    });
    collection = mongoose.connection.db.collection(COLLECTION_NAME);

    const hello = await readTopology(mongoose.connection.db.admin());
    const topology = topologySummary(hello);
    console.log(`Topology: ${topology.type}`);
    if (topology.replicaSetName) {
      console.log(`Replica set: ${topology.replicaSetName}`);
    }
    if (!topology.appearsTransactionCapable) {
      console.warn(
        "WARNING: topology appears standalone; multi-document transactions are not expected to work."
      );
    }

    await insertInTransaction(
      collection,
      {
        _id: abortedId,
        probeId,
        phase: "abort",
        createdAt: new Date(),
      },
      false
    );
    const abortedDocument = await collection.findOne({ _id: abortedId });
    if (abortedDocument) {
      throw fail("FAIL: aborted transaction document still exists.");
    }
    console.log("Abort verification: PASS");

    await insertInTransaction(
      collection,
      {
        _id: committedId,
        probeId,
        phase: "commit",
        createdAt: new Date(),
      },
      true
    );
    const committedDocument = await collection.findOne({ _id: committedId });
    if (!committedDocument) {
      throw fail("FAIL: committed transaction document was not found.");
    }
    console.log("Commit verification: PASS");

    await collection.deleteOne({ _id: committedId, probeId });
    const remainingDocument = await collection.findOne({
      _id: { $in: [abortedId, committedId] },
    });
    if (remainingDocument) {
      throw fail("FAIL: probe cleanup did not remove all probe documents.");
    }
    console.log("Cleanup verification: PASS");
    console.log(
      "PASS: MongoDB transactions are supported for reservation-engine writes."
    );
  } finally {
    if (collection) {
      await collection
        .deleteMany({ _id: { $in: [abortedId, committedId] }, probeId })
        .catch((error) =>
          console.error(`WARNING: final probe cleanup failed: ${error.message}`)
        );
    }
    await mongoose.disconnect().catch(() => {});
  }
}

run().catch((error) => {
  const message = String(error?.message || error);
  console.error(message.startsWith("FAIL:") ? message : `FAIL: ${message}`);
  process.exitCode = error.exitCode || 1;
});

module.exports = {
  insertInTransaction,
  readTopology,
  topologySummary,
};
