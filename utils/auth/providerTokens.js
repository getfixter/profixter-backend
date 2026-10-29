const crypto = require("crypto");
const jwt = require("jsonwebtoken");

/**
 * Proving a Google or Apple sign-in, on the server.
 *
 * The browser hands us a signed token. Nothing in it is believed until its
 * signature, issuer, audience and expiry check out against the provider's own
 * keys, and an email inside it only counts when the provider says it verified
 * that email. Everything returned here is therefore safe to identify somebody
 * by; everything else the browser sends is not.
 */

class ProviderTokenError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function list(value) {
  return String(value || "").split(",").map((part) => part.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ Google */

function googleClientIds(env = process.env) {
  return list(env.GOOGLE_CLIENT_ID);
}

async function verifyGoogleIdToken(idToken, { env = process.env } = {}) {
  const audience = googleClientIds(env);
  if (!audience.length) throw new ProviderTokenError("GOOGLE_NOT_CONFIGURED");
  const { OAuth2Client } = require("google-auth-library");
  let payload;
  try {
    const ticket = await new OAuth2Client().verifyIdToken({ idToken, audience });
    payload = ticket.getPayload();
  } catch {
    throw new ProviderTokenError("INVALID_PROVIDER_TOKEN");
  }
  return googleIdentity(payload);
}

/**
 * The older access-token path, kept for any browser still running the old
 * screen. An access token says nothing about WHO it was issued to, so it is
 * checked with Google first: a token minted for some other app must never be
 * accepted here (token substitution).
 */
async function verifyGoogleAccessToken(accessToken, { env = process.env } = {}) {
  const audience = googleClientIds(env);
  if (!audience.length) throw new ProviderTokenError("GOOGLE_NOT_CONFIGURED");
  const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
  if (!info.ok) throw new ProviderTokenError("INVALID_PROVIDER_TOKEN");
  const token = await info.json();
  if (!audience.includes(String(token.aud || token.azp || ""))) throw new ProviderTokenError("INVALID_PROVIDER_TOKEN");
  const profile = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!profile.ok) throw new ProviderTokenError("INVALID_PROVIDER_TOKEN");
  return googleIdentity(await profile.json());
}

function googleIdentity(payload = {}) {
  const sub = String(payload.sub || "");
  if (!sub) throw new ProviderTokenError("INVALID_PROVIDER_TOKEN");
  const emailVerified = payload.email_verified === true || payload.email_verified === "true";
  return {
    provider: "google",
    sub,
    email: emailVerified ? String(payload.email || "").trim().toLowerCase() : "",
    emailVerified,
    name: String(payload.name || "").trim(),
    firstName: String(payload.given_name || "").trim(),
    lastName: String(payload.family_name || "").trim(),
  };
}

/* ------------------------------------------------------------------- Apple */

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";
let appleKeysCache = { at: 0, keys: [] };

function appleClientIds(env = process.env) {
  return list(env.APPLE_CLIENT_IDS || env.APPLE_CLIENT_ID);
}

async function appleKeys({ fetchKeys = null } = {}) {
  if (fetchKeys) return fetchKeys();
  if (Date.now() - appleKeysCache.at < 60 * 60 * 1000 && appleKeysCache.keys.length) return appleKeysCache.keys;
  const response = await fetch(APPLE_KEYS_URL);
  if (!response.ok) throw new ProviderTokenError("APPLE_UNAVAILABLE");
  const body = await response.json();
  appleKeysCache = { at: Date.now(), keys: body.keys || [] };
  return appleKeysCache.keys;
}

function isAppleRelay(email) {
  return /@privaterelay\.appleid\.com$/i.test(String(email || ""));
}

/**
 * Verify Sign in with Apple's identity token.
 *
 * The nonce ties the token to THIS sign-in attempt: the browser made a random
 * value, sent its SHA-256 to Apple, and sends us the original. A token lifted
 * from somewhere else carries somebody else's nonce and fails here.
 */
async function verifyAppleIdToken(idToken, { rawNonce, env = process.env, fetchKeys = null } = {}) {
  const audience = appleClientIds(env);
  if (!audience.length) throw new ProviderTokenError("APPLE_NOT_CONFIGURED");
  const header = jwt.decode(idToken, { complete: true })?.header;
  if (!header?.kid) throw new ProviderTokenError("INVALID_PROVIDER_TOKEN");
  const jwk = (await appleKeys({ fetchKeys })).find((key) => key.kid === header.kid);
  if (!jwk) throw new ProviderTokenError("INVALID_PROVIDER_TOKEN");

  let payload;
  try {
    const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
    payload = jwt.verify(idToken, key, { algorithms: ["RS256"], issuer: APPLE_ISSUER, audience });
  } catch {
    throw new ProviderTokenError("INVALID_PROVIDER_TOKEN");
  }

  const expectedNonce = rawNonce ? crypto.createHash("sha256").update(String(rawNonce)).digest("hex") : "";
  if (!expectedNonce || payload.nonce !== expectedNonce) throw new ProviderTokenError("INVALID_PROVIDER_TOKEN");

  const sub = String(payload.sub || "");
  if (!sub) throw new ProviderTokenError("INVALID_PROVIDER_TOKEN");
  const emailVerified = payload.email_verified === true || payload.email_verified === "true";
  const email = emailVerified ? String(payload.email || "").trim().toLowerCase() : "";
  return {
    provider: "apple",
    sub,
    email,
    emailVerified,
    emailIsRelay: isAppleRelay(email) || payload.is_private_email === true || payload.is_private_email === "true",
  };
}

module.exports = {
  ProviderTokenError,
  appleClientIds,
  googleClientIds,
  isAppleRelay,
  verifyAppleIdToken,
  verifyGoogleAccessToken,
  verifyGoogleIdToken,
};
