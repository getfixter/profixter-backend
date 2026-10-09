/**
 * Is this ZIP one we serve? One question, one answer, no account required.
 *
 * The signup address step needs this to say "we're not in your area yet" the
 * moment somebody picks an address, and it is deliberately the only way the
 * browser can find out. The alternative was shipping the 169-ZIP allowlist to
 * the client, which would make utils/serviceArea.js the single source of truth
 * for everything except the one screen a customer actually reads — and the two
 * copies would drift the first time the business added a town.
 *
 * This answers a question, it does not grant anything. Eligibility for the
 * First Visit Free offer is still decided server-side where the visit is
 * booked, against the address on file, exactly as before. A lie told to this
 * endpoint buys nothing, which is why it needs no auth and no rate limit
 * beyond the app's own.
 *
 * Public, cacheable, and free of anything about the caller: the input is five
 * digits and the output is a boolean and a county name.
 */
const express = require("express");
const router = express.Router();

const { normalizeZip, isZipInServiceArea, countyForZip, SERVICE_AREA_LABEL } =
  require("../utils/serviceArea");

router.get("/check", (req, res) => {
  const zip = normalizeZip(req.query.zip);

  if (!zip) {
    return res.status(400).json({ message: "A 5-digit ZIP code is required." });
  }

  const serviceable = isZipInServiceArea(zip);

  /*
   * A day is the right cache window. The allowlist changes when the business
   * decides to serve another town, which is a deploy, not an event anybody is
   * waiting on to the minute.
   */
  res.set("Cache-Control", "public, max-age=86400");

  return res.json({
    zip,
    serviceable,
    county: countyForZip(zip),
    serviceAreaLabel: SERVICE_AREA_LABEL,
  });
});

/**
 * "Tell me when you serve my area."
 *
 * The free-visit booker's out-of-area screen used to be a dead end. Now the
 * visitor can leave an email for the one message that matters to them, and we
 * learn where unmet demand is. See models/ServiceAreaWaitlist for what the row
 * may and may not be used for (email, once, about coverage - never SMS).
 *
 * Refuses a ZIP we already serve: that visitor should book, and a waitlist row
 * for a serviceable ZIP would only ever be a bug on the page.
 *
 * Rate-limited per IP because, unlike /check, this one writes.
 */
const ServiceAreaWaitlist = require("../models/ServiceAreaWaitlist");
const { normalizeEmail } = require("../utils/identity");
const { sanitizeAttribution } = require("../utils/analytics/attribution");
const { rateLimit } = require("../utils/rateLimit");

const WAITLIST_CONSENT_TEXT = "Email me when Profixter starts serving my area";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const waitlistLimiter = rateLimit({
  limit: 10,
  windowMs: 60 * 60 * 1000,
  keyResolver: (req) =>
    String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim() || null,
});

router.post("/waitlist", waitlistLimiter, async (req, res) => {
  const body = req.body || {};
  const email = String(body.email || "").trim().slice(0, 254);
  const emailNormalized = normalizeEmail(email);
  const zip = normalizeZip(body.zip);

  if (!emailNormalized || !EMAIL_RE.test(emailNormalized)) {
    return res.status(400).json({ code: "INVALID_EMAIL", message: "Please enter a valid email." });
  }
  if (!zip) {
    return res.status(400).json({ code: "INVALID_ZIP", message: "A 5-digit ZIP code is required." });
  }
  // A literal true, as everywhere else consent is recorded: "false" is truthy.
  if (body.consentEmail !== true) {
    return res.status(400).json({ code: "CONSENT_REQUIRED", message: "Please tick the box so we can email you." });
  }
  if (isZipInServiceArea(zip)) {
    return res.status(400).json({ code: "IN_SERVICE_AREA", message: "We already serve this ZIP code." });
  }

  const now = new Date();
  try {
    await ServiceAreaWaitlist.updateOne(
      { emailNormalized, zip },
      {
        $setOnInsert: {
          email,
          emailNormalized,
          zip,
          source: body.source ? String(body.source).slice(0, 60) : null,
          visitorId: body.visitorId ? String(body.visitorId).slice(0, 100) : null,
          attribution: sanitizeAttribution(body.attribution, { now }),
          consentEmailAt: now,
          consentText: WAITLIST_CONSENT_TEXT,
          status: "waiting",
        },
        $set: { lastRequestedAt: now },
        $inc: { requestCount: 1 },
      },
      { upsert: true }
    );
  } catch (error) {
    // Two identical submits racing the unique index: the row exists, which is the goal.
    if (error?.code !== 11000) {
      console.error("Waitlist save failed:", error.message);
      return res.status(500).json({ message: "Could not save that right now. Please try again." });
    }
  }

  return res.status(201).json({ ok: true });
});

module.exports = router;
module.exports.WAITLIST_CONSENT_TEXT = WAITLIST_CONSENT_TEXT;
