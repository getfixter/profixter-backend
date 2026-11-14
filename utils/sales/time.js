/**
 * Pay weeks and bonus periods, in America/New_York, daylight saving included.
 *
 * PAY WEEK: Friday 00:00:00.000 New York (inclusive) to the next Friday
 * 00:00:00.000 New York (exclusive). Payday is that next Friday: the one
 * immediately after the Thursday that ends the week. A week is named by its
 * starting Friday ("2026-11-13"). Boundaries are computed as wall-clock
 * dates in New York, never as "+7 × 24 hours": the week that contains the
 * November change is 169 hours long and the March one 167.
 *
 * BONUS PERIOD: anchored on the New York calendar date of an employee's first
 * verified qualifying membership sale. Period n starts at 00:00 New York on
 * anchor + n calendar months, ALWAYS computed from the original anchor, so a
 * 31st becomes the last day of a shorter month and then returns to the 31st
 * (Jan 31 → Feb 28 → Mar 31 → Apr 30 …). Each period ends exclusive at the next
 * period's start, so periods never overlap and never leave a gap.
 */
const moment = require("moment-timezone");

const TZ = "America/New_York";
const FRIDAY = 5;

const nyDate = (date) => moment(date).tz(TZ).format("YYYY-MM-DD");
const startOfNyDay = (ymd) => moment.tz(ymd, "YYYY-MM-DD", TZ).startOf("day");

/** The pay week containing `date`. */
function payWeekOf(date) {
  const local = moment(date).tz(TZ);
  const back = (local.day() - FRIDAY + 7) % 7;
  const start = local.clone().startOf("day").subtract(back, "days");
  return weekFromStart(start.format("YYYY-MM-DD"));
}

/** A pay week by its starting Friday ("YYYY-MM-DD"). */
function weekFromStart(weekKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(weekKey || ""))) throw new Error(`bad week ${weekKey}`);
  const start = startOfNyDay(weekKey);
  if (start.day() !== FRIDAY) throw new Error(`week ${weekKey} does not start on a Friday`);
  const end = startOfNyDay(weekKey).add(7, "days");
  return {
    week: start.format("YYYY-MM-DD"),
    startsAt: start.toDate(),
    endsAt: end.toDate(),
    /* The last day of the week, for display ("Fri Nov 13 – Thu Nov 19"). */
    lastDay: startOfNyDay(weekKey).add(6, "days").format("YYYY-MM-DD"),
    payday: end.format("YYYY-MM-DD"),
  };
}

const nextWeekKey = (weekKey) => startOfNyDay(weekKey).add(7, "days").format("YYYY-MM-DD");

/** Bonus period `index` (0-based) for an anchor date. */
function bonusPeriod(anchorDate, index) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(anchorDate || ""))) throw new Error(`bad anchor ${anchorDate}`);
  // moment clamps month arithmetic to the end of a shorter month, and we always add to the ORIGINAL anchor.
  const start = startOfNyDay(anchorDate).add(index, "months");
  const end = startOfNyDay(anchorDate).add(index + 1, "months");
  return {
    index,
    anchorDate,
    startsAt: start.toDate(),
    endsAt: end.toDate(),
    firstDay: start.format("YYYY-MM-DD"),
    lastDay: end.clone().subtract(1, "day").format("YYYY-MM-DD"),
  };
}

/**
 * The bonus period index containing `date`. Before the anchor the same
 * anniversary calendar runs backwards (-1 is the month before period 0, and so
 * on), so a payment always lands in the month-long period that contains it.
 */
function bonusPeriodIndexFor(anchorDate, date) {
  const t = new Date(date).getTime();
  if (t < startOfNyDay(anchorDate).valueOf()) {
    let i = -1;
    while (bonusPeriod(anchorDate, i).startsAt.getTime() > t) i -= 1;
    return i;
  }
  const local = moment(date).tz(TZ);
  const a = startOfNyDay(anchorDate);
  let i = Math.max(0, (local.year() - a.year()) * 12 + (local.month() - a.month()) - 1);
  while (bonusPeriod(anchorDate, i + 1).startsAt.getTime() <= t) i += 1;
  while (i > 0 && bonusPeriod(anchorDate, i).startsAt.getTime() > t) i -= 1;
  return i;
}

/** "Fri Nov 13" style, New York. */
const shortDay = (ymdOrDate) => (typeof ymdOrDate === "string" ? startOfNyDay(ymdOrDate) : moment(ymdOrDate).tz(TZ)).format("ddd MMM D");

module.exports = { TZ, nyDate, payWeekOf, weekFromStart, nextWeekKey, bonusPeriod, bonusPeriodIndexFor, shortDay };
