// 📁 backend/routes/track.js
const express = require("express");
const router = express.Router();

const PIXEL_ID = process.env.FB_PIXEL_ID;
const ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;

// Basic guard
if (!PIXEL_ID || !ACCESS_TOKEN) {
  console.warn("⚠️ FB_PIXEL_ID or FB_ACCESS_TOKEN not set — /api/track/fbcap will be a no-op.");
}

router.post("/fbcap", async (req, res) => {
  try {
    if (!PIXEL_ID || !ACCESS_TOKEN) return res.status(200).json({ ok: true, skipped: true });

    const {
      event_name = "Subscribe",
      event_id,           // for dedup with Pixel
      value = 0,
      currency = "USD",
      plan,
      source_url,
      user_data = {},     // { em: hashed email, ph: hashed phone } — optional
    } = req.body || {};

    const payload = {
      data: [
        {
          event_name,
          event_time: Math.floor(Date.now() / 1000),
          event_id,
          action_source: "website",
          event_source_url: source_url || req.headers.referer || undefined,
          user_data,  // pass-through if provided (already hashed from client or leave empty)
          custom_data: {
            value: Number(value) || 0,
            currency,
            plan,
          },
        },
      ],
    };

    const url = `https://graph.facebook.com/v17.0/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const text = await r.text();
      console.warn("Meta CAPI error:", r.status, text);
      return res.status(200).json({ ok: true, meta_error: true });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.warn("CAPI relay failed:", e.message);
    return res.status(200).json({ ok: true, error: true });
  }
});

module.exports = router;
