const express = require("express");
const crypto = require("crypto");
const staffSetup = require("../utils/auth/staffSetup");
const authAccounts = require("../utils/auth/accounts");
const { hitAll } = require("../utils/auth/authRateLimit");
const { clientIp } = require("../utils/auth/clientIp");

/**
 * The invitation link a new Telemarketer opens (utils/auth/staffSetup.js).
 *
 *   POST /api/staff-setup/verify   { token }            -> { firstName, email, expiresAt }
 *   POST /api/staff-setup/complete { token, password }  -> { token, user }   (signed in)
 *
 * The token is only ever read from the body: never a query string, which ends
 * up in access logs. Both steps are rate limited per IP; a wrong or tampered
 * token gets the same answer as one that never existed.
 */
const router = express.Router();

async function limited(req, res, step) {
  const ip = crypto.createHash("sha256").update(clientIp(req)).digest("hex").slice(0, 32);
  const r = await hitAll([{ key: `staff-setup:${step}:ip:${ip}`, limit: step === "verify" ? 40 : 15, windowMs: 15 * 60 * 1000 }]);
  if (r.allowed) return false;
  res.status(429).json({ message: "Too many attempts. Please wait a few minutes and try again.", code: "RATE_LIMITED", retryAfterSeconds: r.retryAfterSeconds });
  return true;
}

function fail(res, error) {
  if (error instanceof staffSetup.SetupError) return res.status(error.status).json({ message: error.message, code: error.code });
  console.error("Staff setup failed:", error?.message);
  return res.status(500).json({ message: "Something went wrong. Please try again." });
}

router.post("/verify", async (req, res) => {
  try {
    if (await limited(req, res, "verify")) return;
    return res.json(await staffSetup.inspect(String(req.body?.token || "")));
  } catch (error) {
    return fail(res, error);
  }
});

router.post("/complete", async (req, res) => {
  try {
    if (await limited(req, res, "complete")) return;
    const user = await staffSetup.complete(String(req.body?.token || ""), req.body?.password);
    const { authUserDTO, buildPerAddressCoverage } = require("./auth");
    const token = await authAccounts.issueSession(user, req);
    return res.json({ token, user: authUserDTO(user, await buildPerAddressCoverage(user)) });
  } catch (error) {
    return fail(res, error);
  }
});

module.exports = router;
