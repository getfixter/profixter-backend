/**
 * Registration & sign-in 2.0, through the real routers and a real database.
 *
 * Phone code, email code, Google and Apple; linking to existing customers;
 * duplicate prevention; replay, brute force, expiry and rate limits; accounts
 * with no address, email or phone; adding a home; and the guarantee that
 * signing up never creates a booking or a charge.
 *
 * Nothing leaves the process: codes are captured by an injected sender, Google
 * is stubbed, and Apple tokens are signed with a throwaway key pair so the
 * real Apple verification code runs against them.
 *
 *   node scripts/test_auth_v2_integration.js
 *
 * Not in `npm test`: it boots a MongoDB binary.
 */

Object.assign(process.env, {
  NODE_ENV: "test",
  S3_BUCKET: "test-bucket",
  JWT_SECRET: "test-secret-for-auth-v2",
  STRIPE_SECRET_KEY: "sk_test_fake",
  GOOGLE_CLIENT_ID: "google-client.apps.googleusercontent.com",
  APPLE_CLIENT_IDS: "com.profixter.web",
  CLIENT_URL: "https://www.profixter.com",
});

const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

/* ---- Google: stubbed before routes/auth.js destructures it ---- */
const providerTokens = require("../utils/auth/providerTokens");
const googleIdentities = new Map();
providerTokens.verifyGoogleIdToken = async (idToken) => {
  const identity = googleIdentities.get(idToken);
  if (!identity) throw new providerTokens.ProviderTokenError("INVALID_PROVIDER_TOKEN");
  return identity;
};

const User = require("../models/User");
const Booking = require("../models/Booking");
const Subscription = require("../models/Subscription");
const AuthChallenge = require("../models/AuthChallenge");
const AuthRateCounter = require("../models/AuthRateCounter");
const { missingBookingContact } = require("../utils/bookingContact");
const { smsBody } = require("../utils/auth/otpDelivery");

/* ---- the real routers ---- */
const authV2 = require("../routes/authV2");
const sent = [];
authV2.deps.deliver = async ({ channel, target, code }) => {
  sent.push({ channel, target, code });
};

/* ---- Apple: a throwaway key pair, published as Apple's JWKS ---- */
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const appleJwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" };
authV2.deps.fetchAppleKeys = async () => [appleJwk];
function appleToken(claims, { rawNonce = "nonce-1", aud = "com.profixter.web" } = {}) {
  return jwt.sign(
    { iss: "https://appleid.apple.com", aud, nonce: crypto.createHash("sha256").update(rawNonce).digest("hex"), ...claims },
    privateKey,
    { algorithm: "RS256", keyid: "test-kid", expiresIn: "5m" }
  );
}

const app = express();
app.use(express.json());
app.use("/api/auth", require("../routes/auth"));
app.use("/api/auth", authV2);
app.use("/api/users", require("../routes/users"));
const passwordReset = require("../routes/passwordReset");
const resetMail = [];
passwordReset.deps.deliver = async (entry) => {
  resetMail.push(entry);
};
app.use("/api/password-reset", passwordReset);

let server;
let base;
async function call(method, path, body, token) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try {
    json = await response.json();
  } catch {
    json = {};
  }
  return { status: response.status, body: json };
}
const post = (path, body, token) => call("POST", path, body, token);

let passed = 0;
const failures = [];
async function test(name, fn) {
  await Promise.all([
    User.deleteMany({}),
    Booking.deleteMany({}),
    Subscription.deleteMany({}),
    AuthChallenge.deleteMany({}),
    AuthRateCounter.deleteMany({}),
  ]);
  sent.length = 0;
  resetMail.length = 0;
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.stack}`);
  }
}

const lastCode = (target) => [...sent].reverse().find((entry) => entry.target === target)?.code;
const clearLimits = () => AuthRateCounter.deleteMany({});

async function phoneSignIn(phone, extra = {}) {
  const start = await post("/api/auth/otp/phone/start", { phone, smsTransactionalConsent: true, ...extra });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  return post("/api/auth/otp/phone/verify", { phone, code: lastCode("+1" + phone.replace(/\D/g, "").slice(-10)) });
}

async function emailSignIn(email, extra = {}) {
  const start = await post("/api/auth/otp/email/start", { email });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  return post("/api/auth/otp/email/verify", { email, code: lastCode(email.toLowerCase()), ...extra });
}

let seq = 0;
async function makePasswordCustomer(overrides = {}) {
  seq += 1;
  const bcrypt = require("bcryptjs");
  return User.create({
    userId: String(40000000 + seq),
    name: "Pat Existing",
    email: `existing${seq}@example.com`,
    password: await bcrypt.hash("correct horse", 4),
    phone: "+16315550100",
    role: "customer",
    signupMethod: "password",
    addresses: [{ line1: "1 Main St", city: "Babylon", state: "NY", zip: "11702" }],
    ...overrides,
  });
}

async function run() {
  console.log("\n--- phone: sign up in seconds");

  await test("new customer by phone: one code, no address, no email, no password", async () => {
    const start = await post("/api/auth/otp/phone/start", { phone: "(631) 555-0101", smsTransactionalConsent: true, smsMarketingConsent: false });
    assert.equal(start.status, 200);
    assert.equal(start.body.phoneMasked, "••• ••• 0101");
    assert.equal(start.body.resendAfterSeconds, 30);
    assert.match(sent[0].code, /^\d{6}$/);

    const res = await post("/api/auth/otp/phone/verify", { phone: "+1 631 555 0101", code: sent[0].code });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "signed_in");
    assert.equal(res.body.created, true);
    assert.ok(res.body.token);
    assert.equal(res.body.user.phone, "+16315550101");
    assert.equal(res.body.user.phoneVerified, true);
    assert.equal(res.body.user.email, "");
    assert.equal(res.body.user.needsName, true);
    assert.deepEqual(res.body.user.addresses, []);

    const user = await User.findOne({ phone: "+16315550101" }).lean();
    assert.equal(user.signupMethod, "phone");
    assert.equal(user.email, undefined, "no empty-string email is stored");
    assert.notEqual(user.smsPreferences?.transactionalEnabled, true, "service texts are never implied by signing up");
    assert.notEqual(user.smsPreferences?.marketingEnabled, true, "marketing is never implied");
    assert.ok(user.termsAcceptedAt, "Terms acceptance is recorded with a timestamp");
    assert.equal(user.termsVersion, "terms.continue.v1");
    assert.equal(await Booking.countDocuments(), 0, "signing up books nothing");
    assert.equal(await Subscription.countDocuments(), 0, "signing up charges nothing");
  });

  await test("the same phone again signs in to the same account", async () => {
    const first = await phoneSignIn("6315550102");
    await clearLimits();
    const again = await phoneSignIn("6315550102");
    assert.equal(again.body.created, false);
    assert.equal(again.body.user.userId, first.body.user.userId);
    assert.equal(await User.countDocuments(), 1);
  });

  await test("many phone-only customers can exist side by side (no email collision)", async () => {
    for (const phone of ["6315550111", "6315550112", "6315550113"]) {
      const res = await phoneSignIn(phone);
      assert.equal(res.body.created, true, JSON.stringify(res.body));
    }
    assert.equal(await User.countDocuments({ email: { $exists: false } }), 3);
  });

  await test("a verification code needs no checkbox; an invalid or non-US number is refused", async () => {
    const plain = await post("/api/auth/otp/phone/start", { phone: "6315550120" });
    assert.equal(plain.status, 200, "requesting your own code is the consent for that one text");
    sent.length = 0;
    const bad = await post("/api/auth/otp/phone/start", { phone: "12345", smsTransactionalConsent: true });
    assert.equal(bad.body.code, "INVALID_PHONE");
    const intl = await post("/api/auth/otp/phone/start", { phone: "+44 20 7946 0958", smsTransactionalConsent: true });
    assert.equal(intl.body.code, "INVALID_PHONE", "US numbers only: the main SMS-pumping vector is international");
    assert.equal(sent.length, 0);
  });

  await test("the text carries the browser autofill line as its last line", async () => {
    // Bound to the host customers are on, whatever CLIENT_URL says (production: bare domain).
    const body = smsBody("482913", { CLIENT_URL: "https://profixter.com" });
    assert.match(body, /\n@www\.profixter\.com #482913$/);
    assert.match(body, /^Your Profixter code is 482913\./);
  });

  console.log("\n--- codes cannot be guessed, replayed or reused");

  await test("wrong code says how many tries are left; five wrong codes kill it", async () => {
    await post("/api/auth/otp/phone/start", { phone: "6315550130", smsTransactionalConsent: true });
    const right = sent[0].code;
    const wrong = right === "000000" ? "111111" : "000000";
    const first = await post("/api/auth/otp/phone/verify", { phone: "6315550130", code: wrong });
    assert.equal(first.status, 400);
    assert.equal(first.body.code, "INVALID_CODE");
    assert.equal(first.body.attemptsLeft, 4);
    for (let i = 0; i < 4; i += 1) await post("/api/auth/otp/phone/verify", { phone: "6315550130", code: wrong });
    const afterLock = await post("/api/auth/otp/phone/verify", { phone: "6315550130", code: right });
    assert.equal(afterLock.body.code, "CODE_EXPIRED", "even the right code is dead after five misses");
    assert.equal(await User.countDocuments(), 0);
  });

  await test("a used code cannot be replayed", async () => {
    await phoneSignIn("6315550131");
    const replay = await post("/api/auth/otp/phone/verify", { phone: "6315550131", code: sent[0].code });
    assert.equal(replay.body.code, "CODE_EXPIRED");
  });

  await test("an expired code is refused", async () => {
    await post("/api/auth/otp/phone/start", { phone: "6315550132", smsTransactionalConsent: true });
    await AuthChallenge.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await post("/api/auth/otp/phone/verify", { phone: "6315550132", code: sent[0].code });
    assert.equal(res.body.code, "CODE_EXPIRED");
  });

  await test("a new code replaces the old one; the old one stops working", async () => {
    await post("/api/auth/otp/phone/start", { phone: "6315550133", smsTransactionalConsent: true });
    const old = sent[0].code;
    await clearLimits();
    await post("/api/auth/otp/phone/start", { phone: "6315550133", smsTransactionalConsent: true });
    const fresh = sent[1].code;
    if (old !== fresh) {
      const stale = await post("/api/auth/otp/phone/verify", { phone: "6315550133", code: old });
      assert.equal(stale.status, 400);
    }
    const ok = await post("/api/auth/otp/phone/verify", { phone: "6315550133", code: fresh });
    assert.equal(ok.body.status, "signed_in");
  });

  await test("codes are stored only as a hash", async () => {
    await post("/api/auth/otp/phone/start", { phone: "6315550134", smsTransactionalConsent: true });
    const row = await AuthChallenge.findOne().lean();
    assert.ok(row.codeHash.length === 64);
    assert.ok(!JSON.stringify(row).includes(sent[0].code));
  });

  await test("with Twilio Verify: Twilio holds the code, we still count tries and allow one use", async () => {
    process.env.TWILIO_VERIFY_SERVICE_SID = "VA00000000000000000000000000000000";
    const checks = [];
    authV2.deps.checkRemote = async ({ target, code }) => {
      checks.push({ target, code });
      return code === "246810";
    };
    try {
      const start = await post("/api/auth/otp/phone/start", { phone: "6315550135" });
      assert.equal(start.status, 200);
      const row = await AuthChallenge.findOne({ target: "+16315550135" }).lean();
      assert.equal(row.provider, "twilio_verify");
      assert.equal(row.codeHash, "", "no code is stored on our side");
      const wrong = await post("/api/auth/otp/phone/verify", { phone: "6315550135", code: "111111" });
      assert.equal(wrong.body.code, "INVALID_CODE");
      assert.equal(wrong.body.attemptsLeft, 4, "our own try counter still applies");
      const right = await post("/api/auth/otp/phone/verify", { phone: "6315550135", code: "246810" });
      assert.equal(right.body.status, "signed_in");
      const replay = await post("/api/auth/otp/phone/verify", { phone: "6315550135", code: "246810" });
      assert.equal(replay.body.code, "CODE_EXPIRED", "an approved code works once");
      assert.deepEqual(checks.map((c) => c.target), ["+16315550135", "+16315550135"], "Twilio is asked only while the code is live");
    } finally {
      delete process.env.TWILIO_VERIFY_SERVICE_SID;
      authV2.deps.checkRemote = null;
    }
  });

  console.log("\n--- abuse limits");

  await test("resend has a cooldown, and a number gets at most 5 codes an hour", async () => {
    const one = await post("/api/auth/otp/phone/start", { phone: "6315550140", smsTransactionalConsent: true });
    assert.equal(one.status, 200);
    const tooSoon = await post("/api/auth/otp/phone/start", { phone: "6315550140", smsTransactionalConsent: true });
    assert.equal(tooSoon.status, 429);
    assert.equal(tooSoon.body.code, "RATE_LIMITED");
    assert.ok(tooSoon.body.retryAfterSeconds > 0);
    assert.equal(sent.length, 1, "a refused request sends nothing");
  });

  await test("one IP cannot text more than 10 different numbers an hour", async () => {
    let refused = 0;
    for (let i = 0; i < 12; i += 1) {
      const res = await post("/api/auth/otp/phone/start", { phone: `63155502${String(i).padStart(2, "0")}`, smsTransactionalConsent: true });
      if (res.status === 429) refused += 1;
    }
    assert.equal(sent.length, 10);
    assert.equal(refused, 2);
  });

  await test("the answer is identical whether or not an account exists (no enumeration)", async () => {
    await makePasswordCustomer({ email: "known@example.com", phone: "+16315550150" });
    const known = await post("/api/auth/otp/email/start", { email: "known@example.com" });
    const unknown = await post("/api/auth/otp/email/start", { email: "nobody@example.com" });
    assert.deepEqual(Object.keys(known.body).sort(), Object.keys(unknown.body).sort());
    assert.equal(known.status, unknown.status);
    const knownPhone = await post("/api/auth/otp/phone/start", { phone: "6315550150", smsTransactionalConsent: true });
    const unknownPhone = await post("/api/auth/otp/phone/start", { phone: "6315550151", smsTransactionalConsent: true });
    assert.deepEqual(Object.keys(knownPhone.body).sort(), Object.keys(unknownPhone.body).sort());
  });

  console.log("\n--- existing customers are never lost, merged blindly, or duplicated");

  await test("a phone an existing customer only TYPED never opens their account by itself", async () => {
    const existing = await makePasswordCustomer({ phone: "+16315550160" });
    const res = await phoneSignIn("6315550160");
    assert.equal(res.body.status, "link_required");
    assert.ok(res.body.linkToken);
    assert.equal(res.body.token, undefined, "no session is issued");
    assert.match(res.body.hint.maskedEmail, /^ex•+@example\.com$/);
    assert.equal(res.body.hint.hasPassword, true);
    const still = await User.findById(existing._id).lean();
    assert.equal(still.phoneVerifiedAt, null);
  });

  await test("proving the account's email joins the phone to it: same account, history intact", async () => {
    const existing = await makePasswordCustomer({ phone: "+16315550161" });
    const link = await phoneSignIn("6315550161");
    await clearLimits();
    const res = await emailSignIn(existing.email, { linkToken: link.body.linkToken });
    assert.equal(res.body.status, "signed_in");
    assert.equal(res.body.created, false);
    assert.equal(res.body.linkedPhone, true);
    assert.equal(res.body.user.userId, existing.userId);
    const after = await User.findById(existing._id).lean();
    assert.ok(after.phoneVerifiedAt);
    assert.equal(after.addresses.length, 1, "saved homes kept");
    assert.ok(after.password, "password kept");
    assert.equal(await User.countDocuments(), 1, "no duplicate");

    await clearLimits();
    const later = await phoneSignIn("6315550161");
    assert.equal(later.body.status, "signed_in", "from now on the phone alone signs them in");
    assert.equal(later.body.user.userId, existing.userId);
  });

  await test("or their password: sign in with the link token and the phone is joined", async () => {
    const existing = await makePasswordCustomer({ phone: "+16315550162" });
    const link = await phoneSignIn("6315550162");
    const login = await post("/api/auth/login", { email: existing.email, password: "correct horse", linkToken: link.body.linkToken });
    assert.equal(login.status, 200);
    assert.equal(login.body.linkedPhone, true);
    assert.ok((await User.findById(existing._id).lean()).phoneVerifiedAt);
  });

  await test("'This isn't me' creates a separate account and leaves theirs untouched", async () => {
    const existing = await makePasswordCustomer({ phone: "+16315550163" });
    const link = await phoneSignIn("6315550163");
    const res = await post("/api/auth/otp/phone/new-account", { linkToken: link.body.linkToken });
    assert.equal(res.body.created, true);
    assert.notEqual(res.body.user.userId, existing.userId);
    assert.equal((await User.findById(existing._id).lean()).phoneVerifiedAt, null);
    const bad = await post("/api/auth/otp/phone/new-account", { linkToken: "forged" });
    assert.equal(bad.body.code, "LINK_EXPIRED");
  });

  await test("a household sharing one verified phone chooses which account to open", async () => {
    const sam = await makePasswordCustomer({ name: "Sam Carter", phone: "+16315550164", phoneVerifiedAt: new Date() });
    const alex = await makePasswordCustomer({ name: "Alex Carter", phone: "+16315550164", phoneVerifiedAt: new Date() });
    const res = await phoneSignIn("6315550164");
    assert.equal(res.body.status, "choose_account");
    assert.equal(res.body.token, undefined, "no session until they choose");
    assert.deepEqual(res.body.accounts.map((a) => a.label).sort(), ["Alex", "Sam"]);
    const pick = await post("/api/auth/otp/phone/choose", { choiceToken: res.body.choiceToken, accountId: String(alex._id) });
    assert.equal(pick.body.status, "signed_in");
    assert.equal(pick.body.user.userId, alex.userId);
    const stranger = await makePasswordCustomer({ phone: "+16315550199", phoneVerifiedAt: new Date() });
    const sneaky = await post("/api/auth/otp/phone/choose", { choiceToken: res.body.choiceToken, accountId: String(stranger._id) });
    assert.equal(sneaky.status, 400, "the choice is limited to accounts that verified this phone");
    assert.ok(sam);
  });

  await test("a second household member can verify the same phone on their own account", async () => {
    await makePasswordCustomer({ phone: "+16315550165", phoneVerifiedAt: new Date() });
    const partner = await emailSignIn("partner@example.com");
    await clearLimits();
    await post("/api/auth/otp/phone/start", { phone: "6315550165", smsTransactionalConsent: true });
    const attach = await post("/api/auth/otp/phone/verify", { phone: "6315550165", code: lastCode("+16315550165"), mode: "attach" }, partner.body.token);
    assert.equal(attach.body.status, "attached");
    assert.equal(attach.body.user.phoneVerified, true);
  });

  await test("existing email/password customers keep signing in exactly as before", async () => {
    const existing = await makePasswordCustomer();
    const login = await post("/api/auth/login", { email: existing.email, password: "correct horse" });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.hasPassword, true);
    const wrong = await post("/api/auth/login", { email: existing.email, password: "nope" });
    assert.equal(wrong.status, 400);
  });

  console.log("\n--- email code");

  await test("new customer by email code: verified email, no password, no address", async () => {
    const res = await emailSignIn("New.Person@Example.com");
    assert.equal(res.body.created, true);
    assert.equal(res.body.user.email, "new.person@example.com");
    assert.equal(res.body.user.emailVerified, true);
    assert.equal(res.body.user.hasPassword, false);
    assert.equal(res.body.user.phone, "");
  });

  await test("an existing customer's email code opens their account, and the password still works", async () => {
    const existing = await makePasswordCustomer();
    const res = await emailSignIn(existing.email);
    assert.equal(res.body.created, false);
    assert.equal(res.body.user.userId, existing.userId);
    const login = await post("/api/auth/login", { email: existing.email, password: "correct horse" });
    assert.equal(login.status, 200);
  });

  console.log("\n--- Google");

  await test("Google with a verified email links to the existing customer", async () => {
    const existing = await makePasswordCustomer({ email: "g.user@example.com" });
    googleIdentities.set("tok-1", { provider: "google", sub: "g-1", email: "g.user@example.com", emailVerified: true, name: "G User" });
    const res = await post("/api/auth/google", { idToken: "tok-1" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.created, false);
    assert.equal(res.body.user.userId, existing.userId);
    const after = await User.findById(existing._id).lean();
    assert.equal(after.googleId, "g-1");
    assert.ok(after.password, "password sign-in still possible");
  });

  await test("Google with an UNVERIFIED email never links; it gets its own account", async () => {
    await makePasswordCustomer({ email: "victim@example.com" });
    googleIdentities.set("tok-2", { provider: "google", sub: "g-2", email: "", emailVerified: false, name: "Mallory" });
    const res = await post("/api/auth/google", { idToken: "tok-2" });
    assert.equal(res.body.created, true);
    assert.equal(res.body.user.email, "");
    assert.equal(await User.countDocuments({ email: "victim@example.com", googleId: { $exists: true } }), 0);
  });

  await test("a returning Google customer is found by Google id; a forged token is refused", async () => {
    googleIdentities.set("tok-3", { provider: "google", sub: "g-3", email: "new.g@example.com", emailVerified: true, name: "New G" });
    const first = await post("/api/auth/google", { idToken: "tok-3" });
    assert.equal(first.body.created, true);
    const again = await post("/api/auth/google", { idToken: "tok-3" });
    assert.equal(again.body.created, false);
    assert.equal(again.body.user.userId, first.body.user.userId);
    const forged = await post("/api/auth/google", { idToken: "made-up" });
    assert.equal(forged.status, 401);
  });

  await test("an account linked to one Google account is never taken over by a different one", async () => {
    const existing = await makePasswordCustomer({ email: "linked@example.com", googleId: "g-original" });
    googleIdentities.set("tok-other", { provider: "google", sub: "g-other", email: "linked@example.com", emailVerified: true, name: "Other" });
    const res = await post("/api/auth/google", { idToken: "tok-other" });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "IDENTIFIER_IN_USE");
    assert.equal((await User.findById(existing._id).lean()).googleId, "g-original", "the original link is untouched");
    assert.equal(res.body.token, undefined);
  });

  console.log("\n--- Apple");

  await test("new Apple customer with Hide My Email: relay address kept and marked", async () => {
    const idToken = appleToken({ sub: "apple-1", email: "abc123@privaterelay.appleid.com", email_verified: "true", is_private_email: "true" });
    const res = await post("/api/auth/apple", { idToken, rawNonce: "nonce-1", name: { firstName: "Ana", lastName: "Lee" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.created, true);
    assert.equal(res.body.user.emailIsAppleRelay, true);
    assert.equal(res.body.user.name, "Ana Lee");
  });

  await test("a returning Apple customer is found by Apple's stable id, even with no email this time", async () => {
    const first = await post("/api/auth/apple", { idToken: appleToken({ sub: "apple-2", email: "x@privaterelay.appleid.com", email_verified: true }), rawNonce: "nonce-1" });
    const again = await post("/api/auth/apple", { idToken: appleToken({ sub: "apple-2" }), rawNonce: "nonce-1" });
    assert.equal(again.body.created, false);
    assert.equal(again.body.user.userId, first.body.user.userId);
  });

  await test("Apple with a real verified email links the existing customer; a relay email never does", async () => {
    const existing = await makePasswordCustomer({ email: "real@example.com" });
    const res = await post("/api/auth/apple", { idToken: appleToken({ sub: "apple-3", email: "real@example.com", email_verified: true }), rawNonce: "nonce-1" });
    assert.equal(res.body.user.userId, existing.userId);
  });

  await test("Apple token with the wrong nonce, audience or signature is refused", async () => {
    const wrongNonce = await post("/api/auth/apple", { idToken: appleToken({ sub: "a" }), rawNonce: "different" });
    assert.equal(wrongNonce.status, 401);
    const wrongAud = await post("/api/auth/apple", { idToken: appleToken({ sub: "a" }, { aud: "com.someone.else" }), rawNonce: "nonce-1" });
    assert.equal(wrongAud.status, 401);
    const { privateKey: otherKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const forged = jwt.sign({ iss: "https://appleid.apple.com", aud: "com.profixter.web", sub: "a", nonce: crypto.createHash("sha256").update("nonce-1").digest("hex") }, otherKey, { algorithm: "RS256", keyid: "test-kid" });
    const bad = await post("/api/auth/apple", { idToken: forged, rawNonce: "nonce-1" });
    assert.equal(bad.status, 401);
    assert.equal(await User.countDocuments(), 0);
  });

  console.log("\n--- progressive profile");

  await test("a phone-only customer adds a verified email later; an email someone else owns is refused", async () => {
    const signup = await phoneSignIn("6315550170");
    const token = signup.body.token;
    await post("/api/auth/otp/email/start", { email: "mine@example.com" });
    const attach = await post("/api/auth/otp/email/verify", { email: "mine@example.com", code: lastCode("mine@example.com"), mode: "attach" }, token);
    assert.equal(attach.body.status, "attached");
    assert.equal(attach.body.user.email, "mine@example.com");
    assert.equal(attach.body.user.emailVerified, true);

    await makePasswordCustomer({ email: "taken@example.com", phone: "+16315550171" });
    await clearLimits();
    await post("/api/auth/otp/email/start", { email: "taken@example.com" });
    const taken = await post("/api/auth/otp/email/verify", { email: "taken@example.com", code: lastCode("taken@example.com"), mode: "attach" }, token);
    assert.equal(taken.status, 409);
    assert.equal(taken.body.code, "IDENTIFIER_IN_USE");
  });

  await test("attaching needs a signed-in account", async () => {
    await post("/api/auth/otp/email/start", { email: "anon@example.com" });
    const res = await post("/api/auth/otp/email/verify", { email: "anon@example.com", code: lastCode("anon@example.com"), mode: "attach" });
    assert.equal(res.status, 401);
  });

  await test("name is asked later and saved once", async () => {
    const signup = await phoneSignIn("6315550172");
    const res = await call("PATCH", "/api/users/me/profile", { name: "  Jordan   Ray " }, signup.body.token);
    assert.equal(res.body.user.name, "Jordan Ray");
    assert.equal(res.body.user.needsName, false);
  });

  await test("adding a home: verified, county derived, service area reported, duplicates merged", async () => {
    const signup = await phoneSignIn("6315550173");
    const token = signup.body.token;
    const add = await post("/api/users/me/addresses", { line1: "12 Bay Rd", city: "Sayville", state: "NY", zip: "11782", county: "Fake County" }, token);
    assert.equal(add.status, 201, JSON.stringify(add.body));
    assert.equal(add.body.serviceArea.inArea, true);
    assert.equal(add.body.serviceArea.county, "Suffolk");
    assert.equal(add.body.user.addresses.length, 1);
    assert.equal(add.body.user.defaultAddressId, add.body.address._id);
    const dup = await post("/api/users/me/addresses", { line1: "12 Bay Rd", city: "Sayville", state: "NY", zip: "11782" }, token);
    assert.equal(dup.body.deduplicated, true);
    const away = await post("/api/users/me/addresses", { line1: "5 Broadway", city: "New York", state: "NY", zip: "10004" }, token);
    assert.equal(away.status, 201, "adding a home is not restricted");
    assert.equal(away.body.serviceArea.inArea, false, "but it is reported, and booking still enforces the area");
    const incomplete = await post("/api/users/me/addresses", { line1: "", city: "Sayville", zip: "11782" }, token);
    assert.equal(incomplete.status, 400);
  });

  await test("booking asks for whatever contact detail is missing", async () => {
    assert.deepEqual(missingBookingContact({ name: "Pat", phone: "+16315550100", email: "" }), ["email"]);
    assert.deepEqual(missingBookingContact({ name: "Pat", phone: "", email: "a@b.co" }), ["phone"]);
    assert.deepEqual(missingBookingContact({ name: "", phone: "+16315550100", email: "a@b.co" }), ["name"]);
    assert.deepEqual(missingBookingContact({ name: "Pat", phone: "+16315550100", email: "a@b.co" }), []);
  });

  await test("change-password on an account without a password says what to do, not 500", async () => {
    const signup = await phoneSignIn("6315550174");
    const res = await post("/api/auth/change-password", { currentPassword: "x", newPassword: "longenough1" }, signup.body.token);
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "NO_PASSWORD");
  });

  console.log("\n--- password reset and login, hardened");

  const lastReset = (email) => [...resetMail].reverse().find((entry) => entry.target === email);

  await test("reset: works once, ends every other session, and the old password stops working", async () => {
    const user = await makePasswordCustomer({ email: "reset.me@example.com" });
    const before = await post("/api/auth/login", { email: user.email, password: "correct horse" });
    const oldSession = before.body.token;
    assert.equal((await call("GET", "/api/auth/me", null, oldSession)).status, 200);

    const sentRes = await post("/api/password-reset", { email: user.email });
    assert.equal(sentRes.body.message, "OTP sent");
    const { code, exists } = lastReset(user.email);
    assert.equal(exists, true);
    const verified = await post("/api/password-reset/verify", { email: user.email, otp: code });
    assert.ok(verified.body.token);
    const set = await post("/api/password-reset/set-password", { token: verified.body.token, password: "a brand new pass" });
    assert.equal(set.status, 200, JSON.stringify(set.body));

    assert.equal((await call("GET", "/api/auth/me", null, oldSession)).status, 401, "old sessions are ended");
    const again = await post("/api/password-reset/set-password", { token: verified.body.token, password: "another one!" });
    assert.equal(again.status, 400, "the reset token works once");
    assert.equal((await post("/api/auth/login", { email: user.email, password: "correct horse" })).status, 400);
    assert.equal((await post("/api/auth/login", { email: user.email, password: "a brand new pass" })).status, 200);
  });

  await test("reset: same answer for unknown emails, and nothing is mailed to them", async () => {
    const res = await post("/api/password-reset", { email: "stranger@example.com" });
    assert.equal(res.status, 200);
    assert.equal(res.body.message, "OTP sent");
    assert.equal(lastReset("stranger@example.com").exists, false, "delivery is told there is no account");
  });

  await test("reset: five wrong codes kill it; short passwords refused", async () => {
    const user = await makePasswordCustomer({ email: "guess@example.com" });
    await post("/api/password-reset", { email: user.email });
    const { code } = lastReset(user.email);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i += 1) await post("/api/password-reset/verify", { email: user.email, otp: wrong });
    const late = await post("/api/password-reset/verify", { email: user.email, otp: code });
    assert.equal(late.status, 400);
    await clearLimits();
    await post("/api/password-reset", { email: user.email });
    const ok = await post("/api/password-reset/verify", { email: user.email, otp: lastReset(user.email).code });
    const short = await post("/api/password-reset/set-password", { token: ok.body.token, password: "short" });
    assert.equal(short.status, 400);
  });

  await test("a sign-in code cannot reset a password, and a reset code cannot sign anybody in", async () => {
    const user = await makePasswordCustomer({ email: "kinds@example.com" });
    await post("/api/auth/otp/email/start", { email: user.email });
    const signInCode = lastCode(user.email);
    const asReset = await post("/api/password-reset/verify", { email: user.email, otp: signInCode });
    assert.equal(asReset.status, 400);
    await post("/api/password-reset", { email: user.email });
    const resetCode = lastReset(user.email).code;
    const asSignIn = await post("/api/auth/otp/email/verify", { email: user.email, code: resetCode });
    assert.equal(asSignIn.status, 400);
  });

  await test("reset requests are rate limited", async () => {
    await makePasswordCustomer({ email: "flood@example.com" });
    const first = await post("/api/password-reset", { email: "flood@example.com" });
    const second = await post("/api/password-reset", { email: "flood@example.com" });
    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
  });

  await test("password guessing on one account is stopped after 20 tries in 15 minutes", async () => {
    const user = await makePasswordCustomer({ email: "brute@example.com" });
    let last;
    for (let i = 0; i < 21; i += 1) last = await post("/api/auth/login", { email: user.email, password: `guess-${i}` });
    assert.equal(last.status, 429);
    assert.equal(last.body.code, "RATE_LIMITED");
  });

  await test("service texts can be switched on at the booking step, recorded as such; offers cannot", async () => {
    const signup = await phoneSignIn("6315550176");
    const t = signup.body.token;
    const offers = await call("PUT", "/api/users/me/sms-preferences", { marketingEnabled: true, source: "booking_step" }, t);
    assert.equal(offers.status, 400, "offers are only ever switched on in account settings");
    const on = await call("PUT", "/api/users/me/sms-preferences", { transactionalEnabled: true, source: "booking_step" }, t);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const user = await User.findOne({ phone: "+16315550176" }).lean();
    assert.equal(user.smsPreferences.transactionalEnabled, true);
    assert.equal(user.smsPreferences.transactionalConsentSource, "booking_step");
    const ConsentEvent = require("../models/ConsentEvent");
    const event = await ConsentEvent.findOne({ source: "booking_step" }).lean();
    assert.ok(event && event.purpose === "service" && event.consentVersion === "sms_service.booking.v1", "consent ledger names the booking wording");
    assert.match(event.consentText, /Text me about my visits/, "and keeps the exact words shown");
    const me = await call("GET", "/api/auth/me", null, t);
    assert.equal(me.body.smsServiceTexts, true);
  });

  await test("/me reports proof and gaps for a phone-only account", async () => {
    const signup = await phoneSignIn("6315550175");
    const me = await call("GET", "/api/auth/me", null, signup.body.token);
    assert.equal(me.status, 200);
    assert.equal(me.body.phoneVerified, true);
    assert.equal(me.body.emailVerified, false);
    assert.deepEqual(me.body.authProviders, ["phone"]);
  });
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await User.syncIndexes();
  await AuthChallenge.syncIndexes();
  await AuthRateCounter.syncIndexes();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run();
  } finally {
    server.close();
    await mongoose.disconnect();
    await mongod.stop();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
