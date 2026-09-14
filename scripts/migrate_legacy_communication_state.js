/**
 * Mark the accounts that predate the current consent system.
 *
 * WHAT THIS DOES, AND THE MUCH LONGER LIST OF WHAT IT DOES NOT
 *
 * It writes four fields recording that an account existed before ProFixter
 * started asking properly about messaging. That is all. It grants nothing,
 * enables nothing and sends nothing.
 *
 * It does NOT set transactionalEnabled, does not set marketingEnabled, does
 * not write a consent timestamp or a consent source, and does not touch
 * smsPreferences at all. Those four things are what "consent" means in this
 * system, and the historical evidence does not support any of them: the old
 * required checkbox read "I agree to the Terms of Service and Privacy Policy"
 * and said nothing about messaging, while the Terms it pointed at said SMS
 * needed a separate opt-in that the form never offered. Recording a consent
 * these people were never asked for would be inventing it.
 *
 * WHO IS EXCLUDED, AND WHY EACH ONE
 *
 *   employee/internal  - staff accounts are not customers
 *   reserved domains   - .invalid/.test/.example cannot reach a person
 *   test-looking       - qa./test./seed. local parts
 *   deactivated        - isActive === false
 *   already marked     - idempotency; a re-run must not move the timestamp
 *
 * LATER CHOICES WIN, ALWAYS
 *
 * The marker is provenance about the past, so it cannot conflict with a
 * present-day preference - but the rule is enforced anyway rather than argued.
 * An account carrying a STOP, an explicit opt-out, or any affirmative consent
 * it made itself is left entirely alone, because those records describe
 * something the customer actually did and this script has nothing to add to
 * them.
 *
 *   node scripts/migrate_legacy_communication_state.js            # dry run
 *   node scripts/migrate_legacy_communication_state.js --execute  # apply
 */
const mongoose = require("mongoose");

const SOURCE = "pre_current_consent_registration";
const EXECUTE = process.argv.includes("--execute");

const RESERVED_DOMAIN = /\.(invalid|test|localhost|example)$/i;
const TEST_LOCAL_PART = /^(test|qa|seed|demo|dummy|sample|fixture)[._-]/i;

function domainOf(email) {
  return String(email || "").toLowerCase().split("@")[1] || "";
}

/** Why this account is not part of the legitimate registered population. */
function exclusionReason(user, adminEmail) {
  const email = String(user.email || "").toLowerCase();

  if (user.role === "employee" || user.role === "admin" || user.employeePosition) {
    return "employee/internal";
  }
  if (adminEmail && email === adminEmail) return "admin";
  if (RESERVED_DOMAIN.test(domainOf(email))) return "reserved domain (test)";
  if (TEST_LOCAL_PART.test(email)) return "test-looking local part";
  if (user.isActive === false) return "deactivated";
  if (user.legacyRegisteredUser === true) return "already marked (idempotent)";

  /*
   * Anything the customer did themselves outranks a note about their past.
   * None of these exist in the current data, but the rule is code rather than
   * a claim so it still holds the day one of them does.
   */
  const prefs = user.smsPreferences || {};
  if (prefs.optedOutAt) return "later choice: opted out";
  if (prefs.transactionalEnabled === true || prefs.marketingEnabled === true) {
    return "later choice: gave real consent";
  }
  if (prefs.transactionalEnabled === false || prefs.marketingEnabled === false) {
    return "later choice: disabled it themselves";
  }
  return null;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

  const db = mongoose.connection.db;
  const users = db.collection("users");
  const adminEmail = String(process.env.ADMIN_EMAIL || "").toLowerCase();

  /* Counts that must not move. Captured before anything is written. */
  const before = {
    users: await users.countDocuments(),
    smsRows: await db.collection("smsmessages").countDocuments(),
    smsSent: await db
      .collection("smsmessages")
      .countDocuments({ status: { $in: ["sent", "delivered"] } }),
    providerSends: await db
      .collection("smsmessages")
      .countDocuments({ providerMessageSid: { $nin: [null, ""] } }),
    emailRows: await db.collection("emaillogs").countDocuments(),
    optOuts: await db.collection("smsoptouts").countDocuments(),
    transactionalTrue: await users.countDocuments({ "smsPreferences.transactionalEnabled": true }),
    marketingTrue: await users.countDocuments({ "smsPreferences.marketingEnabled": true }),
  };

  const all = await users.find({}).toArray();
  const eligible = [];
  const excluded = {};

  for (const user of all) {
    const reason = exclusionReason(user, adminEmail);
    if (reason) {
      (excluded[reason] = excluded[reason] || []).push(user);
      continue;
    }
    eligible.push(user);
  }

  console.log(`\n=== LEGACY COMMUNICATION STATE — ${EXECUTE ? "EXECUTE" : "DRY RUN"} ===\n`);
  console.log(`  total User records                 : ${all.length}`);
  console.log(`  ELIGIBLE to mark as legacy         : ${eligible.length}`);
  console.log(`\n  excluded, by category:`);
  for (const [reason, list] of Object.entries(excluded).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`    ${reason.padEnd(34)} ${String(list.length).padStart(4)}`);
    for (const u of list) {
      console.log(`        ${String(u.email || "(no email)").replace(/^(.{2}).*@/, "$1***@")}`);
    }
  }

  const withRole = eligible.filter((u) => u.role === "customer").length;
  console.log(`\n  of the eligible:`);
  console.log(`    role === "customer"              : ${withRole}`);
  console.log(`    role field absent (pre-dates it) : ${eligible.length - withRole}`);
  console.log(`    with a phone number              : ${eligible.filter((u) => String(u.phone || "").trim()).length}`);
  console.log(`    with a registration timestamp    : ${eligible.filter((u) => u.createdAt).length}`);

  if (!EXECUTE) {
    console.log(`\n  DRY RUN — nothing written. Re-run with --execute to apply.\n`);
    await mongoose.disconnect();
    return;
  }

  const migratedAt = new Date();
  let written = 0;
  for (const user of eligible) {
    const set = {
      legacyRegisteredUser: true,
      legacyCommunicationStateSource: SOURCE,
      legacyCommunicationStateMigratedAt: migratedAt,
    };
    /*
     * The registration timestamp is the only historical evidence that exists
     * for these accounts, so it is snapshotted. Where even that is missing the
     * field stays null rather than being invented.
     */
    if (user.createdAt) set.legacyRegisteredAt = user.createdAt;

    const result = await users.updateOne({ _id: user._id }, { $set: set });
    if (result.modifiedCount) written += 1;
  }

  const after = {
    users: await users.countDocuments(),
    smsRows: await db.collection("smsmessages").countDocuments(),
    smsSent: await db
      .collection("smsmessages")
      .countDocuments({ status: { $in: ["sent", "delivered"] } }),
    providerSends: await db
      .collection("smsmessages")
      .countDocuments({ providerMessageSid: { $nin: [null, ""] } }),
    emailRows: await db.collection("emaillogs").countDocuments(),
    optOuts: await db.collection("smsoptouts").countDocuments(),
    transactionalTrue: await users.countDocuments({ "smsPreferences.transactionalEnabled": true }),
    marketingTrue: await users.countDocuments({ "smsPreferences.marketingEnabled": true }),
  };

  console.log(`\n  marked as legacy                   : ${written}`);
  console.log(`\n=== BEFORE / AFTER ===`);
  let drift = 0;
  for (const key of Object.keys(before)) {
    const same = before[key] === after[key];
    if (!same && key !== "users") drift += 1;
    console.log(
      `  ${key.padEnd(20)} ${String(before[key]).padStart(6)} -> ${String(after[key]).padStart(6)}  ${same ? "unchanged" : "CHANGED"}`
    );
  }
  console.log(
    drift === 0
      ? `\n  ZERO communications generated, and no consent field moved.\n`
      : `\n  ${drift} COUNTER MOVED — investigate before trusting this run.\n`
  );

  await mongoose.disconnect();
  process.exitCode = drift === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error("migration failed:", error.message);
  process.exit(1);
});
