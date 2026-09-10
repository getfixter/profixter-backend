/**
 * Occasions: the words on a gift, and nothing else.
 *
 * WHAT AN OCCASION IS ALLOWED TO CHANGE
 *
 * The headline and one supporting line. That is the entire contract.
 *
 * It must never touch the plan, the duration, the price, the entitlement or
 * anything Stripe sees, because the moment presentation can move any of those
 * we have six products instead of one product with six greetings — and six
 * things to keep correct every time the real one changes. A test asserts the
 * quote for a gift is identical across every occasion.
 *
 * Kept on the server so the wording is the same in the purchase preview, the
 * recipient's page and the email, rather than three copies drifting apart.
 */

const OCCASIONS = {
  neutral: {
    key: "neutral",
    label: "A gift for you",
    /** The large line on the card. */
    title: "A Gift for You",
    /** One quiet line beneath it. Never repeats the title. */
    kicker: "Someone was thinking of you",
  },
  new_home: {
    key: "new_home",
    label: "New home",
    title: "A Gift for Your New Home",
    kicker: "Welcome home",
  },
  congratulations: {
    key: "congratulations",
    label: "Congratulations",
    title: "Congratulations",
    kicker: "Something to make the next part easier",
  },
  birthday: {
    key: "birthday",
    label: "Birthday",
    title: "Happy Birthday",
    kicker: "Something useful, just for you",
  },
  thank_you: {
    key: "thank_you",
    label: "Thank you",
    title: "Thank You",
    kicker: "A little something to make life easier",
  },
  just_because: {
    key: "just_because",
    label: "Just because",
    title: "Just Because",
    kicker: "No occasion needed",
  },
};

const OCCASION_KEYS = Object.keys(OCCASIONS);
const DEFAULT_OCCASION = "neutral";

/** Anything unrecognised becomes the neutral greeting rather than an error. */
function normalizeOccasion(value) {
  const key = String(value || "").trim().toLowerCase();
  return OCCASION_KEYS.includes(key) ? key : DEFAULT_OCCASION;
}

function occasionCopy(value) {
  return OCCASIONS[normalizeOccasion(value)];
}

/**
 * How long a personal message may be.
 *
 * Short enough to stay a message rather than a letter, and to keep the card
 * legible on a phone at a readable size. Stripe metadata values cap at 500
 * characters, so this also sits comfortably inside what we can carry through
 * checkout.
 */
const MESSAGE_MAX_LENGTH = 200;

/**
 * Clean a purchaser-written message.
 *
 * Treated as hostile input throughout. React escapes on render, but the
 * recipient EMAIL is assembled HTML, so angle brackets are removed here rather
 * than relied upon to be escaped correctly by every future template. Control
 * characters go too: they survive a database round trip and can break both a
 * layout and a log line.
 *
 * Newlines are deliberately kept — a two-line message reads like a note, and a
 * gift should be allowed to look handwritten. Runs of them are collapsed so
 * nobody can push the CTA off the card with fifty blank lines.
 */
function sanitizePersonalMessage(value) {
  if (value === null || value === undefined) return "";

  let text = String(value);

  // Angle brackets first: no tag can survive, whatever the later template does.
  text = text.replace(/[<>]/g, "");

  // Every control character except newline and tab.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

  text = text.replace(/\t/g, " ");
  text = text.replace(/\r\n?/g, "\n");
  text = text.replace(/[\u0020\u00A0]{2,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim().slice(0, MESSAGE_MAX_LENGTH);
}

/** A display name, cleaned the same way but always one line. */
function sanitizeDisplayName(value, max = 80) {
  if (value === null || value === undefined) return "";
  let text = String(value).replace(/[<>]/g, "");
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001F\u007F]/g, " ");
  return text.replace(/\s{2,}/g, " ").trim().slice(0, max);
}

module.exports = {
  DEFAULT_OCCASION,
  MESSAGE_MAX_LENGTH,
  OCCASIONS,
  OCCASION_KEYS,
  normalizeOccasion,
  occasionCopy,
  sanitizeDisplayName,
  sanitizePersonalMessage,
};
