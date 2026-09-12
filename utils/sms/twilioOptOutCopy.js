/**
 * The keyword replies Twilio sends on our behalf.
 *
 * DESCRIPTIVE, NOT AUTHORITATIVE - AND NOTHING HERE IS EVER SENT BY US.
 *
 * routes/smsWebhook answers every inbound keyword with empty TwiML, on purpose:
 * Twilio's Advanced Opt-Out is the enforcement point, and two systems replying
 * to one STOP would send the customer two messages. So these three bodies live
 * in the Twilio console, under the "Profixter users" Messaging Service, and
 * this file is the record of what must be typed there.
 *
 * The cost of a descriptive file is that it can drift from the console it
 * describes. Nothing in the repo can read the console, so the tests pin what is
 * checkable from here - segment count, the CTIA elements, the claims the opt-in
 * body must and must not make, and that our own keyword sets recognise every
 * keyword we ask Twilio to use. Drift then shows up as a failing test rather
 * than as a wrong sentence nobody notices for a year.
 *
 * WHY THE OPT-IN BODY IS WORDED SO CAREFULLY
 *
 * START, YES and UNSTOP are Twilio's reserved opt-in keywords and they really
 * do something: they clear the carrier-level block, after which our number can
 * reach that handset again. What they do NOT do is create ProFixter consent -
 * utils/sms/smsEligibility still requires transactionalEnabled or
 * marketingEnabled to be explicitly true, and routes/smsWebhook's applyOptIn
 * sets neither.
 *
 * Two opposite mistakes are available here and the body below avoids both.
 * Twilio's stock confirmation ("you have successfully been re-subscribed")
 * claims a consent we do not have. Denying it outright ("you are not signed up
 * for any texts") contradicts Twilio's own terminology for a keyword it treats
 * as an opt-in, and tells the customer something confusing about a thing that
 * did just work. The body states the carrier-level fact plainly and then points
 * at where the application-level choice is made, which is the honest
 * description of a two-layer system.
 */

/** Twilio's default opt-out set. routes/smsWebhook additionally tolerates OPTOUT / OPT OUT. */
const OPT_OUT_KEYWORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];

/** Twilio's reserved opt-in set. routes/smsWebhook additionally tolerates OPTIN / OPT IN. */
const OPT_IN_KEYWORDS = ["START", "YES", "UNSTOP"];

const HELP_KEYWORDS = ["HELP", "INFO"];

/**
 * Says the STOP switched the stored preferences off, which is true and is the
 * part a customer would otherwise be surprised by when they come back.
 */
const OPT_OUT_MESSAGE =
  "ProFixter: You are unsubscribed and will get no more texts from us. " +
  "Your service and offer text settings are now off. Reply START to unblock " +
  "this number, then switch texts back on at profixter.com/account. " +
  "Help: 631-599-1363";

/**
 * The carrier-level fact, then the application-level choice. See the note above
 * for why it is phrased this way rather than either of the two obvious ways.
 */
const OPT_IN_MESSAGE =
  "ProFixter: This number can receive texts from us again. To choose which " +
  "ProFixter texts you want, turn on service or offer texts in your account " +
  "at profixter.com/account. Msg&data rates may apply. Reply STOP to opt out, " +
  "HELP for help.";

const HELP_MESSAGE =
  "ProFixter by Premium Island Homes Inc - Long Island home services. " +
  "Msg frequency varies. Msg&data rates may apply. Help: 631-599-1363 or " +
  "getfixter@gmail.com. Reply STOP to opt out. " +
  "profixter.com/communication-consent";

/**
 * Whether a body is entirely GSM-7, and how many segments it costs.
 *
 * Worth pinning because a single smart quote or en dash pasted into the console
 * silently switches the body to UCS-2, which cuts the per-segment budget from
 * 153 characters to 67 and can turn a two-segment reply into four.
 */
const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅå" +
  "Δ_ΦΓΛΩΠΨΣΘΞÆæßÉ" +
  " !\"#¤%&'()*+,-./0123456789:;<=>?¡" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿" +
  "abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXTENDED = "^{}\\[~]|€";

function measure(body) {
  let units = 0;
  for (const char of String(body)) {
    if (GSM7.includes(char)) units += 1;
    else if (GSM7_EXTENDED.includes(char)) units += 2;
    else return { gsm7: false, units: String(body).length, segments: null };
  }
  const segments = units <= 160 ? 1 : Math.ceil(units / 153);
  return { gsm7: true, units, segments };
}

module.exports = {
  HELP_KEYWORDS,
  HELP_MESSAGE,
  OPT_IN_KEYWORDS,
  OPT_IN_MESSAGE,
  OPT_OUT_KEYWORDS,
  OPT_OUT_MESSAGE,
  measure,
};
