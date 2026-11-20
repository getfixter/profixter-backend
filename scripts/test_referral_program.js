/*
 * Customer referral program, end to end: personal links (and the 2025 ?ref=
 * links), attribution at sign-up / claim / checkout, the reward from real
 * Stripe invoice shapes (Basic full price and with a promotion code, annual,
 * $0 first invoices), refunds and chargebacks, duplicate and replayed
 * webhooks, self-referral and household flags, and the owner's payout flow
 * (recheck, payee, approve, mailed) with its permissions.
 *
 * Real routes (/api/referrals, /api/admin/referral-rewards, the Stripe webhook
 * with real signatures, Needs action), a real in-memory MongoDB replica set.
 * Stripe and email are faked: nothing leaves the machine, nobody is charged.
 *
 *   node scripts/test_referral_program.js
 */
Object.assign(process.env, {
  NODE_ENV: "test",
  JWT_SECRET: "test-secret-referrals",
  STRIPE_SECRET_KEY: "sk_test_fake_for_unit_tests",
  STRIPE_WEBHOOK_SECRET: "whsec_test_referrals",
  CLIENT_URL: "https://www.profixter.com",
  SMS_ENABLED: "false",
  MAIL_ADMIN: "owner@example.test",
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
const sentEmails = [];
const realMail = require("../utils/emailService");
stub("../utils/emailService", {
  ...realMail,
  async sendTx(templateKey, to, vars) {
    sentEmails.push({ templateKey, to, vars, rendered: realMail.TEMPLATES?.[templateKey] ? realMail.TEMPLATES[templateKey](vars) : null });
    return { messageId: "fake" };
  },
  async sendRaw({ to, subject }) {
    sentEmails.push({ to, subject });
    return { messageId: "fake" };
  },
  async sendPromo(to, { subject, html }) {
    sentEmails.push({ to, subject, html, promo: true });
    return { messageId: "fake" };
  },
});

const { MongoMemoryReplSet } = require("mongodb-memory-server");
const subsModule = require("../utils/subscriptionManagement");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const S = require("../models/Sales");
const { ReferralCode, CustomerReferral } = require("../models/ReferralProgram");
const codes = require("../utils/referrals/codes");
const engine = require("../utils/referrals/engine");
const A = require("../utils/referrals/amounts");
const webhook = require("../routes/webhook");
const { collectNeedsAction } = require("../utils/needsAction");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(error.stack || error.message).split("\n").slice(0, 6).join("\n      ")}`);
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
const fake = { subs: new Map(), invoices: new Map(), charges: new Map(), cards: new Map(), sessions: [] };
const copy = (x) => JSON.parse(JSON.stringify(x));
function listResult(items) {
  const promise = Promise.resolve({ object: "list", data: items, has_more: false });
  promise[Symbol.asyncIterator] = async function* it() {
    for (const i of items) yield i;
  };
  return promise;
}
let seq = 0;
function makeSub({ user, plan = "basic", cycle = "monthly", created = "2026-11-20T15:00:00Z", metadata = {} }) {
  const id = `sub_${++seq}`;
  const sub = {
    id,
    object: "subscription",
    customer: user.stripeCustomerId,
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
    metadata: { addressId: String(user.addresses[0]._id), userId: String(user.userId), plan, billingCycle: cycle, ...metadata },
    items: { data: [{ id: `si_${id}`, price: { id: PRICES[plan][cycle], unit_amount: 0, recurring: { interval: cycle === "annual" ? "year" : "month" } }, current_period_start: T(created), current_period_end: T(created) + 30 * 86400 }] },
  };
  fake.subs.set(id, sub);
  return sub;
}
stripe.subscriptions.retrieve = async (id) => {
  const s = fake.subs.get(id);
  if (!s) throw Object.assign(new Error(`No such subscription: ${id}`), { code: "resource_missing" });
  return copy(s);
};
stripe.subscriptions.list = (params = {}) => listResult([...fake.subs.values()].filter((s) => !params.customer || s.customer === params.customer).map(copy));
stripe.customers.retrieve = async (id) => ({ id, object: "customer", email: null, metadata: {} });
stripe.customers.list = async () => ({ data: [] });
stripe.invoices.list = async ({ subscription }) => ({ data: [...fake.invoices.values()].filter((i) => i.subscription === subscription).map(copy) });
stripe.invoices.retrieve = async (id) => {
  const i = fake.invoices.get(id);
  if (!i) throw Object.assign(new Error(`No such invoice: ${id}`), { code: "resource_missing" });
  return copy(i);
};
stripe.charges.retrieve = async (id) => copy(fake.charges.get(id));
stripe.paymentIntents.retrieve = async (id) => ({ id, latest_charge: null });
stripe.paymentMethods.list = async ({ customer }) => ({ data: (fake.cards.get(customer) || []).map((fp) => ({ id: `pm_${fp}`, card: { fingerprint: fp } })) });
stripe.checkout.sessions.create = async (config) => {
  const s = { id: `cs_${++seq}`, url: `https://checkout.stripe.com/c/pay/cs_${seq}`, ...config };
  fake.sessions.push(s);
  return s;
};
stripe.checkout.sessions.list = async () => ({ data: [] });
stripe.checkout.sessions.retrieve = async (id) => ({ id, status: "expired" });
stripe.checkout.sessions.expire = async (id) => ({ id, status: "expired" });

let invSeq = 0;
/** A membership invoice: regular price, optional percent discount (a promotion code), NY tax 8.625%. */
function invoice({ sub, reason = "subscription_create", plan = "basic", cycle = "monthly", paidAt, percentOff = 0, promo = null, card = "fp_friend" }) {
  invSeq += 1;
  const base = Math.round(subsModule.PLAN_CATALOG[plan][cycle].price * 100);
  const discount = Math.round((base * percentOff) / 100);
  const pre = base - discount;
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
    discount: promo ? { coupon: { id: `co_${promo}`, name: promo, percent_off: percentOff }, promotion_code: { id: `promo_${promo}`, code: promo } } : null,
    total_discount_amounts: discount ? [{ amount: discount }] : [],
    lines: { data: [{ type: "subscription", subscription: sub.id, amount: base, amount_excluding_tax: base, discount_amounts: discount ? [{ amount: discount }] : [], price: { id: PRICES[plan][cycle], recurring: { interval: cycle === "annual" ? "year" : "month" } } }] },
  };
  fake.invoices.set(inv.id, inv);
  fake.charges.set(chargeId, { id: chargeId, object: "charge", amount: pre + tax, amount_refunded: 0, disputed: false, invoice: inv.id, payment_intent: inv.payment_intent, created: T(paidAt), refunds: { data: [] }, payment_method_details: { card: { fingerprint: card } } });
  return inv;
}

/* --------------------------------- app ----------------------------------- */
const app = express();
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), webhook);
app.use(express.json());
app.use("/api/referrals", require("../routes/referrals"));
app.use("/api/admin/referral-rewards", require("../routes/adminReferrals"));
app.use("/api/stripe/checkout", require("../routes/stripe"));

let base;
const tokenFor = (u, { ageS = 0 } = {}) => jwt.sign({ id: String(u._id), tv: Number(u.tokenVersion || 0), iat: Math.floor(Date.now() / 1000) - ageS }, process.env.JWT_SECRET, { expiresIn: "2h" });
async function call(method, path, user, body, opts = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(user ? { authorization: `Bearer ${tokenFor(user, opts)}` } : {}) },
    body: body && method !== "GET" ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { text };
  }
  return { status: r.status, body: json };
}
let eventSeq = 0;
async function sendEvent(type, object, id = `evt_${++eventSeq}`) {
  const payload = JSON.stringify({ id, object: "event", type, data: { object }, created: Math.floor(Date.now() / 1000), livemode: false, api_version: "2024-06-20" });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const r = await fetch(`${base}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload });
  return r.status;
}

/* -------------------------------- fixtures -------------------------------- */
let n = 0;
async function customer(fields = {}) {
  n += 1;
  return User.create({
    userId: String(83000000 + n),
    name: fields.name || `Friend Number${n}`,
    firstName: (fields.name || `Friend Number${n}`).split(" ")[0],
    lastName: (fields.name || `Friend Number${n}`).split(" ")[1] || "",
    email: `r${n}@example.test`,
    emailVerifiedAt: new Date(),
    phone: `+1631557${String(1000 + n).slice(-4)}`,
    role: "customer",
    stripeCustomerId: `cus_r${n}`,
    addresses: [{ line1: fields.line1 || `${n} Oak Street`, city: "Huntington", state: "NY", zip: fields.zip || "11743" }],
    ...Object.fromEntries(Object.entries(fields).filter(([k]) => !["line1", "zip", "name"].includes(k))),
    name: fields.name || `Friend Number${n}`,
  });
}
const refOf = (user) => CustomerReferral.findOne({ referred: user._id }).lean();
const dollars = (c) => (c / 100).toFixed(2);

/** Friend pays a first invoice (and optionally a second) through the real webhook. */
async function pay(user, { plan = "basic", cycle = "monthly", percentOff = 0, promo = null, card, paidAt = "2026-11-20T16:00:00Z", sub = null, reason = "subscription_create" } = {}) {
  const s = sub || makeSub({ user, plan, cycle });
  const inv = invoice({ sub: s, plan, cycle, paidAt, percentOff, promo, reason, ...(card ? { card } : {}) });
  assert.strictEqual(await sendEvent("invoice.paid", inv), 200);
  return { sub: s, inv };
}
async function refund(inv, cents, eventId) {
  const ch = fake.charges.get(inv.charge);
  ch.amount_refunded = cents;
  ch.refunds = { data: [{ id: `re_${inv.id}_${cents}`, amount: cents, created: T("2026-12-01T12:00:00Z") }] };
  return sendEvent("charge.refunded", copy(ch), eventId);
}

(async () => {
  const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri());
  for (const m of [...Object.values(S), ReferralCode, CustomerReferral]) await m.init();
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  const owner = await User.create({ userId: "70000001", name: "Owner Person", email: "owner@example.test", role: "admin" });
  const general = await User.create({ userId: "70000002", name: "Gina General", email: "gf@example.test", role: "employee", employeePosition: "General Fixter" });
  const maria = await customer({ name: "Maria Lopez" }); // the referrer: never had a membership

  /* ===================================================== links */
  let code;
  await check("any signed-in customer (no membership) gets a personal link /r/<firstname>-xxxx; the same one every time", async () => {
    const a = await call("GET", "/api/referrals/me", maria);
    assert.strictEqual(a.status, 200, JSON.stringify(a.body));
    assert.match(a.body.code, /^maria-[a-z0-9]{4}$/);
    assert.strictEqual(a.body.url, `https://www.profixter.com/r/${a.body.code}`);
    const b = await call("GET", "/api/referrals/me", maria);
    assert.strictEqual(b.body.code, a.body.code);
    assert.deepStrictEqual(b.body.rewards, []);
    code = a.body.code;
  });
  await check("staff accounts have no customer referral link", async () => {
    const r = await call("GET", "/api/referrals/me", general);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.eligible, false);
    assert.strictEqual(r.body.code, null);
  });
  await check("codes are read as people paste them: a full link, ?ref=, upper case, spaces", async () => {
    assert.strictEqual(codes.normalizeCode(`https://www.profixter.com/r/${code.toUpperCase()}`), code);
    assert.strictEqual(codes.normalizeCode(`https://profixter.com/?source=referral&ref=${code}`), code);
    assert.strictEqual(codes.normalizeCode(`  ${code.toUpperCase()} `), code);
    assert.strictEqual(codes.normalizeCode("MIKE1234"), "", "a telemarketer's sales code is not a customer code");
    assert.strictEqual(codes.normalizeCode("<script>"), "");
  });
  await check("the 2025 links (/?ref=<8-digit account number>) still resolve to that customer", async () => {
    const r = await codes.resolveCode(maria.userId);
    assert.strictEqual(String(r.referrer._id), String(maria._id));
    assert.strictEqual(r.legacy, true);
    assert.strictEqual(await codes.resolveCode(general.userId), null, "a staff account number refers nobody");
    assert.strictEqual(await codes.resolveCode("99999999"), null);
  });

  /* ===================================================== attribution */
  const ann = await customer({ name: "Ann Baker" });
  await check("sign-up: the account-created hook records the referral from body.referral", async () => {
    const accounts = require("../utils/auth/accounts");
    await accounts.afterAccountCreated(ann, { req: { body: { referral: { code, capturedAt: new Date().toISOString() } }, headers: {} } });
    const r = await refOf(ann);
    assert.ok(r, "recorded");
    assert.strictEqual(String(r.referrer), String(maria._id));
    assert.strictEqual(r.via, "signup");
    assert.strictEqual(r.status, "attributed");
  });
  await check("the first referral wins: a second link later never replaces it", async () => {
    const other = await customer({ name: "Otto Other" });
    const otherCode = (await call("GET", "/api/referrals/me", other)).body.code;
    const r = await call("POST", "/api/referrals/claim", ann, { referral: { code: otherCode } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.recorded, false);
    assert.strictEqual(r.body.reason, "already_referred");
    assert.strictEqual(String((await refOf(ann)).referrer), String(maria._id));
  });
  await check("self-referral is refused: your own link records nothing", async () => {
    const r = await call("POST", "/api/referrals/claim", maria, { referral: { code } });
    assert.strictEqual(r.body.reason, "self");
    assert.strictEqual(await refOf(maria), null);
    const legacy = await call("POST", "/api/referrals/claim", maria, { code: maria.userId });
    assert.strictEqual(legacy.body.reason, "self");
  });
  await check("a customer who already had a paid membership can't be referred", async () => {
    const member = await customer({ name: "Mem Ber" });
    await Subscription.create({ user: member._id, subscriptionType: "basic", billingCycle: "monthly", status: "active", stripeSubscriptionId: "sub_old_member", addressId: member.addresses[0]._id, address: member.addresses[0].line1 }).catch(async () => {
      await Subscription.collection.insertOne({ user: member._id, stripeSubscriptionId: "sub_old_member" });
    });
    const r = await call("POST", "/api/referrals/claim", member, { referral: { code } });
    assert.strictEqual(r.body.reason, "already_member");
    assert.strictEqual(await refOf(member), null);
  });
  await check("an unknown or telemarketer code records nothing", async () => {
    const x = await customer();
    assert.strictEqual((await call("POST", "/api/referrals/claim", x, { referral: { code: "nobody-zzzz" } })).body.reason, "unknown_code");
    assert.strictEqual((await call("POST", "/api/referrals/claim", x, { referral: { code: "MIKE1234" } })).body.reason, "unknown_code");
  });

  await check("checkout: a referral the browser holds is recorded and rides on the Stripe session and subscription metadata (promotion codes stay allowed)", async () => {
    const cara = await customer({ name: "Cara Checkout" });
    const before = fake.sessions.length;
    const r = await call("POST", "/api/stripe/checkout/create-checkout-session", cara, { plan: "basic", billingCycle: "monthly", addressId: String(cara.addresses[0]._id), referral: { code } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(fake.sessions.length, before + 1);
    const s = fake.sessions.at(-1);
    const rec = await refOf(cara);
    assert.strictEqual(rec.via, "checkout");
    assert.strictEqual(s.metadata.referralCode, code);
    assert.strictEqual(s.subscription_data.metadata.referralCode, code);
    assert.strictEqual(s.subscription_data.metadata.referralId, String(rec._id));
    assert.strictEqual(s.allow_promotion_codes, true, "the friend can still type a promotion code on Stripe's page");
  });

  /* ===================================================== the reward */
  await check("Basic at full price: first invoice → Pending $149.00 (tax excluded); referrer emailed", async () => {
    sentEmails.length = 0;
    await pay(ann, { paidAt: "2026-11-20T16:00:00Z" });
    const r = await refOf(ann);
    assert.strictEqual(r.status, "pending");
    assert.strictEqual(r.amountCents, 14900);
    assert.strictEqual(r.first.taxCents, 1285);
    assert.strictEqual(r.first.amountPaidCents, 16185);
    const mail = sentEmails.find((e) => e.templateKey === "referral_reward_pending");
    assert.ok(mail, "pending email");
    assert.strictEqual(mail.to, maria.email);
    assert.strictEqual(mail.vars.amount, "$149.00");
    assert.strictEqual(mail.vars.friend, "Ann B.", "the referrer sees a first name and initial only");
  });
  await check("duplicate webhook: the same event again, and a new event for the same invoice, change nothing", async () => {
    const before = await refOf(ann);
    const inv = [...fake.invoices.values()].find((i) => i.id === before.first.invoiceId);
    const id = `evt_dup_${Date.now()}`;
    assert.strictEqual(await sendEvent("invoice.paid", inv, id), 200);
    assert.strictEqual(await sendEvent("invoice.paid", inv, id), 200);
    assert.strictEqual(await sendEvent("invoice.paid", inv), 200);
    const after = await refOf(ann);
    assert.strictEqual(after.status, "pending");
    assert.strictEqual(after.history.length, before.history.length);
    assert.strictEqual(after.second, null);
    assert.strictEqual(sentEmails.filter((e) => e.templateKey === "referral_reward_pending").length, 1, "one pending email");
  });
  await check("second paid invoice (renewal) → Ready; owner emailed once and listed in Needs action; referrer asked where to mail it", async () => {
    sentEmails.length = 0;
    const first = await refOf(ann);
    const inv = invoice({ sub: fake.subs.get(first.first.subscriptionId), reason: "subscription_cycle", paidAt: "2026-12-20T16:00:00Z" });
    assert.strictEqual(await sendEvent("invoice.paid", inv), 200);
    assert.strictEqual(await sendEvent("invoice.paid", inv), 200); // replay
    const r = await refOf(ann);
    assert.strictEqual(r.status, "eligible");
    assert.strictEqual(r.amountCents, 14900);
    assert.strictEqual(sentEmails.filter((e) => e.promo && e.to === "owner@example.test" && /ready/i.test(e.subject)).length, 1);
    assert.strictEqual(sentEmails.filter((e) => e.templateKey === "referral_reward_ready").length, 1);
    const na = await collectNeedsAction({ accessUser: owner });
    const item = na.items.find((i) => i.kind === "referral_reward_ready" && i.id === String(r._id));
    assert.ok(item, "in Needs action");
    assert.strictEqual(item.href, `/admin/referrals/${r._id}`);
    const staff = await collectNeedsAction({ accessUser: general });
    assert.ok(!staff.items.some((i) => i.kind?.startsWith("referral_reward")), "only the owner sees referral rewards");
  });
  await check("a third paid invoice changes nothing once Ready", async () => {
    const before = await refOf(ann);
    const inv = invoice({ sub: fake.subs.get(before.first.subscriptionId), reason: "subscription_cycle", paidAt: "2027-01-20T16:00:00Z" });
    assert.strictEqual(await sendEvent("invoice.paid", inv), 200);
    const after = await refOf(ann);
    assert.strictEqual(after.second.invoiceId, before.second.invoiceId);
    assert.strictEqual(after.history.length, before.history.length);
  });

  const ben = await customer({ name: "Ben Promo" });
  await check("Basic with a 10% promotion code earns $134.10 (the amount actually collected, before tax); the code is recorded", async () => {
    await engine.bindReferral({ user: ben, code, via: "signup" });
    await pay(ben, { percentOff: 10, promo: "SAVE10", paidAt: "2026-11-21T16:00:00Z", card: "fp_ben" });
    const r = await refOf(ben);
    assert.strictEqual(r.status, "pending");
    assert.strictEqual(r.amountCents, 13410);
    assert.strictEqual(dollars(r.amountCents), "134.10");
    assert.strictEqual(r.first.promoCode, "SAVE10");
    assert.strictEqual(r.first.discountCents, 1490);
  });
  await check("refunds: a partial refund lowers the reward (tax share taken out); the replayed refund event changes nothing; a full refund voids it", async () => {
    const r0 = await refOf(ben);
    const inv = fake.invoices.get(r0.first.invoiceId);
    // $50.00 back of $145.67 paid: pre-tax share = 5000 * 13410 / 14567 = 4603.
    assert.strictEqual(await refund(inv, 5000, "evt_refund_partial"), 200);
    let r = await refOf(ben);
    assert.strictEqual(r.first.refundedPreTaxCents, Math.round((5000 * 13410) / 14567));
    assert.strictEqual(r.amountCents, 13410 - Math.round((5000 * 13410) / 14567));
    const hist = r.history.length;
    assert.strictEqual(await refund(inv, 5000), 200, "the same refund total under a new event id");
    r = await refOf(ben);
    assert.strictEqual(r.history.length, hist, "no second deduction");
    assert.strictEqual(await refund(inv, inv.amount_paid), 200);
    r = await refOf(ben);
    assert.strictEqual(r.status, "void");
    assert.strictEqual(r.amountCents, 0);
    assert.match(r.reason, /refunded in full/);
    const view = (await call("GET", "/api/referrals/me", maria)).body.rewards.find((x) => x.id === String(r._id));
    assert.strictEqual(view.statusLabel, "No reward");
    assert.ok(!("flags" in view), "the referrer never sees the owner's flags");
  });

  const cleo = await customer({ name: "Cleo Free" });
  await check("a $0 first invoice (100% code, gift trial) doesn't count; the first PAID invoice is the first", async () => {
    await engine.bindReferral({ user: cleo, code, via: "signup" });
    const sub = makeSub({ user: cleo });
    const zero = invoice({ sub, paidAt: "2026-11-22T16:00:00Z", percentOff: 100, promo: "FREEMONTH" });
    assert.strictEqual(A.isCountedInvoice(zero), false);
    assert.strictEqual(await sendEvent("invoice.paid", zero), 200);
    assert.strictEqual((await refOf(cleo)).status, "attributed");
    await pay(cleo, { sub, reason: "subscription_cycle", paidAt: "2026-12-22T16:00:00Z" });
    const r = await refOf(cleo);
    assert.strictEqual(r.status, "pending");
    assert.strictEqual(r.amountCents, 14900);
  });
  await check("a full refund of the SECOND payment sends a Ready reward back to Pending; the next paid month makes it Ready again", async () => {
    const r0 = await refOf(cleo);
    const sub = fake.subs.get(r0.first.subscriptionId);
    const second = invoice({ sub, reason: "subscription_cycle", paidAt: "2027-01-22T16:00:00Z" });
    assert.strictEqual(await sendEvent("invoice.paid", second), 200);
    assert.strictEqual((await refOf(cleo)).status, "eligible");
    assert.strictEqual(await refund(second, second.amount_paid), 200);
    assert.strictEqual((await refOf(cleo)).status, "pending");
    const third = invoice({ sub, reason: "subscription_cycle", paidAt: "2027-02-22T16:00:00Z" });
    assert.strictEqual(await sendEvent("invoice.paid", third), 200);
    const r = await refOf(cleo);
    assert.strictEqual(r.status, "eligible");
    assert.strictEqual(r.second.invoiceId, third.id);
  });
  await check("annual Elite: the reward is capped at $149", async () => {
    const dee = await customer({ name: "Dee Annual" });
    await engine.bindReferral({ user: dee, code, via: "signup" });
    await pay(dee, { plan: "elite", cycle: "annual", paidAt: "2026-11-23T16:00:00Z" });
    const r = await refOf(dee);
    assert.strictEqual(r.status, "pending");
    assert.strictEqual(r.amountCents, 14900);
    assert.ok(r.first.paidPreTaxCents > 14900);
  });
  await check("a plan-change proration invoice and a non-membership charge are ignored", async () => {
    const eve = await customer({ name: "Eve Ignore" });
    await engine.bindReferral({ user: eve, code, via: "signup" });
    const sub = makeSub({ user: eve });
    const proration = invoice({ sub, reason: "subscription_update", paidAt: "2026-11-24T16:00:00Z" });
    assert.strictEqual(await sendEvent("invoice.paid", proration), 200);
    assert.strictEqual((await refOf(eve)).status, "attributed");
    const visit = { id: "ch_one_time_visit", object: "charge", amount: 9900, amount_refunded: 9900, invoice: null, payment_intent: "pi_visit", refunds: { data: [] } };
    assert.strictEqual(await sendEvent("charge.refunded", visit), 200);
    assert.strictEqual((await refOf(eve)).status, "attributed", "a one-time visit never touches a referral");
  });

  /* ===================================================== flags */
  let fay;
  await check("same household as the referrer, and the referrer's own card: flagged for the owner, never silently paid", async () => {
    fay = await customer({ name: "Fay Household", line1: maria.addresses[0].line1, zip: maria.addresses[0].zip });
    fake.cards.set(maria.stripeCustomerId, ["fp_maria"]);
    await engine.bindReferral({ user: fay, code, via: "signup" });
    const { sub } = await pay(fay, { card: "fp_maria", paidAt: "2026-11-25T16:00:00Z" });
    await pay(fay, { sub, reason: "subscription_cycle", card: "fp_maria", paidAt: "2026-12-25T16:00:00Z" });
    const r = await refOf(fay);
    assert.strictEqual(r.status, "eligible");
    const got = r.flags.map((f) => f.code).sort();
    assert.ok(got.includes("same_address"), got.join());
    assert.ok(got.includes("same_card"), got.join());
  });
  await check("a second referred account at an already-rewarded home is flagged (one reward per household)", async () => {
    const gus = await customer({ name: "Gus Sameh", line1: ann.addresses[0].line1, zip: ann.addresses[0].zip });
    await engine.bindReferral({ user: gus, code, via: "signup" });
    await pay(gus, { paidAt: "2026-11-26T16:00:00Z", card: "fp_gus" });
    const r = await refOf(gus);
    assert.ok(r.flags.some((f) => f.code === "household_rewarded"), r.flags.map((f) => f.code).join());
  });

  /* ===================================================== Admin payout */
  const annRef = await refOf(ann);
  const id = String(annRef._id);
  await check("Admin > Referrals is the owner's alone (staff and customers get 403)", async () => {
    assert.strictEqual((await call("GET", "/api/admin/referral-rewards", general)).status, 403);
    assert.strictEqual((await call("GET", "/api/admin/referral-rewards", maria)).status, 403);
    assert.strictEqual((await call("GET", `/api/admin/referral-rewards/${id}`, maria)).status, 403);
  });
  await check("the owner sees ready rewards with the referrer, amount, both payments and flags", async () => {
    const list = await call("GET", "/api/admin/referral-rewards?status=ready", owner);
    assert.strictEqual(list.status, 200);
    const row = list.body.rewards.find((x) => x.id === id);
    assert.ok(row);
    assert.strictEqual(row.referrer.name, "Maria Lopez");
    assert.strictEqual(row.amountCents, 14900);
    assert.ok(list.body.counts.ready >= 2);
    const d = (await call("GET", `/api/admin/referral-rewards/${id}`, owner)).body.reward;
    assert.strictEqual(d.first.paidPreTaxCents, 14900);
    assert.strictEqual(d.second.billingReason, "subscription_cycle");
    assert.strictEqual(d.payee, null);
    assert.strictEqual(d.canApprove, false);
  });
  await check("approve is refused until the payee and mailing address are confirmed", async () => {
    const r = await call("POST", `/api/admin/referral-rewards/${id}/approve`, owner, { expectedAmountCents: 14900, payeeConfirmed: true });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, "PAYEE_MISSING");
  });
  await check("the referrer sets the payee only with a fresh sign-in or a confirmation code (an old session gets REAUTH_REQUIRED)", async () => {
    const payee = { name: "Maria Lopez", line1: "12 Oak Street", line2: "Apt 2", city: "Huntington", state: "ny", zip: "11743" };
    const stale = await call("POST", `/api/referrals/rewards/${id}/payee`, maria, payee, { ageS: 3600 });
    assert.strictEqual(stale.status, 403);
    assert.strictEqual(stale.body.code, "REAUTH_REQUIRED");
    const proof = jwt.sign({ id: String(maria._id), tv: 0, purpose: "reauth" }, process.env.JWT_SECRET, { expiresIn: "10m" });
    sentEmails.length = 0;
    const ok = await call("POST", `/api/referrals/rewards/${id}/payee`, maria, { ...payee, reauthToken: proof }, { ageS: 3600 });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.reward.payee.confirmed, true);
    assert.strictEqual(ok.body.reward.payee.address, "12 Oak Street, Apt 2, Huntington, NY 11743");
    assert.ok(sentEmails.some((e) => e.templateKey === "referral_payee_saved" && e.to === maria.email), "security notice sent");
    const other = await customer({ name: "Not Referrer" });
    assert.strictEqual((await call("POST", `/api/referrals/rewards/${id}/payee`, other, payee)).status, 404, "nobody else's reward");
    const bad = await call("POST", `/api/referrals/rewards/${id}/payee`, maria, { ...payee, zip: "12" });
    assert.strictEqual(bad.status, 400);
  });
  await check("approve needs the owner's tick that the payee is checked, and the amount the owner saw", async () => {
    assert.strictEqual((await call("POST", `/api/admin/referral-rewards/${id}/approve`, owner, { expectedAmountCents: 14900 })).body.code, "PAYEE_UNCONFIRMED");
    const wrong = await call("POST", `/api/admin/referral-rewards/${id}/approve`, owner, { expectedAmountCents: 13410, payeeConfirmed: true });
    assert.strictEqual(wrong.status, 409);
    assert.strictEqual(wrong.body.code, "AMOUNT_CHANGED");
  });
  await check("recheck before approval: a refund Stripe shows (but no webhook delivered) blocks approval and updates the amount", async () => {
    const r0 = await refOf(ann);
    const ch = fake.charges.get(r0.first.chargeId);
    ch.amount_refunded = 1000; // in Stripe only
    const r = await call("POST", `/api/admin/referral-rewards/${id}/approve`, owner, { expectedAmountCents: 14900, payeeConfirmed: true });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, "RECHECK_CHANGED");
    assert.ok(r.body.changes.some((c) => /now \$/.test(c)), r.body.changes.join(" | "));
    const expected = 14900 - Math.round((1000 * 14900) / 16185);
    assert.strictEqual(r.body.reward.amountCents, expected);
    const again = await call("POST", `/api/admin/referral-rewards/${id}/approve`, owner, { expectedAmountCents: expected, payeeConfirmed: true });
    assert.strictEqual(again.status, 200, JSON.stringify(again.body));
    assert.strictEqual(again.body.reward.status, "approved");
    assert.strictEqual(again.body.reward.approval.amountCents, expected);
  });
  await check("mark mailed needs a check reference, rechecks Stripe again, and tells the referrer", async () => {
    assert.strictEqual((await call("POST", `/api/admin/referral-rewards/${id}/mailed`, owner, { reference: "" })).body.code, "REFERENCE_REQUIRED");
    sentEmails.length = 0;
    const r = await call("POST", `/api/admin/referral-rewards/${id}/mailed`, owner, { reference: "Check 1042", mailedAt: new Date(Date.now() - 86400000).toISOString().slice(0, 10) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.reward.status, "mailed");
    assert.strictEqual(r.body.reward.check.reference, "Check 1042");
    assert.ok(sentEmails.some((e) => e.templateKey === "referral_reward_mailed" && e.vars.reference === "Check 1042"));
    const me = (await call("GET", "/api/referrals/me", maria)).body;
    const view = me.rewards.find((x) => x.id === id);
    assert.strictEqual(view.statusLabel, "Check mailed");
    assert.ok(me.totals.mailedCents > 0);
    // Approving or mailing twice is refused: no duplicate payout.
    assert.strictEqual((await call("POST", `/api/admin/referral-rewards/${id}/mailed`, owner, { reference: "Check 1043" })).status, 409);
    assert.strictEqual((await call("POST", `/api/admin/referral-rewards/${id}/approve`, owner, { expectedAmountCents: r.body.reward.amountCents, payeeConfirmed: true })).status, 409);
    assert.strictEqual((await call("POST", `/api/admin/referral-rewards/${id}/void`, owner, { reason: "test" })).status, 409, "a mailed check can't be voided");
  });
  await check("a refund after the check was mailed is put in front of the owner (Needs action problem + email), never silently changed", async () => {
    sentEmails.length = 0;
    const r0 = await refOf(ann);
    const inv = fake.invoices.get(r0.first.invoiceId);
    assert.strictEqual(await refund(inv, inv.amount_paid), 200);
    const r = await refOf(ann);
    assert.strictEqual(r.status, "mailed");
    assert.match(r.attention, /already mailed/);
    assert.ok(sentEmails.some((e) => e.promo && /needs a look/.test(e.subject)));
    const na = await collectNeedsAction({ accessUser: owner });
    assert.ok(na.items.some((i) => i.kind === "referral_reward_attention" && i.id === id && i.severity === "problem"));
    const ack = await call("POST", `/api/admin/referral-rewards/${id}/acknowledge`, owner, { note: "Called Maria" });
    assert.strictEqual(ack.status, 200);
    assert.strictEqual(ack.body.reward.attention, "");
  });
  await check("flagged rewards: approval waits until the owner says what they checked; a flag cleared once stays cleared", async () => {
    const fr = await refOf(fay);
    const fid = String(fr._id);
    await call("POST", `/api/admin/referral-rewards/${fid}/payee`, owner, { name: "Maria Lopez", line1: "1 Oak Street", city: "Huntington", state: "NY", zip: "11743", note: "" }).then((r) => assert.strictEqual(r.body.code, "NOTE_REQUIRED"));
    const p = await call("POST", `/api/admin/referral-rewards/${fid}/payee`, owner, { name: "Fay Household", line1: "1 Oak Street", city: "Huntington", state: "NY", zip: "11743", note: "Confirmed by phone" });
    assert.strictEqual(p.status, 200, JSON.stringify(p.body));
    const blocked = await call("POST", `/api/admin/referral-rewards/${fid}/approve`, owner, { expectedAmountCents: 14900, payeeConfirmed: true });
    assert.strictEqual(blocked.status, 409);
    assert.strictEqual(blocked.body.code, "FLAGS_OPEN");
    const cleared = await call("POST", `/api/admin/referral-rewards/${fid}/flags/clear`, owner, { note: "Fay rents the downstairs unit; separate household, own card on file" });
    assert.strictEqual(cleared.status, 200);
    assert.ok(cleared.body.reward.flags.every((f) => f.reviewed));
    const ok = await call("POST", `/api/admin/referral-rewards/${fid}/approve`, owner, { expectedAmountCents: 14900, payeeConfirmed: true });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  });
  await check("a chargeback on an approved reward withdraws the approval and raises a flag", async () => {
    const fr = await refOf(fay);
    const dispute = { id: "dp_1", object: "dispute", charge: fr.second.chargeId, amount: fr.second.amountPaidCents, status: "needs_response" };
    fake.charges.get(fr.second.chargeId).disputed = true;
    assert.strictEqual(await sendEvent("charge.dispute.created", dispute), 200);
    const r = await refOf(fay);
    assert.notStrictEqual(r.status, "approved");
    assert.ok(r.flags.some((f) => f.code === "chargeback"));
    assert.ok(r.attention);
  });
  await check("void with a reason; a voided reward can't be approved", async () => {
    const gr = await CustomerReferral.findOne({ "flags.code": "household_rewarded" }).lean();
    const v = await call("POST", `/api/admin/referral-rewards/${gr._id}/void`, owner, { reason: "Same household as Ann" });
    assert.strictEqual(v.status, 200);
    assert.strictEqual(v.body.reward.status, "void");
    assert.strictEqual((await call("POST", `/api/admin/referral-rewards/${gr._id}/approve`, owner, { expectedAmountCents: 14900, payeeConfirmed: true })).status, 409);
  });
  await check("two webhooks for the same referral at once: one first payment, one second, nothing lost", async () => {
    const hal = await customer({ name: "Hal Race" });
    await engine.bindReferral({ user: hal, code, via: "signup" });
    const sub = makeSub({ user: hal });
    const a = invoice({ sub, paidAt: "2026-11-27T16:00:00Z" });
    const b = invoice({ sub, reason: "subscription_cycle", paidAt: "2026-12-27T16:00:00Z" });
    await sendEvent("invoice.paid", a);
    await Promise.all([sendEvent("invoice.paid", b), sendEvent("invoice.paid", b)]);
    const r = await refOf(hal);
    assert.strictEqual(r.status, "eligible");
    assert.strictEqual(r.first.invoiceId, a.id);
    assert.strictEqual(r.second.invoiceId, b.id);
  });
  await check("the unique index is the last guard: one referral (and so one reward) per referred account", async () => {
    await assert.rejects(CustomerReferral.create({ referrer: maria._id, referred: ann._id, code, via: "claim" }), (e) => e.code === 11000);
  });
  await check("emails render: pending, ready, payee saved, mailed", async () => {
    for (const key of ["referral_reward_pending", "referral_reward_ready", "referral_payee_saved", "referral_reward_mailed"]) {
      const t = realMail.TEMPLATES[key]({ name: "Maria", friend: "Ann B.", amount: "$149.00", reference: "1042", mailedOn: "December 21, 2026", payee: "Maria Lopez", address: "12 Oak St" });
      assert.ok(t.subject && t.html.includes("Profixter"), key);
    }
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
