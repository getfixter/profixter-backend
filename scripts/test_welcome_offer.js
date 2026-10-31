/*
 * The 20% first-payment offer: Customer Experience 4.2 (new customers, ten
 * minutes from sign-up) widened by the Halloween promotion (any plan, monthly
 * or annual; former members too; existing customers open their own ten
 * minutes by opening the campaign while signed in; once per customer and home).
 *
 * Drives the real routes (/api/stripe/checkout/welcome-offer and
 * create-checkout-session) and the real checkout opener against an in-memory
 * MongoDB. Stripe is faked on the shared client, and the fake refuses what
 * Stripe refuses (a coupon alongside the promotion-code field, an expiry
 * outside 30 min - 24 h), so a request that passes here is one Stripe accepts.
 * Nothing leaves the machine.
 *
 *   node scripts/test_welcome_offer.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-welcome-offer";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake_for_unit_tests";
process.env.CLIENT_URL = "https://www.profixter.com";
process.env.SMS_ENABLED = "false";
const PRICES = {
  basic: ["price_basic_m", 14900],
  plus: ["price_plus_m", 24900],
  premium: ["price_premium_m", 34900],
  elite: ["price_elite_m", 49900],
};
for (const [plan, [id]] of Object.entries(PRICES)) process.env[`STRIPE_PRICE_${plan.toUpperCase()}_MONTHLY`] = id;
const ANNUAL = { basic: ["price_basic_y", 149000], plus: ["price_plus_y", 249000], premium: ["price_premium_y", 349000], elite: ["price_elite_y", 499000] };
for (const [plan, [id]] of Object.entries(ANNUAL)) process.env[`STRIPE_PRICE_${plan.toUpperCase()}_ANNUAL`] = id;
const ALL_PRICES = [...Object.values(PRICES), ...Object.values(ANNUAL)];

const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
// Gift coverage, per test: a home id listed here is covered for 20 more days.
const giftCovered = new Set();
const realGift = require("../utils/gifts/giftAccess");
stub("../utils/gifts/giftAccess", {
  ...realGift,
  async projectedGiftCoverageEnd(userId, addressId) {
    return giftCovered.has(String(addressId)) ? new Date(Date.now() + 20 * 86400000) : null;
  },
});

const { MongoMemoryServer } = require("mongodb-memory-server");
const subsModule = require("../utils/subscriptionManagement");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const welcome = require("../utils/welcomeOffer");

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
const fake = { sessions: new Map(), created: [], expired: [], coupons: new Map(), couponCreates: 0, customers: [], subs: [] };
const stripeError = (message, code = "parameter_invalid") => Object.assign(new Error(message), { type: "StripeInvalidRequestError", code, statusCode: 400 });
stripe.prices.retrieve = async (id) => {
  const hit = ALL_PRICES.find(([pid]) => pid === id);
  if (!hit) throw stripeError(`No such price: ${id}`, "resource_missing");
  return { id, unit_amount: hit[1], currency: "usd", recurring: { interval: "month" } };
};
stripe.coupons.retrieve = async (id) => {
  if (!fake.coupons.has(id)) throw Object.assign(stripeError(`No such coupon: '${id}'`, "resource_missing"), { statusCode: 404 });
  return { ...fake.coupons.get(id) };
};
stripe.coupons.create = async (params) => {
  if (fake.coupons.has(params.id)) throw stripeError("Coupon already exists.", "resource_already_exists");
  fake.couponCreates += 1;
  const coupon = { object: "coupon", valid: true, amount_off: null, ...params };
  fake.coupons.set(params.id, coupon);
  return { ...coupon };
};
stripe.customers.list = async ({ email }) => ({ data: fake.customers.filter((c) => c.email === email) });
stripe.subscriptions.list = (params = {}) => {
  const items = fake.subs.filter((s) => s.customer === params.customer);
  const promise = Promise.resolve({ object: "list", data: items.slice(0, params.limit || 100), has_more: false });
  promise[Symbol.asyncIterator] = async function* iterate() {
    for (const item of items) yield item;
  };
  return promise;
};
stripe.checkout.sessions.list = async ({ customer }) => ({
  data: [...fake.sessions.values()].filter((s) => s.customer === customer && s.status === "open"),
});
stripe.checkout.sessions.retrieve = async (id) => {
  if (!fake.sessions.has(id)) throw stripeError(`No such checkout.session: ${id}`, "resource_missing");
  return { ...fake.sessions.get(id) };
};
stripe.checkout.sessions.expire = async (id) => {
  fake.expired.push(id);
  fake.sessions.get(id).status = "expired";
  return { ...fake.sessions.get(id) };
};
stripe.checkout.sessions.create = async (config) => {
  // What Stripe itself refuses.
  if (config.discounts && config.allow_promotion_codes) throw stripeError("You may only specify one of these parameters: allow_promotion_codes, discounts.");
  if (config.expires_at) {
    const lifetime = config.expires_at - Math.floor(Date.now() / 1000);
    if (lifetime < 30 * 60 || lifetime > 24 * 3600) throw stripeError("expires_at must be between 30 minutes and 24 hours from now");
  }
  for (const d of config.discounts || []) {
    if (d.coupon && !fake.coupons.has(d.coupon)) throw stripeError(`No such coupon: '${d.coupon}'`, "resource_missing");
  }
  const id = `cs_test_${fake.created.length + 1}`;
  const session = { id, status: "open", mode: "subscription", customer: config.customer || null, metadata: config.metadata, url: `https://checkout.stripe.test/${id}`, config };
  fake.sessions.set(id, session);
  fake.created.push(session);
  return { ...session };
};

/*
 * What Stripe would bill: the first invoice takes a "once" coupon, every later
 * one is the plain price. Used to prove the renewal is untouched.
 */
function invoices(session, count = 3) {
  const price = ALL_PRICES.find(([pid]) => pid === session.config.line_items[0].price)[1];
  const coupon = (session.config.discounts || [])[0]?.coupon ? fake.coupons.get(session.config.discounts[0].coupon) : null;
  return Array.from({ length: count }, (_, i) => {
    const applies = coupon && (coupon.duration === "forever" || (coupon.duration === "once" && i === 0));
    return applies ? price - Math.round((price * coupon.percent_off) / 100) : price;
  });
}

/* ------------------------------- helpers -------------------------------- */
let server;
let baseUrl;
let seq = 0;
async function makeCustomer({ minutesOld = 1, street = "12 Maple Street", zip = "11735", extra = {} } = {}) {
  seq += 1;
  const user = await User.create({
    userId: `7000${seq}${Date.now() % 10000}`,
    name: `New Customer ${seq}`,
    email: `new${seq}@example.test`,
    phone: `+1516555${String(1000 + seq).padStart(4, "0")}`,
    phoneVerifiedAt: new Date(),
    role: "customer",
    signupMethod: "phone",
    addresses: [{ label: "Primary", line1: street, city: "Farmingdale", state: "NY", zip, county: "Nassau" }],
    smsPreferences: { transactionalEnabled: true, transactionalConsentAt: new Date() },
    ...extra,
  });
  if (minutesOld) {
    // createdAt as the server would have written it that long ago.
    await User.collection.updateOne({ _id: user._id }, { $set: { createdAt: new Date(Date.now() - minutesOld * 60000) } });
  }
  return User.findById(user._id);
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
const offer = (user, query = "") => api(user, "GET", `/api/stripe/checkout/welcome-offer${query}`);
const buy = (user, body) =>
  api(user, "POST", "/api/stripe/checkout/create-checkout-session", { plan: "basic", billingCycle: "monthly", addressId: String(user.addresses[0]._id), ...body });
const clearLock = (user) => User.collection.updateOne({ _id: user._id }, { $unset: { membershipCheckoutLock: "" } });

/* --------------------------------- run ---------------------------------- */
async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Subscription.init();
  const app = express();
  app.use(express.json());
  app.use("/api/stripe/checkout", require("../routes/stripe"));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  try {
    console.log("\nA brand-new customer");
    const ana = await makeCustomer({ minutesOld: 2 });
    let first;
    await check("is eligible, with an expiry exactly ten minutes after the account was created", async () => {
      first = await offer(ana);
      assert.strictEqual(first.status, 200);
      assert.strictEqual(first.body.eligible, true);
      const created = (await User.collection.findOne({ _id: ana._id })).createdAt;
      assert.strictEqual(Date.parse(first.body.expiresAt), created.getTime() + 10 * 60000);
      assert.ok(Math.abs(Date.parse(first.body.serverNow) - Date.now()) < 5000, "serverNow is the server's clock");
    });
    await check("prices come from Stripe: every plan, monthly and annual, 20% off the first payment", async () => {
      assert.deepStrictEqual(first.body.plans, {
        basic: { monthlyCents: 14900, firstMonthCents: 11920, annualCents: 149000, firstYearCents: 119200 },
        plus: { monthlyCents: 24900, firstMonthCents: 19920, annualCents: 249000, firstYearCents: 199200 },
        premium: { monthlyCents: 34900, firstMonthCents: 27920, annualCents: 349000, firstYearCents: 279200 },
        elite: { monthlyCents: 49900, firstMonthCents: 39920, annualCents: 499000, firstYearCents: 399200 },
      });
      assert.deepStrictEqual(first.body.cycles, ["monthly", "annual"]);
      assert.strictEqual(first.body.source, "new_account");
      assert.strictEqual(first.body.percentOff, 20);
    });
    await check("asking again (reload, second tab) never moves the expiry", async () => {
      const again = await offer(ana);
      await User.updateOne({ _id: ana._id }, { $set: { name: "Ana Edited" } });
      const afterEdit = await offer(ana);
      assert.strictEqual(again.body.expiresAt, first.body.expiresAt);
      assert.strictEqual(afterEdit.body.expiresAt, first.body.expiresAt);
    });

    let anaSession;
    await check("monthly checkout carries the coupon, no promotion-code field, a 31-minute life", async () => {
      const res = await buy(ana, { welcomeOffer: true });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.welcomeOfferApplied, true);
      anaSession = fake.created.at(-1);
      assert.deepStrictEqual(anaSession.config.discounts, [{ coupon: welcome.WELCOME_COUPON_ID }]);
      assert.strictEqual(anaSession.config.allow_promotion_codes, undefined);
      const life = anaSession.config.expires_at - Math.floor(Date.now() / 1000);
      assert.ok(life > 30 * 60 && life <= 31 * 60, `lifetime ${life}s`);
      assert.strictEqual(anaSession.config.metadata.welcomeOffer, "first_month_20");
      assert.strictEqual(anaSession.config.subscription_data.metadata.welcomeOffer, "first_month_20");
    });
    await check("the coupon is 20% off ONCE, created a single time, server-attached only", async () => {
      const coupon = fake.coupons.get(welcome.WELCOME_COUPON_ID);
      assert.strictEqual(coupon.percent_off, 20);
      assert.strictEqual(coupon.duration, "once");
      assert.strictEqual(fake.couponCreates, 1);
    });
    await check("Stripe bills $119.20 first, then $149 every month after", async () => {
      assert.deepStrictEqual(invoices(anaSession, 3), [11920, 14900, 14900]);
    });
    await check("Elite: $399.20 first month, $499 after", async () => {
      await clearLock(ana);
      const res = await buy(ana, { plan: "elite", welcomeOffer: true });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(invoices(fake.created.at(-1), 2), [39920, 49900]);
    });
    await check("a second welcome checkout closes the first (one welcome price open at a time)", async () => {
      assert.ok(fake.expired.includes(anaSession.id), `expired=${fake.expired.join(",")}`);
      assert.strictEqual(fake.couponCreates, 1, "coupon not created twice");
    });
    await check("annual: 20% off the first year ($2,490 -> $1,992), then $2,490 a year", async () => {
      await clearLock(ana);
      const res = await buy(ana, { plan: "plus", billingCycle: "annual", welcomeOffer: true });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const s = fake.created.at(-1);
      assert.deepStrictEqual(s.config.discounts, [{ coupon: welcome.WELCOME_COUPON_ID }]);
      assert.strictEqual(s.config.allow_promotion_codes, undefined);
      assert.strictEqual(res.body.welcomeOfferApplied, true);
      assert.deepStrictEqual(invoices(s, 2), [199200, 249000]);
    });
    await check("an abandoned or canceled welcome checkout does not use the offer up", async () => {
      // Every session so far is open/expired, none complete.
      assert.strictEqual((await offer(ana)).body.eligible, true);
    });
    await check("once a welcome checkout is paid, the offer is gone (redeemed)", async () => {
      const raw = (await User.collection.findOne({ _id: ana._id })).welcomeOffer;
      fake.sessions.get(raw.sessionId).status = "complete";
      const res = await offer(ana);
      assert.strictEqual(res.body.eligible, false);
      await clearLock(ana);
      const again = await buy(ana, { welcomeOffer: true });
      assert.strictEqual(again.status, 409);
      assert.strictEqual(again.body.code, "WELCOME_OFFER_UNAVAILABLE");
    });

    console.log("\nThe ten minutes");
    const late = await makeCustomer({ minutesOld: 10.05 });
    await check("ten minutes after sign-up: not eligible, no prices sent", async () => {
      const res = await offer(late);
      assert.strictEqual(res.body.eligible, false);
      assert.strictEqual(res.body.plans, undefined);
    });
    await check("expired + the page still showing the welcome price: refused, nothing opened", async () => {
      const before = fake.created.length;
      const res = await buy(late, { welcomeOffer: true });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.code, "WELCOME_OFFER_ENDED");
      assert.strictEqual(fake.created.length, before);
    });
    await check("expired, regular price asked: full price checkout, promotion codes as before", async () => {
      await clearLock(late);
      const res = await buy(late, {});
      assert.strictEqual(res.status, 200);
      const s = fake.created.at(-1);
      assert.strictEqual(s.config.discounts, undefined);
      assert.strictEqual(s.config.allow_promotion_codes, true);
      assert.strictEqual(s.config.expires_at, undefined);
      assert.deepStrictEqual(invoices(s, 2), [14900, 14900]);
    });
    await check("the window is computed against the server clock at 9:59 and 10:00", async () => {
      const created = new Date("2026-10-31T12:00:00Z");
      const user = { _id: new mongoose.Types.ObjectId(), role: "customer", signupMethod: "phone", createdAt: created };
      const w = welcome.welcomeOfferWindow(user);
      assert.strictEqual(w.expiresAt.toISOString(), "2026-10-31T12:10:00.000Z");
      const at = (iso) => welcome.welcomeOfferStatus({ user, now: new Date(iso) });
      assert.strictEqual((await at("2026-10-31T12:10:00.000Z")).reason, "expired");
      assert.notStrictEqual((await at("2026-10-31T12:09:59.000Z")).reason, "expired");
    });

    console.log("\nWho is not a new customer");
    await check("an account Admin created (phone sale) never gets it", async () => {
      const made = await makeCustomer({ minutesOld: 1, street: "1 Admin Ln", extra: { signupMethod: "admin" } });
      assert.strictEqual((await offer(made)).body.eligible, false);
    });
    await check("a former member (canceled membership) IS eligible", async () => {
      const prior = await makeCustomer({ minutesOld: 1, street: "5 Prior Ct" });
      await Subscription.create({ user: prior._id, userId: prior.userId, subscriptionType: "basic", addressId: prior.addresses[0]._id, status: "canceled", accessStatus: "inactive", planPrice: 149, startDate: new Date(), latestPaymentDate: new Date(), nextPaymentDate: new Date() });
      assert.strictEqual((await offer(prior)).body.eligible, true);
    });
    await check("an account with a live membership never gets it (it would bill twice)", async () => {
      const live = await makeCustomer({ minutesOld: 1, street: "6 Live Ct" });
      await Subscription.create({ user: live._id, userId: live.userId, subscriptionType: "basic", addressId: live.addresses[0]._id, status: "active", accessStatus: "active", planPrice: 149, startDate: new Date(), latestPaymentDate: new Date(), nextPaymentDate: new Date() });
      assert.strictEqual((await offer(live)).body.eligible, false);
    });
    await check("Stripe: a canceled old subscription is fine; a live one, or one bought with this offer, is not", async () => {
      const back = await makeCustomer({ minutesOld: 1, street: "8 Return Rd" });
      fake.customers.push({ id: "cus_returning", email: back.email });
      fake.subs.push({ id: "sub_old", customer: "cus_returning", status: "canceled", metadata: {} });
      assert.strictEqual((await offer(back)).body.eligible, true, "canceled");
      fake.subs.push({ id: "sub_pastdue", customer: "cus_returning", status: "past_due", metadata: {} });
      assert.strictEqual((await offer(back)).body.eligible, false, "past_due");
      const used = await makeCustomer({ minutesOld: 1, street: "9 Used Rd" });
      fake.customers.push({ id: "cus_used", email: used.email });
      fake.subs.push({ id: "sub_used", customer: "cus_used", status: "canceled", metadata: { welcomeOffer: "first_month_20" } });
      assert.strictEqual((await offer(used)).body.eligible, false, "redeemed before");
    });
    await check("a second account at a house that already USED the offer is refused at checkout", async () => {
      const owner = await makeCustomer({ minutesOld: 600, street: "44 Oak Street", zip: "11701" });
      fake.sessions.set("cs_paid_oak", { id: "cs_paid_oak", status: "complete" });
      await User.collection.updateOne({ _id: owner._id }, { $set: { welcomeOffer: { sessionId: "cs_paid_oak", addressId: String(owner.addresses[0]._id) } } });
      const formerOnly = await makeCustomer({ minutesOld: 1, street: "50 Oak Street", zip: "11701" });
      await Subscription.create({ user: formerOnly._id, userId: formerOnly.userId, subscriptionType: "plus", addressId: formerOnly.addresses[0]._id, status: "canceled", accessStatus: "inactive", planPrice: 249, startDate: new Date(), latestPaymentDate: new Date(), nextPaymentDate: new Date() });
      assert.strictEqual((await offer(formerOnly, `?addressId=${formerOnly.addresses[0]._id}`)).body.eligible, true, "a home with only an old membership is fine");
      const again = await makeCustomer({ minutesOld: 1, street: "44 oak st.", zip: "11701-2233" });
      assert.strictEqual((await offer(again, `?addressId=${again.addresses[0]._id}`)).body.eligible, false);
      assert.strictEqual((await offer(again, `?line1=${encodeURIComponent("44 Oak St")}&zip=11701`)).body.eligible, false);
      const res = await buy(again, { welcomeOffer: true });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.code, "WELCOME_OFFER_UNAVAILABLE");
      assert.match(res.body.message, /home has already used the 20% offer/);
    });
    await check("a neighbour at a different number on the same street is still eligible", async () => {
      const neighbour = await makeCustomer({ minutesOld: 1, street: "46 Oak Street", zip: "11701" });
      assert.strictEqual((await offer(neighbour, `?addressId=${neighbour.addresses[0]._id}`)).body.eligible, true);
    });
    await check("over gift coverage the first invoice is the $0 trial: no welcome price, refused if expected", async () => {
      const gifted = await makeCustomer({ minutesOld: 1, street: "9 Gift Pl" });
      giftCovered.add(String(gifted.addresses[0]._id));
      const res = await buy(gifted, { welcomeOffer: true });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.code, "WELCOME_OFFER_UNAVAILABLE");
      await clearLock(gifted);
      const plain = await buy(gifted, {});
      assert.strictEqual(plain.status, 200, "not shown the offer: the regular gift-deferred checkout, as before");
      const s = fake.created.at(-1);
      assert.strictEqual(s.config.discounts, undefined);
      assert.ok(s.config.subscription_data.trial_end, "billing still deferred over the gift");
    });

    console.log("\nThe Halloween campaign (existing customers)");
    const activate = (user, body = {}) => api(user, "POST", "/api/stripe/checkout/welcome-offer/activate", { campaign: "halloween-2026", ...body });
    const longtime = await makeCustomer({ minutesOld: 60 * 24 * 90, street: "70 Harbor Rd" });
    await check("an old account has no offer until it opens the campaign", async () => {
      assert.strictEqual((await offer(longtime)).body.eligible, false);
    });
    let opened;
    await check("opening the campaign while signed in starts ten minutes, server-side", async () => {
      const before = Date.now();
      opened = await activate(longtime);
      assert.strictEqual(opened.status, 200);
      assert.strictEqual(opened.body.eligible, true, JSON.stringify(opened.body));
      assert.strictEqual(opened.body.source, "halloween-2026");
      assert.strictEqual(opened.body.label, "Halloween Offer");
      const end = Date.parse(opened.body.expiresAt);
      assert.ok(end >= before + 10 * 60000 && end <= Date.now() + 10 * 60000 + 1000, "ten minutes from now");
    });
    await check("opening it again (another tab, another device) never restarts it", async () => {
      const again = await activate(longtime);
      assert.strictEqual(again.body.expiresAt, opened.body.expiresAt);
      assert.strictEqual(again.body.activation, "already_activated");
      assert.strictEqual((await offer(longtime)).body.expiresAt, opened.body.expiresAt);
    });
    await check("a campaign customer checks out at 20% off, monthly or annual", async () => {
      const res = await buy(longtime, { plan: "elite", billingCycle: "annual", welcomeOffer: true });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(invoices(fake.created.at(-1), 2), [399200, 499000]);
    });
    await check("when their ten minutes end, opening the link again does not bring it back", async () => {
      await User.collection.updateOne({ _id: longtime._id }, { $set: { "welcomeOfferActivation.expiresAt": new Date(Date.now() - 1000) } });
      const later = await activate(longtime);
      assert.strictEqual(later.body.eligible, false);
      assert.strictEqual(later.body.activation, "already_activated");
      await clearLock(longtime);
      const res = await buy(longtime, { welcomeOffer: true });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.code, "WELCOME_OFFER_ENDED");
    });
    await check("a live member opening the campaign gets nothing started", async () => {
      const member = await makeCustomer({ minutesOld: 60 * 24 * 30, street: "71 Harbor Rd" });
      await Subscription.create({ user: member._id, userId: member.userId, subscriptionType: "plus", addressId: member.addresses[0]._id, status: "active", accessStatus: "active", planPrice: 249, startDate: new Date(), latestPaymentDate: new Date(), nextPaymentDate: new Date() });
      const res = await activate(member);
      assert.strictEqual(res.body.eligible, false);
      assert.strictEqual(res.body.activation, "has_membership");
      assert.strictEqual((await User.collection.findOne({ _id: member._id })).welcomeOfferActivation, undefined);
    });
    await check("a former member opens it and is eligible", async () => {
      const former = await makeCustomer({ minutesOld: 60 * 24 * 200, street: "72 Harbor Rd" });
      await Subscription.create({ user: former._id, userId: former.userId, subscriptionType: "basic", addressId: former.addresses[0]._id, status: "canceled", accessStatus: "inactive", planPrice: 149, startDate: new Date(), latestPaymentDate: new Date(), nextPaymentDate: new Date() });
      assert.strictEqual((await activate(former)).body.eligible, true);
    });
    await check("someone who already redeemed it cannot open it again", async () => {
      const raw = (await User.collection.findOne({ _id: longtime._id })).welcomeOffer;
      fake.sessions.get(raw.sessionId).status = "complete";
      const other = await makeCustomer({ minutesOld: 60 * 24 * 5, street: "70 Harbor Road" });
      const res = await activate(other);
      assert.strictEqual(res.body.eligible, false, "same home, other account");
    });
    await check("nothing can be started after the campaign ends, or for an unknown campaign", async () => {
      const late = await makeCustomer({ minutesOld: 60 * 24 * 5, street: "73 Harbor Rd" });
      const ended = await welcome.activateCampaignOffer({ user: late.toObject(), campaignId: "halloween-2026", now: new Date("2026-11-03T05:00:00Z") });
      assert.strictEqual(ended.activated, false);
      assert.strictEqual(ended.reason, "campaign_ended");
      assert.strictEqual((await activate(late, { campaign: "made-up" })).body.eligible, false);
    });
    await check("the campaign's public facts: running, its end date, nothing personal", async () => {
      const res = await fetch(`${baseUrl}/api/stripe/checkout/welcome-offer/campaign/halloween-2026`);
      const body = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(body.endsAt, "2026-11-03T04:59:59.000Z");
      assert.strictEqual(typeof body.active, "boolean");
    });
    await check("without a session (a link preview, a sent message) nothing can be activated", async () => {
      const res = await fetch(`${baseUrl}/api/stripe/checkout/welcome-offer/activate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ campaign: "halloween-2026" }) });
      assert.strictEqual(res.status, 401);
    });

    console.log("\nThe coupon itself");
    await check("a coupon that is not exactly 20% once is never used", async () => {
      welcome.resetWelcomeOfferCaches();
      fake.coupons.set(welcome.WELCOME_COUPON_ID, { ...fake.coupons.get(welcome.WELCOME_COUPON_ID), percent_off: 25 });
      const odd = await makeCustomer({ minutesOld: 1, street: "3 Odd Ave" });
      const res = await buy(odd, { welcomeOffer: true });
      assert.strictEqual(res.status, 409);
      await clearLock(odd);
      const plain = await buy(odd, {});
      assert.strictEqual(plain.status, 200);
      assert.strictEqual(fake.created.at(-1).config.discounts, undefined);
      fake.coupons.set(welcome.WELCOME_COUPON_ID, { ...fake.coupons.get(welcome.WELCOME_COUPON_ID), percent_off: 20 });
      welcome.resetWelcomeOfferCaches();
    });
    await check("first-month rounding matches Stripe's percent-off to the cent", async () => {
      assert.strictEqual(welcome.firstMonthCents(14900), 11920);
      assert.strictEqual(welcome.firstMonthCents(14999), 11999);
      assert.strictEqual(welcome.firstMonthCents(12345), 9876);
    });
    await check("Admin's phone sale path (no welcomeOffer argument) is unchanged", async () => {
      const { openMembershipCheckout } = require("../utils/membershipCheckout");
      const buyer = await makeCustomer({ minutesOld: 1, street: "77 Phone Dr" });
      const { session, welcomeOfferApplied } = await openMembershipCheckout({ userId: buyer._id, plan: "basic", billingCycle: "monthly", addressId: String(buyer.addresses[0]._id), metadata: { adminInitiated: true } });
      assert.strictEqual(welcomeOfferApplied, false);
      assert.strictEqual(fake.sessions.get(session.id).config.allow_promotion_codes, true);
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
