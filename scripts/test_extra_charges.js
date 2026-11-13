/*
 * Charge customer ("Charge extra"), end to end: owner-only access, server-side
 * ownership, the saved card, the PaymentIntent for exactly the entered total,
 * payment links, webhooks, refunds and background reconciliation.
 *
 * Real routes (Admin extra charges, Admin jobs, /api/pay, the Stripe webhook
 * with real signatures), a real in-memory MongoDB replica set. Stripe's API,
 * email and SMS are faked: nothing leaves the machine and nobody is charged.
 *
 *   node scripts/test_extra_charges.js
 */
Object.assign(process.env, {
  NODE_ENV: "test",
  JWT_SECRET: "test-secret-extra-charges",
  STRIPE_SECRET_KEY: "sk_test_fake_for_unit_tests",
  STRIPE_WEBHOOK_SECRET: "whsec_test_extra_charges",
  CLIENT_URL: "https://www.profixter.com",
  SMS_ENABLED: "false",
  S3_BUCKET: "test-bucket",
  AWS_REGION: "us-east-1",
  MAIL_ADMIN: "owner@example.test",
});

const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
/* Unrelated to extras: the abandoned-membership proposal the webhook makes on checkout.session.expired. */
stub("../utils/growth/checkoutRecovery", { async proposeCheckoutRecovery() {} });
const sentEmails = [];
const realMail = require("../utils/emailService");
stub("../utils/emailService", {
  ...realMail,
  async sendTx(templateKey, to) {
    sentEmails.push({ templateKey, to });
    return { messageId: `fake-${sentEmails.length}` };
  },
  async sendRaw({ to, subject, logContext = {} }) {
    sentEmails.push({ templateKey: logContext.templateKey || "raw", to, subject });
    return { messageId: `fake-${sentEmails.length}` };
  },
  async sendPromo(to, { subject }) {
    sentEmails.push({ templateKey: "promo", to, subject });
    return { messageId: "fake" };
  },
});

const Stripe = require("stripe");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const User = require("../models/User");
const Booking = require("../models/Booking");
const Subscription = require("../models/Subscription");
const AdditionalCharge = require("../models/AdditionalCharge");
const AdminPaymentLink = require("../models/AdminPaymentLink");
const AdminActivityLog = require("../models/AdminActivityLog");
const VisitEntitlement = require("../models/VisitEntitlement");
const extras = require("../utils/extraCharges");
const { sweepOpen, sweepRefunds } = require("../utils/extraCharges/sweep");
const customerBilling = require("../utils/admin/customerBilling");
const { classifyCharge } = require("../utils/analytics/stripeRevenue");
const { hashToken } = require("../utils/admin/paymentLinks");
const webhook = require("../routes/webhook");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(error.stack || error.message).split("\n").slice(0, 4).join("\n      ")}`);
  }
}

/* ------------------------------ fake Stripe ------------------------------ */
const F = {
  customers: new Map(),
  pms: new Map(),
  pis: new Map(),
  sessions: new Map(),
  idem: new Map(),
  calls: [],
  taxTx: [],
  reversals: [],
  seq: 0,
  timeoutOnce: new Set(), // payment methods whose first create "times out" after reaching Stripe
  lostOnce: new Set(), // payment methods whose first create never reaches Stripe
  cancelFails: new Set(), // PaymentIntents whose cancel Stripe does not confirm (network)
  expireFails: new Set(), // Checkout sessions whose expire call fails
  taxReason: "standard_rated",
  taxRate: 8.625,
};
const nid = (p) => `${p}_${++F.seq}`;
const now = () => Math.floor(Date.now() / 1000);
function list(data) {
  return { object: "list", data, has_more: false };
}
function idemReplay(key, fn) {
  if (key && F.idem.has(key)) {
    const saved = F.idem.get(key);
    if (saved.error) throw saved.error;
    return saved.value;
  }
  try {
    const value = fn();
    if (key) F.idem.set(key, { value });
    return value;
  } catch (error) {
    if (key && error.type === "StripeCardError") F.idem.set(key, { error });
    throw error;
  }
}
function cardError(pi, code, message, decline_code) {
  const e = new Stripe.errors.StripeCardError({ message, code, decline_code, payment_intent: pi, type: "card_error" });
  e.payment_intent = pi;
  return e;
}
const fakeStripe = {
  customers: {
    async list(params) {
      F.calls.push(["customers.list", params?.email]);
      return list([...F.customers.values()].filter((c) => c.email === params?.email).reverse());
    },
    async search(params) {
      F.calls.push(["customers.search", params?.query]);
      return list([]);
    },
    async retrieve(id) {
      F.calls.push(["customers.retrieve", id]);
      const c = F.customers.get(id);
      if (!c) throw Object.assign(new Stripe.errors.StripeInvalidRequestError({ message: "No such customer", code: "resource_missing" }), { statusCode: 404 });
      return c;
    },
  },
  subscriptions: {
    async list({ customer }) {
      return list((F.customers.get(customer)?.subs || []).map((s) => ({ ...s, customer })));
    },
  },
  paymentMethods: {
    async list({ customer }) {
      return list([...F.pms.values()].filter((p) => p.customer === customer));
    },
    async retrieve(id) {
      F.calls.push(["paymentMethods.retrieve", id]);
      const pm = F.pms.get(id);
      if (!pm) throw new Stripe.errors.StripeInvalidRequestError({ message: "No such payment method", code: "resource_missing" });
      return pm;
    },
  },
  paymentIntents: {
    async create(params, options) {
      F.calls.push(["paymentIntents.create", params.payment_method, options?.idempotencyKey]);
      const key = options?.idempotencyKey;
      if (F.lostOnce.has(params.payment_method)) {
        F.lostOnce.delete(params.payment_method);
        throw new Stripe.errors.StripeConnectionError({ message: "socket hang up" });
      }
      const reached = key && F.idem.has(key);
      const result = idemReplay(key, () => {
        const pm = F.pms.get(params.payment_method);
        if (!pm || pm.customer !== params.customer) {
          throw new Stripe.errors.StripeInvalidRequestError({ message: "The payment method does not belong to this customer.", code: "payment_method_not_owned" });
        }
        const pi = { id: nid("pi"), object: "payment_intent", amount: params.amount, currency: params.currency, customer: params.customer, payment_method: params.payment_method, metadata: { ...params.metadata }, created: now(), status: "succeeded", latest_charge: null, receipt_email: params.receipt_email || null };
        F.pis.set(pi.id, pi);
        if (pm.behavior === "decline") {
          pi.status = "requires_payment_method";
          pi.last_payment_error = { code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." };
          throw cardError({ ...pi }, "card_declined", "Your card has insufficient funds.", "insufficient_funds");
        }
        if (pm.behavior === "auth") {
          pi.status = "requires_action";
          throw cardError({ ...pi }, "authentication_required", "This payment requires authentication.");
        }
        if (pm.behavior === "processing") {
          pi.status = "processing";
          return { ...pi };
        }
        const ch = { id: nid("ch"), amount: pi.amount, amount_refunded: 0, receipt_url: `https://pay.stripe.test/receipts/${pi.id}`, payment_intent: pi.id, payment_method_details: { card: { brand: pm.card.brand, last4: pm.card.last4, exp_month: pm.card.exp_month, exp_year: pm.card.exp_year } } };
        F.charges.set(ch.id, ch);
        pi.latest_charge = ch.id;
        return { ...pi };
      });
      if (!reached && F.timeoutOnce.has(params.payment_method)) {
        F.timeoutOnce.delete(params.payment_method);
        throw new Stripe.errors.StripeConnectionError({ message: "Request timed out" });
      }
      return result;
    },
    async retrieve(id) {
      const pi = F.pis.get(id);
      if (!pi) throw new Stripe.errors.StripeInvalidRequestError({ message: "No such payment_intent", code: "resource_missing" });
      return { ...pi, metadata: { ...pi.metadata } };
    },
    async cancel(id) {
      F.calls.push(["paymentIntents.cancel", id]);
      if (F.cancelFails.has(id)) throw new Stripe.errors.StripeConnectionError({ message: "socket hang up" });
      const pi = F.pis.get(id);
      if (pi.status === "succeeded" || pi.status === "canceled") throw new Stripe.errors.StripeInvalidRequestError({ message: `You cannot cancel this PaymentIntent because it has a status of ${pi.status}.`, code: "payment_intent_unexpected_state" });
      pi.status = "canceled";
      return { ...pi };
    },
    /* The customer finishing a bank check on an old intent (what Stripe does when they confirm it). */
    async customerCompletes(id) {
      const pi = F.pis.get(id);
      if (pi.status !== "requires_action") throw new Stripe.errors.StripeInvalidRequestError({ message: `This PaymentIntent's status is ${pi.status}; it cannot be confirmed.`, code: "payment_intent_unexpected_state" });
      pi.status = "succeeded";
      const ch = { id: nid("ch"), amount: pi.amount, amount_refunded: 0, receipt_url: "https://pay.stripe.test/r3ds", payment_intent: pi.id, payment_method_details: { card: { brand: "visa", last4: "3155" } } };
      F.charges.set(ch.id, ch);
      pi.latest_charge = ch.id;
      return { ...pi };
    },
    async search({ query }) {
      const m = query.match(/'([a-f0-9]{24})'/);
      return list([...F.pis.values()].filter((p) => p.metadata.additionalChargeId === m?.[1]));
    },
  },
  charges: {
    async retrieve(id) {
      return F.charges.get(id);
    },
  },
  checkout: {
    sessions: {
      async create(params, options) {
        F.calls.push(["checkout.sessions.create", options?.idempotencyKey]);
        return idemReplay(options?.idempotencyKey, () => {
          const s = { id: nid("cs"), object: "checkout.session", status: "open", payment_status: "unpaid", url: `https://checkout.stripe.test/${F.seq}`, customer: params.customer || null, customer_email: params.customer_email || null, metadata: { ...params.metadata }, payment_intent: null, line_items_param: params.line_items, pid: params.payment_intent_data };
          F.sessions.set(s.id, s);
          return { ...s };
        });
      },
      async retrieve(id) {
        return { ...F.sessions.get(id) };
      },
      async expire(id) {
        F.calls.push(["checkout.sessions.expire", id]);
        if (F.expireFails.has(id)) throw new Stripe.errors.StripeConnectionError({ message: "socket hang up" });
        const s = F.sessions.get(id);
        if (s.status !== "open") throw new Stripe.errors.StripeInvalidRequestError({ message: "Only open sessions can be expired" });
        s.status = "expired";
        return { ...s };
      },
    },
  },
  tax: {
    calculations: {
      async create(params) {
        F.calls.push(["tax.calculations.create", params.customer_details.address.postal_code]);
        const amount = params.line_items[0].amount;
        const taxed = F.taxReason === "standard_rated";
        const tax = taxed ? Math.round((amount * F.taxRate) / 100) : 0;
        return {
          id: nid("taxcalc"),
          amount_total: amount + tax,
          tax_amount_exclusive: tax,
          expires_at: now() + 90 * 86400,
          tax_breakdown: [{ amount: tax, taxability_reason: F.taxReason, tax_rate_details: { percentage_decimal: taxed ? String(F.taxRate) : "0.0" } }],
          line_items: list([{ amount, tax_code: params.line_items[0].tax_code }]),
        };
      },
    },
    transactions: {
      async createFromCalculation(params, options) {
        return idemReplay(options?.idempotencyKey, () => {
          const tx = { id: nid("tax_tx"), reference: params.reference };
          F.taxTx.push(tx);
          return tx;
        });
      },
      async createReversal(params, options) {
        return idemReplay(options?.idempotencyKey, () => {
          const r = { id: nid("tax_rev"), ...params };
          F.reversals.push(r);
          return r;
        });
      },
    },
  },
};
F.charges = new Map();
extras.setStripeClient(fakeStripe);

/** Complete a Checkout page the way Stripe does: a PaymentIntent that succeeded on it. */
function completeSession(id, { cardBrand = "visa", last4 = "4242" } = {}) {
  const s = F.sessions.get(id);
  const metadata = { ...s.pid.metadata };
  const amount = s.line_items_param.reduce((sum, l) => sum + l.price_data.unit_amount, 0);
  const pi = { id: nid("pi"), object: "payment_intent", amount, currency: "usd", customer: s.customer, metadata, created: now(), status: "succeeded", latest_charge: null };
  const ch = { id: nid("ch"), amount, amount_refunded: 0, receipt_url: `https://pay.stripe.test/receipts/${pi.id}`, payment_intent: pi.id, payment_method_details: { card: { brand: cardBrand, last4, exp_month: 12, exp_year: 2030 } } };
  F.charges.set(ch.id, ch);
  pi.latest_charge = ch.id;
  F.pis.set(pi.id, pi);
  s.status = "complete";
  s.payment_status = "paid";
  s.payment_intent = pi.id;
  return { session: { ...s }, pi };
}

/* --------------------------------- app ----------------------------------- */
const app = express();
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), webhook);
app.use(express.json());
app.use("/api/admin", require("../routes/adminJobs"));
app.use("/api/admin", require("../routes/adminExtraCharges"));
app.use("/api/admin", require("../routes/adminCustomerDirectory"));
app.use("/api/pay", require("../routes/pay"));

let base;
const tokenFor = (u) => jwt.sign({ id: String(u._id), tv: Number(u.tokenVersion || 0) }, process.env.JWT_SECRET, { expiresIn: "10m" });
async function call(method, path, user, body) {
  if (body && body.previewFingerprint !== undefined) {
    body = { ...body, targetFingerprint: body.previewFingerprint };
    delete body.previewFingerprint;
  }
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(user ? { authorization: `Bearer ${tokenFor(user)}` } : {}) },
    body: body && method !== "GET" ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
let eventSeq = 0;
async function sendEvent(type, object, id = `evt_${++eventSeq}`) {
  const payload = JSON.stringify({ id, object: "event", type, data: { object }, created: now(), livemode: false, api_version: "2024-06-20" });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const r = await fetch(`${base}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
  return r.status;
}

/* -------------------------------- fixtures -------------------------------- */
let userSeq = 0;
async function makeUser(fields = {}) {
  userSeq += 1;
  return User.create({
    userId: String(80000000 + userSeq),
    name: fields.name || `Customer ${userSeq}`,
    email: fields.email || `c${userSeq}@example.test`,
    phone: fields.phone || `+1631555${String(1000 + userSeq)}`,
    role: "customer",
    addresses: [{ line1: fields.line1 || `${userSeq} Main St`, city: "Huntington", state: "NY", zip: "11743" }],
    ...fields,
  });
}
function addCustomer(id, { pm, brand = "visa", last4 = "4242", behavior = "ok", defaultPm = true, metadata = {}, exp = [12, 2030] } = {}) {
  F.customers.set(id, { id, object: "customer", deleted: false, metadata, invoice_settings: { default_payment_method: defaultPm && pm ? pm : null }, subs: [] });
  if (pm) F.pms.set(pm, { id: pm, object: "payment_method", type: "card", customer: id, behavior, card: { brand, last4, exp_month: exp[0], exp_year: exp[1] } });
}
let bookingSeq = 9000;
async function makeBooking(user, fields = {}) {
  bookingSeq += 1;
  const addr = user?.addresses?.[0];
  return Booking.create({
    bookingNumber: String(bookingSeq),
    date: new Date(Date.now() + 86400000),
    service: "Handyman visit",
    user: user ? user._id : null,
    userId: user ? String(user.userId) : "",
    addressId: addr?._id || null,
    name: user?.name || fields.name || "Guest Person",
    address: addr?.line1 || fields.address || "",
    city: addr?.city || fields.city || "",
    state: addr?.state || fields.state || "",
    zip: addr?.zip || fields.zip || "",
    phone: user?.phone || fields.phone || "+16315550000",
    email: user?.email || fields.email || "guest@example.test",
    subscription: "basic",
    status: "Confirmed",
    ...fields,
  });
}
let keySeq = 0;
const key = () => `test-key-${Date.now()}-${++keySeq}`;
/** What the sheet shows before "Charge $X": the target, plus the entered total (what is charged, nothing added). */
async function previewFor(owner, booking, input = {}) {
  const r = await call("GET", `/api/admin/jobs/${booking._id}/extra-charges/target`, owner);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const cents = input.amount !== undefined ? extras.readAmountCents({ amount: input.amount }) : null;
  return { ...r.body.target, totalCents: cents };
}
async function charge(owner, booking, input, extra = {}) {
  const p = await previewFor(owner, booking, input);
  const body = { amount: input.amount, note: input.description || "", idempotencyKey: key(), targetFingerprint: p.fingerprint, method: "card", allowRepeat: true, ...extra };
  const r = await call("POST", `/api/admin/jobs/${booking._id}/extra-charges`, owner, body);
  return { preview: p, res: r, body };
}
const piCreates = () => F.calls.filter((c) => c[0] === "paymentIntents.create").length;
/* The customer-profile entry point: no booking anywhere. */
const custBase = (u) => `/api/admin/customers/${u._id || u}/charges`;
async function customerTarget(who, u) {
  return call("GET", `${custBase(u)}/target`, who);
}
async function chargeDirect(who, u, amount, extra = {}) {
  const t = await customerTarget(who, u);
  assert.strictEqual(t.status, 200, JSON.stringify(t.body));
  const body = { amount, note: "", idempotencyKey: key(), targetFingerprint: t.body.target.fingerprint, method: "card", ...extra };
  const res = await call("POST", custBase(u), who, body);
  return { target: t.body.target, res, body };
}
// Old test inputs carried a tax treatment; the server now ignores any such field (nothing is added on top).
const TAXABLE = "Taxable Repair / Maintenance";
const CAPITAL = "Capital Improvement - No Sales Tax";

(async () => {
  const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri());
  await AdditionalCharge.init();
  await AdminPaymentLink.init();
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  const owner = await User.create({ userId: "70000001", name: "Owner Person", email: "owner@example.test", role: "admin" });
  const general = await User.create({ userId: "70000002", name: "General Fixter", email: "gf@example.test", role: "employee", employeePosition: "General Fixter" });
  const manager = await User.create({ userId: "70000003", name: "Manager", email: "mgr@example.test", role: "employee", employeeTitle: "Manager", adminSections: ["overview", "members", "customers", "leads", "projects", "jobs", "schedule", "communications", "activity"] });
  const field = await User.create({ userId: "70000004", name: "Field Fixter", email: "ff@example.test", role: "employee", employeePosition: "Fixter" });

  // Two customers with the SAME email and the SAME address, each with their own Stripe customer and card.
  const alice = await makeUser({ name: "Alice Able", email: "shared@example.test", line1: "10 Shared Ln", stripeCustomerId: "cus_alice" });
  // The app keeps one customer account per email, but Stripe does not: both Stripe customers carry the same email.
  const bob = await makeUser({ name: "Bob Baker", email: "bob@example.test", line1: "10 Shared Ln", stripeCustomerId: "cus_bob" });
  addCustomer("cus_alice", { pm: "pm_alice", last4: "1111" });
  addCustomer("cus_bob", { pm: "pm_bob", last4: "2222", brand: "mastercard" });
  F.customers.get("cus_alice").email = "shared@example.test";
  F.customers.get("cus_bob").email = "shared@example.test";
  const aliceJob = await makeBooking(alice);
  const bobJob = await makeBooking(bob);

  try {
    /* ------------------------------ access ------------------------------ */
    await check("only the Owner and a General Fixter may preview, charge, list or act; a field Fixter, a manager and a customer are refused by the server", async () => {
      const input = { description: "Hang extra shelf", amount: "40", taxTreatment: CAPITAL };
      for (const who of [manager, field, alice]) {
        for (const [m, p] of [["GET", `/api/admin/jobs/${aliceJob._id}/extra-charges`], ["GET", `/api/admin/jobs/${aliceJob._id}/extra-charges/target`], ["POST", `/api/admin/jobs/${aliceJob._id}/extra-charges`]]) {
          const r = await call(m, p, who, { ...input, idempotencyKey: key(), customerAgreed: true, method: "card" });
          assert.strictEqual(r.status, 403, `${who.name} ${m} ${p} -> ${r.status}`);
        }
      }
      assert.strictEqual((await call("GET", `/api/admin/jobs/${aliceJob._id}/extra-charges`)).status, 401);
      assert.strictEqual(await AdditionalCharge.countDocuments(), 0);
      assert.strictEqual(piCreates(), 0);
    });

    await check("the job sheet offers Charge customer to the Owner and a General Fixter (not a field Fixter, even on their own job), on confirmed or completed visits", async () => {
      const mine = await call("GET", `/api/admin/jobs/${aliceJob._id}`, owner);
      assert.ok(mine.body.job.allowedActions.includes("chargeExtra"));
      assert.deepStrictEqual(mine.body.job.extraCharges, { count: 0, paidCents: 0, open: 0 });
      const gf = await call("GET", `/api/admin/jobs/${aliceJob._id}`, general);
      assert.ok(gf.body.job.allowedActions.includes("chargeExtra"));
      assert.deepStrictEqual(gf.body.job.extraCharges, { count: 0, paidCents: 0, open: 0 });
      const assigned = await makeBooking(alice, { assignedFixterId: field._id, status: "Completed" });
      const ff = await call("GET", `/api/admin/jobs/${assigned._id}`, field);
      assert.strictEqual(ff.status, 200, "the field Fixter still sees their own job");
      assert.ok(!ff.body.job.allowedActions.includes("chargeExtra"));
      assert.strictEqual(ff.body.job.extraCharges, undefined);
      const pending = await makeBooking(alice, { status: "Pending" });
      const p = await call("GET", `/api/admin/jobs/${pending._id}`, owner);
      assert.ok(!p.body.job.allowedActions.includes("chargeExtra"));
      const pr = await previewFor(owner, pending);
      assert.strictEqual(pr.direct.allowed, false);
      assert.strictEqual(pr.direct.code, "BOOKING_NOT_CHARGEABLE");
    });

    /* ------------------------- preview and tax ---------------------------- */
    await check("target: the booking's own customer, address and card; no Stripe ids reach the browser", async () => {
      const p = await previewFor(owner, aliceJob);
      assert.strictEqual(p.customer.name, "Alice Able");
      assert.strictEqual(p.serviceAddress.full, "10 Shared Ln, Huntington, NY 11743");
      assert.deepStrictEqual({ brand: p.card.brand, last4: p.card.last4 }, { brand: "visa", last4: "1111" });
      assert.ok(p.direct.allowed && p.link.allowed);
      assert.ok(p.fingerprint && p.fingerprint.length === 32);
      assert.ok(!JSON.stringify(p).includes("pm_alice") && !JSON.stringify(p).includes("cus_alice"), "no Stripe ids reach the browser");
    });

    await check("amount: the entered total is charged as is (integer cents), with no tax added and no exemption claimed", async () => {
      const calcs = F.calls.filter((c) => c[0].startsWith("tax.")).length;
      const job = await makeBooking(alice);
      const p = await previewFor(owner, job);
      const r = await call("POST", `/api/admin/jobs/${job._id}/extra-charges`, owner, { amount: "123.45", note: "", idempotencyKey: key(), targetFingerprint: p.fingerprint, method: "card", taxTreatment: "Tax Exempt" });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      assert.strictEqual(r.body.charge.totalCents, 12345);
      assert.strictEqual(r.body.charge.taxStatus, "not_calculated");
      const rec = await AdditionalCharge.findById(r.body.charge.id).lean();
      assert.strictEqual(F.pis.get(rec.paymentIntentId).amount, 12345, "exactly the entered amount, nothing on top");
      assert.strictEqual(F.pis.get(rec.paymentIntentId).metadata.taxStatus, "not_calculated");
      assert.strictEqual(rec.tax.status, "not_calculated", "not marked exempt: tax is accounted separately");
      assert.strictEqual(F.calls.filter((c) => c[0].startsWith("tax.")).length, calcs, "no Stripe Tax calls in this flow");
      for (const [amount, code] of [["12.345", "INVALID_AMOUNT"], ["0.10", "AMOUNT_TOO_SMALL"], ["5000.01", "AMOUNT_TOO_LARGE"], ["", "INVALID_AMOUNT"]]) {
        const bad = await call("POST", `/api/admin/jobs/${job._id}/extra-charges`, owner, { amount, idempotencyKey: key(), targetFingerprint: p.fingerprint, method: "card" });
        assert.strictEqual(bad.body.code, code, amount);
      }
      assert.strictEqual(extras.readAmountCents({ amount: "0.29" }), 29);
      assert.strictEqual(extras.readAmountCents({ amount: "1,234.5" }), 123450);
      assert.strictEqual(extras.readAmountCents({ amount: "$40" }), 4000);
    });

    /* ---------------------------- the charge ------------------------------ */
    let aliceCharge;
    await check("success: charges Alice's own Stripe customer and card, records consent, Stripe receipt only, booking untouched", async () => {
      const before = (await Booking.findById(aliceJob._id).lean());
      const entBefore = await VisitEntitlement.countDocuments();
      const emailsBefore = sentEmails.length;
      const { preview: p, res } = await charge(owner, aliceJob, { description: "Replace two outlets", amount: "123.45" });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const c = res.body.charge;
      aliceCharge = c;
      assert.strictEqual(c.status, "paid");
      assert.strictEqual(c.totalCents, p.totalCents);
      assert.deepStrictEqual(c.card, { brand: "visa", last4: "1111" });
      assert.ok(c.receiptUrl.startsWith("https://pay.stripe.test/receipts/"));
      assert.ok(c.stripeUrl.includes("/test/payments/pi_"));
      const rec = await AdditionalCharge.findById(c.id).lean();
      assert.strictEqual(String(rec.user), String(alice._id));
      assert.strictEqual(rec.stripeCustomerId, "cus_alice");
      assert.strictEqual(rec.paymentMethodId, "pm_alice");
      assert.strictEqual(rec.consent.confirmedByName, "Owner Person");
      assert.strictEqual(rec.consent.totalCents, 12345);
      assert.strictEqual(rec.consent.statement, 'The owner pressed "Charge $123.45".');
      assert.ok(rec.consent.confirmedAt);
      assert.strictEqual(rec.description, "Replace two outlets", "the optional note is kept");
      const pi = F.pis.get(rec.paymentIntentId);
      assert.strictEqual(pi.customer, "cus_alice");
      assert.strictEqual(pi.payment_method, "pm_alice");
      assert.strictEqual(pi.amount, p.totalCents);
      assert.strictEqual(pi.receipt_email, "shared@example.test");
      assert.deepStrictEqual(
        { k: pi.metadata.productKind, a: pi.metadata.additionalChargeId, b: pi.metadata.bookingId, u: pi.metadata.userMongoId, t: pi.metadata.amountCents },
        { k: "additional_charge", a: c.id, b: String(aliceJob._id), u: String(alice._id), t: "12345" }
      );
      assert.strictEqual(sentEmails.length, emailsBefore, "no email of ours: the receipt is Stripe's");
      const after = await Booking.findById(aliceJob._id).lean();
      for (const k of ["status", "paymentState", "accessType", "bookingType", "entitlementId", "subscription"]) assert.deepStrictEqual(after[k], before[k], k);
      assert.strictEqual(String(after.updatedAt), String(before.updatedAt), "the booking document is not written");
      assert.strictEqual(await VisitEntitlement.countDocuments(), entBefore);
      assert.ok(await AdminActivityLog.findOne({ action: "Extra Charged (Saved Card)", entityId: String(aliceJob._id) }));
    });

    await check("the same booking can carry several separately numbered extras", async () => {
      const { res } = await charge(owner, aliceJob, { description: "Patch drywall hole", amount: "60", taxTreatment: TAXABLE });
      assert.strictEqual(res.body.charge.status, "paid");
      assert.notStrictEqual(res.body.charge.number, aliceCharge.number);
      assert.ok(/-E2$/.test(res.body.charge.number), res.body.charge.number);
      const listed = await call("GET", `/api/admin/jobs/${aliceJob._id}/extra-charges`, owner);
      assert.strictEqual(listed.body.charges.length, 2);
      const job = await call("GET", `/api/admin/jobs/${aliceJob._id}`, owner);
      assert.strictEqual(job.body.job.extraCharges.count, 2);
    });

    await check("double submission: two presses with one key make one record and one PaymentIntent", async () => {
      const job = await makeBooking(alice);
      const input = { description: "Seal the tub", amount: "45", taxTreatment: CAPITAL };
      const p = await previewFor(owner, job, input);
      const body = { ...input, idempotencyKey: key(), customerAgreed: true, previewFingerprint: p.fingerprint, expectedTotalCents: p.totalCents, method: "card" };
      const creates = piCreates();
      const [a, b] = await Promise.all([call("POST", `/api/admin/jobs/${job._id}/extra-charges`, owner, body), call("POST", `/api/admin/jobs/${job._id}/extra-charges`, owner, body)]);
      const c = await call("POST", `/api/admin/jobs/${job._id}/extra-charges`, owner, body);
      assert.strictEqual(await AdditionalCharge.countDocuments({ booking: job._id }), 1);
      assert.strictEqual(piCreates() - creates, 1, "one PaymentIntent request");
      for (const r of [a, b, c].filter((r) => r.status < 300)) assert.strictEqual(r.body.charge.id, c.body.charge.id);
      assert.strictEqual(c.body.replayed, true);
      assert.strictEqual(c.body.charge.status, "paid");
    });

    await check("stale details and repeats: a changed card or account since the screen opened is refused; the same amount again soon asks first", async () => {
      const job = await makeBooking(alice);
      const p = await previewFor(owner, job);
      const stale = await call("POST", `/api/admin/jobs/${job._id}/extra-charges`, owner, { amount: "80", idempotencyKey: key(), targetFingerprint: "0".repeat(32), method: "card" });
      assert.strictEqual(stale.status, 409);
      assert.strictEqual(stale.body.code, "TARGET_CHANGED");
      assert.ok(stale.body.target && stale.body.target.card.last4 === "1111", "the new details come back to show");
      const missing = await call("POST", `/api/admin/jobs/${job._id}/extra-charges`, owner, { amount: "80", idempotencyKey: key(), method: "card" });
      assert.strictEqual(missing.body.code, "TARGET_CHANGED");
      assert.strictEqual(await AdditionalCharge.countDocuments({ booking: job._id }), 0);
      const first = await call("POST", `/api/admin/jobs/${job._id}/extra-charges`, owner, { amount: "80", idempotencyKey: key(), targetFingerprint: p.fingerprint, method: "card" });
      assert.strictEqual(first.body.charge.status, "paid");
      const creates = piCreates();
      const again = await call("POST", `/api/admin/jobs/${job._id}/extra-charges`, owner, { amount: "80", idempotencyKey: key(), targetFingerprint: p.fingerprint, method: "card" });
      assert.strictEqual(again.status, 409);
      assert.strictEqual(again.body.code, "POSSIBLE_DUPLICATE");
      assert.ok(/already charged/.test(again.body.message));
      assert.strictEqual(piCreates(), creates, "no second charge without the owner saying so");
      const different = await call("POST", `/api/admin/jobs/${job._id}/extra-charges`, owner, { amount: "35", idempotencyKey: key(), targetFingerprint: p.fingerprint, method: "card" });
      assert.strictEqual(different.status, 201, "a different amount is a different charge");
      const meant = await call("POST", `/api/admin/jobs/${job._id}/extra-charges`, owner, { amount: "80", idempotencyKey: key(), targetFingerprint: p.fingerprint, method: "card", allowRepeat: true });
      assert.strictEqual(meant.status, 201, "a deliberate second charge, confirmed");
      assert.strictEqual(await AdditionalCharge.countDocuments({ booking: job._id, status: "paid" }), 3);
    });

    /* ---------------------------- linkage --------------------------------- */
    await check("wrong-account defence: browser ids, switched profiles, shared email and address change nothing", async () => {
      const job = await makeBooking(alice);
      const input = { description: "Fix gate latch", amount: "30", taxTreatment: CAPITAL };
      const p = await previewFor(owner, job, input);
      const r = await call("POST", `/api/admin/jobs/${job._id}/extra-charges`, owner, {
        ...input,
        idempotencyKey: key(),
        customerAgreed: true,
        previewFingerprint: p.fingerprint,
        expectedTotalCents: p.totalCents,
        method: "card",
        // Everything a tampered or confused browser might send:
        userId: String(bob._id),
        customerId: String(bob._id),
        stripeCustomerId: "cus_bob",
        paymentMethodId: "pm_bob",
        payment_method: "pm_bob",
        email: "bob@example.test",
        openProfileId: String(bob._id),
      });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      const rec = await AdditionalCharge.findById(r.body.charge.id).lean();
      assert.strictEqual(String(rec.user), String(alice._id));
      const pi = F.pis.get(rec.paymentIntentId);
      assert.strictEqual(pi.customer, "cus_alice");
      assert.strictEqual(pi.payment_method, "pm_alice");
      assert.ok(![...F.pis.values()].some((x) => x.customer === "cus_bob"), "Bob was never charged");
      // A charge id from one booking cannot be driven through another booking's URL.
      const cross = await call("POST", `/api/admin/jobs/${bobJob._id}/extra-charges/${rec._id}/refresh`, owner, {});
      assert.strictEqual(cross.status, 404);
      const crossRetry = await call("POST", `/api/admin/jobs/${bobJob._id}/extra-charges/${rec._id}/retry-card`, owner, { idempotencyKey: key(), expectedCardLast4: "2222" });
      assert.strictEqual(crossRetry.status, 404);
    });

    await check("another customer's card set as default: blocked before Stripe is asked to charge", async () => {
      const carol = await makeUser({ name: "Carol Card", stripeCustomerId: "cus_carol" });
      addCustomer("cus_carol", { pm: null });
      F.customers.get("cus_carol").invoice_settings.default_payment_method = "pm_bob"; // Bob's card, attached to cus_bob
      const job = await makeBooking(carol);
      const p = await previewFor(owner, job, { description: "Extra", amount: "20", taxTreatment: CAPITAL });
      assert.strictEqual(p.direct.allowed, false);
      assert.strictEqual(p.direct.code, "PM_NOT_OWNED");
      assert.strictEqual(p.card, null);
      const creates = piCreates();
      const r = await call("POST", `/api/admin/jobs/${job._id}/extra-charges`, owner, { description: "Extra", amount: "20", taxTreatment: CAPITAL, idempotencyKey: key(), customerAgreed: true, previewFingerprint: p.fingerprint, expectedTotalCents: p.totalCents, method: "card" });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.body.code, "PM_NOT_OWNED");
      assert.strictEqual(piCreates(), creates);
      assert.strictEqual(p.link.allowed, true, "the customer can still pay through a link");
    });

    await check("ambiguous or missing mappings block direct charging: shared Stripe customer, two Stripe customers, mismatch label, no customer, no card, several cards, expired card", async () => {
      const dave = await makeUser({ stripeCustomerId: "cus_shared" });
      await makeUser({ stripeCustomerId: "cus_shared" });
      addCustomer("cus_shared", { pm: "pm_shared" });
      const erin = await makeUser({ stripeCustomerId: "cus_erin" });
      addCustomer("cus_erin", { pm: "pm_erin" });
      // An older membership of Erin's on a second Stripe customer (raw insert: only the mapping matters here).
      await Subscription.collection.insertOne({ user: erin._id, userId: String(erin.userId), addressId: erin.addresses[0]._id, subscriptionType: "basic", status: "active", stripeCustomerId: "cus_erin_old" });
      const fay = await makeUser({ stripeCustomerId: "cus_fay" });
      addCustomer("cus_fay", { pm: "pm_fay", metadata: { userMongoId: String(bob._id) } });
      // No Stripe customer of their own, but their email is on Bob's Stripe customer: still no card to charge.
      const gus = await makeUser({ email: "gus@example.test" });
      F.customers.get("cus_bob").email = "gus@example.test";
      const hal = await makeUser({ stripeCustomerId: "cus_hal" });
      addCustomer("cus_hal", { pm: null });
      const ivy = await makeUser({ stripeCustomerId: "cus_ivy" });
      addCustomer("cus_ivy", { pm: "pm_ivy1", defaultPm: false });
      F.pms.set("pm_ivy2", { id: "pm_ivy2", type: "card", customer: "cus_ivy", card: { brand: "visa", last4: "9999", exp_month: 1, exp_year: 2031 } });
      const jay = await makeUser({ stripeCustomerId: "cus_jay" });
      addCustomer("cus_jay", { pm: "pm_jay", exp: [1, 2020] });
      const expect = [[dave, "STRIPE_CUSTOMER_SHARED"], [erin, "MULTIPLE_STRIPE_CUSTOMERS"], [fay, "STRIPE_CUSTOMER_MISMATCH"], [gus, "NO_STRIPE_CUSTOMER"], [hal, "NO_SAVED_CARD"], [ivy, "NO_DEFAULT_CARD"], [jay, "CARD_EXPIRED"]];
      for (const [u, code] of expect) {
        const job = await makeBooking(u);
        const p = await previewFor(owner, job, { description: "Extra", amount: "20", taxTreatment: CAPITAL });
        assert.strictEqual(p.direct.allowed, false, code);
        assert.strictEqual(p.direct.code, code);
        assert.strictEqual(p.link.allowed, true, `${code}: link still offered`);
      }
      F.customers.get("cus_bob").email = "shared@example.test";
      assert.strictEqual(F.calls.filter((c) => c[0] === "customers.list" || c[0] === "customers.search").length, 0, "Stripe customers are never looked up by email");
    });

    await check("guest visit and conflicting ownership: no direct charge, a booking-specific link only", async () => {
      const guest = await makeBooking(null, { adminGuest: true, name: "Guest Gina", address: "5 Elm St", city: "Babylon", state: "NY", zip: "11702", email: "gina@example.test" });
      const p = await previewFor(owner, guest, { description: "Extra", amount: "20", taxTreatment: CAPITAL });
      assert.strictEqual(p.direct.code, "GUEST_BOOKING");
      assert.strictEqual(p.customer.guest, true);
      assert.strictEqual(p.link.allowed, true);
      const conflict = await makeBooking(alice, { userId: String(bob.userId) });
      const c = await previewFor(owner, conflict, { description: "Extra", amount: "20", taxTreatment: CAPITAL });
      assert.strictEqual(c.direct.code, "OWNERSHIP_CONFLICT");
    });

    await check("ownership re-checked before retrying: a visit moved to another account is never charged on the old card", async () => {
      const job = await makeBooking(alice);
      addCustomer("cus_alice", { pm: "pm_alice", last4: "1111" });
      F.pms.get("pm_alice").behavior = "decline";
      const { res } = await charge(owner, job, { description: "Extra trim", amount: "25", taxTreatment: CAPITAL });
      assert.strictEqual(res.body.charge.status, "failed");
      F.pms.get("pm_alice").behavior = "ok";
      await Booking.updateOne({ _id: job._id }, { $set: { user: bob._id, userId: String(bob.userId) } });
      const creates = piCreates();
      const r = await call("POST", `/api/admin/jobs/${job._id}/extra-charges/${res.body.charge.id}/retry-card`, owner, { idempotencyKey: key(), expectedCardLast4: "2222" });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.body.code, "OWNERSHIP_CHANGED");
      assert.strictEqual(piCreates(), creates);
    });

    /* --------------------------- failures --------------------------------- */
    await check("decline: shown as Failed with the reason, the intent is canceled, no automatic retry", async () => {
      const kim = await makeUser({ stripeCustomerId: "cus_kim" });
      addCustomer("cus_kim", { pm: "pm_kim", behavior: "decline", last4: "0002" });
      const job = await makeBooking(kim);
      const creates = piCreates();
      const { res } = await charge(owner, job, { description: "Extra", amount: "75", taxTreatment: CAPITAL });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.charge.status, "failed");
      assert.strictEqual(res.body.charge.failure.code, "card_declined");
      assert.ok(/insufficient funds/i.test(res.body.charge.failure.message));
      assert.ok(res.body.charge.actions.includes("paymentLink"));
      assert.strictEqual(piCreates() - creates, 1);
      const rec = await AdditionalCharge.findById(res.body.charge.id).lean();
      assert.strictEqual(F.pis.get(rec.attempts[0].paymentIntentId).status, "canceled");
      await call("GET", `/api/admin/jobs/${job._id}/extra-charges`, owner);
      assert.strictEqual(piCreates() - creates, 1, "reopening does not retry");
    });

    let authCharge;
    let authJob;
    await check("authentication required: Failed, intent canceled, payment link offered", async () => {
      const lee = await makeUser({ stripeCustomerId: "cus_lee" });
      addCustomer("cus_lee", { pm: "pm_lee", behavior: "auth", last4: "3155" });
      authJob = await makeBooking(lee);
      const { res } = await charge(owner, authJob, { description: "Extra", amount: "90", taxTreatment: TAXABLE });
      authCharge = res.body.charge;
      assert.strictEqual(authCharge.status, "failed");
      assert.strictEqual(authCharge.failure.code, "authentication_required");
      assert.ok(/approve/i.test(authCharge.failure.message));
      const rec = await AdditionalCharge.findById(authCharge.id).lean();
      assert.strictEqual(F.pis.get(rec.attempts[0].paymentIntentId).status, "canceled");
    });

    await check("payment link for the same record: copied link opens one Stripe page on the same customer; paid once; link closes", async () => {
      const r = await call("POST", `/api/admin/jobs/${authJob._id}/extra-charges/${authCharge.id}/payment-link`, owner, { idempotencyKey: key(), send: false });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.charge.status, "awaiting_payment");
      assert.ok(r.body.payUrl.startsWith("https://www.profixter.com/pay/"));
      const token = r.body.payUrl.split("/pay/")[1];
      const link = await AdminPaymentLink.findOne({ tokenHash: hashToken(token) }).lean();
      assert.strictEqual(String(link.additionalCharge), authCharge.id);
      assert.deepStrictEqual(link.sentVia, [], "copy sends nothing");
      const view = await call("GET", `/api/pay/${token}`);
      assert.strictEqual(view.body.status, "open");
      assert.strictEqual(view.body.amountCents, authCharge.totalCents);
      const open1 = await call("POST", `/api/pay/${token}/checkout`);
      const open2 = await call("POST", `/api/pay/${token}/checkout`);
      assert.strictEqual(open1.status, 200, JSON.stringify(open1.body));
      assert.strictEqual(open1.body.url, open2.body.url, "the same page, not a second payable one");
      const sessionId = [...F.sessions.values()].find((s) => s.metadata.additionalChargeId === authCharge.id).id;
      const s = F.sessions.get(sessionId);
      assert.strictEqual(s.customer, "cus_lee");
      assert.strictEqual(s.line_items_param.reduce((a, l) => a + l.price_data.unit_amount, 0), authCharge.totalCents);
      assert.strictEqual(s.line_items_param.length, 1, "one line: exactly the entered total, nothing added");
      const { session, pi } = completeSession(sessionId);
      assert.strictEqual(await sendEvent("checkout.session.completed", session, "evt_link_1"), 200);
      assert.strictEqual(await sendEvent("checkout.session.completed", session, "evt_link_1"), 200);
      assert.strictEqual(await sendEvent("payment_intent.succeeded", F.pis.get(pi.id), "evt_link_2"), 200);
      const rec = await AdditionalCharge.findById(authCharge.id).lean();
      assert.strictEqual(rec.status, "paid");
      assert.strictEqual(rec.paymentIntentId, pi.id);
      assert.strictEqual(rec.extraPayments.length, 0);
      assert.strictEqual((await AdminPaymentLink.findById(link._id).lean()).status, "paid");
      const again = await call("POST", `/api/pay/${token}/checkout`);
      assert.strictEqual(again.status, 410);
      assert.strictEqual(again.body.status, "paid");
      const notAgain = await call("POST", `/api/admin/jobs/${authJob._id}/extra-charges/${authCharge.id}/payment-link`, owner, { idempotencyKey: key() });
      assert.strictEqual(notAgain.status, 409);
    });

    await check("guest visit: the link's Stripe page has no customer attached; a sent link goes to the booking contact", async () => {
      const guest = await makeBooking(null, { adminGuest: true, name: "Guest Gail", address: "7 Oak St", city: "Islip", state: "NY", zip: "11751", email: "gail@example.test", phone: "+16315557777" });
      const input = { description: "Extra shelf", amount: "35", taxTreatment: CAPITAL };
      const p = await previewFor(owner, guest, input);
      const emails = sentEmails.length;
      const r = await call("POST", `/api/admin/jobs/${guest._id}/extra-charges`, owner, { ...input, idempotencyKey: key(), customerAgreed: true, previewFingerprint: p.fingerprint, expectedTotalCents: p.totalCents, method: "link", send: true, channels: ["email"] });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      assert.strictEqual(r.body.charge.status, "awaiting_payment");
      assert.strictEqual(sentEmails.length, emails + 1);
      assert.strictEqual(sentEmails.at(-1).to, "gail@example.test");
      assert.strictEqual(sentEmails.at(-1).templateKey, "payment_link");
      const token = r.body.payUrl.split("/pay/")[1];
      await call("POST", `/api/pay/${token}/checkout`);
      const s = [...F.sessions.values()].find((x) => x.metadata.additionalChargeId === r.body.charge.id);
      assert.strictEqual(s.customer, null);
      assert.strictEqual(s.customer_email, "gail@example.test");
      const card = await call("POST", `/api/admin/jobs/${guest._id}/extra-charges`, owner, { ...input, idempotencyKey: key(), customerAgreed: true, previewFingerprint: p.fingerprint, expectedTotalCents: p.totalCents, method: "card" });
      assert.strictEqual(card.status, 409);
      assert.strictEqual(card.body.code, "GUEST_BOOKING");
    });

    await check("a new link replaces the old: the old link stops working and its Stripe page is expired", async () => {
      const mo = await makeUser({ stripeCustomerId: "cus_mo" });
      addCustomer("cus_mo", { pm: "pm_mo", behavior: "decline" });
      const job = await makeBooking(mo);
      const { res } = await charge(owner, job, { description: "Extra", amount: "50", taxTreatment: CAPITAL });
      const first = await call("POST", `/api/admin/jobs/${job._id}/extra-charges/${res.body.charge.id}/payment-link`, owner, { idempotencyKey: key() });
      const t1 = first.body.payUrl.split("/pay/")[1];
      await call("POST", `/api/pay/${t1}/checkout`);
      const s1 = [...F.sessions.values()].find((x) => x.metadata.additionalChargeId === res.body.charge.id);
      const second = await call("POST", `/api/admin/jobs/${job._id}/extra-charges/${res.body.charge.id}/payment-link`, owner, { idempotencyKey: key() });
      assert.strictEqual(F.sessions.get(s1.id).status, "expired");
      const old = await call("POST", `/api/pay/${t1}/checkout`);
      assert.strictEqual(old.status, 410);
      const t2 = second.body.payUrl.split("/pay/")[1];
      assert.strictEqual((await call("POST", `/api/pay/${t2}/checkout`)).status, 200);
    });

    await check("link open, then the owner charges the fixed card: the page is closed first; a late page payment is flagged, not a second 'paid'", async () => {
      const ned = await makeUser({ stripeCustomerId: "cus_ned" });
      addCustomer("cus_ned", { pm: "pm_ned", behavior: "decline", last4: "4444" });
      const job = await makeBooking(ned);
      const { res } = await charge(owner, job, { description: "Extra", amount: "55", taxTreatment: CAPITAL });
      const l = await call("POST", `/api/admin/jobs/${job._id}/extra-charges/${res.body.charge.id}/payment-link`, owner, { idempotencyKey: key() });
      const token = l.body.payUrl.split("/pay/")[1];
      await call("POST", `/api/pay/${token}/checkout`);
      const s = [...F.sessions.values()].find((x) => x.metadata.additionalChargeId === res.body.charge.id);
      F.pms.get("pm_ned").behavior = "ok";
      const retry = await call("POST", `/api/admin/jobs/${job._id}/extra-charges/${res.body.charge.id}/retry-card`, owner, { idempotencyKey: key(), expectedCardLast4: "4444" });
      assert.strictEqual(retry.status, 200, JSON.stringify(retry.body));
      assert.strictEqual(retry.body.charge.status, "paid");
      assert.strictEqual(F.sessions.get(s.id).status, "expired", "the page was expired before the card was charged");
      assert.strictEqual((await call("POST", `/api/pay/${token}/checkout`)).status, 410);
      // Stripe races anyway (the page was paid a moment before it expired): never a silent double.
      F.sessions.get(s.id).status = "open";
      const { session } = completeSession(s.id);
      await sendEvent("checkout.session.completed", session);
      const rec = await AdditionalCharge.findById(res.body.charge.id).lean();
      assert.strictEqual(rec.status, "paid");
      assert.strictEqual(rec.extraPayments.length, 1, "the second payment is recorded for a refund in Stripe");
      const listed = await call("GET", `/api/admin/jobs/${job._id}/extra-charges`, owner);
      assert.strictEqual(listed.body.charges[0].extraPayments.length, 1);
    });

    await check("timeout after Stripe received the request: shown as Processing, then resolved to the ORIGINAL intent on reopen", async () => {
      const ola = await makeUser({ stripeCustomerId: "cus_ola" });
      addCustomer("cus_ola", { pm: "pm_ola", last4: "5555" });
      F.timeoutOnce.add("pm_ola");
      const job = await makeBooking(ola);
      const { res } = await charge(owner, job, { description: "Extra", amount: "65", taxTreatment: CAPITAL });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.charge.status, "processing", "never shown as paid or failed when unknown");
      assert.strictEqual([...F.pis.values()].filter((p) => p.customer === "cus_ola").length, 1);
      const rec0 = await AdditionalCharge.findById(res.body.charge.id).lean();
      await AdditionalCharge.updateOne({ _id: rec0._id }, { $set: { lastStripeSyncAt: null } });
      const listed = await call("GET", `/api/admin/jobs/${job._id}/extra-charges`, owner);
      assert.strictEqual(listed.body.charges[0].status, "paid");
      const keys = F.calls.filter((c) => c[0] === "paymentIntents.create" && c[1] === "pm_ola").map((c) => c[2]);
      assert.strictEqual(new Set(keys).size, 1, "the retry used the same Stripe idempotency key");
      assert.strictEqual([...F.pis.values()].filter((p) => p.customer === "cus_ola").length, 1, "still exactly one PaymentIntent");
    });

    await check("timeout before Stripe received the request: Processing, then the same key creates the one and only intent", async () => {
      const rae = await makeUser({ stripeCustomerId: "cus_rae" });
      addCustomer("cus_rae", { pm: "pm_rae" });
      F.lostOnce.add("pm_rae");
      const job = await makeBooking(rae);
      const { res } = await charge(owner, job, { description: "Extra", amount: "33", taxTreatment: CAPITAL });
      assert.strictEqual(res.body.charge.status, "processing");
      assert.strictEqual([...F.pis.values()].filter((p) => p.customer === "cus_rae").length, 0);
      const r = await call("POST", `/api/admin/jobs/${job._id}/extra-charges/${res.body.charge.id}/refresh`, owner, {});
      assert.strictEqual(r.body.charge.status, "paid");
      assert.strictEqual([...F.pis.values()].filter((p) => p.customer === "cus_rae").length, 1);
      const keys = F.calls.filter((c) => c[0] === "paymentIntents.create" && c[1] === "pm_rae").map((c) => c[2]);
      assert.strictEqual(keys.length, 2);
      assert.strictEqual(new Set(keys).size, 1);
    });

    await check("a blocked customer is not charged and gets no link", async () => {
      const Blacklist = require("../models/Blacklist");
      const sam = await makeUser({ stripeCustomerId: "cus_sam" });
      addCustomer("cus_sam", { pm: "pm_sam" });
      await Blacklist.collection.insertOne({ email: sam.email, emailNormalized: sam.email, phone: "", reason: "test", createdAt: new Date(), active: true });
      const job = await makeBooking(sam);
      const p = await previewFor(owner, job, { description: "Extra", amount: "20", taxTreatment: CAPITAL });
      assert.strictEqual(p.direct.code, "CUSTOMER_BLOCKED");
      assert.strictEqual(p.link.allowed, false);
    });

    await check("sending a link by text to a guest who gave no text consent: the existing SMS rules hold it back", async () => {
      const guest = await makeBooking(null, { adminGuest: true, name: "Guest Hank", address: "9 Pine St", city: "Islip", state: "NY", zip: "11751", email: "hank@example.test", phone: "+16315558888" });
      const input = { description: "Extra", amount: "20", taxTreatment: CAPITAL };
      const p = await previewFor(owner, guest, input);
      const r = await call("POST", `/api/admin/jobs/${guest._id}/extra-charges`, owner, { ...input, idempotencyKey: key(), customerAgreed: true, previewFingerprint: p.fingerprint, expectedTotalCents: p.totalCents, method: "link", send: true, channels: ["sms"] });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      assert.ok(r.body.delivery && r.body.delivery.sms && r.body.delivery.sms !== "sent", JSON.stringify(r.body.delivery));
      const token = r.body.payUrl.split("/pay/")[1];
      const view = await call("GET", `/api/pay/${token}`);
      assert.strictEqual(view.body.status, "open");
    });

    await check("processing card payment: Processing until Stripe's webhook says succeeded; duplicate webhooks change nothing twice", async () => {
      const pat = await makeUser({ stripeCustomerId: "cus_pat" });
      addCustomer("cus_pat", { pm: "pm_pat", behavior: "processing" });
      const job = await makeBooking(pat);
      const { res } = await charge(owner, job, { description: "Extra", amount: "70", taxTreatment: TAXABLE });
      assert.strictEqual(res.body.charge.status, "processing");
      const rec = await AdditionalCharge.findById(res.body.charge.id).lean();
      const pi = F.pis.get(rec.paymentIntentId);
      pi.status = "succeeded";
      const ch = { id: nid("ch"), amount: pi.amount, amount_refunded: 0, receipt_url: "https://pay.stripe.test/r", payment_intent: pi.id, payment_method_details: { card: { brand: "visa", last4: "4242" } } };
      F.charges.set(ch.id, ch);
      pi.latest_charge = ch.id;
      for (const id of ["evt_pp_1", "evt_pp_1", "evt_pp_2", "evt_pp_3"]) assert.strictEqual(await sendEvent("payment_intent.succeeded", { ...pi }, id), 200);
      const after = await AdditionalCharge.findById(rec._id).lean();
      assert.strictEqual(after.status, "paid");
      assert.strictEqual(after.extraPayments.length, 0);
    });

    await check("an intent naming this record but another amount or customer is never accepted as payment", async () => {
      const rec = await AdditionalCharge.findOne({ status: "awaiting_payment" }).lean();
      const forged = { id: "pi_forged", object: "payment_intent", amount: rec.totalCents - 1, currency: "usd", customer: "cus_bob", status: "succeeded", metadata: { productKind: "additional_charge", additionalChargeId: String(rec._id), bookingId: String(rec.booking), adminPaymentLinkId: "x" }, created: now() };
      await sendEvent("payment_intent.succeeded", forged);
      assert.strictEqual((await AdditionalCharge.findById(rec._id).lean()).status, "awaiting_payment");
    });

    await check("refunds made in Stripe: partial then full, the status follows, repeated events are harmless", async () => {
      const rec = await AdditionalCharge.findById(aliceCharge.id).lean();
      const ch = F.charges.get(rec.chargeId);
      ch.amount_refunded = 5000;
      await sendEvent("charge.refunded", { ...ch, object: "charge" }, "evt_r1");
      await sendEvent("charge.refunded", { ...ch, object: "charge" }, "evt_r1b");
      let after = await AdditionalCharge.findById(rec._id).lean();
      assert.strictEqual(after.status, "partially_refunded");
      assert.strictEqual(after.refundedCents, 5000);
      ch.amount_refunded = rec.totalCents;
      await sendEvent("charge.refunded", { ...ch, object: "charge" }, "evt_r2");
      after = await AdditionalCharge.findById(rec._id).lean();
      assert.strictEqual(after.status, "refunded");
      assert.strictEqual(F.reversals.length, 0, "no Stripe Tax records in this flow");
      const listed = await call("GET", `/api/admin/jobs/${aliceJob._id}/extra-charges`, owner);
      const row = listed.body.charges.find((c) => c.id === aliceCharge.id);
      assert.strictEqual(row.statusLabel, "Refunded");
      assert.strictEqual(row.refundedCents, rec.totalCents);
    });

    await check("close an unpaid charge: its link stops and its page expires; a paid one cannot be closed", async () => {
      const quin = await makeUser({ stripeCustomerId: "cus_quin" });
      addCustomer("cus_quin", { pm: "pm_quin", behavior: "decline" });
      const job = await makeBooking(quin);
      const { res } = await charge(owner, job, { description: "Extra", amount: "15", taxTreatment: CAPITAL });
      const l = await call("POST", `/api/admin/jobs/${job._id}/extra-charges/${res.body.charge.id}/payment-link`, owner, { idempotencyKey: key() });
      const token = l.body.payUrl.split("/pay/")[1];
      await call("POST", `/api/pay/${token}/checkout`);
      const closed = await call("POST", `/api/admin/jobs/${job._id}/extra-charges/${res.body.charge.id}/close`, owner, {});
      assert.strictEqual(closed.body.charge.status, "canceled");
      assert.strictEqual((await call("POST", `/api/pay/${token}/checkout`)).status, 410);
      const paidClose = await call("POST", `/api/admin/jobs/${aliceJob._id}/extra-charges/${aliceCharge.id}/close`, owner, {});
      assert.strictEqual(paidClose.status, 409);
    });

    /* ------------------- recovery: one collectible payment ------------------- */
    async function authFailed(name, { cancelFails = false } = {}) {
      const u = await makeUser({ stripeCustomerId: `cus_${name}` });
      addCustomer(`cus_${name}`, { pm: `pm_${name}`, behavior: "auth", last4: "3155" });
      const job = await makeBooking(u);
      const before = new Set(F.pis.keys());
      // The bank check leaves the intent in requires_action; whether our cancel lands is the test.
      const origCreate = fakeStripe.paymentIntents.create;
      fakeStripe.paymentIntents.create = async (params, options) => {
        try {
          return await origCreate(params, options);
        } catch (error) {
          const pi = error.payment_intent && F.pis.get(error.payment_intent.id);
          if (pi && cancelFails) F.cancelFails.add(pi.id);
          throw error;
        }
      };
      try {
        const { res } = await charge(owner, job, { description: "Extra", amount: "90", taxTreatment: CAPITAL });
        const piId = [...F.pis.keys()].find((k) => !before.has(k));
        return { job, chargeId: res.body.charge.id, res, piId };
      } finally {
        fakeStripe.paymentIntents.create = origCreate;
      }
    }

    await check("auth required, our cancel failed: the record remembers it, and a link is made only after the old intent is really canceled", async () => {
      const { job, chargeId, res, piId } = await authFailed("rec1", { cancelFails: true });
      assert.strictEqual(res.body.charge.status, "failed");
      assert.strictEqual(F.pis.get(piId).status, "requires_action", "Stripe did not confirm the cancel");
      let rec = await AdditionalCharge.findById(chargeId).lean();
      assert.strictEqual(rec.attempts[0].cancelPending, true);
      // While Stripe still cannot cancel it, no second way to pay is made.
      const refused = await call("POST", `/api/admin/jobs/${job._id}/extra-charges/${chargeId}/payment-link`, owner, { idempotencyKey: key() });
      assert.strictEqual(refused.status, 503, JSON.stringify(refused.body));
      assert.strictEqual(await AdminPaymentLink.countDocuments({ additionalCharge: chargeId }), 0);
      // Stripe recovers: now the link is made, and the old intent is canceled first.
      F.cancelFails.delete(piId);
      const ok = await call("POST", `/api/admin/jobs/${job._id}/extra-charges/${chargeId}/payment-link`, owner, { idempotencyKey: key() });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.strictEqual(F.pis.get(piId).status, "canceled");
      rec = await AdditionalCharge.findById(chargeId).lean();
      assert.strictEqual(rec.attempts[0].cancelPending, false);
      // The customer finishing the OLD bank check now fails at Stripe: it was canceled.
      await assert.rejects(() => fakeStripe.paymentIntents.customerCompletes(piId), /status is canceled/);
      // Paying the link collects exactly once.
      const token = ok.body.payUrl.split("/pay/")[1];
      await call("POST", `/api/pay/${token}/checkout`);
      const sess = [...F.sessions.values()].find((x) => x.metadata.additionalChargeId === chargeId);
      const { session } = completeSession(sess.id);
      await sendEvent("checkout.session.completed", session);
      rec = await AdditionalCharge.findById(chargeId).lean();
      assert.strictEqual(rec.status, "paid");
      const collected = [...F.pis.values()].filter((p) => p.metadata.additionalChargeId === chargeId && p.status === "succeeded");
      assert.strictEqual(collected.length, 1, "exactly one successful payment for the extra");
    });

    await check("auth completed by the customer before we could cancel: found Paid, no link and no page are made", async () => {
      const { job, chargeId, piId } = await authFailed("rec2", { cancelFails: true });
      await fakeStripe.paymentIntents.customerCompletes(piId);
      F.cancelFails.delete(piId);
      const sessions = F.sessions.size;
      const r = await call("POST", `/api/admin/jobs/${job._id}/extra-charges/${chargeId}/payment-link`, owner, { idempotencyKey: key() });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.body.code, "ALREADY_PAID");
      const rec = await AdditionalCharge.findById(chargeId).lean();
      assert.strictEqual(rec.status, "paid");
      assert.strictEqual(rec.paymentIntentId, piId);
      assert.strictEqual(await AdminPaymentLink.countDocuments({ additionalCharge: chargeId }), 0);
      assert.strictEqual(F.sessions.size, sessions);
    });

    await check("an old link page that Stripe cannot expire blocks a new link (never two open pages)", async () => {
      const { job, chargeId } = await authFailed("rec3");
      const first = await call("POST", `/api/admin/jobs/${job._id}/extra-charges/${chargeId}/payment-link`, owner, { idempotencyKey: key() });
      await call("POST", `/api/pay/${first.body.payUrl.split("/pay/")[1]}/checkout`);
      const s1 = [...F.sessions.values()].find((x) => x.metadata.additionalChargeId === chargeId);
      F.expireFails.add(s1.id);
      const second = await call("POST", `/api/admin/jobs/${job._id}/extra-charges/${chargeId}/payment-link`, owner, { idempotencyKey: key() });
      assert.strictEqual(second.status, 503);
      assert.strictEqual(F.sessions.get(s1.id).status, "open");
      assert.strictEqual(await AdminPaymentLink.countDocuments({ additionalCharge: chargeId }), 1);
      // The first link still works; the old page is still the only one.
      assert.strictEqual((await call("POST", `/api/pay/${first.body.payUrl.split("/pay/")[1]}/checkout`)).status, 200);
      assert.strictEqual([...F.sessions.values()].filter((x) => x.metadata.additionalChargeId === chargeId).length, 1);
      F.expireFails.delete(s1.id);
    });

    await check("the pay page itself re-checks: an old card intent still open blocks opening Stripe", async () => {
      const { job, chargeId, piId } = await authFailed("rec4");
      const link = await call("POST", `/api/admin/jobs/${job._id}/extra-charges/${chargeId}/payment-link`, owner, { idempotencyKey: key() });
      // Simulate an intent that came back to life between link and payment (should never happen; must still be safe).
      F.pis.get(piId).status = "requires_action";
      F.cancelFails.add(piId);
      const sessions = F.sessions.size;
      const open = await call("POST", `/api/pay/${link.body.payUrl.split("/pay/")[1]}/checkout`);
      assert.strictEqual(open.status, 503);
      assert.strictEqual(F.sessions.size, sessions, "no Stripe page while the old intent could still succeed");
      F.cancelFails.delete(piId);
      const again = await call("POST", `/api/pay/${link.body.payUrl.split("/pay/")[1]}/checkout`);
      assert.strictEqual(again.status, 200);
      assert.strictEqual(F.pis.get(piId).status, "canceled");
    });

    /* ------------------- reconciliation with nobody looking ------------------- */
    await check("background sweep: a processing card payment becomes Paid without anyone opening the job", async () => {
      const tom = await makeUser({ stripeCustomerId: "cus_tom" });
      addCustomer("cus_tom", { pm: "pm_tom", behavior: "processing" });
      const job = await makeBooking(tom);
      const { res } = await charge(owner, job, { description: "Extra", amount: "44", taxTreatment: CAPITAL });
      assert.strictEqual(res.body.charge.status, "processing");
      const rec = await AdditionalCharge.findById(res.body.charge.id).lean();
      const pi = F.pis.get(rec.paymentIntentId);
      pi.status = "succeeded";
      const ch = { id: nid("ch"), amount: pi.amount, amount_refunded: 0, receipt_url: "https://pay.stripe.test/s", payment_intent: pi.id, payment_method_details: { card: { brand: "visa", last4: "4242" } } };
      F.charges.set(ch.id, ch);
      pi.latest_charge = ch.id;
      const r = await sweepOpen({ now: new Date(Date.now() + 5 * 60 * 1000) });
      assert.ok(r.checked >= 1 && r.errors === 0, JSON.stringify(r));
      assert.strictEqual((await AdditionalCharge.findById(rec._id).lean()).status, "paid");
    });

    await check("background sweep: a link paid while the webhook was lost becomes Paid; a lost refund is picked up nightly", async () => {
      const una = await makeUser({ stripeCustomerId: "cus_una" });
      addCustomer("cus_una", { pm: "pm_una", behavior: "decline" });
      const job = await makeBooking(una);
      const { res } = await charge(owner, job, { description: "Extra", amount: "66", taxTreatment: TAXABLE });
      const l = await call("POST", `/api/admin/jobs/${job._id}/extra-charges/${res.body.charge.id}/payment-link`, owner, { idempotencyKey: key() });
      await call("POST", `/api/pay/${l.body.payUrl.split("/pay/")[1]}/checkout`);
      const sess = [...F.sessions.values()].find((x) => x.metadata.additionalChargeId === res.body.charge.id);
      completeSession(sess.id); // paid at Stripe, NO webhook sent
      await sweepOpen({ now: new Date(Date.now() + 5 * 60 * 1000) });
      let rec = await AdditionalCharge.findById(res.body.charge.id).lean();
      assert.strictEqual(rec.status, "paid");
      F.charges.get(rec.chargeId).amount_refunded = rec.totalCents; // refunded in Stripe, NO webhook
      await AdditionalCharge.updateOne({ _id: rec._id }, { $set: { lastStripeSyncAt: null } });
      await sweepRefunds();
      rec = await AdditionalCharge.findById(rec._id).lean();
      assert.strictEqual(rec.status, "refunded");
      assert.strictEqual(rec.refundedCents, rec.totalCents);
      await sweepRefunds();
      assert.strictEqual((await AdditionalCharge.findById(rec._id).lean()).status, "refunded", "a second sweep changes nothing");
    });

    await check("background sweep: a card cancel Stripe did not confirm is retried until it is canceled", async () => {
      const { chargeId, piId } = await authFailed("rec5", { cancelFails: true });
      assert.strictEqual(F.pis.get(piId).status, "requires_action");
      F.cancelFails.delete(piId);
      await sweepOpen({ now: new Date(Date.now() + 5 * 60 * 1000) });
      assert.strictEqual(F.pis.get(piId).status, "canceled");
      assert.strictEqual((await AdditionalCharge.findById(chargeId).lean()).attempts[0].cancelPending, false);
    });

    /* ---------------- the customer profile: charges with no booking ---------------- */
    await check("customer profile: only the Owner and a General Fixter may see who pays, charge, list or act; the profile offers it to them only", async () => {
      const charges0 = await AdditionalCharge.countDocuments();
      for (const who of [manager, field, alice]) {
        for (const [m, p] of [["GET", custBase(alice)], ["GET", `${custBase(alice)}/target`], ["POST", custBase(alice)], ["POST", `${custBase(alice)}/${aliceCharge.id}/refresh`]]) {
          const r = await call(m, p, who, { amount: "40", idempotencyKey: key(), method: "card" });
          assert.strictEqual(r.status, 403, `${who.name} ${m} ${p} -> ${r.status}`);
        }
      }
      assert.strictEqual((await call("GET", custBase(alice))).status, 401);
      assert.strictEqual(await AdditionalCharge.countDocuments(), charges0);
      const mine = await call("GET", `/api/admin/customers/${alice._id}`, owner);
      assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));
      assert.strictEqual(mine.body.allowedActions.chargeCustomer, true);
      const theirs = await call("GET", `/api/admin/customers/${alice._id}`, manager);
      assert.strictEqual(theirs.body.allowedActions.chargeCustomer, false, "customers.manage alone does not grant charging");
      const gf = await call("GET", `/api/admin/customers/${alice._id}`, general);
      assert.strictEqual(gf.status, 200, JSON.stringify(gf.body));
      assert.strictEqual(gf.body.allowedActions.chargeCustomer, true);
      // Nothing else widened for the General Fixter: no customer edits, memberships, archiving or contact changes.
      for (const k of ["editProfile", "editContact", "changePlan", "scheduleCancellation", "grantComplimentary", "sellMembership", "archive"]) assert.strictEqual(gf.body.allowedActions[k], false, k);
      // The existing customer-access restriction holds: a field Fixter cannot open a profile at all.
      assert.strictEqual((await call("GET", `/api/admin/customers/${alice._id}`, field)).status, 403);
    });

    await check("role matrix on BOTH entry points: Owner and General Fixter preview, charge, retry, copy and send a link, close; a field Fixter gets 403 on every one, also with real charge ids", async () => {
      const gwen = await makeUser({ name: "Gwen Gate", stripeCustomerId: "cus_gwen" });
      addCustomer("cus_gwen", { pm: "pm_gwen", behavior: "decline", last4: "7070" });
      const gJob = await makeBooking(gwen, { assignedFixterId: field._id, status: "Completed" });
      const entries = [
        { name: "booking", base: `/api/admin/jobs/${gJob._id}/extra-charges` },
        { name: "profile", base: custBase(gwen) },
      ];
      const made = [];
      let amount = 31;
      for (const who of [owner, general]) {
        for (const e of entries) {
          const t = await call("GET", `${e.base}/target`, who);
          assert.strictEqual(t.status, 200, `${who.name} ${e.name} target`);
          assert.strictEqual(t.body.target.card.last4, "7070");
          amount += 1;
          const c = await call("POST", e.base, who, {
            amount: String(amount), idempotencyKey: key(), targetFingerprint: t.body.target.fingerprint, method: "card",
            // a tampered browser: someone else's ids are ignored
            stripeCustomerId: "cus_alice", paymentMethodId: "pm_alice", userId: String(alice._id), customerId: String(alice._id),
          });
          assert.strictEqual(c.status, 201, `${who.name} ${e.name} charge ${JSON.stringify(c.body)}`);
          assert.strictEqual(c.body.charge.status, "failed", "declined: the real result");
          const rec = await AdditionalCharge.findById(c.body.charge.id).lean();
          assert.deepStrictEqual([String(rec.user), rec.stripeCustomerId, rec.paymentMethodId], [String(gwen._id), "cus_gwen", "pm_gwen"], "only the account's own Stripe customer and card");
          assert.strictEqual(rec.consent.confirmedByName, who.name);
          assert.strictEqual(rec.consent.confirmedByRole, who === owner ? "owner" : "general_fixter");
          assert.strictEqual(rec.consent.statement, `The ${who === owner ? "owner" : "General Fixter"} pressed "Charge $${amount}.00".`);
          const retry = await call("POST", `${e.base}/${rec._id}/retry-card`, who, { idempotencyKey: key(), expectedCardLast4: "7070" });
          assert.strictEqual(retry.status, 200, `${who.name} ${e.name} retry ${JSON.stringify(retry.body)}`);
          const copy = await call("POST", `${e.base}/${rec._id}/payment-link`, who, { idempotencyKey: key(), send: false });
          assert.strictEqual(copy.status, 200, `${who.name} ${e.name} copy link`);
          const emails = sentEmails.length;
          const send = await call("POST", `${e.base}/${rec._id}/payment-link`, who, { idempotencyKey: key(), send: true, channels: ["email"] });
          assert.strictEqual(send.status, 200, `${who.name} ${e.name} send link`);
          assert.strictEqual(sentEmails.length, emails + 1, "sent through the (fake) mailer only");
          assert.strictEqual(sentEmails.at(-1).to, gwen.email, "to the account's own email");
          assert.strictEqual((await call("POST", `${e.base}/${rec._id}/refresh`, who, {})).status, 200);
          made.push({ e, id: String(rec._id) });
        }
      }
      // The General Fixter's charge, its link and its record are the same kind of record as the owner's.
      assert.strictEqual(await AdditionalCharge.countDocuments({ user: gwen._id }), 4);

      // A field Fixter: refused on every action, both entry points, even on their own assigned job and with real ids.
      const counts = async () => [await AdditionalCharge.countDocuments(), await AdminPaymentLink.countDocuments(), piCreates(), sentEmails.length];
      const before = await counts();
      for (const e of entries) {
        const t = await call("GET", `${e.base}/target`, field);
        assert.strictEqual(t.status, 403, `field ${e.name} target`);
        assert.strictEqual(t.body.code, "CHARGE_NOT_ALLOWED");
        assert.strictEqual((await call("GET", e.base, field)).status, 403);
        assert.strictEqual((await call("POST", e.base, field, { amount: "25", idempotencyKey: key(), targetFingerprint: "x", method: "card" })).status, 403);
        assert.strictEqual((await call("POST", e.base, field, { amount: "25", idempotencyKey: key(), targetFingerprint: "x", method: "link", send: true, channels: ["email", "sms"] })).status, 403);
      }
      for (const { e, id } of made) {
        for (const [action, body] of [["refresh", {}], ["retry-card", { idempotencyKey: key(), expectedCardLast4: "7070" }], ["payment-link", { idempotencyKey: key(), send: false }], ["payment-link", { idempotencyKey: key(), send: true, channels: ["email", "sms"] }], ["close", {}]]) {
          const r = await call("POST", `${e.base}/${id}/${action}`, field, body);
          assert.strictEqual(r.status, 403, `field ${e.name} ${action} -> ${r.status}`);
        }
      }
      // An old pay page link still belongs to the customer, not to staff: it needs no staff role and is unaffected.
      assert.deepStrictEqual(await counts(), before, "nothing made, charged or sent for the field Fixter");
      assert.ok(!(await AdditionalCharge.find({ user: gwen._id }).lean()).some((r) => r.status === "canceled"), "the field Fixter closed nothing");

      // Duplicate protection holds across roles and screens: the owner's amount from the job, then the General Fixter from the profile.
      F.pms.get("pm_gwen").behavior = "ok";
      const ot = await call("GET", `${entries[0].base}/target`, owner);
      const first = await call("POST", entries[0].base, owner, { amount: "66", idempotencyKey: key(), targetFingerprint: ot.body.target.fingerprint, method: "card" });
      assert.strictEqual(first.body.charge.status, "paid");
      const gt = await call("GET", `${entries[1].base}/target`, general);
      const again = await call("POST", entries[1].base, general, { amount: "66", idempotencyKey: key(), targetFingerprint: gt.body.target.fingerprint, method: "card" });
      assert.strictEqual(again.status, 409);
      assert.strictEqual(again.body.code, "POSSIBLE_DUPLICATE");
      // And a General Fixter's stale screen is refused like the owner's.
      F.pms.set("pm_gwen2", { id: "pm_gwen2", type: "card", customer: "cus_gwen", card: { brand: "visa", last4: "8080", exp_month: 1, exp_year: 2031 } });
      F.customers.get("cus_gwen").invoice_settings.default_payment_method = "pm_gwen2";
      const stale = await call("POST", entries[1].base, general, { amount: "12", idempotencyKey: key(), targetFingerprint: gt.body.target.fingerprint, method: "card" });
      assert.strictEqual(stale.body.code, "TARGET_CHANGED");
    });

    let directCharge;
    await check("both entry points resolve the SAME account, Stripe customer and card; a direct charge needs and makes no booking", async () => {
      const { resolveChargeTarget, resolveCustomerChargeTarget } = require("../utils/extraCharges/linkage");
      const viaBooking = await resolveChargeTarget(await Booking.findById(aliceJob._id), { stripe: fakeStripe });
      const viaProfile = await resolveCustomerChargeTarget(alice._id, { stripe: fakeStripe });
      const pick = (t) => ({ account: t.accountUserId, customer: t.customerId, pm: t.paymentMethodId, last4: t.card?.last4, direct: t.direct.allowed });
      assert.deepStrictEqual(pick(viaProfile), pick(viaBooking));
      assert.deepStrictEqual(pick(viaProfile), { account: String(alice._id), customer: "cus_alice", pm: "pm_alice", last4: "1111", direct: true });

      const shown = (await customerTarget(owner, alice)).body.target;
      assert.strictEqual(shown.scope, "direct");
      assert.strictEqual(shown.booking, null);
      assert.strictEqual(shown.customer.name, "Alice Able");
      assert.deepStrictEqual({ brand: shown.card.brand, last4: shown.card.last4 }, { brand: "visa", last4: "1111" });
      assert.ok(!JSON.stringify(shown).includes("pm_alice") && !JSON.stringify(shown).includes("cus_alice"), "no Stripe ids reach the browser");

      const bookings = await Booking.countDocuments();
      const { res } = await chargeDirect(owner, alice, "211.11", { note: "Emergency call-out, burst pipe" });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      directCharge = res.body.charge;
      assert.strictEqual(directCharge.status, "paid");
      assert.strictEqual(directCharge.scope, "direct");
      assert.strictEqual(directCharge.where, "Direct charge");
      assert.strictEqual(directCharge.bookingId, null);
      assert.ok(/^80000001-D1$/.test(directCharge.number), directCharge.number);
      assert.strictEqual(await Booking.countDocuments(), bookings, "no booking is created");
      const rec = await AdditionalCharge.findById(directCharge.id).lean();
      assert.strictEqual(rec.booking, null);
      assert.strictEqual(String(rec.user), String(alice._id));
      const bookingRec = await AdditionalCharge.findById(aliceCharge.id).lean();
      assert.deepStrictEqual([rec.stripeCustomerId, rec.paymentMethodId], [bookingRec.stripeCustomerId, bookingRec.paymentMethodId], "the same Stripe customer and card as from her booking");
      const pi = F.pis.get(rec.paymentIntentId);
      assert.deepStrictEqual([pi.customer, pi.payment_method, pi.amount], ["cus_alice", "pm_alice", 21111], "exactly the entered total, nothing added");
      assert.deepStrictEqual(
        { s: pi.metadata.chargeScope, b: pi.metadata.bookingId, u: pi.metadata.userMongoId, t: pi.metadata.taxStatus },
        { s: "direct", b: "", u: String(alice._id), t: "not_calculated" }
      );
      assert.strictEqual(rec.consent.statement, 'The owner pressed "Charge $211.11".');
      assert.ok(await AdminActivityLog.findOne({ action: "Direct Charge (Saved Card)", entityType: "user", entityId: String(alice._id) }));
    });

    await check("one record, two places: a booking charge shows under its job AND the customer; a direct charge only under the customer", async () => {
      const cust = await call("GET", custBase(alice), owner);
      assert.strictEqual(cust.status, 200);
      const all = cust.body.charges;
      assert.strictEqual(all.length, await AdditionalCharge.countDocuments({ user: alice._id }), "every one of hers, once");
      assert.strictEqual(new Set(all.map((c) => c.id)).size, all.length, "no duplicates");
      const direct = all.find((c) => c.id === directCharge.id);
      assert.deepStrictEqual(
        { where: direct.where, note: direct.note, by: direct.confirmedByName, status: direct.status, receipt: Boolean(direct.receiptUrl), at: Boolean(direct.confirmedAt) },
        { where: "Direct charge", note: "Emergency call-out, burst pipe", by: "Owner Person", status: "paid", receipt: true, at: true }
      );
      const onJob = (await call("GET", `/api/admin/jobs/${aliceJob._id}/extra-charges`, owner)).body.charges;
      const fromJob = onJob.find((c) => c.id === aliceCharge.id);
      const fromCustomer = all.find((c) => c.id === aliceCharge.id);
      assert.deepStrictEqual(fromCustomer, fromJob, "the same record, serialized the same, from both");
      assert.strictEqual(fromCustomer.where, `Job #${aliceJob.bookingNumber}`);
      assert.ok(!onJob.some((c) => c.id === directCharge.id), "a direct charge is on no job");
      assert.strictEqual(await AdditionalCharge.countDocuments({ _id: aliceCharge.id }), 1);
    });

    await check("tampered customer-profile requests: browser ids, someone else's screen, key or charge id never reach another account", async () => {
      const aliceShown = (await customerTarget(owner, alice)).body.target;
      const bobShown = (await customerTarget(owner, bob)).body.target;
      const creates = piCreates();
      // Bob's URL with every Alice id a confused or tampered browser could send: Bob pays, only Bob.
      const r = await call("POST", custBase(bob), owner, {
        amount: "33.30", idempotencyKey: key(), targetFingerprint: bobShown.fingerprint, method: "card",
        userId: String(alice._id), customerId: String(alice._id), stripeCustomerId: "cus_alice", paymentMethodId: "pm_alice", payment_method: "pm_alice", bookingId: String(aliceJob._id), email: "shared@example.test",
      });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      const rec = await AdditionalCharge.findById(r.body.charge.id).lean();
      assert.strictEqual(String(rec.user), String(bob._id));
      assert.deepStrictEqual([F.pis.get(rec.paymentIntentId).customer, F.pis.get(rec.paymentIntentId).payment_method], ["cus_bob", "pm_bob"]);
      assert.strictEqual(r.body.charge.card.last4, "2222");
      // Alice's screen (fingerprint) sent to Bob's URL, and Alice's booking screen sent to her profile URL: refused, nothing charged.
      for (const [url, fp] of [[custBase(bob), aliceShown.fingerprint], [custBase(alice), (await previewFor(owner, aliceJob)).fingerprint]]) {
        const bad = await call("POST", url, owner, { amount: "33.31", idempotencyKey: key(), targetFingerprint: fp, method: "card" });
        assert.strictEqual(bad.status, 409);
        assert.strictEqual(bad.body.code, "TARGET_CHANGED");
      }
      assert.strictEqual(piCreates() - creates, 1, "only Bob's one charge");
      // One press's key cannot be replayed into another customer, or onto a job.
      const used = r.body.charge && (await AdditionalCharge.findById(r.body.charge.id).lean()).clientKey;
      for (const url of [custBase(alice), `/api/admin/jobs/${aliceJob._id}/extra-charges`]) {
        const replay = await call("POST", url, owner, { amount: "33.30", idempotencyKey: used, targetFingerprint: aliceShown.fingerprint, method: "card" });
        assert.strictEqual(replay.status, 409, url);
        assert.strictEqual(replay.body.code, "KEY_REUSED");
      }
      // A charge id only works under its own customer, or its own job.
      for (const [m, p, body] of [
        ["POST", `${custBase(bob)}/${directCharge.id}/refresh`, {}],
        ["POST", `${custBase(bob)}/${directCharge.id}/retry-card`, { idempotencyKey: key(), expectedCardLast4: "2222" }],
        ["POST", `${custBase(bob)}/${directCharge.id}/payment-link`, { idempotencyKey: key() }],
        ["POST", `${custBase(bob)}/${aliceCharge.id}/close`, {}],
        ["POST", `/api/admin/jobs/${aliceJob._id}/extra-charges/${directCharge.id}/refresh`, {}],
        ["POST", `/api/admin/jobs/${bobJob._id}/extra-charges/${directCharge.id}/retry-card`, { idempotencyKey: key(), expectedCardLast4: "1111" }],
      ]) {
        assert.strictEqual((await call(m, p, owner, body)).status, 404, p);
      }
      assert.strictEqual((await call("GET", `${custBase("not-an-id")}/target`, owner)).status, 400);
      assert.strictEqual((await call("GET", `${custBase(new mongoose.Types.ObjectId())}/target`, owner)).status, 404);
      const staff = (await customerTarget(owner, general)).body.target;
      assert.deepStrictEqual([staff.direct.allowed, staff.direct.code, staff.link.allowed], [false, "STAFF_ACCOUNT", false], "a staff account is never charged");
      const staffPost = await call("POST", custBase(general), owner, { amount: "10", idempotencyKey: key(), targetFingerprint: staff.fingerprint, method: "card" });
      assert.strictEqual(staffPost.status, 409);
      assert.ok(![...F.pis.values()].some((x) => x.customer === "cus_alice" && x.amount === 3330), "Alice was never charged Bob's amount");
    });

    await check("ambiguous or missing mappings block the profile entry point exactly as they block the booking one", async () => {
      const kit = await makeUser({ stripeCustomerId: "cus_kit_shared" });
      await makeUser({ stripeCustomerId: "cus_kit_shared" });
      addCustomer("cus_kit_shared", { pm: "pm_kit" });
      const lia = await makeUser({ stripeCustomerId: "cus_lia" });
      addCustomer("cus_lia", { pm: "pm_lia", metadata: { userMongoId: String(bob._id) } });
      const max = await makeUser({ email: "max@example.test" });
      const nia = await makeUser({ stripeCustomerId: "cus_nia" });
      addCustomer("cus_nia", { pm: null });
      F.customers.get("cus_nia").invoice_settings.default_payment_method = "pm_bob"; // another customer's card
      for (const [u, code] of [[kit, "STRIPE_CUSTOMER_SHARED"], [lia, "STRIPE_CUSTOMER_MISMATCH"], [max, "NO_STRIPE_CUSTOMER"], [nia, "PM_NOT_OWNED"]]) {
        const fromProfile = (await customerTarget(owner, u)).body.target;
        const fromBooking = await previewFor(owner, await makeBooking(u));
        assert.deepStrictEqual([fromProfile.direct.allowed, fromProfile.direct.code], [false, code], code + " got " + JSON.stringify(fromProfile.direct));
        assert.strictEqual(fromBooking.direct.code, fromProfile.direct.code, "the same answer from both");
        assert.strictEqual(fromProfile.card, null, `${code}: no card shown`);
        const creates = piCreates();
        const r = await call("POST", custBase(u), owner, { amount: "20", idempotencyKey: key(), targetFingerprint: fromProfile.fingerprint, method: "card" });
        assert.strictEqual(r.body.code, code);
        assert.strictEqual(piCreates(), creates);
      }
    });

    await check("accidental repeats are caught across the two entry points, in either order and when pressed at the same moment", async () => {
      const quinn = await makeUser({ name: "Quinn Quill", stripeCustomerId: "cus_quinn" });
      addCustomer("cus_quinn", { pm: "pm_quinn", last4: "5151" });
      const qJob = await makeBooking(quinn);
      // Booking first, then the profile.
      const p = await previewFor(owner, qJob);
      const first = await call("POST", `/api/admin/jobs/${qJob._id}/extra-charges`, owner, { amount: "150", idempotencyKey: key(), targetFingerprint: p.fingerprint, method: "card" });
      assert.strictEqual(first.body.charge.status, "paid");
      const creates = piCreates();
      const fromProfile = await chargeDirect(owner, quinn, "150");
      assert.strictEqual(fromProfile.res.status, 409);
      assert.strictEqual(fromProfile.res.body.code, "POSSIBLE_DUPLICATE");
      assert.ok(/already charged for Quinn Quill .*on job #/.test(fromProfile.res.body.message), fromProfile.res.body.message);
      assert.strictEqual(piCreates(), creates);
      const meant = await call("POST", custBase(quinn), owner, { ...fromProfile.body, idempotencyKey: key(), allowRepeat: true });
      assert.strictEqual(meant.status, 201, "a deliberate second charge, confirmed");
      // Profile first, then the booking.
      const d = await chargeDirect(owner, quinn, "61");
      assert.strictEqual(d.res.body.charge.status, "paid");
      const viaJob = await call("POST", `/api/admin/jobs/${qJob._id}/extra-charges`, owner, { amount: "61", idempotencyKey: key(), targetFingerprint: (await previewFor(owner, qJob)).fingerprint, method: "card" });
      assert.strictEqual(viaJob.body.code, "POSSIBLE_DUPLICATE");
      assert.ok(/as a direct charge/.test(viaJob.body.message), viaJob.body.message);
      // Two screens pressed at the same moment, different keys: one charge, one question.
      const t = (await customerTarget(owner, quinn)).body.target;
      const jp = await previewFor(owner, qJob);
      const before = piCreates();
      const [a, b] = await Promise.all([
        call("POST", custBase(quinn), owner, { amount: "77", idempotencyKey: key(), targetFingerprint: t.fingerprint, method: "card" }),
        call("POST", `/api/admin/jobs/${qJob._id}/extra-charges`, owner, { amount: "77", idempotencyKey: key(), targetFingerprint: jp.fingerprint, method: "card" }),
      ]);
      assert.deepStrictEqual([a.status, b.status].sort(), [201, 409], JSON.stringify([a.body, b.body]));
      assert.strictEqual([a, b].find((x) => x.status === 409).body.code, "POSSIBLE_DUPLICATE");
      assert.strictEqual(piCreates() - before, 1);
      assert.strictEqual(await AdditionalCharge.countDocuments({ user: quinn._id, totalCents: 7700 }), 1);
      // Another customer's same amount is not a repeat.
      const other = await chargeDirect(owner, bob, "77");
      assert.strictEqual(other.res.status, 201);
    });

    await check("direct charge, double tap and stale card: one key is one charge; a card changed since the screen opened is refused and shown", async () => {
      const rory = await makeUser({ stripeCustomerId: "cus_rory" });
      addCustomer("cus_rory", { pm: "pm_rory", last4: "4444" });
      const t = (await customerTarget(owner, rory)).body.target;
      const body = { amount: "45", idempotencyKey: key(), targetFingerprint: t.fingerprint, method: "card" };
      const creates = piCreates();
      const [a, b] = await Promise.all([call("POST", custBase(rory), owner, body), call("POST", custBase(rory), owner, body)]);
      const c = await call("POST", custBase(rory), owner, body);
      assert.strictEqual(await AdditionalCharge.countDocuments({ user: rory._id }), 1);
      assert.strictEqual(piCreates() - creates, 1);
      for (const r of [a, b, c].filter((r) => r.status < 300)) assert.strictEqual(r.body.charge.id, c.body.charge.id);
      assert.strictEqual(c.body.replayed, true);
      // The customer's default card changes while the owner's screen is open.
      const t2 = (await customerTarget(owner, rory)).body.target;
      F.pms.set("pm_rory2", { id: "pm_rory2", type: "card", customer: "cus_rory", card: { brand: "amex", last4: "0005", exp_month: 4, exp_year: 2031 } });
      F.customers.get("cus_rory").invoice_settings.default_payment_method = "pm_rory2";
      const stale = await call("POST", custBase(rory), owner, { amount: "12", idempotencyKey: key(), targetFingerprint: t2.fingerprint, method: "card" });
      assert.strictEqual(stale.status, 409);
      assert.strictEqual(stale.body.code, "TARGET_CHANGED");
      assert.strictEqual(stale.body.target.card.last4, "0005", "the new card comes back to show");
      assert.strictEqual(piCreates() - creates, 1);
    });

    await check("direct charge declined, then a payment link that belongs only to that charge: paid once, closes, cannot pay twice", async () => {
      const sky = await makeUser({ stripeCustomerId: "cus_sky" });
      addCustomer("cus_sky", { pm: "pm_sky", behavior: "auth", last4: "3184" });
      const { res } = await chargeDirect(owner, sky, "88", { note: "After-hours lockout" });
      assert.strictEqual(res.body.charge.status, "failed");
      assert.strictEqual(res.body.charge.failure.code, "authentication_required");
      assert.ok(res.body.charge.actions.includes("paymentLink"));
      const id = res.body.charge.id;
      assert.strictEqual(F.pis.get((await AdditionalCharge.findById(id).lean()).attempts[0].paymentIntentId).status, "canceled", "the old intent cannot be completed");
      const l = await call("POST", `${custBase(sky)}/${id}/payment-link`, owner, { idempotencyKey: key(), send: false });
      assert.strictEqual(l.status, 200, JSON.stringify(l.body));
      const token = l.body.payUrl.split("/pay/")[1];
      const link = await AdminPaymentLink.findOne({ tokenHash: hashToken(token) }).lean();
      assert.strictEqual(String(link.additionalCharge), id, "the link belongs to this one charge");
      assert.strictEqual(link.booking || null, null);
      assert.ok(/your Profixter service: After-hours lockout/.test(link.itemLabel), link.itemLabel);
      const open = await call("POST", `/api/pay/${token}/checkout`);
      assert.strictEqual(open.status, 200, JSON.stringify(open.body));
      const sess = [...F.sessions.values()].find((x) => x.metadata.additionalChargeId === id);
      assert.strictEqual(sess.customer, "cus_sky");
      assert.strictEqual(sess.metadata.chargeScope, "direct");
      assert.deepStrictEqual(sess.line_items_param.map((x) => [x.price_data.unit_amount, x.price_data.product_data.name]), [[8800, "Profixter"]]);
      const { session } = completeSession(sess.id);
      assert.strictEqual(await sendEvent("checkout.session.completed", session, "evt_direct_link_1"), 200);
      const rec = await AdditionalCharge.findById(id).lean();
      assert.strictEqual(rec.status, "paid");
      assert.strictEqual(rec.extraPayments.length, 0);
      assert.strictEqual((await call("POST", `/api/pay/${token}/checkout`)).status, 410);
      assert.strictEqual((await call("POST", `${custBase(sky)}/${id}/payment-link`, owner, { idempotencyKey: key() })).status, 409);
      assert.strictEqual(await AdditionalCharge.countDocuments({ user: sky._id }), 1, "one charge, one transaction");
    });

    await check("direct charges reconcile with nobody looking: processing becomes Paid by the sweep; a refund in Stripe follows", async () => {
      const tia = await makeUser({ stripeCustomerId: "cus_tia" });
      addCustomer("cus_tia", { pm: "pm_tia", behavior: "processing" });
      const { res } = await chargeDirect(owner, tia, "52");
      assert.strictEqual(res.body.charge.status, "processing");
      const rec = await AdditionalCharge.findById(res.body.charge.id).lean();
      const pi = F.pis.get(rec.paymentIntentId);
      pi.status = "succeeded";
      const ch = { id: nid("ch"), amount: pi.amount, amount_refunded: 0, receipt_url: "https://pay.stripe.test/d", payment_intent: pi.id, payment_method_details: { card: { brand: "visa", last4: "4242" } } };
      F.charges.set(ch.id, ch);
      pi.latest_charge = ch.id;
      const r = await sweepOpen({ now: new Date(Date.now() + 5 * 60 * 1000) });
      assert.strictEqual(r.errors, 0, JSON.stringify(r));
      const paid = await AdditionalCharge.findById(rec._id).lean();
      assert.deepStrictEqual([paid.status, paid.receiptUrl], ["paid", "https://pay.stripe.test/d"]);
      ch.amount_refunded = 2000;
      await sweepRefunds({ now: new Date(Date.now() + 60 * 60 * 1000) });
      assert.deepStrictEqual([(await AdditionalCharge.findById(rec._id).lean()).status, (await AdditionalCharge.findById(rec._id).lean()).refundedCents], ["partially_refunded", 2000]);
    });

    await check("customer billing: direct and booking charges are labelled on their Stripe payment, each counted once", async () => {
      const recs = await AdditionalCharge.find({ user: alice._id, paymentIntentId: { $ne: "" } }).lean();
      customerBilling.setStripeClient({
        customers: { retrieve: async (id) => ({ id, invoice_settings: {} }) },
        subscriptions: { list: async () => list([]) },
        invoices: { list: async () => list([]), createPreview: async () => { throw Object.assign(new Error("none"), { code: "invoice_upcoming_none" }); } },
        charges: { list: async () => list(recs.map((r) => ({ id: r.chargeId, payment_intent: r.paymentIntentId, amount: r.totalCents, created: now(), status: "succeeded", paid: true }))) },
      });
      const b = await customerBilling.billingForCustomer(alice, { fresh: true });
      const directRow = b.payments.find((p) => p.extraCharge?.id === directCharge.id);
      assert.deepStrictEqual({ direct: directRow.extraCharge.direct, bookingId: directRow.extraCharge.bookingId }, { direct: true, bookingId: null });
      const jobRow = b.payments.find((p) => p.extraCharge?.id === aliceCharge.id);
      assert.deepStrictEqual({ direct: jobRow.extraCharge.direct, n: jobRow.extraCharge.bookingNumber }, { direct: false, n: aliceJob.bookingNumber });
      assert.strictEqual(b.payments.length, recs.length, "one Stripe payment per charge, none added from our records");
    });

    await check("billing history labels extras inside the Stripe charges and does not list them twice", async () => {
      const recs = await AdditionalCharge.find({ user: alice._id, paymentIntentId: { $ne: "" } }).lean();
      customerBilling.setStripeClient({
        customers: { retrieve: async (id) => ({ id, invoice_settings: {} }) },
        subscriptions: { list: async () => list([]) },
        invoices: { list: async () => list([]), createPreview: async () => { throw Object.assign(new Error("none"), { code: "invoice_upcoming_none" }); } },
        charges: { list: async () => list(recs.map((r) => ({ id: r.chargeId, payment_intent: r.paymentIntentId, amount: r.totalCents, created: now(), status: "succeeded", paid: true }))) },
      });
      const b = await customerBilling.billingForCustomer(alice, { fresh: true });
      assert.strictEqual(b.available, true);
      assert.strictEqual(b.payments.length, recs.length);
      assert.ok(b.payments.every((p) => p.extraCharge && (p.extraCharge.bookingNumber || p.extraCharge.direct)));
      assert.ok(b.additionalCharges.filter((a) => a.paidAt).every((a) => a.inPayments));
      const total = b.payments.reduce((s, p) => s + p.amountCents, 0);
      assert.strictEqual(total, recs.reduce((s, r) => s + r.totalCents, 0), "counted once");
    });

    await check("Overview revenue: an extra is its own kind", async () => {
      const row = classifyCharge({ id: "ch_x", amount: 13410, amount_refunded: 0, created: now(), payment_intent: { id: "pi_x", metadata: { productKind: "additional_charge", taxStatus: "not_calculated" } } });
      assert.strictEqual(row.kind, "extra");
    });
  } finally {
    server.close();
    await mongoose.disconnect();
    await mongod.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
