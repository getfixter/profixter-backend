const express = require("express");

const { getPayload } = require("../utils/membershipMap");

const router = express.Router();

/**
 * The public membership map.
 *
 * ONE ROUTE, NO PARAMETERS, NO TOKEN, AND NOTHING TO ASK FOR.
 *
 * There is no id to pass, no filter to widen, no plan to select and no page to
 * walk. A caller can request the map or nothing; there is no query string that
 * makes it return more than it already does, because the only shape it can
 * return is the one below.
 *
 * ASSUME EVERY BYTE OF THIS IS READ BY SOMEBODY WITH DEVTOOLS OPEN.
 *
 * That is the design premise rather than a worry. The response carries drawing
 * positions and a plan word - no name, address, ZIP, coordinate, user,
 * subscription, gift, or id of any kind - so inspecting it reveals exactly what
 * looking at the picture reveals. Nothing here depends on the frontend
 * declining to display something it was sent.
 */
router.get("/", async (_req, res) => {
  try {
    const payload = await getPayload();

    /*
     * Cached hard, on purpose. Membership changes do not need to reach the
     * homepage in under a second, and a decorative section must not put a
     * database read behind every visitor. Five minutes fresh, ten more while
     * revalidating - a cancellation is off the map inside one window.
     */
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    return res.json(payload);
  } catch (error) {
    console.error("membership map read failed:", error);
    /*
     * An empty map, not a 500.
     *
     * This is a homepage decoration. If it cannot be built, the section should
     * quietly render nothing rather than put an error on the marketing page -
     * and an empty list is a shape the client already handles, because it is
     * also what a genuinely empty map looks like.
     */
    res.set("Cache-Control", "public, max-age=30");
    return res.json({ viewBox: null, points: [] });
  }
});

module.exports = router;
