#!/usr/bin/env node
/**
 * Adobe Acrobat Sign — one-time OAuth bootstrap.
 *
 * Obtains the initial refresh token that utils/esign/adobeSignClient.js needs.
 * Run this ONCE, on your own machine. Nothing here ships to production.
 *
 *   node scripts/adobe_oauth_bootstrap.js
 *
 * SHARDS
 * Acrobat Sign accounts live on a shard (na1, na2, na4, eu1, jp1, ...) and
 * OAuth applications are shard-bound: a client_id registered on na4 does not
 * exist in na1's database, so authorizing against the wrong shard fails with
 * "the client configuration is invalid: invalid_request".
 *
 * There is no way to discover an account's shard programmatically before you
 * hold a token: GET /baseUris reports it, but /baseUris requires the very token
 * OAuth is trying to mint. (The shardless secure.echosign.com form exists, but
 * Adobe documents it for PARTNER/embed applications only, not customer apps.)
 *
 * So the shard is resolved from what Adobe actually exposes to a human: the
 * hostname in the address bar when signed into Acrobat Sign. This script asks
 * for that rather than defaulting to a guess, and then CONFIRMS the answer
 * against /baseUris once a token exists.
 *
 * WHY THERE IS NO LOCAL SERVER
 * The authorization code arrives as a query parameter on a redirect. Adobe
 * requires that redirect to be HTTPS even on localhost, which would otherwise
 * mean generating a self-signed certificate and clicking through a browser
 * trust warning. Instead we let the redirect fail to connect and read the code
 * out of the browser's address bar. The code never leaves this machine, no
 * local port is opened, and no callback route is added to the production API.
 *
 * SECRECY
 * Credentials are read from BackEnd/.env (gitignored), never from argv, so they
 * do not land in shell history. The client secret is never printed. The refresh
 * token IS printed once, because you have to copy it into Elastic Beanstalk -
 * clear your scrollback afterwards.
 */

require("dotenv").config();

const crypto = require("crypto");
const readline = require("readline");

/** Scopes must match what is enabled on the Adobe application, exactly. */
const DEFAULT_SCOPES = [
  "agreement_read:account",
  "agreement_write:account",
  "agreement_send:account",
  "webhook_read:account",
  "webhook_write:account",
];

/**
 * Shard codes are two-to-four letters plus a digit or two (na1, na4, eu2, jp1).
 * Validated by shape rather than against a fixed list, because Adobe adds
 * shards and an allowlist would turn a new region into a bug.
 */
const SHARD_PATTERN = /^[a-z]{2,4}\d{1,2}$/;

function config() {
  return {
    clientId: String(process.env.ADOBE_SIGN_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.ADOBE_SIGN_CLIENT_SECRET || "").trim(),
    redirectUri: String(
      process.env.ADOBE_SIGN_REDIRECT_URI || "https://localhost:8443/adobe/callback"
    ).trim(),
    shard: String(process.env.ADOBE_SIGN_SHARD || "").trim().toLowerCase(),
    tokenHost: String(process.env.ADOBE_SIGN_TOKEN_HOST || "").trim().replace(/\/+$/, ""),
    scopes: String(process.env.ADOBE_SIGN_SCOPES || "")
      .split(/[\s,]+/)
      .filter(Boolean),
  };
}

/**
 * Pull a shard out of any Acrobat Sign hostname or URL.
 * Handles api.na4.adobesign.com, secure.na4.adobesign.com and the per-account
 * web host (joesBikeShop.na4.adobesign.com). Returns "" for the shardless
 * partner host, which is deliberately not usable here.
 */
function shardFromText(text) {
  const match = String(text || "").match(/(?:^|\/\/|\.)([a-z]{2,4}\d{1,2})\.adobesign\.com/i);
  return match ? match[1].toLowerCase() : "";
}

const authorizeHost = (shard) => `https://secure.${shard}.adobesign.com`;
const apiHost = (shard) => `https://api.${shard}.adobesign.com`;

function fail(message) {
  console.error(`\n  ERROR  ${message}\n`);
  process.exit(1);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });
}

/**
 * Work out which shard to authorize against.
 *
 * Never falls back to a default: authorizing against a guessed shard is exactly
 * the failure this function exists to prevent.
 */
async function resolveShard(c) {
  if (c.shard) {
    if (!SHARD_PATTERN.test(c.shard)) {
      fail(
        `ADOBE_SIGN_SHARD="${c.shard}" does not look like a shard code.\n` +
          "  Expected something like na1, na4, eu1 or jp1."
      );
    }
    console.log(`  Shard: ${c.shard}  (from ADOBE_SIGN_SHARD)\n`);
    return c.shard;
  }

  const fromTokenHost = shardFromText(c.tokenHost);
  if (fromTokenHost) {
    console.log(`  Shard: ${fromTokenHost}  (derived from ADOBE_SIGN_TOKEN_HOST)\n`);
    return fromTokenHost;
  }

  console.log("  Which Acrobat Sign shard is this account on?\n");
  console.log("  Sign in to Acrobat Sign in a browser and look at the address bar. The");
  console.log("  hostname contains the shard, e.g. https://secure.na4.adobesign.com/...");
  console.log("  or https://<yourcompany>.na4.adobesign.com/...\n");

  const answer = await ask("  Paste that URL (or just the shard code, e.g. na4): ");
  if (!answer) fail("No shard provided.");

  const shard = shardFromText(answer) || answer.trim().toLowerCase();

  if (!SHARD_PATTERN.test(shard)) {
    fail(
      `Could not read a shard from "${answer}".\n` +
        "  Paste the full URL from the address bar, or just the code such as na4."
    );
  }

  console.log(`\n  Shard: ${shard}`);
  console.log(`  Set ADOBE_SIGN_SHARD=${shard} in .env to skip this prompt next time.\n`);
  return shard;
}

/**
 * Exchange the authorization code for tokens.
 *
 * Adobe's own documentation is inconsistent about whether the v6 path is
 * /oauth/v2/token or the older /oauth/token, so try the v6 path first and fall
 * back rather than let a doc discrepancy block the bootstrap.
 */
async function exchangeCode({ apiAccessPoint, code, clientId, clientSecret, redirectUri, shard }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  const attempts = ["/oauth/v2/token", "/oauth/token"];
  let lastStatus = 0;
  let lastDetail = "";

  for (const path of attempts) {
    const res = await fetch(`${apiAccessPoint}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (res.ok) {
      const json = await res.json();
      return { json, path };
    }

    lastStatus = res.status;
    // Adobe returns a JSON error code here. It describes the failure mode
    // (expired code, mismatched redirect) and contains no token material.
    try {
      const errorBody = await res.json();
      lastDetail = String(errorBody?.error || errorBody?.code || "").slice(0, 200);
    } catch {
      lastDetail = "";
    }

    // Only a 404 justifies trying the other path; anything else is a real error.
    if (res.status !== 404) break;
  }

  fail(
    `Token exchange failed (HTTP ${lastStatus}${lastDetail ? `, ${lastDetail}` : ""}).\n` +
      "  Common causes:\n" +
      "    - The authorization code expired. It is valid for about 5 minutes; re-run this script.\n" +
      "    - The Redirect URI here does not byte-for-byte match the one registered on the\n" +
      "      Adobe application (trailing slash, http vs https, port).\n" +
      "    - The client secret in .env does not match the application.\n" +
      `    - The code was minted on a different shard than ${shard}.`
  );
  return null;
}

/**
 * Ask Adobe which shard this token actually belongs to.
 * This is the authoritative check, and the only one available once a token
 * exists. A mismatch here means later API calls would hit the wrong shard.
 */
async function confirmShard(apiAccessPoint, accessToken) {
  try {
    const res = await fetch(`${apiAccessPoint}/api/rest/v6/baseUris`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const json = await res.json();
    return {
      ok: true,
      apiAccessPoint: String(json?.apiAccessPoint || "").replace(/\/+$/, ""),
      webAccessPoint: String(json?.webAccessPoint || "").replace(/\/+$/, ""),
    };
  } catch (error) {
    return { ok: false, detail: error?.message || "unreachable" };
  }
}

async function main() {
  const c = config();
  const scopes = c.scopes.length ? c.scopes : DEFAULT_SCOPES;

  console.log("\nAdobe Acrobat Sign - OAuth bootstrap\n");

  if (!c.clientId || !c.clientSecret) {
    fail(
      "ADOBE_SIGN_CLIENT_ID and ADOBE_SIGN_CLIENT_SECRET must be set in BackEnd/.env\n" +
        "  Get them from: Account > Acrobat Sign API > API Applications >\n" +
        "  select the application > Configure OAuth for Application."
    );
  }

  const shard = await resolveShard(c);

  // CSRF protection. Held in memory for this process only.
  const state = crypto.randomBytes(16).toString("hex");

  const authorizeUrl = new URL(`${authorizeHost(shard)}/public/oauth/v2`);
  authorizeUrl.searchParams.set("client_id", c.clientId);
  authorizeUrl.searchParams.set("redirect_uri", c.redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  // URLSearchParams encodes the separating spaces as "+", which is the format
  // Adobe's examples use.
  authorizeUrl.searchParams.set("scope", scopes.join(" "));
  authorizeUrl.searchParams.set("state", state);

  console.log("  Redirect URI in use:");
  console.log(`    ${c.redirectUri}`);
  console.log("    This must match the Adobe application EXACTLY.\n");
  console.log("  Scopes requested:");
  for (const scope of scopes) console.log(`    ${scope}`);

  console.log(
    `\n  STEP 1  Open this URL in a browser signed in as the ${shard} account admin:\n`
  );
  console.log(`${authorizeUrl.toString()}\n`);
  console.log("  STEP 2  Approve the request.\n");
  console.log("  STEP 3  The browser will try to load the redirect URI and fail to connect.");
  console.log("          That is expected - nothing is listening there. The authorization code");
  console.log("          is in the address bar. Copy the ENTIRE failed URL and paste it below.\n");

  const pasted = await ask("  Paste the full redirected URL: ");
  if (!pasted) fail("No URL provided.");

  let redirected;
  try {
    redirected = new URL(pasted);
  } catch {
    fail("That is not a valid URL. Copy the whole thing, starting with https://");
  }

  const returnedError = redirected.searchParams.get("error");
  if (returnedError) {
    fail(
      `Adobe returned an error instead of a code: ${returnedError}\n` +
        "  If it mentions the client configuration, the application is registered on a\n" +
        `  different shard than ${shard} - applications are shard-bound.\n` +
        "  If it mentions scope approval, the account admin must approve the :account\n" +
        "  scope modifiers, which requires Business or Enterprise edition."
    );
  }

  const returnedState = redirected.searchParams.get("state");
  if (returnedState !== state) {
    fail(
      "The state parameter did not match. Do not continue - this response did not come\n" +
        "  from the request this script just made. Re-run the script."
    );
  }

  const code = redirected.searchParams.get("code");
  if (!code) fail("No authorization code found in that URL.");

  // Adobe returns the account's true shard in the redirect. Prefer it over
  // anything configured, otherwise every later API call hits the wrong shard.
  const redirectAccessPoint = String(redirected.searchParams.get("api_access_point") || "").replace(
    /\/+$/,
    ""
  );
  const apiAccessPoint = redirectAccessPoint || apiHost(shard);

  const redirectShard = shardFromText(redirectAccessPoint);
  if (redirectShard && redirectShard !== shard) {
    console.log(
      `\n  NOTE  Adobe redirected with shard ${redirectShard}, not ${shard}. Using ${redirectShard}.`
    );
  }

  console.log(`\n  Exchanging the code on ${apiAccessPoint} ...`);

  const { json, path } = await exchangeCode({
    apiAccessPoint,
    code,
    clientId: c.clientId,
    clientSecret: c.clientSecret,
    redirectUri: c.redirectUri,
    shard,
  });

  const refreshToken = json?.refresh_token;
  if (!refreshToken) {
    fail(
      "Adobe accepted the code but returned no refresh token.\n" +
        "  Re-run the authorization and make sure you are approving as an account admin."
    );
  }

  let resolvedAccessPoint = String(json.api_access_point || apiAccessPoint).replace(/\/+$/, "");

  // Authoritative confirmation, now that a token exists.
  const confirmed = await confirmShard(resolvedAccessPoint, json.access_token);
  if (confirmed.ok && confirmed.apiAccessPoint) {
    if (confirmed.apiAccessPoint !== resolvedAccessPoint) {
      console.log(
        `  NOTE  /baseUris reports ${confirmed.apiAccessPoint}; using that as the API host.`
      );
      resolvedAccessPoint = confirmed.apiAccessPoint;
    } else {
      console.log(`  Shard confirmed by /baseUris: ${shardFromText(confirmed.apiAccessPoint)}`);
    }
  } else {
    console.log(`  (Could not confirm via /baseUris: ${confirmed.detail}. Proceeding.)`);
  }

  console.log(`  Success (token endpoint: ${path}).\n`);
  console.log("  ----------------------------------------------------------------");
  console.log("  Set these in Elastic Beanstalk (Handyman-v2-env):\n");
  console.log(`  ADOBE_SIGN_TOKEN_HOST=${resolvedAccessPoint}`);
  console.log(`  ADOBE_SIGN_REFRESH_TOKEN=${refreshToken}`);
  console.log("\n  ADOBE_SIGN_CLIENT_ID and ADOBE_SIGN_CLIENT_SECRET must be set there too.");
  console.log("  ----------------------------------------------------------------\n");
  console.log("  ADOBE_SIGN_TOKEN_HOST must point at this shard. The default in the code is");
  console.log("  na1, which would fail for this account - set it explicitly.\n");
  console.log("  This refresh token is a long-lived credential.");
  console.log("    - Clear your terminal scrollback now.");
  console.log("    - Never commit it. Never paste it into a ticket or a chat.");
  console.log("    - Its scopes are fixed at this moment. If you add a scope on the Adobe");
  console.log("      application later, re-run this script to mint a new token.\n");

  process.exit(0);
}

module.exports = { shardFromText, SHARD_PATTERN, authorizeHost, apiHost };

if (require.main === module) {
  main().catch((error) => {
    // Deliberately message-only: an error object here could carry request bodies.
    fail(error?.message || "Unexpected failure");
  });
}
