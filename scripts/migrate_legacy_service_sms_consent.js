/**
 * Carry the historical registration forward as service-SMS permission.
 *
 * WHAT THIS IS, SAID HONESTLY
 *
 * 156 accounts registered under the previous process. ProFixter has since
 * decided that service texts are part of having an account - the signup form
 * now requires them - and this represents those existing accounts consistently
 * with that position.
 *
 * It does NOT claim they ticked today's checkbox. The source is written as
 * legacy_registration_migration, never signup_web_form, and the consent
 * timestamp is their ORIGINAL REGISTRATION DATE rather than the afternoon
 * somebody ran this. When we ran it is recorded separately, in
 * legacyConsentMigration.migratedAt, because those are two different facts and
 * flattening them would make every legacy account look like it consented at
 * the same instant.
 *
 * MARKETING IS NOT TOUCHED. Not by inference from service consent, not at all.
 * A promotional text still requires its own box, ticked by the person.
 *
 * WHAT ALWAYS WINS
 *
 * Every later thing a customer did outranks this, and each is a separate
 * check rather than one broad condition, so a future reader can see which
 * protection is which:
 *
 *   a carrier STOP on the handset          - absolute, never overridden
 *   an opt-out recorded on the account
 *   service texts they switched off themselves
 *   consent they gave through today's form - not overwritten with a legacy source
 *
 * IDEMPOTENT. Re-running changes nothing: an account already carrying this
 * migration version is skipped, so the timestamps cannot drift on a second run.
 *
 *   node scripts/migrate_legacy_service_sms_consent.js            # dry run
 *   node scripts/migrate_legacy_service_sms_consent.js --execute  # apply
 */
const mongoose = require("mongoose");

const VERSION = "legacy_service_sms_v1";
const CONSENT_SOURCE = "legacy_registration_migration";
const BASIS = "historical_legacy_migration";
const EXECUTE = process.argv.includes("--execute");

function reasonToSkip(user, optOutPhones) {
  const prefs = user.smsPreferences || {};

  if (user.legacyRegisteredUser !== true) return "not a legacy registered account";

  /* A STOP is a property of the handset and outranks everything here. */
  const phone = String(user.phone || "").trim();
  if (phone && optOutPhones.has(phone)) return "carrier STOP on the handset";
  if (prefs.optedOutAt) return "opt-out recorded on the account";

  if (prefs.transactionalEnabled === false) return "customer switched service texts off";
  if (prefs.transactionalConsentSource === "signup_web_form") {
    return "already consented through the current form";
  }
  if (prefs.transactionalEnabled === true) return "already has service consent";
  if (user.legacyConsentMigration?.version === VERSION) return "already migrated (idempotent)";

  return null;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

  const db = mongoose.connection.db;
  const users = db.collection("users");

  const before = {
    users: await users.countDocuments(),
    smsRows: await db.collection("smsmessages").countDocuments(),
    smsQueued: await db
      .collection("smsmessages")
      .countDocuments({ status: { $in: ["pending", "sending", "retry_scheduled"] } }),
    providerSends: await db
      .collection("smsmessages")
      .countDocuments({ providerMessageSid: { $nin: [null, ""] } }),
    emailRows: await db.collection("emaillogs").countDocuments(),
    marketingTrue: await users.countDocuments({ "smsPreferences.marketingEnabled": true }),
    optOuts: await db.collection("smsoptouts").countDocuments(),
  };

  const optOutPhones = new Set(
    (await db.collection("smsoptouts").find({}).project({ phone: 1 }).toArray()).map((r) =>
      String(r.phone || "").trim()
    )
  );

  const all = await users.find({}).toArray();
  const eligible = [];
  const skipped = {};
  for (const user of all) {
    const reason = reasonToSkip(user, optOutPhones);
    if (reason) {
      (skipped[reason] = skipped[reason] || []).push(user);
      continue;
    }
    eligible.push(user);
  }

  console.log(`\n=== LEGACY SERVICE-SMS CONSENT — ${EXECUTE ? "EXECUTE" : "DRY RUN"} ===\n`);
  console.log(`  total User records                 : ${all.length}`);
  console.log(`  WOULD RECEIVE legacy service consent: ${eligible.length}`);
  console.log(`\n  skipped, by reason:`);
  for (const [reason, list] of Object.entries(skipped).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${reason.padEnd(42)} ${String(list.length).padStart(4)}`);
  }
  console.log(`\n  of those eligible:`);
  console.log(`    have an original registration date : ${eligible.filter((u) => u.createdAt).length}`);
  console.log(`    have a phone number                : ${eligible.filter((u) => String(u.phone || "").trim()).length}`);
  console.log(`    would gain MARKETING consent       : 0  (never granted here)`);

  if (!EXECUTE) {
    console.log(`\n  DRY RUN — nothing written. Re-run with --execute to apply.\n`);
    await mongoose.disconnect();
    return;
  }

  const migratedAt = new Date();
  let written = 0;
  for (const user of eligible) {
    /*
     * The customer's own registration date is the consent timestamp. Where an
     * account somehow has none, the migration timestamp is used and the
     * provenance record says so rather than passing it off as historical.
     */
    const historical = user.createdAt || user.legacyRegisteredAt || null;
    await users.updateOne(
      { _id: user._id },
      {
        $set: {
          "smsPreferences.transactionalEnabled": true,
          "smsPreferences.transactionalConsentAt": historical || migratedAt,
          "smsPreferences.transactionalConsentSource": CONSENT_SOURCE,
          communicationStateBasis: BASIS,
          legacyConsentMigration: {
            version: VERSION,
            migratedAt,
            basis: historical
              ? "pre_current_consent_registration"
              : "pre_current_consent_registration_no_historical_date",
            historicalRegisteredAt: historical,
          },
        },
      }
    );
    written += 1;
  }

  const after = {
    users: await users.countDocuments(),
    smsRows: await db.collection("smsmessages").countDocuments(),
    smsQueued: await db
      .collection("smsmessages")
      .countDocuments({ status: { $in: ["pending", "sending", "retry_scheduled"] } }),
    providerSends: await db
      .collection("smsmessages")
      .countDocuments({ providerMessageSid: { $nin: [null, ""] } }),
    emailRows: await db.collection("emaillogs").countDocuments(),
    marketingTrue: await users.countDocuments({ "smsPreferences.marketingEnabled": true }),
    optOuts: await db.collection("smsoptouts").countDocuments(),
  };

  console.log(`\n  migrated : ${written}`);
  console.log(`\n=== BEFORE / AFTER (none of these may move) ===`);
  let drift = 0;
  for (const key of Object.keys(before)) {
    const same = before[key] === after[key];
    if (!same) drift += 1;
    console.log(
      `  ${key.padEnd(16)} ${String(before[key]).padStart(6)} -> ${String(after[key]).padStart(6)}  ${same ? "unchanged" : "CHANGED"}`
    );
  }
  console.log(
    drift === 0
      ? `\n  ZERO messages, zero queued sends, zero marketing consent granted.\n`
      : `\n  ${drift} COUNTER MOVED — investigate before trusting this run.\n`
  );

  await mongoose.disconnect();
  process.exitCode = drift === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error("migration failed:", error.message);
  process.exit(1);
});
