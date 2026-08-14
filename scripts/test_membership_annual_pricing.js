/**
 * Annual membership pricing and Stripe price resolution.
 *
 * Annual checkout was dead in production for one reason: the annual Stripe price
 * ids in the plan map had been archived and, for Premium and Elite, deleted
 * outright, while the monthly ids beside them were fine. Nothing failed loudly.
 * Resolution reported success because it had found *an* id, and the request only
 * died later inside Stripe, so all four annual buttons returned a generic 500
 * and no test noticed.
 *
 * What is asserted here is therefore the shape of the mistake, not just the
 * values: that every plan resolves to a distinct id on each cycle, that no
 * retired id can be resolved for a new checkout, and that the annual amount is
 * exactly ten months of the monthly one so the price and the "pay for ten, get
 * twelve" promise cannot drift apart.
 *
 * Deterministic and offline by construction: no Stripe key, so resolution is
 * forced down the built-in map, which is the thing under test. Whether those ids
 * are still live in Stripe is a different question, answered against the real
 * account rather than in CI.
 *
 *   node scripts/test_membership_annual_pricing.js
 */

// Must be cleared before the module loads: it decides at load whether Stripe is
// reachable, and a key in the ambient environment would send resolution to the
// network and make this suite non-deterministic.
delete process.env.STRIPE_SECRET_KEY;
for (const plan of ["BASIC", "PLUS", "PREMIUM", "ELITE"]) {
  for (const cycle of ["MONTHLY", "ANNUAL"]) {
    delete process.env[`STRIPE_PRICE_${plan}_${cycle}`];
  }
}

const assert = require("assert");
const path = require("path");

const {
  ANNUAL_MONTHS_CHARGED,
  PLAN_CATALOG,
  PLAN_PRICES,
  PLAN_ANNUAL_PRICES,
  LEGACY_PRICE_MAP,
  RETIRED_PRICE_IDS,
  resolveStripePriceId,
  getPlanPrice,
  getPlanRank,
  getPlanAndBillingFromPrice,
} = require(path.join(__dirname, "..", "utils", "subscriptionManagement.js"));

const PLANS = ["basic", "plus", "premium", "elite"];
const CYCLES = ["monthly", "annual"];

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      throw new Error("test body returned a promise; use testAsync");
    }
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
    console.log(`  FAIL  ${name}`);
  }
}

const asyncTests = [];
function testAsync(name, fn) {
  asyncTests.push({ name, fn });
}

/* ------------------------------------------------------------------ */
/* The offer                                                           */
/* ------------------------------------------------------------------ */

test("annual charges ten months", () => {
  assert.strictEqual(ANNUAL_MONTHS_CHARGED, 10);
});

for (const plan of PLANS) {
  test(`${plan} annual is exactly ten months of monthly`, () => {
    const monthly = PLAN_PRICES[plan];
    const annual = PLAN_ANNUAL_PRICES[plan];
    assert.strictEqual(
      annual,
      monthly * ANNUAL_MONTHS_CHARGED,
      `${plan}: annual ${annual} is not ${ANNUAL_MONTHS_CHARGED} x ${monthly}`
    );
  });
}

test("the annual prices are the ones live in Stripe", () => {
  // Pinned deliberately. If Stripe changes, this fails and forces the catalog
  // and the marketing promise to be revisited together.
  assert.deepStrictEqual(PLAN_ANNUAL_PRICES, {
    basic: 1490,
    plus: 2490,
    premium: 3490,
    elite: 4990,
  });
});

test("monthly prices are untouched", () => {
  assert.deepStrictEqual(PLAN_PRICES, {
    basic: 149,
    plus: 249,
    premium: 349,
    elite: 499,
  });
});

/* ------------------------------------------------------------------ */
/* Price ids                                                           */
/* ------------------------------------------------------------------ */

test("every plan on every cycle has a price id", () => {
  for (const cycle of CYCLES) {
    for (const plan of PLANS) {
      const id = LEGACY_PRICE_MAP[cycle][plan];
      assert.ok(id && /^price_[A-Za-z0-9]+$/.test(id), `${plan}/${cycle} has no usable price id: ${id}`);
    }
  }
});

test("no price id is shared by two plans or cycles", () => {
  const seen = new Map();
  for (const cycle of CYCLES) {
    for (const plan of PLANS) {
      const id = LEGACY_PRICE_MAP[cycle][plan];
      assert.ok(!seen.has(id), `${id} is used by both ${seen.get(id)} and ${plan}/${cycle}`);
      seen.set(id, `${plan}/${cycle}`);
    }
  }
});

test("no retired price id is still being sold", () => {
  const live = new Set(CYCLES.flatMap((c) => PLANS.map((p) => LEGACY_PRICE_MAP[c][p])));
  for (const [cycle, plans] of Object.entries(RETIRED_PRICE_IDS)) {
    for (const [plan, id] of Object.entries(plans)) {
      assert.ok(!live.has(id), `retired ${plan}/${cycle} price ${id} is still in the sold map`);
    }
  }
});

test("retired price ids still map back to a plan", () => {
  // A subscription created against one of these must not crash the webhook:
  // upsert throws outright when a price cannot be mapped to a local plan.
  for (const [cycle, plans] of Object.entries(RETIRED_PRICE_IDS)) {
    for (const [plan, id] of Object.entries(plans)) {
      assert.deepStrictEqual(
        getPlanAndBillingFromPrice(id),
        { plan, billingCycle: cycle },
        `retired ${id} no longer maps to ${plan}/${cycle}`
      );
    }
  }
});

test("catalog and derived tables agree", () => {
  for (const plan of PLANS) {
    assert.strictEqual(PLAN_CATALOG[plan].monthly.price, PLAN_PRICES[plan]);
    assert.strictEqual(PLAN_CATALOG[plan].annual.price, PLAN_ANNUAL_PRICES[plan]);
    for (const cycle of CYCLES) {
      assert.strictEqual(PLAN_CATALOG[plan][cycle].stripePriceId, LEGACY_PRICE_MAP[cycle][plan]);
    }
  }
});

/* ------------------------------------------------------------------ */
/* Resolution: the thing the checkout route actually calls             */
/* ------------------------------------------------------------------ */

for (const cycle of CYCLES) {
  for (const plan of PLANS) {
    testAsync(`${cycle} ${plan} resolves to its own price`, async () => {
      const { priceId } = await resolveStripePriceId({ plan, billingCycle: cycle });
      assert.strictEqual(
        priceId,
        LEGACY_PRICE_MAP[cycle][plan],
        `${plan}/${cycle} resolved to ${priceId}`
      );
    });
  }
}

testAsync("annual never resolves to a monthly price", async () => {
  for (const plan of PLANS) {
    const { priceId } = await resolveStripePriceId({ plan, billingCycle: "annual" });
    const monthly = Object.values(LEGACY_PRICE_MAP.monthly);
    assert.ok(!monthly.includes(priceId), `${plan} annual resolved to a monthly price: ${priceId}`);
  }
});

testAsync("an unknown cycle falls back to monthly, not to nothing", async () => {
  const { priceId } = await resolveStripePriceId({ plan: "plus", billingCycle: "weekly" });
  assert.strictEqual(priceId, LEGACY_PRICE_MAP.monthly.plus);
});

testAsync("an unknown plan resolves to no price at all", async () => {
  const { priceId } = await resolveStripePriceId({ plan: "platinum", billingCycle: "annual" });
  assert.strictEqual(priceId, null);
});

/* ------------------------------------------------------------------ */
/* What a member is told they pay                                      */
/* ------------------------------------------------------------------ */

test("getPlanPrice answers per cycle", () => {
  for (const plan of PLANS) {
    assert.strictEqual(getPlanPrice(plan), PLAN_PRICES[plan], `${plan} default is not monthly`);
    assert.strictEqual(getPlanPrice(plan, "monthly"), PLAN_PRICES[plan]);
    assert.strictEqual(
      getPlanPrice(plan, "annual"),
      PLAN_ANNUAL_PRICES[plan],
      `${plan} annual would be shown the monthly figure beside a "/year" label`
    );
  }
});

test("getPlanPrice is safe on rubbish", () => {
  assert.strictEqual(getPlanPrice(null), 0);
  assert.strictEqual(getPlanPrice("platinum", "annual"), 0);
});

test("plan ranking is unchanged", () => {
  assert.deepStrictEqual(
    PLANS.map(getPlanRank),
    [1, 2, 3, 4]
  );
  assert.strictEqual(getPlanRank("platinum"), 0);
  assert.strictEqual(getPlanRank(null), 0);
});

(async () => {
  for (const { name, fn } of asyncTests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok    ${name}`);
    } catch (error) {
      failures.push({ name, message: error?.message || String(error) });
      console.log(`  FAIL  ${name}`);
    }
  }

  console.log(`\nmembership annual pricing: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`  FAIL  ${f.name}\n        ${f.message}`);
    process.exit(1);
  }
  process.exit(0);
})();
