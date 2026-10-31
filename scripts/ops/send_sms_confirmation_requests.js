/*
 * Email the "confirm offers by text" request to every customer whose marketing
 * texts were switched on in Admin after a phone call and who has not confirmed
 * them yourself - the bulk form of the Admin button
 * (POST /api/admin/users/:id/communication/sms-confirmation).
 *
 * DRY RUN BY DEFAULT: counts who would get it and why the rest would not.
 *
 *   node scripts/ops/send_sms_confirmation_requests.js
 *   node scripts/ops/send_sms_confirmation_requests.js --send --confirm [--non-members] [--limit N]
 *
 * Changes no preference. Each customer gets it at most once per 20 hours
 * (users.smsPreferences.marketingConfirmRequestedAt), only if their email is
 * not unsubscribed or blacklisted and their phone has not texted STOP.
 */
const mongoose = require("mongoose");
const User = require("../../models/User");
const Subscription = require("../../models/Subscription");
const { marketingSmsBasis } = require("../../utils/consent/marketingSmsBasis");
const { confirmationBlocker, requestSmsConfirmation } = require("../../utils/consent/smsConfirmLink");
const { LIVE_MEMBERSHIP_STATUSES } = require("../../utils/welcomeOffer");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runConfirmationRequests({ send = false, nonMembersOnly = false, limit = Infinity, sendPromo = null, pauseMs = 300, now = () => new Date() } = {}) {
  const tally = { candidates: 0, eligible: 0, sent: 0, failed: 0, skipped: {} };
  const bump = (k) => (tally.skipped[k] = (tally.skipped[k] || 0) + 1);
  const users = await User.find({ role: { $nin: ["employee", "admin"] }, "smsPreferences.marketingEnabled": true }).lean();
  const live = new Set((await Subscription.find({ status: { $in: LIVE_MEMBERSHIP_STATUSES } }).select("user").lean()).map((s) => String(s.user)));
  for (const user of users) {
    if (user.employeePosition) continue;
    if (marketingSmsBasis(user).status !== "needs_confirmation") continue;
    tally.candidates++;
    if (nonMembersOnly && live.has(String(user._id))) {
      bump("member");
      continue;
    }
    const blocker = await confirmationBlocker(user, now());
    if (blocker) {
      bump(blocker);
      continue;
    }
    tally.eligible++;
    if (!send || tally.sent >= limit) continue;
    try {
      await requestSmsConfirmation({ userId: user._id, admin: { name: "owner-approved bulk request" }, sendPromo, now: now() });
      tally.sent++;
    } catch (error) {
      tally.failed++;
      bump(`send_${error.code || "error"}`);
      console.error(JSON.stringify({ event: "sms_confirmation_request_failed", userId: String(user._id), error: String(error.message).slice(0, 200) }));
    }
    await sleep(pauseMs);
  }
  return tally;
}

module.exports = { runConfirmationRequests };

if (require.main === module) {
  const args = process.argv.slice(2);
  const send = args.includes("--send");
  if (send && !args.includes("--confirm")) {
    console.error("Refusing to send without --confirm.");
    process.exit(2);
  }
  const i = args.indexOf("--limit");
  const limit = i >= 0 ? Number(args[i + 1]) : Infinity;
  (async () => {
    await mongoose.connect(process.env.MONGO_URI);
    const tally = await runConfirmationRequests({ send, nonMembersOnly: args.includes("--non-members"), limit });
    console.log(JSON.stringify({ mode: send ? "send" : "dry-run", ...tally }, null, 2));
    await mongoose.disconnect();
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
