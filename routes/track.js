const express = require("express");
const router = express.Router();
const User = require("../models/User");

const PIXEL_ID = process.env.FB_PIXEL_ID;
const ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;

// Meta CAPI relay (client -> server -> Meta)
router.post("/fbcap", async (req, res) => {
  try {
    if (!PIXEL_ID || !ACCESS_TOKEN) {
      return res.status(200).json({ ok: true, skipped: true });
    }

    const {
      event_name = "Purchase",
      event_id,
      value = 0,
      currency = "USD",
      plan,
      source_url,
      user_data = {},
    } = req.body || {};

    const mergedUserData = {
      client_user_agent: req.headers["user-agent"] || "",
      client_ip_address:
        (req.headers["x-forwarded-for"]?.split(",")[0]?.trim()) ||
        req.socket?.remoteAddress ||
        "",
      ...user_data,
    };

    const payload = {
      data: [
        {
          event_name,
          event_time: Math.floor(Date.now() / 1000),
          event_id,
          action_source: "website",
          event_source_url: source_url || req.headers.referer || undefined,
          user_data: mergedUserData,
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

// Confirmation page fetches real plan/value using token (?t=...)
router.get("/last-purchase", async (req, res) => {
  try {
    const t = String(req.query.t || "");
    if (!t) return res.status(400).json({ ok: false });

    const user = await User.findOne({ "lastPurchase.token": t }).select("lastPurchase");
    if (!user || !user.lastPurchase) return res.status(404).json({ ok: false });

    return res.json({
      ok: true,
      plan: user.lastPurchase.plan,
      value: user.lastPurchase.value,
      currency: user.lastPurchase.currency,
      createdAt: user.lastPurchase.createdAt,
    });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

router.get("/last-purchase-by-session", async (req, res) => {
  try {
    const sessionId = String(req.query.session_id || "");
    if (!sessionId) return res.status(400).json({ ok: false });

    const user = await User.findOne({ "lastPurchase.stripeSessionId": sessionId }).select("lastPurchase");
    if (!user || !user.lastPurchase) return res.status(404).json({ ok: false });

    return res.json({
      ok: true,
      plan: user.lastPurchase.plan,
      value: user.lastPurchase.value,
      currency: user.lastPurchase.currency,
      createdAt: user.lastPurchase.createdAt,
    });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});


module.exports = router;
