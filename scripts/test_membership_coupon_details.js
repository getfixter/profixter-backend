/**
 * Discount detail on the membership-started Admin notification.
 *
 * The rule the owner asked for: dollars matter most. A 30% coupon on an annual
 * Premium plan must read "Discount: $447.00", not "30%", because the person
 * reading the email is reconciling a payment and a percentage of an amount they
 * cannot see is useless.
 *
 * Every figure here comes from Stripe. Nothing is calculated, so proration,
 * stacked discounts and rounding stay Stripe's answer rather than ours.
 *
 *   node scripts/test_membership_coupon_details.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const assert = require("assert");
const path = require("path");

/*
 * The webhook module reaches for Stripe and Mongo at load. Only the pure
 * discount helpers are under test, so they are read out of the module's
 * exports via a narrow harness rather than by booting the whole route.
 */
const webhook = require(path.join(__dirname, "..", "routes", "webhook.js"));
const {
  promotionAdminRows,
  promotionDetails,
  promotionDisplayName,
  promotionDurationNote,
} = webhook.__testables || {};

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

const rowsToObject = (rows) => Object.fromEntries(rows.map(([k, v]) => [k, v]));

/* A Checkout Session shaped the way Stripe actually sends it. */
function session({ amountTotal, amountDiscount = 0, discounts = [], metadata = {} }) {
  return {
    id: "cs_test_harness",
    amount_total: amountTotal,
    currency: "usd",
    payment_status: "paid",
    total_details: { amount_discount: amountDiscount },
    discounts,
    metadata,
  };
}

function subscriptionWith(invoice) {
  return {
    items: { data: [{ price: { unit_amount: 349000, currency: "usd", recurring: { interval: "year" } } }] },
    latest_invoice: invoice,
    currency: "usd",
  };
}

console.log("\nmembership coupon details\n");

/* ------------------------------------------------------------------ */

test("no coupon adds no rows at all", () => {
  const promotion = promotionDetails({
    session: session({ amountTotal: 349000 }),
    stripeSubscription: subscriptionWith(null),
    invoice: null,
    lineItems: [],
    currency: "usd",
  });
  assert.strictEqual(promotion.used, false, "a promotion was detected where there was none");
  const rows = promotionAdminRows({
    promotion, coupon: null, currency: "usd", amountPaid: 349000,
  });
  assert.deepStrictEqual(rows, [], "the ordinary notification gained rows it should not have");
});

test("a percentage promotion code shows dollars first", () => {
  const coupon = { id: "co_x", name: "Welcome 30", percent_off: 30, duration: "once" };
  const promotion = promotionDetails({
    session: session({
      amountTotal: 104300,
      amountDiscount: 44700,
      discounts: [{ discount: { coupon, promotion_code: { id: "promo_x", code: "WELCOME30" } } }],
    }),
    stripeSubscription: subscriptionWith(null),
    invoice: null,
    lineItems: [],
    currency: "usd",
  });

  const rows = rowsToObject(promotionAdminRows({
    promotion, coupon, currency: "usd", amountPaid: 104300,
  }));

  assert.strictEqual(rows.Promotion, "WELCOME30", "the typed code should be shown");
  assert.strictEqual(rows.Discount, "$447.00 (30% off)");
  assert.strictEqual(rows.Paid, "$1,043.00");
  assert.strictEqual(rows.Duration, undefined, "a one-off coupon should not mention duration");
});

test("a fixed dollar coupon reports the same way", () => {
  const coupon = { id: "co_y", name: "Fifty Off", amount_off: 5000, currency: "usd", duration: "once" };
  const promotion = promotionDetails({
    session: session({
      amountTotal: 19900,
      amountDiscount: 5000,
      discounts: [{ discount: { coupon, promotion_code: { id: "promo_y", code: "FIFTY" } } }],
    }),
    stripeSubscription: subscriptionWith(null),
    invoice: null, lineItems: [], currency: "usd",
  });

  const rows = rowsToObject(promotionAdminRows({
    promotion, coupon, currency: "usd", amountPaid: 19900,
  }));
  assert.strictEqual(rows.Promotion, "FIFTY");
  assert.strictEqual(rows.Discount, "$50.00", "a fixed coupon should not show a percentage");
  assert.strictEqual(rows.Paid, "$199.00");
});

test("the discount comes from Stripe's total, not from multiplying out a percentage", () => {
  // Stripe says 40000 even though 30% of 149000 would be 44700. Stripe wins,
  // because only Stripe knows about proration and stacked discounts.
  const coupon = { id: "co_z", percent_off: 30, duration: "once" };
  const promotion = promotionDetails({
    session: session({
      amountTotal: 109000,
      amountDiscount: 40000,
      discounts: [{ discount: { coupon, promotion_code: { id: "promo_z", code: "ODD" } } }],
    }),
    stripeSubscription: subscriptionWith(null),
    invoice: null, lineItems: [], currency: "usd",
  });
  const rows = rowsToObject(promotionAdminRows({
    promotion, coupon, currency: "usd", amountPaid: 109000,
  }));
  assert.strictEqual(rows.Discount, "$400.00 (30% off)", "the figure was recalculated locally");
});

test("the discount is read from the invoice when the session does not carry it", () => {
  const coupon = { id: "co_i", percent_off: 20, duration: "once" };
  const invoice = {
    amount_paid: 119200,
    total_discount_amounts: [{ amount: 29800, discount: { coupon } }],
  };
  const promotion = promotionDetails({
    session: { id: "cs_i", currency: "usd", total_details: {} },
    stripeSubscription: subscriptionWith(invoice),
    invoice,
    lineItems: [],
    currency: "usd",
  });
  const rows = rowsToObject(promotionAdminRows({
    promotion, coupon, currency: "usd", amountPaid: invoice.amount_paid,
  }));
  assert.strictEqual(rows.Discount, "$298.00 (20% off)");
  assert.strictEqual(rows.Paid, "$1,192.00");
});

test("a coupon with no promotion code falls back to its display name", () => {
  const coupon = { id: "co_named", name: "Neighborhood Partner", percent_off: 15, duration: "once" };
  const promotion = promotionDetails({
    session: session({
      amountTotal: 126650, amountDiscount: 22350,
      discounts: [{ discount: { coupon } }],
    }),
    stripeSubscription: subscriptionWith(null),
    invoice: null, lineItems: [], currency: "usd",
  });
  const rows = rowsToObject(promotionAdminRows({
    promotion, coupon, currency: "usd", amountPaid: 126650,
  }));
  assert.strictEqual(rows.Promotion, "Neighborhood Partner");
  assert.ok(!/co_named/.test(JSON.stringify(rows)), "a Stripe coupon id was exposed");
});

test("an unnamed coupon never falls back to a Stripe id", () => {
  const coupon = { id: "co_anonymous", percent_off: 10, duration: "once" };
  assert.strictEqual(
    promotionDisplayName({ used: true, promotionCodeUsed: "Not Available" }, coupon),
    "Applied at checkout"
  );
  assert.strictEqual(promotionDisplayName({ used: true, promotionCodeUsed: "" }, coupon),
    "Applied at checkout");
});

test("a fully discounted first payment still reports honestly", () => {
  const coupon = { id: "co_full", percent_off: 100, duration: "once" };
  const promotion = promotionDetails({
    session: session({
      amountTotal: 0, amountDiscount: 14900,
      discounts: [{ discount: { coupon, promotion_code: { id: "promo_f", code: "FIRSTFREE" } } }],
    }),
    stripeSubscription: subscriptionWith(null),
    invoice: null, lineItems: [], currency: "usd",
  });
  const rows = rowsToObject(promotionAdminRows({
    promotion, coupon, currency: "usd", amountPaid: 0,
  }));
  assert.strictEqual(rows.Promotion, "FIRSTFREE");
  assert.strictEqual(rows.Discount, "$149.00 (100% off)");
  assert.strictEqual(rows.Paid, "$0.00", "a zero payment should be stated, not omitted");
});

test("a recurring coupon says how long it lasts, and a one-off says nothing", () => {
  assert.strictEqual(promotionDurationNote({ duration: "once" }), "");
  assert.strictEqual(promotionDurationNote({ duration: "forever" }), "Applies to every payment");
  assert.strictEqual(
    promotionDurationNote({ duration: "repeating", duration_in_months: 3 }),
    "Applies to the first 3 months"
  );
  assert.strictEqual(
    promotionDurationNote({ duration: "repeating" }),
    "Applies to more than one payment"
  );
});

test("a repeating coupon carries its duration into the notification", () => {
  const coupon = { id: "co_r", percent_off: 25, duration: "repeating", duration_in_months: 6 };
  const promotion = promotionDetails({
    session: session({
      amountTotal: 11175, amountDiscount: 3725,
      discounts: [{ discount: { coupon, promotion_code: { id: "promo_r", code: "HALFYEAR" } } }],
    }),
    stripeSubscription: subscriptionWith(null),
    invoice: null, lineItems: [], currency: "usd",
  });
  const rows = rowsToObject(promotionAdminRows({
    promotion, coupon, currency: "usd", amountPaid: 11175,
  }));
  assert.strictEqual(rows.Duration, "Applies to the first 6 months");
});

test("no Stripe identifier reaches any rendered row", () => {
  const coupon = { id: "co_leak", name: "Test", percent_off: 10, duration: "once" };
  const promotion = promotionDetails({
    session: session({
      amountTotal: 134100, amountDiscount: 14900,
      discounts: [{ discount: { coupon, promotion_code: { id: "promo_leak", code: "TEN" } } }],
    }),
    stripeSubscription: subscriptionWith(null),
    invoice: null, lineItems: [], currency: "usd",
  });
  const serialized = JSON.stringify(promotionAdminRows({
    promotion, coupon, currency: "usd", amountPaid: 134100,
  }));
  assert.ok(!/\b(co_|promo_|cs_|sub_|in_|pi_|price_|prod_)[A-Za-z0-9]/.test(serialized),
    `a Stripe id appeared in the rows: ${serialized}`);
});

test("a missing amount paid omits the row rather than inventing a figure", () => {
  const coupon = { id: "co_m", percent_off: 5, duration: "once" };
  const promotion = promotionDetails({
    session: session({
      amountTotal: null, amountDiscount: 1000,
      discounts: [{ discount: { coupon, promotion_code: { id: "promo_m", code: "FIVE" } } }],
    }),
    stripeSubscription: subscriptionWith(null),
    invoice: null, lineItems: [], currency: "usd",
  });
  const rows = rowsToObject(promotionAdminRows({
    promotion, coupon, currency: "usd", amountPaid: null,
  }));
  assert.strictEqual(rows.Paid, undefined, "an unknown payment amount was rendered anyway");
  assert.strictEqual(rows.Discount, "$10.00 (5% off)");
});

console.log(`\nmembership coupon details: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f.name}\n        ${f.message}`);
  process.exit(1);
}
process.exit(0);
