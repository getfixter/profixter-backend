/**
 * Small helpers shared by the visibility collectors: New York dates, error
 * sanitising, and an HTTP call with a timeout.
 */
const TIMEZONE = "America/New_York";

const nyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD of `date` in New York, the business's day boundary. */
function nyDate(date = new Date()) {
  return nyFormatter.format(date);
}

function shiftYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole days from a to b (b later is positive). */
function daysBetween(a, b) {
  const toMs = (ymd) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toMs(b) - toMs(a)) / 86400000);
}

function round(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const f = 10 ** digits;
  return Math.round(Number(value) * f) / f;
}

/**
 * Strip anything credential-like from an error before it is stored in the
 * status record (which the Admin can read) or logged. Each collector also
 * passes its own secret values, which are removed verbatim wherever they
 * appear; the patterns catch the shapes we know about even if a secret is
 * not passed: Google API keys, bearer tokens, basic-auth headers, PEM private
 * keys and key=... query parameters.
 */
function sanitizeError(message, secrets = []) {
  let text = String(message || "").slice(0, 4000);
  for (const secret of secrets) {
    if (secret && String(secret).length >= 6) text = text.split(String(secret)).join("[redacted]");
  }
  text = text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted-key]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/([?&](key|access_token|token|password)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted]");
  return text.slice(0, 300);
}

class HttpError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * fetch + JSON with a hard timeout. Returns the parsed body; throws HttpError
 * on a non-2xx status or an unparseable body. The error message carries a
 * short excerpt of the body, which callers must sanitise before storing.
 */
async function fetchJson(fetchImpl, url, { method = "GET", headers = {}, body, timeoutMs = 30000 } = {}) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      signal: controller?.signal,
    });
  } catch (error) {
    const reason = error?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : error?.message || String(error);
    throw new HttpError(`Network error: ${reason}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = await response.text().catch(() => "");
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const detail = parsed?.error?.message || parsed?.status_message || text.slice(0, 200);
    throw new HttpError(`HTTP ${response.status}: ${detail}`, { status: response.status, body: parsed });
  }
  if (parsed === null) throw new HttpError(`Unparseable response (HTTP ${response.status})`, { status: response.status });
  return parsed;
}

/** The registrable-ish host of a URL, without "www.". Empty for junk. */
function domainOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function defaultFetch() {
  return require("node-fetch");
}

module.exports = {
  TIMEZONE,
  nyDate,
  shiftYmd,
  daysBetween,
  round,
  sanitizeError,
  HttpError,
  fetchJson,
  domainOf,
  defaultFetch,
};
