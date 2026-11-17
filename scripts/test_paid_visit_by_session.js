/*
 * The proofs behind the browser's ChatGPT Ads conversions:
 *   GET /api/track/paid-visit-by-session   -> order_created
 *   GET /api/track/membership-by-session   -> subscription_created
 *
 * Each must answer ok ONLY to the signed-in owner, only when our record says
 * paid/active AND Stripe says complete and paid, never for a staff sale or a
 * $0 charge, and must return nothing beyond product, cents and currency.
 * No database, no Stripe: models and the Stripe client are replaced in the
 * require cache before the route loads.
 *
 *   node scripts/test_paid_visit_by_session.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
const assert = require("assert");
const path = require("path");
const jwt = require("jsonwebtoken");

const SESSION = "cs_test_a1B2c3D4e5F6g7H8i9J0";
const OWNER = "64b000000000000000000001";

let entitlement;
let subscription;
let session;
let stripeFails;
let stripeMissing;
let filters;

function stub(relative, exports) {
  const file = require.resolve(path.join(__dirname, "..", relative));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
/* findOne(filter) matches only when the filter names the owner. */
const finder = (getDoc) => ({
  findOne(filter) {
    filters.push(filter);
    const doc = getDoc();
    const result = doc && String(filter.user) === OWNER ? doc : null;
    return { select: () => ({ lean: async () => result }) };
  },
});
stub("models/VisitEntitlement.js", finder(() => entitlement));
stub("models/Subscription.js", finder(() => subscription));
stub("utils/subscriptionManagement.js", {
  stripe: {
    checkout: {
      sessions: {
        retrieve: async (id) => {
          if (stripeFails) throw new Error("stripe down");
          if (stripeMissing) throw Object.assign(new Error("No such checkout.session"), { statusCode: 404, code: "resource_missing" });
          return session && session.id === id ? session : null;
        },
      },
    },
  },
});

const router = require("../routes/track");
function handlers(routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath);
  assert(layer, `${routePath} is registered`);
  return layer.route.stack.map((s) => s.handle);
}

const tokenFor = (id, extra = {}) => jwt.sign({ id, ...extra }, process.env.JWT_SECRET);

/* Runs the route's middleware chain (limiter, optionalAuth, handler) on a fake request. */
async function call(routePath, query, token) {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    set(k, v) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return this.headers[k.toLowerCase()];
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const req = { query, headers, header: (n) => headers[n.toLowerCase()], ip: `10.0.0.${Math.floor(Math.random() * 250)}`, socket: {} };
  for (const handle of handlers(routePath)) {
    let advanced = false;
    await handle(req, res, () => {
      advanced = true;
    });
    if (!advanced) break;
  }
  return res;
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  entitlement = { kind: "one_time_handyman_visit" };
  subscription = { subscriptionType: "Basic", billingCycle: "monthly" };
  session = {
    id: SESSION,
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    amount_total: 9900,
    amount_subtotal: 9900,
    total_details: { amount_discount: 0 },
    currency: "usd",
    metadata: {},
  };
  stripeFails = false;
  stripeMissing = false;
  filters = [];
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

const VISIT = "/paid-visit-by-session";
const MEMBER = "/membership-by-session";
const owner = () => tokenFor(OWNER);

(async () => {
  /* ---------------- paid visit ---------------- */
  await test("visit: owner, paid: product, cents, currency and NOTHING else", async () => {
    const res = await call(VISIT, { session_id: SESSION }, owner());
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { ok: true, product: "one_time_visit", amountCents: 9900, currency: "USD" });
    assert.strictEqual(res.headers["cache-control"], "no-store");
  });
  await test("visit: lookup is scoped to the owner, a purchase, paid or used", async () => {
    await call(VISIT, { session_id: SESSION }, owner());
    const f = filters[0];
    assert.strictEqual(f.stripeCheckoutSessionId, SESSION);
    assert.strictEqual(String(f.user), OWNER);
    assert.strictEqual(f.source, "purchase");
    assert.deepStrictEqual(f.status, { $in: ["paid", "consumed"] });
  });
  await test("visit: Full Day reports product full_day", async () => {
    entitlement = { kind: "full_day_visit" };
    session.amount_total = 49900;
    const res = await call(VISIT, { session_id: SESSION }, owner());
    assert.deepStrictEqual(res.body, { ok: true, product: "full_day", amountCents: 49900, currency: "USD" });
  });
  await test("visit: signed out -> 401 (says nothing about the session), no lookup", async () => {
    const res = await call(VISIT, { session_id: SESSION });
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(res.body, { ok: false });
    assert.strictEqual(filters.length, 0);
  });
  await test("visit: another customer's token -> 404", async () => {
    const res = await call(VISIT, { session_id: SESSION }, tokenFor("64b000000000000000000099"));
    assert.strictEqual(res.statusCode, 404);
  });
  await test("visit: a purpose token (reauth) is not a sign-in -> 401", async () => {
    const res = await call(VISIT, { session_id: SESSION }, tokenFor(OWNER, { purpose: "reauth" }));
    assert.strictEqual(res.statusCode, 401);
  });
  await test("visit: forged token -> 401", async () => {
    const res = await call(VISIT, { session_id: SESSION }, jwt.sign({ id: OWNER }, "wrong-secret"));
    assert.strictEqual(res.statusCode, 401);
  });
  await test("visit: no paid entitlement (unpaid, failed, refunded) -> 404", async () => {
    entitlement = null;
    assert.strictEqual((await call(VISIT, { session_id: SESSION }, owner())).statusCode, 404);
  });
  await test("visit: Stripe unpaid, or session not complete -> 404", async () => {
    session.payment_status = "unpaid";
    assert.strictEqual((await call(VISIT, { session_id: SESSION }, owner())).statusCode, 404);
    session.payment_status = "paid";
    session.status = "open";
    assert.strictEqual((await call(VISIT, { session_id: SESSION }, owner())).statusCode, 404);
  });
  await test("visit: Stripe unreachable -> 500 (retry later), never a guess and never a final no", async () => {
    stripeFails = true;
    const res = await call(VISIT, { session_id: SESSION }, owner());
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.body, { ok: false });
  });
  await test("visit: Stripe has no such session -> 404", async () => {
    stripeMissing = true;
    assert.strictEqual((await call(VISIT, { session_id: SESSION }, owner())).statusCode, 404);
  });
  await test("visit: staff-initiated sale -> 404", async () => {
    session.metadata = { adminInitiated: "1" };
    assert.strictEqual((await call(VISIT, { session_id: SESSION }, owner())).statusCode, 404);
  });
  await test("visit: $0 charge -> 404", async () => {
    session.amount_total = 0;
    assert.strictEqual((await call(VISIT, { session_id: SESSION }, owner())).statusCode, 404);
  });
  await test("visit: malformed session id -> 400, no lookup", async () => {
    for (const session_id of [undefined, "", "abc", "cs_live_$where", `${SESSION}'`, { $ne: "" }]) {
      filters = [];
      const res = await call(VISIT, { session_id }, owner());
      assert.strictEqual(res.statusCode, 400, JSON.stringify(session_id));
      assert.strictEqual(filters.length, 0);
    }
  });

  /* ---------------- membership ---------------- */
  const member = () => {
    session.mode = "subscription";
    session.amount_subtotal = 14900;
    session.amount_total = 14900;
  };
  await test("membership: owner, active, paid: plan, cents, currency and NOTHING else", async () => {
    member();
    const res = await call(MEMBER, { session_id: SESSION }, owner());
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { ok: true, planId: "basic_monthly", amountCents: 14900, currency: "USD" });
    assert.strictEqual(res.headers["cache-control"], "no-store");
  });
  await test("membership: lookup is the ACTIVE membership created by this checkout, for the owner", async () => {
    member();
    await call(MEMBER, { session_id: SESSION }, owner());
    const f = filters[0];
    assert.strictEqual(f.stripeCheckoutSessionId, SESSION);
    assert.strictEqual(String(f.user), OWNER);
    assert.strictEqual(f.status, "active");
  });
  await test("membership: amount is charged before tax (discount applied)", async () => {
    member();
    session.total_details = { amount_discount: 2980 };
    session.amount_total = 12989; // incl. tax; not what is reported
    const res = await call(MEMBER, { session_id: SESSION }, owner());
    assert.strictEqual(res.body.amountCents, 11920);
  });
  await test("membership: annual plan id", async () => {
    member();
    subscription = { subscriptionType: "Elite", billingCycle: "annual" };
    const res = await call(MEMBER, { session_id: SESSION }, owner());
    assert.strictEqual(res.body.planId, "elite_annual");
  });
  await test("membership: no active membership from this checkout (pending, canceled, second bill) -> 404", async () => {
    member();
    subscription = null;
    assert.strictEqual((await call(MEMBER, { session_id: SESSION }, owner())).statusCode, 404);
  });
  await test("membership: $0 start (gift-covered / trial, no_payment_required) -> 404", async () => {
    member();
    session.payment_status = "no_payment_required";
    assert.strictEqual((await call(MEMBER, { session_id: SESSION }, owner())).statusCode, 404);
    session.payment_status = "paid";
    session.amount_subtotal = 0;
    session.amount_total = 0;
    assert.strictEqual((await call(MEMBER, { session_id: SESSION }, owner())).statusCode, 404);
  });
  await test("membership: Stripe unpaid or incomplete -> 404", async () => {
    member();
    session.payment_status = "unpaid";
    assert.strictEqual((await call(MEMBER, { session_id: SESSION }, owner())).statusCode, 404);
  });
  await test("membership: a one-time payment session is not a membership -> 404", async () => {
    member();
    session.mode = "payment";
    assert.strictEqual((await call(MEMBER, { session_id: SESSION }, owner())).statusCode, 404);
  });
  await test("membership: signed out -> 401, another customer -> 404", async () => {
    member();
    assert.strictEqual((await call(MEMBER, { session_id: SESSION })).statusCode, 401);
    assert.strictEqual((await call(MEMBER, { session_id: SESSION }, tokenFor("64b000000000000000000099"))).statusCode, 404);
  });
  await test("membership: Stripe unreachable -> 500", async () => {
    member();
    stripeFails = true;
    assert.strictEqual((await call(MEMBER, { session_id: SESSION }, owner())).statusCode, 500);
  });
  await test("membership: staff sale -> 404", async () => {
    member();
    session.metadata = { adminGiftRecipientId: "x" };
    assert.strictEqual((await call(MEMBER, { session_id: SESSION }, owner())).statusCode, 404);
  });

  console.log(`\n${passed}/${passed + failures.length} passed`);
  process.exit(failures.length ? 1 : 0);
})();
