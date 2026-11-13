/**
 * Admin membership actions: confirmed plan changes, cancellation, complimentary,
 * the legacy one-tap routes, plan status in lists, and no N+1 in GET /users.
 *
 *   node scripts/test_admin_customer_membership.js
 *
 * In-memory Mongo, the real admin router and auth middleware, and a fake Stripe
 * installed on the shared client (nothing reaches Stripe).
 */
Object.assign(process.env, {
  NODE_ENV: "test",
  S3_BUCKET: "test-bucket",
  AWS_REGION: "us-east-1",
  JWT_SECRET: "test-secret-admin-membership",
  STRIPE_SECRET_KEY: "sk_test_fake_never_called",
  MAIL_ADMIN: "owner@example.com",
  CLIENT_URL: "https://www.profixter.com",
});

const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../models/User");
const Subscription = require("../models/Subscription");
const AdminActivityLog = require("../models/AdminActivityLog");
const CustomerActionReceipt = require("../models/CustomerActionReceipt");
const { SECTIONS_VERSION } = require("../utils/adminAccess");
const sm = require("../utils/subscriptionManagement");

/* ------------------------------------------------------------ fake Stripe */
const PRICE = {
  basic: sm.PLAN_CATALOG.basic.monthly.stripePriceId,
  plus: sm.PLAN_CATALOG.plus.monthly.stripePriceId,
  premium: sm.PLAN_CATALOG.premium.monthly.stripePriceId,
};
const AMOUNT = { [PRICE.basic]: 14900, [PRICE.plus]: 24900, [PRICE.premium]: 34900 };
const fake = { subs: new Map(), schedules: new Map(), calls: [], previewAmount: 6700, down: false };
const record = (name, args) => fake.calls.push({ name, args });
const copy = (v) => JSON.parse(JSON.stringify(v));
function priceObj(id) {
  return { id, unit_amount: AMOUNT[id], recurring: { interval: "month" }, metadata: {} };
}
const stripe = sm.stripe;
stripe.subscriptions.retrieve = async (id) => {
  record("subscriptions.retrieve", [id]);
  const s = fake.subs.get(id);
  if (!s) throw Object.assign(new Error("No such subscription"), { statusCode: 404, code: "resource_missing" });
  return copy(s);
};
stripe.subscriptions.update = async (id, params, options) => {
  record("subscriptions.update", [id, params, options]);
  const s = fake.subs.get(id);
  if (params.items) s.items.data[0].price = priceObj(params.items[0].price);
  if ("cancel_at_period_end" in params) s.cancel_at_period_end = params.cancel_at_period_end;
  if ("cancel_at" in params) s.cancel_at = params.cancel_at === "" ? null : params.cancel_at;
  if (params.metadata) s.metadata = params.metadata;
  return copy(s);
};
stripe.subscriptions.list = async () => ({ data: [] });
stripe.prices.retrieve = async (id) => priceObj(id);
stripe.invoices.createPreview = async (params) => {
  record("invoices.createPreview", [params]);
  if (fake.down) throw Object.assign(new Error("down"), { statusCode: 503 });
  return { amount_due: fake.previewAmount, tax: 0, lines: { data: [{ amount: -3200, period: { end: 0 } }, { amount: 9900, period: { end: 0 } }] } };
};
stripe.subscriptionSchedules.create = async (params, options) => {
  record("subscriptionSchedules.create", [params, options]);
  const id = `sub_sched_${fake.schedules.size + 1}`;
  fake.schedules.set(id, { id, status: "active", metadata: {}, phases: [] });
  fake.subs.get(params.from_subscription).schedule = id;
  return copy(fake.schedules.get(id));
};
stripe.subscriptionSchedules.retrieve = async (id) => {
  const sched = copy(fake.schedules.get(id));
  for (const phase of sched.phases) for (const item of phase.items) item.price = priceObj(item.price);
  return sched;
};
stripe.subscriptionSchedules.update = async (id, params, options) => {
  record("subscriptionSchedules.update", [id, params, options]);
  Object.assign(fake.schedules.get(id), { phases: params.phases, metadata: params.metadata });
  return copy(fake.schedules.get(id));
};
stripe.subscriptionSchedules.release = async (id) => {
  record("subscriptionSchedules.release", [id]);
  for (const s of fake.subs.values()) if (s.schedule === id) s.schedule = null;
  return {};
};
const stripeWrites = () => fake.calls.filter((c) => c.name !== "subscriptions.retrieve" && c.name !== "invoices.createPreview");

/* ---------------------------------------------------------------- harness */
const app = express();
app.use(express.json());
app.use("/api/admin", require("../routes/admin"));

let base;
let passed = 0;
const failures = [];
async function test(name, fn) {
  await Promise.all([User.deleteMany({}), Subscription.deleteMany({}), AdminActivityLog.deleteMany({}), CustomerActionReceipt.deleteMany({})]);
  fake.subs.clear();
  fake.schedules.clear();
  fake.calls.length = 0;
  fake.down = false;
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.stack}`);
  }
}

const token = (user) => jwt.sign({ id: String(user._id), tv: 0 }, process.env.JWT_SECRET);
async function call(method, path, user, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { Authorization: `Bearer ${token(user)}` } : {}) },
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

let seq = 0;
const mk = (over = {}) => {
  seq += 1;
  return User.create({ userId: String(30000000 + seq), name: `User ${seq}`, email: `user${seq}@example.com`, role: "customer", ...over });
};
const owner = () => mk({ name: "Owner", email: "owner@example.com" });
const staff = (sections) => mk({ name: "Staff", role: "employee", adminSections: sections, adminSectionsVersion: SECTIONS_VERSION });
async function customer(over = {}) {
  const user = await mk({
    name: "Casey Customer",
    stripeCustomerId: "cus_casey",
    phone: "+16315550101",
    addresses: [{ label: "Home", line1: "12 Oak Street", city: "Massapequa", state: "NY", zip: "11758" }],
    ...over,
  });
  user.defaultAddressId = user.addresses[0]._id;
  await user.save();
  return user;
}
const DAY = 24 * 60 * 60 * 1000;
async function stripeMember(user, { plan = "basic", status = "active", cancelAtPeriodEnd = false } = {}) {
  const now = Date.now();
  const address = user.addresses[0];
  const local = await Subscription.create({
    user: user._id,
    userId: user.userId,
    subscriptionType: plan,
    addressId: address._id,
    stripeCustomerId: "cus_casey",
    stripeSubscriptionId: "sub_casey",
    stripePriceId: PRICE[plan],
    stripeSubscriptionItemId: "si_casey",
    billingCycle: "monthly",
    startDate: new Date(now - 40 * DAY),
    latestPaymentDate: new Date(now - 10 * DAY),
    nextPaymentDate: new Date(now + 20 * DAY),
    currentPeriodStart: new Date(now - 10 * DAY),
    currentPeriodEnd: new Date(now + 20 * DAY),
    status,
    accessStatus: ["active", "trialing"].includes(status) ? "active" : "inactive",
    cancelAtPeriodEnd,
  });
  fake.subs.set("sub_casey", {
    id: "sub_casey",
    customer: "cus_casey",
    status,
    cancel_at_period_end: cancelAtPeriodEnd,
    cancel_at: null,
    schedule: null,
    current_period_start: Math.floor((now - 10 * DAY) / 1000),
    current_period_end: Math.floor((now + 20 * DAY) / 1000),
    metadata: { addressId: String(address._id), localSubscriptionId: String(local._id) },
    items: { data: [{ id: "si_casey", quantity: 1, price: priceObj(PRICE[plan]) }] },
  });
  return local;
}
const home = (user) => `/api/admin/customers/${user._id}/addresses/${user.addresses[0]._id}`;
const uuid = () => require("crypto").randomUUID();

async function run() {
  console.log("\nPlan change: preview, then confirm");

  await test("preview shows the amount due now from Stripe's invoice preview, and changes nothing", async () => {
    const boss = await owner();
    const user = await customer();
    await stripeMember(user);
    const res = await call("POST", `${home(user)}/plan-change/preview`, boss, { plan: "plus" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.changeType, "upgrade");
    assert.equal(res.body.effective, "now");
    assert.equal(res.body.amountDueNowCents, 6700);
    assert.equal(res.body.creditCents, 3200);
    assert.deepEqual(res.body.current, { ...res.body.current, plan: "basic", cycle: "monthly", priceCents: 14900 });
    assert.deepEqual(res.body.requested, { plan: "plus", cycle: "monthly", priceCents: 24900 });
    assert.equal(res.body.nextRenewalAmountCents, 24900);
    assert.ok(res.body.previewToken && res.body.expiresAt);
    assert.ok(res.body.warnings.some((w) => w.code === "CHARGES_NOW"));
    const preview = fake.calls.find((c) => c.name === "invoices.createPreview").args[0];
    assert.equal(preview.subscription_details.proration_behavior, "always_invoice");
    assert.equal(stripeWrites().length, 0, "a preview never writes to Stripe");
  });

  await test("confirm applies the upgrade with Stripe idempotency keys and audits before/after", async () => {
    const boss = await owner();
    const user = await customer();
    await stripeMember(user);
    const preview = await call("POST", `${home(user)}/plan-change/preview`, boss, { plan: "plus" });
    const key = uuid();
    const res = await call("POST", `${home(user)}/plan-change/confirm`, boss, { previewToken: preview.body.previewToken, idempotencyKey: key });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.changeType, "upgrade");
    const update = fake.calls.find((c) => c.name === "subscriptions.update" && c.args[1].items);
    assert.equal(update.args[2].idempotencyKey, `pfx_plan_${key}:upgrade`);
    const local = await Subscription.findOne({ stripeSubscriptionId: "sub_casey" }).lean();
    assert.equal(local.subscriptionType, "plus");
    const log = await AdminActivityLog.findOne({ action: "Plan Changed" }).lean();
    assert.equal(String(log.actorUserId), String(boss._id));
    assert.deepEqual(log.details.before, { plan: "basic", cycle: "monthly" });
    assert.equal(log.details.after.plan, "plus");
    assert.equal(log.details.amountDueNowCents, 6700);
  });

  await test("a duplicate confirm with the same idempotencyKey calls Stripe once and replays the answer", async () => {
    const boss = await owner();
    const user = await customer();
    await stripeMember(user);
    const preview = await call("POST", `${home(user)}/plan-change/preview`, boss, { plan: "plus" });
    const body = { previewToken: preview.body.previewToken, idempotencyKey: uuid() };
    const first = await call("POST", `${home(user)}/plan-change/confirm`, boss, body);
    assert.equal(first.status, 200);
    const writes = stripeWrites().length;
    const second = await call("POST", `${home(user)}/plan-change/confirm`, boss, body);
    assert.equal(second.status, 200);
    assert.equal(second.body.replayed, true);
    assert.equal(stripeWrites().length, writes, "no second Stripe write");
    assert.equal(fake.calls.filter((c) => c.name === "subscriptions.update" && c.args[1].items).length, 1);
    assert.equal(await AdminActivityLog.countDocuments({ action: "Plan Changed" }), 1);
  });

  await test("the subscription changing between preview and confirm is 409 STALE and nothing is written", async () => {
    const boss = await owner();
    const user = await customer();
    const local = await stripeMember(user);
    const preview = await call("POST", `${home(user)}/plan-change/preview`, boss, { plan: "plus" });
    // A webhook lands in between (a renewal), touching the record.
    await new Promise((r) => setTimeout(r, 15));
    await Subscription.updateOne({ _id: local._id }, { $set: { latestInvoiceStatus: "paid" } });
    const res = await call("POST", `${home(user)}/plan-change/confirm`, boss, { previewToken: preview.body.previewToken, idempotencyKey: uuid() });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "STALE");
    assert.equal(stripeWrites().length, 0);
    assert.equal((await Subscription.findById(local._id).lean()).subscriptionType, "basic");
  });

  await test("a cancellation scheduled at Stripe after the preview is also STALE", async () => {
    const boss = await owner();
    const user = await customer();
    await stripeMember(user);
    const preview = await call("POST", `${home(user)}/plan-change/preview`, boss, { plan: "plus" });
    fake.subs.get("sub_casey").cancel_at_period_end = true;
    const res = await call("POST", `${home(user)}/plan-change/confirm`, boss, { previewToken: preview.body.previewToken, idempotencyKey: uuid() });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "STALE");
  });

  await test("an expired preview is refused (409 PREVIEW_EXPIRED); a tampered one is 400", async () => {
    const boss = await owner();
    const user = await customer();
    await stripeMember(user);
    const preview = await call("POST", `${home(user)}/plan-change/preview`, boss, { plan: "plus" });
    const payload = jwt.decode(preview.body.previewToken);
    const expired = jwt.sign({ ...payload, iat: payload.iat - 3600, exp: payload.iat - 1 }, `${process.env.JWT_SECRET}:admin_plan_change_preview`);
    const res = await call("POST", `${home(user)}/plan-change/confirm`, boss, { previewToken: expired, idempotencyKey: uuid() });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "PREVIEW_EXPIRED");
    const forged = jwt.sign({ ...payload, due: 0 }, "wrong-secret");
    assert.equal((await call("POST", `${home(user)}/plan-change/confirm`, boss, { previewToken: forged, idempotencyKey: uuid() })).body.code, "INVALID_PREVIEW");
    assert.equal(stripeWrites().length, 0);
  });

  await test("confirm without an idempotencyKey is refused", async () => {
    const boss = await owner();
    const user = await customer();
    await stripeMember(user);
    const preview = await call("POST", `${home(user)}/plan-change/preview`, boss, { plan: "plus" });
    const res = await call("POST", `${home(user)}/plan-change/confirm`, boss, { previewToken: preview.body.previewToken });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "IDEMPOTENCY_KEY_REQUIRED");
  });

  await test("a downgrade is scheduled for the renewal: nothing due now", async () => {
    const boss = await owner();
    const user = await customer();
    await stripeMember(user, { plan: "premium" });
    const preview = await call("POST", `${home(user)}/plan-change/preview`, boss, { plan: "basic" });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.effective, "period_end");
    assert.equal(preview.body.amountDueNowCents, 0);
    assert.equal(fake.calls.filter((c) => c.name === "invoices.createPreview").length, 0);
    const res = await call("POST", `${home(user)}/plan-change/confirm`, boss, { previewToken: preview.body.previewToken, idempotencyKey: uuid() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.effective, "period_end");
    assert.ok(fake.calls.some((c) => c.name === "subscriptionSchedules.update" && c.args[2]?.idempotencyKey?.endsWith(":schedule-update")));
  });

  await test("past-due, DB-only and no-membership homes cannot be previewed", async () => {
    const boss = await owner();
    const user = await customer();
    await stripeMember(user, { status: "past_due" });
    assert.equal((await call("POST", `${home(user)}/plan-change/preview`, boss, { plan: "plus" })).body.code, "PAYMENT_ISSUE");
    const other = await customer({ email: "other@example.com" });
    assert.equal((await call("POST", `${home(other)}/plan-change/preview`, boss, { plan: "plus" })).body.code, "NO_MEMBERSHIP");
  });

  await test("Stripe being down during preview is a clean 502 and nothing is written", async () => {
    const boss = await owner();
    const user = await customer();
    await stripeMember(user);
    fake.down = true;
    const res = await call("POST", `${home(user)}/plan-change/preview`, boss, { plan: "plus" });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, "STRIPE_UNAVAILABLE");
  });

  console.log("\nWho may change plans");

  await test("customerTargetsOnly: staff and owner records are refused; a customer gets 403; members.read alone cannot", async () => {
    const boss = await owner();
    const clerk = await staff(["customers"]);
    const viewer = await staff(["members"]);
    const colleague = await staff(["customers"]);
    colleague.addresses = [{ line1: "1 Staff Rd", city: "Babylon", state: "NY", zip: "11702" }];
    await colleague.save();
    const res = await call("POST", `/api/admin/customers/${colleague._id}/addresses/${colleague.addresses[0]._id}/plan-change/preview`, clerk, { plan: "plus" });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "FORBIDDEN_RECORD");
    assert.equal((await call("PUT", `/api/admin/users/${colleague._id}/address/${colleague.addresses[0]._id}/subscription`, clerk, { plan: "plus" })).status, 403);
    assert.equal((await call("PUT", `/api/admin/users/${boss._id}/address/${colleague.addresses[0]._id}/cancellation-date`, clerk, { cancelOnDate: "2030-01-01" })).status, 403);
    const user = await customer();
    await stripeMember(user);
    assert.equal((await call("POST", `${home(user)}/plan-change/preview`, viewer, { plan: "plus" })).status, 403);
    assert.equal((await call("POST", `${home(user)}/plan-change/preview`, user, { plan: "plus" })).status, 403);
    assert.equal((await call("POST", `${home(user)}/plan-change/preview`, clerk, { plan: "plus" })).status, 200);
  });

  console.log("\nLegacy one-tap routes refuse");

  await test("legacy PUT .../subscription refuses an upgrade, a cancel and a DB-only grant (428, nothing written)", async () => {
    const boss = await owner();
    const user = await customer();
    await stripeMember(user);
    const path = `/api/admin/users/${user._id}/address/${user.addresses[0]._id}/subscription`;
    for (const plan of ["plus", "Cancel", "basic"]) {
      const res = await call("PUT", path, boss, { plan });
      if (plan === "basic") {
        assert.equal(res.status, 200, "re-sending the current plan is not a change");
        assert.ok(Array.isArray(res.body.addressesDetailed));
      } else {
        assert.equal(res.status, 428, plan);
        assert.equal(res.body.code, "CONFIRMATION_REQUIRED");
      }
    }
    const bare = await customer({ email: "bare@example.com" });
    const grant = await call("PUT", `/api/admin/users/${bare._id}/address/${bare.addresses[0]._id}/subscription`, boss, { plan: "elite" });
    assert.equal(grant.status, 428);
    assert.equal(await Subscription.countDocuments({ user: bare._id }), 0, "no DB-only membership is ever created");
    assert.equal(stripeWrites().length, 0);
  });

  await test("legacy PUT .../cancellation-date refuses to set or clear; a no-op is 200", async () => {
    const boss = await owner();
    const user = await customer();
    await stripeMember(user);
    const path = `/api/admin/users/${user._id}/address/${user.addresses[0]._id}/cancellation-date`;
    const set = await call("PUT", path, boss, { cancelOnDate: "2030-01-15" });
    assert.equal(set.status, 428);
    assert.equal(set.body.code, "CONFIRMATION_REQUIRED");
    assert.equal((await call("PUT", path, boss, { cancelOnDate: null })).status, 200);
    assert.equal(stripeWrites().length, 0);
  });

  console.log("\nCancellation");

  await test("cancel at period end needs confirm, is audited with before/after and actor, and replays once", async () => {
    const clerk = await staff(["customers"]);
    const user = await customer();
    await stripeMember(user);
    const noConfirm = await call("POST", `${home(user)}/cancellation`, clerk, { mode: "period_end", idempotencyKey: uuid() });
    assert.equal(noConfirm.status, 428);
    const body = { mode: "period_end", confirm: true, idempotencyKey: uuid() };
    const res = await call("POST", `${home(user)}/cancellation`, clerk, body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.addressPlan.planStatus, "ending");
    const again = await call("POST", `${home(user)}/cancellation`, clerk, body);
    assert.equal(again.body.replayed, true);
    assert.equal(fake.calls.filter((c) => c.name === "subscriptions.update").length, 1);
    const log = await AdminActivityLog.findOne({ action: "Membership Cancellation Scheduled" }).lean();
    assert.equal(String(log.actorUserId), String(clerk._id));
    assert.equal(log.details.before.cancelAtPeriodEnd, false);
    assert.equal(log.details.after.cancelAtPeriodEnd, true);
  });

  await test("a cancellation date, then clearing it, are both audited", async () => {
    const boss = await owner();
    const user = await customer();
    await stripeMember(user);
    const set = await call("POST", `${home(user)}/cancellation`, boss, { mode: "date", date: "2030-03-10", confirm: true, idempotencyKey: uuid() });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.ok(fake.subs.get("sub_casey").cancel_at);
    const clear = await call("POST", `${home(user)}/cancellation`, boss, { mode: "clear", confirm: true, idempotencyKey: uuid() });
    assert.equal(clear.status, 200, JSON.stringify(clear.body));
    assert.equal(fake.subs.get("sub_casey").cancel_at, null);
    assert.ok(await AdminActivityLog.exists({ action: "Membership Cancellation Date Set" }));
    const cleared = await AdminActivityLog.findOne({ action: "Membership Cancellation Cleared" }).lean();
    assert.ok(cleared.details.before.cancelAt);
    assert.equal(cleared.details.after.cancelAt, null);
    assert.equal((await call("POST", `${home(user)}/cancellation`, boss, { mode: "date", date: "2001-01-01", confirm: true, idempotencyKey: uuid() })).body.code, "DATE_IN_PAST");
  });

  console.log("\nComplimentary");

  await test("complimentary is owner only, needs a reason and confirm", async () => {
    const boss = await owner();
    const clerk = await staff(["customers", "members"]);
    const user = await customer({ stripeCustomerId: undefined });
    assert.equal((await call("POST", `${home(user)}/complimentary`, clerk, { plan: "plus", reason: "Charity", confirm: true })).status, 403);
    assert.equal((await call("POST", `${home(user)}/complimentary`, boss, { plan: "plus", confirm: true })).body.code, "REASON_REQUIRED");
    assert.equal((await call("POST", `${home(user)}/complimentary`, boss, { plan: "plus", reason: "Charity" })).body.code, "CONFIRMATION_REQUIRED");
    const ok = await call("POST", `${home(user)}/complimentary`, boss, { plan: "plus", reason: "Charity raffle prize", confirm: true });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const sub = await Subscription.findOne({ user: user._id }).lean();
    assert.equal(sub.paymentMethod, "complimentary");
    assert.equal(sub.complimentary.reason, "Charity raffle prize");
    const log = await AdminActivityLog.findOne({ action: "Complimentary Membership Granted" }).lean();
    assert.equal(log.details.reason, "Charity raffle prize");
  });

  await test("complimentary is refused while any membership on the home has not ended (past due included)", async () => {
    const boss = await owner();
    for (const status of ["active", "past_due", "incomplete"]) {
      await Subscription.deleteMany({});
      const user = await customer({ email: `c-${status}@example.com`, stripeCustomerId: undefined });
      await stripeMember(user, { status });
      const res = await call("POST", `${home(user)}/complimentary`, boss, { plan: "elite", reason: "Goodwill", confirm: true });
      assert.equal(res.status, 409, status);
      assert.equal(res.body.code, "ADDRESS_HAS_MEMBERSHIP");
      assert.equal(await Subscription.countDocuments({ user: user._id }), 1);
    }
  });

  console.log("\nPlan status in lists");

  await test("past due shows as payment_issue and the customer is in the members filter (old /users keeps its shape)", async () => {
    const boss = await owner();
    const user = await customer();
    await stripeMember(user, { status: "past_due" });
    const ending = await customer({ email: "ending@example.com" });
    await Subscription.create({
      user: ending._id, userId: ending.userId, subscriptionType: "basic", addressId: ending.addresses[0]._id,
      startDate: new Date(), latestPaymentDate: new Date(), nextPaymentDate: new Date(Date.now() + 9 * DAY),
      currentPeriodEnd: new Date(Date.now() + 9 * DAY), cancelAtPeriodEnd: true, status: "active", accessStatus: "active",
    });
    await customer({ email: "none@example.com" });
    const members = await call("GET", "/api/admin/customers?filter=members", boss);
    assert.equal(members.status, 200, JSON.stringify(members.body));
    const ids = members.body.items.map((i) => i.id);
    assert.ok(ids.includes(String(user._id)) && ids.includes(String(ending._id)));
    assert.equal(ids.length, 2);
    const row = members.body.items.find((i) => i.id === String(user._id));
    assert.equal(row.addresses[0].planStatus, "payment_issue");
    assert.equal(members.body.items.find((i) => i.id === String(ending._id)).addresses[0].planStatus, "ending");
    const issues = await call("GET", "/api/admin/customers?filter=payment_issue", boss);
    assert.deepEqual(issues.body.items.map((i) => i.id), [String(user._id)]);
    const legacy = await call("GET", "/api/admin/users", boss);
    const legacyRow = legacy.body.find((u) => u._id === String(user._id));
    assert.equal(legacyRow.addressesDetailed[0].plan, null, "legacy plan field unchanged: only access-granting");
    assert.equal(legacyRow.addressesDetailed[0].planStatus, "payment_issue");
  });

  await test("the members needs-action collector lists payment issues and endings within 30 days", async () => {
    const collector = require("../utils/needsAction/collectors/members");
    const user = await customer();
    await stripeMember(user, { status: "past_due" });
    const later = await customer({ email: "later@example.com" });
    await Subscription.create({
      user: later._id, userId: later.userId, subscriptionType: "basic", addressId: later.addresses[0]._id,
      startDate: new Date(), latestPaymentDate: new Date(), nextPaymentDate: new Date(Date.now() + 60 * DAY),
      currentPeriodEnd: new Date(Date.now() + 60 * DAY), cancelAtPeriodEnd: true, status: "active", accessStatus: "active",
    });
    const out = await collector.collect({ now: new Date(), limit: 10 });
    assert.equal(collector.permission, "members.read");
    assert.equal(out.count, 1);
    assert.equal(out.items[0].kind, "member_payment_issue");
    assert.equal(out.items[0].severity, "problem");
    assert.equal(out.items[0].href, `/admin/customers/${user._id}`);
  });

  await test("GET /users no longer issues one Subscription query per customer", async () => {
    const boss = await owner();
    for (let i = 0; i < 12; i += 1) await customer({ email: `n${i}@example.com` });
    let subscriptionFinds = 0;
    const listener = (collection, method) => {
      if (collection === "subscriptions" && /^find/.test(method)) subscriptionFinds += 1;
    };
    mongoose.set("debug", listener);
    const res = await call("GET", "/api/admin/users", boss);
    mongoose.set("debug", false);
    assert.equal(res.status, 200);
    assert.ok(res.body.length >= 12);
    assert.equal(subscriptionFinds, 1, `expected 1 subscription query, saw ${subscriptionFinds}`);
  });
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await User.syncIndexes();
  await Subscription.syncIndexes();
  await CustomerActionReceipt.syncIndexes();
  const server = app.listen(0);
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
