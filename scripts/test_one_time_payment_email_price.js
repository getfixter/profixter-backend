/*
 * Review fix 1 (2026-11-13): the One-Time Visit payment-received email must
 * print the amount with its "$". dd6708a dropped it and the email read
 * "We received your 99 payment". This renders the real template with the
 * exact price value the Stripe webhook passes.
 *
 * No network, no database.
 *
 *   node scripts/test_one_time_payment_email_price.js
 */
process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
const assert = require("assert");
const { TEMPLATES, toText } = require("../utils/emailService");
const { __testables: w } = require("../routes/webhook");

assert.equal(w.oneTimePaymentPriceLabel({ priceCents: 9900 }), "$99");
assert.equal(w.oneTimePaymentPriceLabel({ priceCents: 14900 }), "$149");
assert.equal(w.oneTimePaymentPriceLabel(null), "$99", "missing entitlement falls back to the $99 product price");

const rendered = TEMPLATES.one_time_visit_payment_received({
  name: "Pat",
  bookingNumber: "1234",
  price: w.oneTimePaymentPriceLabel({ priceCents: 9900 }),
  durationMinutes: 90,
});
const text = `${rendered.html || ""}\n${rendered.text || ""}`;
assert.ok(text.includes("We received your $99 payment"), "the email shows the dollar sign");
assert.ok(!/received your 99 payment/.test(text), "the bare number never reaches the customer");
if (typeof toText === "function" && rendered.html) {
  assert.ok(toText(rendered.html).includes("$99 payment"));
}

console.log("test_one_time_payment_email_price: all checks passed");
