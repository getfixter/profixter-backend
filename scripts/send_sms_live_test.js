require("dotenv").config();
const mongoose = require("mongoose");

/**
 * The first real SMS, and only the first.
 *
 * WHY THIS EXISTS RATHER THAN SMS_ENABLED=true IN PRODUCTION.
 *
 * Every trigger is already wired into live routes: bookings, auth, password
 * reset, subscriptions and the Stripe webhook all call smsNotifications today
 * and are writing "simulated" rows. Flipping SMS_ENABLED on the production
 * environment does not send one text to one person - it releases booking
 * confirmations, assignment notices, membership changes and payment-failed
 * notices to every customer those events touch, from the first second.
 *
 * That is the wrong way to discover that the Messaging Service SID has a typo.
 *
 * So the master switch is set HERE, in this process only, for the duration of
 * one send to one number that has to be named on the command line. Production
 * keeps SMS_ENABLED=false throughout. Nothing about the deployed environment
 * changes, and there is no window during which the running API can text anyone.
 *
 * WHY IT GOES THROUGH enqueueSms AND NOT STRAIGHT AT THE PROVIDER.
 *
 * A raw provider call would prove Twilio accepts our credentials and nothing
 * else. The status callback finds its message by providerMessageSid, and with
 * no SmsMessage row there is nothing to find: the delivery receipt would be
 * logged and dropped, and SmsPhoneStatus would never move to "valid". Going
 * through the real send path is what makes the whole chain observable -
 * eligibility, the audit row, Twilio, the webhook, deliverability state.
 *
 * USAGE
 *   node scripts/send_sms_live_test.js --to +1XXXXXXXXXX              (dry run)
 *   node scripts/send_sms_live_test.js --to +1XXXXXXXXXX --confirm    (sends 1)
 *   node scripts/send_sms_live_test.js --to +1XXXXXXXXXX --check      (read back)
 *
 * Dry run is the default and touches neither Twilio nor the database. Only
 * --confirm sends, only to the single number given, and only once.
 */

const ARGS = process.argv.slice(2);

function flag(name) {
  return ARGS.includes(`--${name}`);
}

function value(name, fallback = "") {
  const index = ARGS.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const next = ARGS[index + 1];
  return next && !next.startsWith("--") ? next : fallback;
}

/**
 * The types this script may send, and no others.
 *
 * Transactional, addressable without an account, and harmless if the recipient
 * is confused by it. ACCOUNT_CREATED is the default because it carries the
 * standard opt-out line, which is what makes the STOP half of the test real.
 * Marketing types are absent on purpose: they require a consenting account and
 * a channel switch, and neither belongs in a smoke test.
 */
const ALLOWED_TYPES = new Set(["ACCOUNT_CREATED", "ACCOUNT_PASSWORD_CHANGED"]);

function fail(message) {
  console.error(`\n  REFUSED: ${message}\n`);
  process.exit(1);
}

async function main() {
  const { toE164, maskPhone } = require("../utils/sms/smsPhone");
  const { configSnapshot, twilioConfigured } = require("../utils/sms/smsConfig");

  const rawTo = value("to");
  if (!rawTo) {
    fail("--to is required. Name the destination number explicitly; there is no default.");
  }

  const to = toE164(rawTo);
  if (!to) fail(`--to "${rawTo}" is not a dialable North American number.`);

  const notificationType = value("type", "ACCOUNT_CREATED");
  if (!ALLOWED_TYPES.has(notificationType)) {
    fail(
      `--type ${notificationType} is not permitted here. Allowed: ${[...ALLOWED_TYPES].join(", ")}`
    );
  }

  if (!process.env.MONGO_URI) fail("MONGO_URI is required.");
  await mongoose.connect(process.env.MONGO_URI);

  const SmsMessage = require("../models/SmsMessage");
  const SmsOptOut = require("../models/SmsOptOut");
  const SmsPhoneStatus = require("../models/SmsPhoneStatus");

  /* ---------------------------------------------------------------- check -- */

  if (flag("check")) {
    const rows = await SmsMessage.find({ toPhone: to, source: "sms_live_test" })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();
    const [optOut, phoneStatus] = await Promise.all([
      SmsOptOut.findOne({ phone: to }).lean(),
      SmsPhoneStatus.findOne({ phone: to }).lean(),
    ]);

    console.log(`\n  Live-test messages to ${to}\n`);
    if (!rows.length) console.log("    (none yet)");
    for (const row of rows) {
      console.log(
        `    ${new Date(row.createdAt).toISOString()}  ${String(row.status).padEnd(16)}` +
          `sid=${row.providerMessageSid || "-"}  provider=${row.providerStatus || "-"}` +
          `${row.providerErrorCode ? `  err=${row.providerErrorCode}` : ""}` +
          `${row.suppressionReason ? `  reason=${row.suppressionReason}` : ""}` +
          `${row.deliveredAt ? `  deliveredAt=${new Date(row.deliveredAt).toISOString()}` : ""}`
      );
    }

    console.log(`\n  SmsPhoneStatus : ${phoneStatus ? phoneStatus.status : "unknown (no row)"}`);
    if (phoneStatus) {
      console.log(`    lastSuccessAt : ${phoneStatus.lastSuccessAt || "-"}`);
      console.log(
        `    lastFailureAt : ${phoneStatus.lastFailureAt || "-"} ${phoneStatus.lastFailureCode || ""}`
      );
    }
    console.log(`  SmsOptOut      : ${optOut ? `${optOut.scope} via ${optOut.source}` : "none"}`);
    if (optOut) {
      console.log(`    optedOutAt    : ${optOut.optedOutAt || "-"}`);
      console.log(`    optedInAt     : ${optOut.optedInAt || "-"}  (a START stamps this)`);
    }
    console.log("");
    await mongoose.disconnect();
    return;
  }

  /* ----------------------------------------------------------- pre-flight -- */

  const snapshot = configSnapshot();
  console.log("\n  Twilio configuration (presence only, never values)\n");
  for (const [key, val] of Object.entries(snapshot)) {
    console.log(`    ${key.padEnd(26)} ${val}`);
  }

  const [optOut, phoneStatus] = await Promise.all([
    SmsOptOut.findOne({ phone: to }).lean(),
    SmsPhoneStatus.findOne({ phone: to }).lean(),
  ]);

  console.log(`\n  Destination      ${to}   (masked in logs as ${maskPhone(to)})`);
  console.log(`  Notification     ${notificationType}`);
  console.log(`  Existing opt-out ${optOut ? `${optOut.scope} via ${optOut.source}` : "none"}`);
  console.log(`  Phone status     ${phoneStatus ? phoneStatus.status : "unknown"}`);

  if (!flag("confirm")) {
    console.log(
      "\n  DRY RUN. Nothing was sent and nothing was written.\n" +
        "  Re-run with --confirm to send exactly one message to the number above.\n"
    );
    await mongoose.disconnect();
    return;
  }

  if (!twilioConfigured()) {
    fail(
      "Twilio is not configured in this shell. Set TWILIO_ACCOUNT_SID, TWILIO_API_KEY, " +
        "TWILIO_API_SECRET and TWILIO_MESSAGING_SERVICE_SID."
    );
  }

  /*
   * The master switch, in this process and nowhere else.
   *
   * Set after every guard above has passed, so an argument mistake exits while
   * sending is still impossible. The deployed environment is untouched.
   */
  process.env.SMS_ENABLED = "true";

  const { sendTransactionalSms } = require("../utils/sms/smsService");

  const result = await sendTransactionalSms({
    notificationType,
    dedupeKey: `sms_live_test:${to}:${Date.now()}`,
    phone: to,
    vars: { name: value("name", "Taras") },
    source: "sms_live_test",
  });

  console.log("\n  Result\n");
  console.log(`    status  ${result.status}`);
  if (result.reason) console.log(`    reason  ${result.reason}`);
  if (result.sid) console.log(`    sid     ${result.sid}`);
  if (result.body) console.log(`    body    ${result.body}`);
  if (result.error) console.log(`    error   ${result.error.message}`);

  console.log(
    "\n  Next: wait for the handset, then re-run with --check to confirm the\n" +
      "  delivered callback landed and SmsPhoneStatus moved to valid.\n"
  );

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("\n  FAILED:", error?.message || error, "\n");
  process.exit(1);
});
