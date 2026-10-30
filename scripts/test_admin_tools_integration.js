/*
 * Admin tools, end to end (2026-10-30): create a customer by phone, their
 * temporary password, communication switches, selling a membership (pay by
 * phone and payment link), and creating visits of all four kinds for a
 * customer or a guest, with photos.
 *
 * Real routes, real database (in-memory replica set, reservation engine ON as
 * in production), real signed Stripe webhooks. Stripe's API, S3 and outgoing
 * email are faked; SMS is rendered and recorded but never sent. Nothing leaves
 * the machine and nobody is charged.
 *
 *   node scripts/test_admin_tools_integration.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-admin-tools";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_for_unit_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_admin_tools";
process.env.CLIENT_URL = "https://www.profixter.com";
process.env.SMS_ENABLED = "false";
process.env.S3_BUCKET = "test-bucket";
process.env.ENABLE_RESERVATION_ENGINE = "true";
process.env.STRIPE_PRICE_ONE_TIME_HANDYMAN_VISIT = "price_test_one_time";
process.env.STRIPE_PRICE_FULL_DAY_VISIT = "price_test_full_day";
process.env.MAIL_ADMIN = "owner@example.test";

const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const sharp = require("sharp");

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
const stored = [];
stub("../utils/s3", {
  async putPublicObject({ Key }) {
    stored.push(Key);
    return `https://test-bucket.s3.amazonaws.com/${Key}`;
  },
  async deletePublicObjects() {
    return { deleted: 0 };
  },
});
const sentEmails = [];
const realMail = require("../utils/emailService");
stub("../utils/emailService", {
  ...realMail,
  async sendTx(templateKey, to, vars) {
    sentEmails.push({ templateKey, to, vars });
    return { messageId: `fake-${sentEmails.length}` };
  },
  async sendRaw({ to, subject, text, logContext = {} }) {
    sentEmails.push({ templateKey: logContext.templateKey || "raw", to, subject, text });
    return { messageId: `fake-${sentEmails.length}` };
  },
  async sendPromo(to, { subject, logContext = {} }) {
    sentEmails.push({ templateKey: logContext.templateKey || "promo", to, subject });
    return { messageId: `fake-${sentEmails.length}` };
  },
});

const { MongoMemoryReplSet } = require("mongodb-memory-server");
const subsModule = require("../utils/subscriptionManagement");
const User = require("../models/User");
const Booking = require("../models/Booking");
const Subscription = require("../models/Subscription");
const SmsMessage = require("../models/SmsMessage");
const SmsOptOut = require("../models/SmsOptOut");
const ConsentEvent = require("../models/ConsentEvent");
const AdminActivityLog = require("../models/AdminActivityLog");
const AdminPaymentLink = require("../models/AdminPaymentLink");
const VisitEntitlement = require("../models/VisitEntitlement");
const StripeWebhookEvent = require("../models/StripeWebhookEvent");
const BookingSlotReservation = require("../models/BookingSlotReservation");
const ReservationTimeBucket = require("../models/ReservationTimeBucket");
const SlotCounter = require("../models/SlotCounter");
const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
const { ensureVisitEntitlementIndexes } = require("../utils/visitEntitlementIndexSafety");
const { checkFreeVisitEligibility } = require("../utils/freeVisit/eligibility");
const temporaryPassword = require("../utils/auth/temporaryPassword");
const webhook = require("../routes/webhook");

const TZ = "America/New_York";
const BASIC = "price_1RUdq2Bw0RtvSZjMnnI6uRgn";
const stripe = subsModule.stripe;
let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${error.stack?.split("\n").slice(0, 3).join("\n      ") || error.message}`);
  }
}

/* ------------------------------ fake Stripe ------------------------------ */
const fake = { subs: new Map(), sessions: new Map(), created: [], expired: [] };
const T = (date) => Math.floor(new Date(date).getTime() / 1000);
function listResult(items) {
  const promise = Promise.resolve({ object: "list", data: items, has_more: false });
  promise[Symbol.asyncIterator] = async function* iterate() {
    for (const item of items) yield item;
  };
  return promise;
}
function makeSub({ id, customer, status, addressId, userId }) {
  const now = Date.now();
  const sub = {
    id,
    object: "subscription",
    customer,
    status,
    created: T(now),
    start_date: T(now),
    current_period_start: T(now),
    current_period_end: T(now + 30 * 86400000),
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    latest_invoice: null,
    schedule: null,
    metadata: { addressId: String(addressId), userId, plan: "basic", billingCycle: "monthly" },
    items: { data: [{ id: `si_${id}`, price: { id: BASIC, unit_amount: 14900, recurring: { interval: "month" } }, current_period_start: T(now), current_period_end: T(now + 30 * 86400000) }] },
  };
  fake.subs.set(id, sub);
  return sub;
}
stripe.subscriptions.retrieve = async (id) => {
  const sub = fake.subs.get(id);
  if (!sub) throw Object.assign(new Error(`No such subscription: ${id}`), { code: "resource_missing" });
  return JSON.parse(JSON.stringify(sub));
};
stripe.subscriptions.list = (params = {}) =>
  listResult([...fake.subs.values()].filter((s) => !params.customer || s.customer === params.customer).map((s) => JSON.parse(JSON.stringify(s))));
stripe.customers.retrieve = async (id) => ({ id, object: "customer", email: null });
stripe.customers.list = async () => ({ data: [] });
stripe.checkout.sessions.list = async ({ customer }) => ({ data: [...fake.sessions.values()].filter((s) => s.customer === customer && s.status === "open") });
stripe.checkout.sessions.retrieve = async (id) => ({ ...fake.sessions.get(id) });
stripe.checkout.sessions.expire = async (id) => {
  fake.expired.push(id);
  fake.sessions.get(id).status = "expired";
  return fake.sessions.get(id);
};
stripe.checkout.sessions.create = async (config) => {
  const id = `cs_test_${fake.created.length + 1}`;
  const session = { id, status: "open", mode: config.mode, customer: config.customer || null, metadata: config.metadata, url: `https://checkout.stripe.test/${id}`, config };
  fake.sessions.set(id, session);
  fake.created.push(session);
  return session;
};
stripe.checkout.sessions.listLineItems = async () => ({ data: [] });

/* -------------------------------- helpers -------------------------------- */
let server;
let baseUrl;
let owner;
let eventSeq = 0;
function tokenFor(user) {
  return jwt.sign({ id: String(user._id), tv: Number(user.tokenVersion || 0) }, process.env.JWT_SECRET);
}
async function call(method, path, { token, body, form } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let payload;
  if (form) payload = form;
  else if (body) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const asOwner = (method, path, opts = {}) => call(method, path, { ...opts, token: tokenFor(owner) });
let lastEventId = "";
async function deliver(type, object) {
  lastEventId = `evt_admin_${++eventSeq}`;
  const payload = JSON.stringify({ id: lastEventId, object: "event", type, data: { object } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const res = await fetch(`${baseUrl}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
  return res.status;
}
function nextOpenDate(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  while (new Date(`${d.toISOString().slice(0, 10)}T12:00:00Z`).getUTCDay() === 0) d.setTime(d.getTime() + 86400000);
  return d.toISOString().slice(0, 10);
}
function visitForm(fields, photos = []) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  for (const photo of photos) form.append("images", new Blob([photo], { type: "image/jpeg" }), "kitchen.jpg");
  return form;
}
async function makeFixter(name) {
  return User.create({
    name,
    email: `${name.toLowerCase().replace(/\s+/g, ".")}@fixter.local`,
    password: "hashed",
    phone: "+15550002222",
    userId: String(Math.floor(10000000 + Math.random() * 89999999)),
    role: "employee",
    employeePosition: "Fixter",
    isActive: true,
  });
}

/* ---------------------------------- run ---------------------------------- */
async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "admintools" });
  await ensureVisitEntitlementIndexes({ logger: { log() {}, warn() {} } });
  await Promise.all([User.init(), Booking.init(), Subscription.init(), SmsMessage.init(), StripeWebhookEvent.init(), AdminPaymentLink.init(), BookingSlotReservation.init(), ReservationTimeBucket.init(), SlotCounter.init()]);

  const fixters = [await makeFixter("Fixter One"), await makeFixter("Fixter Two")];
  await CompanyAvailabilityTemplate.create({
    active: true,
    timezone: TZ,
    slotMinutes: 30,
    minLeadMinutes: 0,
    maxAdvanceDays: 120,
    defaultCapacity: fixters.length,
    visitDurationMinutes: 90,
    weeklySchedule: Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      enabled: weekday !== 0,
      starts: ["08:00", "10:00", "13:00"].map((time) => ({ time, capacity: null })),
      intervals: [{ startTime: "08:00", endTime: "16:00", capacity: null }],
    })),
  });
  owner = await User.create({ userId: "90000001", name: "Owner", email: "owner@example.test", role: "admin", password: "x" });

  const app = express();
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), webhook);
  app.use(express.json());
  app.use("/api/auth", require("../routes/auth"));
  app.use("/api/password-reset", require("../routes/passwordReset"));
  app.use("/api/users", require("../routes/users"));
  app.use("/api/admin", require("../routes/adminCustomers"));
  app.use("/api/admin", require("../routes/adminSales"));
  app.use("/api/pay", require("../routes/pay"));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  const photo = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#3366aa" } }).jpeg().toBuffer();
  const day = nextOpenDate(6);
  const fullDayDate = nextOpenDate(9);

  try {
    /* ============================ 1. Accounts ============================ */
    console.log("\nAdmin-created account");
    const newCustomer = {
      firstName: "Rosa",
      lastName: "Diaz",
      phone: "(516) 555-0142",
      email: "Rosa.Diaz@Mailbox.org",
      addresses: [{ line1: "12 Elm St", city: "Farmingdale", state: "NY", zip: "11735" }],
    };
    let created;
    await check("1. Admin creates a full customer account", async () => {
      const res = await asOwner("POST", "/api/admin/customers", { body: newCustomer });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      created = await User.findById(res.body.customer._id);
      assert.strictEqual(created.name, "Rosa Diaz");
      assert.strictEqual(created.email, "rosa.diaz@mailbox.org");
      assert.strictEqual(created.phone, "+15165550142");
      assert.strictEqual(created.addresses.length, 1);
      assert.strictEqual(String(created.defaultAddressId), String(created.addresses[0]._id));
      assert.strictEqual(created.signupMethod, "admin");
    });
    await check("7. active at once, without any verification stamped", async () => {
      assert.strictEqual(created.isActive, true);
      assert.strictEqual(created.phoneVerifiedAt, null);
      assert.strictEqual(created.emailVerifiedAt, null);
      assert.strictEqual(created.termsAcceptedAt, null, "the customer has not accepted terms yet");
      assert.ok(temporaryPassword.isLive(created));
      const hours = (created.temporaryPassword.expiresAt - created.temporaryPassword.issuedAt) / 3600000;
      assert.strictEqual(hours, 72);
    });
    await check("2. one welcome email with the temporary password", async () => {
      const mails = sentEmails.filter((m) => m.templateKey === "admin_account_created");
      assert.strictEqual(mails.length, 1);
      assert.strictEqual(mails[0].to, "rosa.diaz@mailbox.org");
      assert.ok(mails[0].text.includes("5165550142"));
      assert.ok(/create a new password/i.test(mails[0].text));
    });
    await check("3. one welcome text with the temporary password (consent recorded first, so not suppressed)", async () => {
      const texts = await SmsMessage.find({ user: created._id, notificationType: "ADMIN_ACCOUNT_CREATED" }).lean();
      assert.strictEqual(texts.length, 1);
      assert.strictEqual(texts[0].status, "simulated", texts[0].suppressionReason || "");
      assert.ok(texts[0].body.includes("5165550142"));
      assert.strictEqual(texts[0].segments, 1);
    });
    await check("the call's consent is in the ledger, attributed to the staff member", async () => {
      const events = await ConsentEvent.find({ user: created._id }).lean();
      const keys = events.map((e) => `${e.channel}.${e.purpose}.${e.action}.${e.source}`).sort();
      assert.deepStrictEqual(keys, ["email.marketing.granted.admin_phone", "email.service.granted.admin_phone", "sms.marketing.granted.admin_phone", "sms.service.granted.admin_phone"]);
      assert.ok(events.every((e) => /recorded by Owner/.test(e.detail)));
      assert.ok(events.filter((e) => e.channel === "sms").every((e) => /admin_phone\.v1$/.test(e.consentVersion)));
      assert.ok(await AdminActivityLog.exists({ action: "Customer Account Created", entityId: String(created._id) }));
    });
    await check("an email already registered is refused, never merged", async () => {
      const res = await asOwner("POST", "/api/admin/customers", { body: { ...newCustomer, phone: "5165550199" } });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.code, "EMAIL_IN_USE");
      assert.strictEqual(res.body.existing.id, String(created._id));
    });
    await check("a phone already on a customer needs Admin to confirm it is someone else", async () => {
      const body = { ...newCustomer, email: "rosa.sister@mailbox.org" };
      const refused = await asOwner("POST", "/api/admin/customers", { body });
      assert.strictEqual(refused.status, 409);
      assert.strictEqual(refused.body.code, "PHONE_IN_USE");
      const allowed = await asOwner("POST", "/api/admin/customers", { body: { ...body, allowSharedPhone: true } });
      assert.strictEqual(allowed.status, 201);
    });
    await check("missing fields are named, nothing is created", async () => {
      const before = await User.countDocuments();
      const res = await asOwner("POST", "/api/admin/customers", { body: { firstName: "", phone: "12", email: "nope" } });
      assert.strictEqual(res.status, 400);
      assert.ok(res.body.errors.firstName && res.body.errors.lastName && res.body.errors.phone && res.body.errors.email);
      assert.strictEqual(await User.countDocuments(), before);
    });
    await check("a customer cannot create accounts", async () => {
      const res = await call("POST", "/api/admin/customers", { token: tokenFor(created), body: newCustomer });
      assert.strictEqual(res.status, 403);
    });

    let tempToken;
    await check("4. the temporary password signs in once, typed as a phone number", async () => {
      const res = await call("POST", "/api/auth/login", { body: { email: "rosa.diaz@mailbox.org", password: "(516) 555-0142" } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.user.mustChangePassword, true);
      assert.strictEqual(res.body.user.temporaryPassword, true);
      tempToken = res.body.token;
    });
    await check("5. until a new password is set, that session reaches nothing else", async () => {
      const blocked = await call("GET", "/api/users/me/sms-preferences", { token: tempToken });
      assert.strictEqual(blocked.status, 403);
      assert.strictEqual(blocked.body.code, "PASSWORD_CHANGE_REQUIRED");
      const me = await call("GET", "/api/auth/me", { token: tempToken });
      assert.strictEqual(me.status, 200);
      assert.strictEqual(me.body.mustChangePassword, true);
    });
    await check("the phone number itself is refused as the new password", async () => {
      const res = await call("POST", "/api/auth/change-password", { token: tempToken, body: { newPassword: "5165550142" } });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.code, "SAME_AS_TEMPORARY");
    });
    await check("5b. setting a new password needs no current password and unlocks the account", async () => {
      const res = await call("POST", "/api/auth/change-password", { token: tempToken, body: { newPassword: "Garden-Gate-42" } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.user.mustChangePassword, false);
      assert.strictEqual(res.body.user.temporaryPassword, false);
      const open = await call("GET", "/api/users/me/sms-preferences", { token: tempToken });
      assert.strictEqual(open.status, 200);
    });
    await check("6. the temporary password no longer works; the new one does", async () => {
      const old = await call("POST", "/api/auth/login", { body: { email: "rosa.diaz@mailbox.org", password: "5165550142" } });
      assert.strictEqual(old.status, 400);
      const fresh = await call("POST", "/api/auth/login", { body: { email: "rosa.diaz@mailbox.org", password: "Garden-Gate-42" } });
      assert.strictEqual(fresh.status, 200);
      assert.strictEqual(fresh.body.user.mustChangePassword, false);
    });
    await check("resending sign-in details is refused once the customer has their own password", async () => {
      const res = await asOwner("POST", `/api/admin/customers/${created._id}/resend-access`);
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.code, "HAS_OWN_PASSWORD");
    });

    let waiting;
    await check("an expired temporary password signs nobody in, and ends a session it opened", async () => {
      const res = await asOwner("POST", "/api/admin/customers", { body: { firstName: "Ken", lastName: "Park", phone: "631-555-0177", email: "ken@example.test" } });
      assert.strictEqual(res.status, 201);
      waiting = await User.findById(res.body.customer._id);
      const login = await call("POST", "/api/auth/login", { body: { email: "ken@example.test", password: "6315550177" } });
      assert.strictEqual(login.status, 200);
      await User.updateOne({ _id: waiting._id }, { $set: { "temporaryPassword.expiresAt": new Date(Date.now() - 1000) } });
      const again = await call("POST", "/api/auth/login", { body: { email: "ken@example.test", password: "6315550177" } });
      assert.strictEqual(again.status, 401);
      assert.strictEqual(again.body.code, "TEMP_PASSWORD_EXPIRED");
      const me = await call("GET", "/api/auth/me", { token: login.body.token });
      assert.strictEqual(me.status, 401);
    });
    await check("Admin can resend: a fresh temporary password and one more email and text", async () => {
      const mailsBefore = sentEmails.filter((m) => m.templateKey === "admin_account_created").length;
      const res = await asOwner("POST", `/api/admin/customers/${waiting._id}/resend-access`);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(sentEmails.filter((m) => m.templateKey === "admin_account_created").length, mailsBefore + 1);
      assert.strictEqual(await SmsMessage.countDocuments({ user: waiting._id, notificationType: "ADMIN_ACCOUNT_CREATED" }), 2);
      const login = await call("POST", "/api/auth/login", { body: { email: "ken@example.test", password: "6315550177" } });
      assert.strictEqual(login.status, 200);
    });
    await check("signing in another way (code, Google, Apple) retires the temporary password", async () => {
      const user = await User.findById(waiting._id);
      assert.strictEqual(await temporaryPassword.retireAfterOtherSignIn(user), true);
      const after = await User.findById(waiting._id);
      assert.ok(!after.password && !temporaryPassword.isIssued(after) && after.mustChangePassword === false);
      const login = await call("POST", "/api/auth/login", { body: { email: "ken@example.test", password: "6315550177" } });
      assert.strictEqual(login.status, 400);
    });

    /* ======================= 2. Communication switches ======================= */
    console.log("\nCommunication preferences");
    const commBefore = { sms: await SmsMessage.countDocuments({ user: created._id }), mail: sentEmails.length };
    await check("Admin sees four switches, all on for an Admin-created account", async () => {
      const res = await asOwner("GET", `/api/admin/users/${created._id}/communication`);
      assert.strictEqual(res.status, 200);
      for (const purpose of ["service", "marketing"]) for (const channel of ["email", "sms"]) assert.strictEqual(res.body[purpose][channel].enabled, true, `${purpose}.${channel}`);
    });
    const numbered = { "service.email": 8, "service.sms": 9, "marketing.email": 10, "marketing.sms": 11 };
    for (const key of ["service.email", "service.sms", "marketing.email", "marketing.sms"]) {
      await check(`${numbered[key]}. ${key} turns off and back on, at once`, async () => {
        const [purpose, channel] = key.split(".");
        const off = await asOwner("PUT", `/api/admin/users/${created._id}/communication`, { body: { key, enabled: false } });
        assert.strictEqual(off.status, 200, JSON.stringify(off.body));
        assert.strictEqual(off.body.state[purpose][channel].enabled, false);
        const on = await asOwner("PUT", `/api/admin/users/${created._id}/communication`, { body: { key, enabled: true } });
        assert.strictEqual(on.body.state[purpose][channel].enabled, true);
      });
    }
    await check("the send paths obey the switches (service SMS, service email)", async () => {
      await asOwner("PUT", `/api/admin/users/${created._id}/communication`, { body: { key: "service.sms", enabled: false } });
      const fresh = await User.findById(created._id).lean();
      assert.strictEqual(fresh.smsPreferences.transactionalEnabled, false);
      await asOwner("PUT", `/api/admin/users/${created._id}/communication`, { body: { key: "service.email", enabled: false } });
      const result = await realMail.sendTx("booking_created", "rosa.diaz@mailbox.org", { name: "Rosa", bookingNumber: "1", date: new Date(), service: "x", address: "y" });
      assert.deepStrictEqual(result, { suppressed: true, reason: "service_email_off" });
      await asOwner("PUT", `/api/admin/users/${created._id}/communication`, { body: { key: "service.sms", enabled: true } });
      await asOwner("PUT", `/api/admin/users/${created._id}/communication`, { body: { key: "service.email", enabled: true } });
    });
    await check("12. changing a switch sends the customer nothing", async () => {
      assert.strictEqual(await SmsMessage.countDocuments({ user: created._id }), commBefore.sms);
      assert.strictEqual(sentEmails.length, commBefore.mail);
    });
    await check("13. every change is logged: who, when, what, source", async () => {
      const logs = await AdminActivityLog.find({ action: "Customer Communication Preference Changed", entityId: String(created._id) }).lean();
      assert.strictEqual(logs.length, 12);
      assert.ok(logs.every((l) => l.actorName === "Owner" && l.createdAt && l.details.setting));
      const ledger = await ConsentEvent.find({ user: created._id, source: { $in: ["admin_change", "admin_phone"] } }).lean();
      assert.ok(ledger.some((e) => e.source === "admin_change" && e.action === "withdrawn"));
      assert.ok(ledger.some((e) => e.channel === "email" && e.purpose === "marketing" && e.action === "unsubscribed"));
    });
    await check("a STOP texted from the phone cannot be switched back on by Admin", async () => {
      await asOwner("PUT", `/api/admin/users/${created._id}/communication`, { body: { key: "marketing.sms", enabled: false } });
      await SmsOptOut.create({ phone: "+15165550142", optedOutAt: new Date(), source: "carrier_keyword", scope: "all" });
      const res = await asOwner("PUT", `/api/admin/users/${created._id}/communication`, { body: { key: "marketing.sms", enabled: true } });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.code, "LOCKED_STOPPED");
      await SmsOptOut.deleteMany({});
    });

    /* ========================= 3. Membership sales ========================= */
    console.log("\nMembership purchase");
    const buyer = await User.findById(created._id);
    const home = buyer.addresses[0]._id;
    await check("Admin sees the home can be sold a membership", async () => {
      const res = await asOwner("GET", `/api/admin/customers/${buyer._id}/membership-options`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.homes[0].canBuy, true);
    });
    let phoneSession;
    await check("14/15. Pay by phone opens Stripe's own page for Admin, through the customer's checkout", async () => {
      const res = await asOwner("POST", `/api/admin/customers/${buyer._id}/membership-sale`, { body: { addressId: String(home), plan: "basic", billingCycle: "monthly", method: "phone" } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      phoneSession = fake.created[fake.created.length - 1];
      assert.strictEqual(res.body.url, phoneSession.url);
      assert.strictEqual(phoneSession.config.mode, "subscription");
      assert.strictEqual(phoneSession.config.metadata.adminInitiated, "phone");
      assert.strictEqual(phoneSession.config.subscription_data.metadata.addressId, String(home));
      assert.strictEqual(phoneSession.config.subscription_data.metadata.userId, buyer.userId);
      assert.ok(phoneSession.config.success_url.startsWith("https://www.profixter.com/admin"));
      assert.ok(await AdminActivityLog.exists({ action: "Membership Sale Started (Pay by Phone)" }));
    });
    let linkToken;
    let spareToken;
    await check("16. Send payment link: one email and one text, logged", async () => {
      const res = await asOwner("POST", `/api/admin/customers/${buyer._id}/membership-sale`, { body: { addressId: String(home), plan: "basic", billingCycle: "monthly", method: "link", channels: ["email", "sms"] } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      linkToken = res.body.payUrl.split("/pay/")[1];
      assert.ok(/^[A-Za-z0-9_-]{22}$/.test(linkToken));
      assert.strictEqual(res.body.delivery.email, "sent");
      assert.strictEqual(res.body.delivery.sms, "simulated");
      const link = await AdminPaymentLink.findOne({ kind: "membership", user: buyer._id });
      assert.ok(link && link.tokenHash !== linkToken, "only the hash is stored");
      assert.ok(sentEmails.some((m) => m.templateKey === "payment_link" && m.text.includes(res.body.payUrl)));
      const sms = await SmsMessage.findOne({ notificationType: "PAYMENT_LINK", user: buyer._id }).lean();
      assert.ok(sms && sms.body.includes(res.body.payUrl) && sms.segments === 1);
      assert.ok(await AdminActivityLog.exists({ action: "Payment Link Sent (Membership)" }));
      const spare = await asOwner("POST", `/api/admin/customers/${buyer._id}/membership-sale`, { body: { addressId: String(home), plan: "basic", billingCycle: "monthly", method: "link", channels: ["email"] } });
      spareToken = spare.body.payUrl.split("/pay/")[1];
    });
    let linkSession;
    await check("the link opens a fresh checkout, closing the one opened by phone", async () => {
      const info = await call("GET", `/api/pay/${linkToken}`);
      assert.strictEqual(info.status, 200);
      assert.strictEqual(info.body.status, "open");
      const res = await call("POST", `/api/pay/${linkToken}/checkout`);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      linkSession = fake.created[fake.created.length - 1];
      assert.strictEqual(res.body.url, linkSession.url);
      assert.ok(linkSession.config.metadata.adminPaymentLinkId);
      assert.ok(fake.expired.includes(phoneSession.id), "an earlier open checkout for the home is expired first");
    });
    await check("a made-up token opens nothing", async () => {
      const res = await call("POST", "/api/pay/AAAAAAAAAAAAAAAAAAAAAA/checkout");
      assert.strictEqual(res.status, 404);
    });
    await check("17/19. payment activates the membership by the normal webhook, with the normal notices", async () => {
      const sub = makeSub({ id: "sub_admin_sale", customer: "cus_admin_sale", status: "active", addressId: home, userId: buyer.userId });
      const status = await deliver("checkout.session.completed", {
        id: linkSession.id,
        object: "checkout.session",
        mode: "subscription",
        customer: "cus_admin_sale",
        subscription: sub.id,
        client_reference_id: String(home),
        metadata: linkSession.config.metadata,
      });
      assert.strictEqual(status, 200);
      const record = await Subscription.findOne({ stripeSubscriptionId: "sub_admin_sale" });
      assert.ok(record && record.status === "active" && record.accessStatus === "active" && String(record.addressId) === String(home));
      const link = await AdminPaymentLink.findOne({ tokenHash: require("../utils/admin/paymentLinks").hashToken(linkToken) });
      assert.strictEqual(link.status, "paid");
      assert.ok(sentEmails.some((m) => m.templateKey === "subscription_started"), "the usual welcome-to-membership email");
      assert.ok(await SmsMessage.exists({ user: buyer._id, notificationType: "MEMBERSHIP_STARTED" }));
    });
    await check("18. no second membership for that home, by phone or by an old link", async () => {
      const phone = await asOwner("POST", `/api/admin/customers/${buyer._id}/membership-sale`, { body: { addressId: String(home), plan: "plus", billingCycle: "monthly", method: "phone" } });
      assert.strictEqual(phone.status, 409);
      assert.strictEqual(phone.body.code, "ADDRESS_ALREADY_SUBSCRIBED");
      const link = await asOwner("POST", `/api/admin/customers/${buyer._id}/membership-sale`, { body: { addressId: String(home), plan: "plus", billingCycle: "monthly", method: "link" } });
      assert.strictEqual(link.status, 409);
      const created = fake.created.length;
      const old = await call("POST", `/api/pay/${spareToken}/checkout`);
      assert.strictEqual(old.status, 409);
      assert.strictEqual(old.body.code, "ADDRESS_ALREADY_SUBSCRIBED");
      assert.strictEqual(fake.created.length, created, "no Stripe page was opened");
      assert.strictEqual((await call("GET", `/api/pay/${spareToken}`)).body.status, "canceled");
    });
    await check("18b. a home Stripe is still billing (past due) is sent to fix that payment", async () => {
      const other = await User.create({ userId: "70000002", name: "Pat Due", email: "pat@example.test", phone: "+15165550111", role: "customer", stripeCustomerId: "cus_pat", addresses: [{ line1: "9 Oak Rd", city: "Farmingdale", state: "NY", zip: "11735" }] });
      makeSub({ id: "sub_pat_due", customer: "cus_pat", status: "past_due", addressId: other.addresses[0]._id, userId: other.userId });
      const res = await asOwner("POST", `/api/admin/customers/${other._id}/membership-sale`, { body: { addressId: String(other.addresses[0]._id), plan: "basic", billingCycle: "monthly", method: "phone" } });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.code, "MEMBERSHIP_PAYMENT_RECOVERY_REQUIRED");
    });

    /* ============================ 4. Visits ============================ */
    console.log("\nVisit creation");
    const member = await User.findById(buyer._id);
    let adminFree;
    await check("24. Free Visit — Admin: no payment, for an existing customer, with a photo", async () => {
      const res = await asOwner("POST", "/api/admin/visits", {
        form: visitForm({ mode: "existing", userId: member._id, addressId: home, type: "admin_free", date: day, time: "10:00", task: "Fix squeaky door", description: "Front door hinge squeaks.", notes: "Owner's courtesy visit" }, [photo]),
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.payment, null);
      adminFree = await Booking.findById(res.body.booking._id);
      assert.strictEqual(adminFree.accessType, "admin");
      assert.strictEqual(adminFree.paymentState, "not_required");
      assert.strictEqual(adminFree.isFreeFirstVisit, false);
      assert.strictEqual(adminFree.adminNote, "Owner's courtesy visit");
      assert.ok(adminFree.slotReservationId, "booked through the reservation engine");
    });
    await check("29. the photo is attached like a customer's", async () => {
      assert.strictEqual(adminFree.images.length, 1);
      assert.ok(/^https:\/\/test-bucket\.s3\.amazonaws\.com\/uploads\/.+booking-\d{8}\/.+admin-create-kitchen\.jpg$/.test(adminFree.images[0]), adminFree.images[0]);
    });
    await check("the customer is told as usual, and called a visit, not a membership visit", async () => {
      assert.ok(sentEmails.some((m) => m.templateKey === "booking_created" && m.to === member.email));
      const sms = await SmsMessage.findOne({ booking: adminFree._id }).lean();
      assert.ok(sms && /your visit/i.test(sms.body) && !/membership visit/i.test(sms.body), sms?.body);
    });
    await check("20/26. a membership visit is still allowed: the Admin visit used none of the plan", async () => {
      const res = await asOwner("POST", "/api/admin/visits", { form: visitForm({ mode: "existing", userId: member._id, addressId: home, type: "membership", date: day, time: "08:00", task: "Hang shelves" }) });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.booking.accessType, "membership");
      assert.strictEqual(res.body.booking.paymentState, "not_required");
    });
    await check("21. the plan's limit holds (Basic: one booked visit at a time)", async () => {
      const res = await asOwner("POST", "/api/admin/visits", { form: visitForm({ mode: "existing", userId: member._id, addressId: home, type: "membership", date: day, time: "13:00", task: "Second visit" }) });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.code, "MEMBERSHIP_LIMIT_REACHED");
    });
    await check("membership visits need an active membership at that home", async () => {
      const res = await asOwner("POST", "/api/admin/visits", { form: visitForm({ mode: "existing", userId: waiting._id, addressId: new mongoose.Types.ObjectId(), type: "membership", date: day, time: "13:00", task: "x" }) });
      assert.ok([400, 409].includes(res.status));
    });
    await check("22. One-Time Visit, pay by phone: held slot, entitlement, Stripe page for Admin", async () => {
      const res = await asOwner("POST", "/api/admin/visits", { form: visitForm({ mode: "existing", userId: member._id, addressId: home, type: "one_time", date: day, time: "13:00", task: "Replace faucet", payment: "phone" }) });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.payment.method, "phone");
      const session = fake.created[fake.created.length - 1];
      assert.strictEqual(res.body.payment.url, session.url);
      assert.strictEqual(session.config.mode, "payment");
      assert.strictEqual(session.config.line_items[0].price, "price_test_one_time");
      assert.strictEqual(session.config.metadata.productKind, "one_time_handyman_visit");
      const booking = await Booking.findById(res.body.booking._id);
      assert.strictEqual(booking.paymentState, "pending");
      const entitlement = await VisitEntitlement.findById(booking.entitlementId);
      assert.strictEqual(entitlement.status, "pending_payment");
      assert.strictEqual(entitlement.stripeCheckoutSessionId, session.id);
    });
    await check("23. Full Day, pay by phone", async () => {
      const res = await asOwner("POST", "/api/admin/visits", { form: visitForm({ mode: "existing", userId: member._id, addressId: home, type: "full_day", date: fullDayDate, task: "Paint two bedrooms", payment: "phone" }) });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const session = fake.created[fake.created.length - 1];
      assert.strictEqual(session.config.line_items[0].price, "price_test_full_day");
      assert.strictEqual(res.body.booking.bookingType, "full_day_visit");
    });

    console.log("\nA guest with no account");
    const guest = { mode: "guest", guestName: "Lee Walker", guestPhone: "516-555-0188", guestEmail: "lee@example.test", guestLine1: "40 Birch Ln", guestCity: "Farmingdale", guestState: "NY", guestZip: "11735" };
    let guestBooking;
    let guestLink;
    await check("28. a guest One-Time Visit with a payment link, no account created", async () => {
      const users = await User.countDocuments();
      const res = await asOwner("POST", "/api/admin/visits", { form: visitForm({ ...guest, guestSmsConsent: "true", type: "one_time", date: nextOpenDate(7), time: "10:00", task: "Mount TV", payment: "link", channels: "email,sms" }, [photo]) });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(await User.countDocuments(), users);
      guestBooking = await Booking.findById(res.body.booking._id);
      assert.strictEqual(guestBooking.user, null);
      assert.strictEqual(guestBooking.adminGuest, true);
      assert.strictEqual(guestBooking.address, "40 Birch Ln");
      assert.strictEqual(guestBooking.images.length, 1);
      assert.ok(guestBooking.guestContactConsent.at && /recorded in Admin by Owner/.test(guestBooking.guestContactConsent.text));
      guestLink = res.body.payment.payUrl.split("/pay/")[1];
      assert.strictEqual(res.body.payment.delivery.email, "sent");
      assert.strictEqual(res.body.payment.delivery.sms, "simulated", "the guest agreed to texts on the call");
      const hold = (new Date(res.body.payment.expiresAt) - Date.now()) / 3600000;
      assert.ok(hold > 23 && hold < 24, `link hold ${hold}h`);
    });
    await check("the guest's link reopens that visit's own Stripe page", async () => {
      const res = await call("POST", `/api/pay/${guestLink}/checkout`);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const session = fake.sessions.get(res.body.url.split("/").pop());
      assert.strictEqual(session.metadata.bookingId, String(guestBooking._id));
    });
    await check("paying confirms the guest's visit and closes the link", async () => {
      const link = await AdminPaymentLink.findOne({ booking: guestBooking._id });
      const session = fake.sessions.get(link.lastSessionId);
      const status = await deliver("checkout.session.completed", {
        id: session.id,
        object: "checkout.session",
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        amount_total: 14900,
        currency: "usd",
        customer: null,
        payment_intent: "pi_guest_1",
        client_reference_id: String(guestBooking._id),
        metadata: session.metadata,
      });
      assert.strictEqual(status, 200);
      const paid = await Booking.findById(guestBooking._id);
      assert.strictEqual(paid.paymentState, "paid");
      assert.strictEqual((await AdminPaymentLink.findById(link._id)).status, "paid");
      assert.ok(sentEmails.some((m) => m.to === "lee@example.test" && m.templateKey !== "payment_link"), "the guest got the paid confirmation");
      const evt = await StripeWebhookEvent.findOne({ eventId: lastEventId }).lean();
      assert.strictEqual(evt.status, "completed", evt.lastError || "");
    });
    await check("a guest who did not agree to texts gets the link by email only", async () => {
      const res = await asOwner("POST", "/api/admin/visits", { form: visitForm({ ...guest, guestName: "No Text", guestPhone: "516-555-0190", guestEmail: "notext@example.test", type: "full_day", date: nextOpenDate(10), task: "Deck repair", payment: "link", channels: "email,sms" }) });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.ok(/^suppressed/.test(res.body.payment.delivery.sms), res.body.payment.delivery.sms);
    });
    await check("25. an Admin free visit for a guest leaves their free first visit untouched", async () => {
      const res = await asOwner("POST", "/api/admin/visits", { form: visitForm({ ...guest, guestName: "Sam Free", guestPhone: "516-555-0191", guestEmail: "samfree@example.test", guestLine1: "77 Pine Ct", type: "admin_free", date: nextOpenDate(11), time: "13:00", task: "Look at leak" }) });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const verdict = await checkFreeVisitEligibility({ phone: "+15165550191", email: "samfree@example.test", address: { line1: "77 Pine Ct", city: "Farmingdale", state: "NY", zip: "11735" } });
      assert.strictEqual(verdict.decision, "eligible", JSON.stringify(verdict));
      assert.deepStrictEqual(verdict.matches, [], "the Admin visit is not counted as anybody's free visit");
    });
    await check("27. existing-customer path keeps the account's own details", async () => {
      assert.strictEqual(String(adminFree.user), String(member._id));
      assert.strictEqual(adminFree.email, member.email);
      assert.strictEqual(adminFree.adminGuest, false);
    });
    await check("a taken time is refused, not double-booked", async () => {
      await asOwner("POST", "/api/admin/visits", { form: visitForm({ ...guest, guestName: "A", guestPhone: "516-555-0192", guestEmail: "a@example.test", type: "admin_free", date: nextOpenDate(8), time: "08:00", task: "x" }) });
      await asOwner("POST", "/api/admin/visits", { form: visitForm({ ...guest, guestName: "B", guestPhone: "516-555-0193", guestEmail: "b@example.test", type: "admin_free", date: nextOpenDate(8), time: "08:00", task: "x" }) });
      const third = await asOwner("POST", "/api/admin/visits", { form: visitForm({ ...guest, guestName: "C", guestPhone: "516-555-0194", guestEmail: "c@example.test", type: "admin_free", date: nextOpenDate(8), time: "08:00", task: "x" }) });
      assert.strictEqual(third.status, 409, JSON.stringify(third.body));
    });
    await check("visits need the bookings permission", async () => {
      const res = await call("POST", "/api/admin/visits", { token: tokenFor(member), form: visitForm({ ...guest, type: "admin_free", date: day, time: "10:00", task: "x" }) });
      assert.strictEqual(res.status, 403);
    });
  } finally {
    server?.close();
    await mongoose.disconnect();
    await replSet.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
