/**
 * Usage:
 *   node scripts/migrate_addresses.js
 *
 * Requires MONGODB_URI in your env (.env is fine).
 */
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("❌ Missing MONGODB_URI env var");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("✅ Connected to MongoDB");

  const users = await User.find({});
  let updated = 0;

  for (const u of users) {
    // already migrated?
    if (u.addresses?.length > 0 && u.defaultAddressId) continue;

    const primary = {
      label: "Primary",
      line1: u.address || "",
      city:  u.city    || "",
      state: u.state   || "NY",
      zip:   u.zip     || "",
      county:u.county  || "",
    };

    const looksValid =
      (primary.line1 && primary.city && primary.state && primary.zip) ||
      (primary.line1 && primary.zip);

    if (!looksValid) {
      console.log(`⚠️  Skipping ${u.email} — missing address pieces`);
      continue;
    }

    u.addresses = u.addresses || [];
    u.addresses.unshift(primary);
    u.defaultAddressId = u.addresses[0]._id;

    await u.save();
    updated++;
    console.log(`→ Migrated ${u.email} (defaultAddressId=${u.defaultAddressId})`);
  }

  console.log(`✅ Done. Users updated: ${updated}`);
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error("❌ Migration failed:", err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
