/**
 * Full Day Fixter against a real database.
 *
 * The unit suite proves the rules. This proves the two guarantees only a
 * database can give:
 *
 *   an Elite member holds exactly one included Full Day per billing period,
 *   however many requests arrive at once;
 *
 *   a Fixter cannot be sold twice on the same day, whichever engine is running.
 *
 * MongoDB is real and in memory. It is started as a single-node replica set so
 * the reservation-engine path, which requires transactions, is exercised rather
 * than skipped.
 *
 *   node scripts/test_full_day_visit_integration.js
 *
 * Not part of `npm test`: it downloads and boots a MongoDB binary, which is too
 * heavy and too network-dependent for the deploy gate.
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";
process.env.CLIENT_URL = "https://www.profixter.com";

const assert = require("assert");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Booking = require("../models/Booking");
const BookingSlotReservation = require("../models/BookingSlotReservation");
const CalendarConfig = require("../models/CalendarConfig");
const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
const ReservationTimeBucket = require("../models/ReservationTimeBucket");
const SlotCounter = require("../models/SlotCounter");
const Subscription = require("../models/Subscription");
const User = require("../models/User");
const VisitEntitlement = require("../models/VisitEntitlement");

const {
  consumeIncludedFullDay,
  includedFullDayState,
  restoreIncludedFullDay,
} = require("../utils/fullDayEntitlements");
const {
  ensureVisitEntitlementIndexes,
} = require("../utils/visitEntitlementIndexSafety");

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

const TZ = "America/New_York";
const PERIOD_START = new Date("2026-08-12T04:00:00.000Z");
const PERIOD_END = new Date("2026-09-12T04:00:00.000Z");
const NEXT_PERIOD_START = PERIOD_END;
const NEXT_PERIOD_END = new Date("2026-10-12T04:00:00.000Z");

async function makeEliteMember({ email = "elite@test.local" } = {}) {
  const addressId = new mongoose.Types.ObjectId();
  const user = await User.create({
    name: "Elite Member",
    email,
    password: "hashed",
    phone: "+15550001111",
    userId: String(Math.floor(10000000 + Math.random() * 89999999)),
    role: "customer",
    addresses: [
      {
        _id: addressId,
        label: "Home",
        line1: "1 Test Street",
        city: "Babylon",
        state: "NY",
        zip: "11702",
        county: "Suffolk",
      },
    ],
    defaultAddressId: addressId,
  });
  await Subscription.create({
    user: user._id,
    userId: user.userId,
    subscriptionType: "elite",
    addressId,
    status: "active",
    accessStatus: "active",
    startDate: PERIOD_START,
    latestPaymentDate: PERIOD_START,
    nextPaymentDate: PERIOD_END,
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
  });
  return { user, addressId };
}

async function seedLegacyCalendar() {
  await CalendarConfig.deleteMany({});
  await CalendarConfig.create({
    timezone: TZ,
    slotMinutes: 60,
    minLeadDays: 1,
    closedWeekdays: [0],
    defaultHours: ["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00"],
    holidays: [],
    maxConcurrent: 1,
  });
}

async function seedReservationFoundation(technicianIds) {
  await CompanyAvailabilityTemplate.deleteMany({});
  await CompanyAvailabilityTemplate.create({
    active: true,
    timezone: TZ,
    slotMinutes: 30,
    minLeadMinutes: 0,
    maxAdvanceDays: 120,
    defaultCapacity: technicianIds.length,
    visitDurationMinutes: 90,
    weeklySchedule: Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      enabled: weekday !== 0,
      starts: ["08:00", "10:00", "13:00"].map((time) => ({ time, capacity: null })),
      intervals: [{ startTime: "08:00", endTime: "16:00", capacity: null }],
    })),
  });
}

async function makeFixter(name) {
  return User.create({
    name,
    email: `${name.toLowerCase().replace(/\s+/g, ".")}@fixter.local`,
    password: "hashed",
    phone: "+15550002222",
    userId: String(Math.floor(10000000 + Math.random() * 89999999)),
    role: "employee",
    employeePosition: "Fixter",
    isActive: true,
  });
}

async function reset() {
  await Promise.all([
    Booking.deleteMany({}),
    BookingSlotReservation.deleteMany({}),
    ReservationTimeBucket.deleteMany({}),
    SlotCounter.deleteMany({}),
    Subscription.deleteMany({}),
    User.deleteMany({}),
    VisitEntitlement.deleteMany({}),
  ]);
}

async function run() {
  const server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(server.getUri(), { dbName: "fullday" });

  // The unique index is the guarantee under test. Build it before racing it.
  await ensureVisitEntitlementIndexes({ logger: { log() {}, warn() {} } });
  await Promise.all([
    Booking.init(),
    BookingSlotReservation.init(),
    ReservationTimeBucket.init(),
    SlotCounter.init(),
  ]);

  try {
    console.log("\nThe included Elite Full Day");

    await test("an Elite member starts the period with one included Full Day", async () => {
      await reset();
      const { user, addressId } = await makeEliteMember();
      const state = await includedFullDayState({ user, addressId });
      assert.equal(state.entitled, true);
      assert.equal(state.used, false);
      assert.equal(state.remaining, 1);
      assert.equal(state.periodStart.toISOString(), PERIOD_START.toISOString());
      assert.equal(state.periodEnd.toISOString(), PERIOD_END.toISOString());
    });

    await test("a non-Elite customer has none", async () => {
      await reset();
      const { user, addressId } = await makeEliteMember();
      await Subscription.updateMany({ user: user._id }, { $set: { subscriptionType: "premium" } });
      const state = await includedFullDayState({ user, addressId });
      assert.equal(state.entitled, false);
      assert.equal(state.reason, "not_elite");
    });

    await test("a subscription with no billing period grants nothing rather than guessing one", async () => {
      await reset();
      const { user, addressId } = await makeEliteMember();
      await Subscription.updateMany(
        { user: user._id },
        { $set: { currentPeriodStart: null, currentPeriodEnd: null } }
      );
      const state = await includedFullDayState({ user, addressId });
      assert.equal(state.entitled, false);
      assert.equal(state.reason, "no_billing_period");
    });

    await test("twenty simultaneous requests produce exactly one entitlement", async () => {
      await reset();
      const { user, addressId } = await makeEliteMember();
      const attempts = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          consumeIncludedFullDay({
            user,
            addressId,
            periodStart: PERIOD_START,
            periodEnd: PERIOD_END,
            durationMinutes: 480,
          })
        )
      );
      const won = attempts.filter((a) => a.status === "fulfilled");
      const lost = attempts.filter((a) => a.status === "rejected");
      assert.equal(won.length, 1, `expected 1 winner, got ${won.length}`);
      assert.equal(lost.length, 19);
      // Every loser gets the same clear refusal, not a raw duplicate-key error.
      for (const attempt of lost) {
        assert.equal(attempt.reason.code, "FULL_DAY_BENEFIT_ALREADY_USED");
      }
      const stored = await VisitEntitlement.find({
        user: user._id,
        source: "membership_benefit",
      });
      assert.equal(stored.length, 1);
      assert.equal(stored[0].status, "consumed");
      assert.equal(stored[0].priceCents, 0);
      assert.ok(stored[0].consumedAt, "consumed at booking confirmation, not later");
    });

    await test("the same member gets another Full Day in the next period", async () => {
      await reset();
      const { user, addressId } = await makeEliteMember();
      await consumeIncludedFullDay({
        user, addressId, periodStart: PERIOD_START, periodEnd: PERIOD_END, durationMinutes: 480,
      });
      // The period the index keys on is different, so this is a different row.
      const next = await consumeIncludedFullDay({
        user, addressId, periodStart: NEXT_PERIOD_START, periodEnd: NEXT_PERIOD_END, durationMinutes: 480,
      });
      assert.ok(next._id);
      assert.equal(
        (await VisitEntitlement.countDocuments({ user: user._id, source: "membership_benefit" })),
        2
      );
    });

    await test("existing entitlements are untouched by the new index", async () => {
      await reset();
      const { user, addressId } = await makeEliteMember();
      // Two documents shaped exactly like every one written before Full Day
      // existed: a purchase, no source set explicitly, no period at all.
      const legacyShaped = await VisitEntitlement.create([
        { user: user._id, userId: user.userId, addressId, status: "paid", priceCents: 9900 },
        { user: user._id, userId: user.userId, addressId, status: "consumed", priceCents: 9900 },
      ]);
      assert.equal(legacyShaped.length, 2, "no unique index blocks historical rows");
      for (const entitlement of legacyShaped) {
        assert.equal(entitlement.source, "purchase");
        assert.equal(entitlement.kind, "one_time_handyman_visit");
        assert.equal(entitlement.periodStart, null);
      }
      // And the member's benefit is still available: purchases are not it.
      const state = await includedFullDayState({ user, addressId });
      assert.equal(state.used, false);
    });

    console.log("\nCancelling an included Full Day");

    await test("cancelling before the day, inside the period, gives it back", async () => {
      await reset();
      const { user, addressId } = await makeEliteMember();
      const entitlement = await consumeIncludedFullDay({
        user, addressId, periodStart: PERIOD_START, periodEnd: PERIOD_END, durationMinutes: 480,
      });
      const booking = await Booking.create({
        ...fullDayBookingData(user, addressId, "10000001"),
        date: new Date("2026-09-01T12:00:00Z"),
        scheduledStart: new Date("2026-09-01T12:00:00Z"),
        accessType: "membership",
        entitlementId: entitlement._id,
      });

      const result = await restoreIncludedFullDay({
        booking,
        now: new Date("2026-08-20T15:00:00Z"),
      });
      assert.equal(result.restored, true);

      // Restored means available again, not deleted: the record survives.
      const stored = await VisitEntitlement.findById(entitlement._id);
      assert.equal(stored.status, "canceled");
      assert.equal(stored.consumedAt, null);

      const state = await includedFullDayState({ user, addressId });
      assert.equal(state.used, false, "the member can book another this period");

      // And they really can, which is the point of the partial filter.
      const again = await consumeIncludedFullDay({
        user, addressId, periodStart: PERIOD_START, periodEnd: PERIOD_END, durationMinutes: 480,
      });
      assert.ok(again._id);
      assert.notEqual(String(again._id), String(entitlement._id));
    });

    await test("cancelling after the day has started does not", async () => {
      await reset();
      const { user, addressId } = await makeEliteMember();
      const entitlement = await consumeIncludedFullDay({
        user, addressId, periodStart: PERIOD_START, periodEnd: PERIOD_END, durationMinutes: 480,
      });
      const booking = await Booking.create({
        ...fullDayBookingData(user, addressId, "10000002"),
        date: new Date("2026-08-20T12:00:00Z"),
        scheduledStart: new Date("2026-08-20T12:00:00Z"),
        accessType: "membership",
        entitlementId: entitlement._id,
      });
      const result = await restoreIncludedFullDay({
        booking,
        now: new Date("2026-08-20T13:00:00Z"),
      });
      assert.equal(result.restored, false);
      assert.equal(result.reason, "day_already_started");
      assert.equal((await VisitEntitlement.findById(entitlement._id)).status, "consumed");
      assert.equal((await includedFullDayState({ user, addressId })).used, true);
    });

    await test("cancelling in a later period does not", async () => {
      await reset();
      const { user, addressId } = await makeEliteMember();
      const entitlement = await consumeIncludedFullDay({
        user, addressId, periodStart: PERIOD_START, periodEnd: PERIOD_END, durationMinutes: 480,
      });
      const booking = await Booking.create({
        ...fullDayBookingData(user, addressId, "10000003"),
        date: new Date("2026-09-25T12:00:00Z"),
        scheduledStart: new Date("2026-09-25T12:00:00Z"),
        accessType: "membership",
        entitlementId: entitlement._id,
      });
      const result = await restoreIncludedFullDay({
        booking,
        now: new Date("2026-09-20T13:00:00Z"),
      });
      assert.equal(result.restored, false);
      assert.equal(result.reason, "outside_granted_period");
    });

    await test("a paid Full Day has no benefit to hand back", async () => {
      await reset();
      const { user, addressId } = await makeEliteMember();
      const entitlement = await VisitEntitlement.create({
        user: user._id,
        userId: user.userId,
        addressId,
        kind: "full_day_visit",
        source: "purchase",
        status: "paid",
        priceCents: 49900,
      });
      const booking = await Booking.create({
        ...fullDayBookingData(user, addressId, "10000004"),
        date: new Date("2026-09-01T12:00:00Z"),
        scheduledStart: new Date("2026-09-01T12:00:00Z"),
        accessType: "one_time",
        entitlementId: entitlement._id,
      });
      const result = await restoreIncludedFullDay({
        booking,
        now: new Date("2026-08-20T15:00:00Z"),
      });
      assert.equal(result.restored, false);
      assert.equal(result.reason, "paid_full_day");
      // Untouched. Money is a separate decision, deliberately not made here.
      assert.equal((await VisitEntitlement.findById(entitlement._id)).status, "paid");
    });

    console.log("\nSelling the day: legacy calendar");

    await test("a free day is offered and a taken day is not", async () => {
      await reset();
      delete process.env.ENABLE_RESERVATION_ENGINE;
      const { fullDayAvailabilityForRange } = freshService();
      await seedLegacyCalendar();
      const date = nextOpenDate(3);
      const before = await fullDayAvailabilityForRange({ from: date, to: date });
      assert.equal(before.engine, "legacy");
      assert.equal(before.days[0].available, true);
      assert.equal(before.days[0].startTime, "08:00");

      // One ordinary booking in the middle of the day takes the whole day,
      // because maxConcurrent is 1 and a Full Day needs every hour.
      await SlotCounter.create({ ymd: date, time: "10:00", count: 1 });
      const after = await fullDayAvailabilityForRange({ from: date, to: date });
      assert.equal(after.days[0].available, false);
      assert.equal(after.days[0].reason, "Another job is already booked that day");
    });

    await test("booking a Full Day takes every hour of the day off the board", async () => {
      await reset();
      delete process.env.ENABLE_RESERVATION_ENGINE;
      const { createFullDayBooking, fullDayAvailabilityForRange } = freshService();
      await seedLegacyCalendar();
      const { user, addressId } = await makeEliteMember();
      const date = nextOpenDate(3);

      const result = await createFullDayBooking({
        date,
        actorUser: user,
        bookingData: fullDayBookingData(user, addressId, "10000010"),
      });
      assert.ok(result.booking._id);
      assert.equal(result.legacyHours.length, 7, "all seven configured hours claimed");

      const counters = await SlotCounter.find({ ymd: date }).lean();
      assert.equal(counters.length, 7);
      assert.ok(counters.every((entry) => entry.count === 1));

      // A second Full Day cannot be sold, and neither can an ordinary visit,
      // because every hour is now at capacity.
      const after = await fullDayAvailabilityForRange({ from: date, to: date });
      assert.equal(after.days[0].available, false);
      await assert.rejects(
        createFullDayBooking({
          date,
          actorUser: user,
          bookingData: fullDayBookingData(user, addressId, "10000011"),
        }),
        (error) => error.code === "FULL_DAY_UNAVAILABLE"
      );
    });

    await test("cancelling gives every hour back", async () => {
      await reset();
      delete process.env.ENABLE_RESERVATION_ENGINE;
      const { createFullDayBooking, releaseFullDayCapacity, fullDayAvailabilityForRange } =
        freshService();
      await seedLegacyCalendar();
      const { user, addressId } = await makeEliteMember();
      const date = nextOpenDate(4);

      const result = await createFullDayBooking({
        date,
        actorUser: user,
        bookingData: fullDayBookingData(user, addressId, "10000012"),
      });
      await releaseFullDayCapacity(result.booking);
      // The route marks the booking Canceled straight after releasing, and it
      // has to: an active booking still occupies its hour in the live sweep.
      await Booking.updateOne({ _id: result.booking._id }, { $set: { status: "Canceled" } });

      const counters = await SlotCounter.find({ ymd: date }).lean();
      assert.ok(
        counters.every((entry) => entry.count === 0),
        `expected every hour back at zero, got ${counters.map((c) => c.count).join(",")}`
      );
      const after = await fullDayAvailabilityForRange({ from: date, to: date });
      assert.equal(after.days[0].available, true);
    });

    console.log("\nSelling the day: reservation engine");

    await test("one Fixter free means one Full Day, and the second is refused", async () => {
      await reset();
      process.env.ENABLE_RESERVATION_ENGINE = "true";
      const { createFullDayBooking, fullDayAvailabilityForRange } = freshService();
      const fixter = await makeFixter("Solo Fixter");
      await seedReservationFoundation([fixter._id]);
      const { user, addressId } = await makeEliteMember();
      const date = nextOpenDate(5);

      const before = await fullDayAvailabilityForRange({ from: date, to: date });
      assert.equal(before.engine, "reservation");
      assert.equal(before.days[0].available, true);
      assert.equal(before.days[0].fixtersAvailable, 1);

      const result = await createFullDayBooking({
        date,
        actorUser: user,
        bookingData: fullDayBookingData(user, addressId, "10000020"),
      });
      assert.equal(String(result.technician.id), String(fixter._id));
      assert.equal(result.reservation.kind, "full_day");

      // The buckets are the guarantee: one per 15 minutes, wall to wall.
      const buckets = await ReservationTimeBucket.find({
        reservationId: result.reservation._id,
      }).lean();
      const spanMinutes =
        (result.reservation.slotEnd - result.reservation.slotStart) / 60000;
      assert.equal(buckets.length, spanMinutes / 15);
      assert.ok(buckets.every((b) => String(b.technicianId) === String(fixter._id)));

      const after = await fullDayAvailabilityForRange({ from: date, to: date });
      assert.equal(after.days[0].available, false);
      await assert.rejects(
        createFullDayBooking({
          date,
          actorUser: user,
          bookingData: fullDayBookingData(user, addressId, "10000021"),
        }),
        (error) => error.code === "FULL_DAY_UNAVAILABLE"
      );
    });

    await test("a second Fixter means a second Full Day on the same date", async () => {
      await reset();
      process.env.ENABLE_RESERVATION_ENGINE = "true";
      const { createFullDayBooking, fullDayAvailabilityForRange } = freshService();
      const [one, two] = [await makeFixter("Fixter One"), await makeFixter("Fixter Two")];
      await seedReservationFoundation([one._id, two._id]);
      const { user, addressId } = await makeEliteMember();
      const date = nextOpenDate(6);

      assert.equal(
        (await fullDayAvailabilityForRange({ from: date, to: date })).days[0].fixtersAvailable,
        2
      );
      const first = await createFullDayBooking({
        date, actorUser: user, bookingData: fullDayBookingData(user, addressId, "10000030"),
      });
      const second = await createFullDayBooking({
        date, actorUser: user, bookingData: fullDayBookingData(user, addressId, "10000031"),
      });
      assert.notEqual(String(first.technician.id), String(second.technician.id));
      assert.equal(
        (await fullDayAvailabilityForRange({ from: date, to: date })).days[0].available,
        false,
        "both Fixters are now spoken for"
      );
    });

    await test("an ordinary visit inside the day blocks that Fixter's Full Day", async () => {
      await reset();
      process.env.ENABLE_RESERVATION_ENGINE = "true";
      const { fullDayAvailabilityForRange } = freshService();
      const fixter = await makeFixter("Busy Fixter");
      await seedReservationFoundation([fixter._id]);
      const date = nextOpenDate(7);

      // A single 90-minute reservation, mid morning, held by the same buckets
      // a Full Day would need.
      const slotStart = moment.tz(`${date} 10:00`, "YYYY-MM-DD HH:mm", TZ).toDate();
      const slotEnd = new Date(slotStart.getTime() + 90 * 60 * 1000);
      const bookingId = new mongoose.Types.ObjectId();
      const reservation = await BookingSlotReservation.create({
        bookingId,
        technicianId: fixter._id,
        slotStart,
        slotEnd,
        status: "reserved",
        createdByType: "admin",
      });
      await ReservationTimeBucket.insertMany(
        Array.from({ length: 6 }, (_, index) => ({
          technicianId: fixter._id,
          bucketStart: new Date(slotStart.getTime() + index * 15 * 60 * 1000),
          bucketEnd: new Date(slotStart.getTime() + (index + 1) * 15 * 60 * 1000),
          reservationId: reservation._id,
          bookingId,
          status: "reserved",
        }))
      );

      const after = await fullDayAvailabilityForRange({ from: date, to: date });
      assert.equal(after.days[0].available, false);
      assert.equal(after.days[0].reason, "No Fixter is free for the whole day");
    });

    await test("cancelling a Full Day releases every bucket", async () => {
      await reset();
      process.env.ENABLE_RESERVATION_ENGINE = "true";
      const { createFullDayBooking, releaseFullDayCapacity, fullDayAvailabilityForRange } =
        freshService();
      const fixter = await makeFixter("Returning Fixter");
      await seedReservationFoundation([fixter._id]);
      const { user, addressId } = await makeEliteMember();
      const date = nextOpenDate(8);

      const result = await createFullDayBooking({
        date, actorUser: user, bookingData: fullDayBookingData(user, addressId, "10000040"),
      });
      await releaseFullDayCapacity(result.booking);
      await Booking.updateOne({ _id: result.booking._id }, { $set: { status: "Canceled" } });

      assert.equal(await ReservationTimeBucket.countDocuments({}), 0);
      assert.equal(
        (await BookingSlotReservation.findById(result.reservation._id)).status,
        "released"
      );
      assert.equal(
        (await fullDayAvailabilityForRange({ from: date, to: date })).days[0].available,
        true
      );
    });

    await test("a Full Day removes that Fixter from the normal booking calendar", async () => {
      await reset();
      process.env.ENABLE_RESERVATION_ENGINE = "true";
      const { createFullDayBooking } = freshService();
      const { customerDayAvailability } = require("../utils/customerCalendarService");
      const [one, two] = [await makeFixter("Calendar One"), await makeFixter("Calendar Two")];
      await seedReservationFoundation([one._id, two._id]);
      const { user, addressId } = await makeEliteMember();
      const date = nextOpenDate(10);

      // This is the shared-capacity claim, checked through the endpoint an
      // ordinary customer actually hits rather than through the Full Day code.
      const before = await customerDayAvailability({ date });
      assert.ok(before.slots.length > 0, "the day starts open to normal visits");
      const beforeRemaining = { ...before.remaining };
      assert.ok(
        Object.values(beforeRemaining).some((n) => n === 2),
        `two free Fixters should show as two, got ${JSON.stringify(beforeRemaining)}`
      );

      await createFullDayBooking({
        date, actorUser: user, bookingData: fullDayBookingData(user, addressId, "10000060"),
      });

      const after = await customerDayAvailability({ date });
      // Every slot of the day lost exactly one Fixter, not just the hour the
      // Full Day booking happens to be stamped at.
      for (const time of Object.keys(beforeRemaining)) {
        assert.equal(
          after.remaining[time],
          beforeRemaining[time] - 1,
          `slot ${time}: expected ${beforeRemaining[time] - 1}, got ${after.remaining[time]}`
        );
      }
      assert.ok(after.slots.length > 0, "the second Fixter is still bookable");
    });

    await test("the last Fixter's Full Day closes the day to normal booking entirely", async () => {
      await reset();
      process.env.ENABLE_RESERVATION_ENGINE = "true";
      const { createFullDayBooking } = freshService();
      const { customerDayAvailability } = require("../utils/customerCalendarService");
      const fixter = await makeFixter("Only Fixter");
      await seedReservationFoundation([fixter._id]);
      const { user, addressId } = await makeEliteMember();
      const date = nextOpenDate(11);

      assert.ok((await customerDayAvailability({ date })).slots.length > 0);
      await createFullDayBooking({
        date, actorUser: user, bookingData: fullDayBookingData(user, addressId, "10000070"),
      });
      const after = await customerDayAvailability({ date });
      assert.equal(after.slots.length, 0, "no normal visit can be booked that day");
      assert.equal(after.available, false);
      assert.ok(
        Object.values(after.remaining).every((n) => n === 0),
        `expected every slot at zero, got ${JSON.stringify(after.remaining)}`
      );
    });

    await test("a held, unpaid Full Day blocks normal booking too", async () => {
      await reset();
      process.env.ENABLE_RESERVATION_ENGINE = "true";
      const { createFullDayBooking } = freshService();
      const { customerDayAvailability } = require("../utils/customerCalendarService");
      const fixter = await makeFixter("Pending Fixter");
      await seedReservationFoundation([fixter._id]);
      const { user, addressId } = await makeEliteMember();
      const date = nextOpenDate(12);

      const holdExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await createFullDayBooking({
        date,
        actorUser: user,
        reservationStatus: "held",
        holdExpiresAt,
        bookingData: {
          ...fullDayBookingData(user, addressId, "10000080"),
          paymentState: "pending",
          paymentHoldExpiresAt: holdExpiresAt,
        },
      });
      // Someone is mid-checkout. Selling the day underneath them would take
      // money for a day we could not deliver.
      assert.equal((await customerDayAvailability({ date })).slots.length, 0);
    });

    await test("an expired Full Day hold gives the day back to normal booking", async () => {
      await reset();
      process.env.ENABLE_RESERVATION_ENGINE = "true";
      const { createFullDayBooking } = freshService();
      const { customerDayAvailability } = require("../utils/customerCalendarService");
      const { expireOneTimeVisitHolds } = require("../jobs/oneTimeVisitHolds");
      const fixter = await makeFixter("Lapsed Fixter");
      await seedReservationFoundation([fixter._id]);
      const { user, addressId } = await makeEliteMember();
      const date = nextOpenDate(13);

      const holdExpiresAt = new Date(Date.now() - 60 * 1000);
      const result = await createFullDayBooking({
        date,
        actorUser: user,
        reservationStatus: "held",
        holdExpiresAt: new Date(Date.now() + 60 * 1000),
        bookingData: {
          ...fullDayBookingData(user, addressId, "10000090"),
          paymentState: "pending",
          paymentHoldExpiresAt: holdExpiresAt,
        },
      });
      assert.equal((await customerDayAvailability({ date })).slots.length, 0);

      // The abandoned-checkout sweeper is the same job the one-time visit uses.
      const expired = await expireOneTimeVisitHolds(new Date());
      assert.equal(expired, 1, "the Full Day hold was swept");
      assert.equal(await ReservationTimeBucket.countDocuments({}), 0);
      assert.equal(
        (await Booking.findById(result.booking._id)).paymentState,
        "expired"
      );
      assert.ok(
        (await customerDayAvailability({ date })).slots.length > 0,
        "the day is for sale again"
      );
    });

    await test("a held Full Day still blocks the day until the hold lapses", async () => {
      await reset();
      process.env.ENABLE_RESERVATION_ENGINE = "true";
      const { createFullDayBooking, fullDayAvailabilityForRange } = freshService();
      const fixter = await makeFixter("Held Fixter");
      await seedReservationFoundation([fixter._id]);
      const { user, addressId } = await makeEliteMember();
      const date = nextOpenDate(9);

      const holdExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const result = await createFullDayBooking({
        date,
        actorUser: user,
        reservationStatus: "held",
        holdExpiresAt,
        bookingData: {
          ...fullDayBookingData(user, addressId, "10000050"),
          paymentState: "pending",
          paymentHoldExpiresAt: holdExpiresAt,
        },
      });
      assert.equal(result.reservation.status, "held");
      assert.equal(
        (await fullDayAvailabilityForRange({ from: date, to: date })).days[0].available,
        false,
        "an unpaid hold still owns the day"
      );
    });
  } finally {
    await mongoose.disconnect();
    await server.stop();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`\n${failure.name}\n`, failure.error);
    process.exit(1);
  }
}

/**
 * The service reads its engine flag at call time, but its module-level
 * dependencies are cached, so each engine's tests take a fresh copy rather than
 * trusting that nothing was memoized.
 */
function freshService() {
  delete require.cache[require.resolve("../utils/fullDayVisitService")];
  return require("../utils/fullDayVisitService");
}

/** The next weekday at least `minDays` out; the seeded calendars close Sundays. */
function nextOpenDate(minDays) {
  const cursor = moment().tz(TZ).add(minDays, "days");
  while (cursor.day() === 0) cursor.add(1, "day");
  return cursor.format("YYYY-MM-DD");
}

function fullDayBookingData(user, addressId, bookingNumber) {
  return {
    bookingNumber,
    service: "Full Day Fixter",
    selectedTask: "Full Day Fixter",
    user: user._id,
    userId: user.userId,
    name: user.name,
    phone: user.phone,
    email: user.email,
    addressId,
    address: "1 Test Street",
    city: "Babylon",
    state: "NY",
    zip: "11702",
    county: "Suffolk",
    subscription: "Elite",
    bookingType: "full_day_visit",
    accessType: "membership",
    paymentState: "not_required",
    note: "Mount TV, replace two fixtures, patch hallway",
    status: "Pending",
  };
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
