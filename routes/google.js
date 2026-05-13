const express = require("express");
const fetch = require("node-fetch");
const router = express.Router();

router.get("/reviews", async (req, res) => {
  try {
    const key = process.env.GOOGLE_PLACES_API_KEY;
    const placeId = process.env.GOOGLE_PLACE_ID;

    if (!key || !placeId) {
      return res.status(500).json({
        ok: false,
        error: "Missing GOOGLE_PLACES_API_KEY or GOOGLE_PLACE_ID",
      });
    }

    const url =
      `https://maps.googleapis.com/maps/api/place/details/json` +
      `?place_id=${encodeURIComponent(placeId)}` +
      `&fields=${encodeURIComponent("name,rating,user_ratings_total,url,reviews")}` +
      `&language=en` +
      `&key=${encodeURIComponent(key)}`;

    const resp = await fetch(url);
    const json = await resp.json();

    if (json.status !== "OK") {
      return res.status(502).json({
        ok: false,
        error: json.error_message || json.status || "Google fetch failed",
      });
    }

    const result = json.result || {};
    const reviewsRaw = Array.isArray(result.reviews) ? result.reviews : [];

    const reviews = reviewsRaw
      .map((r) => ({
        author_name: String(r.author_name || "Google User"),
        rating: Number(r.rating || 5),
        text: String(r.text || ""),
        relative_time_description: String(r.relative_time_description || ""),
        time: Number(r.time || 0),
        profile_photo_url: String(r.profile_photo_url || ""),
      }))
      .filter((r) => r.text.trim().length > 0)
      .sort((a, b) => {
        if (b.rating !== a.rating) return b.rating - a.rating;
        return (b.time || 0) - (a.time || 0);
      })
      .slice(0, 10); // keep small

    return res.json({
      ok: true,
      placeName: String(result.name || ""),
      rating: Number(result.rating || 0),
      total: Number(result.user_ratings_total || 0),
      googleUrl: String(result.url || ""),
      reviews,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});

module.exports = router;
