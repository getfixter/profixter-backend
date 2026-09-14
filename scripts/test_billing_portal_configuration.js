/**
 * What the Customer Portal is allowed to offer an existing member.
 *
 * Existing members saw monthly only, because the portal fell through to Stripe's
 * account default configuration and that configuration listed one price per
 * product. Nothing in the codebase was wrong, and nothing could have caught it:
 * the offer lived in the Dashboard, and Stripe omits `products` from the API
 * response unless it is explicitly expanded.
 *
 * So the point of this suite is that the offer is now a thing in the repository
 * that can be asserted on: every plan, both cycles, no retired price, and the
 * deferral rules that keep Annual -> Monthly from becoming a refund question.
 *
 *   node scripts/test_billing_portal_configuration.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake_portal_config";

const assert = require("assert");
const path = require("path");

const {
  buildPortalConfigurationParams,
  allowedPortalPriceIds,
  resolveBillingPortalConfigurationId,
} = require(path.join(__dirname, "..", "utils", "billingPortalConfiguration.js"));
const {
  PLAN_CATALOG,
  RETIRED_PRICE_IDS,
} = require(path.join(__dirname, "..", "utils", "subscriptionManagement.js"));

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
    console.log(`  FAIL  ${name}`);
  }
}

const params = buildPortalConfigurationParams();
const su = params.features.subscription_update;
const productsById = Object.fromEntries(su.products.map((p) => [p.product, p]));

test("subscription updates are enabled at all", () => {
  assert.strictEqual(su.enabled, true);
  assert.deepStrictEqual(su.default_allowed_updates, ["price"]);
});

test("every plan is offered", () => {
  assert.strictEqual(su.products.length, 4);
  for (const [name, plan] of Object.entries(PLAN_CATALOG)) {
    assert.ok(productsById[plan.stripeProductId], `${name} is missing from the portal`);
  }
});

for (const [name, plan] of Object.entries(PLAN_CATALOG)) {
  test(`${name} offers BOTH monthly and annual`, () => {
    const offered = productsById[plan.stripeProductId].prices;
    assert.ok(
      offered.includes(plan.monthly.stripePriceId),
      `${name} monthly ${plan.monthly.stripePriceId} not offered`
    );
    assert.ok(
      offered.includes(plan.annual.stripePriceId),
      `${name} annual ${plan.annual.stripePriceId} not offered — this is the bug`
    );
    assert.strictEqual(offered.length, 2, `${name} offers ${offered.length} prices, expected 2`);
  });
}

test("all eight prices are offered and none repeats", () => {
  const ids = allowedPortalPriceIds();
  assert.strictEqual(ids.length, 8);
  assert.strictEqual(new Set(ids).size, 8, "a price id appears twice");
});

test("no retired price is ever offered", () => {
  const offered = new Set(allowedPortalPriceIds());
  for (const [cycle, plans] of Object.entries(RETIRED_PRICE_IDS)) {
    for (const [plan, id] of Object.entries(plans)) {
      assert.ok(!offered.has(id), `retired ${plan}/${cycle} price ${id} is offered in the portal`);
    }
  }
});

test("quantity cannot be adjusted", () => {
  // A membership covers one address. The live default configuration leaves this
  // on, which puts a quantity stepper next to every plan.
  for (const product of su.products) {
    assert.strictEqual(
      product.adjustable_quantity?.enabled,
      false,
      `${product.product} allows quantity changes`
    );
  }
});

test("downgrades and interval shortening wait for the period end", () => {
  const types = (su.schedule_at_period_end?.conditions || []).map((c) => c.type).sort();
  assert.deepStrictEqual(
    types,
    ["decreasing_item_amount", "shortening_interval"],
    "Annual -> Monthly would take effect immediately, stranding paid time"
  );
});

test("upgrades are invoiced with proration", () => {
  assert.strictEqual(su.proration_behavior, "always_invoice");
});

/*
 * Cancellation belongs to ProFixter's own flow, not to the Stripe portal.
 *
 * The portal cannot show a member what their Loyalty progress is worth, so a
 * cancellation reachable through it skips the one screen that might change
 * their mind — with facts, not a discount. Cancelling is still one tap in the
 * account area and still takes effect the same way.
 */
test("cancellation is not offered through the Stripe portal", () => {
  const cancel = params.features.subscription_cancel;
  assert.strictEqual(cancel.enabled, false);
});

/*
 * Turning cancellation off must not have cost members anything else. Each of
 * these is a thing the portal is genuinely better at than we are, and all of
 * them stay self-serve.
 */
test("everything else in the portal still works", () => {
  const features = params.features;
  assert.strictEqual(features.payment_method_update.enabled, true, "cards");
  assert.strictEqual(features.invoice_history.enabled, true, "receipts");
  assert.strictEqual(features.customer_update.enabled, true, "contact details");
  assert.strictEqual(features.subscription_update.enabled, true, "plan changes");
});

test("the portal keeps working when no configuration is pinned", () => {
  const before = process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID;
  delete process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID;
  assert.strictEqual(resolveBillingPortalConfigurationId(), null);

  process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = "  bpc_example  ";
  assert.strictEqual(resolveBillingPortalConfigurationId(), "bpc_example");

  process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = "   ";
  assert.strictEqual(resolveBillingPortalConfigurationId(), null, "whitespace should read as unset");

  if (before === undefined) delete process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID;
  else process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = before;
});

console.log(`\nbilling portal configuration: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f.name}\n        ${f.message}`);
  process.exit(1);
}
process.exit(0);
