const crypto = require("crypto");
const bcrypt = require("bcryptjs");

/**
 * Setting up a Telemarketer account from an invitation link.
 *
 * Replaces the shared first password ("11111111") that every new employee
 * used to get. A Telemarketer account is created with NO usable password and a
 * setup link instead:
 *
 *  - the link carries 32 random bytes; only their SHA-256 is stored, so the
 *    database (or a backup of it) cannot be turned back into a working link;
 *  - it expires (TTL_HOURS, 72 by default) and works once: completing setup
 *    removes it in the same atomic update that sets the password;
 *  - issuing a new one (Copy a new link, Send or Resend the invitation)
 *    replaces the stored hash, so every earlier link stops working at once;
 *  - until setup is complete the account can open nothing: password sign-in
 *    skips it (routes/auth.js) and any session it might hold is refused by
 *    middleware/auth.js. Employees cannot sign in by code, Google or Apple.
 *
 * The token travels in the URL fragment (#...), which browsers never send to a
 * server or put in a Referer header, so it does not land in hosting logs.
 */

const DEFAULT_TTL_HOURS = 72;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const SETUP_PATH = "/team-setup";
const LEGACY_SHARED_PASSWORD = "11111111";

/* Tests and the preview stack inject delivery here; production sends through SES. */
const deps = { send: null };

function ttlHours(env = process.env) {
  const raw = Number(env.STAFF_SETUP_TTL_HOURS);
  return Number.isFinite(raw) && raw >= 1 && raw <= 24 * 14 ? raw : DEFAULT_TTL_HOURS;
}

/* The www host: the apex redirects (308), and a redirect is one more hop for the link. */
function siteBase(env = process.env) {
  return String(env.STAFF_SETUP_BASE_URL || "https://www.profixter.com").replace(/\/+$/, "");
}

const hashToken = (raw) => crypto.createHash("sha256").update(`staff-setup|${raw}`).digest("hex");

/* A well-formed token is exactly 43 base64url characters (32 bytes). Anything else is refused before any lookup. */
const wellFormed = (raw) => typeof raw === "string" && /^[A-Za-z0-9_-]{43}$/.test(raw);

function linkFor(raw, env = process.env) {
  return `${siteBase(env)}${SETUP_PATH}#${raw}`;
}

/** Only Telemarketers are set up by link (the owner's decision, 2026-11-14). */
const usesSetupLink = (user) => user?.role === "employee" && user?.employeePosition === "Telemarketer";

/**
 * Whether this account still has to be set up from a link. True for a pending
 * setup, and also for a Telemarketer still carrying the old forced-change flag
 * (created with the shared password) that the boot conversion has not reached:
 * the shared password must never open a Telemarketer account, even for the
 * minutes between a deploy and that conversion.
 */
function awaitingSetup(user) {
  if (!user || user.role !== "employee") return false;
  if (user.staffSetup?.pending === true) return true;
  return usesSetupLink(user) && user.mustChangePassword === true && !user.temporaryPassword?.issuedAt;
}

function isExpired(user, now = new Date()) {
  const at = user?.staffSetup?.expiresAt;
  return !at || new Date(at).getTime() <= now.getTime();
}

/** What the Team screen shows. Never includes the link or its hash. */
function statusOf(user, now = new Date()) {
  if (!awaitingSetup(user)) return user?.staffSetup?.completedAt ? { state: "complete", completedAt: user.staffSetup.completedAt } : null;
  const s = user.staffSetup || {};
  const hasLink = Boolean(s.tokenHash);
  return {
    state: !hasLink ? "needs_link" : isExpired(user, now) ? "expired" : "link_active",
    expiresAt: hasLink ? s.expiresAt || null : null,
    issuedAt: hasLink ? s.issuedAt || null : null,
    lastSentAt: s.lastSentAt || null,
    lastSentTo: s.lastSentTo || "",
    sendCount: Number(s.sendCount || 0),
  };
}

/**
 * Put the account into setup with a fresh link (not saved: the caller saves).
 * Any password is removed, so nothing but the link can open it. Returns the
 * link once; it is not stored and cannot be shown again.
 */
function issue(user, { admin = null, now = new Date(), env = process.env } = {}) {
  const raw = crypto.randomBytes(32).toString("base64url");
  user.password = undefined;
  user.mustChangePassword = false;
  user.staffSetup = {
    ...(user.staffSetup?.toObject ? user.staffSetup.toObject() : user.staffSetup || {}),
    pending: true,
    tokenHash: hashToken(raw),
    issuedAt: now,
    expiresAt: new Date(now.getTime() + ttlHours(env) * 60 * 60 * 1000),
    issuedBy: admin?._id || null,
    issuedByName: String(admin?.name || admin?.email || "").slice(0, 120),
    completedAt: null,
  };
  user.authProviders = (user.authProviders || []).filter((p) => p !== "password");
  return { link: linkFor(raw, env), expiresAt: user.staffSetup.expiresAt };
}

class SetupError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const INVALID = () => new SetupError("SETUP_LINK_INVALID", "This setup link isn't valid. Ask the owner to send you a new one.");
const EXPIRED = () => new SetupError("SETUP_LINK_EXPIRED", "This setup link has expired. Ask the owner to send you a new one.", 410);

async function findByToken(raw) {
  if (!wellFormed(raw)) throw INVALID();
  const User = require("../../models/User");
  const user = await User.findOne({ role: "employee", "staffSetup.pending": true, "staffSetup.tokenHash": hashToken(raw) });
  if (!user) throw INVALID();
  return user;
}

/** For the setup screen: whose account this is, before they choose a password. */
async function inspect(raw, { now = new Date() } = {}) {
  const user = await findByToken(raw);
  if (user.isActive === false) throw INVALID();
  if (isExpired(user, now)) throw EXPIRED();
  return { firstName: user.firstName || String(user.name || "").split(" ")[0] || "", email: user.email, expiresAt: user.staffSetup.expiresAt };
}

function passwordProblem(password, user) {
  const p = String(password || "");
  if (p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (p.length > MAX_PASSWORD) return "That password is too long.";
  if (p === LEGACY_SHARED_PASSWORD || /^(.)\1+$/.test(p)) return "Choose a password that isn't one character repeated.";
  const lower = p.toLowerCase();
  if (["12345678", "123456789", "1234567890", "password", "password1", "profixter", "qwertyui", "qwerty123"].includes(lower)) {
    return "That password is too easy to guess. Choose another.";
  }
  if (user?.email && lower === String(user.email).toLowerCase()) return "Choose a password that isn't your email.";
  return "";
}

/**
 * Finish setup: set the password the employee chose and burn the link, in ONE
 * conditional update. Two tabs submitting the same link at once: exactly one
 * matches; the other is told the link is no longer valid. Returns the saved user.
 */
async function complete(raw, password, { now = new Date() } = {}) {
  const user = await findByToken(raw);
  if (user.isActive === false) throw INVALID();
  if (isExpired(user, now)) throw EXPIRED();
  const problem = passwordProblem(password, user);
  if (problem) throw new SetupError("WEAK_PASSWORD", problem);
  const User = require("../../models/User");
  const hash = await bcrypt.hash(String(password), 10);
  const done = await User.findOneAndUpdate(
    { _id: user._id, role: "employee", "staffSetup.pending": true, "staffSetup.tokenHash": hashToken(raw), "staffSetup.expiresAt": { $gt: now } },
    {
      $set: {
        password: hash,
        mustChangePassword: false,
        "staffSetup.pending": false,
        "staffSetup.tokenHash": null,
        "staffSetup.expiresAt": null,
        "staffSetup.completedAt": now,
      },
      $addToSet: { authProviders: "password" },
      // Any session that somehow existed before setup ends now.
      $inc: { tokenVersion: 1 },
    },
    { new: true }
  );
  if (!done) throw INVALID();
  return done;
}

function inviteEmail({ firstName, link, expiresAt }) {
  const mail = require("../emailService");
  const name = mail.escapeHtml(firstName || "there");
  const until = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(expiresAt));
  return {
    subject: "Set up your Profixter sales account",
    html: mail.frame(
      `
      <h2 style="font-size:22px;font-weight:800;margin:0 0 10px">Hi ${name},</h2>
      <p>Your Profixter sales workspace is ready. Open the link below and choose your own password to finish setting up your account.</p>
      <p style="margin:18px 0">${mail.btn(link, "Set up my account")}</p>
      <p>The link works once and expires on <strong>${mail.escapeHtml(until)}</strong> (New York time). If it expires, ask the owner for a new one.</p>
      <p style="color:#64748b;font-size:14px">If you weren't expecting this, you can ignore this email. Don't forward it: anyone with the link could set up the account.</p>
    `,
      { preheader: "Choose your password to finish setting up your Profixter account." }
    ),
    text: `Hi ${firstName || "there"},\n\nYour Profixter sales workspace is ready. Open this link and choose your own password:\n${link}\n\nThe link works once and expires on ${until} (New York time). If you weren't expecting this, ignore this email. Don't forward it.`,
  };
}

/** Email the link. The email log keeps a redacted copy: the link itself is never stored anywhere. */
async function sendInvite(user, { link, expiresAt }) {
  const message = inviteEmail({ firstName: user.firstName, link, expiresAt });
  if (deps.send) return deps.send({ to: user.email, link, expiresAt, ...message });
  const mail = require("../emailService");
  return mail.sendRaw({
    to: user.email,
    ...message,
    bccAdmin: false,
    logContext: {
      templateKey: "staff_setup_invite",
      emailType: "security",
      source: "staffSetup",
      recipientEmail: user.email,
      recipientName: user.name || "",
      redactBody: true,
    },
  });
}

/**
 * The one-time conversion of Telemarketer accounts created with the shared
 * password and never set up. Matches only accounts still flagged to change it,
 * so a password an employee already chose is never touched. They get no link
 * here: the owner sends one from Team. Idempotent; returns how many changed.
 */
async function convertLegacyTelemarketers({ now = new Date() } = {}) {
  const User = require("../../models/User");
  const { revokeAllForUser } = require("./sessions");
  const rows = await User.find({
    role: "employee",
    employeePosition: "Telemarketer",
    mustChangePassword: true,
    "temporaryPassword.issuedAt": null,
    "staffSetup.pending": { $ne: true },
  }).select("_id");
  let converted = 0;
  for (const { _id } of rows) {
    const r = await User.updateOne(
      { _id, employeePosition: "Telemarketer", mustChangePassword: true, "staffSetup.pending": { $ne: true } },
      {
        $unset: { password: 1 },
        $set: { mustChangePassword: false, "staffSetup.pending": true, "staffSetup.tokenHash": null, "staffSetup.expiresAt": null, "staffSetup.convertedAt": now },
        $pull: { authProviders: "password" },
        $inc: { tokenVersion: 1 },
      }
    );
    if (r.modifiedCount) {
      converted += 1;
      await revokeAllForUser(_id, "staff_setup_required").catch(() => {});
    }
  }
  return converted;
}

module.exports = {
  DEFAULT_TTL_HOURS,
  LEGACY_SHARED_PASSWORD,
  SETUP_PATH,
  SetupError,
  awaitingSetup,
  complete,
  convertLegacyTelemarketers,
  deps,
  hashToken,
  inspect,
  inviteEmail,
  isExpired,
  issue,
  linkFor,
  passwordProblem,
  sendInvite,
  statusOf,
  ttlHours,
  usesSetupLink,
};
