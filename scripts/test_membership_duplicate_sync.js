/*
 * Two subscriptions, one home: the 2026-10-30 membership incident, end to end.
 *
 * A member's renewal failed (past_due), the site let them buy a second
 * membership for the same home, and a later sync of the OLD subscription
 * overwrote the NEW one's record - a paying customer shown as locked out.
 * This drives the real webhook endpoint (signed events), the real checkout and
 * recovery routes, and the restoration notice, against a real database.
 * Stripe's API is faked on the shared client; nothing leaves the machine.
 *
 *   node scripts/test_membership_duplicate_sync.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-membership-sync";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake_for_unit_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_membership_sync";
process.env.CLIENT_URL = "https://www.profixter.com";
process.env.SMS_ENABLED = "false"; // rendered, recorded, never sent

const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const sentEmails = [];
function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
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
});

const { MongoMemoryServer } = require("mongodb-memory-server");
const subsModule = require("../utils/subscriptionManagement");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const StripeWebhookEvent = require("../models/StripeWebhookEvent");
const SmsMessage = require("../models/SmsMessage");
const webhook = require("../routes/webhook");
const { sendDueRestorationNotices } = require("../utils/membershipRestoredNotice");

const PRICE = "price_1RUdq2Bw0RtvSZjMnnI6uRgn"; // Basic monthly
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
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

/* ------------------------------ fake Stripe ------------------------------ */
const T = (iso) => Math.floor(Date.parse(iso) / 1000);
const fake = { subs: new Map(), invoices: new Map(), sessions: new Map(), expired: [], created: [], createDelay: 0 };
function listResult(items) {
  const promise = Promise.resolve({ object: "list", data: items, has_more: false });
  promise[Symbol.asyncIterator] = async function* iterate() {
    for (const item of items) yield item;
  };
  return promise;
}
function makeSub({ id, customer, status, addressId, userId, created, periodStart, periodEnd, latestInvoice = null, metadata }) {
  const sub = {
    id,
    object: "subscription",
    customer,
    status,
    created: T(created),
    start_date: T(created),
    current_period_start: T(periodStart || created),
    current_period_end: T(periodEnd),
    cancel_at_period_end: false,
    canceled_at: status === "canceled" ? T(periodEnd) : null,
    ended_at: status === "canceled" ? T(periodEnd) : null,
    latest_invoice: latestInvoice,
    schedule: null,
    metadata: metadata || (addressId ? { addressId: String(addressId), userId, plan: "basic", billingCycle: "monthly" } : {}),
    items: {
      data: [
        {
          id: `si_${id}`,
          price: { id: PRICE, unit_amount: 14900, recurring: { interval: "month" } },
          current_period_start: T(periodStart || created),
          current_period_end: T(periodEnd),
        },
      ],
    },
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
  listResult(
    [...fake.subs.values()]
      .filter((s) => !params.customer || s.customer === params.customer)
      .sort((a, b) => b.created - a.created)
      .map((s) => JSON.parse(JSON.stringify(s)))
  );
stripe.customers.retrieve = async (id) => ({ id, object: "customer", email: null });
stripe.customers.list = async () => ({ data: [] });
stripe.invoices.retrieve = async (id) => {
  const invoice = fake.invoices.get(id);
  if (!invoice) throw new Error(`No such invoice: ${id}`);
  return { ...invoice };
};
stripe.billingPortal.sessions.create = async () => ({ url: "https://billing.stripe.test/portal" });
stripe.checkout.sessions.list = async ({ customer }) => ({
  data: [...fake.sessions.values()].filter((s) => s.customer === customer && s.status === "open"),
});
stripe.checkout.sessions.retrieve = async (id) => ({ ...fake.sessions.get(id) });
stripe.checkout.sessions.expire = async (id) => {
  fake.expired.push(id);
  fake.sessions.get(id).status = "expired";
  return fake.sessions.get(id);
};
stripe.checkout.sessions.create = async (config) => {
  if (fake.createDelay) await new Promise((r) => setTimeout(r, fake.createDelay));
  const id = `cs_test_${fake.created.length + 1}`;
  const session = { id, status: "open", mode: "subscription", customer: config.customer || null, metadata: config.metadata, url: `https://checkout.stripe.test/${id}` };
  fake.sessions.set(id, session);
  fake.created.push(session);
  return session;
};

/* ------------------------------- helpers -------------------------------- */
let server;
let baseUrl;
let sequence = 0;
async function makeMember({ addresses = 1 } = {}) {
  sequence += 1;
  const addrs = Array.from({ length: addresses }, (_, i) => ({
    label: i ? "Rental" : "Primary",
    line1: `${57 + i} Intervale Ave`,
    city: "Farmingdale",
    state: "NY",
    zip: "11735",
    county: "Nassau",
  }));
  return User.create({
    userId: `6274${sequence}${Date.now() % 10000}`,
    name: "Mike",
    email: `mike${sequence}@example.test`,
    phone: `+1516473${String(6200 + sequence).padStart(4, "0")}`,
    role: "customer",
    stripeCustomerId: `cus_test_${sequence}`,
    addresses: addrs,
    smsPreferences: { transactionalEnabled: true, transactionalConsentAt: new Date() },
  });
}
function record(user, sub, extra = {}) {
  return Subscription.create({
    user: user._id,
    userId: user.userId,
    subscriptionType: "basic",
    addressId: user.addresses[0]._id,
    stripeCustomerId: sub.customer,
    stripeSubscriptionId: sub.id,
    startDate: new Date(sub.created * 1000),
    latestPaymentDate: new Date(sub.current_period_start * 1000),
    nextPaymentDate: new Date(sub.current_period_end * 1000),
    status: sub.status,
    accessStatus: ["active", "trialing"].includes(sub.status) ? "active" : "inactive",
    planPrice: 149,
    ...extra,
  });
}
let eventSeq = 0;
async function deliver(type, object, id = `evt_test_${++eventSeq}`) {
  const payload = JSON.stringify({ id, object: "event", type, data: { object } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body: payload,
  });
  return { status: res.status, id };
}
async function api(user, method, path, body) {
  const token = jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET);
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const fresh = (id) => Subscription.findById(id);

/* --------------------------------- run ---------------------------------- */
async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([StripeWebhookEvent.init(), SmsMessage.init(), Subscription.init()]);

  const app = express();
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), webhook);
  app.use(express.json());
  app.use("/api/stripe/checkout", require("../routes/stripe"));
  app.use("/api/subscriptions", require("../routes/subscriptions"));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  try {
    console.log("\nMike's exact sequence");
    const mike = await makeMember();
    const home = mike.user ? null : mike.addresses[0]._id;
    const cus = mike.stripeCustomerId;
    const legacy = makeSub({ id: "sub_dec2025", customer: cus, status: "canceled", created: "2025-12-12T23:10:06Z", periodEnd: "2025-12-22T19:56:16Z" });
    const oldSub = makeSub({ id: "sub_sept", customer: cus, status: "past_due", addressId: home, userId: mike.userId, created: "2026-09-22T21:48:07Z", periodStart: "2026-10-22T21:48:07Z", periodEnd: "2026-11-22T21:48:07Z", latestInvoice: "in_oct_renewal" });
    fake.invoices.set("in_oct_renewal", { id: "in_oct_renewal", status: "open", customer: cus, subscription: "sub_sept", amount_due: 16185, hosted_invoice_url: "https://invoice.stripe.test/in_oct_renewal" });
    const oldRecord = await record(mike, oldSub, { cancellationReason: "payment_failed" });
    void legacy;

    const newSub = makeSub({ id: "sub_oct30", customer: cus, status: "active", addressId: home, userId: mike.userId, created: "2026-10-30T14:54:03Z", periodEnd: "2026-11-30T14:54:03Z" });
    const session = { id: "cs_live_oct30", object: "checkout.session", mode: "subscription", customer: cus, subscription: newSub.id, client_reference_id: String(home), metadata: { userId: mike.userId, addressId: String(home), plan: "basic" } };

    await check("checkout.session.completed for the new subscription is processed", async () => {
      const { status } = await deliver("checkout.session.completed", session);
      assert.strictEqual(status, 200);
    });
    await check("the new subscription gets its OWN record; the old one keeps its own", async () => {
      const rows = await Subscription.find({ user: mike._id }).sort({ createdAt: 1 });
      assert.strictEqual(rows.length, 2, `records=${rows.length}`);
      assert.strictEqual((await fresh(oldRecord._id)).stripeSubscriptionId, "sub_sept");
      const added = rows.find((r) => r.stripeSubscriptionId === "sub_oct30");
      assert.ok(added && added.status === "active" && added.accessStatus === "active");
    });
    await check("Admin is alerted that the home is billed by two subscriptions", async () => {
      const alerts = sentEmails.filter((e) => e.templateKey === "admin_duplicate_membership_billing");
      assert.strictEqual(alerts.length, 1);
    });

    const pmEvent = { id: "pm_new_card", object: "payment_method", customer: cus };
    let pmDelivery;
    await check("payment_method.attached (old past-due sub + metadata-less canceled sub) succeeds", async () => {
      pmDelivery = await deliver("payment_method.attached", pmEvent);
      assert.strictEqual(pmDelivery.status, 200);
      const evt = await StripeWebhookEvent.findOne({ eventId: pmDelivery.id });
      assert.strictEqual(evt.status, "completed", evt.lastError || "");
    });
    await check("...and the old subscription did NOT overwrite the new membership", async () => {
      const added = await Subscription.findOne({ stripeSubscriptionId: "sub_oct30" });
      assert.strictEqual(added.status, "active");
      assert.strictEqual(added.accessStatus, "active");
      assert.strictEqual((await fresh(oldRecord._id)).status, "past_due");
      assert.strictEqual(await Subscription.countDocuments({ stripeSubscriptionId: "sub_dec2025" }), 0, "no record invented for the legacy sub");
    });
    await check("the account's view of the home picks the paid membership", async () => {
      const chosen = await subsModule.getOwnedSubscriptionForAddress({ userId: mike._id, addressId: home, statuses: ["active", "trialing", "past_due", "unpaid"] });
      assert.strictEqual(chosen.stripeSubscriptionId, "sub_oct30");
      const legacyUser = await User.collection.findOne({ _id: mike._id });
      assert.strictEqual(legacyUser.subscription, "basic");
    });

    console.log("\nRetries, replays, out-of-order, concurrency");
    await check("Stripe re-delivering the same event is a no-op", async () => {
      const again = await deliver("payment_method.attached", pmEvent, pmDelivery.id);
      assert.strictEqual(again.status, 200);
      assert.strictEqual((await Subscription.findOne({ stripeSubscriptionId: "sub_oct30" })).status, "active");
    });
    await check("a previously FAILED event retried later cannot reverse the activation", async () => {
      await StripeWebhookEvent.create({ eventId: "evt_failed_before", eventType: "payment_method.attached", status: "failed", lastError: "Unable to resolve subscription address for Stripe subscription" });
      const retried = await deliver("payment_method.attached", pmEvent, "evt_failed_before");
      assert.strictEqual(retried.status, 200);
      assert.strictEqual((await Subscription.findOne({ stripeSubscriptionId: "sub_oct30" })).accessStatus, "active");
      assert.strictEqual((await fresh(oldRecord._id)).stripeSubscriptionId, "sub_sept");
    });
    await check("a late customer.subscription.updated for the OLD sub only touches the old record", async () => {
      const { status } = await deliver("customer.subscription.updated", oldSub);
      assert.strictEqual(status, 200);
      assert.strictEqual((await Subscription.findOne({ stripeSubscriptionId: "sub_oct30" })).status, "active");
      assert.strictEqual((await fresh(oldRecord._id)).status, "past_due");
    });
    await check("concurrent syncs of both subscriptions leave each record correct", async () => {
      await Promise.all([
        deliver("payment_method.attached", pmEvent),
        deliver("customer.subscription.updated", oldSub),
        deliver("customer.subscription.updated", newSub),
        deliver("payment_method.attached", pmEvent),
      ]);
      const rows = await Subscription.find({ user: mike._id });
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows.find((r) => r.stripeSubscriptionId === "sub_oct30").status, "active");
      assert.strictEqual(rows.find((r) => r.stripeSubscriptionId === "sub_sept").status, "past_due");
    });
    await check("a metadata-less canceled subscription with no record does not fail the webhook", async () => {
      const { status, id } = await deliver("customer.subscription.deleted", fake.subs.get("sub_dec2025"));
      assert.strictEqual(status, 200);
      assert.strictEqual((await StripeWebhookEvent.findOne({ eventId: id })).status, "completed");
    });

    console.log("\nThe repair: retire the old subscription quietly");
    await check("canceling the replaced subscription records why, and tells the customer nothing", async () => {
      const emailsBefore = sentEmails.length;
      const smsBefore = await SmsMessage.countDocuments({ notificationType: "MEMBERSHIP_CANCELLED" });
      const sub = fake.subs.get("sub_sept");
      sub.metadata = { ...sub.metadata, profixterReplacedBy: "sub_oct30" };
      sub.status = "canceled";
      sub.ended_at = T("2026-10-30T17:00:00Z");
      const { status } = await deliver("customer.subscription.deleted", sub);
      assert.strictEqual(status, 200);
      const old = await fresh(oldRecord._id);
      assert.strictEqual(old.status, "canceled");
      assert.strictEqual(old.cancellationReason, "replaced_by_new_subscription");
      const customerEmails = sentEmails.slice(emailsBefore).filter((e) => e.templateKey === "subscription_canceled");
      assert.strictEqual(customerEmails.length, 0, "no 'membership ended' email");
      assert.strictEqual(await SmsMessage.countDocuments({ notificationType: "MEMBERSHIP_CANCELLED" }), smsBefore, "no 'membership ended' text");
      assert.strictEqual((await Subscription.findOne({ stripeSubscriptionId: "sub_oct30" })).status, "active");
    });
    await check("an ordinary cancellation still sends the ended notices", async () => {
      const other = await makeMember();
      const sub = makeSub({ id: "sub_plain_cancel", customer: other.stripeCustomerId, status: "active", addressId: other.addresses[0]._id, userId: other.userId, created: "2026-09-01T00:00:00Z", periodEnd: "2026-11-01T00:00:00Z" });
      await record(other, sub);
      sub.status = "canceled";
      const before = sentEmails.filter((e) => e.templateKey === "subscription_canceled").length;
      await deliver("customer.subscription.deleted", sub);
      assert.strictEqual(sentEmails.filter((e) => e.templateKey === "subscription_canceled").length, before + 1);
    });

    console.log("\nThe restoration notice: once, and only when true");
    await check("not requested: nothing is sent", async () => {
      const stats = await sendDueRestorationNotices({ deps: { retrieve: stripe.subscriptions.retrieve } });
      assert.strictEqual(stats.claimed, 0);
    });
    await check("requested for a working membership: one email and one text", async () => {
      await Subscription.updateOne({ stripeSubscriptionId: "sub_oct30" }, { $set: { "restorationNotice.requestedAt": new Date(), "restorationNotice.requestedBy": "test" } });
      const before = sentEmails.length;
      const [a, b] = await Promise.all([
        sendDueRestorationNotices({ deps: { retrieve: stripe.subscriptions.retrieve } }),
        sendDueRestorationNotices({ deps: { retrieve: stripe.subscriptions.retrieve } }),
      ]);
      assert.strictEqual(a.claimed + b.claimed, 1, "claimed once across two concurrent runs");
      const mails = sentEmails.slice(before).filter((e) => e.templateKey === "membership_restored");
      assert.strictEqual(mails.length, 1);
      assert.strictEqual(mails[0].subject, "Your Profixter Membership Is Active");
      assert.ok(mails[0].text.startsWith("Hi Mike,"));
      assert.ok(mails[0].text.includes("Your October 30 payment was successfully received"));
      const texts = await SmsMessage.find({ notificationType: "MEMBERSHIP_RESTORED" });
      assert.strictEqual(texts.length, 1);
      assert.ok(String(texts[0].body || "").startsWith("Hi Mike! This is Profixter."), texts[0].body);
      const notice = (await Subscription.findOne({ stripeSubscriptionId: "sub_oct30" })).restorationNotice;
      assert.ok(notice.emailSentAt && notice.smsMessageId && !notice.emailError && !notice.smsError, JSON.stringify(notice));
    });
    await check("running again (restart, next tick) sends nothing more", async () => {
      const before = sentEmails.length;
      const stats = await sendDueRestorationNotices({ deps: { retrieve: stripe.subscriptions.retrieve } });
      assert.strictEqual(stats.claimed, 0);
      assert.strictEqual(sentEmails.length, before);
      assert.strictEqual(await SmsMessage.countDocuments({ notificationType: "MEMBERSHIP_RESTORED" }), 1);
    });
    await check("requested while Stripe does not show it active: skipped, nothing sent", async () => {
      const other = await makeMember();
      const sub = makeSub({ id: "sub_not_really_active", customer: other.stripeCustomerId, status: "past_due", addressId: other.addresses[0]._id, userId: other.userId, created: "2026-09-01T00:00:00Z", periodEnd: "2026-11-01T00:00:00Z" });
      const row = await record(other, { ...sub, status: "active" }, { restorationNotice: { requestedAt: new Date() } });
      const before = sentEmails.length;
      await sendDueRestorationNotices({ deps: { retrieve: stripe.subscriptions.retrieve } });
      assert.strictEqual(sentEmails.length, before);
      assert.strictEqual((await fresh(row._id)).restorationNotice.skippedReason, "stripe_past_due");
    });

    console.log("\nCheckout: no second membership for a home Stripe is billing");
    const pd = await makeMember();
    const pdHome = pd.addresses[0]._id;
    const pdSub = makeSub({ id: "sub_pd", customer: pd.stripeCustomerId, status: "past_due", addressId: pdHome, userId: pd.userId, created: "2026-09-10T00:00:00Z", periodEnd: "2026-11-10T00:00:00Z", latestInvoice: "in_pd" });
    fake.invoices.set("in_pd", { id: "in_pd", status: "open", customer: pd.stripeCustomerId, amount_due: 16185, hosted_invoice_url: "https://invoice.stripe.test/in_pd" });
    await record(pd, pdSub);
    await check("past due: checkout refused and pointed at payment recovery", async () => {
      const res = await api(pd, "POST", "/api/stripe/checkout/create-checkout-session", { plan: "basic", addressId: String(pdHome), billingCycle: "monthly" });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.code, "MEMBERSHIP_PAYMENT_RECOVERY_REQUIRED");
      assert.strictEqual(fake.created.length, 0);
    });
    await check("past due with NO local record (the stale-database case) is refused too", async () => {
      await Subscription.deleteMany({ user: pd._id });
      const res = await api(pd, "POST", "/api/stripe/checkout/create-checkout-session", { plan: "basic", addressId: String(pdHome), billingCycle: "monthly" });
      assert.strictEqual(res.body.code, "MEMBERSHIP_PAYMENT_RECOVERY_REQUIRED");
    });
    await check("payment recovery opens Stripe's page for the unpaid renewal", async () => {
      const res = await api(pd, "POST", `/api/subscriptions/manage/address/${pdHome}/payment-recovery`);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual([res.body.kind, res.body.url], ["invoice", "https://invoice.stripe.test/in_pd"]);
    });
    await check("no unpaid invoice: recovery falls back to the billing portal", async () => {
      fake.invoices.get("in_pd").status = "paid";
      const res = await api(pd, "POST", `/api/subscriptions/manage/address/${pdHome}/payment-recovery`);
      assert.deepStrictEqual([res.body.kind, res.body.url], ["portal", "https://billing.stripe.test/portal"]);
    });
    await check("active in Stripe: checkout refused as already subscribed", async () => {
      pdSub.status = "active";
      const res = await api(pd, "POST", "/api/stripe/checkout/create-checkout-session", { plan: "basic", addressId: String(pdHome), billingCycle: "monthly" });
      assert.strictEqual(res.body.code, "ADDRESS_ALREADY_SUBSCRIBED");
    });
    await check("canceled for good: a fresh membership can be bought", async () => {
      pdSub.status = "canceled";
      const res = await api(pd, "POST", "/api/stripe/checkout/create-checkout-session", { plan: "basic", addressId: String(pdHome), billingCycle: "monthly" });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.url);
    });
    await check("buying again closes the earlier checkout still open for that home", async () => {
      const first = fake.created[fake.created.length - 1].id;
      const res = await api(pd, "POST", "/api/stripe/checkout/create-checkout-session", { plan: "basic", addressId: String(pdHome), billingCycle: "monthly" });
      assert.strictEqual(res.status, 200);
      assert.ok(fake.expired.includes(first), `expired=${fake.expired}`);
    });
    await check("two simultaneous checkouts: only one is opened", async () => {
      const racer = await makeMember();
      const before = fake.created.length;
      fake.createDelay = 300;
      const results = await Promise.all([1, 2].map(() => api(racer, "POST", "/api/stripe/checkout/create-checkout-session", { plan: "basic", addressId: String(racer.addresses[0]._id), billingCycle: "monthly" })));
      fake.createDelay = 0;
      assert.deepStrictEqual(results.map((r) => r.status).sort(), [200, 409]);
      assert.strictEqual(results.find((r) => r.status === 409).body.code, "CHECKOUT_ALREADY_OPENING");
      assert.strictEqual(fake.created.length, before + 1);
    });

    console.log("\nLegitimate cases keep working");
    await check("a second home gets its own membership; neither disturbs the other", async () => {
      const alertsBefore = sentEmails.filter((e) => e.templateKey === "admin_duplicate_membership_billing").length;
      const owner = await makeMember({ addresses: 2 });
      const [h1, h2] = owner.addresses.map((a) => a._id);
      const s1 = makeSub({ id: "sub_home1", customer: owner.stripeCustomerId, status: "active", addressId: h1, userId: owner.userId, created: "2026-08-01T00:00:00Z", periodEnd: "2026-11-01T00:00:00Z" });
      await deliver("customer.subscription.created", s1);
      const res = await api(owner, "POST", "/api/stripe/checkout/create-checkout-session", { plan: "basic", addressId: String(h2), billingCycle: "monthly" });
      assert.strictEqual(res.status, 200, "the second home may buy");
      const s2 = makeSub({ id: "sub_home2", customer: owner.stripeCustomerId, status: "active", addressId: h2, userId: owner.userId, created: "2026-10-01T00:00:00Z", periodEnd: "2026-11-01T00:00:00Z" });
      await deliver("checkout.session.completed", { id: "cs_home2", object: "checkout.session", mode: "subscription", customer: owner.stripeCustomerId, subscription: s2.id, metadata: { userId: owner.userId, addressId: String(h2) } });
      await deliver("payment_method.attached", { id: "pm_owner", customer: owner.stripeCustomerId });
      const rows = await Subscription.find({ user: owner._id });
      assert.strictEqual(rows.length, 2);
      assert.ok(rows.every((r) => r.status === "active" && r.accessStatus === "active"));
      assert.strictEqual(sentEmails.filter((e) => e.templateKey === "admin_duplicate_membership_billing").length, alertsBefore, "two homes is not a duplicate");
    });
    await check("a legacy admin-created membership is adopted by the Stripe subscription (one record)", async () => {
      const legacyMember = await makeMember();
      const manual = await Subscription.create({ user: legacyMember._id, userId: legacyMember.userId, subscriptionType: "basic", addressId: legacyMember.addresses[0]._id, startDate: new Date("2026-05-05"), latestPaymentDate: new Date("2026-10-05"), nextPaymentDate: new Date("2026-11-05"), status: "active", accessStatus: "active" });
      const sub = makeSub({ id: "sub_for_manual", customer: legacyMember.stripeCustomerId, status: "active", addressId: legacyMember.addresses[0]._id, userId: legacyMember.userId, created: "2026-05-05T00:00:00Z", periodEnd: "2026-11-05T00:00:00Z" });
      await deliver("customer.subscription.updated", sub);
      const rows = await Subscription.find({ user: legacyMember._id });
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(String(rows[0]._id), String(manual._id));
      assert.strictEqual(rows[0].stripeSubscriptionId, "sub_for_manual");
    });
    await check("an unlinked paying member (no Stripe metadata) is linked once, then every event finds her", async () => {
      // Larisa's shape: Stripe subscription from an old, deleted account, no metadata; her current
      // account holds an admin-created active record and no Stripe customer id.
      sequence += 1;
      const member = await User.create({
        userId: `8611${sequence}${Date.now() % 10000}`, name: "Larisa", email: `lar${sequence}@example.test`,
        phone: `+1516555${String(3300 + sequence).padStart(4, "0")}`, role: "customer",
        addresses: [{ label: "Home", line1: "2129 Washington Ave", city: "Seaford", state: "NY", zip: "11783" }],
        smsPreferences: { transactionalEnabled: true, transactionalConsentAt: new Date() },
      });
      const homeId = member.addresses[0]._id;
      const manual = await Subscription.create({ user: member._id, userId: member.userId, subscriptionType: "basic", addressId: homeId, startDate: new Date("2026-05-05"), latestPaymentDate: new Date("2026-05-05"), nextPaymentDate: new Date("2026-06-05"), status: "active", accessStatus: "active" });
      const sub = makeSub({ id: "sub_unlinked", customer: "cus_unlinked", status: "active", created: "2025-07-21T18:53:02Z", periodStart: "2026-10-21T18:53:02Z", periodEnd: "2026-11-21T18:53:02Z", metadata: {} });

      const before = sentEmails.length;
      const smsBefore = await SmsMessage.countDocuments({});
      // Before linking, her events reach nobody - which is the defect being repaired.
      await deliver("invoice.paid", { id: "in_unlinked_0", object: "invoice", subscription: sub.id, customer: "cus_unlinked", status: "paid", created: T("2026-10-21T18:53:02Z") });
      assert.ok(!(await fresh(manual._id)).stripeSubscriptionId, "still unlinked");

      // The repair: the customer id on her account, then one sync with her home as the hint.
      await User.collection.updateOne({ _id: member._id, stripeCustomerId: null }, { $set: { stripeCustomerId: "cus_unlinked" } });
      const linked = await subsModule.upsertSubscriptionFromStripe({ stripeSubscription: await stripe.subscriptions.retrieve(sub.id), user: await User.findById(member._id), addressIdHint: String(homeId) });
      assert.strictEqual(String(linked._id), String(manual._id), "her existing record is the one linked");
      assert.deepStrictEqual([linked.stripeSubscriptionId, linked.status, linked.accessStatus], ["sub_unlinked", "active", "active"]);

      // A failed renewal reaches her record.
      sub.status = "past_due";
      await deliver("customer.subscription.updated", sub);
      assert.deepStrictEqual([(await fresh(manual._id)).status, (await fresh(manual._id)).accessStatus], ["past_due", "inactive"]);
      // Paying it restores her.
      sub.status = "active";
      await deliver("invoice.paid", { id: "in_unlinked_1", object: "invoice", subscription: sub.id, customer: "cus_unlinked", status: "paid", created: T("2026-11-21T18:53:02Z"), status_transitions: { paid_at: T("2026-11-21T18:53:02Z") } });
      assert.deepStrictEqual([(await fresh(manual._id)).status, (await fresh(manual._id)).accessStatus], ["active", "active"]);
      // Canceling in Stripe ends her access here too.
      sub.status = "canceled";
      await deliver("customer.subscription.deleted", sub);
      assert.strictEqual((await fresh(manual._id)).status, "canceled");
      assert.strictEqual(await Subscription.countDocuments({ user: member._id }), 1, "never a second record");
      // The link itself sent nothing; only the genuine cancellation notified her.
      const linkMail = sentEmails.slice(before).filter((e) => e.templateKey !== "subscription_canceled");
      assert.deepStrictEqual(linkMail.map((e) => e.templateKey), []);
      void smsBefore;
    });
    await check("failed renewal then payment: the same membership becomes active again", async () => {
      const m = await makeMember();
      const sub = makeSub({ id: "sub_recovers", customer: m.stripeCustomerId, status: "past_due", addressId: m.addresses[0]._id, userId: m.userId, created: "2026-09-01T00:00:00Z", periodEnd: "2026-11-01T00:00:00Z" });
      const row = await record(m, sub, { cancellationReason: "payment_failed" });
      sub.status = "active";
      await deliver("invoice.paid", { id: "in_recovered", object: "invoice", subscription: sub.id, customer: m.stripeCustomerId, status: "paid", created: T("2026-10-31T00:00:00Z"), status_transitions: { paid_at: T("2026-10-31T00:00:00Z") } });
      const after = await fresh(row._id);
      assert.deepStrictEqual([after.status, after.accessStatus, after.cancellationReason], ["active", "active", null]);
      assert.strictEqual(await Subscription.countDocuments({ user: m._id }), 1);
    });
    await check("if a home ever IS billed twice, Admin is told once (nothing auto-canceled)", async () => {
      const alertsBefore = sentEmails.filter((e) => e.templateKey === "admin_duplicate_membership_billing").length;
      const d = await makeMember();
      const home2 = d.addresses[0]._id;
      makeSub({ id: "sub_dup_a", customer: d.stripeCustomerId, status: "active", addressId: home2, userId: d.userId, created: "2026-09-01T00:00:00Z", periodEnd: "2026-11-01T00:00:00Z" });
      await deliver("customer.subscription.created", fake.subs.get("sub_dup_a"));
      makeSub({ id: "sub_dup_b", customer: d.stripeCustomerId, status: "active", addressId: home2, userId: d.userId, created: "2026-10-15T00:00:00Z", periodEnd: "2026-11-15T00:00:00Z" });
      const completed = { id: "cs_dup_b", object: "checkout.session", mode: "subscription", customer: d.stripeCustomerId, subscription: "sub_dup_b", metadata: { userId: d.userId, addressId: String(home2) } };
      await deliver("checkout.session.completed", completed);
      await deliver("checkout.session.completed", completed);
      assert.strictEqual(sentEmails.filter((e) => e.templateKey === "admin_duplicate_membership_billing").length, alertsBefore + 1);
      const rows = await Subscription.find({ user: d._id });
      assert.ok(rows.every((r) => r.status === "active"), "Stripe-backed records are never hidden as canceled");
    });
  } finally {
    server.close();
    await mongoose.disconnect();
    await mongo.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
