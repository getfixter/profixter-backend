/**
 * A Full Day is the Fixter's whole day, however it got into the database.
 *
 * test_full_day_visit_integration.js proves a freshly booked Full Day holds its
 * day. This proves the day stays held after what happens to a real booking
 * next, and that the server, not just the calendar, refuses to sell into it:
 *
 *   Admin Confirm, reassign and reschedule used to rebuild every reservation as
 *   90 minutes from its start. A paid Full Day confirmed in Admin became an
 *   8:00-9:30 visit, and 10:30, 13:00 and 15:30 went back on sale. That is the
 *   October 24 booking, and the first tests here are that sequence.
 *
 *   Full Day records already narrowed that way, or with no reservation at all,
 *   must still read as the whole day, because nobody rewrote them.
 *
 * MongoDB is real and in memory, as a single-node replica set so the
 * reservation engine's transactions run for real.
 *
 *   node scripts/test_full_day_capacity_integration.js
 *
 * Not part of `npm test`, for the same reason as the other in-memory suites: it
 * downloads and boots a MongoDB binary.
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";
process.env.CLIENT_URL = "https://www.profixter.com";
process.env.ENABLE_RESERVATION_ENGINE = "true";

const assert = require("assert");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Booking = require("../models/Booking");
const BookingSlotReservation = require("../models/BookingSlotReservation");
const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
const ReservationCapacityBucket = require("../models/ReservationCapacityBucket");
const ReservationTimeBucket = require("../models/ReservationTimeBucket");
const User = require("../models/User");

const {
  createFullDayBooking,
  fullDayAvailabilityForRange,
} = require("../utils/fullDayVisitService");
const {
  cancelBookingWithReservation,
  createBookingWithReservation,
  findEligibleTechnicians,
  moveReservationForBooking,
  promoteHeldReservationForBooking,
} = require("../utils/slotReservationService");
const {
  applyMemberVisitLeadTime,
  customerDayAvailability,
  customerMonthAvailability,
} = require("../utils/customerCalendarService");

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
// Production's day: four 90-minute starts, Tuesday to Saturday.
const STARTS = ["08:00", "10:30", "13:00", "15:30"];
const LATER = ["10:30", "13:00", "15:30"];

let counter = 20000000;
const nextNumber = () => String((counter += 1));

async function seedFoundation(capacity) {
  await CompanyAvailabilityTemplate.deleteMany({});
  await CompanyAvailabilityTemplate.create({
    active: true,
    timezone: TZ,
    slotMinutes: 90,
    minLeadMinutes: 0,
    maxAdvanceDays: 120,
    defaultCapacity: capacity,
    visitDurationMinutes: 90,
    weeklySchedule: Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      enabled: weekday !== 0 && weekday !== 1,
      starts: STARTS.map((time) => ({ time, capacity: null })),
      intervals: [{ startTime: "08:00", endTime: "17:00", capacity: null }],
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

async function makeCustomer() {
  const addressId = new mongoose.Types.ObjectId();
  const user = await User.create({
    name: "Test Customer",
    email: `customer.${nextNumber()}@test.local`,
    password: "hashed",
    phone: "+15550001111",
    userId: String(Math.floor(10000000 + Math.random() * 89999999)),
    role: "customer",
    addresses: [{ _id: addressId, label: "Home", line1: "1 Test Street", city: "Babylon", state: "NY", zip: "11702", county: "Suffolk" }],
    defaultAddressId: addressId,
  });
  return { user, addressId };
}

async function setup({ fixters = 1 } = {}) {
  await Promise.all([
    Booking.deleteMany({}),
    BookingSlotReservation.deleteMany({}),
    ReservationTimeBucket.deleteMany({}),
    ReservationCapacityBucket.deleteMany({}),
    User.deleteMany({}),
  ]);
  const team = [];
  for (let index = 0; index < fixters; index += 1) {
    team.push(await makeFixter(`Fixter ${index + 1}`));
  }
  await seedFoundation(fixters);
  const customer = await makeCustomer();
  return { team, ...customer };
}

function base(user, addressId) {
  return {
    bookingNumber: nextNumber(),
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
    note: "Hang shelves and fix a door",
    status: "Pending",
  };
}

/** Every product that books a normal 90-minute visit, shaped as its route shapes it. */
const PRODUCTS = {
  membership: (user, addressId) => ({
    ...base(user, addressId),
    service: "Handyman visit",
    subscription: "Elite",
    accessType: "membership",
    bookingType: "membership_visit",
    paymentState: "not_required",
  }),
  free_first_visit: (user, addressId) => ({
    ...base(user, addressId),
    service: "Handyman visit",
    subscription: "Free visit",
    accessType: "free_first_visit",
    bookingType: "membership_visit",
    paymentState: "not_required",
    isFreeFirstVisit: true,
  }),
  extra_visit: (user, addressId) => ({
    ...base(user, addressId),
    service: "Handyman visit",
    subscription: "Elite",
    accessType: "one_time",
    bookingType: "one_time_handyman_visit",
    paymentState: "pending",
  }),
  one_time: (user, addressId) => ({
    ...base(user, addressId),
    service: "Handyman visit",
    subscription: "One-time visit",
    accessType: "one_time",
    bookingType: "one_time_handyman_visit",
    paymentState: "pending",
  }),
};

function fullDayData(user, addressId, extra = {}) {
  return {
    ...base(user, addressId),
    service: "Full Day Fixter",
    selectedTask: "Full Day Fixter",
    subscription: "Full Day Fixter",
    accessType: "one_time",
    bookingType: "full_day_visit",
    paymentState: "paid",
    paymentStatus: "Paid",
    ...extra,
  };
}

const at = (date, time) => moment.tz(`${date} ${time}`, "YYYY-MM-DD HH:mm", TZ).toDate();

/** A Saturday at least `minDays` out: a working day in the seeded week, like October 24. */
function nextSaturday(minDays) {
  const cursor = moment().tz(TZ).add(minDays, "days");
  while (cursor.day() !== 6) cursor.add(1, "day");
  return cursor.format("YYYY-MM-DD");
}

/** Book a normal visit exactly as the customer routes do. */
function bookVisit({ product, date, time, user, addressId }) {
  const paid = product === "extra_visit" || product === "one_time";
  return createBookingWithReservation({
    bookingData: PRODUCTS[product](user, addressId),
    slotStart: at(date, time),
    createdByType: "customer",
    actorUser: user,
    assignmentSource: "automatic",
    ...(paid
      ? { reservationStatus: "held", holdExpiresAt: new Date(Date.now() + 30 * 60 * 1000) }
      : {}),
  });
}

/** The paid Full Day the way checkout and the webhook produce it. */
async function paidFullDay({ date, user, addressId }) {
  const holdExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
  const result = await createFullDayBooking({
    date,
    actorUser: user,
    reservationStatus: "held",
    holdExpiresAt,
    bookingData: fullDayData(user, addressId, {
      paymentState: "pending",
      paymentStatus: "Pending",
      paymentHoldExpiresAt: holdExpiresAt,
    }),
  });
  await promoteHeldReservationForBooking({ bookingId: result.booking._id });
  await Booking.updateOne(
    { _id: result.booking._id },
    { $set: { paymentState: "paid", paymentStatus: "Paid" } }
  );
  return result;
}

/**
 * What Admin's Confirm button does to a booking: PUT /bookings/:id/status with
 * the assignee, which runs moveReservationForBooking with the booking's own
 * start and Fixter.
 */
async function adminConfirm(bookingId, technicianId) {
  await moveReservationForBooking({
    bookingId,
    technicianId,
    slotStart: (await Booking.findById(bookingId)).date,
    createdByType: "admin",
    assignmentSource: "admin",
  });
  await Booking.updateOne({ _id: bookingId }, { $set: { status: "Confirmed" } });
}

/**
 * A Full Day as the bug left it: the booking says Full Day, the reservation and
 * its buckets say 8:00-9:30. Written directly, because the code that wrote it is
 * the code under repair.
 */
async function narrowedFullDay({ date, fixter, user, addressId, status = "Confirmed" }) {
  const start = at(date, "08:00");
  const end = new Date(start.getTime() + 90 * 60 * 1000);
  const booking = await Booking.create({
    ...fullDayData(user, addressId),
    date: start,
    status,
    assignedFixterId: fixter._id,
    assignedFixterName: fixter.name,
    scheduledStart: start,
    scheduledEnd: end,
  });
  const reservation = await BookingSlotReservation.create({
    bookingId: booking._id,
    technicianId: fixter._id,
    kind: "full_day",
    slotStart: start,
    slotEnd: end,
    status: "reserved",
    createdByType: "admin",
  });
  await ReservationTimeBucket.insertMany(
    Array.from({ length: 6 }, (_, index) => ({
      technicianId: fixter._id,
      bucketStart: new Date(start.getTime() + index * 15 * 60 * 1000),
      bucketEnd: new Date(start.getTime() + (index + 1) * 15 * 60 * 1000),
      reservationId: reservation._id,
      bookingId: booking._id,
      status: "reserved",
    }))
  );
  await Booking.updateOne({ _id: booking._id }, { $set: { slotReservationId: reservation._id } });
  return { booking, reservation };
}

const refusedAsTaken = (error) =>
  ["SLOT_UNAVAILABLE", "SLOT_CONFLICT", "TECHNICIAN_UNAVAILABLE"].includes(error?.code);

async function assertDayClosed(date, label = "") {
  const day = await customerDayAvailability({ date });
  assert.deepEqual(day.slots, [], `${label} no bookable time, got ${JSON.stringify(day.slots)}`);
  assert.equal(day.available, false);
  // Booked times stay listed, as unavailable, which is how the calendar shows them.
  assert.deepEqual(day.candidateSlots.map((slot) => slot.time), STARTS);
  assert.ok(day.candidateSlots.every((slot) => slot.available === false));
  return day;
}

async function assertNoVisitCanBeBooked({ date, user, addressId, times = STARTS }) {
  for (const product of Object.keys(PRODUCTS)) {
    for (const time of times) {
      await assert.rejects(
        bookVisit({ product, date, time, user, addressId }),
        refusedAsTaken,
        `${product} at ${time} must be refused`
      );
    }
  }
}

async function run() {
  const server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(server.getUri(), { dbName: "fulldaycapacity" });
  await Promise.all([
    Booking.init(),
    BookingSlotReservation.init(),
    ReservationTimeBucket.init(),
    ReservationCapacityBucket.init(),
  ]);

  try {
    console.log("\nThe October 24 sequence: paid Full Day, then Admin Confirm");

    await test("Admin Confirm keeps a paid Full Day as the whole day", async () => {
      const { team, user, addressId } = await setup();
      const date = nextSaturday(10);
      const { booking } = await paidFullDay({ date, user, addressId });
      await adminConfirm(booking._id, team[0]._id);

      const reservation = await BookingSlotReservation.findOne({
        bookingId: booking._id,
        status: "reserved",
      }).lean();
      assert.equal(reservation.kind, "full_day");
      assert.equal(reservation.slotStart.toISOString(), at(date, "08:00").toISOString());
      assert.equal(reservation.slotEnd.toISOString(), at(date, "17:00").toISOString());
      assert.equal(
        await ReservationTimeBucket.countDocuments({ reservationId: reservation._id }),
        36,
        "9 hours of 15-minute buckets"
      );
      const after = await Booking.findById(booking._id).lean();
      assert.equal(after.scheduledEnd.toISOString(), at(date, "17:00").toISOString());
      assert.equal(after.bookingType, "full_day_visit");
      assert.equal(after.paymentState, "paid", "payment untouched");
    });

    await test("after Confirm, 10:30, 13:00 and 15:30 are not offered", async () => {
      const { team, user, addressId } = await setup();
      const date = nextSaturday(10);
      const { booking } = await paidFullDay({ date, user, addressId });
      await adminConfirm(booking._id, team[0]._id);
      await assertDayClosed(date, "confirmed Full Day:");
    });

    await test("after Confirm, every product is refused by the server at every time", async () => {
      const { team, user, addressId } = await setup();
      const date = nextSaturday(10);
      const { booking } = await paidFullDay({ date, user, addressId });
      await adminConfirm(booking._id, team[0]._id);
      await assertNoVisitCanBeBooked({ date, user, addressId });
      await assert.rejects(
        createFullDayBooking({ date, actorUser: user, bookingData: fullDayData(user, addressId) }),
        (error) => error.code === "FULL_DAY_UNAVAILABLE"
      );
    });

    console.log("\nA. Full Day on an empty day, one Fixter");

    await test("the Full Day books and every other visit type is unavailable", async () => {
      const { team, user, addressId } = await setup();
      const date = nextSaturday(10);
      assert.equal((await customerDayAvailability({ date })).slots.length, 4);
      const result = await paidFullDay({ date, user, addressId });
      assert.equal(String(result.technician.id), String(team[0]._id));
      await assertDayClosed(date);
      await assertNoVisitCanBeBooked({ date, user, addressId });
    });

    console.log("\nB. A Full Day exists");

    await test("membership, free first visit, extra visit, one-time and a second Full Day are all refused", async () => {
      const { user, addressId } = await setup();
      const date = nextSaturday(10);
      await paidFullDay({ date, user, addressId });
      await assertNoVisitCanBeBooked({ date, user, addressId });
      await assert.rejects(
        createFullDayBooking({ date, actorUser: user, bookingData: fullDayData(user, addressId) }),
        (error) => error.code === "FULL_DAY_UNAVAILABLE"
      );
      assert.equal(await Booking.countDocuments({}), 1, "nothing else was written");
    });

    await test("the membership-visit calendar reads the same closed day", async () => {
      const { user, addressId } = await setup();
      const date = nextSaturday(10);
      await paidFullDay({ date, user, addressId });
      const day = applyMemberVisitLeadTime(await customerDayAvailability({ date }));
      assert.deepEqual(day.slots, []);
      const month = await customerMonthAvailability({ month: date.slice(0, 7) });
      const entry = month.days.find((item) => item.date === date);
      assert.equal(entry.available, false);
      assert.deepEqual(entry.slots, []);
    });

    console.log("\nC. A normal visit already exists");

    for (const product of Object.keys(PRODUCTS)) {
      await test(`a ${product} at 13:00 blocks a Full Day that day`, async () => {
        const { user, addressId } = await setup();
        const date = nextSaturday(10);
        await bookVisit({ product, date, time: "13:00", user, addressId });
        assert.equal(
          (await fullDayAvailabilityForRange({ from: date, to: date })).days[0].available,
          false
        );
        await assert.rejects(
          createFullDayBooking({ date, actorUser: user, bookingData: fullDayData(user, addressId) }),
          (error) => error.code === "FULL_DAY_UNAVAILABLE"
        );
      });
    }

    console.log("\nD. A cancelled Full Day");

    await test("cancelling a confirmed Full Day gives every slot back", async () => {
      const { team, user, addressId } = await setup();
      const date = nextSaturday(10);
      const { booking } = await paidFullDay({ date, user, addressId });
      await adminConfirm(booking._id, team[0]._id);
      await cancelBookingWithReservation({ bookingId: booking._id, createdByType: "admin", reason: "test" });
      assert.deepEqual((await customerDayAvailability({ date })).slots, STARTS);
      await bookVisit({ product: "membership", date, time: "10:30", user, addressId });
    });

    await test("cancelling an already-narrowed historical Full Day gives the day back", async () => {
      const { team, user, addressId } = await setup();
      const date = nextSaturday(10);
      const { booking } = await narrowedFullDay({ date, fixter: team[0], user, addressId });
      await cancelBookingWithReservation({ bookingId: booking._id, createdByType: "admin", reason: "test" });
      assert.deepEqual((await customerDayAvailability({ date })).slots, STARTS);
    });

    console.log("\nE. Full Days that do not hold capacity");

    for (const [status, paymentState] of [
      ["Canceled", "expired"],
      ["Canceled", "failed"],
      ["Failed", "failed"],
      ["Completed", "paid"],
    ]) {
      await test(`a ${status} Full Day (${paymentState}) does not close the day`, async () => {
        const { team, user, addressId } = await setup();
        const date = nextSaturday(10);
        await Booking.create({
          ...fullDayData(user, addressId, { paymentState }),
          date: at(date, "08:00"),
          status,
          assignedFixterId: team[0]._id,
        });
        assert.deepEqual((await customerDayAvailability({ date })).slots, STARTS);
        await bookVisit({ product: "one_time", date, time: "13:00", user, addressId });
      });
    }

    console.log("\nF. Pending and Confirmed hold the day the same way");

    for (const status of ["Pending", "Confirmed"]) {
      await test(`a ${status} Full Day closes the day`, async () => {
        const { team, user, addressId } = await setup();
        const date = nextSaturday(10);
        const { booking } = await paidFullDay({ date, user, addressId });
        if (status === "Confirmed") await adminConfirm(booking._id, team[0]._id);
        assert.equal((await Booking.findById(booking._id)).status, status);
        await assertDayClosed(date);
        await assertNoVisitCanBeBooked({ date, user, addressId, times: LATER });
      });
    }

    console.log("\nG. Full Day records written before the fix");

    await test("a Full Day narrowed to 8:00-9:30 still closes the whole day", async () => {
      const { team, user, addressId } = await setup();
      const date = nextSaturday(10);
      await narrowedFullDay({ date, fixter: team[0], user, addressId });
      await assertDayClosed(date, "narrowed Full Day:");
      await assertNoVisitCanBeBooked({ date, user, addressId, times: LATER });
      assert.equal(
        (await fullDayAvailabilityForRange({ from: date, to: date })).days[0].available,
        false
      );
    });

    await test("reading a narrowed Full Day changes nothing in the database", async () => {
      const { team, user, addressId } = await setup();
      const date = nextSaturday(10);
      const { booking, reservation } = await narrowedFullDay({ date, fixter: team[0], user, addressId });
      const before = JSON.stringify([
        await Booking.findById(booking._id).lean(),
        await BookingSlotReservation.findById(reservation._id).lean(),
        await ReservationTimeBucket.countDocuments({}),
      ]);
      await customerDayAvailability({ date });
      await customerMonthAvailability({ month: date.slice(0, 7) });
      await fullDayAvailabilityForRange({ from: date, to: date });
      await assertNoVisitCanBeBooked({ date, user, addressId, times: LATER });
      const after = JSON.stringify([
        await Booking.findById(booking._id).lean(),
        await BookingSlotReservation.findById(reservation._id).lean(),
        await ReservationTimeBucket.countDocuments({}),
      ]);
      assert.equal(after, before);
    });

    await test("a Full Day with no reservation at all still closes the day", async () => {
      const { team, user, addressId } = await setup();
      const date = nextSaturday(10);
      await Booking.create({
        ...fullDayData(user, addressId),
        date: at(date, "08:00"),
        status: "Pending",
        assignedFixterId: team[0]._id,
      });
      await assertDayClosed(date);
      await assertNoVisitCanBeBooked({ date, user, addressId, times: LATER });
    });

    await test("confirming a narrowed Full Day again widens it back to the whole day", async () => {
      const { team, user, addressId } = await setup();
      const date = nextSaturday(10);
      const { booking } = await narrowedFullDay({ date, fixter: team[0], user, addressId });
      await adminConfirm(booking._id, team[0]._id);
      const reservation = await BookingSlotReservation.findOne({ bookingId: booking._id, status: "reserved" });
      assert.equal(reservation.slotEnd.toISOString(), at(date, "17:00").toISOString());
      assert.equal(await ReservationTimeBucket.countDocuments({ reservationId: reservation._id }), 36);
    });

    await test("Admin assignment options still list the Full Day's own Fixter", async () => {
      const { team, user, addressId } = await setup();
      const date = nextSaturday(10);
      const { booking } = await paidFullDay({ date, user, addressId });
      const options = await findEligibleTechnicians({
        slotStart: booking.booking?.date || (await Booking.findById(booking._id)).date,
        excludeReservationId: (await Booking.findById(booking._id)).slotReservationId,
        excludeBookingId: booking._id,
      });
      assert.equal(String(options.recommended?.id), String(team[0]._id));
    });

    await test("rescheduling a Full Day moves the whole day, and frees the old one", async () => {
      const { team, user, addressId } = await setup();
      const date = nextSaturday(10);
      const later = nextSaturday(17);
      const { booking } = await paidFullDay({ date, user, addressId });
      await moveReservationForBooking({
        bookingId: booking._id,
        technicianId: team[0]._id,
        slotStart: at(later, "08:00"),
        createdByType: "admin",
      });
      assert.deepEqual((await customerDayAvailability({ date })).slots, STARTS);
      await assertDayClosed(later);
    });

    await test("a Full Day cannot be moved onto a day that already has a visit", async () => {
      const { team, user, addressId } = await setup();
      const date = nextSaturday(10);
      const later = nextSaturday(17);
      const { booking } = await paidFullDay({ date, user, addressId });
      await bookVisit({ product: "membership", date: later, time: "15:30", user, addressId });
      await assert.rejects(
        moveReservationForBooking({
          bookingId: booking._id,
          technicianId: team[0]._id,
          slotStart: at(later, "08:00"),
          createdByType: "admin",
        }),
        refusedAsTaken
      );
      await assertDayClosed(date, "original day still held:");
    });

    console.log("\nH. More than one Fixter");

    await test("with two Fixters, a Full Day takes one of them, not the day", async () => {
      const { team, user, addressId } = await setup({ fixters: 2 });
      const date = nextSaturday(10);
      const { booking, technician } = await paidFullDay({ date, user, addressId });
      await adminConfirm(booking._id, technician.id);
      const day = await customerDayAvailability({ date });
      assert.deepEqual(day.slots, STARTS);
      assert.ok(Object.values(day.remaining).every((n) => n === 1), JSON.stringify(day.remaining));

      const other = team.find((fixter) => String(fixter._id) !== String(technician.id));
      const visit = await bookVisit({ product: "membership", date, time: "10:30", user, addressId });
      assert.equal(String(visit.technician._id), String(other._id), "the visit goes to the free Fixter");
      await assert.rejects(
        bookVisit({ product: "one_time", date, time: "10:30", user, addressId }),
        refusedAsTaken,
        "and 10:30 is then full"
      );
      // The Full Day Fixter cannot be chosen directly either.
      await assert.rejects(
        createBookingWithReservation({
          bookingData: PRODUCTS.membership(user, addressId),
          slotStart: at(date, "13:00"),
          technicianId: technician.id,
          createdByType: "admin",
        }),
        refusedAsTaken
      );
    });

    console.log("\nI. Stale availability and races");

    await test("a slot shown before the Full Day was bought is refused after", async () => {
      const { user, addressId } = await setup();
      const date = nextSaturday(10);
      const stale = await customerDayAvailability({ date });
      assert.ok(stale.slots.includes("10:30"), "customer A sees 10:30");
      await paidFullDay({ date, user, addressId });
      await assert.rejects(
        bookVisit({ product: "one_time", date, time: "10:30", user, addressId }),
        refusedAsTaken
      );
    });

    await test("a slot shown before a narrowed Full Day existed is refused after", async () => {
      const { team, user, addressId } = await setup();
      const date = nextSaturday(10);
      const stale = await customerDayAvailability({ date });
      assert.ok(stale.slots.includes("13:00"));
      await narrowedFullDay({ date, fixter: team[0], user, addressId });
      await assert.rejects(
        bookVisit({ product: "membership", date, time: "13:00", user, addressId }),
        refusedAsTaken
      );
    });

    for (let round = 0; round < 5; round += 1) {
      await test(`a Full Day and a visit racing for one Fixter never both win (round ${round + 1})`, async () => {
        const { user, addressId } = await setup();
        const date = nextSaturday(10);
        const outcomes = await Promise.allSettled([
          createFullDayBooking({ date, actorUser: user, bookingData: fullDayData(user, addressId) }),
          bookVisit({ product: "membership", date, time: "13:00", user, addressId }),
          bookVisit({ product: "one_time", date, time: "10:30", user, addressId }),
        ]);
        const fullDayWon = outcomes[0].status === "fulfilled";
        const visitsWon = outcomes.slice(1).filter((o) => o.status === "fulfilled").length;
        assert.ok(!(fullDayWon && visitsWon > 0), "a Full Day and a visit were both accepted");
        assert.ok(fullDayWon || visitsWon > 0, "somebody should have won");
        const live = await Booking.find({ status: { $ne: "Canceled" } }).lean();
        assert.equal(live.length, fullDayWon ? 1 : visitsWon);
      });
    }

    console.log("\nJ. Date and timezone boundaries");

    await test("a Full Day closes only its own local service date", async () => {
      const { user, addressId } = await setup();
      const date = nextSaturday(10);
      const before = moment.tz(date, TZ).subtract(1, "day").format("YYYY-MM-DD");
      const after = moment.tz(date, TZ).add(3, "day").format("YYYY-MM-DD"); // Tuesday
      await paidFullDay({ date, user, addressId });
      await assertDayClosed(date);
      assert.deepEqual((await customerDayAvailability({ date: before })).slots, STARTS);
      assert.deepEqual((await customerDayAvailability({ date: after })).slots, STARTS);
      await bookVisit({ product: "membership", date: before, time: "15:30", user, addressId });
      await bookVisit({ product: "membership", date: after, time: "08:00", user, addressId });
    });

    await test("a Full Day stamped 8:00 local is 12:00Z and does not leak into the UTC day", async () => {
      const { user, addressId } = await setup();
      const date = nextSaturday(10);
      const { booking } = await paidFullDay({ date, user, addressId });
      const stored = await Booking.findById(booking._id).lean();
      assert.equal(moment(stored.date).tz(TZ).format("YYYY-MM-DD HH:mm"), `${date} 08:00`);
      const nextDay = moment.tz(date, TZ).add(1, "day").format("YYYY-MM-DD"); // closed Sunday
      assert.deepEqual((await customerDayAvailability({ date: nextDay })).slots, []);
      const month = await customerMonthAvailability({ month: date.slice(0, 7) });
      const closedDays = month.days.filter((day) => day.date === date && day.available);
      assert.equal(closedDays.length, 0);
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

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
