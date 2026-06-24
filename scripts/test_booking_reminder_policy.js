const assert = require("node:assert/strict");
const {
  HOUR_MS,
  evaluate24HourReminder,
  evaluate60MinuteReminder,
} = require("../utils/bookingReminderPolicy");

const now = new Date("2026-06-20T12:00:00.000Z");

function booking(hoursUntil, overrides = {}) {
  return {
    status: "Confirmed",
    email: "test@example.com",
    date: new Date(now.getTime() + hoursUntil * HOUR_MS),
    ...overrides,
  };
}

function run() {
  assert.deepEqual(evaluate24HourReminder(booking(24), now), {
    eligible: true,
    reason: "scheduled_window",
    mode: "scheduled_window",
    msUntilBooking: 24 * HOUR_MS,
  });

  assert.equal(
    evaluate24HourReminder(booking(23 + 50 / 60), now).reason,
    "scheduled_window"
  );
  assert.equal(
    evaluate24HourReminder(booking(24 + 10 / 60), now).eligible,
    true
  );

  const catchup = evaluate24HourReminder(booking(5), now);
  assert.equal(catchup.eligible, true);
  assert.equal(catchup.mode, "catch_up");
  assert.equal(
    evaluate24HourReminder(booking(2 + 1 / 60), now).eligible,
    true
  );

  const ninetyMinutes = evaluate24HourReminder(booking(1.5), now);
  assert.equal(ninetyMinutes.eligible, false);
  assert.equal(ninetyMinutes.shouldMarkSkipped, true);
  assert.equal(
    evaluate24HourReminder(booking(2), now).shouldMarkSkipped,
    true
  );

  assert.equal(
    evaluate24HourReminder(
      booking(24, { status: "Canceled" }),
      now
    ).eligible,
    false
  );
  assert.equal(
    evaluate24HourReminder(
      booking(24, { status: "Completed" }),
      now
    ).eligible,
    false
  );
  assert.equal(
    evaluate24HourReminder(
      booking(24, { reminder24hSentAt: new Date() }),
      now
    ).reason,
    "already_sent"
  );
  assert.equal(
    evaluate24HourReminder(
      booking(5, { reminder24hSkippedAt: new Date() }),
      now
    ).eligible,
    true
  );
  assert.equal(
    evaluate24HourReminder(
      booking(5, {
        reminder24hSkippedAt: new Date(),
        reminder24hSkipReason: "legacy_false_skip",
      }),
      now
    ).mode,
    "catch_up"
  );
  assert.equal(
    evaluate24HourReminder(
      booking(1.5, { reminder24hSkippedAt: new Date() }),
      now
    ).eligible,
    false
  );
  assert.equal(
    evaluate24HourReminder(booking(24 + 16 / 60), now).eligible,
    false
  );

  assert.equal(evaluate60MinuteReminder(booking(1), now).eligible, true);
  assert.equal(evaluate60MinuteReminder(booking(1.25), now).eligible, true);
  assert.equal(
    evaluate60MinuteReminder(booking(1.5), now).eligible,
    false
  );
  assert.equal(
    evaluate60MinuteReminder(
      booking(1, { status: "Canceled" }),
      now
    ).eligible,
    false
  );
  assert.equal(
    evaluate60MinuteReminder(
      booking(1, { status: "Completed" }),
      now
    ).eligible,
    false
  );
  assert.equal(
    evaluate60MinuteReminder(
      booking(1, { reminder60mSentAt: new Date() }),
      now
    ).reason,
    "already_sent"
  );

  console.log("Booking reminder policy tests passed");
}

run();
