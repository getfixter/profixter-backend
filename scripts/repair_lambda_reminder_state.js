/**
 * One-time cutover repair: clear reminder flags the SNS Lambda wrote.
 *
 * The Lambda `sendBookingReminder` set reminder24hSentAt when it sent its own
 * SMS, and the backend reads that same field to decide whether the email is
 * still owed. So every upcoming booking the Lambda has already touched will be
 * skipped by the backend forever unless the false flag is cleared.
 *
 * EmailLog is the arbiter, not the flag. A booking whose flag is set AND has a
 * booking_reminder_24h log really did get the email and is left alone; one with
 * a flag and no log was claimed by the Lambda and is repaired.
 *
 *   node scripts/repair_lambda_reminder_state.js            # dry run, default
 *   node scripts/repair_lambda_reminder_state.js --write    # apply
 *
 * Only upcoming, non-terminal bookings are considered. Nothing historical is
 * touched, because a reminder for a visit that already happened is worthless
 * and resending it would be spam.
 */

const mongoose = require("mongoose");

const WRITE = process.argv.includes("--write");
const HOUR = 3600000;

// Matches the backend's own usefulness cutoff. A booking closer than this gets
// no upcoming reminder even after repair, so clearing its flag would only
// create churn.
const MIN_LEAD_MS = 2 * HOUR;

const TERMINAL = [
  "Canceled", "Cancelled", "Completed", "Complete", "Done", "Failed", "No-Show", "Noshow",
];

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGO_URI to run this");
  await mongoose.connect(uri, { dbName: process.env.MONGO_DB || "test" });
  const db = mongoose.connection.db;
  const bookings = db.collection("bookings");
  const logs = db.collection("emaillogs");

  const now = new Date();
  const upcoming = await bookings
    .find({ date: { $gt: now }, status: { $nin: TERMINAL } })
    .project({
      bookingNumber: 1, date: 1, status: 1, email: 1,
      reminder24hSentAt: 1, reminder24hMessageId: 1,
      reminder60mSentAt: 1, reminder60mMessageId: 1,
    })
    .sort({ date: 1 })
    .toArray();

  const groups = { A: [], B: [], C: [], D: [] };

  for (const b of upcoming) {
    const leadMs = new Date(b.date).getTime() - now.getTime();
    const flagged = !!b.reminder24hSentAt;
    const emailed =
      (await logs.countDocuments({
        bookingNumber: String(b.bookingNumber),
        templateKey: "booking_reminder_24h",
        status: "sent",
      })) > 0;

    const row = {
      bookingNumber: b.bookingNumber,
      appointment: new Date(b.date).toISOString(),
      leadHours: Number((leadMs / HOUR).toFixed(2)),
      flagged,
      emailed,
    };

    if (!flagged) groups.A.push(row);              // clean, backend will handle it
    else if (emailed) groups.C.push(row);          // genuinely emailed, leave alone
    else if (leadMs < MIN_LEAD_MS) groups.D.push(row); // too late to be useful
    else groups.B.push(row);                       // false Lambda flag, repair
  }

  const show = (key, title) => {
    console.log(`\n--- Group ${key}: ${title} (${groups[key].length})`);
    for (const r of groups[key].slice(0, 25)) {
      console.log(
        `    #${String(r.bookingNumber).padEnd(9)} ${r.appointment}  lead=${String(r.leadHours).padStart(7)}h` +
        `  flag=${r.flagged ? "set" : "-"}  email=${r.emailed ? "SENT" : "none"}`
      );
    }
    if (groups[key].length > 25) console.log(`    ... and ${groups[key].length - 25} more`);
  };

  console.log(`Lambda reminder-state repair  (${WRITE ? "WRITE" : "DRY RUN"})`);
  console.log(`Now: ${now.toISOString()}   upcoming active bookings: ${upcoming.length}`);
  show("A", "no 24h flag, backend will handle normally, no action");
  show("C", "real email already sent, DO NOT resend, no action");
  show("D", "flag set but too close to the visit, leave abandoned, no action");
  show("B", "false Lambda flag, no email ever sent, REPAIR");

  if (!groups.B.length) {
    console.log("\nNothing to repair.");
  } else if (!WRITE) {
    console.log(`\nDRY RUN. ${groups.B.length} booking(s) would be repaired. Re-run with --write to apply.`);
  } else {
    let repaired = 0;
    for (const r of groups.B) {
      const result = await bookings.updateOne(
        {
          bookingNumber: String(r.bookingNumber),
          // Re-checked at write time so a booking that received its email
          // between the dry run and the apply is not cleared underneath us.
          reminder24hSentAt: { $ne: null },
          date: { $gt: new Date() },
          status: { $nin: TERMINAL },
        },
        {
          $set: {
            reminder24hSentAt: null,
            reminder24hSkippedAt: null,
            reminder24hSkipReason: "",
            reminder24hAttempts: 0,
            reminder24hMessageId: "",
            reminder24hLastError: "",
            // The Lambda's SMS already went out for these, so the CRM tag is
            // deliberately NOT reset: the customer should get the email they
            // never received, not a second text.
            reminder24hTagAt: new Date(),
            reminder24hTagError: "superseded_by_lambda_sms",
          },
          $unset: { reminder24hQueuedAt: 1 },
        }
      );
      if (result.modifiedCount === 1) repaired += 1;
    }
    console.log(`\nRepaired ${repaired} of ${groups.B.length} booking(s).`);
    console.log("Reversal: set reminder24hSentAt back to a timestamp for those booking numbers.");
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("FAILED:", error.message);
  process.exit(1);
});
