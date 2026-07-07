const fetch = require("node-fetch");

const BASE_URL = "https://services.leadconnectorhq.com";
const DEFAULT_GHL_VERSION = "2021-07-28";

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
  const token = String(process.env.GHL_API_TOKEN || "").trim();
  if (!token) {
    throw new GhlApiError("Missing GHL_API_TOKEN", { statusCode: 500 });
  }
  return token;
}

function getHeaders() {
  return {
    Authorization: `Bearer ${getAccessToken()}`,
    Version: String(process.env.GHL_API_VERSION || DEFAULT_GHL_VERSION).trim(),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
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

async function request({ method, path, query, body }) {
  const upperMethod = String(method || "GET").toUpperCase();
  const url = buildUrl(path, query);
  const requestShape = {
    method: upperMethod,
    url: `${url.origin}${url.pathname}${url.search}`,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    body: body || null,
  };

  const response = await fetch(url.toString(), {
    method: upperMethod,
    headers: getHeaders(),
    body: ["GET", "HEAD"].includes(upperMethod)
      ? undefined
      : JSON.stringify(body || {}),
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
    rateLimit: {
      dailyLimit: response.headers.get("x-ratelimit-limit-daily") || "",
      dailyRemaining: response.headers.get("x-ratelimit-daily-remaining") || "",
      intervalMs: response.headers.get("x-ratelimit-interval-milliseconds") || "",
      intervalLimit: response.headers.get("x-ratelimit-max") || "",
      intervalRemaining: response.headers.get("x-ratelimit-remaining") || "",
    },
  };

  if (!response.ok) {
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
