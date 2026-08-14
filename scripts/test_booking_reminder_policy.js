/**
 * Booking reminder eligibility.
 *
 * The rules this locks down are the ones that decide whether a customer is
 * reminded, reminded twice, or not reminded at all. They are pure functions of
 * a booking and an instant, which is what makes the interesting cases (a
 * scheduler that was down for six hours, an appointment rescheduled across a
 * DST boundary) testable without a clock or a database.
 */

const assert = require("node:assert/strict");

const {
  MINUTE_MS,
  HOUR_MS,
  REMINDER_MAX_ATTEMPTS,
  evaluateTagRetry,
  clearedReminderState,
  due24HourAt,
  due60MinuteAt,
  evaluate24HourReminder,
  evaluate60MinuteReminder,
  isMaterialDateChange,
} = require("../utils/bookingReminderPolicy");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

const NOW = new Date("2026-09-14T15:00:00.000Z");

/** A booking that is eligible for everything, `hoursAway` from now. */
function booking(hoursAway, overrides = {}) {
  return {
    _id: "b1",
    status: "Confirmed",
    email: "customer@example.com",
    date: new Date(NOW.getTime() + hoursAway * HOUR_MS),
    ...overrides,
  };
}

const eligible24 = (b, now = NOW) => evaluate24HourReminder(b, now);
const eligible60 = (b, now = NOW) => evaluate60MinuteReminder(b, now);

console.log("\nWhen a reminder becomes due");

test("due times are derived from the appointment, not stored", () => {
  const b = booking(30);
  assert.equal(due24HourAt(b).getTime(), new Date(b.date).getTime() - 24 * HOUR_MS);
  assert.equal(due60MinuteAt(b).getTime(), new Date(b.date).getTime() - HOUR_MS);
  // Move the appointment and both due times move with it, for free.
  const moved = { ...b, date: new Date(new Date(b.date).getTime() + 72 * HOUR_MS) };
  assert.equal(
    due24HourAt(moved).getTime() - due24HourAt(b).getTime(),
    72 * HOUR_MS
  );
});

console.log("\nThe 24-hour reminder");

test("30 hours away: not yet due", () => {
  const v = eligible24(booking(30));
  assert.equal(v.eligible, false);
  assert.equal(v.reason, "not_yet_due");
});

test("exactly 24 hours away: due, and counted as on time", () => {
  const v = eligible24(booking(24));
  assert.equal(v.eligible, true);
  assert.equal(v.mode, "on_time");
});

test("24h10m away: not yet due, and NOT lost", () => {
  const b = booking(0, { date: new Date(NOW.getTime() + 24 * HOUR_MS + 10 * MINUTE_MS) });
  assert.equal(eligible24(b).reason, "not_yet_due");
  // Ten minutes later it is due. Under the old window this booking could fall
  // between two cycles and never be selected again.
  const later = new Date(NOW.getTime() + 11 * MINUTE_MS);
  assert.equal(eligible24(b, later).eligible, true);
});

test("23h50m away: due, sent as a catch-up", () => {
  const v = eligible24(booking(23 + 50 / 60));
  assert.equal(v.eligible, true);
  assert.equal(v.mode, "catch_up");
});

test("a six-hour scheduler outage does not lose the reminder", () => {
  // Due at T-24h, but nothing ran until T-18h. It is still due.
  const b = booking(18);
  const v = eligible24(b);
  assert.equal(v.eligible, true);
  assert.equal(v.mode, "catch_up");
  assert.equal(Math.round(v.msUntilBooking / HOUR_MS), 18);
});

test("still recoverable at 2h1m, abandoned at 1h59m", () => {
  const justInside = booking(0, { date: new Date(NOW.getTime() + 2 * HOUR_MS + MINUTE_MS) });
  assert.equal(eligible24(justInside).eligible, true);

  const justOutside = booking(0, { date: new Date(NOW.getTime() + 2 * HOUR_MS - MINUTE_MS) });
  const v = eligible24(justOutside);
  assert.equal(v.eligible, false);
  assert.equal(v.reason, "less_than_2h_notice");
  assert.equal(v.shouldMarkSkipped, true, "abandonment must be recorded, not silent");
});

test("booked 10 hours before the visit: one reminder, not none", () => {
  // The customer cannot have 24 hours of notice, but they can have ten hours
  // of notice, which is the useful thing to send.
  const v = eligible24(booking(10));
  assert.equal(v.eligible, true);
  assert.equal(v.mode, "catch_up");
});

test("appointment already started: abandoned with a reason", () => {
  const v = eligible24(booking(-0.5));
  assert.equal(v.eligible, false);
  assert.equal(v.reason, "appointment_started");
  assert.equal(v.shouldMarkSkipped, true);
});

console.log("\nThe 60-minute reminder");

test("90 minutes away: not yet due", () => {
  assert.equal(eligible60(booking(1.5)).reason, "not_yet_due");
});

test("exactly 60 minutes away: due", () => {
  const v = eligible60(booking(1));
  assert.equal(v.eligible, true);
  assert.equal(v.mode, "on_time");
});

test("20 minutes away after a missed cycle: still sent", () => {
  const v = eligible60(booking(20 / 60));
  assert.equal(v.eligible, true);
  assert.equal(v.mode, "catch_up");
});

test("10 minutes after the start: still sent, we are on the way", () => {
  assert.equal(eligible60(booking(-10 / 60)).eligible, true);
});

test("20 minutes after the start: abandoned", () => {
  const v = eligible60(booking(-20 / 60));
  assert.equal(v.eligible, false);
  assert.equal(v.reason, "appointment_started");
  assert.equal(v.shouldMarkSkipped, true);
});

console.log("\nThe two reminders cannot interfere with each other");

test("a sent 24h reminder does not block the 60m reminder", () => {
  const b = booking(1, { reminder24hSentAt: new Date(NOW.getTime() - 23 * HOUR_MS) });
  assert.equal(eligible24(b).reason, "already_sent");
  assert.equal(eligible60(b).eligible, true, "60m must be independent of 24h");
});

test("a sent 60m reminder does not block a still-due 24h reminder", () => {
  const b = booking(5, { reminder60mSentAt: new Date(NOW.getTime() - HOUR_MS) });
  assert.equal(eligible60(b).reason, "already_sent");
  assert.equal(eligible24(b).eligible, true);
});

test("an abandoned 24h reminder does not abandon the 60m reminder", () => {
  const b = booking(1, {
    reminder24hSkippedAt: new Date(),
    reminder24hSkipReason: "less_than_2h_notice",
  });
  assert.equal(eligible24(b).reason, "already_skipped");
  assert.equal(eligible60(b).eligible, true);
});

console.log("\nIdempotency and retry");

test("running again after success sends nothing", () => {
  const b = booking(20, { reminder24hSentAt: new Date() });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(eligible24(b).eligible, false);
    assert.equal(eligible24(b).reason, "already_sent");
  }
});

test("running again after a failure retries", () => {
  // The send failed, so nothing was recorded as sent and the attempt counted.
  const b = booking(20, { reminder24hAttempts: 1 });
  assert.equal(eligible24(b).eligible, true, "a failed send must be retried");
});

test("retries stop after the attempt ceiling, and say so", () => {
  const b = booking(20, { reminder24hAttempts: REMINDER_MAX_ATTEMPTS });
  const v = eligible24(b);
  assert.equal(v.eligible, false);
  assert.equal(v.reason, "max_attempts_exceeded");
  assert.equal(v.shouldMarkSkipped, true, "a give-up must be visible, not a silent loop");
  // One attempt below the ceiling still tries.
  assert.equal(eligible24(booking(20, { reminder24hAttempts: REMINDER_MAX_ATTEMPTS - 1 })).eligible, true);
});

console.log("\nBooking state");

test("cancelled bookings receive nothing", () => {
  for (const status of ["Canceled", "Cancelled", "canceled"]) {
    assert.equal(eligible24(booking(20, { status })).reason, "status_not_confirmed");
    assert.equal(eligible60(booking(1, { status })).reason, "status_not_confirmed");
  }
});

test("completed bookings receive nothing", () => {
  assert.equal(eligible24(booking(20, { status: "Completed" })).reason, "status_not_confirmed");
  assert.equal(eligible60(booking(1, { status: "Completed" })).reason, "status_not_confirmed");
});

test("pending bookings receive nothing until confirmed", () => {
  assert.equal(eligible24(booking(20, { status: "Pending" })).reason, "status_not_confirmed");
  // Confirmed inside its own 24h window: due immediately.
  assert.equal(eligible24(booking(20, { status: "Confirmed" })).eligible, true);
});

test("a missing or malformed email is not attempted", () => {
  for (const email of ["", null, undefined, "not-an-email", "a@b"]) {
    assert.equal(eligible24(booking(20, { email })).reason, "missing_or_invalid_email");
  }
});

test("an unparseable date is not attempted", () => {
  assert.equal(eligible24(booking(0, { date: "nonsense" })).reason, "invalid_booking_date");
  assert.equal(eligible60(booking(0, { date: null })).reason, "invalid_booking_date");
});

console.log("\nRescheduling");

test("a save that does not move the appointment is not a reschedule", () => {
  const d = new Date("2026-09-20T14:00:00.000Z");
  assert.equal(isMaterialDateChange(d, new Date(d.getTime())), false);
  assert.equal(isMaterialDateChange(d, new Date(d.getTime() + 500)), false, "sub-second drift");
  assert.equal(isMaterialDateChange(d, new Date(d.getTime() + 61 * 1000)), true);
});

test("a rescheduled booking is owed a fresh reminder", () => {
  // Reminded about Monday, then moved to Thursday. Suppressing Thursday's
  // reminder because Monday's was sent is the bug that looks like dedup.
  const cleared = clearedReminderState();
  const moved = { ...booking(50), ...cleared, status: "Confirmed" };
  assert.equal(eligible24(moved, NOW).reason, "not_yet_due");
  const dayBefore = new Date(new Date(moved.date).getTime() - 23 * HOUR_MS);
  assert.equal(eligible24(moved, dayBefore).eligible, true);
});

test("clearing resets every reminder field, including the new ones", () => {
  const cleared = clearedReminderState();
  for (const field of [
    "reminder24hSentAt", "reminder24hSkippedAt", "reminder24hAttempts",
    "reminder24hQueuedAt", "reminder24hMessageId", "reminder24hLastError",
    "reminder60mSentAt", "reminder60mSkippedAt", "reminder60mAttempts",
    "reminder60mQueuedAt", "reminder60mMessageId", "reminder60mLastError",
  ]) {
    assert.ok(field in cleared, `${field} must be cleared on reschedule`);
  }
  assert.equal(cleared.reminder24hAttempts, 0, "a moved booking starts with no attempts");
});

console.log("\nThe SMS channel is tracked independently of the email");

test("the tag is owed once the email has gone, and not before", () => {
  assert.equal(evaluateTagRetry(booking(20), "24h", NOW).reason, "email_not_sent");
  const sent = booking(20, { reminder24hSentAt: new Date(NOW.getTime() - 60000) });
  assert.equal(evaluateTagRetry(sent, "24h", NOW).eligible, true);
});

test("a failed tag is retryable without resending the email", () => {
  // The whole point of splitting the channels: the customer has the email, the
  // CRM call failed, and the fix must not put a second email in their inbox in
  // order to retry a text message.
  const b = booking(20, {
    reminder24hSentAt: new Date(NOW.getTime() - 60000),
    reminder24hTagAttempts: 2,
    reminder24hTagError: "GHL 502",
  });
  assert.equal(evaluateTagRetry(b, "24h", NOW).eligible, true);
  assert.equal(eligible24(b).reason, "already_sent", "the email must NOT be resent");
});

test("a tagged reminder is finished", () => {
  const b = booking(20, {
    reminder24hSentAt: new Date(NOW.getTime() - 60000),
    reminder24hTagAt: new Date(NOW.getTime() - 59000),
  });
  assert.equal(evaluateTagRetry(b, "24h", NOW).reason, "already_tagged");
});

test("tag retries stop at the ceiling, after cancellation, and after the visit", () => {
  const base = { reminder24hSentAt: new Date(NOW.getTime() - 60000) };
  assert.equal(
    evaluateTagRetry(booking(20, Object.assign({}, base, { reminder24hTagAttempts: REMINDER_MAX_ATTEMPTS })), "24h", NOW).reason,
    "max_attempts_exceeded"
  );
  assert.equal(evaluateTagRetry(booking(-1, base), "24h", NOW).reason, "appointment_started");
  assert.equal(
    evaluateTagRetry(booking(20, Object.assign({}, base, { status: "Canceled" })), "24h", NOW).reason,
    "status_not_confirmed"
  );
});

test("the 60m tag is tracked separately from the 24h tag", () => {
  const b = booking(0.5, {
    reminder24hSentAt: new Date(NOW.getTime() - 20 * HOUR_MS),
    reminder24hTagAt: new Date(NOW.getTime() - 20 * HOUR_MS),
    reminder60mSentAt: new Date(NOW.getTime() - 60000),
  });
  assert.equal(evaluateTagRetry(b, "24h", NOW).reason, "already_tagged");
  assert.equal(evaluateTagRetry(b, "60m", NOW).eligible, true, "the 60m tag is still owed");
});

console.log("\nTime zones and DST");

test("eligibility is absolute-instant arithmetic, so DST cannot shift it", () => {
  // 2026-11-01 is the US fall-back. A 2am-to-1am repeat must not make a
  // reminder fire twice or vanish, because nothing here reads a wall clock.
  const appointment = new Date("2026-11-01T14:00:00.000Z");
  const b = { status: "Confirmed", email: "c@example.com", date: appointment };
  const dueAt = new Date(appointment.getTime() - 24 * HOUR_MS);
  assert.equal(evaluate24HourReminder(b, new Date(dueAt.getTime() - MINUTE_MS)).eligible, false);
  assert.equal(evaluate24HourReminder(b, dueAt).eligible, true);
  // Across the spring-forward boundary too.
  const spring = new Date("2027-03-14T12:00:00.000Z");
  const springBooking = { ...b, date: spring };
  assert.equal(
    evaluate24HourReminder(springBooking, new Date(spring.getTime() - 24 * HOUR_MS)).eligible,
    true
  );
});

test("the reminder lead is 24 real hours, not 24 wall-clock hours", () => {
  const appointment = new Date("2026-11-02T14:00:00.000Z");
  assert.equal(
    new Date(appointment).getTime() - due24HourAt({ date: appointment }).getTime(),
    24 * HOUR_MS
  );
});

console.log("\nMany bookings at once");

test("each booking is judged on its own state", () => {
  const bookings = [
    booking(30),
    booking(24),
    booking(18),
    booking(1.9),
    booking(20, { reminder24hSentAt: new Date() }),
    booking(20, { status: "Canceled" }),
  ];
  const verdicts = bookings.map((b) => eligible24(b));
  assert.deepEqual(
    verdicts.map((v) => v.eligible),
    [false, true, true, false, false, false]
  );
  assert.deepEqual(
    verdicts.map((v) => v.reason),
    ["not_yet_due", "on_time", "catch_up", "less_than_2h_notice", "already_sent", "status_not_confirmed"]
  );
});

test("booking type does not gate reminders", () => {
  // Every product that produces a confirmed appointment gets reminded,
  // including Full Day, which is why this is asserted rather than assumed.
  for (const bookingType of [
    "membership_visit",
    "one_time_handyman_visit",
    "full_day_visit",
    undefined,
  ]) {
    assert.equal(eligible24(booking(20, { bookingType })).eligible, true, String(bookingType));
    assert.equal(eligible60(booking(0.5, { bookingType })).eligible, true, String(bookingType));
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}\n`, f.error);
  process.exit(1);
}
