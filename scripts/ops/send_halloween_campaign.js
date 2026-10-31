/*
 * Halloween 2026: one email and one SMS to each eligible customer WITHOUT a
 * live membership, pointing at the 20% first-payment offer (/halloween).
 *
 *   node scripts/ops/send_halloween_campaign.js                  dry run: counts only, nothing sent or written
 *   node scripts/ops/send_halloween_campaign.js --send --confirm [--channel email|sms] [--limit N]
 *
 * Everything that decides who may be contacted is the existing marketing
 * machinery, re-checked for each person immediately before their send:
 *  - live membership (active, trialing, past due, unpaid): never contacted;
 *  - EMAIL: isMarketableAccount (customer, active, not excluded, real address),
 *    no active EmailSuppression (unsubscribe, bounce, complaint), not Blacklisted;
 *    the footer carries the business address and a one-click unsubscribe;
 *  - SMS: sendMarketingSms -> checkEligibility, which requires recorded MARKETING
 *    consent (smsPreferences.marketingEnabled), no STOP on the number, the
 *    marketing channel switched on, and the marketing quiet hours
 *    (11:00-18:00 New York) - outside them nothing is sent.
 * Service/transactional consent is never read as marketing consent.
 *
 * Once only: an email is claimed in MarketingSend (unique per user, campaign
 * and cycle) before it is sent; an SMS is claimed by its SmsMessage dedupeKey.
 * A re-run - or a retry after a crash - skips everyone already claimed.
 */
const mongoose = require("mongoose");
const User = require("../../models/User");
const Subscription = require("../../models/Subscription");
const MarketingSend = require("../../models/MarketingSend");
const Blacklist = require("../../models/Blacklist");
const { isMarketableAccount, isUnsubscribed, resolveAudience } = require("../../utils/marketing/marketingEligibility");
const { renderMarketingEmail } = require("../../utils/marketing/marketingRenderer");
const { sendPromo } = require("../../utils/emailService");
const { sendMarketingSms } = require("../../utils/sms/smsService");
const { checkEligibility } = require("../../utils/sms/smsEligibility");
const { campaignKey } = require("../../utils/sms/smsDedupe");
const { LIVE_MEMBERSHIP_STATUSES, campaignInfo } = require("../../utils/welcomeOffer");

const CAMPAIGN = "halloween-2026";
const EMAIL_CAMPAIGN_ID = `${CAMPAIGN}-email`;
const LINK_SMS = "https://www.profixter.com/halloween?c=sms";

const SMS_BODY =
  "Happy Halloween from Profixter! 🎃 We've got a treat for you: 20% OFF your first payment on ANY Profixter membership plan! " +
  `Ready to make home repairs easier? Claim your Halloween offer: ${LINK_SMS}`;
// The template appends "Reply STOP to opt out."; the body itself must fit its 240-character cap untouched.
if (SMS_BODY.length > 240) throw new Error(`SMS body is ${SMS_BODY.length} characters; the cap is 240`);

const EMAIL_TEMPLATE = {
  id: EMAIL_CAMPAIGN_ID,
  subject: "🎃 Happy Halloween! Here's 20% OFF from Profixter!",
  preheader: "A special Halloween treat for your home.",
  headline: "Happy Halloween! 🎃",
  paragraphs: [
    "We've got a little treat for you!",
    "Enjoy 20% OFF your first payment on any Profixter membership plan.",
    "Whether you're joining for the first time or coming back, we'd love to help you take care of your home.",
  ],
  ctaLabel: "CLAIM MY 20% OFF",
  ctaRoute: "halloweenEmail",
  closing:
    "Your home. Your handyman. One membership. Happy Halloween! - The Profixter Team. " +
    "The offer is 20% off the first payment of a new monthly or annual membership; renewals are at the regular price. " +
    "Once per customer and home. Available through November 2, 2026.",
};

/*
 * Marketing texts need the customer's OWN prior express written consent
 * (TCPA). Consent a customer gave themselves - the sign-up form, the phone-code
 * sign-up, account settings, the website, texting START - qualifies. Consent
 * recorded on their behalf by staff ("admin_phone" after a call, and the
 * legacy migration of those) is not written consent by the customer, so this
 * campaign does not text those numbers. The owner can decide otherwise.
 */
const SELF_GIVEN_SMS_CONSENT = new Set(["signup_web_form", "signup_phone_code", "account_settings", "website", "sms_keyword"]);
const smsConsentSelfGiven = (user) => SELF_GIVEN_SMS_CONSENT.has(String(user?.smsPreferences?.marketingConsentSource || ""));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hasLiveMembership(userId) {
  return Boolean(await Subscription.exists({ user: userId, status: { $in: LIVE_MEMBERSHIP_STATUSES } }));
}

async function emailBlocker(user, blacklist) {
  if (!isMarketableAccount(user)) return "not_marketable";
  const email = String(user.email || "").trim().toLowerCase();
  if (blacklist.users.has(String(user._id)) || blacklist.emails.has(email)) return "blacklisted";
  if (await isUnsubscribed(email)) return "suppressed";
  return "";
}

async function loadBlacklist() {
  const rows = await Blacklist.find().select("user email").lean();
  return { users: new Set(rows.map((r) => String(r.user || ""))), emails: new Set(rows.map((r) => String(r.email || "").toLowerCase())) };
}

/**
 * @param {object} opts
 * @param {boolean} opts.send     false = count only
 * @param {string[]} opts.channels ["email","sms"]
 * @param {number} opts.limit     most messages to send in this run
 * @param {object} [opts.senders] { sendPromo, sendMarketingSms } (tests)
 * @param {number} [opts.pauseMs]
 */
async function runHalloweenCampaign({ send = false, channels = ["email", "sms"], limit = Infinity, senders = {}, pauseMs = 300, clock = () => new Date() } = {}) {
  const SEND = send;
  const CHANNELS = channels;
  const LIMIT = limit;
  const sendEmail = senders.sendPromo || sendPromo;
  const sendSms = senders.sendMarketingSms || sendMarketingSms;
  const now = clock();
  const campaign = campaignInfo(CAMPAIGN, now);
  if (!campaign?.active) throw new Error("The Halloween campaign is not running; nothing to send.");
  const blacklist = await loadBlacklist();
  const customers = await User.find({ role: "customer" }).lean();
  const tally = {
    mode: SEND ? "SEND" : "DRY RUN",
    customers: customers.length,
    withoutLiveMembership: 0,
    audience: {},
    email: { eligible: 0, skipped: {}, accepted: 0, failed: 0, duplicate: 0 },
    sms: { eligible: 0, skipped: {}, accepted: 0, failed: 0, duplicate: 0 },
  };
  const bump = (obj, key) => (obj[key] = (obj[key] || 0) + 1);
  let sent = 0;

  for (const listed of customers) {
    if (await hasLiveMembership(listed._id)) continue;
    const audienceInfo = await resolveAudience(listed, now);
    if (audienceInfo.audience === "member") continue; // access via a record the status list did not cover
    tally.withoutLiveMembership++;
    bump(tally.audience, audienceInfo.audience);

    /* ------------------------------- email ------------------------------- */
    if (CHANNELS.includes("email")) {
      const reason = await emailBlocker(listed, blacklist);
      if (reason) bump(tally.email.skipped, reason);
      else {
        tally.email.eligible++;
        if (SEND && sent < LIMIT) {
          // Immediately before sending: re-read the person and re-check everything.
          const user = await User.findById(listed._id).lean();
          const late = !user ? "gone" : (await hasLiveMembership(user._id)) ? "became_member" : await emailBlocker(user, blacklist);
          if (late) bump(tally.email.skipped, `at_send_${late}`);
          else {
            let claim = null;
            try {
              claim = await MarketingSend.create({
                user: user._id,
                userId: user.userId || "",
                email: String(user.email).toLowerCase(),
                campaignId: EMAIL_CAMPAIGN_ID,
                cycle: 0,
                audience: audienceInfo.audience,
                category: "seasonal",
                kind: "oneoff",
                topic: CAMPAIGN,
                status: "claimed",
                subject: EMAIL_TEMPLATE.subject,
              });
            } catch (error) {
              if (error?.code !== 11000) throw error;
              // Already claimed. Only a FAILED attempt may be taken again (atomically, at most three tries); a sent one never.
              claim = await MarketingSend.findOneAndUpdate(
                { user: user._id, campaignId: EMAIL_CAMPAIGN_ID, cycle: 0, status: "failed", attempts: { $lt: 3 } },
                { $set: { status: "claimed", claimedAt: new Date() } },
                { new: true }
              );
              if (!claim) tally.email.duplicate++;
            }
            if (claim) {
              try {
                const rendered = renderMarketingEmail(EMAIL_TEMPLATE, { name: user.firstName || "there", email: user.email, audience: audienceInfo.audience });
                const info = await sendEmail(user.email, {
                  subject: rendered.subject,
                  html: rendered.html,
                  text: rendered.text,
                  headers: { "List-Unsubscribe": `<${rendered.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
                  logContext: { campaignId: EMAIL_CAMPAIGN_ID, emailType: "marketing", userId: String(user._id) },
                });
                await MarketingSend.updateOne({ _id: claim._id }, { $set: { status: "sent", sentAt: new Date(), providerMessageId: String(info?.messageId || "") }, $inc: { attempts: 1 } });
                tally.email.accepted++;
                sent++;
              } catch (error) {
                await MarketingSend.updateOne({ _id: claim._id }, { $set: { status: "failed", failedAt: new Date(), failureReason: String(error?.message || error).slice(0, 300) }, $inc: { attempts: 1 } });
                tally.email.failed++;
              }
              await sleep(pauseMs);
            }
          }
        }
      }
    }

    /* -------------------------------- sms -------------------------------- */
    if (CHANNELS.includes("sms")) {
      const pre = !smsConsentSelfGiven(listed)
        ? { eligible: false, reason: listed.smsPreferences?.marketingEnabled ? "consent_recorded_by_staff" : "marketing_not_opted_in" }
        : await checkEligibility({ notificationType: "SEASONAL_MARKETING", user: listed, phone: listed.phone, now: clock() });
      if (!pre.eligible) bump(tally.sms.skipped, pre.reason || "ineligible");
      else {
        tally.sms.eligible++;
        if (SEND && sent < LIMIT) {
          const user = await User.findById(listed._id);
          if (!user || (await hasLiveMembership(user._id))) bump(tally.sms.skipped, "at_send_became_member");
          else if (!smsConsentSelfGiven(user)) bump(tally.sms.skipped, "at_send_consent_changed");
          else {
            // sendMarketingSms claims the dedupeKey first, then re-checks consent, STOP and quiet hours itself.
            const result = await sendSms({
              notificationType: "SEASONAL_MARKETING",
              dedupeKey: campaignKey(CAMPAIGN, user, 0),
              user,
              vars: { body: SMS_BODY },
              campaignId: CAMPAIGN,
              campaignCycle: 0,
              source: "oneoff_campaign",
              now: clock(),
            });
            const status = String(result?.status || "");
            if (status === "duplicate") tally.sms.duplicate++;
            else if (["sent", "queued", "accepted", "delivered", "simulated"].includes(status) || result?.ok) { tally.sms.accepted++; sent++; }
            else if (status === "skipped" || status === "blocked" || status === "suppressed") bump(tally.sms.skipped, `at_send_${result?.reason || status}`);
            else { tally.sms.failed++; bump(tally.sms.skipped, `failed_${result?.reason || status || "unknown"}`); }
            await sleep(pauseMs);
          }
        }
      }
    }
  }

  return tally;
}

module.exports = { runHalloweenCampaign, SMS_BODY, EMAIL_TEMPLATE, CAMPAIGN, EMAIL_CAMPAIGN_ID };

if (require.main === module) {
  const args = process.argv.slice(2);
  const channelArg = (args[args.indexOf("--channel") + 1] || "both").toLowerCase();
  (async () => {
    await mongoose.connect(process.env.MONGO_URI);
    const tally = await runHalloweenCampaign({
      send: args.includes("--send") && args.includes("--confirm"),
      channels: args.includes("--channel") ? [channelArg] : ["email", "sms"],
      limit: args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : Infinity,
    });
    console.log(JSON.stringify(tally, null, 2));
    await mongoose.disconnect();
  })().catch(async (error) => {
    console.error("CAMPAIGN ERROR", error?.message || error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
