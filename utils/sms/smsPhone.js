const { normalizePhoneE164 } = require("../identity");

/**
 * Phone handling for SMS.
 *
 * Built on utils/identity rather than beside it. That module already encodes
 * the North American numbering plan rules the rest of the product validates
 * against, and a second, subtly different notion of "a valid phone number"
 * would eventually let a number pass one check and fail the other — which
 * shows up as a customer who is silently never texted.
 *
 * What is added here is the SMS-specific part identity has no opinion on:
 * whether a number is worth attempting a paid send to, and how to say so
 * without putting the number in a log.
 */

/**
 * The number we would dial, or null.
 *
 * Null for anything that is not a complete, plausible North American mobile or
 * landline: too short, too long, a bogus area code, an international number we
 * are not provisioned to text. Returning null rather than a best guess is
 * deliberate — a "corrected" wrong number is a message delivered to a stranger.
 */
function toE164(phone) {
  return normalizePhoneE164(phone);
}

function isValidSmsPhone(phone) {
  return Boolean(toE164(phone));
}

/**
 * A phone number safe to put in a log line.
 *
 * Country code and last two digits only: enough to correlate two log entries or
 * recognise a number you are actively debugging, not enough to be a contact
 * list if the logs are ever aggregated somewhere less careful than this system.
 */
function maskPhone(phone) {
  const e164 = toE164(phone);
  if (!e164) return "";
  return `${e164.slice(0, 2)}******${e164.slice(-2)}`;
}

/**
 * The best number to text for a booking, and where it came from.
 *
 * A Booking carries a phone snapshot taken when it was made; the User carries
 * the current one. The booking's is preferred because it is what the customer
 * gave for this specific visit, and the account fallback exists for older
 * bookings whose snapshot is empty or was never valid.
 *
 * Returning the source alongside the number is not decoration: when somebody
 * asks why a reminder went to an old number, the answer is in the log.
 */
function resolveBookingPhone(booking = {}, user = null) {
  const fromBooking = toE164(booking.phone);
  if (fromBooking) return { phone: fromBooking, source: "booking" };
  const fromUser = toE164(user?.phone);
  if (fromUser) return { phone: fromUser, source: "user" };
  return { phone: null, source: "none" };
}

/**
 * How many segments a body will be billed as.
 *
 * An estimate, not an authority — Twilio decides for real, and the exact answer
 * depends on encoding tables this does not model. It exists so a template that
 * has quietly grown into three segments is visible in the log and in tests,
 * because tripling the cost of every reminder is the kind of regression nobody
 * notices until the invoice.
 *
 * Any character outside the GSM-7 set forces the whole message to UCS-2, which
 * is why one stray smart quote or emoji cuts the limit from 160 to 70.
 */
const GSM7 = /^[A-Za-z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\n\r\f^{}\[~\]|€]*$/;

function estimateSegments(body) {
  const text = String(body || "");
  if (!text) return 0;
  const unicode = !GSM7.test(text);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  if (text.length <= single) return 1;
  return Math.ceil(text.length / multi);
}

function isUnicodeBody(body) {
  return !GSM7.test(String(body || ""));
}

module.exports = {
  estimateSegments,
  isUnicodeBody,
  isValidSmsPhone,
  maskPhone,
  resolveBookingPhone,
  toE164,
};
