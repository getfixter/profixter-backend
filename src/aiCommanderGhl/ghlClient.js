const fetch = require("node-fetch");

const BASE_URL = "https://services.leadconnectorhq.com";
const DEFAULT_GHL_VERSION = "v3";
const DEFAULT_RETRIES = 5;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_RETRY_MAX_MS = 30000;

class GhlApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "GhlApiError";
    this.statusCode = details.statusCode || 502;
    this.ghlStatus = details.ghlStatus || null;
    this.response = details.response || null;
    this.request = details.request || null;
    this.rateLimit = details.rateLimit || null;
    this.retryAfterMs = Number.isFinite(details.retryAfterMs) ? details.retryAfterMs : null;
  }
}

function getLocationId() {
  const locationId = String(process.env.GHL_LOCATION_ID || "").trim();
  if (!locationId) {
    throw new GhlApiError("Missing GHL_LOCATION_ID", { statusCode: 500 });
  }
  return locationId;
}

function getAccessToken() {
  const token = String(process.env.GHL_AI_COMMANDER_TOKEN || "").trim();
  if (!token) {
    throw new GhlApiError("Missing GHL_AI_COMMANDER_TOKEN", { statusCode: 500 });
  }
  return token;
}

function getTokenDiagnostics() {
  const commanderToken = String(process.env.GHL_AI_COMMANDER_TOKEN || "").trim();
  const legacyToken = String(process.env.GHL_API_TOKEN || "").trim();
  return {
    source: commanderToken ? "GHL_AI_COMMANDER_TOKEN" : "",
    length: commanderToken.length,
    hasLegacyGhlApiToken: !!legacyToken,
    legacyLength: legacyToken.length,
    token: commanderToken,
  };
}

function redactSecretString(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(
      /("(?:authorization|x-auth-token|api[-_]?key|secret|token|jwt|password|access[-_]?token|refresh[-_]?token)"\s*:\s*")[^"]+(")/gi,
      "$1[REDACTED]$2"
    )
    .replace(
      /((?:api[-_]?key|token|secret|jwt|access[-_]?token|refresh[-_]?token)=)[^&\s"']+/gi,
      "$1[REDACTED]"
    );
}

function getSafeTokenDiagnostics() {
  const tokenInfo = getTokenDiagnostics();
  return {
    source: tokenInfo.source || "missing",
    hasToken: !!tokenInfo.token,
    length: tokenInfo.length,
    hasLegacyGhlApiToken: tokenInfo.hasLegacyGhlApiToken,
    legacyLength: tokenInfo.legacyLength,
    apiVersion: String(
      process.env.AI_COMMANDER_GHL_API_VERSION || DEFAULT_GHL_VERSION
    ).trim(),
  };
}

function getSafeGhlDiagnostics() {
  const token = getSafeTokenDiagnostics();
  const locationId = String(process.env.GHL_LOCATION_ID || "").trim();
  return {
    baseUrl: BASE_URL,
    apiVersion: token.apiVersion,
    locationIdUsed: locationId || null,
    token,
  };
}

function getHeaders(token = getAccessToken()) {
  return {
    Authorization: `Bearer ${token}`,
    Version: String(
      process.env.AI_COMMANDER_GHL_API_VERSION || DEFAULT_GHL_VERSION
    ).trim(),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function redactHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [
      key,
      /^authorization$/i.test(key) ? "[REDACTED]" : value,
    ])
  );
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "string") return redactSecretString(value);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (/authorization|token|secret|api[_-]?key/i.test(key)) {
        return [key, "[REDACTED]"];
      }
      return [key, redact(item)];
    })
  );
}

function buildUrl(path, query = {}) {
  const cleanPath = String(path || "").startsWith("/")
    ? String(path)
    : `/${path || ""}`;
  const url = new URL(`${BASE_URL}${cleanPath}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && String(value) !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (Number.isFinite(number) && number >= min && number <= max) return number;
  return fallback;
}

function getDefaultRetryCount() {
  return boundedNumber(
    process.env.JARVIS_GHL_MAX_RETRIES || process.env.JARVIS_GHL_RETRIES,
    DEFAULT_RETRIES,
    0,
    10
  );
}

function parseRetryAfter(value) {
  const clean = String(value || "").trim();
  if (!clean) return null;
  const seconds = Number(clean);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(clean);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function retryDelayMs(error, attempt, options = {}) {
  const retryAfterMs = Number(error?.retryAfterMs);
  const maxMs = boundedNumber(
    options.retryMaxMs ?? process.env.JARVIS_GHL_RETRY_MAX_MS,
    DEFAULT_RETRY_MAX_MS,
    0,
    120000
  );
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(maxMs, retryAfterMs);
  }

  const baseMs = boundedNumber(
    options.retryBaseMs ?? process.env.JARVIS_GHL_RETRY_BASE_MS,
    DEFAULT_RETRY_BASE_MS,
    0,
    60000
  );
  const jitterMax = Math.max(0, Math.min(250, baseMs));
  const jitter = jitterMax ? Math.floor(Math.random() * (jitterMax + 1)) : 0;
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt) + jitter);
}

function shouldRetryError(error) {
  const status = Number(error?.ghlStatus || error?.status || 0);
  if (status === 429 || status >= 500) return true;
  return /timeout|timed out|etimedout|socket hang up|econnreset|network/i.test(
    String(error?.message || error?.type || "")
  );
}

async function requestOnce({ method, path, query, body, timeoutMs, logResponseBody = true }) {
  const upperMethod = String(method || "GET").toUpperCase();
  const url = buildUrl(path, query);
  const tokenInfo = getTokenDiagnostics();
  if (!tokenInfo.token) {
    console.error("GHL AI Commander token configuration:", {
      using: "GHL_AI_COMMANDER_TOKEN",
      length: 0,
      hasGhlApiToken: tokenInfo.hasLegacyGhlApiToken,
      ghlApiTokenLength: tokenInfo.legacyLength,
      fallbackToGhlApiToken: false,
    });
    throw new GhlApiError("Missing GHL_AI_COMMANDER_TOKEN", { statusCode: 500 });
  }
  const headers = getHeaders(tokenInfo.token);
  const requestShape = {
    method: upperMethod,
    url: `${url.origin}${url.pathname}${url.search}`,
    baseUrl: BASE_URL,
    endpoint: `${upperMethod} ${url.pathname}${url.search}`,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: redactHeaders(headers),
    body: body || null,
  };

  console.info("GHL AI Commander request diagnostics:", {
    token: `Using GHL_AI_COMMANDER_TOKEN (length=${tokenInfo.length})`,
    fallbackToGhlApiToken: false,
    hasGhlApiToken: tokenInfo.hasLegacyGhlApiToken,
    baseUrl: BASE_URL,
    endpoint: requestShape.endpoint,
    url: requestShape.url,
    headers: requestShape.headers,
    body: redact(requestShape.body),
  });

  let response;
  try {
    response = await fetch(url.toString(), {
      method: upperMethod,
      headers,
      body: ["GET", "HEAD"].includes(upperMethod)
        ? undefined
        : JSON.stringify(body || {}),
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    });
  } catch (error) {
    throw new GhlApiError(error?.message || "GHL request failed", {
      statusCode: 502,
      request: requestShape,
    });
  }

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  const retryAfter = response.headers.get("retry-after") || "";
  const retryAfterMs = parseRetryAfter(retryAfter);
  const rateLimit = {
    dailyLimit: response.headers.get("x-ratelimit-limit-daily") || "",
    dailyRemaining: response.headers.get("x-ratelimit-daily-remaining") || "",
    intervalMs: response.headers.get("x-ratelimit-interval-milliseconds") || "",
    intervalLimit: response.headers.get("x-ratelimit-max") || "",
    intervalRemaining: response.headers.get("x-ratelimit-remaining") || "",
    retryAfter,
    retryAfterMs,
  };

  const result = {
    ok: response.ok,
    status: response.status,
    data,
    request: redact(requestShape),
    responseBody: redact(data),
    rateLimit,
  };

  console.info("GHL AI Commander response diagnostics:", {
    status: response.status,
    body: logResponseBody ? redact(data) : "[REDACTED_RESPONSE_BODY]",
  });

  if (!response.ok) {
    console.error("GHL AI Commander API request failed:", {
      status: response.status,
      request: result.request,
      responseBody: logResponseBody ? redact(data) : "[REDACTED_RESPONSE_BODY]",
    });
    throw new GhlApiError(`GHL API request failed with ${response.status}`, {
      statusCode: 502,
      ghlStatus: response.status,
      response: redact(data),
      request: result.request,
      rateLimit,
      retryAfterMs,
    });
  }

  return result;
}

async function request({
  retryCount,
  retryBaseMs,
  retryMaxMs,
  ...requestShape
}) {
  const maxRetries = boundedNumber(retryCount, getDefaultRetryCount(), 0, 10);
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const result = await requestOnce(requestShape);
      return {
        ...result,
        attempts: attempt + 1,
      };
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !shouldRetryError(error)) break;
      const delayMs = retryDelayMs(error, attempt, { retryBaseMs, retryMaxMs });
      console.warn("GHL AI Commander retrying request", {
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        statusCode: error?.statusCode || null,
        ghlStatus: error?.ghlStatus || null,
        retryAfterMs: error?.retryAfterMs || null,
        request: redact(error?.request || null),
      });
      if (delayMs > 0) await wait(delayMs);
    }
  }

  throw lastError;
}

module.exports = {
  BASE_URL,
  GhlApiError,
  getLocationId,
  getSafeGhlDiagnostics,
  getSafeTokenDiagnostics,
  request,
  parseRetryAfter,
  redact,
  redactSecretString,
  retryDelayMs,
  shouldRetryError,
};
