/**
 * Personal referral codes and links.
 *
 * A customer code is the first name in lowercase, a hyphen and four letters or
 * digits ("maria-7k2m"), so it reads well in a text and can never be mistaken
 * for a telemarketer's sales code (upper case, no hyphen: utils/sales/leads).
 * The link is /r/<code>, which the site turns into /?source=referral&ref=<code>
 * so the welcome flow and attribution see an ordinary referral landing.
 *
 * The 2025 links (/?ref=<8-digit account number>, components/ReferralSection)
 * still resolve to the customer they named.
 */
const crypto = require("crypto");
const User = require("../../models/User");
const { ReferralCode } = require("../../models/ReferralProgram");

const CODE_RE = /^[a-z]{1,12}-[a-z0-9]{4}$/;
const LEGACY_RE = /^\d{8}$/;
// No 0/o, 1/l/i: a code read aloud or copied by hand still works.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

const isCustomerAccount = (u) => Boolean(u) && String(u.role || "customer") === "customer" && !u.employeePosition;

function siteBase() {
  return String(process.env.CLIENT_URL || "https://www.profixter.com").replace(/\/+$/, "");
}

function shareUrl(code) {
  return `${siteBase()}/r/${encodeURIComponent(code)}`;
}

function stemFor(user) {
  const first = String(user?.firstName || String(user?.name || "").split(/\s+/)[0] || "")
    .normalize("NFKD")
    .replace(/[^A-Za-z]/g, "")
    .toLowerCase()
    .slice(0, 12);
  return first || "friend";
}

function suffix() {
  const bytes = crypto.randomBytes(4);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** The account's personal code, created the first time it is asked for. */
async function codeFor(user) {
  if (!user?._id) throw new Error("codeFor needs an account");
  const existing = await ReferralCode.findOne({ user: user._id }).lean();
  if (existing) return existing.code;
  const stem = stemFor(user);
  for (let i = 0; i < 8; i += 1) {
    const code = `${stem}-${suffix()}`;
    try {
      return (await ReferralCode.create({ user: user._id, code })).code;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      // Either the code is taken (try another) or this account got one concurrently (use it).
      const mine = await ReferralCode.findOne({ user: user._id }).lean();
      if (mine) return mine.code;
    }
  }
  throw new Error("could not create a referral code");
}

/** Clean a code as a person might paste it: spaces, case, a full link. */
function normalizeCode(raw) {
  let s = String(raw ?? "").trim();
  if (!s || s.length > 200) return "";
  const m = s.match(/\/r\/([^/?#\s]+)/i) || s.match(/[?&]ref=([^&#\s]+)/i);
  if (m) {
    try {
      s = decodeURIComponent(m[1]);
    } catch {
      s = m[1];
    }
  }
  s = s.trim();
  if (LEGACY_RE.test(s)) return s;
  s = s.toLowerCase();
  return CODE_RE.test(s) ? s : "";
}

/**
 * Who a code belongs to: { referrer, code, legacy } or null.
 * Only customer accounts refer customers; a staff code (or anything else) is null.
 */
async function resolveCode(raw) {
  const code = normalizeCode(raw);
  if (!code) return null;
  let referrer = null;
  let legacy = false;
  if (LEGACY_RE.test(code)) {
    referrer = await User.findOne({ userId: code }).lean();
    legacy = true;
  } else {
    const row = await ReferralCode.findOne({ code }).lean();
    if (row) referrer = await User.findById(row.user).lean();
  }
  if (!referrer || !isCustomerAccount(referrer)) return null;
  return { referrer, code, legacy };
}

module.exports = { CODE_RE, LEGACY_RE, codeFor, normalizeCode, resolveCode, shareUrl, isCustomerAccount };
