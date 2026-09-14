const cron = require("node-cron");

const LoyaltyGrant = require("../models/LoyaltyGrant");
const Subscription = require("../models/Subscription");
const User = require("../models/User");
const VisitEntitlement = require("../models/VisitEntitlement");
const mail = require("../utils/emailService");
const { loyaltyActive } = require("../utils/loyalty/loyaltyConfig");
const { describeReward } = require("../utils/loyalty/loyaltyProgress");
const { congratulate } = require("../utils/loyalty/loyaltyNotify");

/**
 * "Your Loyalty Benefit ends soon."
 *
 * IT GRANTS NOTHING, REVOKES NOTHING, AND NOTHING DEPENDS ON IT RUNNING.
 *
 * Whether a benefit is live is a date comparison made wherever the question is
 * asked, so a delayed or dead sweep cannot extend a benefit past its end or cut
 * one short. The same separation the gift lifecycle uses, for the same reason:
 * a job that decides entitlement means one missed run silently costs a customer
 * something they hold, and nobody notices until they try to book.
 *
 * What this does is the one part that genuinely has to be initiated — sending
 * an email — because a benefit quietly running out produces no Stripe event and
 * no customer action to hang it on. An unused complimentary month is the
 * program failing at its own purpose, and a week's notice is the cheapest fix
 * for that.
 *
 * Idempotent by a stamp claimed BEFORE the send, so two instances behind the
 * load balancer cannot both email the same member.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How much warning is useful: long enough to book, short enough to act on. */
const TIER_UPGRADE_NOTICE_DAYS = 7;
const FULL_DAY_NOTICE_DAYS = 14;
const BATCH_LIMIT = 200;

function log(level, event, details = {}) {
  const payload = JSON.stringify({ level, event, scope: "loyalty_reminders", ...details });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

/**
 * Claim the reminder, then send it.
 *
 * This order is the whole concurrency story. The stamp is set with a
 * conditional update that only one caller can win, so a second instance finds
 * nothing to claim and sends nothing. Released again on failure so the next
 * run retries rather than the customer silently never hearing.
 */
async function claim(grantId) {
  const claimed = await LoyaltyGrant.findOneAndUpdate(
    { _id: grantId, expiryNotifiedAt: null },
    { $set: { expiryNotifiedAt: new Date() } },
    { new: true }
  );
  return !!claimed;
}

async function release(grantId) {
  await LoyaltyGrant.updateOne({ _id: grantId }, { $set: { expiryNotifiedAt: null } }).catch(
    () => {}
  );
}

async function sendExpiring({ grant, endsOn }) {
  const user = await User.findById(grant.user).lean();
  if (!user?.email) return false;

  const subscription = await Subscription.findOne({
    user: grant.user,
    addressId: grant.addressId,
    status: { $in: ["active", "trialing"] },
  }).lean();

  // A benefit belonging to a membership that has already ended is not news.
  if (!subscription) return false;

  const described = describeReward({
    kind: grant.rewardKind,
    rewardPlan: grant.rewardPlan,
    cycles: grant.cycles,
  });

  await mail.sendTx(
    "loyalty_benefit_expiring",
    user.email,
    {
      name: user.name || String(user.email).split("@")[0],
      rewardHeadline: described?.headline || "Your Loyalty Benefit",
      endsOn: endsOn ? mail.formatNYCTime(new Date(endsOn).toISOString()) : null,
      address: subscription.addressSnapshot
        ? `${subscription.addressSnapshot.line1}, ${subscription.addressSnapshot.city}, ${subscription.addressSnapshot.state}`
        : null,
    },
    {
      bccAdmin: false,
      logContext: {
        userId: user._id,
        customerName: user.name || "",
        customerEmail: user.email,
        recipientName: user.name || "",
        recipientEmail: user.email,
        emailType: "billing",
        source: "loyaltyReminders",
      },
    }
  );
  return true;
}

/** Temporary plan upgrades running out within the notice window. */
async function remindExpiringUpgrades(now = new Date()) {
  const grants = await LoyaltyGrant.find({
    rewardKind: "tier_upgrade",
    status: "granted",
    expiryNotifiedAt: null,
    effectiveUntil: {
      $gt: now,
      $lte: new Date(now.getTime() + TIER_UPGRADE_NOTICE_DAYS * DAY_MS),
    },
  })
    .limit(BATCH_LIMIT)
    .lean();

  let sent = 0;
  for (const grant of grants) {
    if (!(await claim(grant._id))) continue;
    try {
      if (await sendExpiring({ grant, endsOn: grant.effectiveUntil })) sent += 1;
    } catch (error) {
      await release(grant._id);
      log("warn", "loyalty_expiry_email_failed", {
        loyaltyGrantId: String(grant._id),
        message: error?.message,
      });
    }
  }
  return { considered: grants.length, sent };
}

/** Unused Elite Loyalty Full Days approaching their ninety-day limit. */
async function remindExpiringFullDays(now = new Date()) {
  const entitlements = await VisitEntitlement.find({
    source: "loyalty_benefit",
    status: "paid",
    expiresAt: {
      $gt: now,
      $lte: new Date(now.getTime() + FULL_DAY_NOTICE_DAYS * DAY_MS),
    },
  })
    .limit(BATCH_LIMIT)
    .lean();

  let sent = 0;
  for (const entitlement of entitlements) {
    if (!entitlement.loyaltyGrantId) continue;
    const grant = await LoyaltyGrant.findById(entitlement.loyaltyGrantId).lean();
    if (!grant || grant.expiryNotifiedAt) continue;
    if (!(await claim(grant._id))) continue;
    try {
      if (await sendExpiring({ grant, endsOn: entitlement.expiresAt })) sent += 1;
    } catch (error) {
      await release(grant._id);
      log("warn", "loyalty_expiry_email_failed", {
        loyaltyGrantId: String(grant._id),
        message: error?.message,
      });
    }
  }
  return { considered: entitlements.length, sent };
}

/**
 * Congratulations that never made it out.
 *
 * The send happens inline when the reward is granted, so this only ever finds
 * the ones a transient failure left behind — a mail provider blip, a Twilio
 * timeout. Each channel carries its own stamp, so a grant whose email went and
 * whose text did not gets only the text retried; congratulate() re-claims per
 * channel and the one already stamped is skipped.
 *
 * Bounded to a week. A congratulation a fortnight late is worse than none, and
 * an unbounded sweep would keep re-reading every grant the programme ever made.
 */
async function retryMissedCongratulations(now = new Date()) {
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const pending = await LoyaltyGrant.find({
    grantedAt: { $gte: since },
    status: { $ne: "failed" },
    $or: [{ emailNotifiedAt: null }, { smsNotifiedAt: null }],
  })
    .limit(BATCH_LIMIT)
    .lean();

  let retried = 0;
  for (const grant of pending) {
    const user = await User.findById(grant.user);
    if (!user) continue;
    const subscription = await Subscription.findOne({
      user: grant.user,
      addressId: grant.addressId,
    }).sort({ currentPeriodStart: -1, updatedAt: -1 });

    const result = await congratulate({ grant, user, subscription });
    if (result?.email?.sent || result?.sms?.sent) retried += 1;
  }
  return { considered: pending.length, retried };
}

async function runLoyaltyReminders(now = new Date()) {
  if (!loyaltyActive()) return { skipped: "program_inactive" };

  const upgrades = await remindExpiringUpgrades(now);
  const days = await remindExpiringFullDays(now);
  const missed = await retryMissedCongratulations(now);
  const summary = {
    upgradesConsidered: upgrades.considered,
    upgradesSent: upgrades.sent,
    fullDaysConsidered: days.considered,
    fullDaysSent: days.sent,
    congratulationsRetried: missed.retried,
  };
  if (summary.upgradesSent || summary.fullDaysSent || summary.congratulationsRetried) {
    log("info", "loyalty_reminders_completed", summary);
  }
  return summary;
}

/**
 * Once a day, in the morning in New York.
 *
 * Registered unconditionally and gated internally on the program switch, on the
 * same reasoning as marketing and SMS: deploying the code and turning the
 * program on stay two separate decisions.
 */
function startLoyaltyReminders() {
  cron.schedule(
    "0 10 * * *",
    async () => {
      try {
        await runLoyaltyReminders();
      } catch (error) {
        log("error", "loyalty_reminders_failed", { message: error?.message });
      }
    },
    { timezone: "America/New_York" }
  );
}

module.exports = {
  FULL_DAY_NOTICE_DAYS,
  TIER_UPGRADE_NOTICE_DAYS,
  remindExpiringFullDays,
  remindExpiringUpgrades,
  retryMissedCongratulations,
  runLoyaltyReminders,
  startLoyaltyReminders,
};
