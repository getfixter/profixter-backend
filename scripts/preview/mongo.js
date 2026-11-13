/**
 * A single-node MongoDB replica set for the preview, kept on disk.
 *
 * The reservation engine writes in transactions, which need a replica set, and
 * the preview keeps its data between restarts, so this runs the
 * mongodb-memory-server binary with a fixed dbPath and --replSet, initiates the
 * set once, and on later starts re-points the member at the current port if it
 * moved. Bound to 127.0.0.1 only.
 */

const fs = require("fs");
const { MongoMemoryServer } = require("mongodb-memory-server");
// The driver bundled with mongoose (there is no top-level mongodb package).
const { MongoClient } = require("mongoose").mongo;

const REPL_SET = "rs0";

async function waitForPrimary(client, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const hello = await client.db("admin").command({ hello: 1 });
      if (hello.isWritablePrimary) return;
    } catch {
      /* not yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The preview MongoDB did not become primary in time.");
}

async function startPersistentReplSet({ dbPath, port = 27555, dbName = "profixter_preview", log = console.log }) {
  fs.mkdirSync(dbPath, { recursive: true });
  const server = await MongoMemoryServer.create({
    instance: { dbPath, port, ip: "127.0.0.1", storageEngine: "wiredTiger", replSet: REPL_SET },
  });
  const actualPort = Number(new URL(server.getUri()).port);
  if (actualPort !== port) log(`[preview] MongoDB port ${port} was busy; using ${actualPort}`);
  const host = `127.0.0.1:${actualPort}`;

  const client = new MongoClient(`mongodb://${host}/?directConnection=true`, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const admin = client.db("admin");
  try {
    let config = null;
    try {
      ({ config } = await admin.command({ replSetGetConfig: 1 }));
    } catch (error) {
      if (error?.code !== 94 && error?.codeName !== "NotYetInitialized") throw error;
    }
    if (!config) {
      await admin.command({ replSetInitiate: { _id: REPL_SET, members: [{ _id: 0, host }] } });
      log(`[preview] MongoDB replica set initiated at ${host}`);
    } else if (config.members?.[0]?.host !== host) {
      config.members[0].host = host;
      config.version = Number(config.version || 1) + 1;
      await admin.command({ replSetReconfig: config, force: true });
      log(`[preview] MongoDB replica set moved to ${host}`);
    }
    await waitForPrimary(client);
  } finally {
    await client.close().catch(() => {});
  }

  return {
    server,
    uri: `mongodb://${host}/${dbName}?directConnection=true`,
    port: actualPort,
    async stop() {
      // doCleanup false: the dbPath is ours and must survive.
      await server.stop({ doCleanup: false, force: false }).catch(() => {});
    },
  };
}

module.exports = { startPersistentReplSet };
