const Subscription = require("../models/Subscription");
const User = require("../models/User");
const mail = require("./emailService");
const { sendTransactionalSms } = require("./sms/smsService");
const {
  retrieveStripeSubscription,
  subscriptionGrantsAccess,
  normalizeStripeStatus,
} = require("./subscriptionManagement");

/**
 * "Your membership is working again" - one email and one text, once.
 *
 * For a member a fault locked out of a membership they had paid for, sent
 * after the repair has been verified. It is never triggered by a webhook, a
 * sync or a deploy: an operator requests it for one subscription record
 * (scripts/ops/request_membership_restored_notice.js) and the production
 * server sends it through its normal email and SMS systems.
 *
 * EXACTLY ONCE, by construction:
 *   - the request is claimed with a conditional update, so two server
 *     instances, two cron ticks or a restart mid-send cannot both send;
 *   - a claimed request is never retried automatically - a failure is
 *     recorded for a person to look at, because a resend is a decision;
 *   - the text also carries a dedupe key, so the SMS layer itself refuses a
 *     second copy.
 *
 * And only while it is TRUE: the membership must grant access in our records
 * and be active in Stripe at the moment of sending, or nothing is sent.
 */

const EMAIL_KEY = "membership_restored";

function firstName(name) {
  const first = String(name || "").trim().split(/\s+/)[0] || "";
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "there";
}

function renderEmail({ name }) {
  const paragraphs = [
    "We apologize for the inconvenience with your Profixter membership.",
    "We experienced a technical issue that temporarily affected your membership access.",
    "The issue has now been resolved, and your membership is fully active.",
    "You can now log in to your Profixter account and book your next handyman visit as usual.",
    "Your October 30 payment was successfully received, and no additional payment was required to restore your membership.",
    "Thank you for your patience and for choosing Profixter!",
  ];
  const p = (t) => `<p style="margin:0 0 16px;">${t}</p>`;
  const html = mail.frame(
    `${p(`Hi ${mail.escapeHtml(firstName(name))},`)}${paragraphs.map(p).join("")}
     ${mail.btn("https://www.profixter.com/book", "Book a visit")}
     <p style="margin:20px 0 0;">The Profixter Team<br/><a href="https://www.profixter.com">https://www.profixter.com</a></p>`,
    { preheader: "Your membership is fully active again." }
  );
  const text = [`Hi ${firstName(name)},`, ...paragraphs, "The Profixter Team\nhttps://www.profixter.com"].join("\n\n");
  return { subject: "Your Profixter Membership Is Active", html, text };
}

/** Is the membership genuinely working right now? Our record and Stripe must both say so. */
async function verifyRestored(subscription, { retrieve = retrieveStripeSubscription } = {}) {
  if (!subscription?.stripeSubscriptionId) return { ok: false, reason: "no_stripe_subscription" };
  const stripeSubscription = await retrieve(String(subscription.stripeSubscriptionId));
  const stripeStatus = normalizeStripeStatus(stripeSubscription?.status);
  if (!["active", "trialing"].includes(stripeStatus)) return { ok: false, reason: `stripe_${stripeStatus}` };
  if (!subscriptionGrantsAccess(subscription)) return { ok: false, reason: "record_does_not_grant_access" };
  return { ok: true };
}

async function sendDueRestorationNotices({ now = new Date(), deps = {} } = {}) {
  const SubscriptionModel = deps.Subscription || Subscription;
  const UserModel = deps.User || User;
  const sendEmail = deps.sendRaw || mail.sendRaw;
  const sendSms = deps.sendTransactionalSms || sendTransactionalSms;
  const stats = { claimed: 0, sent: 0, skipped: 0 };

  const due = await SubscriptionModel.find({
    "restorationNotice.requestedAt": { $ne: null },
    "restorationNotice.claimedAt": null,
  }).limit(10);

  for (const candidate of due) {
    const claim = await SubscriptionModel.updateOne(
      { _id: candidate._id, "restorationNotice.claimedAt": null },
      { $set: { "restorationNotice.claimedAt": now } }
    );
    if (!claim.modifiedCount) continue;
    stats.claimed++;

    const record = (fields) =>
      SubscriptionModel.updateOne(
        { _id: candidate._id },
        { $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`restorationNotice.${k}`, v])) }
      );

    const subscription = await SubscriptionModel.findById(candidate._id);
    const verified = await verifyRestored(subscription, { retrieve: deps.retrieve }).catch((error) => ({
      ok: false,
      reason: `verify_failed: ${error?.message || error}`,
    }));
    if (!verified.ok) {
      stats.skipped++;
      await record({ skippedReason: String(verified.reason).slice(0, 200) });
      continue;
    }

    const user = await UserModel.findById(subscription.user);
    if (!user) {
      stats.skipped++;
      await record({ skippedReason: "user_not_found" });
      continue;
    }

    if (user.email) {
      try {
        const { subject, html, text } = renderEmail({ name: user.name });
        await sendEmail({
          to: user.email,
          subject,
          html,
          text,
          bccAdmin: false,
          logContext: {
            templateKey: EMAIL_KEY,
            userId: user._id,
            customerName: user.name || "",
            customerEmail: user.email,
            recipientName: user.name || "",
            recipientEmail: user.email,
            emailType: "billing",
            source: "membershipRestoredNotice",
          },
        });
        await record({ emailSentAt: new Date() });
      } catch (error) {
        await record({ emailError: String(error?.message || error).slice(0, 300) });
      }
    } else {
      await record({ emailError: "no_email_on_account" });
    }

    if (user.phone) {
      try {
        const result = await sendSms({
          notificationType: "MEMBERSHIP_RESTORED",
          dedupeKey: `MEMBERSHIP_RESTORED:${subscription.stripeSubscriptionId}`,
          user,
          phone: user.phone,
          subscription,
          vars: { name: user.name },
          source: "membershipRestoredNotice",
        });
        await record({
          smsMessageId: result?.id ? String(result.id) : null,
          smsStatus: String(result?.status || "unknown"),
        });
      } catch (error) {
        await record({ smsError: String(error?.message || error).slice(0, 300) });
      }
    } else {
      await record({ smsError: "no_phone_on_account" });
    }
    stats.sent++;
  }
  return stats;
}

module.exports = { sendDueRestorationNotices, renderEmail, verifyRestored, EMAIL_KEY };
