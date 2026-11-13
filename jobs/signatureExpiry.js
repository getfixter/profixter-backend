const cron = require("node-cron");

const { expireStaleRequests } = require("../utils/esign/nativeSignatureService");

/**
 * Close signing requests whose link has run out.
 *
 * A token is already refused at its expiry by the signing route, so this does
 * not decide who may sign. It only makes the record say so: without it the
 * admin keeps seeing "Sent" or "Viewed" for a dead request, and the dead
 * request keeps blocking a fresh send ("already has a request in progress").
 *
 * Every update is conditional on the token still being active, so a run that
 * overlaps a real signature or a revoke changes nothing.
 */

const SCHEDULE = "17 * * * *";

async function runSignatureExpiryCycle(now = new Date()) {
  let total = 0;
  // expireStaleRequests handles up to 200 rows per call; drain a backlog in a few passes.
  for (let pass = 0; pass < 10; pass += 1) {
    const expired = await expireStaleRequests(now);
    total += expired;
    if (expired < 200) break;
  }
  if (total > 0) console.log(JSON.stringify({ event: "signature_requests_expired", count: total }));
  return total;
}

function startSignatureExpiry() {
  let running = false;
  cron.schedule(
    SCHEDULE,
    async () => {
      if (running) return;
      running = true;
      try {
        await runSignatureExpiryCycle(new Date());
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "signature_expiry_failed",
            message: String(error?.message || "Unknown error").slice(0, 300),
          })
        );
      } finally {
        running = false;
      }
    },
    { timezone: "America/New_York" }
  );
  console.log(JSON.stringify({ event: "signature_expiry_started", schedule: SCHEDULE }));
}

module.exports = { runSignatureExpiryCycle, startSignatureExpiry, SCHEDULE };
