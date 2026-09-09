const Booking = require("../../models/Booking");
const SmsCampaign = require("../../models/SmsCampaign");
const SmsMessage = require("../../models/SmsMessage");
const Subscription = require("../../models/Subscription");
const User = require("../../models/User");

const { BATCH, smsMarketingEnabled } = require("./smsConfig");
const dedupe = require("./smsDedupe");
const { newYorkParts } = require("./smsEligibility");
const { sendMarketingSms } = require("./smsService");

/**
 * Native marketing SMS to existing ProFixter customers.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
 * Occasional, configurable messages to people who already have an account with
 * us and have affirmatively agreed to receive them. It is not lead prospecting:
 * new leads and nurture stay in GoHighLevel, which is what that tool is for.
 *
 * EVERY DEFAULT IS THE CAUTIOUS ONE
 * Campaigns start disabled. The channel starts disabled. Nobody is opted in.
 * The per-run and per-day ceilings are small. The cooldowns are long. This is
 * deliberate: the failure mode of a marketing SMS system is not sending too
 * few, it is sending too many to somebody who did not want any, which costs a
 * customer and a compliance complaint rather than an opportunity.
 */

const CAMPAIGN_TYPE = {
  kitchen_bath: "KITCHEN_BATH_MARKETING",
  membership: "MEMBERSHIP_MARKETING",
  seasonal: "SEASONAL_MARKETING",
  other: "SEASONAL_MARKETING",
};

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days, now = new Date()) {
  return new Date(new Date(now).getTime() - Number(days || 0) * DAY_MS);
}

/**
 * Whether a campaign may run at this moment.
 *
 * Checked before any audience is resolved, so a campaign outside its window
 * costs one comparison rather than a database sweep.
 */
function campaignRunnable(campaign, now = new Date()) {
  if (!campaign?.enabled) return { runnable: false, reason: "campaign_disabled" };
  if (campaign.startsAt && new Date(campaign.startsAt) > now) {
    return { runnable: false, reason: "campaign_not_started" };
  }
  if (campaign.endsAt && new Date(campaign.endsAt) < now) {
    return { runnable: false, reason: "campaign_ended" };
  }

  const { hour, dayOfWeek } = newYorkParts(now);
  const window = campaign.sendWindow || {};
  const days = Array.isArray(window.daysOfWeek) && window.daysOfWeek.length
    ? window.daysOfWeek
    : [1, 2, 3, 4, 5, 6];
  if (!days.includes(dayOfWeek)) return { runnable: false, reason: "outside_send_days" };

  const startHour = Number.isFinite(window.startHour) ? window.startHour : 11;
  const endHour = Number.isFinite(window.endHour) ? window.endHour : 18;
  if (hour < startHour || hour >= endHour) {
    return { runnable: false, reason: "outside_send_hours" };
  }
  return { runnable: true, reason: "runnable" };
}

/**
 * The membership state that decides audience membership.
 *
 * Read from Subscription rather than the legacy User.subscription string, which
 * is stale on many records and was never authoritative. "Active" means the same
 * thing the rest of the product means by it: active or trialing.
 */
async function membershipStateOf(userId, { SubscriptionModel = Subscription } = {}) {
  const active = await SubscriptionModel.exists({
    user: userId,
    status: { $in: ["active", "trialing"] },
  });
  if (active) return "member";
  const ever = await SubscriptionModel.exists({ user: userId });
  return ever ? "former_member" : "non_member";
}

/**
 * Whether one person may receive one campaign, and if so which cycle.
 *
 * Returns the cycle number because the caller needs it for the dedupe key. The
 * separation matters: the cycle is what makes a deliberate resend six months
 * later a different key rather than a duplicate, while two workers computing
 * the same cycle collide exactly as intended.
 */
async function personEligibleForCampaign(
  user,
  campaign,
  { now = new Date(), MessageModel = SmsMessage, SubscriptionModel = Subscription, BookingModel = Booking } = {}
) {
  const audience = campaign.audience || {};

  /*
   * The account-level rule is checked here as well as in the eligibility
   * engine. Not redundant: doing it here avoids claiming a dedupe key and
   * writing a suppressed row for every unconsented customer on every run,
   * which would fill the audit collection with noise about people we were
   * never going to text.
   */
  if (user?.smsPreferences?.marketingEnabled !== true) {
    return { eligible: false, reason: "marketing_not_opted_in" };
  }
  if (user?.excludeFromMarketing === true) {
    return { eligible: false, reason: "account_excluded_from_marketing" };
  }
  if (!user?.phone) return { eligible: false, reason: "no_phone" };

  const minAge = Number(audience.minAccountAgeDays || 0);
  if (minAge > 0 && user.createdAt && new Date(user.createdAt) > daysAgo(minAge, now)) {
    return { eligible: false, reason: "account_too_new" };
  }

  if (audience.membership && audience.membership !== "any") {
    const state = await membershipStateOf(user._id, { SubscriptionModel });
    if (state !== audience.membership) {
      return { eligible: false, reason: `wrong_audience_${state}` };
    }
  }

  if (audience.requiresCompletedBooking) {
    const completed = await BookingModel.exists({ user: user._id, status: /^completed$/i });
    if (!completed) return { eligible: false, reason: "no_completed_booking" };
  }

  const excludeDays = Number(audience.excludeBookedWithinDays || 0);
  if (excludeDays > 0) {
    const recent = await BookingModel.exists({
      user: user._id,
      createdAt: { $gte: daysAgo(excludeDays, now) },
    });
    if (recent) return { eligible: false, reason: "booked_recently" };
  }

  const frequency = campaign.frequency || {};

  /*
   * The global marketing frequency cap: how recently this person heard from
   * marketing at ALL, across every campaign. Without this, three campaigns each
   * obeying their own cooldown still add up to three texts in a week.
   */
  const minGap = Number(frequency.minDaysBetweenAnyMarketing || 30);
  const lastAnyMarketing = await MessageModel.findOne({
    user: user._id,
    channelClass: "marketing",
    status: { $in: ["sent", "delivered", "simulated"] },
  })
    .sort({ createdAt: -1 })
    .select("createdAt")
    .lean();
  if (lastAnyMarketing && new Date(lastAnyMarketing.createdAt) > daysAgo(minGap, now)) {
    return { eligible: false, reason: "global_frequency_cap" };
  }

  // This campaign specifically: how many times, and how recently.
  const priorSends = await MessageModel.find({
    user: user._id,
    campaignId: campaign.campaignId,
    status: { $in: ["sent", "delivered", "simulated", "pending", "sending", "retry_scheduled"] },
  })
    .sort({ createdAt: -1 })
    .select("createdAt campaignCycle")
    .lean();

  const maxSends = Number(frequency.maxSendsPerPerson || 2);
  if (priorSends.length >= maxSends) {
    return { eligible: false, reason: "campaign_max_sends_reached" };
  }
  const cooldown = Number(frequency.cooldownDays || 180);
  if (priorSends.length && new Date(priorSends[0].createdAt) > daysAgo(cooldown, now)) {
    return { eligible: false, reason: "campaign_cooldown" };
  }

  const cycle = priorSends.reduce(
    (max, row) => Math.max(max, Number(row.campaignCycle || 0) + 1),
    0
  );
  return { eligible: true, reason: "eligible", cycle };
}

/**
 * Run one campaign.
 *
 * The daily ceiling is counted from the audit collection rather than from a
 * counter on the campaign, so it survives a restart and cannot drift. Counting
 * what actually happened is always safer than remembering what we intended.
 */
async function runCampaign(
  campaign,
  {
    now = new Date(),
    MessageModel = SmsMessage,
    UserModel = User,
    SubscriptionModel = Subscription,
    BookingModel = Booking,
    send = sendMarketingSms,
  } = {}
) {
  const stats = {
    campaignId: campaign.campaignId,
    considered: 0,
    skipped: 0,
    claimed: 0,
    sent: 0,
    simulated: 0,
    failed: 0,
    reason: "",
  };

  const runnable = campaignRunnable(campaign, now);
  if (!runnable.runnable) {
    stats.reason = runnable.reason;
    return stats;
  }

  const startOfDay = new Date(new Date(now).getTime() - DAY_MS);
  const sentToday = await MessageModel.countDocuments({
    campaignId: campaign.campaignId,
    createdAt: { $gte: startOfDay },
    status: { $nin: ["suppressed"] },
  });
  const dailyRemaining = Math.max(0, Number(campaign.limits?.maxPerDay || 0) - sentToday);
  if (dailyRemaining <= 0) {
    stats.reason = "daily_limit_reached";
    return stats;
  }

  const perRun = Math.min(Number(campaign.limits?.maxPerRun || 0), dailyRemaining);
  if (perRun <= 0) {
    stats.reason = "run_limit_zero";
    return stats;
  }

  /*
   * Only accounts that have already opted in are even considered. That is what
   * keeps the candidate set small and the sweep cheap, and it means the query
   * itself encodes the consent rule rather than relying on a later filter.
   */
  const candidates = await UserModel.find({
    role: "customer",
    isActive: true,
    excludeFromMarketing: { $ne: true },
    phone: { $nin: [null, ""] },
    "smsPreferences.marketingEnabled": true,
  })
    .select("_id userId name phone createdAt smsPreferences excludeFromMarketing")
    .limit(perRun * 10)
    .lean();

  const notificationType = CAMPAIGN_TYPE[campaign.category] || "SEASONAL_MARKETING";

  for (const user of candidates) {
    if (stats.claimed >= perRun) break;
    stats.considered += 1;

    const verdict = await personEligibleForCampaign(user, campaign, {
      now,
      MessageModel,
      SubscriptionModel,
      BookingModel,
    });
    if (!verdict.eligible) {
      stats.skipped += 1;
      continue;
    }

    const result = await send({
      notificationType,
      dedupeKey: dedupe.campaignKey(campaign.campaignId, user, verdict.cycle),
      user,
      phone: user.phone,
      campaignId: campaign.campaignId,
      campaignCycle: verdict.cycle,
      vars: { body: campaign.body, name: user.name },
      source: `smsCampaign:${campaign.campaignId}`,
      now,
      sendWindow: {
        startHour: campaign.sendWindow?.startHour ?? 11,
        endHour: campaign.sendWindow?.endHour ?? 18,
      },
      MessageModel,
    });

    stats.claimed += 1;
    if (result.status === "sent") stats.sent += 1;
    else if (result.status === "simulated") stats.simulated += 1;
    else if (result.status === "failed" || result.status === "error") stats.failed += 1;

    if (BATCH.delayBetweenSendsMs) {
      await new Promise((resolve) => setTimeout(resolve, BATCH.delayBetweenSendsMs));
    }
  }

  await SmsCampaign.updateOne(
    { _id: campaign._id },
    {
      $inc: {
        "stats.totalClaimed": stats.claimed,
        "stats.totalSent": stats.sent,
        "stats.totalFailed": stats.failed,
      },
      $set: { "stats.lastRunAt": now },
    }
  ).catch(() => {});

  return stats;
}

/**
 * One sweep across every enabled campaign.
 *
 * Refuses at the top when the marketing channel is off, which is its state on
 * deployment. The sweep is registered regardless so that turning marketing on
 * is a configuration change rather than a deploy.
 */
async function runSmsCampaignSweep({
  now = new Date(),
  CampaignModel = SmsCampaign,
  ...dependencies
} = {}) {
  if (!smsMarketingEnabled()) {
    return { ran: false, reason: "marketing_channel_disabled", campaigns: [] };
  }

  const campaigns = await CampaignModel.find({ enabled: true }).lean();
  const results = [];
  for (const campaign of campaigns) {
    try {
      results.push(await runCampaign(campaign, { now, ...dependencies }));
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "sms_campaign_failed",
          campaignId: campaign.campaignId,
          error: String(error?.message || "").slice(0, 200),
        })
      );
      results.push({ campaignId: campaign.campaignId, reason: "error", failed: 1 });
    }
  }
  return { ran: true, campaigns: results };
}

module.exports = {
  CAMPAIGN_TYPE,
  campaignRunnable,
  membershipStateOf,
  personEligibleForCampaign,
  runCampaign,
  runSmsCampaignSweep,
};
