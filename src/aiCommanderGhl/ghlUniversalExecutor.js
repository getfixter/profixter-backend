const mongoose = require("mongoose");

const { getLocationId, request, redact } = require("./ghlClient");
const GhlUniversalAudit = require("./ghlUniversalAudit.model");
const {
  DESTRUCTIVE_CONFIRMATION_PHRASE,
  findEndpoint,
  normalizePath,
} = require("./ghlEndpointRegistry");

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_RETRIES = 5;

function cleanString(value) {
  return String(value ?? "").trim();
}

function asPlainObject(value, fieldName) {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    const error = new Error(`${fieldName} must be an object.`);
    error.statusCode = 400;
    throw error;
  }
  return { ...value };
}

function methodIsWrite(method) {
  return WRITE_METHODS.has(cleanString(method).toUpperCase());
}

function getRetryCount() {
  const retries = Number(process.env.JARVIS_GHL_UNIVERSAL_RETRIES);
  if (Number.isFinite(retries) && retries >= 0 && retries <= 10) return retries;
  return DEFAULT_RETRIES;
}

function getTimeoutMs() {
  const timeoutMs = Number(process.env.JARVIS_GHL_UNIVERSAL_TIMEOUT_MS);
  if (Number.isFinite(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 300000) {
    return timeoutMs;
  }
  return DEFAULT_TIMEOUT_MS;
}

function assertSupportedApiVersion() {
  const version = cleanString(process.env.AI_COMMANDER_GHL_API_VERSION || "v3").toLowerCase();
  if (!["v2", "v3"].includes(version)) {
    const error = new Error("Jarvis universal GHL executor only allows current v2/v3 API versions.");
    error.statusCode = 500;
    throw error;
  }
}

function ensureConfiguredLocation(locationId) {
  const configuredLocationId = getLocationId();
  const requestedLocationId = cleanString(locationId) || configuredLocationId;
  if (requestedLocationId !== configuredLocationId) {
    const error = new Error("Requested GHL location does not match the configured admin location.");
    error.statusCode = 403;
    throw error;
  }
  return configuredLocationId;
}

function fillLocationPlaceholders(path, locationId) {
  return cleanString(path)
    .replace(/(^|\/):locationId(?=\/|$)/g, `$1${encodeURIComponent(locationId)}`)
    .replace(/(^|\/)\{locationId\}(?=\/|$)/g, `$1${encodeURIComponent(locationId)}`);
}

function validateEndpoint({ method, path, locationId }) {
  const configuredLocationId = ensureConfiguredLocation(locationId);
  const cleanPath = normalizePath(fillLocationPlaceholders(path, configuredLocationId));
  const match = findEndpoint({ method, path: cleanPath });
  if (!match) {
    const error = new Error("This GHL endpoint is not in Jarvis's allowed endpoint registry.");
    error.statusCode = 422;
    throw error;
  }

  const endpoint = match.endpoint;
  if (!endpoint.enabled || endpoint.deprecated) {
    const error = new Error("This GHL endpoint is disabled or deprecated in Jarvis.");
    error.statusCode = 422;
    throw error;
  }

  if (match.params?.locationId && match.params.locationId !== configuredLocationId) {
    const error = new Error("Requested GHL location does not match the configured admin location.");
    error.statusCode = 403;
    throw error;
  }

  return { endpoint, params: match.params || {}, path: cleanPath, locationId: configuredLocationId };
}

function injectLocation({ endpoint, method, query, body, locationId }) {
  const upperMethod = cleanString(method).toUpperCase();
  if (!endpoint.requiresLocationId) {
    return { query, body };
  }

  const locationParam = endpoint.locationParam || "locationId";
  if (upperMethod === "GET" || upperMethod === "HEAD") {
    const nextQuery = { ...query };
    if (!nextQuery.locationId && !nextQuery.location_id && !nextQuery[locationParam]) {
      nextQuery[locationParam] = locationId;
    }
    return { query: nextQuery, body };
  }

  const nextBody = { ...body };
  if (!nextBody.locationId && !nextBody.location_id && !nextBody[locationParam]) {
    nextBody[locationParam] = locationId;
  }
  return { query, body: nextBody };
}

function requiresExtraConfirmation({ endpoint, body }) {
  if (endpoint.requiresExtraConfirmation || endpoint.destructive) return true;
  const bodyText = JSON.stringify(body || {});
  if (endpoint.group === "conversations" && /\b(bulk|blast|all|email|sms)\b/i.test(bodyText)) {
    return true;
  }
  return false;
}

function makeSummary({ endpoint, method, path, dryRun, status }) {
  const verb = dryRun ? "would call" : "called";
  const statusText = status ? ` GHL returned ${status}.` : "";
  return `Jarvis ${verb} ${method} ${path} for ${endpoint.description}${statusText}`;
}

function auditConnected() {
  return mongoose.connection?.readyState === 1;
}

async function writeAudit(record) {
  if (!auditConnected()) return;
  try {
    await GhlUniversalAudit.create({
      ...record,
      query: redact(record.query),
      body: redact(record.body),
      error: redact(record.error),
      responseSummary: redact(record.responseSummary),
    });
  } catch (error) {
    console.warn("GHL universal audit write failed:", {
      message: cleanString(error?.message || error),
    });
  }
}

async function requestWithRetry(requestShape) {
  return request({
    ...requestShape,
    timeoutMs: requestShape.timeoutMs || getTimeoutMs(),
    logResponseBody: false,
    retryCount: getRetryCount(),
  });
}

async function executeGhlRequest({
  method,
  path,
  query,
  body,
  locationId,
  reason,
  dryRun = false,
  approved = false,
  confirmationPhrase = "",
  adminUserId = null,
  userRequest = "",
} = {}) {
  assertSupportedApiVersion();
  const upperMethod = cleanString(method || "GET").toUpperCase();
  const initialQuery = asPlainObject(query, "query");
  const initialBody = asPlainObject(body, "body");
  const { endpoint, path: cleanPath, locationId: configuredLocationId } = validateEndpoint({
    method: upperMethod,
    path,
    locationId,
  });
  const write = methodIsWrite(upperMethod) && endpoint.readOnly !== true;
  const sendsBody = !["GET", "HEAD"].includes(upperMethod);
  const extraConfirmationRequired = requiresExtraConfirmation({
    endpoint,
    body: initialBody,
  });

  const { query: finalQuery, body: finalBody } = injectLocation({
    endpoint,
    method: upperMethod,
    query: initialQuery,
    body: initialBody,
    locationId: configuredLocationId,
  });
  const requestShape = {
    method: upperMethod,
    path: cleanPath,
    query: finalQuery,
    body: sendsBody ? finalBody : undefined,
  };

  const baseAudit = {
    adminUserId,
    userRequest,
    reason,
    method: upperMethod,
    path: cleanPath,
    endpointKey: endpoint.key,
    locationId: configuredLocationId,
    query: finalQuery,
    body: sendsBody ? finalBody : null,
    dryRun: dryRun === true,
    approved: approved === true,
    requiresExtraConfirmation: extraConfirmationRequired,
  };

  try {
    if (write && !approved && dryRun !== true) {
      const error = new Error("GHL write requests require Jarvis approval before execution.");
      error.statusCode = 403;
      throw error;
    }

    if (
      write &&
      extraConfirmationRequired &&
      dryRun !== true &&
      cleanString(confirmationPhrase) !== DESTRUCTIVE_CONFIRMATION_PHRASE
    ) {
      const error = new Error(
        `This high-risk GHL request requires the exact confirmation phrase: ${DESTRUCTIVE_CONFIRMATION_PHRASE}`
      );
      error.statusCode = 403;
      throw error;
    }

    if (dryRun === true) {
      const summary = makeSummary({
        endpoint,
        method: upperMethod,
        path: cleanPath,
        dryRun: true,
      });
      const dryRunResult = {
        dryRun: true,
        endpointKey: endpoint.key,
        method: upperMethod,
        path: cleanPath,
        query: redact(finalQuery),
        body: sendsBody ? redact(finalBody) : null,
        riskLevel: endpoint.riskLevel,
        destructive: endpoint.destructive,
        requiresApproval: write,
        requiresExtraConfirmation: extraConfirmationRequired,
        confirmationPhraseRequired: extraConfirmationRequired
          ? DESTRUCTIVE_CONFIRMATION_PHRASE
          : "",
        summary,
      };
      await writeAudit({
        ...baseAudit,
        status: "dry_run",
        responseSummary: dryRunResult,
      });
      return dryRunResult;
    }

    const result = await requestWithRetry(requestShape);
    const response = redact(result.data);
    const summary = makeSummary({
      endpoint,
      method: upperMethod,
      path: cleanPath,
      dryRun: false,
      status: result.status,
    });
    await writeAudit({
      ...baseAudit,
      status: "executed",
      resultStatus: result.status,
      responseSummary: {
        ok: true,
        status: result.status,
        rateLimit: result.rateLimit || {},
      },
    });
    return {
      dryRun: false,
      endpointKey: endpoint.key,
      method: upperMethod,
      path: cleanPath,
      query: redact(finalQuery),
      body: sendsBody ? redact(finalBody) : null,
      status: result.status,
      response,
      request: result.request,
      rateLimit: result.rateLimit || {},
      attempts: result.attempts || 1,
      summary,
      riskLevel: endpoint.riskLevel,
      destructive: endpoint.destructive,
      requiresApproval: write,
      requiresExtraConfirmation: extraConfirmationRequired,
    };
  } catch (error) {
    await writeAudit({
      ...baseAudit,
      status: error.statusCode === 403 || error.statusCode === 422 ? "rejected" : "failed",
      resultStatus: error.ghlStatus || null,
      error: {
        message: cleanString(error?.message || error),
        statusCode: error.statusCode || null,
        ghlStatus: error.ghlStatus || null,
        request: error.request || null,
        response: error.response || null,
      },
    });
    throw error;
  }
}

module.exports = {
  executeGhlRequest,
  methodIsWrite,
};
