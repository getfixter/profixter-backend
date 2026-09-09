/**
 * Gift membership configuration.
 *
 * Off by default and fails closed, on the same reasoning as SMS_ENABLED:
 * GIFTS_ENABLED must spell "true" to expose anything to a customer. Unset,
 * empty, "1" and any typo all mean off, so no plausible misconfiguration is
 * what makes a half-finished feature customer-visible.
 */

function readFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  return String(raw).trim().toLowerCase() === "true";
}

function readNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

/** Whether the feature is exposed at all. A function, so tests can flip it. */
function giftsEnabled() {
  return readFlag("GIFTS_ENABLED", false);
}

/**
 * Durations the architecture understands, and the subset a customer may pick.
 *
 * Two lists rather than one because they answer different questions. The first
 * is what the term arithmetic, pricing and storage support; the second is what
 * the purchase screen offers today. Launch exposes two months only, and
 * enabling six is then a config change rather than a code change.
 */
const SUPPORTED_DURATIONS = [1, 2, 3, 6, 12];

function offeredDurations() {
  const raw = String(process.env.GIFT_DURATIONS || "").trim();
  if (!raw) return [2];
  const chosen = raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => SUPPORTED_DURATIONS.includes(value));
  return chosen.length ? chosen : [2];
}

function isOfferedDuration(months) {
  return offeredDurations().includes(Number(months));
}

function isSupportedDuration(months) {
  return SUPPORTED_DURATIONS.includes(Number(months));
}

/**
 * How long a claim LINK stays usable.
 *
 * This is a credential lifetime and nothing else. It does not decide what
 * happens to the money: an expired link leaves the gift entirely intact, and
 * Admin can issue a fresh one. Keeping the two apart is deliberate — a link
 * going stale in an inbox is a security matter, and forfeiting a paid gift is
 * a business decision nobody has made.
 */
const CLAIM_TOKEN_TTL_DAYS = readNumber("GIFT_CLAIM_TOKEN_TTL_DAYS", 90);

/** When to nudge an unclaimed gift, in days since the invitation. */
const CLAIM_REMINDER_DAYS = [7, 30];

/** How long before a running gift ends to offer Continue Membership. */
const ENDING_SOON_DAYS = readNumber("GIFT_ENDING_SOON_DAYS", 14);

/**
 * Whether somebody may gift themselves.
 *
 * OFF FOR LAUNCH. A self-gift is really a prepaid membership bought at a
 * discount, and gift checkout accepts promotion codes — so allowing it turns
 * every gift coupon into a way to discount your own membership, which is not
 * what any of those codes were created for. Enable deliberately, if ever.
 */
function selfGiftingAllowed() {
  return readFlag("GIFT_ALLOW_SELF_GIFT", false);
}

const TIMEZONE = "America/New_York";

/** A snapshot for logs, health checks and the admin screen. */
function configSnapshot() {
  return {
    giftsEnabled: giftsEnabled(),
    selfGiftingAllowed: selfGiftingAllowed(),
    offeredDurations: offeredDurations(),
    supportedDurations: SUPPORTED_DURATIONS,
    claimTokenTtlDays: CLAIM_TOKEN_TTL_DAYS,
    endingSoonDays: ENDING_SOON_DAYS,
    timezone: TIMEZONE,
  };
}

module.exports = {
  CLAIM_REMINDER_DAYS,
  CLAIM_TOKEN_TTL_DAYS,
  ENDING_SOON_DAYS,
  SUPPORTED_DURATIONS,
  TIMEZONE,
  configSnapshot,
  giftsEnabled,
  isOfferedDuration,
  isSupportedDuration,
  offeredDurations,
  selfGiftingAllowed,
};
