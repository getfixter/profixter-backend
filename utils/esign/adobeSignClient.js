/**
 * Adobe Acrobat Sign REST API v6 client.
 *
 * Implements only what ProFixter needs: upload a PDF, create an agreement,
 * read status, download the executed PDF and audit trail, and cancel.
 *
 * Auth: OAuth 2.0 refresh-token flow. A long-lived refresh token is held in
 * server-side config; access tokens live one hour and are cached in memory.
 * The API base URI is per-shard (na1/na2/eu1/jp1) and comes back with the
 * token, so it is never hard-coded.
 *
 * Nothing here logs tokens, secrets, or document bytes.
 */

const ADOBE_API_VERSION = "/api/rest/v6";

/** Token refresh paths, current first. See getAccessToken for why both exist. */
const REFRESH_PATHS = Object.freeze(["/oauth/v2/refresh", "/oauth/refresh"]);

/**
 * Error codes Adobe returns when the request reached the wrong shard.
 * Accounts and OAuth applications are shard-bound, so pointing
 * ADOBE_SIGN_TOKEN_HOST at the wrong region fails every call.
 */
const SHARD_MISMATCH_CODES = new Set([
  "INVALID_API_ACCESS_POINT",
  "MISDIRECTED_REQUEST",
]);

/** Adobe agreement status -> ProFixter ESignature status. */
const AGREEMENT_STATUS_MAP = Object.freeze({
  AUTHORING: "Draft",
  DOCUMENTS_NOT_YET_PROCESSED: "Sent",
  WAITING_FOR_FAXIN: "Sent",
  OUT_FOR_SIGNATURE: "Awaiting Signature",
  OUT_FOR_APPROVAL: "Awaiting Signature",
  OUT_FOR_ACCEPTANCE: "Awaiting Signature",
  OUT_FOR_FORM_FILLING: "Awaiting Signature",
  OUT_FOR_DELIVERY: "Awaiting Signature",
  WAITING_FOR_MY_SIGNATURE: "Partially Signed",
  WAITING_FOR_MY_APPROVAL: "Partially Signed",
  WAITING_FOR_MY_ACKNOWLEDGEMENT: "Partially Signed",
  WAITING_FOR_MY_ACCEPTANCE: "Partially Signed",
  WAITING_FOR_MY_FORM_FILLING: "Partially Signed",
  WAITING_FOR_MY_DELEGATION: "Partially Signed",
  SIGNED: "Completed",
  APPROVED: "Completed",
  ACCEPTED: "Completed",
  FORM_FILLED: "Completed",
  DELIVERED: "Completed",
  COMPLETED: "Completed",
  ARCHIVED: "Completed",
  ABORTED: "Declined",
  REJECTED: "Declined",
  RECALLED: "Cancelled",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
});

/**
 * Adobe webhook event -> normalized lifecycle event.
 * AGREEMENT_WORKFLOW_COMPLETED is the only event that means "fully executed";
 * AGREEMENT_ACTION_COMPLETED fires per signer and must not be treated as done.
 */
const WEBHOOK_EVENT_MAP = Object.freeze({
  AGREEMENT_CREATED: "created",
  AGREEMENT_ACTION_REQUESTED: "sent",
  AGREEMENT_EMAIL_VIEWED: "viewed",
  AGREEMENT_ACTION_COMPLETED: "signer_completed",
  AGREEMENT_WORKFLOW_COMPLETED: "completed",
  AGREEMENT_REJECTED: "declined",
  AGREEMENT_RECALLED: "cancelled",
  AGREEMENT_EXPIRED: "expired",
  AGREEMENT_EMAIL_BOUNCED: "delivery_failed",
  AGREEMENT_AUTO_CANCELLED_CONVERSION_PROBLEM: "cancelled",
});

class AdobeSignError extends Error {
  constructor(message, { status = 0, code = "", retryable = false } = {}) {
    super(message);
    this.name = "AdobeSignError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function config() {
  return {
    clientId: String(process.env.ADOBE_SIGN_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.ADOBE_SIGN_CLIENT_SECRET || "").trim(),
    refreshToken: String(process.env.ADOBE_SIGN_REFRESH_TOKEN || "").trim(),
    /**
     * Alternative to OAuth. An integration key is a long-lived bearer token
     * issued from Account Settings > Acrobat Sign API > API Information, on
     * accounts that expose Integration Keys but not API Applications. It grants
     * the same API surface; only the way the token is obtained differs.
     */
    integrationKey: String(process.env.ADOBE_SIGN_INTEGRATION_KEY || "").trim(),
    // Shard host used only to bootstrap; the authoritative base URI comes back
    // from the token response (OAuth) or from /baseUris (integration key).
    tokenHost: String(process.env.ADOBE_SIGN_TOKEN_HOST || "https://api.na1.adobesign.com").replace(/\/+$/, ""),
  };
}

/** Which credential style is in use, if any. */
function authMode() {
  const c = config();
  if (c.integrationKey) return "integration_key";
  if (c.clientId && c.clientSecret && c.refreshToken) return "oauth";
  return "";
}

/** True when enough configuration exists to attempt a live call. */
function isConfigured() {
  return authMode() !== "";
}

function assertConfigured() {
  if (!isConfigured()) {
    throw new AdobeSignError(
      "Adobe Acrobat Sign is not configured. Set ADOBE_SIGN_INTEGRATION_KEY, or " +
        "ADOBE_SIGN_CLIENT_ID, ADOBE_SIGN_CLIENT_SECRET and ADOBE_SIGN_REFRESH_TOKEN.",
      { code: "NOT_CONFIGURED" }
    );
  }
}

/* ------------------------------------------------------------------ */
/* Access token cache                                                  */
/* ------------------------------------------------------------------ */

let tokenCache = { accessToken: "", apiAccessPoint: "", expiresAt: 0 };

/** Exposed for tests; never call in production paths. */
function _resetTokenCache() {
  tokenCache = { accessToken: "", apiAccessPoint: "", expiresAt: 0 };
}

/**
 * Discover the account's API shard for an integration key.
 * Calling any other endpoint on the wrong shard returns an error telling you
 * to use the right one, so this is resolved once and cached.
 */
async function discoverBaseUri(bearerToken, tokenHost) {
  const res = await fetch(`${tokenHost}${ADOBE_API_VERSION}/baseUris`, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  if (!res.ok) {
    throw new AdobeSignError("Adobe Sign base URI lookup failed", {
      status: res.status,
      code: "BASE_URI_LOOKUP_FAILED",
      retryable: res.status >= 500 || res.status === 429,
    });
  }
  const json = await res.json();
  return String(json?.apiAccessPoint || tokenHost).replace(/\/+$/, "");
}

async function getAccessToken() {
  assertConfigured();

  // Refresh a minute early so a token cannot expire mid-request.
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache;
  }

  const c = config();

  if (authMode() === "integration_key") {
    // An integration key does not expire on a schedule. It is cached for an
    // hour purely to avoid repeating the shard lookup on every request.
    const apiAccessPoint = await discoverBaseUri(c.integrationKey, c.tokenHost);
    tokenCache = {
      accessToken: c.integrationKey,
      apiAccessPoint,
      expiresAt: Date.now() + 3600 * 1000,
    };
    return tokenCache;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: c.refreshToken,
  });

  // Adobe's documentation is inconsistent about whether the current refresh
  // path is /oauth/v2/refresh or the older /oauth/refresh. Try v6 first and
  // fall back only on 404, so a doc discrepancy cannot strand a live token
  // refresh. Any other status is a real failure and is surfaced immediately.
  let res = null;
  for (const path of REFRESH_PATHS) {
    res = await fetch(`${c.tokenHost}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (res.ok || res.status !== 404) break;
  }

  if (!res.ok) {
    // Deliberately does not echo the response body: it can contain token material.
    throw new AdobeSignError("Adobe Sign token refresh failed", {
      status: res.status,
      code: "TOKEN_REFRESH_FAILED",
      retryable: res.status >= 500 || res.status === 429,
    });
  }

  const json = await res.json();
  const accessToken = json?.access_token;
  if (!accessToken) {
    throw new AdobeSignError("Adobe Sign token response contained no access token", {
      code: "TOKEN_MISSING",
    });
  }

  tokenCache = {
    accessToken,
    apiAccessPoint: String(json.api_access_point || c.tokenHost).replace(/\/+$/, ""),
    expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
  };
  return tokenCache;
}

/* ------------------------------------------------------------------ */
/* Request helper                                                      */
/* ------------------------------------------------------------------ */

async function request(path, { method = "GET", json, body, headers = {}, raw = false } = {}) {
  const { accessToken, apiAccessPoint } = await getAccessToken();
  const url = `${apiAccessPoint}${ADOBE_API_VERSION}${path}`;

  const finalHeaders = { Authorization: `Bearer ${accessToken}`, ...headers };
  let payload = body;
  if (json !== undefined) {
    finalHeaders["Content-Type"] = "application/json";
    payload = JSON.stringify(json);
  }

  const res = await fetch(url, { method, headers: finalHeaders, body: payload });

  if (!res.ok) {
    let code = "";
    try {
      const err = await res.json();
      code = String(err?.code || "");
    } catch {
      /* non-JSON error body; status is enough */
    }
    // A wrong-shard host is otherwise a baffling generic failure, so name it.
    if (SHARD_MISMATCH_CODES.has(code)) {
      throw new AdobeSignError(
        `Adobe Sign rejected ${apiAccessPoint} as the wrong API host for this account. ` +
          "Set ADOBE_SIGN_TOKEN_HOST to the account's own shard.",
        { status: res.status, code, retryable: false }
      );
    }
    throw new AdobeSignError(`Adobe Sign request failed (${method} ${path})`, {
      status: res.status,
      code,
      retryable: res.status >= 500 || res.status === 429,
    });
  }

  if (raw) return Buffer.from(await res.arrayBuffer());
  if (res.status === 204) return null;
  return res.json();
}

/* ------------------------------------------------------------------ */
/* API surface                                                         */
/* ------------------------------------------------------------------ */

/**
 * Upload a PDF as a transient document. Adobe keeps it briefly; it must be
 * referenced by an agreement soon after upload.
 */
async function uploadTransientDocument({ buffer, fileName }) {
  const form = new FormData();
  form.append(
    "File",
    new Blob([buffer], { type: "application/pdf" }),
    fileName || "document.pdf"
  );
  form.append("File-Name", fileName || "document.pdf");

  const json = await request("/transientDocuments", { method: "POST", body: form });
  if (!json?.transientDocumentId) {
    throw new AdobeSignError("Adobe Sign did not return a transient document id", {
      code: "NO_TRANSIENT_ID",
    });
  }
  return json.transientDocumentId;
}

/**
 * Create and send an agreement.
 *
 * `signers` is [{ email, role, order }]. Distinct order values produce
 * sequential signing; equal values sign in parallel.
 */
async function createAgreement({ name, transientDocumentId, signers, message, inPerson = false }) {
  const participantSetsInfo = signers.map((signer) => ({
    memberInfos: [{ email: signer.email }],
    order: Number(signer.order || 1),
    role: "SIGNER",
  }));

  const json = await request("/agreements", {
    method: "POST",
    json: {
      fileInfos: [{ transientDocumentId }],
      name,
      participantSetsInfo,
      signatureType: "ESIGN",
      state: "IN_PROCESS",
      ...(message ? { message } : {}),
      // In-person signing happens on the admin's device, so the "please sign"
      // email would be noise. Completion emails are left on: the customer
      // still receives their executed copy.
      ...(inPerson
        ? { emailOption: { sendOptions: { initEmails: "NONE", inFlightEmails: "NONE", completionEmails: "ALL" } } }
        : {}),
    },
  });

  if (!json?.id) {
    throw new AdobeSignError("Adobe Sign did not return an agreement id", {
      code: "NO_AGREEMENT_ID",
    });
  }
  return json.id;
}

/**
 * The account's API and web base URIs, per Adobe.
 * Read-only and side-effect free: the cheapest way to prove a credential works
 * and to confirm which shard the account actually lives on.
 */
async function getBaseUris() {
  return request("/baseUris");
}

/**
 * Signing URLs for the participants who still have to act.
 *
 * This is what makes in-person signing legitimate rather than a local drawing
 * pad: the customer signs inside Adobe's own hosted ceremony on the admin's
 * phone, so the agreement is executed, audited and stored by Adobe exactly as
 * it would be for a remote signer.
 */
async function getSigningUrls(agreementId) {
  const json = await request(`/agreements/${encodeURIComponent(agreementId)}/signingUrls`);
  const sets = json?.signingUrlSetInfos || [];
  const urls = [];
  for (const set of Array.isArray(sets) ? sets : []) {
    for (const entry of set?.signingUrls || []) {
      if (entry?.esignUrl) {
        urls.push({ email: String(entry.email || "").toLowerCase(), url: entry.esignUrl });
      }
    }
  }
  return urls;
}

async function getAgreement(agreementId) {
  return request(`/agreements/${encodeURIComponent(agreementId)}`);
}

/** Per-participant state, used to record who signed and when. */
async function getAgreementMembers(agreementId) {
  return request(`/agreements/${encodeURIComponent(agreementId)}/members`);
}

/** The flattened, fully executed PDF including signatures. */
async function getCombinedDocument(agreementId) {
  return request(`/agreements/${encodeURIComponent(agreementId)}/combinedDocument`, {
    raw: true,
    headers: { Accept: "application/pdf" },
  });
}

/** The signature certificate / audit trail PDF. */
async function getAuditTrail(agreementId) {
  return request(`/agreements/${encodeURIComponent(agreementId)}/auditTrail`, {
    raw: true,
    headers: { Accept: "application/pdf" },
  });
}

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

/**
 * Every webhook visible to this application.
 * Adobe has used more than one envelope key for this list over the API's life,
 * so all the known shapes are accepted rather than assuming one.
 */
async function listWebhooks() {
  const json = await request("/webhooks");
  const list =
    json?.userWebhookList || json?.webhookList || json?.webhooks || json?.items || [];
  return Array.isArray(list) ? list : [];
}

async function getWebhook(webhookId) {
  return request(`/webhooks/${encodeURIComponent(webhookId)}`);
}

/**
 * Register a webhook. The client id Adobe later echoes in
 * X-AdobeSign-ClientId is the id of the application making THIS call, which is
 * why registration belongs here and not in the Acrobat Sign web UI.
 */
async function createWebhook({ name, url, scope = "ACCOUNT", events, state = "ACTIVE" }) {
  const json = await request("/webhooks", {
    method: "POST",
    json: {
      name,
      scope,
      state,
      webhookUrlInfo: { url },
      webhookSubscriptionEvents: events,
    },
  });
  if (!json?.id) {
    throw new AdobeSignError("Adobe Sign did not return a webhook id", { code: "NO_WEBHOOK_ID" });
  }
  return json.id;
}

/** Replace a webhook's subscription. Used when the event set drifts. */
async function updateWebhook(webhookId, { name, url, scope = "ACCOUNT", events, state = "ACTIVE" }) {
  return request(`/webhooks/${encodeURIComponent(webhookId)}`, {
    method: "PUT",
    json: {
      name,
      scope,
      state,
      webhookUrlInfo: { url },
      webhookSubscriptionEvents: events,
    },
  });
}

async function setWebhookState(webhookId, state) {
  return request(`/webhooks/${encodeURIComponent(webhookId)}/state`, {
    method: "PUT",
    json: { state },
  });
}

/** Recall an agreement that is still out for signature. */
async function cancelAgreement(agreementId, reason = "Cancelled by Premium Island Homes Inc.") {
  return request(`/agreements/${encodeURIComponent(agreementId)}/state`, {
    method: "PUT",
    json: { state: "CANCELLED", agreementCancellationInfo: { comment: reason, notifySigner: true } },
  });
}

/* ------------------------------------------------------------------ */
/* Mapping                                                             */
/* ------------------------------------------------------------------ */

function mapAgreementStatus(providerStatus) {
  return AGREEMENT_STATUS_MAP[String(providerStatus || "").toUpperCase()] || "Sent";
}

function mapWebhookEvent(eventType) {
  return WEBHOOK_EVENT_MAP[String(eventType || "").toUpperCase()] || null;
}

module.exports = {
  AdobeSignError,
  AGREEMENT_STATUS_MAP,
  WEBHOOK_EVENT_MAP,
  authMode,
  isConfigured,
  getAccessToken,
  uploadTransientDocument,
  createAgreement,
  getBaseUris,
  getAgreement,
  getSigningUrls,
  getAgreementMembers,
  getCombinedDocument,
  getAuditTrail,
  cancelAgreement,
  listWebhooks,
  getWebhook,
  createWebhook,
  updateWebhook,
  setWebhookState,
  mapAgreementStatus,
  mapWebhookEvent,
  _resetTokenCache,
};
