/**
 * The member calendar offers only what the member booking route accepts.
 *
 * The seven-day rule (utils/bookingLeadTime.js) was enforced when a booking was
 * created but not when availability was listed, so the calendar offered — and
 * auto-selected — dates the API then refused. These assertions pin both halves
 * to the same function, and pin the slot list that lets a booked time stay
 * visible without ever counting as availability.
 *
 * No database: the reservation engine is driven through its injected
 * dependencies, the same way test_customer_booking_cutover.js does it.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const moment = require("moment-timezone");
const {
  applyMemberVisitLeadTime,
  customerDayAvailability,
  customerMonthAvailability,
} = require("../utils/customerCalendarService");
const {
  earliestMemberVisitYMD,
  isBeforeEarliestMemberVisit,
} = require("../utils/bookingLeadTime");

const TZ = "America/New_York";
const TIMES = ["08:00", "10:30", "13:00", "15:30"];

/* Thursday 1 October 2026, mid-morning in New York. Earliest member date: the 8th. */
const NOW = new Date("2026-10-01T14:00:00Z");

const noReservations = {
  find() {
    return { async lean() { return []; } };
  },
};

/* One technician per slot; `bookedTimes` are already taken by a booking. */
function engineDay(date, bookedTimes = []) {
  return {
    date,
    timezone: TZ,
    slots: TIMES.map((time) => {
      const booked = bookedTimes.includes(time);
      return {
        time,
        configuredCapacity: 1,
        usedCapacity: booked ? 1 : 0,
        open: !booked,
        technicians: [{ id: "tech-1", available: true, booked }],
      };
    }),
  };
}

async function day(date, { memberVisit, booked = [], now = NOW } = {}) {
  return customerDayAvailability({
    date,
    now,
    memberVisit,
    dependencies: {
      calculateDayAvailability: async () => engineDay(date, booked),
      ReservationModel: noReservations,
    },
  });
}

async function run() {
  assert.equal(earliestMemberVisitYMD(NOW), "2026-10-08");

  /* 1. Inside the window, with a free technician: not offered to a member. */
  const tooSoon = await day("2026-10-05", { memberVisit: true });
  assert.equal(tooSoon.available, false);
  assert.equal(tooSoon.availableSlotCount, 0);
  assert.deepEqual(tooSoon.slots, []);
  assert.ok(tooSoon.candidateSlots.every((slot) => slot.available === false));
  assert.equal(tooSoon.closed, true);
  /* The last blocked date is the 7th. */
  assert.equal((await day("2026-10-07", { memberVisit: true })).available, false);

  /* ...but the same day is still open to the products that keep their own lead time. */
  const notMember = await day("2026-10-05", { memberVisit: false });
  assert.equal(notMember.available, true);
  assert.deepEqual(notMember.slots, TIMES);

  /* 2. The first legal date is offered. */
  const firstLegal = await day("2026-10-08", { memberVisit: true });
  assert.equal(firstLegal.available, true);
  assert.deepEqual(firstLegal.slots, TIMES);

  /* 3. Two of four booked: the day is open, all four are listed, two are bookable. */
  const partly = await day("2026-10-09", {
    memberVisit: true,
    booked: ["08:00", "13:00"],
  });
  assert.equal(partly.available, true);
  assert.equal(partly.availableSlotCount, 2);
  assert.deepEqual(partly.slots, ["10:30", "15:30"]);
  assert.deepEqual(partly.candidateSlots, [
    { time: "08:00", available: false },
    { time: "10:30", available: true },
    { time: "13:00", available: false },
    { time: "15:30", available: true },
  ]);

  /* 4. Every slot booked: candidates still listed, but the day is closed. */
  const full = await day("2026-10-10", { memberVisit: true, booked: TIMES });
  assert.equal(full.available, false);
  assert.equal(full.availableSlotCount, 0);
  assert.equal(full.candidateSlots.length, 4);
  assert.ok(full.candidateSlots.every((slot) => slot.available === false));

  /* A reservation hold makes a slot unavailable exactly as a booking does. */
  const held = await customerDayAvailability({
    date: "2026-10-09",
    now: NOW,
    memberVisit: true,
    dependencies: {
      calculateDayAvailability: async () => engineDay("2026-10-09"),
      ReservationModel: {
        find() {
          return {
            async lean() {
              return [{
                technicianId: "tech-1",
                status: "reserved",
                slotStart: moment.tz("2026-10-09 10:30", "YYYY-MM-DD HH:mm", TZ).toDate(),
                slotEnd: moment.tz("2026-10-09 12:00", "YYYY-MM-DD HH:mm", TZ).toDate(),
              }];
            },
          };
        },
      },
    },
  });
  assert.equal(
    held.candidateSlots.find((slot) => slot.time === "10:30").available,
    false
  );
  assert.equal(held.slots.includes("10:30"), false);

  /* Month view: the same rule, the same candidates, per day. */
  const month = await customerMonthAvailability({
    month: "2026-10",
    now: NOW,
    memberVisit: true,
    dependencies: {
      loadAvailabilityContext: async () => ({ timezone: TZ }),
      calculateDayFromContext: ({ date }) =>
        engineDay(date, date === "2026-10-12" ? TIMES : ["08:00"]),
      ReservationModel: noReservations,
    },
  });
  const byDate = Object.fromEntries(month.days.map((entry) => [entry.date, entry]));
  for (let d = 1; d <= 7; d += 1) {
    const ymd = `2026-10-0${d}`;
    assert.equal(byDate[ymd].available, false, `${ymd} is inside the window`);
    assert.equal(byDate[ymd].open, false);
    assert.deepEqual(byDate[ymd].slots, []);
  }
  assert.equal(byDate["2026-10-08"].available, true);
  assert.deepEqual(byDate["2026-10-08"].slots, ["10:30", "13:00", "15:30"]);
  assert.equal(byDate["2026-10-08"].candidateSlots.length, 4);
  assert.equal(byDate["2026-10-12"].available, false, "fully booked day is closed");
  const firstOpen = month.days.find((entry) => entry.available);
  assert.equal(firstOpen.date, "2026-10-08", "the first offered date is the first legal one");

  /*
   * 8. The boundary, in New York time.
   *
   * 23:59 NY on the 1st is already the 2nd in UTC; the window must not move
   * until New York's midnight. And across the November fall-back, seven days
   * are still seven dates.
   */
  const lateEvening = new Date("2026-10-02T03:59:00Z"); // 23:59 EDT, Oct 1
  assert.equal((await day("2026-10-07", { memberVisit: true, now: lateEvening })).available, false);
  assert.equal((await day("2026-10-08", { memberVisit: true, now: lateEvening })).available, true);
  const afterMidnight = new Date("2026-10-02T04:01:00Z"); // 00:01 EDT, Oct 2
  assert.equal((await day("2026-10-08", { memberVisit: true, now: afterMidnight })).available, false);
  assert.equal((await day("2026-10-09", { memberVisit: true, now: afterMidnight })).available, true);
  const beforeFallBack = new Date("2026-10-30T16:00:00Z"); // Fri Oct 30, EDT
  assert.equal(earliestMemberVisitYMD(beforeFallBack), "2026-11-06");
  assert.equal((await day("2026-11-05", { memberVisit: true, now: beforeFallBack })).available, false);
  assert.equal((await day("2026-11-06", { memberVisit: true, now: beforeFallBack })).available, true);

  /* The availability rule and the booking rule are one function, so they agree on every date. */
  for (let offset = 0; offset < 14; offset += 1) {
    const ymd = moment(NOW).tz(TZ).add(offset, "days").format("YYYY-MM-DD");
    const offered = (await day(ymd, { memberVisit: true })).available;
    assert.equal(offered, !isBeforeEarliestMemberVisit(ymd, NOW), ymd);
  }

  /* Legacy engine shape: the same helper closes it the same way. */
  const legacy = applyMemberVisitLeadTime(
    {
      date: "2026-10-05",
      slots: ["08:00"],
      candidateSlots: [{ time: "08:00", available: true }],
      taken: {},
      capacityPerSlot: 1,
    },
    NOW
  );
  assert.equal(legacy.available, false);
  assert.deepEqual(legacy.slots, []);
  assert.deepEqual(legacy.candidateSlots, [{ time: "08:00", available: false }]);
  const legacyLegal = { date: "2026-10-08", slots: ["08:00"], candidateSlots: [] };
  assert.equal(applyMemberVisitLeadTime(legacyLegal, NOW), legacyLegal);

  /*
   * 6 & 7. The server still refuses what the calendar no longer offers.
   *
   * The calendar is presentation; the booking route is the rule. These pin the
   * route's own checks, which do not depend on anything the calendar sends.
   */
  const read = (relative) =>
    fs.readFileSync(path.join(__dirname, relative), "utf8");
  const bookings = read("../routes/bookings.js");
  assert.match(
    bookings,
    /if \(activeSub\) \{\s*const requestedYMD = bookingYMD\(bookingDate\);\s*if \(isBeforeEarliestMemberVisit\(requestedYMD\)\)/,
    "member bookings inside the window must still be refused server-side"
  );
  assert.match(bookings, /code: "SLOT_UNAVAILABLE"/, "taken slots must still be refused server-side");
  assert.ok(
    !/req\.query\.visit|isMemberVisitRequest/.test(bookings),
    "the booking route must decide membership itself, never from the calendar flag"
  );

  /* Both engines honour the flag, so flipping ENABLE_RESERVATION_ENGINE cannot regress it. */
  const calendar = read("../routes/calendar.js");
  assert.match(calendar, /customerDayAvailability\(\{ date, memberVisit \}\)/);
  assert.match(calendar, /memberVisit: isMemberVisitRequest\(req\)/);
  assert.match(calendar, /applyMemberVisitLeadTime\(day\)/);

  console.log("member calendar availability: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
