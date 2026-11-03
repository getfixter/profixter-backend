/**
 * The Conversions API, in one place.
 *
 * WHY THIS FILE EXISTS.
 *
 * There were three ways to reach Meta from this codebase - controllers/
 * facebookCapi.js, routes/track.js and an inline sender inside the Stripe
 * webhook - each with its own API version, its own idea of which fields to
 * hash, and its own copy of the pixel id. Two were dead code nothing called.
 * The live one sent an event named "Purchase" when somebody started a monthly
 * membership. Everything now goes through send().
 *
 * WHY EVENTS ARE SENT FROM THE SERVER AT ALL.
 *
 * The browser pixel is blocked for a large minority of real customers, and
 * blocked disproportionately on exactly the conversions worth the most. The
 * server cannot be blocked, and it knows more: the verified email and phone,
 * the address, the plan actually charged. The two are reconciled by event_id -
 * Meta collapses a browser event and a server event sharing one id into a
 * single conversion, so the pair improves coverage without inflating counts.
 *
 * NOTHING HERE MAY THROW OR BLOCK.
 *
 * Every caller sits on a signup or a payment path. A tracking failure - a bad
 * token, a Meta outage, a DNS blip - must cost nothing, so send() resolves to a
 * result object rather than rejecting, and callers are expected not to await it
 * where latency would be felt.
 */

const crypto = require("crypto");

/** The one dataset. Also stated in the frontend's lib/meta.ts; they must agree. */
const META_PIXEL_ID = "3668264173327839";
const GRAPH_VERSION = "v21.0";

/**
 * The token, read at call time rather than at module load.
 *
 * Elastic Beanstalk injects environment on boot, but a module hoisted into a
 * different load order can read it before it exists; the old senders captured
 * `process.env.FB_ACCESS_TOKEN` at require time for exactly that reason and
 * went quiet whenever the order changed. FB_ACCESS_TOKEN is still honoured so
 * that nothing breaks in the window before META_CAPI_TOKEN is set.
 */
function getToken() {
  return process.env.META_CAPI_TOKEN || process.env.FB_ACCESS_TOKEN || "";
}

function sha256(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * A phone as Meta wants it: digits only, country code included, no plus.
 *
 * A ten-digit US number is assumed to be US and gets a 1. A number that already
 * starts with 1 and is eleven digits is left alone. Anything else is passed
 * through as digits, because guessing a country code wrongly is worse than
 * sending a number Meta fails to match.
 */
function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `1${digits}`;
  return digits;
}

const US_STATES = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co",
  connecticut: "ct", delaware: "de", "district of columbia": "dc", florida: "fl", georgia: "ga",
  hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia", kansas: "ks", kentucky: "ky",
  louisiana: "la", maine: "me", maryland: "md", massachusetts: "ma", michigan: "mi", minnesota: "mn",
  mississippi: "ms", missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv", "new hampshire": "nh",
  "new jersey": "nj", "new mexico": "nm", "new york": "ny", "north carolina": "nc", "north dakota": "nd",
  ohio: "oh", oklahoma: "ok", oregon: "or", pennsylvania: "pa", "rhode island": "ri",
  "south carolina": "sc", "south dakota": "sd", tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt",
  virginia: "va", washington: "wa", "west virginia": "wv", wisconsin: "wi", wyoming: "wy",
};

/**
 * US state as a two-letter lowercase code, which is the only form Meta matches.
 * "New York" used to go out as "new york" (both branches lowercased) and match nothing.
 */
function normalizeState(state) {
  const trimmed = String(state || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "");
  if (!trimmed) return "";
  if (/^[a-z]{2}$/.test(trimmed)) return trimmed;
  return US_STATES[trimmed] || "";
}

/*
 * Delivery is visible (2026-11-03). Failures were a console.warn at best, and a
 * missing token or an event with no identifiers returned silently - every
 * server conversion could stop and nothing would say so. Now each failure is a
 * JSON line ("meta_capi_failed"), a missing token is logged once an hour, and
 * an hourly "meta_capi_summary" counts what was sent and what was not (only
 * when something happened).
 */
const counts = {};
let notConfiguredLoggedAt = 0;
function count(eventName, outcome) {
  const key = `${eventName}:${outcome}`;
  counts[key] = (counts[key] || 0) + 1;
}
function logFailure(eventName, eventId, reason, extra = {}) {
  count(eventName, reason);
  console.error(JSON.stringify({ event: "meta_capi_failed", eventName, eventId: eventId || null, reason, ...extra }));
}
setInterval(() => {
  if (!Object.keys(counts).length) return;
  console.log(JSON.stringify({ event: "meta_capi_summary", lastHour: { ...counts } }));
  for (const k of Object.keys(counts)) delete counts[k];
}, 60 * 60 * 1000).unref?.();

/* One retry, same event id (Meta deduplicates on it), for a 5xx or a network error. */
const RETRY_DELAY_MS = 2000;
async function postWithRetry(url, init) {
  try {
    const first = await fetch(url, init);
    if (first.status < 500) return first;
  } catch {
    /* fall through to the retry */
  }
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  return fetch(url, init);
}

/** ZIP without the +4, which Meta ignores and which lowers the match rate. */
function normalizeZip(zip) {
  const digits = String(zip || "").replace(/\D/g, "");
  return digits ? digits.slice(0, 5) : "";
}

function normalizeName(name) {
  return String(name || "").trim().toLowerCase().replace(/[^a-zÀ-ɏ'\- ]/g, "");
}

/** Strip keys Meta would reject: undefined, null, empty strings, empty arrays. */
function clean(object) {
  if (!object || typeof object !== "object") return object;
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const kept = value.filter((v) => v !== undefined && v !== null && String(v).trim() !== "");
      if (kept.length) out[key] = kept;
      continue;
    }
    if (typeof value === "string" && value.trim() === "") continue;
    out[key] = value;
  }
  return out;
}

function firstForwardedIp(req) {
  const forwarded = req?.headers?.["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req?.socket?.remoteAddress || "";
}

function readCookie(req, name) {
  const header = req?.headers?.cookie || "";
  const match = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split("=").slice(1).join("=")) : "";
}

/**
 * The click id, from the cookie if the pixel wrote one and from the URL if not.
 *
 * _fbc only exists if the pixel ran while the fbclid was still in the address
 * bar. Blocked pixel, slow load, or a client-side navigation that replaced the
 * query string all lose it - so a caller that captured the fbclid at landing
 * can pass it and have the value rebuilt in Meta's documented format,
 * `fb.1.<creation-ms>.<fbclid>`. Without this, a large share of paid clicks
 * arrive unattributed.
 */
function resolveFbc({ fbc, fbclid, fbclidAt, req }) {
  if (fbc) return fbc;
  const cookie = readCookie(req, "_fbc");
  if (cookie) return cookie;
  if (fbclid) return `fb.1.${Number(fbclidAt) || Date.now()}.${fbclid}`;
  return "";
}

/**
 * Everything Meta can match a person on, hashed.
 *
 * Plaintext never leaves this function. The identifiers that are NOT hashed -
 * fbp, fbc, the IP and the user agent - are the ones Meta's own spec says must
 * be sent raw; hashing those would simply make them unmatched.
 */
function buildUserData({ user = {}, address = {}, fbp, fbc, clientIp, userAgent, externalId }) {
  const email = String(user.email || "").trim().toLowerCase();
  const phone = normalizePhone(user.phone);

  const first = normalizeName(user.firstName || String(user.name || "").split(" ")[0]);
  const last = normalizeName(
    user.lastName || String(user.name || "").split(" ").slice(1).join(" ")
  );

  return clean({
    em: email ? [sha256(email)] : undefined,
    ph: phone ? [sha256(phone)] : undefined,
    fn: first ? [sha256(first)] : undefined,
    ln: last ? [sha256(last)] : undefined,
    ct: address.city ? [sha256(String(address.city).replace(/\s/g, ""))] : undefined,
    st: address.state ? [sha256(normalizeState(address.state))] : undefined,
    zp: address.zip ? [sha256(normalizeZip(address.zip))] : undefined,
    country: [sha256("us")],
    external_id: externalId ? [sha256(String(externalId))] : undefined,
    fbp: fbp || undefined,
    fbc: fbc || undefined,
    client_ip_address: clientIp || undefined,
    client_user_agent: userAgent || undefined,
  });
}

/**
 * Whether this event can be matched to anybody.
 *
 * Meta accepts an event with no identifiers and then silently does nothing
 * useful with it, which looks identical to working. Refusing to send it keeps
 * the dataset's match quality honest and keeps the logs meaningful.
 */
function hasUsableIdentity(userData) {
  return Boolean(
    userData.em ||
      userData.ph ||
      userData.external_id ||
      userData.fbp ||
      userData.fbc
  );
}

/**
 * Send one event. Never throws, never rejects.
 *
 * Returns a small result object so callers and tests can assert on what
 * happened without any of them having to handle an error.
 */
async function send({
  eventName,
  eventId,
  eventSourceUrl,
  customData = {},
  user = {},
  address = {},
  externalId,
  fbp,
  fbc,
  fbclid,
  fbclidAt,
  req = null,
  clientIp,
  userAgent,
  eventTime,
}) {
  try {
    const token = getToken();
    if (!token || !eventName) {
      count(eventName || "unknown", "not_configured");
      if (!token && Date.now() - notConfiguredLoggedAt > 60 * 60 * 1000) {
        notConfiguredLoggedAt = Date.now();
        console.error(JSON.stringify({ event: "meta_capi_not_configured", eventName: eventName || null }));
      }
      return { sent: false, reason: "not_configured" };
    }
    if (typeof fetch !== "function") {
      return { sent: false, reason: "no_fetch" };
    }

    const resolvedIp = clientIp || firstForwardedIp(req);
    const resolvedUa = userAgent || req?.headers?.["user-agent"] || "";
    const resolvedFbp = fbp || readCookie(req, "_fbp");
    const resolvedFbc = resolveFbc({ fbc, fbclid, fbclidAt, req });

    const userData = buildUserData({
      user,
      address,
      fbp: resolvedFbp,
      fbc: resolvedFbc,
      clientIp: resolvedIp,
      userAgent: resolvedUa,
      externalId,
    });

    if (!hasUsableIdentity(userData)) {
      count(eventName, "no_identifiers");
      return { sent: false, reason: "no_identifiers" };
    }

    const payload = {
      data: [
        clean({
          event_name: eventName,
          event_time: eventTime || Math.floor(Date.now() / 1000),
          event_id: eventId || undefined,
          action_source: "website",
          event_source_url: eventSourceUrl || req?.headers?.referer || undefined,
          user_data: userData,
          custom_data: clean(customData),
        }),
      ],
    };

    // Set only while testing against Events Manager; absent in normal operation.
    if (process.env.META_TEST_EVENT_CODE || process.env.FB_TEST_CODE) {
      payload.test_event_code =
        process.env.META_TEST_EVENT_CODE || process.env.FB_TEST_CODE;
    }

    const response = await postWithRetry(
      `https://graph.facebook.com/${GRAPH_VERSION}/${META_PIXEL_ID}/events`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      }
    );

    if (!response.ok) {
      let detail = "";
      try {
        detail = JSON.stringify(await response.json());
      } catch {
        detail = await response.text().catch(() => "");
      }
      logFailure(eventName, eventId, "http_error", { status: response.status, detail: detail.slice(0, 400) });
      return { sent: false, reason: "http_error", status: response.status };
    }

    count(eventName, "sent");
    return { sent: true, eventId: eventId || null };
  } catch (error) {
    logFailure(eventName, eventId, "exception", { message: String(error?.message || error).slice(0, 200) });
    return { sent: false, reason: "exception" };
  }
}

/**
 * Fire and forget, for call sites on a signup or payment path.
 *
 * The await is deliberately not offered: a customer must never wait on Meta,
 * and a rejected promise here must never become an unhandled rejection that
 * takes the process down.
 */
function sendDetached(options) {
  Promise.resolve()
    .then(() => send(options))
    .catch(() => {});
}

module.exports = {
  META_PIXEL_ID,
  GRAPH_VERSION,
  getToken,
  send,
  sendDetached,
  sha256,
  normalizePhone,
  normalizeState,
  normalizeZip,
  buildUserData,
  hasUsableIdentity,
  resolveFbc,
  firstForwardedIp,
  readCookie,
};
