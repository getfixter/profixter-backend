/**
 * Full Day Fixter: the rules that decide whether a day can be sold, what an
 * Elite member's included day costs them, and when cancelling gives it back.
 *
 * No database, no network. Every function under test is pure or takes its
 * collaborators as arguments, which is why the interesting cases (a member two
 * periods later, a day that has already started) can be checked at all.
 */

process.env.ENABLE_RESERVATION_ENGINE = "false";

const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const BookingSlotReservation = require("../models/BookingSlotReservation");
const VisitEntitlement = require("../models/VisitEntitlement");
const {
  MEMBERSHIP_BENEFIT_INDEX_NAME,
  ADDITIVE_INDEXES,
} = require("../utils/visitEntitlementIndexSafety");
const {
  canRestoreIncludedFullDay,
  subscriptionPeriod,
} = require("../utils/fullDayEntitlements");
const {
  FULL_DAY_PRODUCT_KIND,
  FULL_DAY_SERVICE,
  legacyDayAvailable,
  legacySpan,
  workdaySpan,
} = require("../utils/fullDayVisitService");
const {
  defaultSettings,
  normalizeSettings,
  publicFullDayVisitSettings,
  FALLBACK_FULL_DAY_PRICE_ID,
} = require("../utils/fullDayVisitSettings");
const { hoursForDate, leadDays } = require("../utils/legacyCalendarSlots");

function section(name) {
  console.log(`\n--- ${name}`);
}

async function testSettings() {
  section("settings are centralized and env-overridable");
  const defaults = defaultSettings();
  assert.equal(defaults.priceCents, 49900);
  assert.equal(defaults.approximateHours, 8);
  assert.equal(defaults.stripePriceId, FALLBACK_FULL_DAY_PRICE_ID);
  assert.equal(defaults.holdMinutes, 30);

  process.env.STRIPE_PRICE_FULL_DAY_VISIT = "price_override_me";
  assert.equal(defaultSettings().stripePriceId, "price_override_me");
  delete process.env.STRIPE_PRICE_FULL_DAY_VISIT;

  // A stored record wins over the environment, and a partial record still
  // resolves every field.
  const stored = normalizeSettings({ priceCents: 39900, stripePriceId: "price_db" });
  assert.equal(stored.priceCents, 39900);
  assert.equal(stored.stripePriceId, "price_db");
  assert.equal(stored.approximateHours, 8);

  // Nothing the customer sees may carry a Stripe identifier.
  const publicView = publicFullDayVisitSettings(defaults);
  assert.equal(publicView.stripePriceId, undefined);
  assert.equal(publicView.priceCents, 49900);
  console.log("PASS");
}

async function testReservationModelAcceptsAFullDay() {
  section("a reservation may span a workday, but only when it says it is one");
  const bookingId = new mongoose.Types.ObjectId();
  const technicianId = new mongoose.Types.ObjectId();
  const slotStart = new Date("2026-09-14T12:00:00Z");

  const fullDay = new BookingSlotReservation({
    bookingId,
    technicianId,
    kind: "full_day",
    slotStart,
    slotEnd: new Date(slotStart.getTime() + 8 * 60 * 60 * 1000),
    status: "reserved",
    createdByType: "customer",
  });
  await fullDay.validate();

  // The 90-minute guarantee is untouched for everything that is not a Full Day.
  const impostor = new BookingSlotReservation({
    bookingId,
    technicianId,
    slotStart,
    slotEnd: new Date(slotStart.getTime() + 8 * 60 * 60 * 1000),
    status: "reserved",
    createdByType: "customer",
  });
  await assert.rejects(impostor.validate(), /exactly 90 minutes/);

  // A Full Day still has to divide into the buckets that enforce it.
  const ragged = new BookingSlotReservation({
    bookingId,
    technicianId,
    kind: "full_day",
    slotStart,
    slotEnd: new Date(slotStart.getTime() + 8 * 60 * 60 * 1000 + 60 * 1000),
    status: "reserved",
    createdByType: "customer",
  });
  await assert.rejects(ragged.validate(), /15-minute buckets/);

  const tooLong = new BookingSlotReservation({
    bookingId,
    technicianId,
    kind: "full_day",
    slotStart,
    slotEnd: new Date(slotStart.getTime() + 25 * 60 * 60 * 1000),
    status: "reserved",
    createdByType: "customer",
  });
  await assert.rejects(tooLong.validate(), /24-hour day/);

  // Existing documents carry no kind and must keep meaning "visit".
  const legacyShaped = new BookingSlotReservation({
    bookingId,
    technicianId,
    slotStart,
    slotEnd: new Date(slotStart.getTime() + 90 * 60 * 1000),
    status: "reserved",
    createdByType: "system",
  });
  await legacyShaped.validate();
  assert.equal(legacyShaped.kind, "visit");
  console.log("PASS");
}

async function testEntitlementSchema() {
  section("the entitlement carries its source and period, and is unique per period");
  const schema = VisitEntitlement.schema;
  assert.deepEqual(schema.path("kind").enumValues, [
    "one_time_handyman_visit",
    "full_day_visit",
  ]);
  assert.deepEqual(schema.path("source").enumValues, [
    "purchase",
    "membership_benefit",
  ]);
  // Every entitlement written before Full Day existed has to keep reading as a
  // purchase without being touched.
  assert.equal(schema.path("source").defaultValue, "purchase");
  assert.equal(schema.path("periodStart").defaultValue, null);

  const index = schema
    .indexes()
    .find(([, options]) => options.name === MEMBERSHIP_BENEFIT_INDEX_NAME);
  assert(index, "membership benefit index is declared on the schema");
  const [fields, options] = index;
  assert.equal(options.unique, true);
  assert.deepEqual(Object.keys(fields), [
    "user",
    "addressId",
    "kind",
    "source",
    "periodStart",
  ]);
  // Partial in the three ways that make it non-destructive.
  assert.equal(options.partialFilterExpression.source, "membership_benefit");
  assert.deepEqual(options.partialFilterExpression.periodStart, { $type: "date" });
  assert.deepEqual(options.partialFilterExpression.status, {
    $in: ["pending_payment", "paid", "consumed"],
  });

  // The startup path creates it and is never allowed to drop anything.
  const additive = ADDITIVE_INDEXES.find(
    (spec) => spec.options.name === MEMBERSHIP_BENEFIT_INDEX_NAME
  );
  assert(additive, "startup index safety knows about the membership benefit index");
  assert.deepEqual(additive.options.partialFilterExpression, options.partialFilterExpression);
  console.log("PASS");
}

function testSubscriptionPeriod() {
  section("the billing period comes from the subscription, never the calendar");
  assert.equal(subscriptionPeriod(null), null);
  assert.equal(subscriptionPeriod({ currentPeriodStart: null, currentPeriodEnd: null }), null);
  assert.equal(
    subscriptionPeriod({
      currentPeriodStart: new Date("2026-08-12T00:00:00Z"),
      currentPeriodEnd: new Date("2026-08-12T00:00:00Z"),
    }),
    null,
    "a zero-length period is not a period"
  );
  const period = subscriptionPeriod({
    currentPeriodStart: new Date("2026-08-12T04:00:00Z"),
    currentPeriodEnd: new Date("2026-09-12T04:00:00Z"),
  });
  assert.equal(period.periodStart.toISOString(), "2026-08-12T04:00:00.000Z");
  assert.equal(period.periodEnd.toISOString(), "2026-09-12T04:00:00.000Z");
  console.log("PASS");
}

function testRestoreRules() {
  section("cancelling gives the included day back, but only under all three rules");
  const periodStart = new Date("2026-08-12T04:00:00Z");
  const periodEnd = new Date("2026-09-12T04:00:00Z");
  const benefit = {
    source: "membership_benefit",
    periodStart,
    periodEnd,
  };
  const futureBooking = { scheduledStart: new Date("2026-09-01T13:00:00Z") };
  const now = new Date("2026-08-20T15:00:00Z");

  assert.deepEqual(
    canRestoreIncludedFullDay({ booking: futureBooking, entitlement: benefit, now }),
    { restore: true, reason: "" }
  );

  // 1. The day has started or passed.
  assert.equal(
    canRestoreIncludedFullDay({
      booking: { scheduledStart: new Date("2026-08-20T14:00:00Z") },
      entitlement: benefit,
      now,
    }).reason,
    "day_already_started"
  );
  assert.equal(
    canRestoreIncludedFullDay({
      booking: { scheduledStart: now },
      entitlement: benefit,
      now,
    }).reason,
    "day_already_started",
    "the moment the day begins it is delivered"
  );

  // 2. The cancellation happened in a later period than the grant. The day is
  // still in the future here, so this is the period rule failing on its own and
  // not the started-day rule answering first.
  const nextPeriodBooking = { scheduledStart: new Date("2026-09-25T13:00:00Z") };
  assert.equal(
    canRestoreIncludedFullDay({
      booking: nextPeriodBooking,
      entitlement: benefit,
      now: new Date("2026-09-15T15:00:00Z"),
    }).reason,
    "outside_granted_period"
  );
  assert.equal(
    canRestoreIncludedFullDay({
      booking: nextPeriodBooking,
      entitlement: benefit,
      now: new Date("2026-09-12T04:00:00Z"),
    }).reason,
    "outside_granted_period",
    "periodEnd is exclusive; that instant belongs to the next period"
  );
  assert.equal(
    canRestoreIncludedFullDay({
      booking: nextPeriodBooking,
      entitlement: benefit,
      now: new Date("2026-09-12T03:59:59Z"),
    }).restore,
    true,
    "one second earlier is still the period the benefit was granted for"
  );

  // 3. The booking was paid for, not taken from the plan.
  assert.equal(
    canRestoreIncludedFullDay({
      booking: futureBooking,
      entitlement: { ...benefit, source: "purchase" },
      now,
    }).reason,
    "paid_full_day",
    "a paid Full Day has no benefit to hand back; its money is a separate question"
  );

  assert.equal(
    canRestoreIncludedFullDay({ booking: futureBooking, entitlement: null, now }).reason,
    "no_membership_entitlement"
  );
  assert.equal(
    canRestoreIncludedFullDay({
      booking: futureBooking,
      entitlement: { ...benefit, periodStart: null, periodEnd: null },
      now,
    }).reason,
    "no_billing_period"
  );
  // date is the fallback when a legacy booking has no scheduledStart.
  assert.equal(
    canRestoreIncludedFullDay({
      booking: { date: new Date("2026-09-01T13:00:00Z") },
      entitlement: benefit,
      now,
    }).restore,
    true
  );
  console.log("PASS");
}

function testWorkdaySpan() {
  section("a Full Day spans the whole configured day, gaps included");
  const detail = {
    slots: [
      { time: "08:00", endTime: "09:30" },
      { time: "10:00", endTime: "11:30" },
      // A gap over lunch. Leaving it bookable would sell a visit inside a day
      // that has already been sold.
      { time: "14:00", endTime: "15:30" },
    ],
  };
  const span = workdaySpan(detail, "2026-09-14", "America/New_York");
  assert.equal(span.startTime, "08:00");
  assert.equal(span.endTime, "15:30");
  assert.equal(span.hours, 7.5);
  assert.equal(span.start.getTime() % (15 * 60 * 1000), 0, "aligned to a bucket");
  assert.equal(span.end.getTime() % (15 * 60 * 1000), 0, "aligned to a bucket");

  assert.equal(workdaySpan({ slots: [] }, "2026-09-14", "America/New_York"), null);
  assert.equal(workdaySpan(null, "2026-09-14", "America/New_York"), null);
  console.log("PASS");
}

function testLegacyDay() {
  section("the legacy calendar sells a day only when every hour of it is free");
  const cfg = {
    timezone: "America/New_York",
    slotMinutes: 60,
    minLeadDays: 2,
    maxConcurrent: 1,
    closedWeekdays: [0],
    defaultHours: ["08:00", "09:00", "10:00", "11:00"],
    holidays: ["2026-09-07"],
  };
  const now = new Date("2026-09-01T12:00:00Z");
  const hours = hoursForDate(cfg, "2026-09-14");
  assert.deepEqual(hours, ["08:00", "09:00", "10:00", "11:00"]);

  assert.deepEqual(
    legacyDayAvailable({ cfg, date: "2026-09-14", hours, taken: {}, now }),
    { available: true, reason: "" }
  );

  // One booked hour is enough to lose the whole day.
  assert.equal(
    legacyDayAvailable({
      cfg,
      date: "2026-09-14",
      hours,
      taken: { "10:00": 1 },
      now,
    }).available,
    false
  );

  // Two Fixters' worth of capacity: one busy hour still leaves a Full Day.
  assert.equal(
    legacyDayAvailable({
      cfg: { ...cfg, maxConcurrent: 2 },
      date: "2026-09-14",
      hours,
      taken: { "10:00": 1 },
      now,
    }).available,
    true
  );

  // Closed days and holidays are not for sale.
  assert.deepEqual(hoursForDate(cfg, "2026-09-07"), [], "holiday");
  assert.deepEqual(hoursForDate(cfg, "2026-09-13"), [], "Sunday");
  assert.equal(
    legacyDayAvailable({ cfg, date: "2026-09-13", hours: [], taken: {}, now }).reason,
    "Closed that day"
  );

  // Lead time applies to the day as a whole.
  assert.equal(
    legacyDayAvailable({
      cfg,
      date: "2026-09-02",
      hours,
      taken: {},
      now: new Date("2026-09-01T12:00:00Z"),
    }).reason,
    "Outside the booking window"
  );
  assert.equal(leadDays("2026-09-03", "America/New_York", now), 2);

  const span = legacySpan("2026-09-14", hours, cfg);
  assert.equal(span.startTime, "08:00");
  assert.equal(span.endTime, "12:00", "the last hour is a whole slot long");
  assert.equal(span.hours, 4);
  console.log("PASS");
}

function testEmailCopy() {
  section("no Full Day email tells the customer it lasts 90 minutes");
  const { TEMPLATES } = require("../utils/emailService");
  const render = (key, vars) => {
    assert(TEMPLATES[key], `template ${key} does not exist`);
    const built = TEMPLATES[key](vars);
    return `${built.subject || ""}\n${built.html || ""}\n${built.text || ""}`;
  };

  const fullDayVars = {
    name: "Sam",
    bookingNumber: "12345678",
    date: "2026-09-14T12:00:00.000Z",
    service: "Full Day Fixter",
    address: "1 Test Street",
    bookingType: "full_day_visit",
  };

  const oneTimeVars = {
    ...fullDayVars,
    service: "One-Time Handyman Visit",
    selectedTask: "TV Mounting",
    bookingType: "one_time_handyman_visit",
    accessType: "one_time",
  };
  const memberVars = {
    ...fullDayVars,
    service: "Labor Only",
    bookingType: "membership_visit",
    accessType: "membership",
  };
  // The shape a paid Full Day actually has after the webhook: bought, so it
  // carries accessType "one_time" alongside the Full Day booking type. This is
  // the combination that used to sell it as a $99 ninety-minute visit.
  const paidFullDayVars = { ...fullDayVars, accessType: "one_time" };

  // Every customer-facing booking email, for all three products.
  const BOOKING_EMAILS = [
    "booking_created",
    "booking_confirmed",
    "booking_reminder_24h",
    "booking_reminder_60m",
    "booking_completed",
    "booking_review_request",
    "booking_canceled",
  ];
  for (const key of BOOKING_EMAILS) {
    for (const [label, vars] of [
      ["included Full Day", fullDayVars],
      ["paid Full Day", paidFullDayVars],
    ]) {
      const body = render(key, vars);
      assert.doesNotMatch(body, /90 minutes/, `${key} tells a ${label} it lasts 90 minutes`);
      assert.doesNotMatch(body, /\$99\b/, `${key} quotes $99 to a ${label}`);
      assert.doesNotMatch(body, /One-Time Visit/, `${key} calls a ${label} a One-Time Visit`);
    }
  }

  // The confirmation an Admin sends when they accept the booking.
  const confirmed = render("booking_confirmed", paidFullDayVars);
  assert.match(confirmed, /One Fixter, approximately 8 hours/);
  assert.match(confirmed, /Full Day Fixter is approved/);
  // A paid Full Day is changed by phone, and the email says so.
  assert.match(confirmed, /call ProFixter at 631-599-1363/i);

  // The one-time visit keeps every word it had.
  const oneTime = render("booking_confirmed", oneTimeVars);
  assert.match(oneTime, /\$99 \/ 90 minutes/, "the one-time visit lost its price and duration");
  assert.match(oneTime, /paid One-Time Visit is approved/);
  // A membership visit quotes neither, exactly as before.
  const member = render("booking_confirmed", memberVars);
  assert.doesNotMatch(member, /\$99/);
  assert.doesNotMatch(member, /Full Day/);
  assert.match(member, /Your appointment is on the schedule/);

  // The upcoming reminder is deliberately timing-neutral now: it recovers from
  // outages and can legitimately go out far less than 24 hours ahead, so it
  // names the product and the exact time and never a distance.
  const reminder24 = render("booking_reminder_24h", fullDayVars);
  assert.match(reminder24, /Full Day Fixter is scheduled for/);
  assert.doesNotMatch(reminder24, /tomorrow/i, "no reminder may promise tomorrow");
  assert.match(render("booking_reminder_24h", oneTimeVars), /One-Time Visit is scheduled for/);
  assert.match(
    render("booking_reminder_24h", memberVars),
    /Profixter appointment is scheduled for/
  );

  const reminder60 = render("booking_reminder_60m", fullDayVars);
  assert.match(reminder60, /Full Day Fixter is scheduled/);
  assert.match(render("booking_reminder_60m", memberVars), /Profixter appointment is scheduled/);

  assert.match(render("booking_completed", fullDayVars), /Your Full Day Fixter/);
  assert.match(render("booking_review_request", fullDayVars), /for your Full Day/);

  // The booking emails Full Day sends for itself.
  const included = render("full_day_visit_booked", {
    ...fullDayVars,
    approximateHours: 8,
    included: true,
    startTime: "8:00 AM",
    endTime: "4:00 PM",
    periodEnd: "2026-09-12T04:00:00.000Z",
  });
  assert.doesNotMatch(included, /90 minutes/);
  assert.match(included, /included with your Elite membership/i);
  assert.doesNotMatch(included, /\$499/, "an included day must not quote a price");

  const paid = render("full_day_visit_booked", {
    ...fullDayVars,
    approximateHours: 8,
    included: false,
    price: "$499",
  });
  assert.match(paid, /\$499/);
  assert.doesNotMatch(paid, /included with your Elite membership/i);
  console.log("PASS");
}

function testWebhookKeepsTheFullDay() {
  section("payment does not rewrite a Full Day into a one-time visit");
  const {
    applyOneTimePaymentSuccessToBooking,
  } = require("../utils/oneTimeVisitPaymentFlow");

  // The shared helper stamps the one-time product, which is right for its own
  // caller and wrong for Full Day. The webhook puts it back; this is the guard
  // that the ordering is not quietly reversed later.
  const booking = { bookingType: "full_day_visit", note: "" };
  applyOneTimePaymentSuccessToBooking(booking, { session: { id: "cs_test" } });
  assert.equal(booking.bookingType, "one_time_handyman_visit", "the helper does overwrite it");

  const webhookSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "routes", "webhook.js"),
    "utf8"
  );
  const handler = webhookSource.slice(
    webhookSource.indexOf("async function handleFullDayCheckoutCompleted")
  );
  const applyAt = handler.indexOf("applyOneTimePaymentSuccessToBooking");
  const restoreAt = handler.indexOf('booking.bookingType = "full_day_visit"');
  const saveAt = handler.indexOf("await booking.save()");
  assert.ok(applyAt >= 0 && restoreAt > applyAt, "the Full Day type is restored after the helper");
  assert.ok(saveAt > restoreAt, "and restored before the booking is saved");
  console.log("PASS");
}

function testWiring() {
  section("the product kind and service name are shared, not retyped");
  assert.equal(FULL_DAY_PRODUCT_KIND, "full_day_visit");
  assert.equal(FULL_DAY_SERVICE, "Full Day Fixter");

  const bookingsSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "routes", "bookings.js"),
    "utf8"
  );
  assert.match(bookingsSource, /full-day\/config/);
  assert.match(bookingsSource, /full-day\/availability/);
  assert.match(bookingsSource, /full-day\/eligibility/);
  assert.match(bookingsSource, /full-day\/book/);
  assert.match(bookingsSource, /full-day\/checkout/);
  assert.match(bookingsSource, /restoreIncludedFullDay/);
  // The price must never be typed into the booking code.
  assert.doesNotMatch(bookingsSource, /price_1[A-Za-z0-9]+/);

  const webhookSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "routes", "webhook.js"),
    "utf8"
  );
  assert.match(webhookSource, /isFullDayCheckoutSession/);
  assert.match(webhookSource, /handleFullDayCheckoutCompleted/);
  assert.match(webhookSource, /handleFullDayCheckoutExpired/);

  const holdsSource = require("fs").readFileSync(
    require("path").join(__dirname, "..", "jobs", "oneTimeVisitHolds.js"),
    "utf8"
  );
  assert.match(holdsSource, /full_day_visit/);
  assert.match(holdsSource, /releaseFullDayCapacity/);
  console.log("PASS");
}

async function run() {
  await testSettings();
  await testReservationModelAcceptsAFullDay();
  await testEntitlementSchema();
  testSubscriptionPeriod();
  testRestoreRules();
  testWorkdaySpan();
  testLegacyDay();
  testEmailCopy();
  testWebhookKeepsTheFullDay();
  testWiring();
  console.log("\nFull Day suite passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
