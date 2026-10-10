const express = require("express");
const SeoOverride = require("../models/SeoOverride");

/**
 * Public, read-only: the active search-wording overrides, keyed by page path.
 *
 * The site reads this during incremental regeneration (every few minutes per
 * page) and falls back to its code defaults if the call fails, so this
 * endpoint can never take a page down. Contains only published page wording.
 */
const router = express.Router();

router.get("/overrides", async (req, res) => {
  try {
    const rows = await SeoOverride.find({ active: true }).select("path fields updatedAt").lean();
    res.set("Cache-Control", "public, max-age=120");
    res.json({
      overrides: Object.fromEntries(
        rows.map((r) => [
          r.path,
          Object.fromEntries(Object.entries(r.fields || {}).filter(([, v]) => typeof v === "string" && v.trim())),
        ])
      ),
    });
  } catch (error) {
    res.status(500).json({ overrides: {} });
  }
});

module.exports = router;
