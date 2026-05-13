// controllers/facebookCapi.js
// Node 18+ has global fetch.
// Sends Conversions API events with strong user_data (em/ph/fbp/fbc/external_id) and skips weak events.

const crypto = require("crypto");

function sha256(v) {
  if (!v) return undefined;
  return crypto
    .createHash("sha256")
    .update(String(v).trim().toLowerCase())
    .digest("hex");
}

function normEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return e || "";
}

function normPhone(phone) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (!digits) return "";
  if (digits.length === 10) return "1" + digits; // US
  return digits;
}

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || "";
  const parts = cookie.split(";").map((s) => s.trim());
  const found = parts.find((p) => p.startsWith(name + "="));
  return found ? decodeURIComponent(found.split("=").slice(1).join("=")) : null;
}

function cleanObject(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      const arr = v.filter((x) => x !== undefined && x !== null && String(x).trim() !== "");
      if (!arr.length) continue;
      out[k] = arr;
      continue;
    }
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = v;
  }
  return out;
}

module.exports = async function facebookCapi(req, res) {
  try {
    const FB_PIXEL_ID = process.env.FB_PIXEL_ID;
    const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;
    const FB_TEST_CODE = process.env.FB_TEST_CODE || "";

    const { name, params = {}, eventID, sourceUrl } = req.body || {};

    // Always ack so frontend never breaks even if creds not set
    if (!FB_PIXEL_ID || !FB_ACCESS_TOKEN || !name) {
      return res.status(204).end();
    }

    if (typeof fetch !== "function") {
      console.warn("⚠️ fetch not available. Node 18+ required for Meta CAPI.");
      return res.status(204).end();
    }

    const email = normEmail(params.email);
    const phone = normPhone(params.phone);
    const externalId = params.externalId ? String(params.externalId) : "";

    const fbp = params.fbp || getCookie(req, "_fbp");
    const fbc = params.fbc || getCookie(req, "_fbc");

    const user_data = cleanObject({
      em: email ? [sha256(email)] : undefined,
      ph: phone ? [sha256(phone)] : undefined,
      external_id: externalId ? [sha256(externalId)] : undefined,
      fbp: fbp || undefined,
      fbc: fbc || undefined,
      client_ip_address: getClientIp(req) || undefined,
      client_user_agent: req.headers["user-agent"] || undefined,
    });

    // ✅ If user_data too weak, do not send
    const hasStrong =
      !!(user_data.em || user_data.ph || user_data.external_id || user_data.fbp || user_data.fbc);

    if (!hasStrong) {
      console.warn("⚠️ Meta CAPI skipped: missing identifiers. Event:", name);
      return res.status(204).end();
    }

    const body = {
      data: [
        cleanObject({
          event_name: name,
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventID || undefined,
          action_source: "website",
          event_source_url: sourceUrl || req.headers.referer || undefined,
          user_data,
          custom_data: params || {},
        }),
      ],
    };

    if (FB_TEST_CODE) body.test_event_code = FB_TEST_CODE;

    const url = `https://graph.facebook.com/v20.0/${FB_PIXEL_ID}/events?access_token=${FB_ACCESS_TOKEN}`;

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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