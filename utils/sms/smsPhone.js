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
 * A Mongo filter matching every User account that holds this number.
 *
 * WHY AN EXACT MATCH ON `phone` IS NOT ENOUGH.
 *
 * Registration normalises to E.164, so accounts made through the website store
 * "+16315991363". But a Google sign-up may carry no phone at all and gain one
 * later, legacy rows predate the normalisation, and admin edits were unchecked
 * until recently - so the same handset can legitimately be stored as
 * "+16315991363", "16315991363", "6315991363" or "(631) 599-1363" across
 * different accounts.
 *
 * That matters because several accounts may share one handset, and a STOP has
 * to reach ALL of them. Matching only the E.164 spelling silently misses the
 * others.
 *
 * `search.phone` is the reliable join: User already maintains it as the bare
 * 10-digit national form, it is indexed, and the pre-validate hook keeps it in
 * step with whatever `phone` holds. The literal spellings are kept in the
 * filter as a fallback for any document written before that field existed.
 *
 * NOTE ON SCOPE: this finds accounts to MIRROR state onto, for display. It is
 * never how a send decision is made - those read SmsOptOut and SmsPhoneStatus,
 * which are keyed by the normalised number and cannot miss.
 */
function userPhoneQuery(phone) {
  const e164 = toE164(phone);
  if (!e164) return null;
  const national = e164.slice(2); // strip the leading "+1"
  return {
    $or: [
      { "search.phone": national },
      { phone: { $in: [e164, `1${national}`, national] } },
    ],
  };
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
  userPhoneQuery,
};
