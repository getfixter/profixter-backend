const cron = require("node-cron");
const service = require("../utils/recentWork/workPhotoService");

/**
 * The clock that makes a Fixter's five minutes real.
 *
 * THE BROWSER IS NOT THE AUTHORITY. The countdown a Fixter sees is a rendering
 * of publishAt, which is already in the database before they see it; close the
 * tab, lose signal, drop the phone in a sink, and the photo still goes live on
 * time. That is the whole reason the delay is stored as an instant rather than
 * run as a timer somewhere.
 *
 * Its own cron rather than a fourth sweep inside the booking reminders: those
 * exist to talk to customers about appointments, and a photo gallery borrowing
 * their cycle would mean an image-processing failure showing up as a reminder
 * sweep error. Same shape, same minute, separate concerns.
 *
 * Duplicate-safe by construction. The promotion is a conditional updateMany -
 * the filter says "still scheduled", so a second worker a millisecond later
 * matches nothing. There is no claim field because there is nothing to claim:
 * the write is the claim.
 */

function errorDetails(error) {
  return {
    message: String(error?.message || "Unknown error").slice(0, 300),
    name: error?.name || "",
  };
}

async function runRecentWorkCycle(now = new Date()) {
  const published = await service.publishDueScheduled(now);

  /*
   * Retry storage for anything deleted while S3 was unreachable. Bounded and
   * safe to repeat: it only touches rows that already say they are deleted.
   */
  let purge = { scanned: 0, purged: 0 };
  try {
    purge = await service.purgePendingDeletions(25);
  } catch (error) {
    console.warn(JSON.stringify({ event: "recent_work_purge_failed", error: errorDetails(error) }));
  }

  if (published.published || purge.purged) {
    console.log(
      JSON.stringify({
        event: "recent_work_cycle",
        at: now.toISOString(),
        published: published.published,
        storagePurged: purge.purged,
      })
    );
  }
  return { ...published, ...purge };
}

function startRecentWorkPublisher() {
  let running = false;

  cron.schedule(
    "* * * * *",
    async () => {
      /* A slow cycle must not start a second one on top of itself. */
      if (running) return;
      running = true;
      try {
        await runRecentWorkCycle(new Date());
      } catch (error) {
        console.error(
          JSON.stringify({ event: "recent_work_cycle_failed", error: errorDetails(error) })
        );
      } finally {
        running = false;
      }
    },
    { timezone: "America/New_York" }
  );

  console.log(
    JSON.stringify({
      event: "recent_work_cron_started",
      cycle: "* * * * *",
      timezone: "America/New_York",
    })
  );
}

module.exports = { runRecentWorkCycle, startRecentWorkPublisher };
