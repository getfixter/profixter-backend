// controllers/facebookCapi.js

/**
 * The original Conversions API relay - retired 2026-11-03.
 *
 * Nothing in the ProFixter frontend or in GTM calls it, and it forwarded the
 * event name, value, email and phone from the request body, so anybody could
 * inject Purchases and Subscribes into the Meta dataset. It still answers 204,
 * as every caller of the old endpoint expected, but forwards nothing. The first
 * call per hour is logged so an unseen caller can be found.
 */
let loggedAt = 0;

module.exports = function facebookCapi(_req, res) {
  const now = Date.now();
  if (now - loggedAt >= 60 * 60 * 1000) {
    loggedAt = now;
    console.log(JSON.stringify({ event: "meta_relay_retired_called", path: "/api/facebook/capi" }));
  }
  return res.status(204).end();
};
