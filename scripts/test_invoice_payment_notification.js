/**
 * The owner's "an invoice was paid online" email.
 *
 * Nothing is sent: the email is built as data and asserted on, so the contents
 * are pinned without a mail server, a database or Stripe.
 *
 * What matters here:
 *   1. The figures are the invoice's own, derived, not a stale stored field.
 *   2. No Stripe identifiers reach an email that has to be read at a glance.
 *   3. Money Stripe collected that could not be applied is never silent.
 *
 *   node scripts/test_invoice_payment_notification.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake_for_unit_tests";
process.env.MAIL_ADMIN = "owner@example.com";

const assert = require("assert");

// The module under test reaches invoiceOnlinePayments for the balance, which
// loads the shared Stripe client. Replace it so nothing can leave the process.
const subsPath = require.resolve("../utils/subscriptionManagement");
require.cache[subsPath] = {
  id: subsPath,
  filename: subsPath,
  loaded: true,
  exports: { stripe: {}, hasStripeSecretKey: () => true },
};

const {
  buildInvoicePaymentNotification,
} = require("../utils/invoicePaymentNotification");
const { renderAdminEventEmail } = require("../utils/adminLeadNotification");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const $ = (dollars) => Math.round(dollars * 100);

function makeInvoice({ total = $(6700), payments = [], status = "Partially Paid" } = {}) {
  return {
    _id: "inv1",
    invoiceNumber: "000123",
    status,
    invoiceTotalCents: total,
    payments: [...payments],
    customerSnapshot: { fullName: "Dana Whitfield", email: "dana@example.com" },
    projectSnapshot: { projectNumber: "PRJ-0042", workType: "Bathroom" },
    onlinePayment: { stripeInvoiceId: "in_live_secret", stripeCustomerId: "cus_live_secret" },
  };
}

const labelOf = (fields, label) => fields.find(([key]) => key === label)?.[1];

console.log("\nWhat the owner is told");

test("the email names the customer, the invoice and the project", () => {
  const invoice = makeInvoice({ payments: [{ amountCents: $(2000) }] });
  const { subject, fields } = buildInvoicePaymentNotification(invoice, {
    appliedCents: $(2000),
    method: "Credit Card",
    paidAt: new Date("2026-08-12T16:00:00Z"),
  });

  assert.match(subject, /Dana Whitfield/);
  assert.match(subject, /\$2,000\.00/, "the amount decides whether this is worth opening");
  // The invoice number moved out of the subject and into the body. It is an
  // internal identifier, and the subject has to be readable as a phone banner.
  assert.doesNotMatch(subject, /000123/);
  assert.strictEqual(labelOf(fields, "Customer"), "Dana Whitfield");
  assert.strictEqual(labelOf(fields, "Customer email"), "dana@example.com");
  assert.strictEqual(labelOf(fields, "Invoice"), "#000123");
  assert.strictEqual(labelOf(fields, "Project"), "PRJ-0042 (Bathroom)");
});

test("the amount paid and what is left are both stated", () => {
  const invoice = makeInvoice({ payments: [{ amountCents: $(2000) }] });
  const { fields } = buildInvoicePaymentNotification(invoice, { appliedCents: $(2000) });
  assert.strictEqual(labelOf(fields, "Amount paid"), "$2,000.00");
  assert.strictEqual(labelOf(fields, "Remaining balance"), "$4,700.00");
});

test("the balance is derived from the payments, not from a stored field", () => {
  const invoice = makeInvoice({ payments: [{ amountCents: $(2000) }] });
  invoice.remainingBalanceCents = $(9999); // deliberately wrong
  const { fields } = buildInvoicePaymentNotification(invoice, { appliedCents: $(2000) });
  assert.strictEqual(labelOf(fields, "Remaining balance"), "$4,700.00");
});

test("a settled invoice reports a zero balance and its resulting status", () => {
  const invoice = makeInvoice({ payments: [{ amountCents: $(6700) }], status: "Paid in Full" });
  const { fields } = buildInvoicePaymentNotification(invoice, { appliedCents: $(6700) });
  assert.strictEqual(labelOf(fields, "Remaining balance"), "$0.00");
  assert.strictEqual(labelOf(fields, "Invoice status"), "Paid in Full");
});

test("the payment method is reported as recorded on the invoice", () => {
  const invoice = makeInvoice({ payments: [{ amountCents: $(6700) }] });
  const card = buildInvoicePaymentNotification(invoice, {
    appliedCents: $(6700),
    method: "Credit Card",
  });
  assert.strictEqual(labelOf(card.fields, "Payment method"), "Credit Card");

  const ach = buildInvoicePaymentNotification(invoice, {
    appliedCents: $(6700),
    method: "ACH / Bank Transfer",
  });
  assert.strictEqual(labelOf(ach.fields, "Payment method"), "ACH / Bank Transfer");
});

test("the time is reported in New York, where the business is", () => {
  const invoice = makeInvoice();
  const { fields } = buildInvoicePaymentNotification(invoice, {
    appliedCents: $(6700),
    paidAt: new Date("2026-08-12T16:00:00Z"),
  });
  const paidAt = labelOf(fields, "Paid at");
  assert.match(paidAt, /Aug 12, 2026/);
  assert.match(paidAt, /12:00/, `expected noon in New York, got ${paidAt}`);
});

test("money that could not be applied is surfaced, never left silent", () => {
  const invoice = makeInvoice({ payments: [{ amountCents: $(6700) }] });
  const { fields } = buildInvoicePaymentNotification(invoice, {
    appliedCents: $(4700),
    unappliedCents: $(2000),
  });
  assert.match(labelOf(fields, "Needs review") || "", /\$2,000\.00/);
});

test("a clean payment adds no review noise", () => {
  const invoice = makeInvoice({ payments: [{ amountCents: $(6700) }] });
  const { fields } = buildInvoicePaymentNotification(invoice, { appliedCents: $(6700) });
  assert.strictEqual(labelOf(fields, "Needs review"), undefined);
});

test("no Stripe identifier reaches the email", () => {
  const invoice = makeInvoice({ payments: [{ amountCents: $(6700) }] });
  const notification = buildInvoicePaymentNotification(invoice, {
    appliedCents: $(6700),
    method: "Credit Card",
  });
  const rendered = renderAdminEventEmail(notification);
  const body = `${rendered.subject}\n${rendered.text}\n${rendered.html}`;
  for (const pattern of [/in_live_secret/, /cus_live_secret/, /\bpi_/, /\bcs_/, /\bevt_/]) {
    assert.ok(!pattern.test(body), `a Stripe identifier matching ${pattern} leaked into the email`);
  }
});

test("a missing customer or project degrades rather than rendering blanks", () => {
  const invoice = makeInvoice();
  invoice.customerSnapshot = { fullName: "", email: "" };
  invoice.projectSnapshot = {};
  const { fields, subject } = buildInvoicePaymentNotification(invoice, { appliedCents: $(100) });
  assert.strictEqual(labelOf(fields, "Customer"), "Not available");
  assert.strictEqual(labelOf(fields, "Project"), "Not available");
  // Medium importance: the amount leads, because that is what decides whether
  // this is worth opening. No longer shouted, and no invoice number in the
  // subject, which was an internal identifier doing no work there.
  assert.match(subject, /^Invoice Paid - \$100\.00 - Customer$/);
});

console.log(`\n${passed} passed, ${failures.length} failed.`);
if (failures.length) process.exit(1);
