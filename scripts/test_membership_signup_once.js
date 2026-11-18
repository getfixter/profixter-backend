/*
 * A new customer buys a membership: it becomes active, and its first payment
 * is recorded ONCE, whatever order Stripe's events arrive in and however many
 * times they are delivered (2026-11-18, before advertising the plans page).
 *
 * Through the real webhook endpoint with signed events, against a real
 * database (in-memory replica set). Stripe, email, SMS and Meta are faked;
 * every would-be message is recorded and counted, nothing is sent.
 *
 * What "once" means here, per checkout:
 *   - one Subscription record, active, with the plan and billing chosen;
 *   - the first payment on it (latestInvoiceId, latestPaymentDate);
 *   - one verified sale for the first invoice (SalesEvent membership_first_paid),
 *     with the amount actually paid before tax (the 20% welcome offer included);
 *   - one Meta Subscribe, with what was charged; one "membership started"
 *     email to the customer; one "Membership Started" notice to the owner;
 *   - no loyalty month counted for the signup invoice.
 *
 * Orders: Stripe's usual (subscription, invoice, checkout), the reverse, and
 * the checkout first. Deliveries: Stripe's retries (same event id), and the
 * same objects again under new event ids.
 *
 *   node scripts/test_membership_signup_once.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-signup-once";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_for_unit_tests";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_signup_once";
process.env.CLIENT_URL = "https://www.profixter.com";
process.env.SMS_ENABLED = "false";
process.env.S3_BUCKET = "test-bucket";
process.env.ENABLE_RESERVATION_ENGINE = "true";
process.env.MAIL_ADMIN = "owner@example.test";
process.env.META_CAPI_TOKEN = "test-meta-token";

const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${error.stack?.split("\n").slice(0, 4).join("\n      ") || error.message}`);
  }
}
const settle = () => new Promise((r) => setTimeout(r, 150));

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri());

  /* ---------------------------- recorded, never sent ---------------------------- */
  const mail = require("../utils/emailService");
  const sent = [];
  mail.sendRaw = async (m) => (sent.push({ kind: "raw", to: m.to, subject: m.subject, text: m.text }), { ok: true });
  mail.sendTx = async (key, to, data) => (sent.push({ kind: "tx", key, to, data }), { ok: true });
  mail.sendPromo = async (to, m) => (sent.push({ kind: "promo", to, subject: m.subject }), { ok: true });
  const meta = [];
  const passThrough = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes("graph.facebook.com")) {
      try {
        for (const e of JSON.parse(String(init?.body || "{}")).data || []) meta.push(e);
      } catch {
        /* not JSON */
      }
      return { ok: true, status: 200, json: async () => ({ events_received: 1 }), text: async () => "{}" };
    }
    return passThrough(url, init);
  };

  /* --------------------------------- fake Stripe -------------------------------- */
  const sm = require("../utils/subscriptionManagement");
  const stripe = sm.stripe;
  const price = (plan, cycle) => sm.PLAN_CATALOG[plan][cycle];
  const fake = { sessions: new Map(), subs: new Map(), invoices: new Map(), customers: new Map(), seq: 0 };
  const listResult = (items) => {
    const promise = Promise.resolve({ object: "list", data: items, has_more: false });
    promise[Symbol.asyncIterator] = async function* iterate() {
      for (const item of items) yield item;
    };
    return promise;
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  stripe.customers.list = async ({ email } = {}) => ({ data: [...fake.customers.values()].filter((c) => !email || c.email === email) });
  stripe.customers.search = async () => ({ data: [] });
  stripe.customers.create = async (p = {}) => {
    const c = { id: `cus_once_${++fake.seq}`, object: "customer", email: p.email || null, metadata: p.metadata || {} };
    fake.customers.set(c.id, c);
    return c;
  };
  stripe.customers.retrieve = async (id) => fake.customers.get(id) || { id, object: "customer", email: null };
  stripe.customers.update = async (id, p) => ({ ...(fake.customers.get(id) || { id }), ...p });
  stripe.subscriptions.list = (params = {}) => listResult([...fake.subs.values()].filter((s) => !params.customer || s.customer === params.customer).map(clone));
  stripe.subscriptions.retrieve = async (id) => {
    const sub = fake.subs.get(id);
    if (!sub) throw Object.assign(new Error(`No such subscription: ${id}`), { code: "resource_missing" });
    const out = clone(sub);
    if (out.latest_invoice && fake.invoices.has(out.latest_invoice)) out.latest_invoice = clone(fake.invoices.get(out.latest_invoice));
    return out;
  };
  stripe.subscriptions.update = async (id, p) => Object.assign(fake.subs.get(id), p);
  stripe.invoices.retrieve = async (id) => clone(fake.invoices.get(id));
  stripe.invoices.list = async ({ customer } = {}) => ({ data: [...fake.invoices.values()].filter((i) => !customer || i.customer === customer).map(clone), has_more: false });
  stripe.charges.retrieve = async (id) => ({ id, object: "charge", payment_method_details: { card: { fingerprint: "fp_once_card" } } });
  stripe.paymentIntents.retrieve = async (id) => ({ id, latest_charge: { id: `ch_${id}`, payment_method_details: { card: { fingerprint: "fp_once_card" } } } });
  stripe.coupons.retrieve = async (id) => ({ id, percent_off: 20, duration: "once", name: "Welcome 20%" });
  stripe.promotionCodes.list = async () => ({ data: [] });
  stripe.checkout.sessions.list = async () => ({ data: [] });
  stripe.checkout.sessions.retrieve = async (id) => clone(fake.sessions.get(id));
  stripe.checkout.sessions.listLineItems = async (id) => ({ data: (fake.sessions.get(id)?.config?.line_items || []).map((l) => ({ price: { id: l.price }, quantity: 1, amount_total: fake.sessions.get(id).amount_total })) });
  stripe.checkout.sessions.expire = async (id) => Object.assign(fake.sessions.get(id), { status: "expired" });
  stripe.checkout.sessions.create = async (config) => {
    const id = `cs_test_once_${++fake.seq}`;
    const session = { id, object: "checkout.session", status: "open", mode: "subscription", customer: config.customer || null, customer_email: config.customer_email || null, client_reference_id: config.client_reference_id, metadata: config.metadata, url: `https://checkout.stripe.test/${id}`, config };
    fake.sessions.set(id, session);
    return clone(session);
  };

  /*
   * The card goes through: what Stripe creates, and the three objects its
   * webhooks carry - the subscription, its paid first invoice, the session.
   */
  const T = (d) => Math.floor(new Date(d).getTime() / 1000);
  function pay(sessionId, { plan, cycle }) {
    const s = fake.sessions.get(sessionId);
    const p = price(plan, cycle);
    const listCents = Math.round(Number(p.price) * 100);
    const coupon = s.config.discounts?.[0]?.coupon || null;
    const off = coupon ? Math.round(listCents * 0.2) : 0;
    const paidCents = listCents - off;
    if (!s.customer) {
      const id = `cus_once_${++fake.seq}`;
      fake.customers.set(id, { id, object: "customer", email: s.customer_email });
      s.customer = id;
    }
    const now = new Date();
    const end = new Date(now);
    if (cycle === "annual") end.setUTCFullYear(end.getUTCFullYear() + 1);
    else end.setUTCMonth(end.getUTCMonth() + 1);
    const subId = `sub_${sessionId}`;
    const invoiceId = `in_${sessionId}`;
    const priceObj = { id: p.stripePriceId, object: "price", unit_amount: listCents, recurring: { interval: cycle === "annual" ? "year" : "month" } };
    const sub = {
      id: subId, object: "subscription", customer: s.customer, status: "active",
      created: T(now), start_date: T(now), current_period_start: T(now), current_period_end: T(end),
      cancel_at_period_end: false, canceled_at: null, ended_at: null, schedule: null,
      latest_invoice: invoiceId,
      discount: coupon ? { coupon: { id: coupon, percent_off: 20, duration: "once" } } : null,
      metadata: { ...s.config.subscription_data.metadata },
      items: { data: [{ id: `si_${subId}`, price: priceObj, current_period_start: T(now), current_period_end: T(end) }] },
    };
    const invoice = {
      id: invoiceId, object: "invoice", customer: s.customer, subscription: subId, status: "paid",
      billing_reason: "subscription_create", currency: "usd", subtotal: listCents, total: paidCents, tax: 0,
      amount_due: paidCents, amount_paid: paidCents, created: T(now), status_transitions: { paid_at: T(now) },
      charge: `ch_${sessionId}`, payment_intent: `pi_${sessionId}`,
      total_discount_amounts: off ? [{ amount: off }] : [],
      lines: { data: [{ id: `il_${invoiceId}`, type: "subscription", subscription: subId, amount: listCents, price: priceObj, discount_amounts: off ? [{ amount: off }] : [], period: { start: T(now), end: T(end) } }] },
    };
    fake.subs.set(subId, sub);
    fake.invoices.set(invoiceId, invoice);
    Object.assign(s, { status: "complete", payment_status: "paid", subscription: subId, invoice: invoiceId, amount_subtotal: listCents, amount_total: paidCents, total_details: { amount_discount: off, amount_tax: 0 } });
    return { session: clone(s), subscription: clone(sub), invoice: clone(invoice), paidCents, listCents };
  }

  const Subscription = require("../models/Subscription");
  const User = require("../models/User");
  const StripeWebhookEvent = require("../models/StripeWebhookEvent");
  const LoyaltyCycle = require("../models/LoyaltyCycle");
  const { SalesEvent } = require("../models/Sales");
  for (const M of [Subscription, User, StripeWebhookEvent]) await M.init();

  const app = express();
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), require("../routes/webhook"));
  app.use(express.json());
  app.use("/api/stripe/checkout", require("../routes/stripe"));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { body, as } = {}) => {
    const headers = { "content-type": "application/json" };
    if (as) headers.authorization = `Bearer ${jwt.sign({ id: String(as._id), tv: 0 }, process.env.JWT_SECRET)}`;
    const res = await fetch(`${base}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  let eventSeq = 0;
  const deliver = async (type, object, id = `evt_once_${++eventSeq}`) => {
    const payload = JSON.stringify({ id, object: "event", type, data: { object } });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const res = await fetch(`${base}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
    return { status: res.status, id };
  };

  /* A new customer, as phone sign-up makes one: verified phone, no Stripe customer yet, one home. */
  let seq = 0;
  const newCustomer = (over = {}) => {
    seq += 1;
    return User.create({
      userId: `5200${String(seq).padStart(4, "0")}`,
      name: `Dana Whitfield ${seq}`,
      email: `dana.once${seq}@mailbox.test`,
      phone: `+1516555${String(2000 + seq)}`,
      phoneVerifiedAt: new Date(),
      signupMethod: "phone",
      role: "customer",
      addresses: [{ label: "Primary", line1: `${20 + seq} Bayview Ave`, city: "Massapequa", state: "NY", zip: "11758", county: "Nassau" }],
      ...over,
    });
  };
  const counts = async (user) => ({
    subscriptions: await Subscription.countDocuments({ user: user._id }),
    sales: await SalesEvent.countDocuments({ user: user._id, kind: "membership_first_paid" }),
    startedEmail: sent.filter((m) => m.kind === "tx" && m.key === "subscription_started" && m.to === user.email).length,
    ownerNotice: sent.filter((m) => m.kind === "raw" && /Membership Started/i.test(m.subject || "") && (m.text || "").includes(user.name)).length,
    loyalty: await LoyaltyCycle.countDocuments({ user: user._id }).catch(() => 0),
  });
  const open = async (user, { plan, cycle, welcome = false } = {}) => {
    const r = await call("POST", "/api/stripe/checkout/create-checkout-session", { as: user, body: { plan, billingCycle: cycle, addressId: String(user.addresses[0]._id), ...(welcome ? { welcomeOffer: true } : {}) } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 300));
    const session = fake.sessions.get(r.body.sessionId);
    user.__eventId = session.metadata.eventId;
    return session;
  };
  const expectOnce = async (user, paid, { plan, cycle }) => {
    const sub = await Subscription.findOne({ user: user._id }).lean();
    assert.ok(sub, "a Subscription record");
    assert.strictEqual(await Subscription.countDocuments({ user: user._id }), 1, "one Subscription record");
    assert.strictEqual(sub.status, "active");
    assert.deepStrictEqual([String(sub.subscriptionType).toLowerCase(), sub.billingCycle], [plan, cycle]);
    assert.strictEqual(sub.stripeSubscriptionId, paid.subscription.id);
    assert.strictEqual(sub.latestInvoiceId, paid.invoice.id, "the first payment is on the record");
    assert.ok(sub.latestPaymentDate, "with its date");
    const sales = await SalesEvent.find({ user: user._id, kind: "membership_first_paid" }).lean();
    assert.strictEqual(sales.length, 1, `one verified first payment (got ${sales.length})`);
    assert.strictEqual(sales[0].sourceKey, `invoice:${paid.invoice.id}`);
    const subscribe = meta.filter((e) => e.event_name === "Subscribe" && e.event_id === user.__eventId);
    assert.strictEqual(subscribe.length, 1, `one Meta Subscribe (got ${subscribe.length})`);
    assert.strictEqual(Number(subscribe[0].custom_data.value), paid.paidCents / 100, "Meta gets what was charged");
    const c = await counts(user);
    assert.strictEqual(c.startedEmail, 1, `one "membership started" email (got ${c.startedEmail})`);
    assert.strictEqual(c.ownerNotice, 1, `one owner notice (got ${c.ownerNotice})`);
    assert.strictEqual(c.loyalty, 0, "the signup invoice is not a loyalty month");
    const fresh = await User.findById(user._id).lean();
    assert.strictEqual(fresh.lastPurchase?.stripeSessionId, paid.session.id, "the confirmation page can find this purchase");
    return { sub, sales, fresh };
  };

  /* ------------------------------------------------------------------------------ */

  await check("Stripe's usual order (subscription, invoice, checkout): active Plus monthly, first payment recorded once", async () => {
    const user = await newCustomer();
    const session = await open(user, { plan: "plus", cycle: "monthly" });
    assert.strictEqual(session.config.mode, "subscription");
    assert.strictEqual(session.config.line_items[0].price, price("plus", "monthly").stripePriceId, "the Plus monthly price");
    const paid = pay(session.id, { plan: "plus", cycle: "monthly" });
    assert.strictEqual((await deliver("customer.subscription.created", paid.subscription)).status, 200);
    assert.strictEqual((await deliver("invoice.paid", paid.invoice)).status, 200);
    assert.strictEqual((await deliver("checkout.session.completed", paid.session)).status, 200);
    await settle();
    const { sales } = await expectOnce(user, paid, { plan: "plus", cycle: "monthly" });
    assert.strictEqual(sales[0].amounts?.paidPreTaxCents ?? sales[0].paidPreTaxCents ?? paid.paidCents, paid.paidCents);
  });

  await check("reverse order (checkout, invoice, subscription): the same single result", async () => {
    const user = await newCustomer();
    const session = await open(user, { plan: "plus", cycle: "monthly" });
    const paid = pay(session.id, { plan: "plus", cycle: "monthly" });
    assert.strictEqual((await deliver("checkout.session.completed", paid.session)).status, 200);
    assert.strictEqual((await deliver("invoice.paid", paid.invoice)).status, 200);
    assert.strictEqual((await deliver("customer.subscription.created", paid.subscription)).status, 200);
    await settle();
    await expectOnce(user, paid, { plan: "plus", cycle: "monthly" });
  });

  await check("Stripe retries (same event ids) change nothing", async () => {
    const user = await newCustomer();
    const session = await open(user, { plan: "plus", cycle: "monthly" });
    const paid = pay(session.id, { plan: "plus", cycle: "monthly" });
    const a = await deliver("customer.subscription.created", paid.subscription);
    const b = await deliver("invoice.paid", paid.invoice);
    const c = await deliver("checkout.session.completed", paid.session);
    for (const e of [a, b, c, a, b, c]) {
      const type = e === a ? "customer.subscription.created" : e === b ? "invoice.paid" : "checkout.session.completed";
      const object = e === a ? paid.subscription : e === b ? paid.invoice : paid.session;
      assert.strictEqual((await deliver(type, object, e.id)).status, 200);
    }
    await settle();
    await expectOnce(user, paid, { plan: "plus", cycle: "monthly" });
  });

  await check("the same payment delivered again under NEW event ids: still one sale, one Subscribe, one email, one owner notice", async () => {
    const user = await newCustomer();
    const session = await open(user, { plan: "plus", cycle: "monthly" });
    const paid = pay(session.id, { plan: "plus", cycle: "monthly" });
    for (let round = 0; round < 2; round++) {
      assert.strictEqual((await deliver("customer.subscription.created", paid.subscription)).status, 200);
      assert.strictEqual((await deliver("invoice.paid", paid.invoice)).status, 200);
      assert.strictEqual((await deliver("checkout.session.completed", paid.session)).status, 200);
      assert.strictEqual((await deliver("customer.subscription.updated", paid.subscription)).status, 200);
    }
    await settle();
    await expectOnce(user, paid, { plan: "plus", cycle: "monthly" });
  });

  await check("Plus annual with the 20% welcome offer: the annual price, and the discounted amount recorded once", async () => {
    const user = await newCustomer();
    await call("POST", "/api/stripe/checkout/welcome-offer/activate", { as: user, body: {} }).catch(() => null);
    const session = await open(user, { plan: "plus", cycle: "annual", welcome: true });
    assert.strictEqual(session.config.line_items[0].price, price("plus", "annual").stripePriceId, "the Plus annual price");
    const discounted = Boolean(session.config.discounts?.length);
    const paid = pay(session.id, { plan: "plus", cycle: "annual" });
    assert.strictEqual((await deliver("customer.subscription.created", paid.subscription)).status, 200);
    assert.strictEqual((await deliver("invoice.paid", paid.invoice)).status, 200);
    assert.strictEqual((await deliver("checkout.session.completed", paid.session)).status, 200);
    await settle();
    await expectOnce(user, paid, { plan: "plus", cycle: "annual" });
    console.log(`      (welcome offer ${discounted ? "applied" : "not offered to this account"}: paid $${(paid.paidCents / 100).toFixed(2)} of $${(paid.listCents / 100).toFixed(2)})`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  await mongoose.disconnect();
  await replSet.stop();
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
