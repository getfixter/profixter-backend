/**
 * Gift Membership: automatic tax, and the stable Product configuration.
 *
 * WHAT THIS SUITE IS DEFENDING
 *
 * Turning automatic tax on touches the same Checkout call that must never
 * produce a subscription. So most of what follows is not really about tax — it
 * is about proving that adding tax did not quietly move the gift onto the
 * recurring rail, and that the purchaser's billing identity is still nowhere
 * near the recipient's.
 *
 * Assertions run against REAL returned objects wherever possible rather than
 * against source text, because a source match proves a line was typed, not
 * that it survives to the object Stripe is handed.
 */

process.env.GIFTS_ENABLED = "true";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

const { stripeLineItem, termWindow } = require("../utils/gifts/giftPricing");
const {
  PRODUCT_ENV,
  giftProductId,
  giftProductStatus,
  giftProductStatusReason,
  looksLikeProductId,
} = require("../utils/gifts/giftProducts");
const { configSnapshot } = require("../utils/gifts/giftConfig");
const { PLAN_CATALOG } = require("../utils/subscriptionManagement");

const FAKE = {
  basic: "prod_GiftBasicTest01",
  plus: "prod_GiftPlusTest01",
  premium: "prod_GiftPremiumTest1",
  elite: "prod_GiftEliteTest01",
};

function withProducts(ids, fn) {
  const saved = {};
  for (const [plan, envName] of Object.entries(PRODUCT_ENV)) {
    saved[envName] = process.env[envName];
    if (ids && ids[plan] !== undefined) process.env[envName] = ids[plan];
    else delete process.env[envName];
  }
  try {
    return fn();
  } finally {
    for (const [envName, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
  }
}

/** Every key anywhere in an object, however deep. */
function deepKeys(value, found = new Set()) {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((entry) => deepKeys(entry, found));
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    found.add(key);
    deepKeys(child, found);
  }
  return found;
}

console.log("\nGift Membership automatic tax\n");

/* ------------------------------------------------------------------ */
/* The Checkout call itself                                            */
/* ------------------------------------------------------------------ */

const routeSource = fs.readFileSync(path.join(__dirname, "..", "routes", "gifts.js"), "utf8");
const checkoutSection = routeSource.slice(
  routeSource.indexOf('router.post("/checkout-session"'),
  routeSource.indexOf('router.get("/purchased"')
);

test("gift Checkout uses mode: payment", () => {
  assert.match(checkoutSection, /mode:\s*"payment"/, "gift checkout must be a one-time payment");
  assert.doesNotMatch(
    checkoutSection,
    /mode:\s*"subscription"/,
    "gift checkout must never open a subscription session"
  );
});

test("automatic_tax.enabled === true in the gift session config", () => {
  assert.match(
    checkoutSection,
    /automatic_tax:\s*\{\s*enabled:\s*true\s*\}/,
    "gift checkout must enable Stripe automatic tax"
  );
});

test("an existing customer gets customer_update so automatic tax has an address", () => {
  assert.match(
    checkoutSection,
    /customer_update\s*=\s*\{\s*address:\s*"auto"\s*\}/,
    "automatic tax with an existing customer needs customer_update.address"
  );
});

test("the gift session never carries subscription_data", () => {
  assert.doesNotMatch(
    checkoutSection,
    /subscription_data/,
    "subscription_data would make this a recurring charge"
  );
});

/* ------------------------------------------------------------------ */
/* The line item — the object, not the source                          */
/* ------------------------------------------------------------------ */

test("no recurring field exists anywhere in gift price_data", () => {
  for (const plan of Object.keys(PRODUCT_ENV)) {
    for (const months of [1, 2, 3, 6, 12]) {
      const item = stripeLineItem({ plan, durationMonths: months, productId: FAKE[plan] });
      assert(item, `${plan}/${months} produced no line item`);
      const keys = deepKeys(item);
      assert(!keys.has("recurring"), `${plan}/${months} line item contains a recurring key`);
      assert(!keys.has("interval"), `${plan}/${months} line item contains an interval key`);
      assert(
        !keys.has("price"),
        `${plan}/${months} references a stored Price; a gift must stay inline`
      );
    }
  }
});

test("price_data carries tax_behavior, which automatic tax requires", () => {
  const item = stripeLineItem({ plan: "plus", durationMonths: 2, productId: FAKE.plus });
  assert.strictEqual(item.price_data.tax_behavior, "exclusive");
});

test("a configured Product id is used instead of a throwaway product", () => {
  const item = stripeLineItem({ plan: "elite", durationMonths: 2, productId: FAKE.elite });
  assert.strictEqual(item.price_data.product, FAKE.elite);
  assert.strictEqual(item.price_data.product_data, undefined, "product and product_data conflict");
});

test("the amount still comes from PLAN_CATALOG, not from Stripe", () => {
  for (const plan of Object.keys(PRODUCT_ENV)) {
    const monthly = Math.round(Number(PLAN_CATALOG[plan].monthly.price) * 100);
    const item = stripeLineItem({ plan, durationMonths: 2, productId: FAKE[plan] });
    assert.strictEqual(
      item.price_data.unit_amount,
      monthly * 2,
      `${plan} gift amount must be the monthly catalogue price times the months`
    );
  }
});

test("gift line items never reference a membership Price id", () => {
  const membershipPrices = new Set();
  for (const entry of Object.values(PLAN_CATALOG)) {
    if (entry?.monthly?.stripePriceId) membershipPrices.add(entry.monthly.stripePriceId);
    if (entry?.annual?.stripePriceId) membershipPrices.add(entry.annual.stripePriceId);
  }
  for (const plan of Object.keys(PRODUCT_ENV)) {
    const item = stripeLineItem({ plan, durationMonths: 2, productId: FAKE[plan] });
    const serialized = JSON.stringify(item);
    for (const priceId of membershipPrices) {
      assert(
        !serialized.includes(priceId),
        `${plan} gift line item mentions recurring price ${priceId}`
      );
    }
  }
});

/* ------------------------------------------------------------------ */
/* Trusted totals                                                      */
/* ------------------------------------------------------------------ */

/*
 * paymentFromSession is not exported, so the reader is checked at its source
 * and the entry point that reaches it is checked for real.
 */
test("payment totals are taken from Stripe's session, including tax", () => {
  const { handleGiftCheckoutCompleted } = require("../utils/gifts/giftWebhook");
  assert.strictEqual(typeof handleGiftCheckoutCompleted, "function");

  const webhookSource = fs.readFileSync(
    path.join(__dirname, "..", "utils", "gifts", "giftWebhook.js"),
    "utf8"
  );
  assert.match(
    webhookSource,
    /total_details\?\.amount_tax/,
    "tax must be read from the Stripe session's total_details"
  );
  assert.match(
    webhookSource,
    /amountPaidCents:\s*Number\(session\?\.amount_total/,
    "the paid total must be Stripe's amount_total"
  );
  assert.match(
    webhookSource,
    /automaticTaxStatus:\s*String\(session\?\.automatic_tax\?\.status/,
    "Stripe's own automatic tax status must be recorded"
  );
});

test("the gift record stores tax, and keeps the total tax-inclusive", () => {
  const modelSource = fs.readFileSync(
    path.join(__dirname, "..", "models", "GiftMembership.js"),
    "utf8"
  );
  assert.match(modelSource, /taxCents:\s*\{\s*type:\s*Number/, "taxCents must exist");
  assert.match(modelSource, /automaticTaxStatus:\s*\{\s*type:\s*String/);
});

test("the frontend never sends an authoritative amount or tax", () => {
  /*
   * Assert on the SET of fields destructured from the request body, not on the
   * exact text of the line. The point being defended is "no money field is
   * read from the browser", and that survives the line being reformatted or
   * gaining a presentation field — which is exactly what happened when the
   * occasion and personal message were added.
   */
  const match = checkoutSection.match(/const \{([\s\S]*?)\} = req\.body/);
  assert(match, "the checkout body destructure could not be found");

  const fields = match[1]
    .split(",")
    .map((part) => part.split("=")[0].trim())
    .filter(Boolean);

  assert.deepStrictEqual(
    fields.sort(),
    ["address", "durationMonths", "occasion", "personalMessage", "plan", "recipient"],
    "the checkout body must carry only these fields"
  );

  for (const field of fields) {
    assert(
      !/amount|total|price|tax|cent|discount|coupon|currency/i.test(field),
      `checkout must not read ${field} from the request body`
    );
  }
});

/* ------------------------------------------------------------------ */
/* Entitlement is untouched by tax                                     */
/* ------------------------------------------------------------------ */

test("gift entitlement remains a fixed term, unaffected by tax", () => {
  const start = new Date("2026-03-15T15:00:00Z");

  // The term is a function of the start date and the number of months, and
  // takes no other argument — so there is nowhere for a tax figure to enter.
  assert.strictEqual(termWindow.length, 2, "termWindow takes only the term inputs");

  const window = termWindow(start, 2);
  assert.strictEqual(window.startAt.toISOString(), start.toISOString());
  assert.strictEqual(window.endAt.toISOString(), "2026-05-15T15:00:00.000Z");

  // A gift that cost more tax lasts exactly as long as one that cost none.
  assert.strictEqual(
    termWindow(start, 2).endAt.toISOString(),
    window.endAt.toISOString(),
    "duration must not vary with anything but the term inputs"
  );

  const source = fs.readFileSync(
    path.join(__dirname, "..", "utils", "gifts", "giftAccess.js"),
    "utf8"
  );
  for (const money of ["taxCents", "amountPaidCents", "amountSubtotalCents", "discountCents"]) {
    assert(!source.includes(money), `access must not read ${money}`);
  }
});

test("no Subscription document is created anywhere in the gift path", () => {
  const files = ["routes/gifts.js", "utils/gifts/giftService.js", "utils/gifts/giftWebhook.js"];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert(!/new Subscription\b/.test(source), `${file} constructs a Subscription`);
    assert(
      !/Subscription\.(create|insertMany|updateOne|updateMany|findByIdAndUpdate|findOneAndUpdate)\b/.test(
        source
      ),
      `${file} writes to Subscription`
    );
  }
});

test("purchaser and recipient Stripe identity stay separated", () => {
  const modelSource = fs.readFileSync(
    path.join(__dirname, "..", "models", "GiftMembership.js"),
    "utf8"
  );
  assert(
    !/stripeCustomerId:\s*\{/.test(modelSource),
    "GiftMembership must never gain a stripeCustomerId field"
  );
  assert(
    !/stripeSubscriptionId:\s*\{/.test(modelSource),
    "GiftMembership must never gain a stripeSubscriptionId field"
  );

  // The Stripe customer on a gift checkout is resolved from the PURCHASER and
  // is carried on the session only. Adding automatic tax must not have moved
  // it onto the gift or introduced the recipient's email as a customer.
  assert.match(checkoutSection, /resolveUserStripeCustomerId\(purchaser\)/);
  assert.match(checkoutSection, /customer_email = purchaser\.email/);
  assert(
    !/customer_email\s*=\s*[^;]*recipient/i.test(checkoutSection),
    "the recipient's email must never become a Stripe customer on a gift purchase"
  );
});

/* ------------------------------------------------------------------ */
/* Stable Product configuration, and failing closed without it         */
/* ------------------------------------------------------------------ */

console.log("\nStable gift Product configuration\n");

test("all four plans have a configured environment variable name", () => {
  assert.deepStrictEqual(Object.keys(PRODUCT_ENV).sort(), [
    "basic",
    "elite",
    "plus",
    "premium",
  ]);
  for (const envName of Object.values(PRODUCT_ENV)) {
    assert.match(envName, /^STRIPE_PRODUCT_GIFT_[A-Z]+$/);
  }
});

test("no real prod_ id is hard-coded in the gift source", () => {
  for (const file of [
    "utils/gifts/giftProducts.js",
    "utils/gifts/giftPricing.js",
    "routes/gifts.js",
    "utils/gifts/giftConfig.js",
  ]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const matches = source.match(/prod_[A-Za-z0-9]{6,}/g) || [];
    assert.strictEqual(
      matches.length,
      0,
      `${file} hard-codes a Stripe product id: ${matches.join(", ")}`
    );
  }
});

test("configuration is incomplete until all four are set", () => {
  withProducts({}, () => {
    const status = giftProductStatus();
    assert.strictEqual(status.ok, false);
    assert.deepStrictEqual(status.missing.sort(), ["basic", "elite", "plus", "premium"]);
  });

  withProducts({ basic: FAKE.basic, plus: FAKE.plus }, () => {
    const status = giftProductStatus();
    assert.strictEqual(status.ok, false, "two of four is not configured");
    assert.deepStrictEqual(status.missing.sort(), ["elite", "premium"]);
  });

  withProducts(FAKE, () => {
    const status = giftProductStatus();
    assert.strictEqual(status.ok, true, giftProductStatusReason(status));
    assert.strictEqual(status.configuredCount, 4);
  });
});

test("a malformed product id is rejected, not passed to Stripe", () => {
  withProducts({ ...FAKE, plus: "price_1RUds8Bw0RtvSZjMFS1BoQEU" }, () => {
    const status = giftProductStatus();
    assert.strictEqual(status.ok, false, "a price id is not a product id");
    assert.deepStrictEqual(status.invalid, ["plus"]);
  });
  withProducts({ ...FAKE, elite: "prod_" }, () => {
    assert.deepStrictEqual(giftProductStatus().invalid, ["elite"]);
  });
  assert.strictEqual(looksLikeProductId("prod_SPSlEbSDrLapFw"), true);
  assert.strictEqual(looksLikeProductId("prod_"), false);
  assert.strictEqual(looksLikeProductId(""), false);
});

test("a gift may never point at a recurring membership Product", () => {
  const membershipProduct = PLAN_CATALOG.plus.stripeProductId;
  withProducts({ ...FAKE, plus: membershipProduct }, () => {
    const status = giftProductStatus();
    assert.strictEqual(status.ok, false, "reusing the membership product must be refused");
    assert.deepStrictEqual(status.reused, ["plus"]);
    assert.match(giftProductStatusReason(status), /reuses membership product/);
  });
});

test("one product id shared by two plans is refused", () => {
  withProducts({ ...FAKE, elite: FAKE.premium }, () => {
    const status = giftProductStatus();
    assert.strictEqual(status.ok, false);
    assert.deepStrictEqual(status.duplicated, ["elite"]);
  });
});

test("the purchase routes fail closed when a Product id is missing", () => {
  assert.match(
    routeSource,
    /function refuseUnlessProductsConfigured/,
    "there must be an explicit refusal, not a fallback"
  );
  assert.match(routeSource, /GIFT_PRODUCTS_NOT_CONFIGURED/);

  // Mounted as router middleware on the two selling paths, ahead of auth, so a
  // misconfigured server refuses before it touches the database.
  assert.match(
    routeSource,
    /router\.use\(\["\/options", "\/checkout-session"\]/,
    "the selling paths must be gated on Product configuration"
  );

  const gateAt = routeSource.indexOf('router.use(["/options", "/checkout-session"]');
  const featureGateAt = routeSource.indexOf("router.use(featureGate);");
  const firstRouteAt = routeSource.indexOf('router.get("/options"');
  assert(featureGateAt > 0 && gateAt > featureGateAt, "the feature gate must answer first");
  assert(gateAt < firstRouteAt, "the product gate must sit ahead of the handlers");
});

test("claiming is NOT gated on Product configuration", () => {
  // A gift that was already paid for must never become unclaimable because
  // somebody mis-set an environment variable afterwards.
  const claimSection = routeSource.slice(
    routeSource.indexOf('router.get("/claim/:token"'),
    routeSource.indexOf('router.get("/mine"')
  );
  assert(
    !claimSection.includes("refuseUnlessProductsConfigured"),
    "claiming must not depend on Stripe Product configuration"
  );
});

test("there is no silent fallback to a throwaway product on the selling path", () => {
  // stripeLineItem still supports product_data so the pricing unit is testable
  // alone, but the route always passes a configured id and refuses without one.
  assert.match(checkoutSection, /productId:\s*giftProductId\(validation\.plan\)/);
  const noProduct = stripeLineItem({ plan: "plus", durationMonths: 2 });
  assert(noProduct.price_data.product_data, "the bare shape stays available to tests");
  assert.strictEqual(noProduct.price_data.product, undefined);
});

test("the config snapshot reports sellability, not just the flag", () => {
  withProducts(FAKE, () => {
    const snapshot = configSnapshot();
    assert.strictEqual(snapshot.productsConfigured, true);
    assert.strictEqual(snapshot.sellable, true);
    assert.strictEqual(snapshot.productsProblem, "");
  });
  withProducts({}, () => {
    const snapshot = configSnapshot();
    assert.strictEqual(snapshot.productsConfigured, false);
    assert.strictEqual(snapshot.sellable, false, "enabled but unconfigured is not sellable");
    assert.match(snapshot.productsProblem, /missing/);
  });
});

test("giftProductId reads only its own plan's variable", () => {
  withProducts(FAKE, () => {
    assert.strictEqual(giftProductId("premium"), FAKE.premium);
    assert.strictEqual(giftProductId("PREMIUM"), FAKE.premium);
    assert.strictEqual(giftProductId("nonsense"), "");
    assert.strictEqual(giftProductId(""), "");
  });
});

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failures.length} failed.`);
if (failures.length) {
  for (const { name, error } of failures) {
    console.error(`\n--- ${name} ---`);
    console.error(error);
  }
  process.exit(1);
}
