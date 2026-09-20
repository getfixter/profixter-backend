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

module.exports = router;
