#!/usr/bin/env node
/**
 * Adobe Acrobat Sign — live connectivity and authentication check.
 *
 *   node scripts/adobe_connectivity_check.js
 *
 * READ-ONLY BY CONSTRUCTION.
 * The only network calls are a token refresh and GET /baseUris. It does not
 * upload a document, create or send an agreement, register a webhook, or write
 * anything to Adobe or to the database. Safe to run against production
 * credentials at any time, including after a credential rotation.
 *
 * It deliberately drives utils/esign/adobeSignClient.js - the same module the
 * server uses - so a pass here means the production code path works with these
 * credentials, not merely that the credentials are valid in the abstract.
 *
 * No secret is ever printed. Credential presence is reported by length only.
 */

require("dotenv").config();

const adobe = require("../utils/esign/adobeSignClient");

/** Values that are configuration, not credentials, and safe to echo. */
const PUBLIC_VARS = [
  "ADOBE_SIGN_TOKEN_HOST",
  "ADOBE_SIGN_SHARD",
  "ADOBE_SIGN_REDIRECT_URI",
];

/** Values that must never be echoed, only counted. */
const SECRET_VARS = [
  "ADOBE_SIGN_CLIENT_ID",
  "ADOBE_SIGN_CLIENT_SECRET",
  "ADOBE_SIGN_REFRESH_TOKEN",
  "ADOBE_SIGN_INTEGRATION_KEY",
  "ADOBE_SIGN_WEBHOOK_CLIENT_ID",
];

function shardFromText(text) {
  const match = String(text || "").match(/(?:^|\/\/|\.)([a-z]{2,4}\d{1,2})\.adobesign\.com/i);
  return match ? match[1].toLowerCase() : "";
}

function line(label, value) {
  console.log(`  ${String(label).padEnd(34)}${value}`);
}

async function main() {
  console.log("\nAdobe Acrobat Sign - connectivity check");
  console.log("  Read-only: no agreement, no document, no webhook.\n");

  console.log("CONFIGURATION\n");
  for (const key of SECRET_VARS) {
    const value = String(process.env[key] || "");
    line(key, value ? `set (${value.length} chars)` : "NOT SET");
  }
  for (const key of PUBLIC_VARS) {
    line(key, process.env[key] || "NOT SET");
  }

  const mode = adobe.authMode();
  console.log("");
  line("Auth mode", mode || "NONE - cannot authenticate");

  if (!adobe.isConfigured()) {
    console.log("\nRESULT: FAILED - no usable credential\n");
    console.log("  A client id and secret alone cannot authenticate. The client needs either");
    console.log("  ADOBE_SIGN_REFRESH_TOKEN (mint it with scripts/adobe_oauth_bootstrap.js)");
    console.log("  or ADOBE_SIGN_INTEGRATION_KEY.\n");
    process.exit(1);
  }

  const expectedShard = String(process.env.ADOBE_SIGN_SHARD || "").trim().toLowerCase();
  const configuredHost = String(process.env.ADOBE_SIGN_TOKEN_HOST || "").trim();

  // Warn before the call, because a wrong host is the likeliest failure.
  if (!configuredHost) {
    console.log("\n  WARNING  ADOBE_SIGN_TOKEN_HOST is not set. The client will fall back to");
    console.log("           its na1 default, which is wrong for any account on another shard.");
  } else if (expectedShard && shardFromText(configuredHost) !== expectedShard) {
    console.log(
      `\n  WARNING  ADOBE_SIGN_TOKEN_HOST points at ${shardFromText(configuredHost) || "an unknown shard"},` +
        ` but ADOBE_SIGN_SHARD says ${expectedShard}.`
    );
  }

  /* --- Step 1: authenticate ------------------------------------------ */

  console.log("\nSTEP 1  Exchange credential for an access token\n");
  let token;
  try {
    token = await adobe.getAccessToken();
    line("Access token obtained", "yes (value withheld)");
    line("Token length", `${String(token.accessToken || "").length} chars`);
    line("API access point returned", token.apiAccessPoint || "(none)");
  } catch (error) {
    // AdobeSignError messages are written to carry no token material.
    console.log(`  FAILED  ${error?.message || "unknown error"}`);
    if (error?.status) line("HTTP status", error.status);
    if (error?.code) line("Adobe code", error.code);
    console.log("\nRESULT: AUTHENTICATION FAILED\n");
    process.exit(1);
  }

  /* --- Step 2: /baseUris --------------------------------------------- */

  console.log("\nSTEP 2  GET /baseUris\n");
  let baseUris;
  try {
    baseUris = await adobe.getBaseUris();
    line("apiAccessPoint", baseUris?.apiAccessPoint || "(none)");
    line("webAccessPoint", baseUris?.webAccessPoint || "(none)");
  } catch (error) {
    console.log(`  FAILED  ${error?.message || "unknown error"}`);
    if (error?.status) line("HTTP status", error.status);
    if (error?.code) line("Adobe code", error.code);
    console.log("\nRESULT: AUTHENTICATED, BUT THE API IS NOT USABLE\n");
    process.exit(1);
  }

  /* --- Step 3: shard confirmation ------------------------------------ */

  console.log("\nSTEP 3  Confirm the shard\n");
  const reportedShard = shardFromText(baseUris?.apiAccessPoint);
  line("Shard reported by Adobe", reportedShard || "could not parse");
  line("Shard expected", expectedShard || "(not configured)");

  const shardOk = Boolean(reportedShard) && (!expectedShard || reportedShard === expectedShard);
  line("Match", shardOk ? "yes" : "NO");

  /* --- Step 4: can production use this unchanged? -------------------- */

  console.log("\nSTEP 4  Production readiness\n");
  const authoritativeHost = String(baseUris?.apiAccessPoint || "").replace(/\/+$/, "");
  const hostOk = configuredHost.replace(/\/+$/, "") === authoritativeHost;

  line("ADOBE_SIGN_TOKEN_HOST correct", hostOk ? "yes" : "NO");
  if (!hostOk) {
    console.log(`\n  Set ADOBE_SIGN_TOKEN_HOST=${authoritativeHost}`);
    console.log("  Without it the client uses its na1 default and every call fails.");
  }

  const webhookIdSet = Boolean(
    process.env.ADOBE_SIGN_WEBHOOK_CLIENT_ID || process.env.ADOBE_SIGN_CLIENT_ID
  );
  line("Webhook client id configured", webhookIdSet ? "yes" : "no (webhook will 503)");

  const ready = shardOk && hostOk;
  console.log(`\nRESULT: ${ready ? "PASS" : "AUTHENTICATED, CONFIGURATION INCOMPLETE"}`);
  console.log("  No agreement created. No document sent. No webhook registered.\n");
  process.exit(ready ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n  ERROR  ${error?.message || "Unexpected failure"}\n`);
  process.exit(1);
});
