/*
 * Charge extra, end to end: owner-only access, server-side ownership, the
 * saved card, tax, the PaymentIntent, payment links, webhooks and refunds.
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
  // A well-formed placeholder: the real code is the accountant's decision (config/taxCodes.js).
  STRIPE_TAX_CODE_ADDITIONAL_WORK: "txcd_99999999",
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
app.use("/api/pay", require("../routes/pay"));

let base;
const tokenFor = (u) => jwt.sign({ id: String(u._id), tv: Number(u.tokenVersion || 0) }, process.env.JWT_SECRET, { expiresIn: "10m" });
async function call(method, path, user, body) {
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
async function previewFor(owner, booking, input) {
  const r = await call("POST", `/api/admin/jobs/${booking._id}/extra-charges/preview`, owner, input);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body.preview;
}
async function charge(owner, booking, input, extra = {}) {
  const p = await previewFor(owner, booking, input);
  const body = { ...input, idempotencyKey: key(), customerAgreed: true, previewFingerprint: p.fingerprint, expectedTotalCents: p.totalCents, method: "card", ...extra };
  const r = await call("POST", `/api/admin/jobs/${booking._id}/extra-charges`, owner, body);
  return { preview: p, res: r, body };
}
const piCreates = () => F.calls.filter((c) => c[0] === "paymentIntents.create").length;
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
    await check("only the owner may preview, charge, list or act; everyone else is refused by the server", async () => {
      const input = { description: "Hang extra shelf", amount: "40", taxTreatment: CAPITAL };
      for (const who of [general, manager, field, alice]) {
        for (const [m, p] of [["GET", `/api/admin/jobs/${aliceJob._id}/extra-charges`], ["POST", `/api/admin/jobs/${aliceJob._id}/extra-charges/preview`], ["POST", `/api/admin/jobs/${aliceJob._id}/extra-charges`]]) {
          const r = await call(m, p, who, { ...input, idempotencyKey: key(), customerAgreed: true, method: "card" });
          assert.strictEqual(r.status, 403, `${who.name} ${m} ${p} -> ${r.status}`);
        }
      }
      assert.strictEqual((await call("GET", `/api/admin/jobs/${aliceJob._id}/extra-charges`)).status, 401);
      assert.strictEqual(await AdditionalCharge.countDocuments(), 0);
      assert.strictEqual(piCreates(), 0);
    });

    await check("the job sheet offers Charge extra to the owner only, on confirmed or completed visits", async () => {
      const mine = await call("GET", `/api/admin/jobs/${aliceJob._id}`, owner);
      assert.ok(mine.body.job.allowedActions.includes("chargeExtra"));
      assert.deepStrictEqual(mine.body.job.extraCharges, { count: 0, paidCents: 0, open: 0 });
      const gf = await call("GET", `/api/admin/jobs/${aliceJob._id}`, general);
      assert.ok(!gf.body.job.allowedActions.includes("chargeExtra"));
      assert.strictEqual(gf.body.job.extraCharges, undefined);
      const pending = await makeBooking(alice, { status: "Pending" });
      const p = await call("GET", `/api/admin/jobs/${pending._id}`, owner);
      assert.ok(!p.body.job.allowedActions.includes("chargeExtra"));
      const pr = await previewFor(owner, pending, { description: "Extra work", amount: "10", taxTreatment: CAPITAL });
      assert.strictEqual(pr.direct.allowed, false);
      assert.strictEqual(pr.direct.code, "BOOKING_NOT_CHARGEABLE");
    });

    /* ------------------------- preview and tax ---------------------------- */
    await check("preview: the booking's own customer, address and card; taxable work taxed by Stripe Tax; integer cents", async () => {
      const p = await previewFor(owner, aliceJob, { description: "Replace two outlets", amount: "123.45", taxTreatment: TAXABLE });
      assert.strictEqual(p.customer.name, "Alice Able");
      assert.strictEqual(p.serviceAddress.full, "10 Shared Ln, Huntington, NY 11743");
      assert.deepStrictEqual({ brand: p.card.brand, last4: p.card.last4 }, { brand: "visa", last4: "1111" });
      assert.strictEqual(p.subtotalCents, 12345);
      assert.strictEqual(p.taxCents, Math.round((12345 * 8.625) / 100));
      assert.strictEqual(p.totalCents, 12345 + p.taxCents);
      assert.strictEqual(p.tax.source, "stripe_tax");
      assert.strictEqual(p.tax.taxCode, "txcd_99999999", "the configured code is sent, never an account default");
      assert.ok(p.direct.allowed && p.link.allowed);
      assert.ok(p.consentStatement.includes(`$${(p.totalCents / 100).toFixed(2)}`));
      assert.ok(!JSON.stringify(p).includes("pm_alice") && !JSON.stringify(p).includes("cus_alice"), "no Stripe ids reach the browser");
    });

    await check("tax: no-tax classifications are $0, 'Not Determined' and a Stripe answer of no tax are blockers, never a silent $0", async () => {
      const cap = await previewFor(owner, aliceJob, { description: "New deck stairs", amount: "200", taxTreatment: CAPITAL });
      assert.strictEqual(cap.taxCents, 0);
      assert.strictEqual(cap.tax.source, "owner_treatment");
      const none = await previewFor(owner, aliceJob, { description: "Something", amount: "200" });
      assert.strictEqual(none.tax.ok, false);
      assert.strictEqual(none.tax.code, "TAX_TREATMENT_REQUIRED");
      assert.strictEqual(none.totalCents, null);
      assert.strictEqual(none.direct.allowed, false);
      assert.strictEqual(none.link.allowed, false);
      F.taxReason = "not_collecting";
      const nc = await previewFor(owner, aliceJob, { description: "Fix faucet", amount: "200", taxTreatment: TAXABLE });
      F.taxReason = "standard_rated";
      assert.strictEqual(nc.tax.code, "TAX_NOT_COLLECTED");
      assert.ok(/not collecting/i.test(nc.tax.message));
      assert.strictEqual(nc.direct.allowed, false);
      const guestNoAddr = await makeBooking(null, { adminGuest: true, address: "", city: "", zip: "" });
      const ga = await previewFor(owner, guestNoAddr, { description: "Fix faucet", amount: "200", taxTreatment: TAXABLE });
      assert.strictEqual(ga.tax.code, "TAX_ADDRESS_MISSING");
      const bad = await call("POST", `/api/admin/jobs/${aliceJob._id}/extra-charges/preview`, owner, { description: "x y z", amount: "12.345", taxTreatment: CAPITAL });
      assert.strictEqual(bad.status, 400);
      assert.strictEqual(bad.body.code, "INVALID_AMOUNT");
      assert.strictEqual(extras.readAmountCents({ amount: "0.29" }), 29);
      assert.strictEqual(extras.readAmountCents({ amount: "1,234.5" }), 123450);
    });

    /* ---------------------------- the charge ------------------------------ */
    let aliceCharge;
    await check("success: charges Alice's own Stripe customer and card, records consent, Stripe receipt only, booking untouched", async () => {
      const before = (await Booking.findById(aliceJob._id).lean());
      const entBefore = await VisitEntitlement.countDocuments();
      const emailsBefore = sentEmails.length;
      const { preview: p, res } = await charge(owner, aliceJob, { description: "Replace two outlets", amount: "123.45", taxTreatment: TAXABLE, writtenApprovalRef: "Text from customer 2:14pm" });
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
      assert.strictEqual(rec.consent.totalCents, p.totalCents);
      assert.strictEqual(rec.consent.writtenApprovalRef, "Text from customer 2:14pm");
      assert.ok(rec.consent.confirmedAt);
      const pi = F.pis.get(rec.paymentIntentId);
      assert.strictEqual(pi.customer, "cus_alice");
      assert.strictEqual(pi.payment_method, "pm_alice");
      assert.strictEqual(pi.amount, p.totalCents);
      assert.strictEqual(pi.receipt_email, "shared@example.test");
      assert.deepStrictEqual(
        { k: pi.metadata.productKind, a: pi.metadata.additionalChargeId, b: pi.metadata.bookingId, u: pi.metadata.userMongoId, t: pi.metadata.taxCents },
        { k: "additional_charge", a: c.id, b: String(aliceJob._id), u: String(alice._id), t: String(p.taxCents) }
      );
      assert.strictEqual(F.taxTx.filter((t) => t.reference === rec.number).length, 1, "tax recorded in Stripe Tax once");
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

    await check("consent: refused unless the owner confirms (never assumed), and refused when anything changed since review", async () => {
      const job = await makeBooking(alice);
      const input = { description: "Extra hour", amount: "80", taxTreatment: CAPITAL };
      const p = await previewFor(owner, job, input);
      const r = await call("POST", `/api/admin/jobs/${job._id}/extra-charges`, owner, { ...input, idempotencyKey: key(), previewFingerprint: p.fingerprint, expectedTotalCents: p.totalCents, method: "card" });
      assert.strictEqual(r.status, 428);
      assert.strictEqual(r.body.code, "CONFIRMATION_REQUIRED");
      const wrongTotal = await call("POST", `/api/admin/jobs/${job._id}/extra-charges`, owner, { ...input, idempotencyKey: key(), customerAgreed: true, previewFingerprint: p.fingerprint, expectedTotalCents: p.totalCents + 1, method: "card" });
      assert.strictEqual(wrongTotal.status, 409);
      assert.strictEqual(wrongTotal.body.code, "PREVIEW_CHANGED");
      assert.strictEqual(await AdditionalCharge.countDocuments({ booking: job._id }), 0);
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
      assert.strictEqual(s.line_items_param.length, 2, "subtotal and sales tax lines");
      const { session, pi } = completeSession(sessionId);
      assert.strictEqual(await sendEvent("checkout.session.completed", session, "evt_link_1"), 200);
      assert.strictEqual(await sendEvent("checkout.session.completed", session, "evt_link_1"), 200);
      assert.strictEqual(await sendEvent("payment_intent.succeeded", F.pis.get(pi.id), "evt_link_2"), 200);
      const rec = await AdditionalCharge.findById(authCharge.id).lean();
      assert.strictEqual(rec.status, "paid");
      assert.strictEqual(rec.paymentIntentId, pi.id);
      assert.strictEqual(rec.extraPayments.length, 0);
      assert.strictEqual(F.taxTx.filter((t) => t.reference === rec.number).length, 1);
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
      assert.strictEqual(F.taxTx.filter((t) => t.reference === after.number).length, 1);
      assert.strictEqual(after.extraPayments.length, 0);
    });

    await check("an intent naming this record but another amount or customer is never accepted as payment", async () => {
      const rec = await AdditionalCharge.findOne({ status: "awaiting_payment" }).lean();
      const forged = { id: "pi_forged", object: "payment_intent", amount: rec.totalCents - 1, currency: "usd", customer: "cus_bob", status: "succeeded", metadata: { productKind: "additional_charge", additionalChargeId: String(rec._id), bookingId: String(rec.booking), adminPaymentLinkId: "x" }, created: now() };
      await sendEvent("payment_intent.succeeded", forged);
      assert.strictEqual((await AdditionalCharge.findById(rec._id).lean()).status, "awaiting_payment");
    });

    await check("refunds made in Stripe: partial then full, status and Stripe Tax reversals follow, repeated events are harmless", async () => {
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
      const revs = F.reversals.filter((r) => r.original_transaction === rec.tax.transactionId);
      assert.deepStrictEqual(revs.map((r) => r.mode), ["partial", "full"]);
      assert.strictEqual(revs[0].flat_amount, -5000);
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

    await check("tax code not configured: taxable work is refused with TAX_CODE_NOT_CONFIGURED; exempt work still allowed", async () => {
      const saved = process.env.STRIPE_TAX_CODE_ADDITIONAL_WORK;
      delete process.env.STRIPE_TAX_CODE_ADDITIONAL_WORK;
      try {
        const calcs = F.calls.filter((c) => c[0] === "tax.calculations.create").length;
        const p = await previewFor(owner, aliceJob, { description: "Fix faucet", amount: "100", taxTreatment: TAXABLE });
        assert.strictEqual(p.tax.code, "TAX_CODE_NOT_CONFIGURED");
        assert.strictEqual(p.direct.allowed, false);
        assert.strictEqual(p.link.allowed, false);
        assert.strictEqual(F.calls.filter((c) => c[0] === "tax.calculations.create").length, calcs, "Stripe Tax not even asked with a guessed code");
        const ok = await previewFor(owner, aliceJob, { description: "New deck stairs", amount: "100", taxTreatment: CAPITAL });
        assert.strictEqual(ok.direct.allowed, true);
      } finally {
        process.env.STRIPE_TAX_CODE_ADDITIONAL_WORK = saved;
      }
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
      assert.ok(rec.tax.transactionId, "Stripe Tax recorded by the sweep path too");
      F.charges.get(rec.chargeId).amount_refunded = rec.totalCents; // refunded in Stripe, NO webhook
      await AdditionalCharge.updateOne({ _id: rec._id }, { $set: { lastStripeSyncAt: null } });
      await sweepRefunds();
      rec = await AdditionalCharge.findById(rec._id).lean();
      assert.strictEqual(rec.status, "refunded");
      assert.strictEqual(F.reversals.filter((x) => x.original_transaction === rec.tax.transactionId).length, 1);
      await sweepRefunds();
      assert.strictEqual(F.reversals.filter((x) => x.original_transaction === rec.tax.transactionId).length, 1, "a second sweep changes nothing");
    });

    await check("background sweep: a card cancel Stripe did not confirm is retried until it is canceled", async () => {
      const { chargeId, piId } = await authFailed("rec5", { cancelFails: true });
      assert.strictEqual(F.pis.get(piId).status, "requires_action");
      F.cancelFails.delete(piId);
      await sweepOpen({ now: new Date(Date.now() + 5 * 60 * 1000) });
      assert.strictEqual(F.pis.get(piId).status, "canceled");
      assert.strictEqual((await AdditionalCharge.findById(chargeId).lean()).attempts[0].cancelPending, false);
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
      assert.ok(b.payments.every((p) => p.extraCharge && p.extraCharge.bookingNumber));
      assert.ok(b.additionalCharges.filter((a) => a.paidAt).every((a) => a.inPayments));
      const total = b.payments.reduce((s, p) => s + p.amountCents, 0);
      assert.strictEqual(total, recs.reduce((s, r) => s + r.totalCents, 0), "counted once");
    });

    await check("Overview revenue: an extra is its own kind and its sales tax is not counted as revenue", async () => {
      const row = classifyCharge({ id: "ch_x", amount: 13410, amount_refunded: 0, created: now(), payment_intent: { id: "pi_x", metadata: { productKind: "additional_charge", taxCents: "1065" } } });
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
