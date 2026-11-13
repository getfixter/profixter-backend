/*
 * Backfill Blacklist.phoneDigits and normalize Blacklist.email (review fix 3,
 * 2026-11-13).
 *
 * Entries written before phoneDigits existed carry only a raw `phone` in
 * whatever spelling Admin typed, and some older entries may hold an email
 * with stray case or spaces. utils/customerBlock.js still matches the raw
 * phone spellings, but a normalized row is matched by the indexed fields and
 * shows the same everywhere (block check, unblock, history).
 *
 * Idempotent: a row already normalized is left alone, so running it twice
 * changes nothing the second time. Lifted entries are normalized too (they
 * are history and are matched by the history view).
 *
 * DRY RUN BY DEFAULT. Nothing is written without --write.
 *
 *   MONGO_URI=... node scripts/backfill_blacklist_normalization.js          # report only
 *   MONGO_URI=... node scripts/backfill_blacklist_normalization.js --write  # apply
 *
 * Release step: run the dry run against production after the backend is
 * deployed, review the counts, then run with --write. Not run by CI.
 */
const mongoose = require("mongoose");
const Blacklist = require("../models/Blacklist");
const { blacklistPhoneDigits } = require("../models/Blacklist");

function normalizedEmail(value) {
  if (value === undefined || value === null) return value;
  return String(value).trim().toLowerCase();
}

/** Computes (and with write:true applies) the changes. Uses the current mongoose connection. */
async function backfillBlacklist({ write = false } = {}) {
  const report = { mode: write ? "write" : "dry-run", scanned: 0, phoneDigitsSet: 0, emailNormalized: 0, rowsChanged: 0, rowsUpdated: 0 };
  // The raw collection: lifted entries included, no middleware.
  const cursor = Blacklist.collection.find({}, { projection: { phone: 1, phoneDigits: 1, email: 1 } });
  for await (const row of cursor) {
    report.scanned += 1;
    const set = {};
    const digits = blacklistPhoneDigits(row.phone);
    if ((row.phoneDigits || "") !== digits) {
      set.phoneDigits = digits;
      report.phoneDigitsSet += 1;
    }
    if (typeof row.email === "string") {
      const email = normalizedEmail(row.email);
      if (email !== row.email) {
        set.email = email;
        report.emailNormalized += 1;
      }
    }
    if (!Object.keys(set).length) continue;
    report.rowsChanged += 1;
    if (write) {
      await Blacklist.collection.updateOne({ _id: row._id }, { $set: set });
      report.rowsUpdated += 1;
    }
  }
  return report;
}

async function main() {
  require("dotenv").config();
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI/MONGODB_URI is required");
  const write = process.argv.includes("--write");
  await mongoose.connect(uri, { autoIndex: false });
  const report = await backfillBlacklist({ write });
  report.database = mongoose.connection.name;
  await mongoose.disconnect();
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(error?.message || error);
    try {
      await mongoose.disconnect();
    } catch {
      // ignore
    }
    process.exit(1);
  });
}

module.exports = { backfillBlacklist };
