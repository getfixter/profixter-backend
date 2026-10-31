const crypto = require("crypto");
const User = require("../../models/User");
const Blacklist = require("../../models/Blacklist");
const { recordConsent } = require("./ledger");
const { CURRENT } = require("./consentText");
const { adminAssistedOptInRegistered, marketingSmsBasis } = require("./marketingSmsBasis");
const { handsetStopped } = require("./status");
const { optOutFor } = require("../sms/smsEligibility");
const { toE164 } = require("../sms/smsPhone");
const { isMarketableAccount, isUnsubscribed } = require("../marketing/marketingEligibility");
const { renderMarketingEmail } = require("../marketing/marketingRenderer");
const { SITE_URL, routeUrl } = require("../marketing/marketingConfig");

/**
 * The Admin-assisted opt-in, finished by the customer in one click.
 *
 * A customer says yes to offers by text on a call. Admin records the call
 * (source "admin_phone") and, with one button, emails the customer a link.
 * The link opens profixter.com/texts/confirm, which shows the number and the
 * full disclosure; pressing "Yes, text me occasional ProFixter offers" is the
 * customer's own electronic, written consent (E-SIGN), recorded with the
 * wording, time, IP and browser. No password, no account steps.
 *
 * UNTIL TWILIO CONFIRMS THE UPDATED MESSAGE FLOW the registered campaign says
 * marketing consent is given only on the sign-up form and in account settings,
 * so the email sends the customer to account settings (sign in, then "Text me
 * occasional ProFixter offers") - the registered opt-in, textable at once.
 * With SMS_ADMIN_ASSISTED_OPTIN_REGISTERED=true it sends the one-click link.
 *
 * The email is sent only when Admin asks for it, never because a switch was
 * changed. It is a marketing-category email: it respects unsubscribes and the
 * blacklist and carries a one-click unsubscribe. Opening the link changes
 * nothing; only the button press does (link scanners open links).
 */

const LINK_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const RESEND_AFTER_MS = 20 * 60 * 60 * 1000;
const MASK = (phone) => (phone ? `•••-•••-${String(phone).slice(-4)}` : "");

class SmsConfirmError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function key() {
  const secret = process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error("EMAIL_UNSUBSCRIBE_SECRET or JWT_SECRET is required");
  return crypto.createHash("sha256").update(`sms-marketing-confirm:${secret}`).digest();
}

/* Signed, not secret: the user id, the phone it confirms, and an expiry. */
function createConfirmToken(userId, phone, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ u: String(userId), p: toE164(phone), e: now + LINK_LIFETIME_MS })).toString("base64url");
  const sig = crypto.createHmac("sha256", key()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readConfirmToken(token, now = Date.now()) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) throw new SmsConfirmError("INVALID_LINK", "This link isn't valid.", 400);
  const want = crypto.createHmac("sha256", key()).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new SmsConfirmError("INVALID_LINK", "This link isn't valid.", 400);
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch (_e) {
    throw new SmsConfirmError("INVALID_LINK", "This link isn't valid.", 400);
  }
  if (!payload?.u || !payload?.p) throw new SmsConfirmError("INVALID_LINK", "This link isn't valid.", 400);
  if (Number(payload.e) < now) throw new SmsConfirmError("LINK_EXPIRED", "This link has expired. Call us at 631-599-1363 and we'll send a new one.", 410);
  return payload;
}

const confirmUrl = (token) => `${SITE_URL}/texts/confirm?t=${encodeURIComponent(token)}`;

const EMAIL_TEMPLATE = {
  id: "sms-marketing-confirm",
  subject: "Confirm ProFixter offers by text",
  preheader: "One tap to confirm what you told us on the phone.",
  headline: ({ name }) => `Hi ${name}, one tap to confirm`,
  paragraphs: [
    "Thanks for talking with us. You told us you'd like occasional ProFixter offers by text message.",
    ({ phoneMasked, oneClick }) =>
      oneClick
        ? `To start them, please confirm with one tap. They'll go to your phone number ending in ${phoneMasked.slice(-4)}.`
        : `To start them, please confirm in your account: sign in and tap "Text me occasional ProFixter offers". They'll go to your phone number ending in ${phoneMasked.slice(-4)}.`,
    "Optional, and not required to buy anything. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help.",
    "If you didn't ask for this, ignore this email and nothing changes.",
  ],
  ctaLabel: ({ oneClick }) => (oneClick ? "Yes, text me offers" : "Confirm in my account"),
  ctaRoute: "accountTexts",
};

/* The customer has done their part (it may still wait for the carrier registration). */
const customerConfirmed = (user) =>
  marketingSmsBasis(user).status === "qualifies" || (user?.smsPreferences?.marketingEnabled === true && user.smsPreferences.marketingConsentSource === "sms_confirm_link");

async function blacklisted(user) {
  const email = String(user.email || "").trim().toLowerCase();
  return Boolean(await Blacklist.exists({ $or: [{ user: user._id }, ...(email ? [{ email }] : [])] }));
}

/** Why the confirmation email can't go to this customer right now, or "". */
async function confirmationBlocker(user, now = new Date()) {
  if (!user) return "NOT_FOUND";
  if (String(user.role || "customer") !== "customer" || user.employeePosition) return "NOT_A_CUSTOMER";
  const phone = toE164(user.phone);
  if (!phone) return "NO_PHONE";
  if (handsetStopped(await optOutFor(phone))) return "STOPPED";
  if (user.excludeFromMarketing === true) return "EXCLUDED";
  if (customerConfirmed(user)) return "ALREADY_CONFIRMED";
  if (!String(user.email || "").trim()) return "NO_EMAIL";
  if (!isMarketableAccount(user)) return "NOT_MARKETABLE";
  if (await isUnsubscribed(String(user.email).trim().toLowerCase())) return "EMAIL_UNSUBSCRIBED";
  if (await blacklisted(user)) return "BLACKLISTED";
  const last = user.smsPreferences?.marketingConfirmRequestedAt;
  if (last && now.getTime() - new Date(last).getTime() < RESEND_AFTER_MS) return "RECENTLY_SENT";
  return "";
}

const BLOCKER_MESSAGES = {
  NOT_FOUND: "Customer not found.",
  NOT_A_CUSTOMER: "Only customer accounts have these settings.",
  NO_PHONE: "This customer has no phone number.",
  STOPPED: "This phone texted STOP. Only the customer can restart texts, by texting START.",
  EXCLUDED: "This account is excluded from marketing.",
  ALREADY_CONFIRMED: "This customer has already confirmed offers by text themselves.",
  NO_EMAIL: "This customer has no email address to send the link to.",
  NOT_MARKETABLE: "This account can't receive marketing email.",
  EMAIL_UNSUBSCRIBED: "This customer unsubscribed from marketing email, so the link can't be emailed.",
  BLACKLISTED: "This customer is blacklisted.",
  RECENTLY_SENT: "A confirmation link was already emailed in the last 20 hours.",
};

/**
 * Email the customer the one-click confirmation link. Changes no preference.
 * `sendPromo` is injectable for tests.
 */
async function requestSmsConfirmation({ userId, admin = null, sendPromo = null, now = new Date() }) {
  const user = await User.findById(userId).lean();
  const blocker = await confirmationBlocker(user, now);
  if (blocker) throw new SmsConfirmError(blocker, BLOCKER_MESSAGES[blocker], blocker === "NOT_FOUND" ? 404 : 409);

  const phone = toE164(user.phone);
  const oneClick = adminAssistedOptInRegistered();
  const rendered = renderMarketingEmail(EMAIL_TEMPLATE, {
    name: user.firstName || String(user.name || "").split(" ")[0] || "there",
    email: user.email,
    vars: { ctaUrl: oneClick ? confirmUrl(createConfirmToken(user._id, phone, now.getTime())) : routeUrl("accountTexts"), phoneMasked: MASK(phone), oneClick },
  });
  const send = sendPromo || require("../emailService").sendPromo;
  const info = await send(user.email, {
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: { "List-Unsubscribe": `<${rendered.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    logContext: { campaignId: EMAIL_TEMPLATE.id, emailType: "marketing", userId: String(user._id) },
  });
  await User.updateOne({ _id: user._id }, { $set: { "smsPreferences.marketingConfirmRequestedAt": now } });
  console.log(JSON.stringify({ event: "sms_marketing_confirmation_emailed", userId: String(user._id), adminId: String(admin?._id || "") }));
  return { sentTo: user.email, messageId: String(info?.messageId || ""), requestedAt: now, oneClick };
}

/** What the confirmation page shows. Opening it changes nothing. */
async function describeConfirmation(token, now = new Date()) {
  const payload = readConfirmToken(token, now.getTime());
  const user = await User.findById(payload.u).select("firstName name phone smsPreferences excludeFromMarketing").lean();
  if (!user) throw new SmsConfirmError("INVALID_LINK", "This link isn't valid.", 400);
  if (toE164(user.phone) !== payload.p) throw new SmsConfirmError("PHONE_CHANGED", "The phone number on this account has changed since this link was sent. Call us at 631-599-1363 for a new one.", 410);
  return {
    firstName: user.firstName || String(user.name || "").split(" ")[0] || "",
    phoneLast4: payload.p.slice(-4),
    confirmed: customerConfirmed(user),
  };
}

/**
 * The customer pressed the button: record their own consent.
 * Never lifts a STOP (only texting START does) and never overrides an exclusion.
 */
async function confirmSmsMarketing({ token, req = null, now = new Date() }) {
  const payload = readConfirmToken(token, now.getTime());
  const user = await User.findById(payload.u).lean();
  if (!user) throw new SmsConfirmError("INVALID_LINK", "This link isn't valid.", 400);
  const phone = toE164(user.phone);
  if (phone !== payload.p) throw new SmsConfirmError("PHONE_CHANGED", "The phone number on this account has changed since this link was sent. Call us at 631-599-1363 for a new one.", 410);
  if (handsetStopped(await optOutFor(phone))) throw new SmsConfirmError("STOPPED", "This phone number texted STOP. To get texts again, text START to our number.");
  if (user.excludeFromMarketing === true) throw new SmsConfirmError("EXCLUDED", "This account can't receive offers by text. Call us at 631-599-1363.");
  if (customerConfirmed(user)) return { confirmed: true, already: true };

  const evidence = `Pressed "Yes, text me occasional ProFixter offers" at ${SITE_URL}/texts/confirm, from the link emailed to ${user.email || "the customer"}`;
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        "smsPreferences.marketingEnabled": true,
        "smsPreferences.marketingConsentAt": now,
        "smsPreferences.marketingConsentSource": "sms_confirm_link",
        "smsPreferences.marketingConsentMethod": "customer_confirmed_link",
        "smsPreferences.marketingConsentEvidence": evidence,
        "smsPreferences.marketingConsentRecordedBy": null,
      },
    }
  );
  await recordConsent({
    user,
    channel: "sms",
    purpose: "marketing",
    action: "granted",
    source: "sms_confirm_link",
    version: CURRENT.confirm_link.marketing,
    phone,
    req,
    method: "customer_confirmed_link",
    evidence,
    detail: user.smsPreferences?.marketingConsentSource === "admin_phone" ? "confirms the consent staff recorded after a call" : "",
    at: now,
  });
  console.log(JSON.stringify({ event: "sms_marketing_confirmed_by_link", userId: String(user._id) }));
  return { confirmed: true, already: false };
}

module.exports = {
  BLOCKER_MESSAGES,
  EMAIL_TEMPLATE,
  SmsConfirmError,
  confirmSmsMarketing,
  confirmationBlocker,
  createConfirmToken,
  describeConfirmation,
  readConfirmToken,
  requestSmsConfirmation,
};
