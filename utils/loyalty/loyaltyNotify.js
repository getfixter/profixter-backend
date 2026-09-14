const LoyaltyGrant = require("../../models/LoyaltyGrant");
const VisitEntitlement = require("../../models/VisitEntitlement");
const mail = require("../emailService");
const smsNotify = require("../sms/smsNotifications");
const { planLabel } = require("./loyaltyProgress");

/**
 * Telling somebody they won something.
 *
 * TWO RULES GOVERN THIS WHOLE FILE.
 *
 * Nobody is congratulated for a benefit that does not exist. Every send happens
 * after the grant is written and only for a grant that succeeded, so a message
 * can never arrive ahead of the thing it announces.
 *
 * And a notification can never cost somebody their reward. Nothing here throws:
 * a failed send is logged, left unstamped, and picked up by the daily sweep. The
 * benefit is on the account either way.
 *
 * THE CHANNELS ARE INDEPENDENT. Each is claimed with a conditional update before
 * its own send and released if that send fails, so email succeeding and SMS
 * failing leaves exactly one of them to retry. A single shared stamp would have
 * meant retrying the text re-sent the email, which is the failure the two fields
 * exist to prevent.
 */

/** Which email template a grant earns. Derived, never passed in. */
const EMAIL_TEMPLATE = {
  "tier_upgrade:3": "loyalty_upgrade_month_3",
  "tier_upgrade:6": "loyalty_upgrade_month_6",
  "loyalty_full_day:3": "loyalty_full_day_month_3",
  "loyalty_full_day:6": "loyalty_full_day_month_6",
  "free_month:12": "loyalty_free_month",
};

function templateFor(grant) {
  return EMAIL_TEMPLATE[`${grant?.rewardKind}:${grant?.milestone}`] || null;
}

function log(level, event, details = {}) {
  const payload = JSON.stringify({ level, event, scope: "loyalty_notify", ...details });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

function formatDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : mail.formatNYCTime(date.toISOString());
}

/**
 * Only one caller may claim a channel, and only once.
 *
 * The condition is the stamp still being null, so two instances racing produce
 * one winner and one no-op. Claiming BEFORE the send rather than after is what
 * makes the race safe; the cost is that a crash between claim and send loses one
 * message, which is the right way round for a congratulation.
 */
async function claim(grantId, field) {
  const claimed = await LoyaltyGrant.findOneAndUpdate(
    { _id: grantId, [field]: null },
    { $set: { [field]: new Date() } },
    { new: true }
  );
  return !!claimed;
}

async function release(grantId, field) {
  await LoyaltyGrant.updateOne({ _id: grantId }, { $set: { [field]: null } }).catch(() => {});
}

/**
 * Everything the message needs, read off the grant and what it produced.
 *
 * The Full Day's use-by date comes from the entitlement the grant created, and
 * the free month's date from the period it will apply to — neither is guessed,
 * so no message can name a date the account does not actually hold.
 */
async function buildVars({ grant, user, subscription }) {
  const base = {
    name: user.name || String(user.email || "").split("@")[0],
    currentPlan: planLabel(subscription?.subscriptionType),
    address: subscription?.addressSnapshot
      ? `${subscription.addressSnapshot.line1}, ${subscription.addressSnapshot.city}, ${subscription.addressSnapshot.state}`
      : null,
  };

  if (grant.rewardKind === "tier_upgrade") {
    return {
      ...base,
      rewardPlan: planLabel(grant.rewardPlan),
      throughDate: formatDate(grant.effectiveUntil),
    };
  }

  if (grant.rewardKind === "loyalty_full_day") {
    const entitlement = grant.visitEntitlementId
      ? await VisitEntitlement.findById(grant.visitEntitlementId).lean()
      : null;
    /*
     * Both forms, because the two channels want different ones. The email
     * reads "Sunday, October 4, 2026 at 9:00 AM EDT"; a text wants "Sun, Oct 4"
     * and formats the raw instant itself.
     */
    return {
      ...base,
      useByDate: formatDate(entitlement?.expiresAt),
      useByAt: entitlement?.expiresAt || null,
    };
  }

  // The free month lands on the renewal that closes the current period.
  const renewalAt = subscription?.currentPeriodEnd || subscription?.nextPaymentDate || null;
  return { ...base, renewalDate: formatDate(renewalAt), renewalAt };
}

async function sendEmail({ grant, user, vars, template }) {
  if (!(await claim(grant._id, "emailNotifiedAt"))) {
    return { sent: false, reason: "already_sent" };
  }
  try {
    await mail.sendTx(template, user.email, vars, {
      bccAdmin: false,
      logContext: {
        userId: user._id,
        customerName: user.name || "",
        customerEmail: user.email,
        recipientName: user.name || "",
        recipientEmail: user.email,
        emailType: "billing",
        source: "loyaltyBenefits",
      },
    });
    return { sent: true };
  } catch (error) {
    await release(grant._id, "emailNotifiedAt");
    log("warn", "loyalty_congratulation_email_failed", {
      loyaltyGrantId: String(grant._id),
      template,
      message: error?.message,
    });
    return { sent: false, reason: "error" };
  }
}

/**
 * The text.
 *
 * Two layers of protection rather than one: the stamp here, and the unique index
 * on SmsMessage.dedupeKey underneath. The stamp stops a second attempt being
 * started; the index stops a second message existing even if one somehow were.
 *
 * A refusal is not a failure. Somebody who has not opted in to service texts is
 * correctly not texted, and re-running the sweep every night to try again would
 * be pointless — so a clean refusal keeps the stamp and only an error releases
 * it.
 */
async function sendSms({ grant, user, vars }) {
  if (!user?.phone) return { sent: false, reason: "no_phone" };
  if (!(await claim(grant._id, "smsNotifiedAt"))) {
    return { sent: false, reason: "already_sent" };
  }

  const result = await smsNotify.notifyLoyaltyRewardUnlocked(grant, user, vars);
  if (result?.ok) return { sent: true };

  if (String(result?.status || "") === "error") {
    await release(grant._id, "smsNotifiedAt");
    log("warn", "loyalty_congratulation_sms_failed", {
      loyaltyGrantId: String(grant._id),
      reason: result?.reason || "unknown",
    });
    return { sent: false, reason: "error" };
  }

  return { sent: false, reason: result?.reason || "not_eligible" };
}

/**
 * Congratulate somebody, on both channels, once each.
 *
 * Never throws. Returns what happened so a caller can log it; nobody has to
 * check it.
 */
async function congratulate({ grant, user, subscription }) {
  try {
    if (!grant || !user?.email) return null;
    if (["failed"].includes(String(grant.status || ""))) return null;

    const template = templateFor(grant);
    if (!template) {
      log("warn", "loyalty_congratulation_unknown_reward", {
        loyaltyGrantId: String(grant._id),
        rewardKind: grant.rewardKind,
        milestone: grant.milestone,
      });
      return null;
    }

    const vars = await buildVars({ grant, user, subscription });
    const email = await sendEmail({ grant, user, vars, template });
    const sms = await sendSms({ grant, user, vars });

    log("info", "loyalty_congratulation", {
      loyaltyGrantId: String(grant._id),
      userId: String(user.userId || ""),
      template,
      emailSent: email.sent,
      emailReason: email.reason || null,
      smsSent: sms.sent,
      smsReason: sms.reason || null,
    });
    return { email, sms };
  } catch (error) {
    log("error", "loyalty_congratulation_failed", {
      loyaltyGrantId: String(grant?._id || ""),
      message: error?.message,
    });
    return null;
  }
}

module.exports = {
  EMAIL_TEMPLATE,
  buildVars,
  congratulate,
  templateFor,
};
