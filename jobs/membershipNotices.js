const cron = require("node-cron");
const { sendDueRestorationNotices } = require("../utils/membershipRestoredNotice");

/**
 * Sends operator-requested "membership restored" notices.
 *
 * Does nothing unless a request exists, and each request is claimed before it
 * is sent, so every instance can run this safely. See
 * utils/membershipRestoredNotice for the exactly-once rules.
 */
function startMembershipNotices() {
  cron.schedule("*/2 * * * *", async () => {
    try {
      const stats = await sendDueRestorationNotices();
      if (stats.claimed) console.log("[membership-notices]", JSON.stringify(stats));
    } catch (error) {
      console.error("[membership-notices] run failed:", error?.message || error);
    }
  });
}

module.exports = { startMembershipNotices };
