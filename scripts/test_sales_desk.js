/*
 * Telemarketer sales desk, end to end: commission rules, the ledger, Friday
 * payouts, the 20-membership bonus, attribution and credit requests, refunds
 * and disputes, role isolation, GoHighLevel sync, offboarding, and the
 * retirement of the old cold-call commission.
 *
 * Real routes (/api/sales, /api/admin/sales-desk, /api/admin/fixters, the
 * Stripe webhook with real signatures, the GHL webhook with real Ed25519
 * signatures), a real in-memory MongoDB replica set. Stripe, S3 and email are
 * faked: nothing leaves the machine, nobody is charged, nothing is sent.
 *
 *   node scripts/test_sales_desk.js
 */
const crypto = require("crypto");
const ghlKeys = crypto.generateKeyPairSync("ed25519");
Object.assign(process.env, {
  NODE_ENV: "test",
  JWT_SECRET: "test-secret-sales-desk",
  STRIPE_SECRET_KEY: "sk_test_fake_for_unit_tests",
  STRIPE_WEBHOOK_SECRET: "whsec_test_sales_desk",
  CLIENT_URL: "https://www.profixter.com",
  SMS_ENABLED: "false",
  S3_BUCKET: "test-bucket",
  AWS_REGION: "us-east-1",
  MAIL_ADMIN: "owner@example.test",
  GHL_LOCATION_ID: "LOCtest123",
  GHL_WEBHOOK_PUBLIC_KEY: ghlKeys.publicKey.export({ type: "spki", format: "pem" }),
});

const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Stripe = require("stripe");

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub("../utils/growth/checkoutRecovery", { async proposeCheckoutRecovery() {} });
const s3Objects = new Map();
stub("../utils/s3", {
  async putPrivateObject({ Key, Body, ContentType }) {
    s3Objects.set(Key, { Body, ContentType });
    return { Key };
  },
  async putPublicObject({ Key }) {
    return `https://test/${Key}`;
  },
  async getObjectBuffer({ Key }) {
    return s3Objects.get(Key).Body;
  },
  async deletePublicObjects() {
    return { deleted: 0 };
  },
});
const sentEmails = [];
const realMail = require("../utils/emailService");
stub("../utils/emailService", {
  ...realMail,
  async sendTx(templateKey, to) {
    sentEmails.push({ templateKey, to });
    return { messageId: "fake" };
  },
  async sendRaw({ to, subject }) {
    sentEmails.push({ to, subject });
    return { messageId: "fake" };
  },
});

const { MongoMemoryReplSet } = require("mongodb-memory-server");
const subsModule = require("../utils/subscriptionManagement");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const RepAttribution = require("../models/RepAttribution");
const S = require("../models/Sales");
const time = require("../utils/sales/time");
const rules = require("../utils/sales/rules");
const ledger = require("../utils/sales/ledger");
const credit = require("../utils/sales/credit");
const bonus = require("../utils/sales/bonus");
const salesStripe = require("../utils/sales/stripeEvents");
const views = require("../utils/sales/views");
const ghl = require("../utils/sales/ghl");
const { analyze } = require("./ops/legacy_rep_attribution_report");
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
    console.log(`FAIL  ${name}\n      ${String(error.stack || error.message).split("\n").slice(0, 5).join("\n      ")}`);
  }
}

/* ------------------------------ fake Stripe ------------------------------ */
const stripe = subsModule.stripe;
const T = (iso) => Math.floor(Date.parse(iso) / 1000);
const PRICES = {
  basic: { monthly: "price_1RUdq2Bw0RtvSZjMnnI6uRgn", annual: "price_1U3g22Bw0RtvSZjMRc5ecQP1" },
  plus: { monthly: "price_1RUds8Bw0RtvSZjMFS1BoQEU", annual: "price_1U3g4HBw0RtvSZjMQBVZnV3f" },
  premium: { monthly: "price_1RUdtWBw0RtvSZjMOo8Q1as9", annual: "price_1U3g6fBw0RtvSZjMx1XMpek2" },
  elite: { monthly: "price_1RUduRBw0RtvSZjMy6ySmgHk", annual: "price_1U3g7XBw0RtvSZjMRSHEhcqC" },
};
const fake = { subs: new Map(), invoices: [], charges: new Map(), pis: new Map() };
function listResult(items) {
  const promise = Promise.resolve({ object: "list", data: items, has_more: false });
  promise[Symbol.asyncIterator] = async function* it() {
    for (const i of items) yield i;
  };
  return promise;
}
function makeSub({ id, customer, user, plan = "basic", cycle = "monthly", created, metadata = {} }) {
  const addressId = String(user.addresses[0]._id);
  const sub = {
    id,
    object: "subscription",
    customer,
    status: "active",
    created: T(created),
    start_date: T(created),
    current_period_start: T(created),
    current_period_end: T(created) + (cycle === "annual" ? 365 : 30) * 86400,
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    latest_invoice: null,
    schedule: null,
    metadata: { addressId, userId: String(user.userId), plan, billingCycle: cycle, ...metadata },
    items: { data: [{ id: `si_${id}`, price: { id: PRICES[plan][cycle], unit_amount: 0, recurring: { interval: cycle === "annual" ? "year" : "month" } }, current_period_start: T(created), current_period_end: T(created) + 30 * 86400 }] },
  };
  fake.subs.set(id, sub);
  return sub;
}
stripe.subscriptions.retrieve = async (id) => {
  const s = fake.subs.get(id);
  if (!s) throw Object.assign(new Error(`No such subscription: ${id}`), { code: "resource_missing" });
  return JSON.parse(JSON.stringify(s));
};
stripe.subscriptions.list = (params = {}) => listResult([...fake.subs.values()].filter((s) => !params.customer || s.customer === params.customer).map((s) => JSON.parse(JSON.stringify(s))));
stripe.customers.retrieve = async (id) => ({ id, object: "customer", email: null, metadata: {} });
stripe.customers.list = async () => ({ data: [] });
stripe.invoices.list = async ({ subscription }) => ({ data: fake.invoices.filter((i) => i.subscription === subscription) });
stripe.charges.retrieve = async (id) => fake.charges.get(id);
stripe.paymentIntents.retrieve = async (id) => fake.pis.get(id) || { id, latest_charge: null };

let invSeq = 0;
/** An invoice for a membership: regular price, optional percent discount, NY tax 8.625% on the discounted amount. */
function invoice({ sub, reason = "subscription_create", plan = "basic", cycle = "monthly", paidAt, regular, percentOff = 0, amountOverride = null, coupon = null }) {
  invSeq += 1;
  const base = regular ?? Math.round(subsModule.PLAN_CATALOG[plan][cycle].price * 100);
  const discount = Math.round((base * percentOff) / 100);
  const pre = amountOverride ?? base - discount;
  const tax = Math.round(pre * 0.08625);
  const chargeId = `ch_inv_${invSeq}`;
  const inv = {
    id: `in_${invSeq}`,
    object: "invoice",
    subscription: sub.id,
    customer: sub.customer,
    billing_reason: reason,
    status: "paid",
    amount_paid: pre + tax,
    subtotal: base,
    tax,
    charge: chargeId,
    payment_intent: `pi_inv_${invSeq}`,
    created: T(paidAt) - 5,
    status_transitions: { paid_at: T(paidAt) },
    discount: coupon ? { coupon: { id: coupon, name: coupon } } : null,
    total_discount_amounts: discount ? [{ amount: discount }] : [],
    lines: { data: [{ type: "subscription", subscription: sub.id, amount: base, amount_excluding_tax: base, discount_amounts: discount ? [{ amount: discount }] : [], price: { id: PRICES[plan][cycle], recurring: { interval: cycle === "annual" ? "year" : "month" } } }] },
  };
  fake.invoices.push(inv);
  fake.charges.set(chargeId, { id: chargeId, object: "charge", amount: pre + tax, amount_refunded: 0, invoice: inv.id, payment_intent: inv.payment_intent, created: T(paidAt), refunds: { data: [] } });
  return inv;
}

/* --------------------------------- app ----------------------------------- */
const app = express();
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), webhook);
app.post("/api/ghl/webhook", express.raw({ type: "*/*" }), ghl.receive);
app.use(express.json());
app.use("/api/sales", require("../routes/sales"));
app.use("/api/admin/sales-desk", require("../routes/adminSalesDesk"));
app.use("/api/admin/fixters", require("../routes/fixters"));
app.use("/api/admin", require("../routes/adminCustomerDirectory"));
app.use("/api/admin", require("../routes/adminExtraCharges"));
app.use("/api/admin", require("../routes/adminJobs"));
app.use("/api/ghl", require("../routes/ghl"));

let base;
const tokenFor = (u) => jwt.sign({ id: String(u._id), tv: Number(u.tokenVersion || 0) }, process.env.JWT_SECRET, { expiresIn: "10m" });
async function call(method, path, user, body, { token } = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(user || token ? { authorization: `Bearer ${token || tokenFor(user)}` } : {}) },
    body: body && method !== "GET" ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { text };
  }
  return { status: r.status, body: json, headers: r.headers };
}
let eventSeq = 0;
async function sendEvent(type, object, id = `evt_${++eventSeq}`) {
  const payload = JSON.stringify({ id, object: "event", type, data: { object }, created: Math.floor(Date.now() / 1000), livemode: false, api_version: "2024-06-20" });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const r = await fetch(`${base}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
  return r.status;
}
async function sendGhl(body, { sign = true, key = ghlKeys.privateKey } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = sign ? crypto.sign(null, raw, key).toString("base64") : "bad";
  const r = await fetch(`${base}/api/ghl/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-ghl-signature": sig }, body: raw });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/* -------------------------------- fixtures -------------------------------- */
let seq = 0;
async function customer(fields = {}) {
  seq += 1;
  return User.create({
    userId: String(81000000 + seq),
    name: fields.name || `Customer ${seq}`,
    email: `c${seq}@example.test`,
    phone: `+1631556${String(1000 + seq).slice(-4)}`,
    role: "customer",
    stripeCustomerId: fields.stripeCustomerId === undefined ? `cus_t${seq}` : fields.stripeCustomerId,
    addresses: [{ line1: `${seq} Main St`, city: fields.city || "Huntington", state: "NY", zip: "11743" }],
    ...fields,
  });
}
async function telemarketer(name, extra = {}) {
  seq += 1;
  return User.create({ userId: String(72000000 + seq), name, firstName: name.split(" ")[0], email: `${name.split(" ")[0].toLowerCase()}@staff.test`, role: "employee", employeePosition: "Telemarketer", isActive: true, ...extra });
}
const key = () => `k${crypto.randomUUID().replace(/-/g, "")}`;
const cents = (n) => Math.round(n * 100);

async function leadFor(owner, user, employee, { at = null } = {}) {
  const r = await call("POST", "/api/admin/sales-desk/leads", owner, { name: user.name, userId: String(user._id), town: "Huntington" });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const leadId = r.body.lead.id;
  if (employee) {
    const a = await call("POST", `/api/admin/sales-desk/leads/${leadId}/assign`, owner, { employeeId: String(employee._id), reason: "Test assignment" });
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    if (at) await S.LeadAssignment.collection.updateOne({ lead: new mongoose.Types.ObjectId(leadId), endedAt: null }, { $set: { startedAt: at } });
  }
  return leadId;
}
/** Buy a membership through the real webhook (subscription + signed invoice.paid). */
async function buy(user, { plan = "basic", cycle = "monthly", paidAt, percentOff = 0, coupon = null, metadata = {}, created } = {}) {
  const sub = makeSub({ id: `sub_${++seq}`, customer: user.stripeCustomerId || `cus_other_${seq}`, user, plan, cycle, created: created || paidAt, metadata });
  const inv = invoice({ sub, plan, cycle, paidAt, percentOff, coupon });
  assert.strictEqual(await sendEvent("invoice.paid", inv), 200);
  return { sub, inv, sale: await S.SalesEvent.findOne({ sourceKey: `invoice:${inv.id}` }).lean() };
}
/** A verified sale written directly (for volume tests): the same functions the webhook uses. */
let directSeq = 0;
async function directSale(user, paidAt, { cycle = "monthly", plan = "basic", returning = false } = {}) {
  directSeq += 1;
  const { sale } = await credit.recordSale({
    sourceKey: `direct:${directSeq}`,
    kind: "membership_first_paid",
    user: user._id,
    identity: "stripe_customer",
    plan,
    cycle,
    stripe: { subscriptionId: `sub_direct_${directSeq}`, invoiceId: `in_direct_${directSeq}`, chargeId: `ch_direct_${directSeq}` },
    amounts: { regularCents: 14900, regularMonthlyCents: 14900, discountCents: 0, paidPreTaxCents: 14900, taxCents: 1285, amountCents: 16185 },
    returningCustomer: returning,
    paidAt,
    paidAtSource: "stripe_invoice",
  });
  return { sale, credit: await credit.creditForSale(sale) };
}
const entriesFor = (emp, extra = {}) => S.CommissionEntry.find({ employee: emp._id, ...extra }).sort({ earnedAt: 1 }).lean();

(async () => {
  const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri());
  for (const m of Object.values(S)) await m.init();
  await rules.ensureRules();
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  const owner = await User.create({ userId: "70000001", name: "Owner Person", email: "owner@example.test", role: "admin" });
  const general = await User.create({ userId: "70000002", name: "Gina General", email: "gf@example.test", role: "employee", employeePosition: "General Fixter" });
  const field = await User.create({ userId: "70000003", name: "Fred Field", email: "ff@example.test", role: "employee", employeePosition: "Fixter" });
  const ana = await telemarketer("Ana Caller");
  const ben = await telemarketer("Ben Dialer");

  /* ===================================================== pure rules */
  await check("pay week: Fri–Thu New York; Thu 23:59:40 and Fri 00:00:20 fall in different weeks; payday is the next Friday", async () => {
    const a = time.payWeekOf(new Date("2026-11-20T04:59:40Z")); // Thu Nov 19 23:59:40 EST
    const b = time.payWeekOf(new Date("2026-11-20T05:00:20Z")); // Fri Nov 20 00:00:20 EST
    assert.deepStrictEqual([a.week, a.lastDay, a.payday], ["2026-11-13", "2026-11-19", "2026-11-20"]);
    assert.deepStrictEqual([b.week, b.payday], ["2026-11-20", "2026-11-27"]);
  });
  await check("daylight saving: the November week is 169 h and the March week 167 h, both still Fri 00:00 New York", async () => {
    const nov = time.weekFromStart("2026-10-30");
    const mar = time.weekFromStart("2027-03-12");
    assert.strictEqual((nov.endsAt - nov.startsAt) / 36e5, 169);
    assert.strictEqual((mar.endsAt - mar.startsAt) / 36e5, 167);
    assert.strictEqual(time.payWeekOf(new Date("2026-11-06T04:59:59Z")).week, "2026-10-30"); // Thu Nov 5 23:59:59 EST
    assert.strictEqual(time.payWeekOf(new Date("2027-03-19T03:59:59Z")).week, "2027-03-12"); // Thu Mar 18 23:59:59 EDT
  });
  await check("bonus periods: calendar-month anniversaries of the ORIGINAL anchor, short months clamped, end-exclusive, no gaps", async () => {
    const p = [0, 1, 2, 3].map((i) => time.bonusPeriod("2027-01-31", i));
    assert.deepStrictEqual(p.map((x) => [x.firstDay, x.lastDay]), [["2027-01-31", "2027-02-27"], ["2027-02-28", "2027-03-30"], ["2027-03-31", "2027-04-29"], ["2027-04-30", "2027-05-30"]]);
    for (let i = 0; i < 3; i++) assert.strictEqual(p[i].endsAt.getTime(), p[i + 1].startsAt.getTime());
    assert.strictEqual(time.bonusPeriodIndexFor("2026-11-14", new Date("2026-12-14T04:59:50Z")), 0); // Sun Dec 13 23:59:50
    assert.strictEqual(time.bonusPeriodIndexFor("2026-11-14", new Date("2026-12-14T05:00:10Z")), 1); // Mon Dec 14 00:00:10
  });
  await check("annual commission = the catalog's monthly regular price: Basic $149, Plus $249, Premium $349, Elite $499", async () => {
    const rule = await rules.ruleAt("membership_annual");
    const got = ["basic", "plus", "premium", "elite"].map((plan) => rules.computeCommission({ kind: "membership_first_paid", cycle: "annual", plan, amounts: { paidPreTaxCents: 100 } }, rule).amountCents);
    assert.deepStrictEqual(got, [14900, 24900, 34900, 49900]);
    assert.deepStrictEqual(["basic", "plus", "premium", "elite"].map((p) => subsModule.PLAN_CATALOG[p].monthly.price), [149, 249, 349, 499]);
    assert.strictEqual(rules.computeCommission({ kind: "membership_first_paid", cycle: "annual", plan: "basic", amounts: { paidPreTaxCents: 0 } }, rule).amountCents, 0, "a free annual earns nothing");
  });

  /* ======================================== webhook: monthly with discount */
  const c1 = await customer({ name: "Jane Doe", city: "Smithtown" });
  const lead1 = await leadFor(owner, c1, ana, { at: new Date("2026-10-02T15:00:00Z") });
  let sale1;
  await check("monthly Basic with the 20% welcome offer: 50% of $119.20 paid excluding tax = $59.60, every part shown", async () => {
    const r = await buy(c1, { paidAt: "2026-10-26T15:05:00Z", percentOff: 20, metadata: { welcomeOffer: "first_month_20" } });
    sale1 = r.sale;
    assert.ok(sale1, "sale recorded");
    assert.strictEqual(sale1.identity, "stripe_customer");
    const [e] = await entriesFor(ana);
    assert.strictEqual(e.amountCents, 5960);
    assert.deepStrictEqual([e.calc.regularCents, e.calc.discountCents, e.calc.paidPreTaxCents], [14900, 2980, 11920]);
    assert.strictEqual(e.calc.taxCents, Math.round(11920 * 0.08625), "tax recorded, never commissioned");
    assert.match(e.calc.discountSource, /Welcome offer/);
    assert.match(e.calc.explain, /50% of \$119\.20/);
    assert.deepStrictEqual([e.calc.rule.key, e.calc.rule.version], ["membership_monthly", 1]);
    assert.strictEqual(e.earnedWeek, "2026-10-23");
    assert.strictEqual(e.paidAt.toISOString(), "2026-10-26T15:05:00.000Z", "Stripe's payment time, not arrival");
  });
  await check("duplicate and replayed webhooks: one sale, one entry", async () => {
    const inv = fake.invoices.find((i) => `invoice:${i.id}` === sale1.sourceKey);
    assert.strictEqual(await sendEvent("invoice.paid", inv, "evt_dupe_1"), 200);
    assert.strictEqual(await sendEvent("invoice.paid", inv, "evt_dupe_1"), 200);
    assert.strictEqual(await sendEvent("invoice.paid", inv, "evt_dupe_2"), 200);
    assert.strictEqual(await S.SalesEvent.countDocuments({ "stripe.invoiceId": inv.id }), 1);
    assert.strictEqual((await entriesFor(ana)).length, 1);
  });
  await check("a renewal (subscription_cycle) earns nothing and records nothing", async () => {
    const sub = fake.subs.get(sale1.stripe.subscriptionId);
    const renewal = invoice({ sub, reason: "subscription_cycle", paidAt: "2026-11-25T15:05:00Z" });
    assert.strictEqual(await sendEvent("invoice.paid", renewal), 200);
    assert.strictEqual(await S.SalesEvent.countDocuments({ "stripe.invoiceId": renewal.id }), 0);
    assert.strictEqual((await entriesFor(ana)).length, 1);
  });
  await check("annual Plus bought at 20% off still earns one month's regular Plus price, $249", async () => {
    const c = await customer({ name: "Ann Nual" });
    await leadFor(owner, c, ana, { at: new Date("2026-10-01T12:00:00Z") });
    await buy(c, { plan: "plus", cycle: "annual", paidAt: "2026-10-27T16:00:00Z", percentOff: 20 });
    const e = (await entriesFor(ana)).find((x) => String(x.user) === String(c._id));
    assert.strictEqual(e.amountCents, 24900);
    assert.strictEqual(e.product, "membership_annual");
    assert.strictEqual(e.calc.paidPreTaxCents, 199200);
  });
  await check("a $0 first invoice (gift trial / 100% code) is not a paid sale: no event, no commission", async () => {
    const c = await customer();
    await leadFor(owner, c, ana, { at: new Date("2026-10-01T12:00:00Z") });
    const sub = makeSub({ id: `sub_zero_${++seq}`, customer: c.stripeCustomerId, user: c, created: "2026-10-27T10:00:00Z" });
    const inv = invoice({ sub, paidAt: "2026-10-27T10:00:00Z", percentOff: 100 });
    inv.amount_paid = 0;
    assert.strictEqual(await sendEvent("invoice.paid", inv), 200);
    assert.strictEqual(await S.SalesEvent.countDocuments({ "stripe.invoiceId": inv.id }), 0);
  });

  /* ================================================ Full Day */
  await check("a separately paid Full Day earns $100; an included (membership or loyalty) day earns nothing", async () => {
    const c = await customer({ name: "Full Dee" });
    await leadFor(owner, c, ana, { at: new Date("2026-10-01T12:00:00Z") });
    fake.pis.set("pi_fd_1", { id: "pi_fd_1", latest_charge: { id: "ch_fd_1", created: T("2026-10-28T14:00:00Z") } });
    const session = { id: "cs_fd_1", payment_status: "paid", payment_intent: "pi_fd_1", customer: c.stripeCustomerId, amount_subtotal: 49900, amount_total: 54204, total_details: { amount_discount: 0, amount_tax: 4304 }, metadata: { userMongoId: String(c._id) }, created: T("2026-10-28T13:59:00Z") };
    await salesStripe.onFullDayPaid({ session, booking: null, entitlement: { _id: new mongoose.Types.ObjectId(), source: "purchase" }, user: c, stripe });
    await salesStripe.onFullDayPaid({ session: { ...session, id: "cs_fd_2", payment_intent: "pi_fd_2" }, booking: null, entitlement: { _id: new mongoose.Types.ObjectId(), source: "membership_benefit" }, user: c, stripe });
    await salesStripe.onFullDayPaid({ session: { ...session, id: "cs_fd_3", payment_intent: "pi_fd_3", payment_status: "unpaid" }, booking: null, entitlement: { _id: new mongoose.Types.ObjectId(), source: "purchase" }, user: c, stripe });
    const e = (await entriesFor(ana)).filter((x) => x.product === "full_day");
    assert.strictEqual(e.length, 1);
    assert.strictEqual(e[0].amountCents, 10000);
    assert.strictEqual(e[0].countsForBonus, false, "a Full Day never counts toward the membership bonus");
    assert.strictEqual(e[0].paidAt.toISOString(), "2026-10-28T14:00:00.000Z");
    const w = await S.CommissionEntry.findOne({ sourceKey: e[0].sourceKey }).lean();
    assert.strictEqual(w.statementWeek, "2026-10-23");
  });

  /* ================================== attribution: identity, conflicts, owner */
  await check("a payment tied to the account only by email (no verified Stripe link) is HELD, never credited automatically", async () => {
    const c = await customer({ name: "Emma Il", stripeCustomerId: null });
    await leadFor(owner, c, ana, { at: new Date("2026-10-01T12:00:00Z") });
    const sale = await credit.recordSale({ sourceKey: "unverified:1", kind: "membership_first_paid", user: c._id, identity: "unverified", plan: "basic", cycle: "monthly", stripe: { subscriptionId: "sub_unv_1" }, amounts: { regularCents: 14900, paidPreTaxCents: 14900 }, paidAt: new Date("2026-10-28T12:00:00Z"), paidAtSource: "stripe_invoice" });
    const cr = await credit.creditForSale(sale.sale);
    assert.strictEqual(cr.status, "held");
    assert.ok(cr.holdReasons.includes("identity_unverified"));
    assert.strictEqual(await S.CommissionEntry.countDocuments({ sale: sale.sale._id }), 0);
  });

  let holdReviewId;
  await check("competing claims (Ana's assignment vs Ben's referral link): held for review, shown to Ana as pending, not as earnings", async () => {
    const code = (await call("GET", "/api/sales/me", ben)).body.referral.code;
    const c = await customer({ name: "Kara Claim", attribution: { refSource: "referral", refCode: code } });
    await require("../utils/sales/leads").recordReferralSignup(c);
    await leadFor(owner, c, ana, { at: new Date("2026-10-01T12:00:00Z") });
    const before = (await call("GET", "/api/sales/earnings", ana)).body.earnings.earnedCents;
    await buy(c, { paidAt: "2026-10-28T18:00:00Z" });
    const cr = await S.SalesCredit.findOne({ user: c._id }).lean();
    assert.strictEqual(cr.status, "held");
    assert.ok(cr.holdReasons.includes("competing_claims"));
    const earn = (await call("GET", "/api/sales/earnings", ana)).body.earnings;
    assert.strictEqual(earn.earnedCents, before, "pending is never earnings");
    assert.ok(earn.claims.some((x) => x.type === "held_credit" && x.proposedCents === 7450));
    const reviews = (await call("GET", "/api/admin/sales-desk/reviews", owner)).body.reviews;
    holdReviewId = reviews.find((r) => r.kind === "credit_hold" && (r.effects.holdReasons || []).includes("competing_claims")).id;
    const names = reviews.find((r) => r.id === holdReviewId).effects.claimants.map((x) => x.name).sort();
    assert.deepStrictEqual(names, ["Ana Caller", "Ben Dialer"]);
  });
  await check("the owner resolves the conflict with a reason; the credit goes to one person, once", async () => {
    assert.strictEqual((await call("POST", `/api/admin/sales-desk/reviews/${holdReviewId}/resolve`, owner, { decision: "credit", employeeId: String(ana._id) })).status, 400, "reason required");
    const r = await call("POST", `/api/admin/sales-desk/reviews/${holdReviewId}/resolve`, owner, { decision: "credit", employeeId: String(ana._id), reason: "Ana worked the lead for two weeks before Ben's text" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const again = await call("POST", `/api/admin/sales-desk/reviews/${holdReviewId}/resolve`, owner, { decision: "credit", employeeId: String(ben._id), reason: "x" });
    assert.strictEqual(again.status, 409);
    const e = await S.CommissionEntry.findById(r.body.entryId).lean();
    assert.strictEqual(String(e.employee), String(ana._id));
    assert.strictEqual(await S.CommissionEntry.countDocuments({ sale: e.sale }), 1);
  });
  await check("owner-assisted sale (the owner took the payment by phone): credit stays with the assigned employee", async () => {
    const c = await customer({ name: "Owen Assist" });
    await leadFor(owner, c, ana, { at: new Date("2026-10-01T12:00:00Z") });
    await buy(c, { paidAt: "2026-10-28T19:00:00Z", metadata: { adminInitiated: "phone", adminUserId: String(owner._id) } });
    const cr = await S.SalesCredit.findOne({ user: c._id }).lean();
    assert.strictEqual(cr.status, "credited");
    assert.strictEqual(String(cr.employee), String(ana._id));
    assert.strictEqual(cr.ownerAssisted, true);
  });
  await check("no assignment and no claim: unattributed, no commission (organic customer)", async () => {
    const c = await customer({ name: "Organic Ollie" });
    await buy(c, { paidAt: "2026-10-28T20:00:00Z" });
    const cr = await S.SalesCredit.findOne({ user: c._id }).lean();
    assert.deepStrictEqual([cr.status, cr.reason], ["none", "unattributed"]);
  });

  /* ================================================= reassignment */
  await check("reassignment requires the manager to choose who keeps credit, records it, and the sale follows that choice", async () => {
    const c = await customer({ name: "Rea Sign" });
    const leadId = await leadFor(owner, c, ana, { at: new Date("2026-10-02T12:00:00Z") });
    const noChoice = await call("POST", `/api/admin/sales-desk/leads/${leadId}/assign`, owner, { employeeId: String(ben._id), reason: "Ana on leave" });
    assert.strictEqual(noChoice.status, 409);
    assert.strictEqual(noChoice.body.code, "CREDIT_DECISION_REQUIRED");
    assert.strictEqual(noChoice.body.currentCreditHolder.name, "Ana Caller");
    const keep = await call("POST", `/api/admin/sales-desk/leads/${leadId}/assign`, owner, { employeeId: String(ben._id), reason: "Ana on leave", creditDecision: "keep_previous" });
    assert.strictEqual(keep.status, 200, JSON.stringify(keep.body));
    await S.LeadAssignment.collection.updateOne({ lead: new mongoose.Types.ObjectId(leadId), endedAt: null }, { $set: { startedAt: new Date("2026-10-20T12:00:00Z") } });
    await buy(c, { plan: "plus", cycle: "annual", paidAt: "2026-10-28T21:00:00Z" });
    const cr = await S.SalesCredit.findOne({ user: c._id }).lean();
    assert.strictEqual(String(cr.employee), String(ana._id), "credit kept with Ana as the manager chose");
    const tl = (await call("GET", `/api/admin/sales-desk/leads/${leadId}`, owner)).body.lead;
    assert.ok(tl.assignments.some((a) => a.creditDecision === "keep_previous" && a.creditEmployee === "Ana Caller"));
    assert.ok(tl.timeline.some((t) => /Sales credit: stays with Ana Caller/.test(t.text)));
    // Ana no longer sees the lead (old link): 404. Ben sees it, with credit "another employee".
    assert.strictEqual((await call("GET", `/api/sales/leads/${leadId}`, ana)).status, 404);
    const benView = await call("GET", `/api/sales/leads/${leadId}`, ben);
    assert.match(benView.body.lead.salesCredit, /another employee/);
  });

  /* ======================================== returning customer: request credit */
  let reqId;
  let recoveryUser;
  let recoveryLead;
  await check("a returning customer is not credited automatically: the employee requests credit with evidence", async () => {
    recoveryUser = await customer({ name: "Ret Urner" });
    await Subscription.create({ user: recoveryUser._id, userId: recoveryUser.userId, subscriptionType: "basic", billingCycle: "monthly", status: "canceled", addressId: recoveryUser.addresses[0]._id, stripeSubscriptionId: "sub_old_returning", startDate: new Date("2026-03-01"), latestPaymentDate: new Date("2026-07-01"), nextPaymentDate: new Date("2026-08-01"), cancellationDate: new Date("2026-08-01") });
    recoveryLead = await leadFor(owner, recoveryUser, ana, { at: new Date("2026-10-03T12:00:00Z") });
    const { sale } = await buy(recoveryUser, { paidAt: "2026-10-29T15:00:00Z" });
    const cr = await S.SalesCredit.findOne({ sale: sale._id }).lean();
    assert.deepStrictEqual([cr.status, cr.reason], ["none", "returning_customer"]);
    const detail = (await call("GET", `/api/sales/leads/${recoveryLead}`, ana)).body.lead;
    const s = detail.sales.find((x) => x.id === String(sale._id));
    assert.strictEqual(s.status, "returning_customer");
    assert.strictEqual(s.claimable, true);
    const r = await call("POST", "/api/sales/credit-requests", ana, { leadId: recoveryLead, saleId: String(sale._id), kind: "recovery", explanation: "Called three times; she rejoined after our call on Oct 12.", ghlReferences: ["GHL call 2026-11-12 14:03, 6 min"] });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    reqId = r.body.request.id;
    assert.strictEqual(r.body.request.proposed.amountCents, 7450);
    // evidence file: a real PNG is accepted, a fake one refused
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "call-log.png");
    const up = await fetch(`${base}/api/sales/credit-requests/${reqId}/evidence`, { method: "POST", headers: { authorization: `Bearer ${tokenFor(ana)}` }, body: form });
    assert.strictEqual(up.status, 201);
    const bad = new FormData();
    bad.append("file", new Blob([Buffer.from("<html>not a png</html>")], { type: "image/png" }), "x.png");
    assert.strictEqual((await fetch(`${base}/api/sales/credit-requests/${reqId}/evidence`, { method: "POST", headers: { authorization: `Bearer ${tokenFor(ana)}` }, body: bad })).status, 400);
    const dup = await call("POST", "/api/sales/credit-requests", ben, { leadId: recoveryLead, saleId: String(sale._id), kind: "recovery", explanation: "I also called her once." });
    assert.strictEqual(dup.status, 404, "Ben does not hold the lead");
  });
  await check("the owner sees membership history, previous commissions, the verified payment, evidence and the proposal", async () => {
    const d = (await call("GET", `/api/admin/sales-desk/credit-requests/${reqId}`, owner)).body;
    assert.strictEqual(d.sale.identity, "stripe_customer");
    assert.strictEqual(d.membershipHistory.length >= 2, true);
    assert.ok(d.membershipHistory.some((m) => m.status === "canceled"));
    assert.strictEqual(d.request.proposed.amountCents, 7450);
    assert.strictEqual(d.request.evidence.filter((e) => e.kind === "file").length, 1);
    assert.match(d.bonusEffect, /counts this sale once/);
    // the file is served to the owner and to Ana, and to nobody else
    const fid = d.request.evidence.find((e) => e.kind === "file").id;
    const o = await fetch(`${base}/api/admin/sales-desk/credit-requests/${reqId}/files/${fid}`, { headers: { authorization: `Bearer ${tokenFor(owner)}` } });
    assert.strictEqual(o.status, 200);
    assert.strictEqual(o.headers.get("x-content-type-options"), "nosniff");
    assert.strictEqual((await fetch(`${base}/api/sales/credit-requests/${reqId}/files/${fid}`, { headers: { authorization: `Bearer ${tokenFor(ana)}` } })).status, 200);
    assert.strictEqual((await fetch(`${base}/api/sales/credit-requests/${reqId}/files/${fid}`, { headers: { authorization: `Bearer ${tokenFor(ben)}` } })).status, 404);
    assert.strictEqual((await fetch(`${base}/api/admin/sales-desk/credit-requests/${reqId}/files/${fid}`, { headers: { authorization: `Bearer ${tokenFor(general)}` } })).status, 403);
  });
  await check("request more information → employee replies → owner approves: an audited entry, once; the sale counts toward the bonus", async () => {
    assert.strictEqual((await call("POST", `/api/admin/sales-desk/credit-requests/${reqId}/decide`, owner, { action: "needs_info", reason: "Which call?" })).status, 200);
    assert.strictEqual((await call("POST", `/api/sales/credit-requests/${reqId}/reply`, ana, { reason: "The 14:03 call on Oct 12 in GHL." })).status, 200);
    const ok = await call("POST", `/api/admin/sales-desk/credit-requests/${reqId}/decide`, owner, { action: "approved", reason: "Confirmed in GHL" });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const e = await S.CommissionEntry.findById(ok.body.entryId).lean();
    assert.deepStrictEqual([e.amountCents, e.countsForBonus, String(e.employee)], [7450, true, String(ana._id)]);
    assert.match(e.calc.explain, /Approved credit request \(recovery\)/);
    assert.strictEqual(e.paidAt.toISOString(), "2026-10-29T15:00:00.000Z", "dated by the verified payment");
    assert.strictEqual((await call("POST", `/api/admin/sales-desk/credit-requests/${reqId}/decide`, owner, { action: "approved", reason: "again" })).status, 409);
    const log = await require("../models/AdminActivityLog").find({ action: "Sales Credit Request Decided" }).lean();
    assert.ok(log.length >= 2);
  });
  await check("a plan change is never a new sale: an upgrade request needs an explicit bonus choice from the owner", async () => {
    const sub = fake.subs.get((await S.SalesEvent.findOne({ user: recoveryUser._id, kind: "membership_first_paid" }).lean()).stripe.subscriptionId);
    const up = invoice({ sub, reason: "subscription_update", paidAt: "2026-10-29T16:00:00Z", regular: 10000 });
    assert.strictEqual(await sendEvent("invoice.paid", up), 200);
    const ev = await S.SalesEvent.findOne({ "stripe.invoiceId": up.id }).lean();
    assert.strictEqual(ev.kind, "membership_change_paid");
    assert.strictEqual((await S.SalesCredit.findOne({ sale: ev._id }).lean()).reason, "plan_change");
    const r = await call("POST", "/api/sales/credit-requests", ana, { leadId: recoveryLead, saleId: String(ev._id), kind: "upgrade", explanation: "I talked her into Plus on the Oct 29 call." });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.request.proposed.amountCents, 5000);
    assert.strictEqual(r.body.request.proposed.countsForBonusDefault, false);
    const noChoice = await call("POST", `/api/admin/sales-desk/credit-requests/${r.body.request.id}/decide`, owner, { action: "approved", reason: "ok" });
    assert.strictEqual(noChoice.body.code, "BONUS_CHOICE_REQUIRED");
    const ok = await call("POST", `/api/admin/sales-desk/credit-requests/${r.body.request.id}/decide`, owner, { action: "approved", reason: "ok", countsForBonus: false, amountCents: 4000 });
    const e = await S.CommissionEntry.findById(ok.body.entryId).lean();
    assert.deepStrictEqual([e.amountCents, e.countsForBonus], [4000, false]);
  });

  /* ============================================= refunds and disputes */
  await check("refund before payout: a review with its effects; nothing deducted until the owner records an adjustment", async () => {
    const charge = fake.charges.get(sale1.stripe.chargeId);
    charge.amount_refunded = 13000;
    charge.refunds = { data: [{ id: "re_1", amount: 13000, created: T("2026-10-28T10:00:00Z") }] };
    assert.strictEqual(await sendEvent("charge.refunded", charge), 200);
    assert.strictEqual(await sendEvent("charge.refunded", charge, "evt_refund_dupe"), 200);
    assert.strictEqual(await S.SalesEvent.countDocuments({ kind: "refund", relatesTo: sale1._id }), 1);
    const e = await S.CommissionEntry.findOne({ sale: sale1._id }).lean();
    assert.strictEqual(e.amountCents, 5960, "the commission is unchanged");
    const rv = (await call("GET", "/api/admin/sales-desk/reviews", owner)).body.reviews.find((r) => r.kind === "refund");
    assert.match(rv.effects.note, /Nothing is deducted automatically/);
    assert.strictEqual(rv.effects.commissions[0].amountCents, 5960);
    const adj = await call("POST", `/api/admin/sales-desk/reviews/${rv.id}/resolve`, owner, { action: "adjust", amountCents: -5960, employeeId: String(ana._id), reason: "Full refund in the first week" });
    assert.strictEqual(adj.status, 200, JSON.stringify(adj.body));
    const a = await S.CommissionEntry.findById(adj.body.entryId).lean();
    assert.deepStrictEqual([a.kind, a.amountCents], ["adjustment", -5960]);
  });

  /* ======================================================= payouts */
  let frozen;
  await check("payday: the week Fri 10/23 – Thu 10/29 is approved and frozen; its lines total the entries", async () => {
    const pre = (await call("GET", "/api/admin/sales-desk/payouts/2026-10-23", owner)).body.payout;
    assert.strictEqual(pre.status, "ready");
    const line = pre.lines.find((l) => l.employeeName === "Ana Caller");
    const entries = await S.CommissionEntry.find({ employee: ana._id, statementWeek: "2026-10-23" }).lean();
    assert.strictEqual(line.totalCents, entries.reduce((s, e) => s + e.amountCents, 0));
    const ok = await call("POST", "/api/admin/sales-desk/payouts/2026-10-23/approve", owner, {});
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual((await call("POST", "/api/admin/sales-desk/payouts/2026-10-23/approve", owner, {})).status, 409);
    frozen = JSON.stringify((await S.PayoutBatch.findOne({ week: "2026-10-23" }).lean()).lines);
    const future = time.payWeekOf(new Date(Date.now() + 7 * 86400000)).week;
    assert.strictEqual((await call("POST", `/api/admin/sales-desk/payouts/${future}/approve`, owner, {})).body.code, "WEEK_NOT_FINISHED");
  });
  await check("a late approval for a frozen week lands on the next open statement as a late line; the frozen statement never changes", async () => {
    const c = await customer({ name: "Late Lou" });
    await leadFor(owner, c, ana, { at: new Date("2026-10-01T12:00:00Z") });
    const sale = await credit.recordSale({ sourceKey: "late:1", kind: "membership_first_paid", user: c._id, identity: "unverified", plan: "basic", cycle: "monthly", stripe: { subscriptionId: "sub_late_1" }, amounts: { regularCents: 14900, paidPreTaxCents: 14900 }, paidAt: new Date("2026-10-29T22:00:00Z"), paidAtSource: "stripe_invoice" });
    await credit.creditForSale(sale.sale);
    const rv = await S.SalesReview.findOne({ sale: sale.sale._id }).lean();
    const r = await call("POST", `/api/admin/sales-desk/reviews/${rv._id}/resolve`, owner, { decision: "credit", employeeId: String(ana._id), reason: "Verified by phone with the customer" });
    const e = await S.CommissionEntry.findById(r.body.entryId).lean();
    assert.deepStrictEqual([e.earnedWeek, e.statementWeek, e.late], ["2026-10-23", "2026-10-30", true]);
    assert.strictEqual(JSON.stringify((await S.PayoutBatch.findOne({ week: "2026-10-23" }).lean()).lines), frozen);
  });
  await check("manual payment record: once, then the employee sees 'paid'; refund after payout opens a review and changes no paid line", async () => {
    const r = await call("POST", `/api/admin/sales-desk/payouts/2026-10-23/lines/${ana._id}/paid`, owner, { paidOn: "2026-10-30", method: "payroll", reference: "PR-1120" });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await call("POST", `/api/admin/sales-desk/payouts/2026-10-23/lines/${ana._id}/paid`, owner, { paidOn: "2026-10-30", method: "payroll" })).status, 409);
    const st = (await call("GET", "/api/sales/statements", ana)).body.statements.find((s) => s.week === "2026-10-23");
    assert.deepStrictEqual([st.status, st.paidOn], ["paid", "2026-10-30"]);
    const annualEntry = (await entriesFor(ana)).find((x) => x.product === "membership_annual" && x.statementWeek === "2026-10-23");
    const sale = await S.SalesEvent.findById(annualEntry.sale).lean();
    const charge = fake.charges.get(sale.stripe.chargeId);
    charge.refunds = { data: [{ id: "re_after", amount: 50000, created: T("2026-11-04T10:00:00Z") }] };
    assert.strictEqual(await sendEvent("charge.refunded", charge), 200);
    assert.strictEqual((await S.CommissionEntry.findById(annualEntry._id).lean()).status, "paid");
    assert.strictEqual(JSON.stringify((await S.PayoutBatch.findOne({ week: "2026-10-23" }).lean()).lines.map((l) => [l.totalCents, l.entries])), JSON.stringify(JSON.parse(frozen).map((l) => [l.totalCents, l.entries])));
    const rv = (await call("GET", "/api/admin/sales-desk/reviews", owner)).body.reviews.find((x) => x.kind === "refund" && x.effects.commissions?.[0]?.status === "paid");
    assert.ok(rv, "the refund on a paid sale is up for review");
    assert.strictEqual((await call("POST", `/api/admin/sales-desk/reviews/${rv.id}/resolve`, owner, { action: "no_change", reason: "Partial refund for a scheduling issue; commission stands" })).status, 200);
  });
  await check("chargebacks: opened and closed each create a review; nothing is deducted", async () => {
    const sale = await S.SalesEvent.findOne({ user: (await User.findOne({ name: "Owen Assist" }))._id, kind: "membership_first_paid" }).lean();
    const d = { id: "dp_1", object: "dispute", charge: sale.stripe.chargeId, amount: 16185, status: "needs_response", created: T("2026-11-05T10:00:00Z") };
    assert.strictEqual(await sendEvent("charge.dispute.created", d), 200);
    assert.strictEqual(await sendEvent("charge.dispute.closed", { ...d, status: "lost" }), 200);
    assert.strictEqual(await S.SalesReview.countDocuments({ kind: "dispute" }), 2);
    assert.strictEqual(await S.CommissionEntry.countDocuments({ sale: sale._id, amountCents: { $lt: 0 } }), 0);
  });
  await check("the payroll CSV needs an approved week and holds no customer data", async () => {
    const r = await fetch(`${base}/api/admin/sales-desk/payouts/2026-10-23/csv`, { headers: { authorization: `Bearer ${tokenFor(owner)}` } });
    const csv = await r.text();
    assert.strictEqual(r.status, 200);
    assert.match(csv, /^week_start,week_end,payday,employee/);
    assert.match(csv, /Ana Caller/);
    assert.doesNotMatch(csv, /Jane|Smithtown|@example/);
    const open = await fetch(`${base}/api/admin/sales-desk/payouts/2026-10-30/csv`, { headers: { authorization: `Bearer ${tokenFor(owner)}` } });
    assert.strictEqual(open.status, 409);
  });

  /* ============================================================ bonus */
  const cara = await telemarketer("Cara Volume");
  await check("20 / 40 / 60 qualifying sales in one bonus month: $500, $1,000, $1,500; Full Days and renewals do not count", async () => {
    const start = Date.now() - 3 * 86400000;
    for (let i = 0; i < 61; i++) {
      const c = await customer();
      await leadFor(owner, c, cara, { at: new Date(start - 86400000) });
      await directSale(c, new Date(start + i * 60000));
    }
    const bonuses = await entriesFor(cara, { kind: "bonus" });
    assert.deepStrictEqual(bonuses.map((b) => [b.amountCents, b.bonus.block, b.bonus.countedEntries.length]), [[50000, 1, 20], [50000, 2, 20], [50000, 3, 20]]);
    const p = await bonus.bonusProgress(cara._id);
    assert.deepStrictEqual([p.verifiedCount, p.inBlock, p.remaining, p.earnedThisPeriodCents], [61, 1, 19, 150000]);
    assert.strictEqual(p.period.number, 1);
    // calling again changes nothing
    await bonus.evaluateBonus(cara._id);
    assert.strictEqual((await entriesFor(cara, { kind: "bonus" })).length, 3);
  });
  await check("the employee's bonus figures and the manager's are the same numbers from the same function", async () => {
    const mine = (await call("GET", "/api/sales/bonus", cara)).body.bonus;
    const team = (await call("GET", "/api/admin/sales-desk/overview", owner)).body.rows.find((r) => r.employee.name === "Cara Volume").bonus;
    const detail = (await call("GET", `/api/admin/sales-desk/employees/${cara._id}`, owner)).body.bonus;
    const pick = (b) => JSON.stringify([b.verifiedCount, b.pendingCount, b.remaining, b.earnedThisPeriodCents, b.paidThisPeriodCents, b.period.firstDay, b.period.lastDay]);
    assert.strictEqual(pick(mine), pick(team));
    assert.strictEqual(pick(mine), pick(detail));
    const earn = (await call("GET", "/api/sales/earnings", cara)).body.earnings;
    const det = (await call("GET", `/api/admin/sales-desk/employees/${cara._id}`, owner)).body.earnings;
    assert.strictEqual(earn.earnedCents, det.earnedCents);
    assert.strictEqual(earn.earnedCents, 61 * 7450 + 150000);
  });
  await check("month-end: first sale on Jan 31 → periods 1/31, 2/28, 3/31; 20 sales across the boundary do not combine", async () => {
    const dee = await telemarketer("Dee Monthend");
    const anchorSale = new Date("2026-01-31T17:00:00Z");
    const c0 = await customer();
    await leadFor(owner, c0, dee, { at: new Date("2026-01-01T12:00:00Z") });
    await directSale(c0, anchorSale);
    for (let i = 0; i < 18; i++) {
      const c = await customer();
      await leadFor(owner, c, dee, { at: new Date("2026-01-01T12:00:00Z") });
      await directSale(c, new Date(Date.parse("2026-02-20T15:00:00Z") + i * 60000));
    }
    const c20 = await customer();
    await leadFor(owner, c20, dee, { at: new Date("2026-01-01T12:00:00Z") });
    await directSale(c20, new Date("2026-02-28T15:00:00Z")); // Feb 28 is period 2
    assert.strictEqual((await entriesFor(dee, { kind: "bonus" })).length, 0, "19 + 1 across the boundary is not 20");
    const periods = await S.BonusPeriod.find({ employee: dee._id }).sort({ index: 1 }).lean();
    assert.deepStrictEqual(periods.map((p) => time.nyDate(p.startsAt)), ["2026-01-31", "2026-02-28"]);
  });
  await check("a late-approved recovery counts in the bonus month of its payment date, and its bonus is a late line", async () => {
    const dee = await User.findOne({ name: "Dee Monthend" });
    const c = await customer();
    const leadId = await leadFor(owner, c, dee, { at: new Date("2026-01-01T12:00:00Z") });
    const { sale } = await directSale(c, new Date("2026-02-25T15:00:00Z"), { returning: true });
    const r = await call("POST", "/api/sales/credit-requests", dee, { leadId, saleId: String(sale._id), kind: "recovery", explanation: "Former member, won back on my calls in February." });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const ok = await call("POST", `/api/admin/sales-desk/credit-requests/${r.body.request.id}/decide`, owner, { action: "approved", reason: "Late paperwork, confirmed" });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const bonuses = await entriesFor(dee, { kind: "bonus" });
    assert.strictEqual(bonuses.length, 1, "20th qualifying sale in period 1");
    assert.strictEqual(bonuses[0].bonus.periodIndex, 0);
    assert.strictEqual(bonuses[0].earnedWeek, "2026-02-20", "the week of the 20th sale's payment");
  });
  await check("bonus progress before any sale: an invitation, not urgency; no fabricated numbers", async () => {
    const p = await bonus.bonusProgress(ben._id);
    assert.strictEqual(p.started, false);
    assert.match(p.message, /first verified membership sale starts/);
  });

  /* ================================================= role isolation */
  await check("only active Telemarketers reach /api/sales: owner, General Fixter, field Fixter and customers are refused", async () => {
    for (const who of [owner, general, field, await customer()]) assert.strictEqual((await call("GET", "/api/sales/me", who)).status, 403, who.name);
  });
  await check("a Telemarketer is refused every admin surface: sales desk, customers, cards, charges, jobs, employees", async () => {
    const c = await customer();
    for (const p of ["/api/admin/sales-desk/overview", "/api/admin/sales-desk/leads", `/api/admin/sales-desk/payouts/2026-10-23/csv`, `/api/admin/customers/${c._id}`, `/api/admin/customers/${c._id}/charges/target`, `/api/admin/customers/${c._id}/billing`, "/api/admin/jobs", "/api/admin/fixters"]) {
      const r = await call("GET", p, ana);
      assert.ok([401, 403, 404].includes(r.status) && r.status !== 200, `${p} -> ${r.status}`);
      assert.notStrictEqual(r.status, 200);
    }
    assert.notStrictEqual((await call("POST", `/api/admin/customers/${c._id}/charges`, ana, { amount: "10" })).status, 201);
  });
  await check("sections stored on a Telemarketer grant nothing (sealed role); General Fixter permissions never leak in", async () => {
    const sneaky = await telemarketer("Sam Sneaky", { adminSections: ["customers", "jobs", "members", "activity"] });
    const { permissionsForUser } = require("../middleware/authorize");
    assert.deepStrictEqual(permissionsForUser(sneaky), ["sales.own"]);
    assert.strictEqual((await call("GET", "/api/admin/customers/" + String((await customer())._id), sneaky)).status, 403);
    const created = await call("POST", "/api/admin/fixters", owner, { firstName: "Tia", lastName: "Tele", email: "tia@staff.test", employeePosition: "Telemarketer", adminSections: ["customers", "jobs"] });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const tia = await User.findOne({ email: "tia@staff.test", role: "employee" }).lean();
    assert.deepStrictEqual([tia.employeePosition, tia.adminSections], ["Telemarketer", []]);
  });
  await check("employees see only their own leads, tasks, requests, statements and earnings", async () => {
    const benLead = (await call("GET", "/api/sales/leads", ben)).body.leads[0];
    assert.ok(benLead);
    assert.strictEqual((await call("GET", `/api/sales/leads/${benLead.id}`, ana)).status, 404);
    assert.strictEqual((await call("POST", `/api/sales/leads/${benLead.id}/phone`, ana)).status, 404);
    assert.strictEqual((await call("GET", `/api/sales/credit-requests/${reqId}`, ben)).status, 404);
    const benEarn = (await call("GET", "/api/sales/earnings", ben)).body.earnings;
    assert.strictEqual(benEarn.earnedCents, 0, "Ana's money never shows on Ben's");
    const stCsv = await fetch(`${base}/api/sales/statements/2026-10-23/csv`, { headers: { authorization: `Bearer ${tokenFor(ben)}` } });
    assert.doesNotMatch(await stCsv.text(), /Jane|J\. D\./);
  });
  await check("lead detail is redacted: last 4 of the phone, town, no email, no card or billing; the full number is a logged reveal", async () => {
    const l = (await call("GET", "/api/sales/leads", ana)).body.leads.find((x) => x.linked);
    const d = (await call("GET", `/api/sales/leads/${l.id}`, ana)).body.lead;
    const json = JSON.stringify(d);
    assert.ok(d.phoneLast4 && !/\+1631/.test(json), "no full phone");
    assert.doesNotMatch(json, /@example\.test|stripeCustomerId|cus_|last4|card|Main St/);
    const reveal = await call("POST", `/api/sales/leads/${l.id}/phone`, ana);
    assert.match(reveal.body.phone, /^\+1/);
    assert.ok(await require("../models/AdminActivityLog").exists({ action: "Sales Phone Revealed" }));
  });

  /* =================================================== intake */
  await check("employee-added leads wait in the owner's intake queue; duplicates are refused without revealing whose", async () => {
    const r = await call("POST", "/api/sales/intake", ben, { name: "Nina Neighbor", phone: "631-555-7777", town: "Commack" });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.lead.status, "intake");
    const dup = await call("POST", "/api/sales/intake", ana, { name: "Nina N", phone: "(631) 555-7777" });
    assert.deepStrictEqual([dup.status, dup.body.code], [409, "DUPLICATE"]);
    assert.doesNotMatch(JSON.stringify(dup.body), /Ben/);
    assert.strictEqual((await call("GET", `/api/sales/leads/${r.body.lead.id}`, ben)).status, 404, "not workable before approval");
    const ok = await call("POST", `/api/admin/sales-desk/intake/${r.body.lead.id}/decide`, owner, { approve: true, reason: "Real referral" });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await call("GET", `/api/sales/leads/${r.body.lead.id}`, ben)).status, 200, "assigned to the person who added it");
  });
  await check("no unapproved bulk import: an employee can add at most 25 leads a day", async () => {
    const eve = await telemarketer("Eve Many");
    let last;
    for (let i = 0; i < 26; i++) last = await call("POST", "/api/sales/intake", eve, { name: `Person ${i}`, phone: `631-557-${String(1000 + i)}` });
    assert.strictEqual(last.status, 429);
    assert.strictEqual(await S.SalesLead.countDocuments({ createdBy: eve._id }), 25);
  });

  /* ==================================================== activity, tasks, DNC */
  await check("outcomes, follow-ups and do-not-contact: stage moves, a task is created, DNC cancels tasks and can only be lifted by the owner", async () => {
    const l = (await call("GET", "/api/sales/leads", ben)).body.leads[0];
    const a = await call("POST", `/api/sales/leads/${l.id}/activities`, ben, { kind: "reached_interested", body: "Wants a visit next week", followUpAt: new Date(Date.now() + 86400000).toISOString() });
    assert.strictEqual(a.status, 201, JSON.stringify(a.body));
    let d = (await call("GET", `/api/sales/leads/${l.id}`, ben)).body.lead;
    assert.strictEqual(d.stage, "interested");
    assert.strictEqual(d.tasks.length, 1);
    await call("POST", `/api/sales/leads/${l.id}/activities`, ben, { kind: "do_not_contact", body: "Asked not to be called", channel: "all" });
    d = (await call("GET", `/api/sales/leads/${l.id}`, ben)).body.lead;
    assert.deepStrictEqual([d.suppression.call, d.suppression.sms, d.tasks.length], [true, true, 0]);
    assert.strictEqual((await call("POST", "/api/admin/sales-desk/suppressions/lift", ben, { phone: "6315557777", channel: "all", reason: "x" })).status, 403);
    // coaching notes are owner-only
    await call("POST", `/api/admin/sales-desk/leads/${l.id}/notes`, owner, { kind: "coaching", body: "Slow down on the opening" });
    const tl = (await call("GET", `/api/sales/leads/${l.id}`, ben)).body.lead.timeline;
    assert.ok(!tl.some((t) => /Slow down/.test(t.text || "")));
  });

  /* ============================================================== GHL */
  await check("GHL sync is OFF by default (503), and refuses unsigned or forged deliveries", async () => {
    assert.strictEqual((await sendGhl({ type: "ContactDndUpdate", contactId: "x" })).status, 503);
    process.env.GHL_SALES_SYNC_ENABLED = "true";
    assert.strictEqual((await sendGhl({ type: "ContactDndUpdate", contactId: "x" }, { sign: false })).status, 401);
    const other = crypto.generateKeyPairSync("ed25519").privateKey;
    assert.strictEqual((await sendGhl({ type: "ContactDndUpdate", contactId: "x" }, { key: other })).status, 401);
  });
  await check("GHL: unmapped events are kept, then replayed when the contact is mapped; DND becomes a Profixter restriction; bodies are never stored", async () => {
    const l = (await call("GET", "/api/sales/leads", ana)).body.leads.find((x) => !x.doNotCall);
    const r1 = await sendGhl({ type: "OutboundMessage", webhookId: "wh_1", contactId: "GhlContact0001", messageType: "TYPE_CALL", callStatus: "completed", callDuration: 95, conversationId: "conv1", body: "secret words" });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual((await S.GhlWebhookEvent.findOne({ eventId: "wh_1" }).lean()).status, "unmapped");
    assert.strictEqual((await sendGhl({ type: "OutboundMessage", webhookId: "wh_1", contactId: "GhlContact0001" })).body.duplicate, true);
    const map = await call("PUT", `/api/sales/leads/${l.id}/ghl`, ana, { contact: "https://app.gohighlevel.com/v2/location/LOCtest123/contacts/detail/GhlContact0001" });
    assert.strictEqual(map.status, 200, JSON.stringify(map.body));
    assert.match(map.body.links.contact, /contacts\/detail\/GhlContact0001$/);
    const ev = await S.GhlWebhookEvent.findOne({ eventId: "wh_1" }).lean();
    assert.strictEqual(ev.status, "processed");
    assert.doesNotMatch(JSON.stringify(ev), /secret words/);
    const d = (await call("GET", `/api/sales/leads/${l.id}`, ana)).body.lead;
    assert.ok(d.timeline.some((t) => t.origin === "ghl" && /Outbound call \(completed\), 95s/.test(t.text)));
    await sendGhl({ type: "ContactDndUpdate", webhookId: "wh_2", contactId: "GhlContact0001", dnd: false, dndSettings: { SMS: { status: "active" } } });
    let s = (await call("GET", `/api/sales/leads/${l.id}`, ana)).body.lead.suppression;
    assert.deepStrictEqual([s.sms, s.call], [true, false]);
    await sendGhl({ type: "ContactDndUpdate", webhookId: "wh_3", contactId: "GhlContact0001", dnd: false, dndSettings: { SMS: { status: "inactive" } } });
    s = (await call("GET", `/api/sales/leads/${l.id}`, ana)).body.lead.suppression;
    assert.strictEqual(s.sms, true, "GHL turning DND off never lifts a Profixter restriction");
    await sendGhl({ type: "InboundMessage", webhookId: "wh_4", contactId: "GhlContact0001", messageType: "TYPE_SMS", body: " STOP " });
    assert.strictEqual(await S.ContactSuppression.countDocuments({ ghlEventId: "wh_4", channel: "sms" }), 1);
  });
  await check("GHL processing failures are visible and retried with backoff", async () => {
    const orig = S.SalesActivity.create;
    S.SalesActivity.create = async () => {
      throw new Error("database hiccup");
    };
    await sendGhl({ type: "OutboundMessage", webhookId: "wh_fail", contactId: "GhlContact0001", messageType: "TYPE_SMS", status: "delivered" });
    S.SalesActivity.create = orig;
    let ev = await S.GhlWebhookEvent.findOne({ eventId: "wh_fail" }).lean();
    assert.deepStrictEqual([ev.status, ev.attempts], ["failed", 1]);
    assert.ok(ev.nextAttemptAt > new Date());
    const st = (await call("GET", "/api/admin/sales-desk/ghl", owner)).body.ghl;
    assert.ok(st.failures.some((f) => f.eventId === "wh_fail" && /hiccup/.test(f.lastError)));
    assert.strictEqual(st.liveVerified, false, "never presented as live-verified");
    await S.GhlWebhookEvent.updateOne({ eventId: "wh_fail" }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
    assert.strictEqual(await ghl.retryFailed(), 1);
    ev = await S.GhlWebhookEvent.findOne({ eventId: "wh_fail" }).lean();
    assert.deepStrictEqual([ev.status, ev.attempts], ["processed", 2]);
    process.env.GHL_SALES_SYNC_ENABLED = "false";
  });

  /* ================================================ immutability */
  await check("money history is immutable: entries' amounts, sales events and rules cannot be edited or deleted", async () => {
    const e = await S.CommissionEntry.findOne({}).lean();
    await assert.rejects(S.CommissionEntry.updateOne({ _id: e._id }, { $set: { amountCents: 1 } }), /frozen/);
    await assert.rejects(S.CommissionEntry.deleteOne({ _id: e._id }), /cannot be deleted/);
    await assert.rejects(S.SalesEvent.updateOne({}, { $set: { "amounts.paidPreTaxCents": 1 } }), /append-only/);
    await assert.rejects(S.CommissionRule.updateOne({}, { $set: { params: {} } }), /append-only/);
    await assert.rejects(S.SalesActivity.deleteMany({}), /append-only/);
  });

  /* ================================================ offboarding */
  await check("disabling a Telemarketer ends every session now, keeps their records and earned money, and lists their leads for reassignment", async () => {
    const before = await call("GET", "/api/sales/me", ben);
    assert.strictEqual(before.status, 200);
    const oldToken = tokenFor(ben);
    const r = await call("PATCH", `/api/admin/fixters/${ben._id}/status`, owner, { isActive: false });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.sales.sessionsRevoked, true);
    assert.ok(r.body.sales.openLeads >= 1);
    const after = await call("GET", "/api/sales/me", null, null, { token: oldToken });
    assert.ok([401, 403].includes(after.status), String(after.status));
    const inactive = (await call("GET", "/api/admin/sales-desk/leads?view=inactive", owner)).body.leads;
    assert.ok(inactive.length >= 1);
    assert.strictEqual((await call("GET", "/api/admin/sales-desk/overview", owner)).body.queues.leadsWithInactiveEmployee >= 1, true);
    const del = await call("DELETE", `/api/admin/fixters/${ana._id}`, owner);
    assert.strictEqual(del.status, 409, "an employee with earnings history cannot be deleted");
  });

  /* ============================================ the old calculation */
  await check("the old /api/ghl/lead-assigned is retired (410) and writes nothing; checkouts no longer compute legacy commissions", async () => {
    const n = await RepAttribution.countDocuments();
    const r = await fetch(`${base}/api/ghl/lead-assigned`, { method: "POST", headers: { "content-type": "application/json", "x-ghl-secret": "anything" }, body: JSON.stringify({ phone: "6315550000", repName: "Old Rep" }) });
    assert.strictEqual(r.status, 410);
    assert.strictEqual(await RepAttribution.countDocuments(), n);
    const src = require("fs").readFileSync(require.resolve("../routes/webhook"), "utf8");
    assert.doesNotMatch(src, /await markLeadSubscribed\(/);
    assert.doesNotMatch(require("fs").readFileSync(require.resolve("../utils/auth/accounts"), "utf8"), /await markLeadRegistered\(/);
  });
  await check("legacy reconciliation report flags annual-at-50%, catalog pricing, email matching and paid-then-overwritten rows, read-only", async () => {
    const { summary, rows } = analyze([
      { _id: 1, repName: "Old Rep", status: "subscribed", subscriptionPlan: "basic", subscriptionBillingCycle: "annual", subscriptionValue: 1490, commissionAmount: 745, commissionStatus: "unpaid", emailNormalized: "a@b.c", phoneNormalized: "16315551234" },
      { _id: 2, repName: "Unknown Rep", status: "subscribed", subscriptionPlan: "plus", subscriptionBillingCycle: "monthly", subscriptionValue: 249, commissionAmount: 124.5, commissionStatus: "paid", commissionPaidAt: new Date("2026-05-01"), lastSyncedAt: new Date("2026-06-01") },
      { _id: 3, repName: "Old Rep", status: "active", commissionAmount: 0 },
    ]);
    assert.deepStrictEqual([summary.total, summary.withCommission, summary.paidCount], [3, 2, 1]);
    assert.deepStrictEqual([summary.flags.annual_at_50pct, summary.flags.paid_then_overwritten, summary.flags.email_match_possible, summary.flags.unknown_rep], [1, 1, 1, 1]);
    assert.strictEqual(rows[0].annualExpectedUnderCurrentRule, 149);
    assert.doesNotMatch(JSON.stringify(rows), /a@b\.c|16315551234/);
  });

  server.close();
  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
