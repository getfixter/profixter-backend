/**
 * Where the visibility collectors keep their data and their bookkeeping.
 *
 * WHY AN INTERFACE AND NOT DIRECT MODEL CALLS. Every collector and summary
 * takes a `store` argument (defaulting to the Mongo one below), so the tests
 * can run the real collection and summary code end to end against an
 * in-memory store, with a fake fetch, and need neither a database nor the
 * network. The surface is deliberately tiny:
 *
 *   upsertSnapshots(rows)              idempotent on (source, date, key)
 *   findSnapshots({ source, from, to, key, date })   oldest date first
 *   latestDates(source, n)             the n most recent distinct dates
 *   readState(key) / writeState(key, value)          AnalyticsState documents
 *   takeLease(key, ms) / releaseLease(key)           one writer across instances
 *   available()                        false when the database is not connected
 *
 * `available()` exists because a Mongoose query on a disconnected connection
 * does not fail, it buffers for ten seconds. The Command Center should say
 * "unavailable" at once instead of hanging the Admin page.
 */
const lease = require("../analytics/analyticsLease");

function mongoStore() {
  const mongoose = require("mongoose");
  const model = () => require("../../models/VisibilitySnapshot");
  const state = () => require("../../models/AnalyticsState");

  return {
    available() {
      return mongoose.connection.readyState === 1;
    },

    async upsertSnapshots(rows) {
      if (!rows.length) return { upserted: 0, modified: 0 };
      const Snapshot = model();
      const result = await Snapshot.bulkWrite(
        rows.map((row) => ({
          updateOne: {
            filter: { source: row.source, date: row.date, key: row.key },
            update: { $set: { metrics: row.metrics, fetchedAt: row.fetchedAt } },
            upsert: true,
          },
        })),
        { ordered: false }
      );
      return { upserted: result.upsertedCount || 0, modified: result.modifiedCount || 0 };
    },

    async findSnapshots({ source, from, to, key, date } = {}) {
      const query = { source };
      if (date) query.date = date;
      else if (from || to) query.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
      if (key) query.key = key;
      return model().find(query).sort({ date: 1, key: 1 }).lean();
    },

    async latestDates(source, n = 2) {
      const dates = await model().distinct("date", { source });
      return dates.sort().reverse().slice(0, n);
    },

    async readState(key) {
      const doc = await state().findOne({ key }).lean();
      return doc?.value || null;
    },

    async writeState(key, value) {
      await state().updateOne({ key }, { $set: { value } }, { upsert: true });
    },

    takeLease: (key, ms) => lease.takeLease(key, ms),
    releaseLease: (key) => lease.releaseLease(key),
  };
}

/**
 * The same interface in memory. Used by scripts/test_visibility.js; also
 * handy for a dry run from a REPL. Leases are honoured within the process so
 * the tests exercise the "another instance holds it" path.
 */
function memoryStore() {
  const snapshots = new Map();
  const states = new Map();
  const leases = new Map();
  const id = (r) => `${r.source}\u0000${r.date}\u0000${r.key}`;

  return {
    snapshots,
    states,
    available: () => true,

    async upsertSnapshots(rows) {
      let upserted = 0;
      let modified = 0;
      for (const row of rows) {
        const k = id(row);
        if (snapshots.has(k)) modified += 1;
        else upserted += 1;
        snapshots.set(k, JSON.parse(JSON.stringify({ ...row, fetchedAt: new Date(row.fetchedAt).toISOString() })));
      }
      return { upserted, modified };
    },

    async findSnapshots({ source, from, to, key, date } = {}) {
      return [...snapshots.values()]
        .filter((r) => r.source === source)
        .filter((r) => (date ? r.date === date : (!from || r.date >= from) && (!to || r.date <= to)))
        .filter((r) => !key || r.key === key)
        .sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
    },

    async latestDates(source, n = 2) {
      const dates = new Set([...snapshots.values()].filter((r) => r.source === source).map((r) => r.date));
      return [...dates].sort().reverse().slice(0, n);
    },

    async readState(key) {
      return states.has(key) ? JSON.parse(JSON.stringify(states.get(key))) : null;
    },

    async writeState(key, value) {
      states.set(key, JSON.parse(JSON.stringify(value)));
    },

    async takeLease(key, ms) {
      const held = leases.get(key);
      if (held && held > Date.now()) return false;
      leases.set(key, Date.now() + ms);
      return true;
    },

    async releaseLease(key) {
      leases.delete(key);
    },
  };
}

let defaultStore = null;
function getDefaultStore() {
  if (!defaultStore) defaultStore = mongoStore();
  return defaultStore;
}

module.exports = { mongoStore, memoryStore, getDefaultStore };
