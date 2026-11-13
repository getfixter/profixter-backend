/**
 * Is this person blocked? The one answer every booking, request and checkout
 * entry point asks for.
 *
 * WHAT A BLOCK COVERS. The account id, the email (lowercased) and the phone in
 * any format (compared as ten US digits). A person who is blocked cannot get
 * round it by booking as a guest with the same email or number, or by writing
 * the number differently.
 *
 * WHAT IT DOES NOT COVER. An address. A household shares a house, and a house
 * changes hands; blocking one person must never block their neighbour, their
 * spouse with their own account, or the next owner.
 *
 * WHAT THE PERSON IS TOLD. A generic sentence and a phone number. Not that they
 * are blocked, and not why: the same words are used for every entry point, and
 * the response code says nothing either.
 *
 * Before this, the Admin "Block" button wrote a Blacklist entry that no booking
 * path ever read (the middleware looked for a user flag the schema did not
 * have), so a blocked customer could still book. See middleware/blacklist.js.
 */
const mongoose = require("mongoose");
const Blacklist = require("../models/Blacklist");
const User = require("../models/User");
const { blacklistPhoneDigits } = require("../models/Blacklist");

const BLOCKED_CODE = "REQUEST_NOT_ACCEPTED";
const BLOCKED_MESSAGE = "We can't complete this request online. Please call us at 631-599-1363 and we'll help.";
const BLOCKED_STATUS = 403;

const blockedBody = () => ({ code: BLOCKED_CODE, message: BLOCKED_MESSAGE });

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return email.includes("@") ? email : "";
}

/** The raw spellings an older entry may have stored the number in. */
function phoneSpellings(digits) {
  if (digits.length !== 10) return [];
  const [a, b, c] = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)];
  return [digits, `1${digits}`, `+1${digits}`, `(${a}) ${b}-${c}`, `${a}-${b}-${c}`, `${a}.${b}.${c}`, `+1 (${a}) ${b}-${c}`, `+1 ${a}-${b}-${c}`];
}

/**
 * The active block entry for any of these identifiers, or null.
 * @param {{ userId?, email?, phone? }} who  userId is the Mongo _id
 */
async function findActiveBlock({ userId = null, email = "", phone = "" } = {}) {
  const clauses = blockMatchClauses({ userId, email, phone });
  if (!clauses.length) return null;
  return Blacklist.findOne({ $or: clauses }).lean();
}

/**
 * The $or clauses that decide which Blacklist entries cover this person.
 * The ONE definition: the block check, unblock and block history all use it,
 * so an entry that blocks somebody is always one their unblock can lift and
 * their history can show - including entries written before phoneDigits
 * existed (raw phone spellings).
 */
function blockMatchClauses({ userId = null, email = "", phone = "" } = {}) {
  const clauses = [];
  if (userId && mongoose.isValidObjectId(String(userId))) clauses.push({ user: new mongoose.Types.ObjectId(String(userId)) });
  const mail = normalizeEmail(email);
  // Emails are stored lowercased and trimmed; scripts/backfill_blacklist_normalization.js fixes older rows.
  if (mail) clauses.push({ email: mail });
  const digits = blacklistPhoneDigits(phone);
  if (digits.length >= 10) {
    clauses.push({ phoneDigits: digits });
    // Entries written before phoneDigits existed.
    clauses.push({ phone: { $in: phoneSpellings(digits) } });
  }
  return clauses;
}

/** blockMatchClauses for a User document (id, email, phone together). */
function blockMatchClausesForUser(user) {
  if (!user) return [];
  return blockMatchClauses({ userId: user._id, email: user.email, phone: user.phone });
}

/** Block check for a signed-in account: its id, email and phone together. */
async function findActiveBlockForUser(userOrId) {
  const user =
    userOrId && typeof userOrId === "object" && userOrId._id
      ? userOrId
      : await User.findById(userOrId).select("email phone").lean();
  if (!user) return null;
  return findActiveBlock({ userId: user._id, email: user.email, phone: user.phone });
}

/** True when any active block covers this account. */
async function isUserBlocked(userOrId) {
  return Boolean(await findActiveBlockForUser(userOrId));
}

/** For read-mostly lists: the set of user ids (strings) blocked by id, email or phone. */
async function blockedUserIdSet(users = []) {
  if (!users.length) return new Set();
  const ids = users.map((u) => u._id);
  const emails = users.map((u) => normalizeEmail(u.email)).filter(Boolean);
  const digits = users.map((u) => blacklistPhoneDigits(u.phone)).filter((d) => d.length === 10);
  const rows = await Blacklist.find({
    $or: [{ user: { $in: ids } }, ...(emails.length ? [{ email: { $in: emails } }] : []), ...(digits.length ? [{ phoneDigits: { $in: digits } }, { phone: { $in: digits.flatMap(phoneSpellings) } }] : [])],
  })
    .select("user email phone phoneDigits")
    .lean();
  const byUser = new Set(rows.map((r) => String(r.user || "")));
  const byEmail = new Set(rows.map((r) => normalizeEmail(r.email)).filter(Boolean));
  const byPhone = new Set(rows.map((r) => r.phoneDigits || blacklistPhoneDigits(r.phone)).filter(Boolean));
  const out = new Set();
  for (const u of users) {
    if (byUser.has(String(u._id)) || byEmail.has(normalizeEmail(u.email)) || byPhone.has(blacklistPhoneDigits(u.phone))) {
      out.add(String(u._id));
    }
  }
  return out;
}

/** Log a refusal without the person's details (only which entry point and which entry). */
function logBlockedAttempt(entryPoint, entry) {
  console.warn(JSON.stringify({ level: "warn", event: "blocked_customer_attempt", entryPoint, blacklistId: entry?._id ? String(entry._id) : null }));
}

/** Send the generic refusal. Returns the response, so callers can `return refuseBlocked(...)`. */
function refuseBlocked(res, entryPoint, entry) {
  logBlockedAttempt(entryPoint, entry);
  return res.status(BLOCKED_STATUS).json(blockedBody());
}

module.exports = {
  BLOCKED_CODE,
  BLOCKED_MESSAGE,
  BLOCKED_STATUS,
  blockedBody,
  blockedUserIdSet,
  blockMatchClauses,
  blockMatchClausesForUser,
  findActiveBlock,
  findActiveBlockForUser,
  isUserBlocked,
  phoneSpellings,
  logBlockedAttempt,
  refuseBlocked,
};
