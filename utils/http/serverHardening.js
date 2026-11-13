const express = require("express");
const { rateLimit } = require("../rateLimit");
const { clientIp } = require("../auth/clientIp");

/**
 * HTTP-level limits for server.js, kept here so they can be tested without
 * booting the whole server (which connects to MongoDB and starts every cron).
 */

/** Ordinary JSON and form bodies. Uploads are multipart (multer) and unaffected. */
const DEFAULT_BODY_LIMIT = "2mb";

/*
 * Routes that legitimately receive larger JSON. The public signing ceremony
 * posts the drawn signature as a PNG data URL; nativeSigning caps the decoded
 * image at 2 MB, which is about 2.7 MB as base64, so the parser allows 4 MB.
 */
const LARGE_JSON_ROUTES = [{ path: "/api/sign", limit: "4mb" }];

/** Production web origins, local development, and the QA hook. Never a wildcard. */
const BASE_CORS_ORIGINS = ["https://profixter.com", "https://www.profixter.com", "http://localhost:3000"];

function corsOrigins(env = process.env) {
  const extra = String(env.EXTRA_CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set([...extra, ...BASE_CORS_ORIGINS])];
}

function applyBodyParsers(app) {
  // A route-specific parser runs first; the global one then sees req._body and skips.
  for (const route of LARGE_JSON_ROUTES) {
    app.use(route.path, express.json({ limit: route.limit }));
  }
  app.use(
    express.json({
      limit: DEFAULT_BODY_LIMIT,
      verify: (req, _res, buf) => {
        if (req.originalUrl.includes("/api/stripe/webhook")) {
          req.rawBody = buf;
        }
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: DEFAULT_BODY_LIMIT }));
}

function isJsonBodyParseError(err) {
  return (
    err?.type === "entity.parse.failed" ||
    (err instanceof SyntaxError && err.status === 400 && Object.prototype.hasOwnProperty.call(err, "body"))
  );
}

/**
 * The final error handler. Client errors (4xx) keep their message because the
 * routes that throw them mean it for the user. Server errors are logged in full
 * and answered generically: an internal message can name a collection, a file
 * path or a provider response.
 */
function errorHandler(err, req, res, _next) {
  const status = Number(err?.statusCode || err?.status || 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;

  console.error("Server Error:", {
    method: req.method,
    path: req.originalUrl,
    statusCode: safeStatus,
    type: err?.type || null,
    message: err?.message || String(err),
    stack: err?.stack || null,
  });

  if (res.headersSent) return undefined;

  if (err?.type === "entity.too.large" || safeStatus === 413) {
    return res.status(413).json({ message: "Request body too large", code: "PAYLOAD_TOO_LARGE" });
  }
  if (isJsonBodyParseError(err)) {
    return res.status(400).json({ message: "Invalid JSON request body", code: "INVALID_JSON" });
  }
  if (safeStatus >= 500) {
    return res.status(safeStatus).json({ message: "Internal Server Error", code: "SERVER_ERROR" });
  }
  return res.status(safeStatus).json({ message: err?.expose === false ? "Request failed" : err?.message || "Request failed" });
}

/**
 * Per-IP ceiling for public lead forms. Each submission emails the owner, so a
 * script could otherwise flood the inbox. Deliberately loose: households and
 * carrier NAT share addresses, and a real person sends one or two.
 */
function publicLeadLimiter(name, { limit = 15, windowMs = 60 * 60 * 1000 } = {}) {
  return rateLimit({
    limit,
    windowMs,
    keyResolver: (req) => `${name}:${clientIp(req)}`,
    message: "Too many requests just now. Please try again later or call 631-599-1363.",
  });
}

module.exports = {
  DEFAULT_BODY_LIMIT,
  LARGE_JSON_ROUTES,
  corsOrigins,
  applyBodyParsers,
  errorHandler,
  isJsonBodyParseError,
  publicLeadLimiter,
};
