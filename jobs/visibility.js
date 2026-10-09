const cron = require("node-cron");
const { runCollector } = require("../utils/visibility/collectors");

/**
 * Local-visibility monitoring for the Growth Command Center: Google review
 * count, Search Console, Maps local-pack rank and AI-answer visibility.
 *
 * Registered on every instance; each tick goes through runCollector, which
 * does nothing unless that collector's flag is on and its credentials are
 * set, and lets only one instance run it (Mongo lease). Everything is off by
 * default except the daily review snapshot, which reuses the site's existing
 * Places key at about two cents a day (see utils/visibility/googleReviews).
 *
 * Times are New York, spread out so no two collectors start together, and
 * early in the morning so the Command Center is fresh when the day starts:
 *   06:10 daily    Google review count
 *   07:20 daily    Search Console (re-reads the last three published days)
 *   05:30 Monday   local-rank tasks posted to DataForSEO's standard queue
 *   every 10 min   local-rank results collected (a single state read when idle)
 *   06:40 Monday   AI-answer visibility
 *
 * Not armed under NODE_ENV=test.
 */
const TIMEZONE = "America/New_York";

const SCHEDULES = [
  { collector: "google_reviews", cron: "10 6 * * *" },
  { collector: "search_console", cron: "20 7 * * *" },
  { collector: "local_rank", cron: "30 5 * * 1" },
  { collector: "local_rank_collect", cron: "*/10 * * * *" },
  { collector: "ai_visibility", cron: "40 6 * * 1" },
];

function startVisibilityJobs() {
  if (process.env.NODE_ENV === "test") return false;
  for (const { collector, cron: expression } of SCHEDULES) {
    cron.schedule(expression, () => runCollector(collector, { now: new Date() }), { timezone: TIMEZONE });
  }
  console.log(JSON.stringify({ event: "visibility_jobs_started", schedules: SCHEDULES }));
  return true;
}

module.exports = { startVisibilityJobs, SCHEDULES };
