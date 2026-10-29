// backend/routes/passwordReset.js
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const mail = require("../utils/emailService");
const smsNotify = require("../utils/sms/smsNotifications");
const { findCustomerByEmail } = require("../utils/userLookup");
const { OtpError, startChallenge, verifyChallenge } = require("../utils/auth/otpService");
const { clientIp } = require("../utils/auth/clientIp");

/**
 * Password reset, on the same code service as sign-in.
 *
 * What changed, and why:
 *  - the code comes from crypto.randomInt (it was Math.random);
 *  - five guesses per code, and limits per address and per IP on both
 *    sending and guessing (there were none: 900,000 codes, unlimited tries);
 *  - a code is only emailed when a customer account owns the address, while
 *    the answer is identical either way - nobody learns who has an account,
 *    and the form cannot be used to mail strangers;
 *  - reset codes are their own kind: one can never sign anybody in, and a
 *    sign-in code can never reset a password;
 *  - the reset token works once: it is bound to the password it replaces;
 *  - a reset ends every session that existed before it.
 *
 * The three steps and their responses are unchanged, so the reset screen keeps
 * working as it is. Tests inject delivery through `router.deps`.
 */
router.deps = { deliver: null };

const RESET_SECRET = () => process.env.JWT_RESET_SECRET || `${process.env.JWT_SECRET}:password-reset`;
const RESET_TTL_MS = 5 * 60 * 1000; // the email says "expires in 5 minutes"
const MIN_PASSWORD = 8;

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

/** A fingerprint of the current password: changes the moment it is replaced. */
function passwordFingerprint(user) {
  return crypto.createHash("sha256").update(`pwf|${user._id}|${user.password || ""}`).digest("hex").slice(0, 32);
}

function limited(res, error) {
  return res.status(429).json({
    message: "Too many attempts. Please wait a few minutes and try again.",
    code: "RATE_LIMITED",
    retryAfterSeconds: error.retryAfterSeconds || 60,
  });
}

// ✅ Step 1: Send a code (only to a real customer, same answer regardless)
router.post("/", async (req, res) => {
  const email = cleanEmail(req.body?.email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: "Email is required" });
  }
  try {
    const user = await findCustomerByEmail(email);
    await startChallenge({
      channel: "email",
      target: email,
      purpose: "reset",
      ttlMs: RESET_TTL_MS,
      ip: clientIp(req),
      deliver: async ({ code }) => {
        if (router.deps.deliver) return router.deps.deliver({ target: email, code, exists: Boolean(user) });
        if (!user) return; // nobody to reset; answer as if sent
        await mail.sendTx("password_otp", email, { otp: code, name: user.name || "there" }, {
          bccAdmin: false,
          logContext: { customerEmail: email, recipientEmail: email, emailType: "security", source: "passwordReset", redactBody: true },
        });
      },
    });
    return res.status(200).json({ message: "OTP sent" });
  } catch (err) {
    if (err instanceof OtpError && err.code === "RATE_LIMITED") return limited(res, err);
    console.error("❌ OTP send error:", err.message);
    return res.status(500).json({ message: "Failed to send OTP" });
  }
});

// ✅ Step 2: Verify the code -> a short-lived, single-use reset token
router.post("/verify", async (req, res) => {
  const email = cleanEmail(req.body?.email);
  const otp = String(req.body?.otp || "");
  if (!email || !otp) return res.status(400).json({ message: "Missing input" });
  try {
    await verifyChallenge({ channel: "email", target: email, code: otp, purpose: "reset", ip: clientIp(req) });
    const user = await findCustomerByEmail(email);
    if (!user) return res.status(400).json({ message: "Invalid or expired code" });
    const token = jwt.sign({ typ: "reset", email, pwf: passwordFingerprint(user) }, RESET_SECRET(), { expiresIn: "15m" });
    return res.status(200).json({ message: "OTP verified", token });
  } catch (err) {
    if (err instanceof OtpError) {
      if (err.code === "RATE_LIMITED") return limited(res, err);
      return res.status(400).json({
        message: "Invalid or expired code",
        ...(err.attemptsLeft ? { attemptsLeft: err.attemptsLeft } : {}),
      });
    }
    console.error("❌ OTP verify error:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
});

// ✅ Step 3: Set the new password (token from body, header, or query)
router.post("/set-password", async (req, res) => {
  try {
    const rawAuth = req.headers.authorization || "";
    const bearer = rawAuth.startsWith("Bearer ") ? rawAuth.slice(7) : null;
    const token = req.body?.token || req.body?.resetToken || bearer || req.query.token;
    const password = String(req.body?.password || "");

    if (!token) return res.status(400).json({ message: "Missing reset token" });
    if (!password) return res.status(400).json({ message: "Password required" });
    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD} characters.` });
    }

    const payload = jwt.verify(token, RESET_SECRET());
    if (payload?.typ !== "reset") throw Object.assign(new Error("wrong token"), { name: "JsonWebTokenError" });

    /*
     * Self-serve reset belongs to the customer account. An email can also carry
     * a Fixter account, and resetting that from a public form would let anyone
     * with inbox access take over a staff login. Employee passwords stay on the
     * admin-managed path.
     */
    const user = await findCustomerByEmail(payload.email);
    if (!user) return res.status(404).json({ message: "User not found" });

    // Used once: after this password is set, the fingerprint no longer matches.
    if (payload.pwf !== passwordFingerprint(user)) {
      return res.status(400).json({ message: "Reset code expired. Please request a new one." });
    }

    user.password = await bcrypt.hash(password, 10);
    user.tokenVersion = Number(user.tokenVersion || 0) + 1; // signs out every other device
    if (!(user.authProviders || []).includes("password")) user.authProviders = [...(user.authProviders || []), "password"];
    await user.save();

    /*
     * The confirmations are best effort: the password HAS changed, and a mail
     * outage must not tell the customer otherwise.
     */
    try {
      await mail.sendTx("password_changed", payload.email, { name: user.name }, {
        bccAdmin: false,
        logContext: {
          userId: user._id,
          customerName: user.name || "",
          customerEmail: payload.email,
          recipientName: user.name || "",
          recipientEmail: payload.email,
          emailType: "security",
          source: "passwordReset",
        },
      });
    } catch (mailError) {
      console.error("Password-changed email failed:", mailError.message);
    }

    /*
     * The security text, keyed to the moment rather than the account: someone
     * whose password is being changed without their knowledge must be told
     * every single time.
     */
    try {
      await smsNotify.notifyPasswordChanged(user, { changedAt: new Date(), source: "passwordReset" });
    } catch (smsError) {
      console.error("Password-changed text failed:", smsError.message);
    }

    return res.status(200).json({ message: "Password updated" });
  } catch (err) {
    console.error("❌ Set password error:", err.name, err.message);
    if (err.name === "TokenExpiredError") {
      return res.status(400).json({ message: "Reset code expired. Please request a new one." });
    }
    if (err.name === "JsonWebTokenError") {
      return res.status(400).json({ message: "Invalid reset code. Please request a new one." });
    }
    return res.status(500).json({ message: "Server error" });
  }
});

router.passwordFingerprint = passwordFingerprint;
module.exports = router;
