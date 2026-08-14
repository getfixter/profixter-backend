const cron = require("node-cron");
const { BATCH, TIMEZONE, marketingEnabled } = require("../utils/marketing/marketingConfig");
const { runMarketingCycle } = require("../utils/marketing/marketingRunner");

/**
 * The marketing cron.
 *
 * Runs every ten minutes and does nothing at all unless ENABLE_MARKETING_EMAILS
 * is true and the clock is inside the send window, so deploying this file is
 * safe on its own. Deployment and activation are two separate decisions, and
 * the second one is the customer's to make.
 *
 * Kept apart from the booking reminder cron on purpose. Marketing must never be
 * able to delay or break a transactional email, so they do not share a cycle,
 * a lock, or a failure path.
 */
function startMarketingEmails() {
  let running = false;

  cron.schedule(
    "*/10 * * * *",
    async () => {
      if (!marketingEnabled()) return;
      if (running) {
        console.warn(JSON.stringify({ event: "marketing_cycle_overlapped", scope: "marketing" }));
        return;
      }
      running = true;
      try {
        await runMarketingCycle({ now: new Date() });
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "marketing_cron_failed",
            scope: "marketing",
            message: error?.message || "",
          })
        );
      } finally {
        running = false;
      }
    },
    { timezone: TIMEZONE }
  );

  console.log(
    JSON.stringify({
      event: "marketing_cron_started",
      scope: "marketing",
      cycle: "*/10 * * * *",
      timezone: TIMEZONE,
      enabled: marketingEnabled(),
      maxPerRun: BATCH.maxPerRun,
      maxPerDay: BATCH.maxPerDay,
    })
  );
}

module.exports = { startMarketingEmails };
