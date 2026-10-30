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
  /*
   * Registration 2.0. Sign-up asks for no text consent at all: the one-time
   * verification code is requested by the person and sent through Twilio
   * Verify, outside the A2P campaign. Service texts are offered later, as an
   * optional unticked box at the booking step, and in account settings.
   */
  "sms_service.booking.v1": {
    channel: "sms",
    purpose: "service",
    text: 'Checkbox "Text me about my visits" (optional, unticked) at the booking step, linking to profixter.com/communication-consent#service-texts: booking confirmations, appointment reminders and arrival updates. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help.',
  },
  "terms.continue.v1": {
    channel: "terms",
    purpose: "terms",
    text: 'Line under the sign-in button: "By continuing, you agree to the Terms and Privacy Policy and to receive a one-time verification text. Msg & data rates may apply." with links to profixter.com/terms, /privacy and /communication-consent. No checkbox; continuing is the acceptance. No marketing consent of any kind.',
  },
  "email_marketing.settings.v1": {
    channel: "email",
    purpose: "marketing",
    text: '"Email me ProFixter tips and offers." Optional. Seasonal home tips, news and offers, at most once a week. Every email has a one-click unsubscribe. Turning this off never stops your booking confirmations, reminders or receipts.',
  },
  /*
   * Given by phone, recorded by staff. Used when Admin creates an account for
   * a caller or switches a channel on for them (utils/admin/communicationControls.js).
   * The record names the staff member who took it; the customer can turn any
   * of it off in their account, and STOP / unsubscribe always win.
   */
  "sms_service.admin_phone.v1": {
    channel: "sms",
    purpose: "service",
    text: "Agreed by phone with ProFixter staff, who recorded it in Admin: text messages about this customer's account and visits - account access, booking confirmations, reminders, arrival and service updates, billing notices. Message frequency varies. Message and data rates may apply. Reply STOP to opt out, HELP for help.",
  },
  "sms_marketing.admin_phone.v1": {
    channel: "sms",
    purpose: "marketing",
    text: "Agreed by phone with ProFixter staff, who recorded it in Admin: occasional ProFixter offers and promotions by text. Optional and not required to buy anything. Message frequency varies. Message and data rates may apply. Reply STOP to opt out, HELP for help.",
  },
  "email_marketing.admin_phone.v1": {
    channel: "email",
    purpose: "marketing",
    text: "Agreed by phone with ProFixter staff, who recorded it in Admin: ProFixter home tips, news and offers by email, at most once a week. Every email has a one-click unsubscribe.",
  },
};

/* What each surface shows today. */
const CURRENT = {
  signup: { service: "sms_service.signup.v1", marketing: "sms_marketing.signup.v1" },
  sms_settings: { service: "sms_service.settings.v1", marketing: "sms_marketing.settings.v1" },
  email_settings: { marketing: "email_marketing.settings.v1" },
  booking: { service: "sms_service.booking.v1" },
  continue_terms: "terms.continue.v1",
  admin_phone: {
    service: "sms_service.admin_phone.v1",
    marketing: "sms_marketing.admin_phone.v1",
    emailMarketing: "email_marketing.admin_phone.v1",
  },
};

function wording(version) {
  const v = VERSIONS[version];
  if (!v) throw new Error(`Unknown consent version: ${version}`);
  return { consentVersion: version, consentText: v.text };
}

module.exports = { CURRENT, VERSIONS, wording };
