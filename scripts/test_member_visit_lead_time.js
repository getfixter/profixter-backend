const assert = require("assert");
const moment = require("moment-timezone");

const {
  MEMBER_VISIT_MIN_LEAD_DAYS,
  MEMBER_VISIT_LEAD_ERROR_CODE,
  earliestMemberVisitYMD,
  isBeforeEarliestMemberVisit,
  bookingYMD,
  memberVisitLeadMessage,
} = require("../utils/bookingLeadTime");

const TZ = "America/New_York";

/**
 * The seven-day rule for regular membership visits.
 *
 * The boundary is the whole test. A lead time expressed in hours passes a
 * casual "is it about a week" check and fails the only question that matters —
 * which DATE can a member pick — differently depending on what time they ask.
 * So every case here fixes a clock time as well as a date.
 */
function run() {
  assert.equal(MEMBER_VISIT_MIN_LEAD_DAYS, 7, "lead time must be seven days");

  /* The worked example from the brief: Thursday 17 September 2026. */
  const morning = new Date("2026-09-17T12:00:00Z"); // 08:00 in New York
  assert.equal(earliestMemberVisitYMD(morning), "2026-09-24");

  /* today -> rejected */
  assert.equal(isBeforeEarliestMemberVisit("2026-09-17", morning), true);

  /* today + 1 .. +6 -> rejected */
  for (let offset = 1; offset <= 6; offset += 1) {
    const ymd = moment.tz("2026-09-17", "YYYY-MM-DD", TZ)
      .add(offset, "days")
      .format("YYYY-MM-DD");
    assert.equal(
      isBeforeEarliestMemberVisit(ymd, morning),
      true,
      `today+${offset} (${ymd}) must be refused`
    );
  }

  /* today + 7 -> allowed */
  assert.equal(isBeforeEarliestMemberVisit("2026-09-24", morning), false);

  /* later dates -> allowed, left to the existing availability rules */
  assert.equal(isBeforeEarliestMemberVisit("2026-09-25", morning), false);
  assert.equal(isBeforeEarliestMemberVisit("2026-12-01", morning), false);

  /*
   * IT IS A DATE RULE, NOT A HUNDRED AND SIXTY-EIGHT HOURS.
   *
   * The same answer at every hour of the same day, including the last half
   * hour of it. A minutes-based rule fails all three of these: at 6pm it would
   * push the earliest bookable moment to 6pm on the 24th and take that day's
   * morning with it.
   */
  const sameDayClockTimes = [
    "2026-09-17T04:01:00Z", // 00:01 in New York
    "2026-09-17T12:00:00Z", // 08:00
    "2026-09-17T22:00:00Z", // 18:00 — the case named in the brief
    "2026-09-18T03:59:00Z", // 23:59
  ];
  for (const iso of sameDayClockTimes) {
    const now = new Date(iso);
    assert.equal(
      earliestMemberVisitYMD(now),
      "2026-09-24",
      `earliest date must not move at ${moment(now).tz(TZ).format("HH:mm")}`
    );
    assert.equal(isBeforeEarliestMemberVisit("2026-09-24", now), false);
    assert.equal(isBeforeEarliestMemberVisit("2026-09-23", now), true);
  }

  /*
   * Across the New York date boundary.
   *
   * 03:30 UTC is still the previous evening in New York, and 04:30 UTC is the
   * next morning. A rule that reads the UTC date gets these the wrong way
   * round for five hours every night.
   */
  assert.equal(
    earliestMemberVisitYMD(new Date("2026-09-18T03:30:00Z")),
    "2026-09-24",
    "23:30 on the 17th in New York is still the 17th"
  );
  assert.equal(
    earliestMemberVisitYMD(new Date("2026-09-18T04:30:00Z")),
    "2026-09-25",
    "00:30 on the 18th in New York is the 18th"
  );

  /* Across a daylight-saving transition, where a day is 23 or 25 hours long. */
  assert.equal(
    earliestMemberVisitYMD(new Date("2026-10-30T12:00:00Z")),
    "2026-11-06",
    "seven days across the DST fallback is still seven dates"
  );
  assert.equal(
    earliestMemberVisitYMD(new Date("2026-03-05T12:00:00Z")),
    "2026-03-12",
    "seven days across the DST spring forward is still seven dates"
  );

  /* A booking's date is read in company time, not UTC. */
  assert.equal(bookingYMD(new Date("2026-09-25T00:30:00Z")), "2026-09-24");
  assert.equal(bookingYMD(new Date("2026-09-24T12:00:00Z")), "2026-09-24");

  /* Junk in, no opinion out: the caller's own validation owns bad input. */
  assert.equal(isBeforeEarliestMemberVisit("", morning), false);
  assert.equal(isBeforeEarliestMemberVisit("not-a-date", morning), false);
  assert.equal(isBeforeEarliestMemberVisit(null, morning), false);

  /*
   * THE RULE IS NEVER DISCLOSED TO A CUSTOMER.
   *
   * This is the assertion that stops a well-meaning future change from putting
   * "book at least 7 days ahead" into a refusal, a tooltip or a banner. The
   * message is the ordinary unavailable-date sentence; the code is the ordinary
   * unavailable-date code. Nothing in either reveals that a lead time exists,
   * let alone how long it is.
   */
  const message = memberVisitLeadMessage();
  const forbidden = [
    "7",
    "seven",
    "lead",
    "advance",
    "days ahead",
    "days in advance",
    "week",
    "too soon",
    "minimum",
  ];
  for (const term of forbidden) {
    assert.ok(
      !message.toLowerCase().includes(term.toLowerCase()),
      `customer-facing message must not mention "${term}": ${message}`
    );
  }
  assert.equal(message, "That date isn't available. Please choose another date.");
  assert.equal(
    MEMBER_VISIT_LEAD_ERROR_CODE,
    "DATE_UNAVAILABLE",
    "the error code must not describe the rule either"
  );
  for (const term of ["SOON", "LEAD", "ADVANCE", "7"]) {
    assert.ok(
      !MEMBER_VISIT_LEAD_ERROR_CODE.includes(term),
      `error code must not hint at the rule: ${MEMBER_VISIT_LEAD_ERROR_CODE}`
    );
  }

  /*
   * AND NOTHING LEAKS THROUGH THE CONFIG PAYLOADS EITHER.
   *
   * Both customer calendar config builders are read as source and checked for
   * the rule. A refusal is not the only way to disclose a policy — publishing
   * `memberVisitMinLeadDays: 7` in a public, unauthenticated config endpoint
   * would have told anyone who looked, without a word of copy anywhere. It was
   * in that payload for one draft. This is the guard that keeps it out.
   */
  const fs = require("fs");
  const path = require("path");
  const payloadSources = [
    "../utils/customerCalendarService.js",
    "../routes/calendar.js",
  ];
  for (const relative of payloadSources) {
    const source = fs.readFileSync(path.join(__dirname, relative), "utf8");
    /* Comments explain the decision; only emitted fields are the concern. */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const banned of [
      "memberVisitMinLeadDays",
      "MEMBER_VISIT_MIN_LEAD_DAYS",
      "minLeadDays: 7",
    ]) {
      assert.ok(
        !code.includes(banned),
        `${relative} must not publish the rule (found "${banned}")`
      );
    }
    assert.ok(
      code.includes("earliestBookableDate"),
      `${relative} must still publish the date the calendar needs`
    );
  }

  console.log("member visit lead time: all assertions passed");
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { run };
