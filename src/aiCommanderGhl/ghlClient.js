const fetch = require("node-fetch");

const BASE_URL = "https://services.leadconnectorhq.com";
const DEFAULT_GHL_VERSION = "v3";

class GhlApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "GhlApiError";
    this.statusCode = details.statusCode || 502;
    this.ghlStatus = details.ghlStatus || null;
    this.response = details.response || null;
    this.request = details.request || null;
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

async function request({ method, path, query, body, timeoutMs }) {
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
    body: requestShape.body,
  });

  const response = await fetch(url.toString(), {
    method: upperMethod,
    headers,
    body: ["GET", "HEAD"].includes(upperMethod)
      ? undefined
      : JSON.stringify(body || {}),
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  const result = {
    ok: response.ok,
    status: response.status,
    data,
    request: redact(requestShape),
    responseBody: data,
    rateLimit: {
      dailyLimit: response.headers.get("x-ratelimit-limit-daily") || "",
      dailyRemaining: response.headers.get("x-ratelimit-daily-remaining") || "",
      intervalMs: response.headers.get("x-ratelimit-interval-milliseconds") || "",
      intervalLimit: response.headers.get("x-ratelimit-max") || "",
      intervalRemaining: response.headers.get("x-ratelimit-remaining") || "",
    },
  };

  console.info("GHL AI Commander response diagnostics:", {
    status: response.status,
    body: data,
  });

  if (!response.ok) {
    console.error("GHL AI Commander API request failed:", {
      status: response.status,
      request: result.request,
      responseBody: data,
    });
    throw new GhlApiError(`GHL API request failed with ${response.status}`, {
      statusCode: 502,
      ghlStatus: response.status,
      response: data,
      request: result.request,
    });
  }

  return result;
}

module.exports = {
  GhlApiError,
  getLocationId,
  request,
  redact,
};
