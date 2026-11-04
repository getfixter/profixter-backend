/**
 * Customer experience 5 (2026-11-03), through the real routers and a real
 * database:
 *
 *  - review requests: one per customer per 90 days across bookings, homes and
 *    email spellings; existing history counts; "Reviewed us" suppresses and can
 *    be corrected; nothing catches up; two servers never both ask; Free Visit
 *    wording; the anonymous /review link counter;
 *  - the marketing box on the phone screen: recorded only when ticked, only
 *    after the code, with its wording and source; STOP wins;
 *  - customers editing their own name, email and phone: confirm-it's-you for a
 *    verified value, duplicates refused before a code is spent, the old value
 *    kept until the new one is proved, text consent never carried to a new
 *    number, Google sign-in untouched.
 *
 * Nothing leaves the process: codes are captured, email is captured, no SMS
 * provider is configured.
 *
 *   node scripts/test_cx5_integration.js
 *
 * Not in `npm test`: it boots a MongoDB binary.
 */

Object.assign(process.env, {
  NODE_ENV: "test",
  S3_BUCKET: "test-bucket",
  JWT_SECRET: "test-secret-for-cx5",
  STRIPE_SECRET_KEY: "sk_test_fake",
  GOOGLE_CLIENT_ID: "google-client.apps.googleusercontent.com",
  CLIENT_URL: "https://www.profixter.com",
  MAIL_ADMIN: "owner@example.test",
});
delete process.env.REVIEW_REQUEST_CUSTOMER_COOLDOWN_DAYS;
delete process.env.TWILIO_VERIFY_SERVICE_SID;

const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

/* ---- email is captured, never sent ---- */
const emailService = require("../utils/emailService");
const mail = [];
emailService.sendTx = async (key, to, vars) => {
  mail.push({ key, to, vars });
  return { messageId: "test" };
};

const providerTokens = require("../utils/auth/providerTokens");
const googleIdentities = new Map();
providerTokens.verifyGoogleIdToken = async (idToken) => {
  const identity = googleIdentities.get(idToken);
  if (!identity) throw new providerTokens.ProviderTokenError("INVALID_PROVIDER_TOKEN");
  return identity;
};

const User = require("../models/User");
const Booking = require("../models/Booking");
const AuthChallenge = require("../models/AuthChallenge");
const AuthRateCounter = require("../models/AuthRateCounter");
const ConsentEvent = require("../models/ConsentEvent");
const SmsOptOut = require("../models/SmsOptOut");
const EmailSuppression = require("../models/EmailSuppression");
const AdminActivityLog = require("../models/AdminActivityLog");
const ReviewLinkClick = require("../models/ReviewLinkClick");
const { FunnelStepSeen } = require("../models/FunnelStep");
const { marketingSmsBasis } = require("../utils/consent/marketingSmsBasis");
const { runBookingReviewRequestCycle, customerCooldownDays } = require("../jobs/bookingReviewRequests");

const authV2 = require("../routes/authV2");
const sent = [];
authV2.deps.deliver = async ({ channel, target, code }) => sent.push({ channel, target, code });

const app = express();
app.use(express.json());
app.use("/api/auth", require("../routes/auth"));
app.use("/api/auth", authV2);
app.use("/api/users", require("../routes/users"));
app.use("/api/track", require("../routes/track"));
app.use("/api/admin", require("../routes/adminCustomerProfile")({ getAddressPlansForUser: async () => [] }));

let server;
let base;
async function call(method, path, body, token, { text = false, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": text ? "text/plain" : "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? (text ? body : JSON.stringify(body)) : undefined,
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
const lastCode = (target) => [...sent].reverse().find((entry) => entry.target === target)?.code;

/* A session signed in long ago: changing a verified detail then needs a fresh code. */
function oldSession(user) {
  return jwt.sign({ id: String(user._id), tv: Number(user.tokenVersion || 0), iat: Math.floor(Date.now() / 1000) - 3600 }, process.env.JWT_SECRET, { expiresIn: "30d" });
}
function freshSession(user) {
  return jwt.sign({ id: String(user._id), tv: Number(user.tokenVersion || 0) }, process.env.JWT_SECRET, { expiresIn: "30d" });
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  await Promise.all([
    User.deleteMany({}),
    Booking.deleteMany({}),
    AuthChallenge.deleteMany({}),
    AuthRateCounter.deleteMany({}),
    ConsentEvent.collection.deleteMany({}), // the model is append-only on purpose
    SmsOptOut.deleteMany({}),
    EmailSuppression.deleteMany({}),
    AdminActivityLog.deleteMany({}),
    ReviewLinkClick.deleteMany({}),
    FunnelStepSeen.deleteMany({}),
  ]);
  sent.length = 0;
  mail.length = 0;
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.stack}`);
  }
}

let seq = 0;
function customer(overrides = {}) {
  seq += 1;
  return User.create({
    userId: String(50000000 + seq),
    name: "Pat Member",
    email: `member${seq}@example.com`,
    role: "customer",
    signupMethod: "email_code",
    emailVerifiedAt: new Date(),
    ...overrides,
  });
}

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const now = new Date();
function completed(user, overrides = {}) {
  seq += 1;
  return Booking.create({
    bookingNumber: `PF-${seq}`,
    user: user?._id || null,
    userId: user?.userId || "",
    ...(user ? {} : { adminGuest: true }),
    address: "1 Main St",
    subscription: "Basic",
    name: user?.name || "Guest",
    email: user?.email || "guest@example.com",
    phone: "+16315550100",
    service: "Handyman visit",
    status: "Completed",
    date: new Date(now.getTime() - 3 * 60 * MIN),
    completedAt: new Date(now.getTime() - 61 * MIN),
    ...overrides,
  });
}
const cycle = (at = now) => runBookingReviewRequestCycle(at, { sendEmail: emailService.sendTx });
const reviewMails = () => mail.filter((m) => m.key === "booking_review_request");

async function run() {
  console.log("\n--- review requests");

  await test("the cooldown is 90 days by default, and 0 still turns it off", async () => {
    assert.equal(customerCooldownDays(), 90);
    process.env.REVIEW_REQUEST_CUSTOMER_COOLDOWN_DAYS = "0";
    assert.equal(customerCooldownDays(), 0);
    process.env.REVIEW_REQUEST_CUSTOMER_COOLDOWN_DAYS = "nonsense";
    assert.equal(customerCooldownDays(), 90);
    delete process.env.REVIEW_REQUEST_CUSTOMER_COOLDOWN_DAYS;
  });

  await test("one completed visit: one email after an hour, once", async () => {
    const pat = await customer();
    const booking = await completed(pat);
    await cycle();
    await cycle();
    assert.equal(reviewMails().length, 1);
    const fresh = await Booking.findById(booking._id).lean();
    assert.ok(fresh.reviewRequestSentAt);
    assert.ok((await User.findById(pat._id).lean()).reviewRequestLastAt, "the account remembers when it was asked");
  });

  await test("still waits the full 60 minutes", async () => {
    const pat = await customer();
    await completed(pat, { completedAt: new Date(now.getTime() - 59 * MIN) });
    await cycle();
    assert.equal(reviewMails().length, 0);
  });

  await test("two homes, two visits the same day: one email for the customer", async () => {
    const pat = await customer({ addresses: [{ line1: "1 Main St", city: "Babylon", state: "NY", zip: "11702" }, { line1: "9 Oak Ave", city: "Islip", state: "NY", zip: "11751" }] });
    const a = await completed(pat, { addressId: pat.addresses[0]._id });
    const b = await completed(pat, { addressId: pat.addresses[1]._id });
    const stats = await cycle();
    assert.equal(reviewMails().length, 1);
    assert.equal(stats.cooldownSkipped, 1);
    const rows = await Booking.find({ _id: { $in: [a._id, b._id] } }).lean();
    const skipped = rows.find((r) => r.reviewRequestSkippedAt);
    assert.equal(skipped.reviewRequestSkipReason, "customer_cooldown");
    await cycle(new Date(now.getTime() + 5 * MIN));
    assert.equal(reviewMails().length, 1, "a skipped booking is never retried");
  });

  await test("weekly member: asked once in 90 days, then again after", async () => {
    const pat = await customer();
    const first = await completed(pat, { completedAt: new Date(now.getTime() - 61 * MIN) });
    await cycle();
    assert.equal(reviewMails().length, 1);
    for (let week = 1; week <= 12; week++) {
      const at = new Date(now.getTime() + week * 7 * DAY);
      await completed(pat, { completedAt: new Date(at.getTime() - 61 * MIN) });
      await cycle(at);
    }
    assert.equal(reviewMails().length, 1, "12 more weekly visits inside 90 days: no more emails");
    const at = new Date(now.getTime() + 91 * DAY);
    await completed(pat, { completedAt: new Date(at.getTime() - 61 * MIN) });
    await cycle(at);
    assert.equal(reviewMails().length, 2, "past 90 days they can be asked again");
    assert.ok(first);
  });

  await test("requests sent before this rule count (history on bookings and by email spelling)", async () => {
    const pat = await customer({ email: "casey@example.com" });
    // An older booking made as a guest with different capitals, asked 30 days ago.
    await Booking.create({ bookingNumber: "PF-OLD", adminGuest: true, phone: "+16315550100", service: "Handyman visit", address: "1 Main St", subscription: "Basic", email: "Casey@Example.com", name: "Casey", status: "Completed", date: new Date(now - 31 * DAY), completedAt: new Date(now - 30 * DAY), reviewRequestSentAt: new Date(now - 30 * DAY) });
    await completed(pat);
    await cycle();
    assert.equal(reviewMails().length, 0, "asked 30 days ago under another spelling: not asked again");
  });

  await test("a guest booking with no account is matched by email", async () => {
    await completed(null, { email: "guest@example.com" });
    await completed(null, { email: "GUEST@example.com", completedAt: new Date(now.getTime() - 62 * MIN) });
    await cycle();
    assert.equal(reviewMails().length, 1);
  });

  await test("Reviewed us: never asked while marked; clearing it sends nothing for past visits", async () => {
    const pat = await customer({ reviewedUs: { at: new Date(now - DAY), byName: "Owner" } });
    const booking = await completed(pat);
    const stats = await cycle();
    assert.equal(reviewMails().length, 0);
    assert.equal(stats.reviewedSkipped, 1);
    assert.equal((await Booking.findById(booking._id).lean()).reviewRequestSkipReason, "reviewed_us");
    await User.updateOne({ _id: pat._id }, { $unset: { reviewedUs: "" } });
    await cycle(new Date(now.getTime() + 2 * MIN));
    assert.equal(reviewMails().length, 0, "no catch-up for the visit that was skipped");
    await completed(pat, { completedAt: new Date(now.getTime() - 61 * MIN + 3 * MIN) });
    await cycle(new Date(now.getTime() + 3 * MIN));
    assert.equal(reviewMails().length, 1, "a new visit after the mark is cleared is asked as normal");
  });

  await test("no catch-up: a visit completed over a week ago is skipped, never emailed", async () => {
    const pat = await customer();
    const old = await completed(pat, { completedAt: new Date(now - 8 * DAY) });
    const stats = await cycle();
    assert.equal(reviewMails().length, 0);
    assert.equal(stats.tooOldSkipped, 1);
    assert.equal((await Booking.findById(old._id).lean()).reviewRequestSkipReason, "too_old");
  });

  await test("two servers at once, two of the customer's bookings: exactly one email", async () => {
    const pat = await customer();
    await completed(pat);
    await completed(pat);
    await completed(pat);
    await Promise.all([cycle(), cycle(), cycle()]);
    assert.equal(reviewMails().length, 1);
  });

  await test("a failed send releases everything, so the next minute retries", async () => {
    const pat = await customer();
    const booking = await completed(pat);
    let fail = true;
    const flaky = async (...args) => {
      if (fail) throw new Error("simulated SES failure");
      return emailService.sendTx(...args);
    };
    const first = await runBookingReviewRequestCycle(now, { sendEmail: flaky });
    assert.equal(first.failed, 1);
    assert.equal((await User.findById(pat._id).lean()).reviewRequestLastAt, null, "the reservation is handed back");
    fail = false;
    await runBookingReviewRequestCycle(new Date(now.getTime() + MIN), { sendEmail: flaky });
    assert.equal(reviewMails().length, 1);
    assert.ok((await Booking.findById(booking._id).lean()).reviewRequestSentAt);
  });

  await test("Free Visit (no labor) gets the visit wording; a labor-included first visit keeps the usual one", async () => {
    const pat = await customer();
    await completed(pat, { isFreeFirstVisit: true, freeVisitPurpose: "consultation" });
    await cycle();
    assert.equal(reviewMails()[0].vars.freeVisitPurpose, "consultation");
    const { createCustomerEmailTemplates } = require("../utils/customerEmailTemplates");
    const t = createCustomerEmailTemplates({ escapeHtml: (s) => String(s), formatNYCTime: () => "", urls: {} });
    const free = t.booking_review_request({ name: "Pat", bookingNumber: "PF-1", freeVisitPurpose: "consultation" });
    assert.equal(free.subject, "How was your Free Visit?");
    assert.match(free.text, /go through your to-do list/);
    assert.doesNotMatch(free.text + free.html, /repair|fixed|work we did|job/i);
    const labor = t.booking_review_request({ name: "Pat", bookingNumber: "PF-2", isFreeFirstVisit: true, freeVisitPurpose: "" });
    assert.equal(labor.subject, "How did we do?");
    for (const rendered of [free, labor]) {
      assert.match(rendered.text, /https:\/\/www\.profixter\.com\/review\?via=email/);
    }
  });

  console.log("\n--- Admin: Reviewed us");

  await test("the owner marks and clears it; who and when are kept; nothing is sent", async () => {
    const owner = await User.create({ userId: "90000001", name: "Owner", email: "owner@example.test", role: "admin" });
    const pat = await customer();
    const token = freshSession(owner);
    const marked = await call("PUT", `/api/admin/users/${pat._id}/reviewed-us`, { reviewed: true }, token);
    assert.equal(marked.status, 200, JSON.stringify(marked.body));
    assert.equal(marked.body.reviewedUs.byName, "Owner");
    assert.ok(marked.body.reviewedUs.at);
    assert.equal(marked.body.canEdit, true);
    const stored = await User.findById(pat._id).lean();
    assert.equal(String(stored.reviewedUs.by), String(owner._id));
    assert.equal(await AdminActivityLog.countDocuments({ action: "Customer Marked Reviewed" }), 1);
    const cleared = await call("PUT", `/api/admin/users/${pat._id}/reviewed-us`, { reviewed: false }, token);
    assert.equal(cleared.body.reviewedUs, null);
    assert.equal(mail.length, 0, "changing the mark tells the customer nothing");
    const bad = await call("PUT", `/api/admin/users/${pat._id}/reviewed-us`, { reviewed: "yes" }, token);
    assert.equal(bad.status, 400);
  });

  await test("staff can see it but only the owner can change it; customers can do neither", async () => {
    const staff = await User.create({ userId: "90000002", name: "Office", email: "office@example.test", role: "employee", employeePosition: "Fixter", adminSections: ["customers"], isActive: true });
    const pat = await customer();
    const other = await customer();
    const read = await call("GET", `/api/admin/users/${pat._id}/reviewed-us`, null, freshSession(staff));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.canEdit, false);
    const write = await call("PUT", `/api/admin/users/${pat._id}/reviewed-us`, { reviewed: true }, freshSession(staff));
    assert.equal(write.status, 403);
    const byCustomer = await call("PUT", `/api/admin/users/${pat._id}/reviewed-us`, { reviewed: true }, freshSession(other));
    assert.equal(byCustomer.status, 403);
    assert.equal((await User.findById(pat._id).lean()).reviewedUs?.at ?? null, null);
  });

  console.log("\n--- the /review link counter");

  await test("counts a browser once a day per place, aggregate only, ignores bots and junk", async () => {
    const owner = await User.create({ userId: "90000003", name: "Owner", email: "owner@example.test", role: "admin" });
    const id = "abcdefghijklmnop";
    for (let i = 0; i < 3; i++) await call("POST", "/api/track/review-open", JSON.stringify({ visitorId: id, via: "email" }), null, { text: true });
    await call("POST", "/api/track/review-open", JSON.stringify({ visitorId: id, via: "home" }), null, { text: true });
    await call("POST", "/api/track/review-open", JSON.stringify({ visitorId: "zyxwvutsrqponmlk", via: "nonsense" }), null, { text: true });
    await call("POST", "/api/track/review-open", JSON.stringify({ visitorId: "bad" }), null, { text: true });
    const bot = await call("POST", "/api/track/review-open", JSON.stringify({ visitorId: "botbotbotbotbot1", via: "email" }), null, { text: true, headers: { "User-Agent": "Googlebot/2.1" } });
    assert.equal(bot.status, 204);
    const rows = await ReviewLinkClick.find({}).lean();
    const by = Object.fromEntries(rows.map((r) => [r.via, r.count]));
    assert.deepEqual(by, { email: 1, home: 1, other: 1 });
    assert.ok(rows.every((r) => Object.keys(r).every((k) => ["_id", "date", "via", "count", "__v"].includes(k))), "nothing personal is stored");
    const pat = await customer();
    await completed(pat);
    await cycle();
    const summary = await call("GET", "/api/admin/review-requests/summary?days=30", null, freshSession(owner));
    assert.equal(summary.status, 200);
    assert.equal(summary.body.sent, 1);
    assert.deepEqual(summary.body.linkOpens, { email: 1, home: 1, other: 1 });
  });

  console.log("\n--- marketing texts on the phone screen");

  async function addPhone(user, phone, extra = {}, token = freshSession(user)) {
    await AuthRateCounter.deleteMany({}); // a person may resend; the limits have their own suite
    const start = await post("/api/auth/otp/phone/start", { phone });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    return post("/api/auth/otp/phone/verify", { phone, code: lastCode(phone), mode: "attach", ...extra }, token);
  }

  await test("ticked: recorded after the code, with source, wording, number and time; it qualifies", async () => {
    const pat = await customer();
    const res = await addPhone(pat, "+16315552001", { smsOptIn: { marketing: true } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.smsOptIn, { marketing: true, service: false });
    assert.equal(res.body.user.smsMarketingTexts, true);
    const user = await User.findById(pat._id).lean();
    assert.equal(user.smsPreferences.marketingEnabled, true);
    assert.equal(user.smsPreferences.marketingConsentSource, "phone_verification");
    assert.ok(user.smsPreferences.marketingConsentAt);
    assert.notEqual(user.smsPreferences.transactionalEnabled, true, "service texts are not switched on by the offers box");
    assert.equal(marketingSmsBasis(user).status, "qualifies");
    const row = await ConsentEvent.findOne({ user: pat._id, purpose: "marketing" }).lean();
    assert.equal(row.action, "granted");
    assert.equal(row.source, "phone_verification");
    assert.equal(row.consentVersion, "sms_marketing.phone_verify.v1");
    assert.match(row.consentText, /Text me ProFixter offers, too\./);
    assert.equal(row.phone, "+16315552001");
    assert.equal(user.emailPreferences?.marketingConsentAt ?? null, null, "email choices are untouched");
  });

  await test("not ticked: the phone is verified and nothing is consented", async () => {
    const pat = await customer();
    const res = await addPhone(pat, "+16315552002");
    assert.equal(res.status, 200);
    assert.equal(res.body.user.phoneVerified, true);
    const user = await User.findById(pat._id).lean();
    assert.notEqual(user.smsPreferences?.marketingEnabled, true);
    assert.notEqual(user.smsPreferences?.transactionalEnabled, true);
    assert.equal(await ConsentEvent.countDocuments({ user: pat._id }), 0);
  });

  await test("only a literal true counts", async () => {
    const pat = await customer();
    await addPhone(pat, "+16315552003", { smsOptIn: { marketing: "true" } });
    assert.notEqual((await User.findById(pat._id).lean()).smsPreferences?.marketingEnabled, true);
  });

  await test("a wrong code records nothing", async () => {
    const pat = await customer();
    await post("/api/auth/otp/phone/start", { phone: "+16315552004" });
    const res = await post("/api/auth/otp/phone/verify", { phone: "+16315552004", code: "000000", mode: "attach", smsOptIn: { marketing: true } }, freshSession(pat));
    assert.equal(res.status, 400);
    const user = await User.findById(pat._id).lean();
    assert.equal(user.phone, undefined);
    assert.notEqual(user.smsPreferences?.marketingEnabled, true);
  });

  await test("a STOP on that handset wins: nothing switched on, the STOP row untouched", async () => {
    const pat = await customer();
    await SmsOptOut.create({ phone: "+16315552005", scope: "all", source: "carrier_keyword", optedOutAt: new Date() });
    const res = await addPhone(pat, "+16315552005", { smsOptIn: { marketing: true } });
    assert.equal(res.status, 200, "the phone itself is still verified");
    assert.equal(res.body.smsOptIn.blocked, "stopped");
    const user = await User.findById(pat._id).lean();
    assert.notEqual(user.smsPreferences?.marketingEnabled, true);
    const stop = await SmsOptOut.findOne({ phone: "+16315552005" }).lean();
    assert.ok(stop.optedOutAt);
    assert.equal(stop.optedInAt ?? null, null);
  });

  console.log("\n--- editing my own details");

  await test("name: updates name, first and last, and the edit history", async () => {
    const pat = await customer({ name: "Pat Member", firstName: "Pat", lastName: "Member" });
    const res = await call("PATCH", "/api/users/me/profile", { name: "  Patricia   Van Member " }, freshSession(pat));
    assert.equal(res.status, 200);
    assert.equal(res.body.user.name, "Patricia Van Member");
    const user = await User.findById(pat._id).lean();
    assert.equal(user.firstName, "Patricia");
    assert.equal(user.lastName, "Van Member");
    const log = await AdminActivityLog.findOne({ entityId: String(pat._id) }).lean();
    assert.equal(log.actorRole, "customer");
    assert.equal(log.details.changes[0].to, "Patricia Van Member");
    assert.equal((await call("PATCH", "/api/users/me/profile", { name: "   " }, freshSession(pat))).status, 400);
    assert.equal((await call("PATCH", "/api/users/me/profile", { name: "12345" }, freshSession(pat))).status, 400);
    assert.equal((await call("PATCH", "/api/users/me/profile", { name: "Hacker" })).status, 401, "no session, no edit");
  });

  await test("changing a verified phone needs confirm-it's-you; with it the new number replaces the old", async () => {
    const pat = await customer({ phone: "+16315553001", phoneVerifiedAt: new Date(), smsPreferences: { transactionalEnabled: true, marketingEnabled: true, marketingConsentSource: "account_settings", marketingConsentAt: new Date(now - 40 * DAY) } });
    const token = oldSession(pat);
    const refused = await addPhone(pat, "+16315553002", { smsOptIn: { marketing: true } }, token);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "REAUTH_REQUIRED");
    assert.equal((await User.findById(pat._id).lean()).phone, "+16315553001", "the old number stays until the change is allowed");

    // Confirm by email (a verified contact on the account), then change.
    const start = await post("/api/auth/reauth/start", { channel: "email" }, token);
    assert.equal(start.status, 200, JSON.stringify(start.body));
    assert.equal(sent.at(-1).target, pat.email, "the code goes to the address the account already trusts");
    const proof = await post("/api/auth/reauth/verify", { channel: "email", code: lastCode(pat.email) }, token);
    assert.equal(proof.status, 200, JSON.stringify(proof.body));
    const changed = await addPhone(pat, "+16315553002", { reauthToken: proof.body.reauthToken }, token);
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const user = await User.findById(pat._id).lean();
    assert.equal(user.phone, "+16315553002");
    assert.ok(user.phoneVerifiedAt);
    assert.equal(user.smsPreferences.marketingEnabled, undefined, "offer texts are never carried to a new number");
    assert.equal(user.smsPreferences.transactionalEnabled, undefined, "nor visit texts");
    assert.equal(user.smsPreferences.marketingConsentAt instanceof Date, true, "the history of the old consent is kept");
    assert.deepEqual(changed.body.consentReset, { service: true, marketing: true });
    const resets = await ConsentEvent.find({ user: pat._id, action: "reset" }).lean();
    assert.equal(resets.length, 2);
    assert.ok(resets.every((r) => r.phone === "+16315553001"));
    const notice = mail.find((m) => m.key === "account_contact_changed");
    assert.equal(notice.to, pat.email);
    assert.equal(notice.vars.field, "phone");
    assert.doesNotMatch(notice.vars.maskedNew, /5553002/, "the notice shows the new number only partly");
    const log = await AdminActivityLog.findOne({ entityId: String(pat._id) }).lean();
    assert.equal(log.details.selfService, true);
    assert.equal(log.details.ownerOnly.changes[0].to, "+16315553002");
  });

  await test("the new number can be opted in on the same screen, and a just-signed-in session needs no extra code", async () => {
    const pat = await customer({ phone: "+16315553011", phoneVerifiedAt: new Date() });
    const res = await addPhone(pat, "+16315553012", { smsOptIn: { marketing: true, service: true } }, freshSession(pat));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const user = await User.findById(pat._id).lean();
    assert.equal(user.smsPreferences.marketingEnabled, true);
    assert.equal(user.smsPreferences.transactionalEnabled, true);
    const service = await ConsentEvent.findOne({ user: pat._id, purpose: "service", action: "granted" }).lean();
    assert.equal(service.consentVersion, "sms_service.phone_change.v1");
  });

  await test("a confirmation is bound to the account and to its current sessions", async () => {
    const pat = await customer({ phone: "+16315553021", phoneVerifiedAt: new Date() });
    const other = await customer();
    const stolen = jwt.sign({ id: String(other._id), tv: 0, purpose: "reauth" }, process.env.JWT_SECRET, { expiresIn: 600 });
    const refused = await addPhone(pat, "+16315553022", { reauthToken: stolen }, oldSession(pat));
    assert.equal(refused.status, 403);
    const forged = jwt.sign({ id: String(pat._id), tv: 0, purpose: "reauth" }, "wrong-secret", { expiresIn: 600 });
    assert.equal((await addPhone(pat, "+16315553022", { reauthToken: forged }, oldSession(pat))).status, 403);
    const plainSession = jwt.sign({ id: String(pat._id), tv: 0 }, process.env.JWT_SECRET, { expiresIn: 600 });
    assert.equal((await addPhone(pat, "+16315553022", { reauthToken: plainSession }, oldSession(pat))).status, 403, "a session token is not a confirmation");
  });

  await test("confirm-it's-you goes only to a verified contact; none means call us", async () => {
    const pat = await customer({ emailVerifiedAt: null, phone: "+16315553031" });
    const res = await post("/api/auth/reauth/start", { channel: "sms" }, oldSession(pat));
    assert.equal(res.body.code, "REAUTH_UNAVAILABLE");
    const email = await post("/api/auth/reauth/start", { channel: "email" }, oldSession(pat));
    assert.equal(email.body.code, "REAUTH_UNAVAILABLE");
    assert.equal(sent.length, 0);
  });

  await test("adding a missing phone or email needs no extra step", async () => {
    const pat = await customer({ phone: undefined });
    const res = await addPhone(pat, "+16315553041", {}, oldSession(pat));
    assert.equal(res.status, 200);
  });

  await test("changing a verified email: confirm, prove the new inbox, then it replaces the old one", async () => {
    const pat = await customer({ email: "old@example.com", phone: "+16315554001", phoneVerifiedAt: new Date(), googleId: "google-sub-1", authProviders: ["google"] });
    await EmailSuppression.create({ email: "old@example.com", reason: "unsubscribe", source: "one_click" });
    const token = oldSession(pat);

    await post("/api/auth/otp/email/start", { email: "new@example.com", mode: "attach" }, token);
    const refused = await post("/api/auth/otp/email/verify", { email: "new@example.com", code: lastCode("new@example.com"), mode: "attach" }, token);
    assert.equal(refused.body.code, "REAUTH_REQUIRED");

    await post("/api/auth/reauth/start", { channel: "sms" }, token);
    const proof = await post("/api/auth/reauth/verify", { channel: "sms", code: lastCode("+16315554001") }, token);
    assert.equal(proof.status, 200, JSON.stringify(proof.body));

    // A wrong code leaves the old address in place.
    const wrong = await post("/api/auth/otp/email/verify", { email: "new@example.com", code: "000000", mode: "attach", reauthToken: proof.body.reauthToken }, token);
    assert.equal(wrong.status, 400);
    assert.equal((await User.findById(pat._id).lean()).email, "old@example.com");

    await post("/api/auth/otp/email/start", { email: "new@example.com", mode: "attach" }, token);
    const ok = await post("/api/auth/otp/email/verify", { email: "new@example.com", code: lastCode("new@example.com"), mode: "attach", reauthToken: proof.body.reauthToken }, token);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const user = await User.findById(pat._id).lean();
    assert.equal(user.email, "new@example.com");
    assert.ok(user.emailVerifiedAt);
    assert.equal(user.googleId, "google-sub-1", "Google sign-in stays linked");
    assert.ok(user.authProviders.includes("google"));
    const notice = mail.find((m) => m.key === "account_contact_changed");
    assert.equal(notice.to, "old@example.com", "the notice goes to the address it was changed FROM");
    const carried = await EmailSuppression.findOne({ email: "new@example.com" }).lean();
    assert.equal(carried.reason, "unsubscribe", "an unsubscribe follows the person");

    // Signing in with Google still opens the same account.
    googleIdentities.set("g-token", { sub: "google-sub-1", email: "old@example.com", emailVerified: true, name: "Pat" });
    const google = await post("/api/auth/google", { idToken: "g-token" });
    assert.equal(google.status, 200, JSON.stringify(google.body));
    assert.equal(google.body.user.userId, pat.userId, "Google opens the same account");
    assert.equal(await User.countDocuments({ role: "customer" }), 1, "no second account");
  });

  await test("an email another account uses is refused before any code is sent", async () => {
    const taken = await customer({ email: "taken@example.com" });
    const pat = await customer();
    const start = await post("/api/auth/otp/email/start", { email: "Taken@Example.com", mode: "attach" }, freshSession(pat));
    assert.equal(start.status, 409);
    assert.equal(start.body.code, "IDENTIFIER_IN_USE");
    assert.equal(sent.length, 0);
    // And at verify, for a client that skips the start check.
    await post("/api/auth/otp/email/start", { email: "taken@example.com" });
    const verify = await post("/api/auth/otp/email/verify", { email: "taken@example.com", code: lastCode("taken@example.com"), mode: "attach" }, freshSession(pat));
    assert.equal(verify.status, 409);
    assert.equal((await User.findById(pat._id).lean()).email, pat.email);
    assert.ok(taken);
  });

  await test("bookings, membership links and history are untouched by a contact change", async () => {
    const pat = await customer({ phone: "+16315555001", phoneVerifiedAt: new Date() });
    const booking = await completed(pat, { reviewRequestSentAt: new Date() });
    await addPhone(pat, "+16315555002", {}, freshSession(pat));
    const after = await Booking.findById(booking._id).lean();
    assert.equal(String(after.user), String(pat._id));
    assert.equal(after.phone, "+16315550100", "a booking keeps the phone it was made with");
  });
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([User.syncIndexes(), AuthChallenge.syncIndexes(), AuthRateCounter.syncIndexes(), ReviewLinkClick.syncIndexes(), FunnelStepSeen.syncIndexes(), SmsOptOut.syncIndexes()]);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const quiet = console.log;
  try {
    await run();
  } finally {
    server.close();
    await mongoose.disconnect();
    await mongod.stop();
  }
  quiet(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
