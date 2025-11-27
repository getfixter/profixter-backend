// controllers/facebookCapi.js
// Node 18+ has global fetch. If you're on Node <18, install node-fetch and import it.

const FB_PIXEL_ID = process.env.FB_PIXEL_ID;         // e.g. 4096130163937669
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN; // long-lived token from Events Manager

module.exports = async function facebookCapi(req, res) {
  try {
    const { name, params = {}, eventID } = req.body || {};

    // Always ack so frontend never breaks even if creds not set
    if (!FB_PIXEL_ID || !FB_ACCESS_TOKEN || !name) {
      return res.status(204).end();
    }

    const url = `https://graph.facebook.com/v17.0/${FB_PIXEL_ID}/events`;
    const payload = {
      data: [{
        event_name: name,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventID,
        action_source: "website",
        event_source_url: req.headers.referer || "",
        user_data: {
          client_user_agent: req.headers["user-agent"] || "",
          client_ip_address:
            (req.headers["x-forwarded-for"]?.split(",")[0]?.trim())
            || req.socket?.remoteAddress
            || "",
        },
        custom_data: params || {},
      }],
      // test_event_code: process.env.FB_TEST_CODE || undefined,
    };

    const r = await fetch(`${url}?access_token=${FB_ACCESS_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const text = await r.text();
      console.warn("Meta CAPI error:", r.status, text);
    }

    return res.status(204).end();
  } catch (e) {
    console.warn("CAPI controller failed:", e.message);
    return res.status(204).end();
  }
};
