const ConsentEvent = require("../../models/ConsentEvent");
const { wording } = require("./consentText");

/**
 * Append one event to the consent history (models/ConsentEvent).
 *
 * Called AFTER the preference itself is saved, and never allowed to undo it:
 * the preference is what protects the customer (an opt-out must take effect
 * even if the history write fails), so a failure here is logged loudly and
 * the request carries on.
 *
 * `version` is given only for a choice the customer made on a screen; it adds
 * the exact wording they saw.
 */
async function recordConsent({ user = null, channel, purpose, action, source, version = "", phone = "", email = "", req = null, detail = "", at = new Date() }) {
  try {
    const words = version ? wording(version) : { consentVersion: "", consentText: "" };
    await ConsentEvent.create({
      user: user?._id || user || null,
      channel,
      purpose,
      action,
      source,
      ...words,
      phone: String(phone || ""),
      email: String(email || "").trim().toLowerCase(),
      ip: req ? String(req.headers?.["x-forwarded-for"] || req.ip || "").split(",")[0].trim().slice(0, 64) : "",
      userAgent: req ? String(req.headers?.["user-agent"] || "").slice(0, 300) : "",
      detail: String(detail || "").slice(0, 300),
      at,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "consent_history_write_failed", channel, purpose, action, source, error: String(error?.message || error).slice(0, 200) }));
  }
}

module.exports = { recordConsent };
