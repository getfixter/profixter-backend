/**
 * E-signature provisioning.
 *
 * Registering the webhook is treated as part of bringing the service up, not a
 * manual errand: on boot the server confirms it can authenticate, then makes
 * sure its webhook exists, is subscribed to the right events, and is ACTIVE.
 * If someone deletes the webhook in the Adobe console, the next deploy puts it
 * back.
 *
 * Registering through the API (rather than the Acrobat Sign web UI) is also
 * what makes verification predictable: Adobe echoes the client id of the
 * application that CREATED the webhook, so creating it with our own OAuth
 * application means the value the endpoint must expect is our own client id.
 *
 * Everything here is best-effort and never blocks or crashes startup, and
 * nothing it logs contains a token or secret.
 */

const ESignWebhook = require("../../models/ESignWebhook");
const adobe = require("./adobeSignClient");

/** Events ProFixter acts on. Order is irrelevant; the set is compared. */
const WEBHOOK_EVENTS = Object.freeze([
  "AGREEMENT_CREATED",
  "AGREEMENT_ACTION_REQUESTED",
  "AGREEMENT_EMAIL_VIEWED",
  "AGREEMENT_ACTION_COMPLETED",
  "AGREEMENT_WORKFLOW_COMPLETED",
  "AGREEMENT_REJECTED",
  "AGREEMENT_RECALLED",
  "AGREEMENT_EXPIRED",
]);

const WEBHOOK_NAME = "ProFixter";
const WEBHOOK_PATH = "/api/esign/webhook/adobe-sign";

/** A provisioning attempt older than this is assumed dead and may be retried. */
const STALE_LOCK_MS = 5 * 60 * 1000;

/** Registration is retried: Adobe calls us back, and we may not be routable yet. */
const PROVISION_ATTEMPTS = 4;
const PROVISION_RETRY_MS = 20_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function publicBaseUrl() {
  return String(process.env.PUBLIC_API_BASE_URL || "").trim().replace(/\/+$/, "");
}

function webhookUrl() {
  const base = publicBaseUrl();
  return base ? `${base}${WEBHOOK_PATH}` : "";
}

/** Auto-provisioning is on whenever it can work; set the flag to "false" to stop it. */
function autoProvisionEnabled() {
  return String(process.env.ESIGN_WEBHOOK_AUTO_PROVISION || "true").toLowerCase() !== "false";
}

/**
 * Read a webhook's ACTIVE/INACTIVE value.
 *
 * Adobe is asymmetric here: requests carry the value as `state`, responses
 * return it as `status`. Reading `state` off a response silently yields
 * undefined, so both are accepted and `status` is preferred.
 */
function webhookStatus(hook) {
  return String(hook?.status || hook?.state || "").toUpperCase();
}

/** Trailing slashes and case in the host must not read as a different webhook. */
function sameUrl(a, b) {
  const normalize = (value) => String(value || "").trim().replace(/\/+$/, "").toLowerCase();
  return normalize(a) === normalize(b) && normalize(a) !== "";
}

function sameEvents(a, b) {
  const left = [...new Set((a || []).map(String))].sort();
  const right = [...new Set((b || []).map(String))].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/* ------------------------------------------------------------------ */
/* Connectivity                                                        */
/* ------------------------------------------------------------------ */

/**
 * Prove this environment can authenticate and reach the API.
 * Read-only: a token refresh and GET /baseUris, nothing else.
 */
async function checkConnectivity() {
  if (!adobe.isConfigured()) {
    return { ok: false, reason: "not_configured", authMode: "" };
  }

  const token = await adobe.getAccessToken();
  const baseUris = await adobe.getBaseUris();
  const apiAccessPoint = String(baseUris?.apiAccessPoint || "").replace(/\/+$/, "");
  const shardMatch = apiAccessPoint.match(/(?:^|\/\/|\.)([a-z]{2,4}\d{1,2})\.adobesign\.com/i);
  const configuredHost = String(process.env.ADOBE_SIGN_TOKEN_HOST || "").replace(/\/+$/, "");

  return {
    ok: true,
    authMode: adobe.authMode(),
    // Length only. The token itself is never returned or logged.
    accessTokenLength: String(token?.accessToken || "").length,
    apiAccessPoint,
    webAccessPoint: String(baseUris?.webAccessPoint || "").replace(/\/+$/, ""),
    shard: shardMatch ? shardMatch[1].toLowerCase() : "",
    tokenHostCorrect: Boolean(apiAccessPoint) && configuredHost === apiAccessPoint,
  };
}

/* ------------------------------------------------------------------ */
/* Webhook                                                             */
/* ------------------------------------------------------------------ */

/**
 * Make sure exactly one ACTIVE account-scoped webhook points at our endpoint.
 *
 * Idempotent by design: it looks the webhook up on Adobe first and only creates
 * one when genuinely absent. Re-activates an INACTIVE one and re-subscribes if
 * the event set has drifted, so the desired state is enforced rather than just
 * established once.
 *
 * Returns { action, webhookId, state }.
 */
async function ensureWebhook({ url, events = WEBHOOK_EVENTS, name = WEBHOOK_NAME } = {}) {
  const targetUrl = url || webhookUrl();
  if (!targetUrl) {
    throw new Error("PUBLIC_API_BASE_URL is not set, so the webhook URL cannot be determined");
  }

  const existing = await adobe.listWebhooks();
  const match = existing.find(
    (hook) =>
      sameUrl(hook?.webhookUrlInfo?.url || hook?.url, targetUrl) &&
      String(hook?.scope || "").toUpperCase() === "ACCOUNT"
  );

  if (!match) {
    // Adobe verifies the endpoint during this call: it issues a GET carrying
    // X-AdobeSign-ClientId and requires the echo. A failure here means the
    // endpoint is unreachable or did not echo, not that the data was wrong.
    const webhookId = await adobe.createWebhook({
      name,
      url: targetUrl,
      scope: "ACCOUNT",
      events: [...events],
      state: "ACTIVE",
    });
    const created = await adobe.getWebhook(webhookId);
    return {
      action: "created",
      webhookId,
      state: webhookStatus(created),
      events: created?.webhookSubscriptionEvents || [...events],
    };
  }

  const webhookId = match.id;
  let state = webhookStatus(match);
  let currentEvents = match.webhookSubscriptionEvents || [];
  const actions = [];

  if (!sameEvents(currentEvents, events)) {
    await adobe.updateWebhook(webhookId, {
      name: match.name || name,
      url: targetUrl,
      scope: "ACCOUNT",
      events: [...events],
      state: "ACTIVE",
    });
    actions.push("updated");
  }

  // Independent of the event check: a webhook can be both out of date AND
  // deactivated, and Adobe only changes the status through its own endpoint.
  if (state && state !== "ACTIVE") {
    await adobe.setWebhookState(webhookId, "ACTIVE");
    actions.push("reactivated");
  }

  if (actions.length) {
    const refreshed = await adobe.getWebhook(webhookId);
    state = webhookStatus(refreshed);
    currentEvents = refreshed?.webhookSubscriptionEvents || currentEvents;
  }

  return { action: actions.join("+") || "unchanged", webhookId, state, events: currentEvents };
}

/**
 * Claim the right to provision this URL.
 *
 * The unique index makes the insert atomic, so among concurrent boots exactly
 * one wins. A claim left behind by a crashed run goes stale and is retaken.
 */
async function claimProvisioning(url) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);

  const claimed = await ESignWebhook.findOneAndUpdate(
    {
      provider: "adobe_sign",
      url,
      $or: [
        { provisionState: { $ne: "active" }, provisionStartedAt: { $lte: staleBefore } },
        { provisionState: { $ne: "active" }, provisionStartedAt: null },
      ],
    },
    { $set: { provisionState: "pending", provisionStartedAt: now } },
    { new: true }
  );
  if (claimed) return claimed;

  // No claimable record: either it does not exist yet, or another instance
  // holds a fresh claim, or it is already active.
  try {
    return await ESignWebhook.create({
      provider: "adobe_sign",
      url,
      provisionState: "pending",
      provisionStartedAt: now,
    });
  } catch (error) {
    // Duplicate key: someone else got there first, which is a correct outcome.
    if (error?.code === 11000) return null;
    throw error;
  }
}

/**
 * Bring the webhook to its desired state and record the outcome.
 * Returns null when another instance is handling it or it is already active.
 */
async function provisionWebhook({ force = false } = {}) {
  const url = webhookUrl();
  if (!url) throw new Error("PUBLIC_API_BASE_URL is not set");

  const record = await ESignWebhook.findOne({ provider: "adobe_sign", url });

  // Already good, and the caller is not asking us to re-verify.
  if (
    !force &&
    record?.provisionState === "active" &&
    record?.providerState === "ACTIVE" &&
    record?.providerWebhookId
  ) {
    // Still confirm against Adobe, cheaply, so a webhook deleted in the console
    // is noticed rather than assumed present.
    let live = null;
    try {
      live = await adobe.getWebhook(record.providerWebhookId);
    } catch {
      live = null;
    }

    if (live && webhookStatus(live) === "ACTIVE") {
      record.lastCheckedAt = new Date();
      await record.save();
      return { action: "verified", webhookId: record.providerWebhookId, state: "ACTIVE" };
    }

    // Gone or deactivated. Stand the record down so the claim below can take
    // it - leaving it "active" would make it permanently unrepairable.
    record.provisionState = "failed";
    record.providerState = live ? webhookStatus(live) : "";
    record.provisionStartedAt = null;
    record.lastError = live ? "Webhook is not ACTIVE at the provider" : "Webhook not found at the provider";
    record.lastCheckedAt = new Date();
    await record.save();
  }

  const claim = await claimProvisioning(url);
  if (!claim) return { action: "skipped", webhookId: "", state: "" };

  try {
    const result = await ensureWebhook({ url });
    claim.providerWebhookId = result.webhookId;
    claim.providerState = result.state;
    claim.events = result.events;
    claim.scope = "ACCOUNT";
    const healthy = result.state === "ACTIVE";
    claim.provisionState = healthy ? "active" : "failed";
    claim.expectedClientId = String(process.env.ADOBE_SIGN_CLIENT_ID || "");
    claim.lastCheckedAt = new Date();
    claim.lastError = healthy ? "" : `Provider reported status "${result.state || "unknown"}"`;
    // Any outcome short of ACTIVE releases the claim, so the next boot retries
    // straight away. Holding it would make an unhealthy webhook look like work
    // in progress for the whole stale-lock window.
    if (!healthy) claim.provisionStartedAt = null;
    await claim.save();
    return result;
  } catch (error) {
    claim.provisionState = "failed";
    claim.lastError = String(error?.message || "Unknown error").slice(0, 1000);
    claim.lastCheckedAt = new Date();
    // Release the claim rather than holding it until it goes stale, so the very
    // next retry can take it. Holding a failed claim would make one transient
    // error look like "another instance is handling it" for five minutes.
    claim.provisionStartedAt = null;
    await claim.save();
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

/**
 * Run at boot. Logs a sanitized summary and never throws: an e-signature
 * problem must not stop the rest of the application from serving.
 */
async function runStartupProvisioning() {
  if (!adobe.isConfigured()) {
    console.log("esign: Adobe Acrobat Sign not configured; e-signature disabled");
    return;
  }

  let connectivity;
  try {
    connectivity = await checkConnectivity();
    console.log(
      `esign: Adobe authenticated (mode=${connectivity.authMode} shard=${connectivity.shard || "?"} ` +
        `api=${connectivity.apiAccessPoint} tokenHostCorrect=${connectivity.tokenHostCorrect})`
    );
    if (!connectivity.tokenHostCorrect) {
      console.error(
        `esign: ADOBE_SIGN_TOKEN_HOST does not match the API host Adobe reports (${connectivity.apiAccessPoint}). ` +
          "Set it to that value."
      );
    }
  } catch (error) {
    console.error(
      `esign: Adobe authentication FAILED (${error?.code || "error"}${error?.status ? ` status=${error.status}` : ""}): ` +
        `${error?.message || "unknown"}`
    );
    return;
  }

  if (!autoProvisionEnabled()) {
    console.log("esign: webhook auto-provisioning disabled by ESIGN_WEBHOOK_AUTO_PROVISION");
    return;
  }
  if (!publicBaseUrl()) {
    console.warn("esign: PUBLIC_API_BASE_URL not set; skipping webhook provisioning");
    return;
  }

  // Adobe verifies the URL by calling it back. Immediately after a deploy this
  // instance may not be in the load balancer yet, so a first failure is often
  // just "too early" rather than a real problem - hence the retries.
  for (let attempt = 1; attempt <= PROVISION_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await delay(PROVISION_RETRY_MS);
    try {
      const result = await provisionWebhook();
      if (result.action === "skipped") {
        console.log(
          "esign: webhook provisioning skipped - the provisioning claim is held elsewhere"
        );
        return;
      }
      console.log(
        `esign: webhook ${result.action} (id=${result.webhookId} state=${result.state} ` +
          `events=${(result.events || []).length}) url=${webhookUrl()}`
      );
      return;
    } catch (error) {
      const detail =
        `${error?.code || "error"}${error?.status ? ` status=${error.status}` : ""}: ` +
        `${error?.message || "unknown"}`;
      if (attempt < PROVISION_ATTEMPTS) {
        console.warn(`esign: webhook provisioning attempt ${attempt} failed (${detail}); retrying`);
      } else {
        console.error(`esign: webhook provisioning FAILED after ${attempt} attempts (${detail})`);
      }
    }
  }
}

module.exports = {
  WEBHOOK_EVENTS,
  WEBHOOK_NAME,
  WEBHOOK_PATH,
  publicBaseUrl,
  webhookUrl,
  autoProvisionEnabled,
  sameUrl,
  sameEvents,
  webhookStatus,
  checkConnectivity,
  ensureWebhook,
  provisionWebhook,
  runStartupProvisioning,
};
