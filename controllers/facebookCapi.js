// controllers/facebookCapi.js
const metaCapi = require("../utils/metaCapi");

/**
 * The original Conversions API relay, kept alive but repointed.
 *
 * Nothing in the ProFixter frontend calls this - it was already dead code when
 * the tracking was rebuilt - but it is a mounted, publicly reachable endpoint,
 * and it used to read `process.env.FB_PIXEL_ID`. That is precisely how events
 * kept arriving in the old dataset after the pixel was replaced. Deleting it
 * outright would break any caller we cannot see from here, such as a custom
 * tag inside GTM, so it now forwards to the one sender instead.
 *
 * It is deliberately NOT a general relay. utils/metaCapi enforces the pixel and
 * the allow-listed conversions; this only translates the old request shape.
 *
 * Always 204, because every caller of the old endpoint expected that.
 */
module.exports = async function facebookCapi(req, res) {
  try {
    const { name, params = {}, eventID, sourceUrl } = req.body || {};
    const ALLOWED = new Set(["Lead", "Subscribe", "Purchase"]);

    if (name && ALLOWED.has(String(name))) {
      await metaCapi.send({
        eventName: String(name),
        eventId: eventID || undefined,
        eventSourceUrl: sourceUrl || req.headers.referer,
        customData: params,
        user: { email: params.email, phone: params.phone },
        externalId: params.externalId,
        fbp: params.fbp,
        fbc: params.fbc,
        req,
      });
    }
  } catch (error) {
    console.warn("Legacy CAPI relay failed:", error.message);
  }

  return res.status(204).end();
};
