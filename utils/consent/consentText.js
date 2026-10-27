/**
 * The exact wording a customer agreed to, by surface, with a version.
 *
 * A consent record is only as good as its answer to "agreed to WHAT". Each
 * entry is the text on that screen at the time, word for word, plus the
 * disclosure it links to. When the wording on a screen changes, add a NEW
 * version here and point CURRENT at it - never edit an old one, because rows in
 * ConsentEvent name the version they were given under.
 *
 * Screens: app/(auth)/signup/page.tsx (the two SMS boxes),
 * app/components/account/SmsPreferences.tsx and EmailPreferences.tsx (the
 * account settings), and app/communication-consent/page.tsx (the disclosure).
 */
const VERSIONS = {
  "sms_service.signup.v1": {
    channel: "sms",
    purpose: "service",
    text: 'Checkbox "Service text messages" (required to create an account), linking to profixter.com/communication-consent#service-texts: appointment scheduling, confirmations, rescheduling and arrival updates; service status updates, follow-ups and support; account security alerts; billing notices and receipts; requests for photos or information to prepare for a visit. Reply STOP to opt out, HELP for help.',
  },
  "sms_marketing.signup.v1": {
    channel: "sms",
    purpose: "marketing",
    text: 'Checkbox "Offers & promotions" (optional, unticked), linking to profixter.com/communication-consent#marketing: "Marketing (Only If You Opt In)" - promotions, seasonal offers, referral rewards and special announcements by text. Marketing consent is optional and is not required to purchase services. Reply STOP to opt out, HELP for help.',
  },
  "sms_service.settings.v1": {
    channel: "sms",
    purpose: "service",
    text: '"Text me about my ProFixter visits." Optional. Booking confirmations, appointment reminders and service updates. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help.',
  },
  "sms_marketing.settings.v1": {
    channel: "sms",
    purpose: "marketing",
    text: '"Text me occasional ProFixter offers." Optional, and separate from the service texts above. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help.',
  },
  "email_marketing.settings.v1": {
    channel: "email",
    purpose: "marketing",
    text: '"Email me ProFixter tips and offers." Optional. Seasonal home tips, news and offers, at most once a week. Every email has a one-click unsubscribe. Turning this off never stops your booking confirmations, reminders or receipts.',
  },
};

/* What each surface shows today. */
const CURRENT = {
  signup: { service: "sms_service.signup.v1", marketing: "sms_marketing.signup.v1" },
  sms_settings: { service: "sms_service.settings.v1", marketing: "sms_marketing.settings.v1" },
  email_settings: { marketing: "email_marketing.settings.v1" },
};

function wording(version) {
  const v = VERSIONS[version];
  if (!v) throw new Error(`Unknown consent version: ${version}`);
  return { consentVersion: version, consentText: v.text };
}

module.exports = { CURRENT, VERSIONS, wording };
