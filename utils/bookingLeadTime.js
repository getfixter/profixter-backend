const moment = require("moment-timezone");

const TIMEZONE = "America/New_York";

/**
 * HOW FAR AHEAD A MEMBER HAS TO BOOK A REGULAR VISIT.
 *
 * Seven CALENDAR days, not a hundred and sixty-eight hours, and the difference
 * is the whole reason this lives in its own module rather than as a bigger
 * number in the availability template.
 *
 * The company template already carries `minLeadMinutes`, and the reservation
 * engine spends it as an instant: `now + minutes`. That is right for "this slot
 * has already started" and wrong for "book a week ahead". At 6pm on the 17th a
 * minutes rule puts the earliest bookable moment at 6pm on the 24th, which
 * quietly deletes the 24th's eight, ten and twelve o'clock slots and moves the
 * first bookable DATE to the 25th — a rule nobody wrote and nobody can explain
 * to a customer. Days are counted as days here: midnight to midnight in New
 * York, so the answer does not change depending on when in the day you ask.
 *
 * This applies to REGULAR MEMBERSHIP VISITS ONLY. First Visit Free, One-Time
 * Visits and Full Days keep the company template's own lead time; they are
 * different products with different promises, and two of them are paid.
 */
const MEMBER_VISIT_MIN_LEAD_DAYS = 7;

/** The calendar date "today" is, in the company's timezone. */
function todayYMD(now = new Date(), timezone = TIMEZONE) {
  return moment(now).tz(timezone).format("YYYY-MM-DD");
}

/**
 * The first date a regular membership visit may be booked for.
 *
 * today + leadDays, as dates. With the default seven, a member standing here on
 * Thursday 17 September is offered Thursday 24 September, at any hour of the
 * 17th.
 */
function earliestMemberVisitYMD(
  now = new Date(),
  timezone = TIMEZONE,
  leadDays = MEMBER_VISIT_MIN_LEAD_DAYS
) {
  return moment(now)
    .tz(timezone)
    .startOf("day")
    .add(Number(leadDays) || 0, "days")
    .format("YYYY-MM-DD");
}

/**
 * Is this date inside the blocked window for a regular membership visit?
 *
 * Compares YYYY-MM-DD strings, which sort lexicographically in date order — no
 * Date objects, no instants, nothing that can drift across a timezone boundary
 * between two lines of code.
 */
function isBeforeEarliestMemberVisit(
  ymd,
  now = new Date(),
  timezone = TIMEZONE,
  leadDays = MEMBER_VISIT_MIN_LEAD_DAYS
) {
  if (typeof ymd !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  return ymd < earliestMemberVisitYMD(now, timezone, leadDays);
}

/**
 * The date a booking falls on, in company time.
 *
 * Bookings are stored as instants. A visit at 8am on the 24th is 12:00 UTC, and
 * asking a UTC Date what day it is answers correctly here only by luck — in the
 * other direction (an evening slot) it does not. Always ask the timezone.
 */
function bookingYMD(date, timezone = TIMEZONE) {
  return moment(date).tz(timezone).format("YYYY-MM-DD");
}

/**
 * THE RULE IS INTERNAL. THE REFUSAL SAYS NOTHING ABOUT IT.
 *
 * A customer never learns that a seven-day rule exists — not from a banner, not
 * from help text, and not from this. They see a calendar that offers the dates
 * they can have, which is how every other constraint in this system already
 * behaves: a Sunday is not offered either, and nobody explains that either.
 *
 * So the message and the code are the ordinary unavailable-date vocabulary this
 * route already speaks, and the number seven appears nowhere a customer can
 * reach. `BOOKING_TOO_SOON` was the first draft and is gone: an integration
 * reading it would have deduced exactly the rule we are not disclosing.
 *
 * The earliest permitted date still travels with the refusal, because a date is
 * not an explanation — it is the same thing the calendar was already showing,
 * and it lets the client move the customer forward instead of leaving them
 * stuck on a date that will never work.
 */
const MEMBER_VISIT_LEAD_ERROR_CODE = "DATE_UNAVAILABLE";

function memberVisitLeadMessage() {
  return "That date isn't available. Please choose another date.";
}

module.exports = {
  MEMBER_VISIT_MIN_LEAD_DAYS,
  MEMBER_VISIT_LEAD_ERROR_CODE,
  TIMEZONE,
  todayYMD,
  earliestMemberVisitYMD,
  isBeforeEarliestMemberVisit,
  bookingYMD,
  memberVisitLeadMessage,
};
