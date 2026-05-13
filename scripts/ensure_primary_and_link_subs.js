// scripts/ensure_primary_and_link_subs.js
require("dotenv").config();
const mongoose = require("mongoose");

const User = require("../models/User");
const Subscription = require("../models/Subscription");

const DRY_RUN = process.argv.includes("--dry");

function toSnapshot(a) {
  if (!a) return undefined;
  return {
    line1: a.line1,
    city: a.city,
    state: a.state,
    zip: a.zip,
    county: a.county || "",
  };
}

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("❌ MONGO_URI missing");
    process.exit(1);
  }

  await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log("✅ Connected to MongoDB");

  let usersFixed = 0;
  let usersCreatedFromLegacy = 0;
  let subsFixed = 0;
  let subsNoAddressAndNoLegacy = 0;

  const cursor = User.find().cursor();

  for (let user = await cursor.next(); user != null; user = await cursor.next()) {
    let changedUser = false;

    // 1) Ensure user has at least one address + defaultAddressId
    const hasDefault = user.defaultAddressId && user.addresses.id(user.defaultAddressId);
    const hasAddresses = Array.isArray(user.addresses) && user.addresses.length > 0;

    if (!hasAddresses) {
      // Try to build from legacy fields (your DB currently has one legacy address for each customer)
      const line1 = (user.address || "").trim();
      const city = (user.city || "").trim();
      const state = (user.state || "NY").trim();
      const zip = (user.zip || "").trim();
      const county = (user.county || "").trim();

      if (line1 && city && state && zip) {
        const newAddr = {
          label: "Primary",
          line1, city, state, zip, county,
        };
        if (!DRY_RUN) user.addresses.push(newAddr);
        usersCreatedFromLegacy++;
        changedUser = true;
        // set default to the one we just pushed
        if (!DRY_RUN) user.defaultAddressId = user.addresses[user.addresses.length - 1]._id;
      } else {
        // No usable legacy address; leave as-is (rare)
      }
    }

    // If addresses exist but default is missing/wrong → set to first
    if ((user.addresses?.length ?? 0) > 0 && !hasDefault) {
      if (!DRY_RUN) user.defaultAddressId = user.addresses[0]._id;
      changedUser = true;
    }

    if (changedUser) {
      if (!DRY_RUN) await user.save();
      usersFixed++;
      console.log(`• Ensured default for ${user.email} (userId=${user.userId})`);
    }

    // 2) Link subscriptions to default address
    const defaultSubdoc = user.defaultAddressId ? user.addresses.id(user.defaultAddressId) : null;

    const subs = await Subscription.find({ user: user._id });
    for (const sub of subs) {
      const needsFix = !sub.addressId || !mongoose.isValidObjectId(sub.addressId);
      if (needsFix) {
        if (defaultSubdoc) {
          if (!DRY_RUN) {
            sub.addressId = defaultSubdoc._id;
            sub.addressSnapshot = toSnapshot(defaultSubdoc);
            await sub.save();
          }
          subsFixed++;
          console.log(`  → Linked sub ${sub._id} to ${user.email} addr ${defaultSubdoc.line1}`);
        } else {
          // No default AND no legacy to build from (very rare)
          subsNoAddressAndNoLegacy++;
          console.warn(`  ⚠ No address to link for sub ${sub._id} (${user.email})`);
        }
      }
    }
  }

  console.log("\n===== SUMMARY =====");
  console.log(`Users with default ensured: ${usersFixed}`);
  console.log(`Users created address from legacy: ${usersCreatedFromLegacy}`);
  console.log(`Subscriptions linked to default address: ${subsFixed}`);
  console.log(`Subscriptions left unlinked (no address data available): ${subsNoAddressAndNoLegacy}`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "WRITE MODE"}`);

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("❌ Script error:", e);
  process.exit(1);
});
