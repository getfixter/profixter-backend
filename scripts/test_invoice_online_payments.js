/**
 * Online invoice payments - safety rules.
 *
 * No Stripe network calls and no money: the Stripe client is replaced with a
 * recording fake, so these tests are about the rules rather than the API.
 *
 * The three failures worth losing sleep over, all covered here:
 *   1. A payment recorded twice.
 *   2. A payment that pushes total payments past the invoice total, which the
 *      Invoice model rejects - the save fails and Stripe retries the webhook
 *      forever.
 *   3. A Stripe page still collecting an amount the invoice no longer expects.
 *
 *   node scripts/test_invoice_online_payments.js
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake_for_unit_tests";

const assert = require("assert");

/* ------------------------------------------------------------------ */
/* A recording Stripe fake. Nothing leaves the process.                */
/* ------------------------------------------------------------------ */

const calls = [];
const state = { failOn: null, invoices: new Map(), seq: 0 };

function record(name, args, options) {
  calls.push({ name, args, idempotencyKey: options?.idempotencyKey });
  if (state.failOn === name) throw new Error(`Injected Stripe failure on ${name}`);
}

const fakeStripe = {
  customers: {
    async create(args, options) {
      record("customers.create", args, options);
      return { id: `cus_fake_${++state.seq}` };
    },
  },
  invoiceItems: {
    async create(args, options) {
      record("invoiceItems.create", args, options);
      return { id: `ii_fake_${++state.seq}` };
    },
  },
  invoices: {
    async create(args, options) {
      record("invoices.create", args, options);
      const id = `in_fake_${++state.seq}`;
      state.invoices.set(id, { id, status: "draft", metadata: args.metadata });
      return state.invoices.get(id);
    },
    async finalizeInvoice(id, args, options) {
      record("invoices.finalizeInvoice", { id, ...args }, options);
      const invoice = state.invoices.get(id) || { id };
      invoice.status = "open";
      invoice.hosted_invoice_url = `https://invoice.stripe.test/${id}`;
      state.invoices.set(id, invoice);
      return invoice;
    },
    async voidInvoice(id) {
      record("invoices.voidInvoice", { id });
      const invoice = state.invoices.get(id);
      if (invoice) invoice.status = "void";
      return invoice;
    },
    async del(id) {
      record("invoices.del", { id });
      state.invoices.delete(id);
      return { id, deleted: true };
    },
    async retrieve(id) {
      record("invoices.retrieve", { id });
      return state.invoices.get(id) || { id, status: "open" };
    },
  },
};

// Replace the shared client before the module under test loads it.
const subsPath = require.resolve("../utils/subscriptionManagement");
require.cache[subsPath] = {
  id: subsPath,
  filename: subsPath,
  loaded: true,
  exports: { stripe: fakeStripe, hasStripeSecretKey: () => true },
};

const online = require("../utils/invoiceOnlinePayments");

let passed = 0;
const failures = [];

async function test(name, fn) {
  calls.length = 0;
  state.failOn = null;
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const $ = (dollars) => Math.round(dollars * 100);

/** A plain invoice-shaped object with just enough behaviour for these rules. */
function makeInvoice({ total = $(6700), payments = [], status = "Sent", link = null, dueDate = new Date("2026-08-12T12:00:00.000Z") } = {}) {
  return {
    dates: { dueDate },
    _id: "inv1",
    invoiceNumber: "000123",
    projectId: "proj1",
    version: 1,
    status,
    isArchived: false,
    invoiceTotalCents: total,
    payments: [...payments],
    customerSnapshot: { fullName: "Dana Whitfield", email: "dana@example.com" },
    customerId: null,
    onlinePayment: link || {},
    events: [],
    addEvent(event, _req, details) {
      this.events.push({ event, details });
    },
    markModified() {},
  };
}

const countCalls = (name) => calls.filter((c) => c.name === name).length;

async function main() {
  /* ---------------- amounts ---------------- */
  console.log("\nAmounts");

  await test("outstanding is derived from payments, not a stored field", () => {
    const invoice = makeInvoice({ payments: [{ amountCents: $(2000) }] });
    invoice.remainingBalanceCents = $(9999); // deliberately wrong
    assert.strictEqual(online.outstandingCents(invoice), $(4700));
  });

  await test("a fully paid invoice is not collectible", () => {
    const invoice = makeInvoice({ payments: [{ amountCents: $(6700) }] });
    assert.strictEqual(online.isCollectible(invoice), false);
  });

  await test("a voided invoice is never collectible", () =>
    assert.strictEqual(online.isCollectible(makeInvoice({ status: "Voided" })), false));

  await test("a superseded invoice is never collectible", () =>
    assert.strictEqual(online.isCollectible(makeInvoice({ status: "Superseded" })), false));

  /* ---------------- provisioning ---------------- */
  console.log("\nProvisioning the payment destination");

  await test("a send finalizes one Stripe invoice for the outstanding balance", async () => {
    const invoice = makeInvoice({ payments: [{ amountCents: $(2000) }] });
    const url = await online.ensureCollectible(invoice);
    assert.ok(url.startsWith("https://invoice.stripe.test/"));
    assert.strictEqual(invoice.onlinePayment.amountDueCents, $(4700), "must collect what is still owed");
    const item = calls.find((c) => c.name === "invoiceItems.create");
    assert.strictEqual(item.args.amount, $(4700), "Stripe was told the wrong amount");
    assert.strictEqual(countCalls("invoices.finalizeInvoice"), 1);
  });

  await test("resending reuses the destination instead of creating a second", async () => {
    const invoice = makeInvoice();
    const first = await online.ensureCollectible(invoice);
    const createdAfterFirst = countCalls("invoices.create");
    const second = await online.ensureCollectible(invoice);
    assert.strictEqual(second, first, "the hosted URL changed on resend");
    assert.strictEqual(countCalls("invoices.create"), createdAfterFirst, "a second Stripe invoice was created");
  });

  await test("every Stripe call carries an idempotency key", async () => {
    const invoice = makeInvoice();
    await online.ensureCollectible(invoice);
    for (const call of calls.filter((c) => c.name !== "invoices.retrieve")) {
      assert.ok(call.idempotencyKey, `${call.name} was sent without an idempotency key`);
    }
  });

  await test("metadata links the Stripe invoice back to ours and carries no personal data", async () => {
    const invoice = makeInvoice();
    await online.ensureCollectible(invoice);
    const created = calls.find((c) => c.name === "invoices.create");
    assert.strictEqual(created.args.metadata.profixterInvoiceId, "inv1");
    assert.strictEqual(created.args.metadata.profixterInvoiceNumber, "000123");
    assert.strictEqual(created.args.metadata.source, "profixter_invoice");
    const serialized = JSON.stringify(created.args.metadata);
    assert.ok(!/dana@example.com/i.test(serialized), "customer email leaked into metadata");
    assert.ok(!/Dana/i.test(serialized), "customer name leaked into metadata");
  });

  await test("a paid invoice cannot be given a payment page", async () => {
    const invoice = makeInvoice({ payments: [{ amountCents: $(6700) }] });
    await assert.rejects(() => online.ensureCollectible(invoice), /nothing left to collect/i);
    assert.strictEqual(countCalls("invoices.create"), 0);
  });

  await test("a voided invoice cannot be given a payment page", async () => {
    const invoice = makeInvoice({ status: "Voided" });
    await assert.rejects(() => online.ensureCollectible(invoice), /nothing left to collect/i);
  });

  await test("a Stripe failure records the reason and does not half-provision", async () => {
    const invoice = makeInvoice();
    state.failOn = "invoices.finalizeInvoice";
    await assert.rejects(() => online.ensureCollectible(invoice));
    assert.ok(invoice.onlinePayment.lastError, "the failure reason was not kept for the admin");
    assert.ok(!invoice.onlinePayment.hostedInvoiceUrl, "a URL survived a failed finalize");
  });

  await test("an invoice with no customer email is refused before touching Stripe", async () => {
    const invoice = makeInvoice();
    invoice.customerSnapshot.email = "";
    await assert.rejects(() => online.ensureCollectible(invoice), /no customer email/i);
    assert.strictEqual(countCalls("invoices.create"), 0);
  });

  /* ---------------- staleness ---------------- */
  console.log("\nKeeping Stripe and ProFixter in step");

  await test("editing the total invalidates the old destination", async () => {
    const invoice = makeInvoice();
    await online.ensureCollectible(invoice);
    const original = invoice.onlinePayment.stripeInvoiceId;

    invoice.invoiceTotalCents = $(7200); // admin edits after sending
    assert.strictEqual(online.destinationIsCurrent(invoice), false);
    const voided = await online.invalidateIfStale(invoice, "edited");
    assert.strictEqual(voided, true);
    assert.strictEqual(invoice.onlinePayment.stripeStatus, "void");
    assert.strictEqual(invoice.onlinePayment.hostedInvoiceUrl, "");
    assert.ok(calls.some((c) => c.name === "invoices.voidInvoice" && c.args.id === original));
  });

  await test("an offline payment invalidates the destination", async () => {
    const invoice = makeInvoice();
    await online.ensureCollectible(invoice);
    invoice.payments.push({ amountCents: $(2000) });
    assert.strictEqual(online.destinationIsCurrent(invoice), false);
    assert.strictEqual(await online.invalidateIfStale(invoice, "cheque"), true);
  });

  await test("reissuing after an edit produces exactly one collectible destination", async () => {
    const invoice = makeInvoice();
    await online.ensureCollectible(invoice);
    invoice.invoiceTotalCents = $(7200);
    await online.ensureCollectible(invoice);
    assert.strictEqual(invoice.onlinePayment.amountDueCents, $(7200));
    assert.strictEqual(countCalls("invoices.voidInvoice"), 1, "the superseded invoice was not voided");
    assert.strictEqual(countCalls("invoices.finalizeInvoice"), 2);
  });

  await test("an unchanged invoice is not needlessly reissued", async () => {
    const invoice = makeInvoice();
    await online.ensureCollectible(invoice);
    assert.strictEqual(await online.invalidateIfStale(invoice, "no change"), false);
    assert.strictEqual(countCalls("invoices.voidInvoice"), 0);
  });

  await test("voiding the invoice kills the payment page", async () => {
    const invoice = makeInvoice();
    await online.ensureCollectible(invoice);
    await online.voidDestination(invoice, "Invoice voided");
    assert.strictEqual(invoice.onlinePayment.hostedInvoiceUrl, "");
    assert.strictEqual(invoice.onlinePayment.stripeStatus, "void");
  });

  /* ---------------- recording money ---------------- */
  console.log("\nRecording money");

  const payment = (over = {}) => ({
    paymentIntentId: "pi_1",
    stripeInvoiceId: "in_1",
    eventId: "evt_1",
    amountCents: $(6700),
    paidAt: new Date("2026-08-12T12:00:00Z"),
    paymentMethodType: "card",
    ...over,
  });

  await test("a full payment is recorded once and clears the balance", () => {
    const invoice = makeInvoice();
    const result = online.recordStripePayment(invoice, payment());
    assert.strictEqual(result.applied, true);
    assert.strictEqual(result.appliedCents, $(6700));
    assert.strictEqual(invoice.payments.length, 1);
    assert.strictEqual(invoice.payments[0].provider, "stripe");
    assert.strictEqual(invoice.payments[0].method, "Credit Card");
    assert.strictEqual(online.outstandingCents(invoice), 0);
  });

  await test("the same PaymentIntent is never recorded twice", () => {
    const invoice = makeInvoice();
    online.recordStripePayment(invoice, payment());
    const second = online.recordStripePayment(invoice, payment({ eventId: "evt_2" }));
    assert.strictEqual(second.applied, false);
    assert.strictEqual(second.reason, "duplicate");
    assert.strictEqual(invoice.payments.length, 1, "a duplicate webhook created a second payment");
  });

  await test("a partial payment leaves the invoice partially paid", () => {
    const invoice = makeInvoice();
    online.recordStripePayment(invoice, payment({ amountCents: $(2000) }));
    assert.strictEqual(online.outstandingCents(invoice), $(4700));
    assert.strictEqual(online.isCollectible(invoice), true);
  });

  await test("two different payments both apply", () => {
    const invoice = makeInvoice();
    online.recordStripePayment(invoice, payment({ paymentIntentId: "pi_a", amountCents: $(2000) }));
    online.recordStripePayment(invoice, payment({ paymentIntentId: "pi_b", amountCents: $(4700) }));
    assert.strictEqual(invoice.payments.length, 2);
    assert.strictEqual(online.outstandingCents(invoice), 0);
  });

  await test("money collected beyond the balance is applied in part and surfaced, never lost", () => {
    // A cheque for $2,000 was recorded after the Stripe page was issued for the
    // full $6,700. Appending the whole $6,700 would exceed the invoice total,
    // and the model rejects that - the save would fail and Stripe would retry
    // this webhook forever.
    const invoice = makeInvoice({ payments: [{ amountCents: $(2000) }] });
    const result = online.recordStripePayment(invoice, payment());
    assert.strictEqual(result.applied, true);
    assert.strictEqual(result.appliedCents, $(4700), "must apply only what was owed");
    assert.strictEqual(result.unappliedCents, $(2000));
    assert.strictEqual(invoice.onlinePayment.unappliedCents, $(2000));

    const totalPaid = invoice.payments.reduce((sum, p) => sum + p.amountCents, 0);
    assert.ok(totalPaid <= invoice.invoiceTotalCents, "payments exceeded the invoice total");
    assert.strictEqual(online.outstandingCents(invoice), 0);
    assert.strictEqual(invoice.payments.at(-1).providerAmountCents, $(6700), "the full collected amount must stay on record");
    assert.ok(invoice.events.some((e) => e.event === "Online payment needs review"));
  });

  await test("a payment arriving after the invoice is settled is held for review", () => {
    const invoice = makeInvoice({ payments: [{ amountCents: $(6700) }] });
    const result = online.recordStripePayment(invoice, payment());
    assert.strictEqual(result.applied, false);
    assert.strictEqual(result.reason, "nothing_outstanding");
    assert.strictEqual(invoice.onlinePayment.unappliedCents, $(6700), "real money was discarded");
    assert.strictEqual(invoice.payments.length, 1);
  });

  await test("the outstanding balance can never go negative", () => {
    const invoice = makeInvoice({ payments: [{ amountCents: $(6000) }] });
    online.recordStripePayment(invoice, payment({ amountCents: $(5000) }));
    assert.strictEqual(online.outstandingCents(invoice), 0);
    assert.ok(online.outstandingCents(invoice) >= 0);
  });

  await test("a zero or negative amount is ignored", () => {
    const invoice = makeInvoice();
    assert.strictEqual(online.recordStripePayment(invoice, payment({ amountCents: 0 })).applied, false);
    assert.strictEqual(online.recordStripePayment(invoice, payment({ amountCents: -500 })).applied, false);
    assert.strictEqual(invoice.payments.length, 0);
  });

  await test("bank payments are recorded as ACH, not as a card", () => {
    const invoice = makeInvoice();
    online.recordStripePayment(invoice, payment({ paymentMethodType: "us_bank_account" }));
    assert.strictEqual(invoice.payments[0].method, "ACH / Bank Transfer");
  });

  await test("stripe identifiers are kept for audit", () => {
    const invoice = makeInvoice();
    online.recordStripePayment(invoice, payment());
    const p = invoice.payments[0];
    assert.strictEqual(p.stripePaymentIntentId, "pi_1");
    assert.strictEqual(p.stripeInvoiceId, "in_1");
    assert.strictEqual(p.stripeEventId, "evt_1");
    assert.ok(!/\d{13,}/.test(JSON.stringify(p)), "something card-number shaped was stored");
  });

  /* ---------------- due dates ---------------- */
  console.log("\nDue dates");

  const dayOf = (unix, tz) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(unix * 1000));

  await test("Stripe is given the invoice's own due date, not a 30 day default", async () => {
    const invoice = makeInvoice({ dueDate: new Date("2026-08-12T12:00:00.000Z") });
    await online.ensureCollectible(invoice);
    const created = calls.find((c) => c.name === "invoices.create");
    assert.ok(!("days_until_due" in created.args), "Stripe must not compute its own due date");
    assert.strictEqual(dayOf(created.args.due_date, "America/New_York"), "2026-08-12");
  });

  await test("the same calendar day is shown in New York and in UTC", () => {
    const unix = online.dueDateUnix(makeInvoice({ dueDate: new Date("2026-08-12T12:00:00.000Z") }));
    assert.strictEqual(dayOf(unix, "America/New_York"), "2026-08-12");
    assert.strictEqual(dayOf(unix, "UTC"), "2026-08-12", "the date must not shift for a UTC reader");
    assert.strictEqual(dayOf(unix, "America/Los_Angeles"), "2026-08-12");
  });

  await test("a due date stored late at night in New York does not roll forward", () => {
    // 2026-08-12T23:30 New York is 2026-08-13T03:30 UTC. Reading the calendar
    // day in UTC would say the 13th, which is the classic off by one.
    const unix = online.dueDateUnix(makeInvoice({ dueDate: new Date("2026-08-13T03:30:00.000Z") }));
    assert.strictEqual(dayOf(unix, "America/New_York"), "2026-08-12");
    assert.strictEqual(dayOf(unix, "UTC"), "2026-08-12");
  });

  await test("a due date stored just after midnight UTC does not roll back", () => {
    // 2026-08-12T00:30 UTC is still 2026-08-11 in New York.
    const unix = online.dueDateUnix(makeInvoice({ dueDate: new Date("2026-08-12T00:30:00.000Z") }));
    assert.strictEqual(dayOf(unix, "America/New_York"), "2026-08-11");
    assert.strictEqual(dayOf(unix, "UTC"), "2026-08-11");
  });

  await test("due today, tomorrow and in thirty days each map to their own day", () => {
    const cases = [
      ["2026-08-12T12:00:00.000Z", "2026-08-12"],
      ["2026-08-13T12:00:00.000Z", "2026-08-13"],
      ["2026-09-11T12:00:00.000Z", "2026-09-11"],
    ];
    for (const [stored, expected] of cases) {
      const unix = online.dueDateUnix(makeInvoice({ dueDate: new Date(stored) }));
      assert.strictEqual(dayOf(unix, "America/New_York"), expected, `${stored} produced the wrong day`);
    }
  });

  await test("a due date across the winter time change still holds", () => {
    // Standard time, where New York is UTC-5 rather than UTC-4.
    const unix = online.dueDateUnix(makeInvoice({ dueDate: new Date("2026-12-15T12:00:00.000Z") }));
    assert.strictEqual(dayOf(unix, "America/New_York"), "2026-12-15");
    assert.strictEqual(dayOf(unix, "UTC"), "2026-12-15");
  });

  await test("a missing or invalid due date is handled rather than crashing", () => {
    assert.strictEqual(online.dueDateUnix({ dates: {} }), null);
    assert.strictEqual(online.dueDateUnix({}), null);
    assert.strictEqual(online.dueDateUnix({ dates: { dueDate: new Date("nonsense") } }), null);
  });

  await test("changing the due date invalidates the destination", async () => {
    const invoice = makeInvoice({ dueDate: new Date("2026-08-12T12:00:00.000Z") });
    await online.ensureCollectible(invoice);
    assert.strictEqual(online.destinationIsCurrent(invoice), true);

    invoice.dates.dueDate = new Date("2026-08-20T12:00:00.000Z");
    assert.strictEqual(online.destinationIsCurrent(invoice), false, "a stale due date must not stand");
    assert.strictEqual(await online.invalidateIfStale(invoice, "due date changed"), true);
  });

  await test("reissuing after a due date change sends the new date and voids the old invoice", async () => {
    const invoice = makeInvoice({ dueDate: new Date("2026-08-12T12:00:00.000Z") });
    await online.ensureCollectible(invoice);
    invoice.dates.dueDate = new Date("2026-08-20T12:00:00.000Z");
    await online.ensureCollectible(invoice);
    assert.strictEqual(countCalls("invoices.voidInvoice"), 1, "the wrongly dated invoice was left collectible");
    const latest = calls.filter((c) => c.name === "invoices.create").pop();
    assert.strictEqual(dayOf(latest.args.due_date, "America/New_York"), "2026-08-20");
  });

  /* ---------------- paid out of band ---------------- */
  console.log("\nPaid out of band");

  await test("an invoice marked paid in Stripe is not a customer online payment", () => {
    const stripeInvoice = {
      id: "in_oob",
      status: "paid",
      paid_out_of_band: true,
      amount_paid: $(6700),
      payment_intent: null,
      payments: { data: [] },
    };
    const classification = online.classifyInvoicePayment(stripeInvoice);
    assert.strictEqual(classification.online, false);
    assert.strictEqual(classification.reason, "paid_out_of_band");
  });

  await test("a paid invoice with no PaymentIntent is never treated as collected online", () => {
    const classification = online.classifyInvoicePayment({
      id: "in_none",
      status: "paid",
      amount_paid: $(6700),
      payment_intent: null,
      payments: { data: [] },
    });
    assert.strictEqual(classification.online, false);
    assert.strictEqual(classification.reason, "no_payment_intent");
  });

  await test("no identifier is ever manufactured from the invoice id", () => {
    assert.strictEqual(online.extractPaymentIntentId({ id: "in_x", payment_intent: null }), null);
    assert.strictEqual(online.extractPaymentIntentId({ id: "in_x" }), null);
    assert.strictEqual(online.extractPaymentIntentId({ id: "in_x", payments: { data: [] } }), null);
  });

  await test("a real PaymentIntent is still recognised, in every shape Stripe returns it", () => {
    assert.strictEqual(online.extractPaymentIntentId({ payment_intent: "pi_str" }), "pi_str");
    assert.strictEqual(online.extractPaymentIntentId({ payment_intent: { id: "pi_obj" } }), "pi_obj");
    assert.strictEqual(
      online.extractPaymentIntentId({ payments: { data: [{ payment: { payment_intent: "pi_nested" } }] } }),
      "pi_nested"
    );
    assert.strictEqual(
      online.extractPaymentIntentId({ payments: { data: [{ payment: { payment_intent: { id: "pi_deep" } } }] } }),
      "pi_deep"
    );
  });

  await test("an out-of-band settlement creates no payment record and asks for review", () => {
    const invoice = makeInvoice();
    const result = online.flagOutOfBandSettlement(invoice, {
      reason: "paid_out_of_band",
      amountCents: $(6700),
      stripeInvoiceId: "in_oob",
    });
    assert.strictEqual(result.applied, false);
    assert.strictEqual(invoice.payments.length, 0, "a phantom online payment was recorded");
    assert.strictEqual(online.outstandingCents(invoice), $(6700), "the balance must not move");
    assert.ok(invoice.onlinePayment.lastError, "the admin was not told");
    assert.ok(invoice.events.some((e) => e.event === "Online payment needs review"));
    assert.strictEqual(invoice.onlinePayment.hostedInvoiceUrl, "", "a settled invoice must stop being payable");
  });

  await test("reconciliation refuses to invent a payment for an out-of-band invoice", async () => {
    const invoice = makeInvoice();
    await online.ensureCollectible(invoice);
    const id = invoice.onlinePayment.stripeInvoiceId;
    state.invoices.set(id, {
      id,
      status: "paid",
      paid_out_of_band: true,
      amount_paid: $(6700),
      payment_intent: null,
    });

    const result = await online.reconcileInvoice(invoice);
    assert.strictEqual(result.applied, false);
    assert.strictEqual(result.reason, "paid_out_of_band");
    assert.strictEqual(invoice.payments.length, 0, "reconciliation invented a payment");
    assert.strictEqual(online.outstandingCents(invoice), $(6700));
  });

  await test("reconciliation still refuses when Stripe returns no payment to verify", async () => {
    const invoice = makeInvoice();
    await online.ensureCollectible(invoice);
    const id = invoice.onlinePayment.stripeInvoiceId;
    state.invoices.set(id, { id, status: "paid", amount_paid: $(6700), payment_intent: null });
    const result = await online.reconcileInvoice(invoice);
    assert.strictEqual(result.applied, false);
    assert.strictEqual(result.reason, "no_payment_intent");
    assert.strictEqual(invoice.payments.length, 0);
  });

  /* ---------------- reconciliation ---------------- */
  console.log("\nReconciliation");

  await test("a lost webhook can be repaired from Stripe", async () => {
    const invoice = makeInvoice();
    await online.ensureCollectible(invoice);
    const id = invoice.onlinePayment.stripeInvoiceId;
    state.invoices.set(id, {
      id,
      status: "paid",
      amount_paid: $(6700),
      payment_intent: "pi_recovered",
      status_transitions: { paid_at: 1786000000 },
    });

    const result = await online.reconcileInvoice(invoice);
    assert.strictEqual(result.applied, true);
    assert.strictEqual(online.outstandingCents(invoice), 0);
    assert.strictEqual(invoice.onlinePayment.stripeStatus, "paid");
  });

  await test("reconciling twice does not double-record", async () => {
    const invoice = makeInvoice();
    await online.ensureCollectible(invoice);
    const id = invoice.onlinePayment.stripeInvoiceId;
    state.invoices.set(id, { id, status: "paid", amount_paid: $(6700), payment_intent: "pi_once" });
    await online.reconcileInvoice(invoice);
    await online.reconcileInvoice(invoice);
    assert.strictEqual(invoice.payments.length, 1);
  });

  await test("reconciling an unpaid invoice records nothing", async () => {
    const invoice = makeInvoice();
    await online.ensureCollectible(invoice);
    const result = await online.reconcileInvoice(invoice);
    assert.strictEqual(result.applied, false);
    assert.strictEqual(invoice.payments.length, 0);
  });

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
