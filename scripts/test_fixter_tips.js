/**
 * Fixter tips - the rules that decide who gets paid.
 *
 * No Stripe network calls, no database and no money: the Stripe client is a
 * recording fake and every other function under test is pure. These are about
 * the decisions, not the API.
 *
 * The failures worth losing sleep over, all covered here:
 *   1. A customer choosing which Fixter gets paid by editing a URL.
 *   2. A tip credited to the wrong Fixter because the context was guessed.
 *   3. A tip that never happens because the page could not resolve context.
 *   4. One payment recorded as two tips.
 *   5. A refund that leaves the totals overstating what was retained.
 *
 *   node scripts/test_fixter_tips.js
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-tip-tokens";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake_for_unit_tests";
process.env.CLIENT_URL = "https://www.profixter.com";
delete process.env.TIP_PAGE_URL;
delete process.env.STRIPE_TIP_PRICE_ID;

const assert = require("assert");

/* ------------------------------------------------------------------ */
/* A recording Stripe fake. Nothing leaves the process.                */
/* ------------------------------------------------------------------ */

const calls = [];
const state = { prices: [], seq: 0, failOn: null, priceCreates: 0 };

function record(name, args, options) {
  calls.push({ name, args, idempotencyKey: options?.idempotencyKey });
  if (state.failOn === name) throw new Error(`Injected Stripe failure on ${name}`);
}

const fakeStripe = {
  prices: {
    async list(args) {
      record("prices.list", args);
      const match = state.prices.filter((price) =>
        (args.lookup_keys || []).includes(price.lookup_key)
      );
      return { data: match.slice(0, args.limit || 10) };
    },
    async create(args, options) {
      record("prices.create", args, options);
      state.priceCreates += 1;
      const price = { id: `price_fake_${++state.seq}`, ...args };
      state.prices.push(price);
      return price;
    },
  },
  checkout: {
    sessions: {
      async create(args, options) {
        record("checkout.sessions.create", args, options);
        const id = `cs_fake_${++state.seq}`;
        return { id, url: `https://checkout.stripe.test/${id}` };
      },
    },
  },
};

const subsPath = require.resolve("../utils/subscriptionManagement");
require.cache[subsPath] = {
  id: subsPath,
  filename: subsPath,
  loaded: true,
  exports: { stripe: fakeStripe, hasStripeSecretKey: () => true },
};

const mongoose = require("mongoose");
const tips = require("../utils/fixterTips");
const { createTipToken, readTipToken } = require("../utils/tipToken");
const { safeTipUrl } = require("../utils/tipPage");
const { PERMISSIONS, permissionsForUser } = require("../middleware/authorize");

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

const ROMAN = {
  _id: "fixter1",
  name: "Roman Petrov",
  email: "roman@profixter.com",
  role: "employee",
  employeePosition: "Fixter",
  isActive: true,
};

const BOOKING = {
  _id: "booking1",
  bookingNumber: "10241",
  name: "Dana Whitfield",
  email: "dana@example.com",
  user: "user1",
  assignedFixterId: "fixter1",
};

function session(over = {}) {
  return {
    id: "cs_live_1",
    mode: "payment",
    payment_status: "paid",
    amount_total: $(20),
    currency: "usd",
    payment_intent: "pi_tip_1",
    customer_details: { name: "D Whitfield", email: "cardholder@example.com" },
    metadata: {
      productKind: "fixter_tip",
      fixterId: "fixter1",
      bookingId: "booking1",
      userId: "user1",
      source: "completion_email",
    },
    ...over,
  };
}

async function main() {
  /* ---------------- the token ---------------- */
  console.log("\nThe link the customer clicks");

  await test("a token round trips the identifiers it was issued for", () => {
    const token = createTipToken({ bookingId: "b1", fixterId: "f1", userId: "u1" });
    const claims = readTipToken(token);
    assert.strictEqual(claims.bookingId, "b1");
    assert.strictEqual(claims.fixterId, "f1");
    assert.strictEqual(claims.userId, "u1");
  });

  await test("the token does not reveal the ids it carries", () => {
    const token = createTipToken({ bookingId: "booking1", fixterId: "fixter1", userId: "user1" });
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    assert.ok(!decoded.includes("fixter1"), "the Fixter id is readable in the token");
    assert.ok(!decoded.includes("booking1"), "the booking id is readable in the token");
  });

  await test("a tampered token is rejected rather than resolving to something else", () => {
    const token = createTipToken({ bookingId: "b1", fixterId: "f1", userId: "u1" });
    const bytes = Buffer.from(token, "base64url");
    bytes[bytes.length - 1] ^= 0xff;
    assert.throws(() => readTipToken(bytes.toString("base64url")));
  });

  await test("a token cannot be forged without the secret", () => {
    const forged = Buffer.concat([
      Buffer.alloc(12),
      Buffer.alloc(16),
      Buffer.from(JSON.stringify({ v: 1, b: "", f: "attacker", u: "", exp: Date.now() + 1000 })),
    ]).toString("base64url");
    assert.throws(() => readTipToken(forged));
  });

  await test("an expired token is refused", () => {
    const token = createTipToken({
      bookingId: "b1",
      fixterId: "f1",
      userId: "u1",
      now: Date.now() - 400 * 24 * 60 * 60 * 1000,
    });
    assert.throws(() => readTipToken(token), /expired/i);
  });

  await test("garbage is refused without throwing something unreadable", () => {
    assert.throws(() => readTipToken("not-a-token"));
    assert.throws(() => readTipToken(""));
    assert.throws(() => readTipToken(null));
  });

  await test("the completion email link points at the tip page and carries a token", () => {
    const url = tips.tipUrlForBooking(BOOKING);
    assert.ok(url.startsWith("https://www.profixter.com/tip?t="), `unexpected URL: ${url}`);
    const token = decodeURIComponent(url.split("t=")[1]);
    assert.strictEqual(readTipToken(token).fixterId, "fixter1");
  });

  await test("a booking with no Fixter still gets a working tip link", () => {
    const url = tips.tipUrlForBooking({ _id: "booking2", user: "user2" });
    assert.ok(url.startsWith("https://www.profixter.com/tip"), `unexpected URL: ${url}`);
  });

  await test("no booking at all still gets the plain tip page rather than a broken link", () => {
    assert.strictEqual(tips.tipUrlForBooking(null), "https://www.profixter.com/tip");
  });

  await test("real Mongo ids survive the round trip as hex, not as bytes", async () => {
    // ObjectId.id is the raw twelve byte buffer. Reading it instead of the hex
    // string would put binary into the tip link and into Stripe metadata, and
    // the Fixter would never be found again on the way back.
    const fixterId = new mongoose.Types.ObjectId();
    const bookingId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    const url = tips.tipUrlForBooking({
      _id: bookingId,
      assignedFixterId: fixterId,
      user: userId,
    });
    const claims = readTipToken(decodeURIComponent(url.split("t=")[1]));
    assert.strictEqual(claims.fixterId, fixterId.toHexString());
    assert.strictEqual(claims.bookingId, bookingId.toHexString());
    assert.strictEqual(claims.userId, userId.toHexString());

    await tips.createTipCheckoutSession({
      fixter: { ...ROMAN, _id: fixterId },
      bookingId,
      userId,
    });
    const created = calls.find((c) => c.name === "checkout.sessions.create");
    assert.strictEqual(created.args.metadata.fixterId, fixterId.toHexString());
    assert.strictEqual(created.args.metadata.bookingId, bookingId.toHexString());
  });

  await test("only our own tip page survives the link guard", () => {
    // A tip email is opened with a card in hand, so a link that is not
    // provably ours is replaced rather than followed.
    const page = "https://www.profixter.com/tip";
    assert.strictEqual(safeTipUrl(`${page}?t=abc`), `${page}?t=abc`);
    assert.strictEqual(safeTipUrl(page), page);
    assert.strictEqual(safeTipUrl("https://evil.example.com/tip?t=abc"), page);
    assert.strictEqual(safeTipUrl("https://www.profixter.com.evil.test/tip"), page);
    assert.strictEqual(safeTipUrl("http://www.profixter.com/tip"), page);
    assert.strictEqual(safeTipUrl("javascript:alert(1)"), page);
    assert.strictEqual(safeTipUrl(""), page);
  });

  /* ---------------- who may see tips ---------------- */
  console.log("\nWho may see tips");

  await test("a Fixter may read tips but holds no admin permission", () => {
    const granted = permissionsForUser({ role: "employee", employeePosition: "Fixter" });
    assert.ok(granted.includes(PERMISSIONS.TIPS_READ));
    assert.ok(
      !granted.includes(PERMISSIONS.ADMIN),
      "a Fixter could assign tips, including to themselves"
    );
  });

  await test("a General Fixter may read tips and still cannot assign them", () => {
    const granted = permissionsForUser({
      role: "employee",
      employeePosition: "General Fixter",
    });
    assert.ok(granted.includes(PERMISSIONS.TIPS_READ));
    assert.ok(!granted.includes(PERMISSIONS.ADMIN));
  });

  await test("a customer holds no tip permission at all", () => {
    assert.deepStrictEqual(permissionsForUser({ role: "customer" }), []);
    assert.deepStrictEqual(permissionsForUser({}), []);
  });

  await test("an admin may both read and assign", () => {
    const granted = permissionsForUser({ role: "admin" });
    assert.ok(granted.includes(PERMISSIONS.TIPS_READ));
    assert.ok(granted.includes(PERMISSIONS.ADMIN));
  });

  /* ---------------- who may be tipped ---------------- */
  console.log("\nWho may be tipped");

  await test("a Fixter and a General Fixter are both eligible", () => {
    assert.strictEqual(tips.isEligibleFixter(ROMAN), true);
    assert.strictEqual(
      tips.isEligibleFixter({ ...ROMAN, employeePosition: "General Fixter" }),
      true
    );
  });

  await test("a customer, an admin and an employee with no position are not", () => {
    assert.strictEqual(tips.isEligibleFixter({ role: "customer", employeePosition: "Fixter" }), false);
    assert.strictEqual(tips.isEligibleFixter({ role: "admin", employeePosition: "Fixter" }), false);
    assert.strictEqual(tips.isEligibleFixter({ role: "employee", employeePosition: null }), false);
    assert.strictEqual(tips.isEligibleFixter(null), false);
  });

  await test("a Fixter who has left still earns their tips", () => {
    // The money was earned before the account was deactivated. Refusing it
    // would move the tip to the unassigned pile and misstate the books.
    assert.strictEqual(tips.isEligibleFixter({ ...ROMAN, isActive: false }), true);
  });

  /* ---------------- the checkout ---------------- */
  console.log("\nOpening the checkout");

  await test("the amount stays the customer's to choose", async () => {
    await tips.createTipCheckoutSession({ fixter: ROMAN, bookingId: "booking1", userId: "user1" });
    const price = state.prices[0];
    assert.ok(price, "no tip price was created");
    assert.strictEqual(price.custom_unit_amount.enabled, true, "the customer must pick the amount");
    assert.ok(!("unit_amount" in price), "a fixed amount was sent");
    const created = calls.find((c) => c.name === "checkout.sessions.create");
    assert.ok(!("amount" in created.args), "an amount was forced onto the session");
    assert.strictEqual(created.args.line_items[0].quantity, 1);
  });

  await test("attribution rides in metadata and no personal data goes with it", async () => {
    const created = (
      await (async () => {
        await tips.createTipCheckoutSession({
          fixter: ROMAN,
          bookingId: "booking1",
          userId: "user1",
          prefillEmail: "dana@example.com",
        });
        return calls.find((c) => c.name === "checkout.sessions.create");
      })()
    );
    assert.strictEqual(created.args.metadata.productKind, "fixter_tip");
    assert.strictEqual(created.args.metadata.fixterId, "fixter1");
    assert.strictEqual(created.args.metadata.bookingId, "booking1");
    const serialized = JSON.stringify(created.args.metadata);
    assert.ok(!/dana@example\.com/i.test(serialized), "a customer email leaked into metadata");
    assert.ok(!/Roman/i.test(serialized), "a Fixter name leaked into metadata");
  });

  await test("the PaymentIntent carries the same attribution as the session", async () => {
    await tips.createTipCheckoutSession({ fixter: ROMAN, bookingId: "booking1" });
    const created = calls.find((c) => c.name === "checkout.sessions.create");
    assert.deepStrictEqual(
      created.args.payment_intent_data.metadata,
      created.args.metadata,
      "a refund could not be traced back to the tip"
    );
  });

  await test("a refresh inside the attempt window reuses one Checkout Session", async () => {
    const now = Date.parse("2026-08-12T15:00:00Z");
    const first = tips.tipIdempotencyKey({ fixterId: "f1", bookingId: "b1", now });
    const refreshed = tips.tipIdempotencyKey({
      fixterId: "f1",
      bookingId: "b1",
      now: now + 60 * 1000,
    });
    assert.strictEqual(first, refreshed, "a refresh would create a second session");
  });

  await test("a genuinely later tip for the same visit is not blocked", () => {
    const now = Date.parse("2026-08-12T15:00:00Z");
    assert.notStrictEqual(
      tips.tipIdempotencyKey({ fixterId: "f1", bookingId: "b1", now }),
      tips.tipIdempotencyKey({ fixterId: "f1", bookingId: "b1", now: now + 3 * 60 * 60 * 1000 })
    );
  });

  await test("different bookings never share a session", () => {
    const now = Date.parse("2026-08-12T15:00:00Z");
    assert.notStrictEqual(
      tips.tipIdempotencyKey({ fixterId: "f1", bookingId: "b1", now }),
      tips.tipIdempotencyKey({ fixterId: "f1", bookingId: "b2", now })
    );
  });

  await test("every Stripe call for a known visit carries an idempotency key", async () => {
    await tips.createTipCheckoutSession({ fixter: ROMAN, bookingId: "booking1" });
    for (const call of calls.filter((c) => c.name !== "prices.list")) {
      assert.ok(call.idempotencyKey, `${call.name} was sent without an idempotency key`);
    }
  });

  await test("two strangers with no context never share a Checkout Session", async () => {
    /*
     * A shared idempotency key returns the FIRST session created under it.
     * Right for one customer refreshing their own link; catastrophic for two
     * unrelated visitors, where the second would be handed a session that may
     * already be paid and their tip would vanish.
     */
    await tips.createTipCheckoutSession({ fixter: null });
    await tips.createTipCheckoutSession({ fixter: null });
    const sessions = calls.filter((c) => c.name === "checkout.sessions.create");
    assert.strictEqual(sessions.length, 2);
    for (const call of sessions) {
      assert.ok(
        !call.idempotencyKey,
        "an unscoped tip reused a key, so one visitor could inherit another's session"
      );
    }
  });

  await test("one custom-amount price serves every tip, created once", async () => {
    // The id is memoised for the life of the process, as in production, so a
    // later checkout must not reach prices.create or even prices.list again.
    await tips.ensureTipPriceId();
    calls.length = 0;
    assert.ok(await tips.ensureTipPriceId(), "no tip price was resolved");
    assert.strictEqual(calls.length, 0, "a resolved tip price was looked up again");
    assert.strictEqual(state.priceCreates, 1, "more than one tip price was created");
  });

  await test("a configured price id is used as given, without touching Stripe", async () => {
    process.env.STRIPE_TIP_PRICE_ID = "price_configured";
    try {
      calls.length = 0;
      assert.strictEqual(await tips.ensureTipPriceId(), "price_configured");
      assert.strictEqual(calls.length, 0, "Stripe was called despite a configured price");
    } finally {
      delete process.env.STRIPE_TIP_PRICE_ID;
    }
  });

  await test("a tip with no resolvable Fixter still opens a working checkout", async () => {
    const result = await tips.createTipCheckoutSession({ fixter: null });
    assert.ok(result.url.startsWith("https://checkout.stripe.test/"));
    assert.strictEqual(result.attributed, false);
    const created = calls.find((c) => c.name === "checkout.sessions.create");
    assert.strictEqual(created.args.metadata.fixterId, "");
  });

  await test("an ineligible Fixter is dropped rather than paid", async () => {
    const result = await tips.createTipCheckoutSession({
      fixter: { _id: "u9", name: "Someone", role: "customer" },
      bookingId: "booking1",
    });
    assert.strictEqual(result.attributed, false);
    const created = calls.find((c) => c.name === "checkout.sessions.create");
    assert.strictEqual(created.args.metadata.fixterId, "", "a non-employee was about to be credited");
  });

  await test("a tip that cannot be attributed still remembers which visit it came from", async () => {
    // Not attribution: nothing is credited on the strength of it. It is the
    // evidence the admin needs to place the tip by hand afterwards.
    await tips.createTipCheckoutSession({
      fixter: { _id: "u9", name: "Someone", role: "customer" },
      bookingId: "booking1",
    });
    const created = calls.find((c) => c.name === "checkout.sessions.create");
    assert.strictEqual(created.args.metadata.bookingId, "booking1");
    assert.strictEqual(created.args.metadata.fixterId, "");
  });

  /* ---------------- recording the tip ---------------- */
  console.log("\nRecording the tip");

  await test("a paid session becomes a tip credited to the Fixter", () => {
    const record = tips.tipRecordFromCheckoutSession(session(), {
      fixter: ROMAN,
      booking: BOOKING,
      user: { _id: "user1", name: "Dana Whitfield", email: "dana@example.com" },
      eventId: "evt_1",
    });
    assert.strictEqual(record.fixter, "fixter1");
    assert.strictEqual(record.fixterNameSnapshot, "Roman Petrov");
    assert.strictEqual(record.amountCents, $(20));
    assert.strictEqual(record.status, "succeeded");
    assert.strictEqual(record.assignmentStatus, "attributed");
    assert.strictEqual(record.stripePaymentIntentId, "pi_tip_1");
  });

  await test("ProFixter's own customer data is not replaced by what Stripe collected", () => {
    const record = tips.tipRecordFromCheckoutSession(session(), {
      fixter: ROMAN,
      booking: BOOKING,
      user: { _id: "user1", name: "Dana Whitfield", email: "dana@example.com" },
    });
    assert.strictEqual(record.tipperName, "Dana Whitfield", "the cardholder name overwrote the customer");
    assert.strictEqual(record.tipperEmail, "dana@example.com", "the checkout email overwrote the customer");
  });

  await test("Stripe's details are used when we hold none of our own", () => {
    const record = tips.tipRecordFromCheckoutSession(session({ metadata: {} }), {});
    assert.strictEqual(record.tipperName, "D Whitfield");
    assert.strictEqual(record.tipperEmail, "cardholder@example.com");
    assert.strictEqual(record.tipperKind, "visitor");
  });

  await test("a tip with no identity at all is unknown, not invented", () => {
    const record = tips.tipRecordFromCheckoutSession(
      session({ customer_details: {}, metadata: {} }),
      {}
    );
    assert.strictEqual(record.tipperKind, "unknown");
    assert.strictEqual(record.tipperName, "");
    assert.strictEqual(record.tipperEmail, "");
  });

  await test("an unassignable tip still records the booking it came from", () => {
    const record = tips.tipRecordFromCheckoutSession(session(), {
      fixter: null,
      booking: BOOKING,
    });
    assert.strictEqual(record.assignmentStatus, "unassigned");
    assert.strictEqual(record.booking, "booking1");
    assert.strictEqual(record.bookingNumberSnapshot, "10241");
    assert.strictEqual(record.tipperKind, "customer");
  });

  await test("a Fixter that no longer validates lands in the unassigned pile", () => {
    const record = tips.tipRecordFromCheckoutSession(session(), { fixter: null });
    assert.strictEqual(record.fixter, null);
    assert.strictEqual(record.assignmentStatus, "unassigned");
    assert.ok(record.unassignedReason, "the admin was told nothing about why");
  });

  await test("a tip with no context is unassigned and says so", () => {
    const record = tips.tipRecordFromCheckoutSession(session({ metadata: {} }), {});
    assert.strictEqual(record.assignmentStatus, "unassigned");
    assert.match(record.unassignedReason, /without Fixter context/i);
  });

  await test("an unpaid session is recorded as pending, never as money received", () => {
    const record = tips.tipRecordFromCheckoutSession(
      session({ payment_status: "unpaid" }),
      { fixter: ROMAN }
    );
    assert.strictEqual(record.status, "pending");
  });

  await test("only our own sessions are treated as tips", () => {
    assert.strictEqual(tips.isFixterTipCheckoutSession(session()), true);
    assert.strictEqual(
      tips.isFixterTipCheckoutSession(session({ metadata: { productKind: "one_time_handyman_visit" } })),
      false
    );
    assert.strictEqual(tips.isFixterTipCheckoutSession(session({ mode: "subscription" })), false);
    assert.strictEqual(tips.isFixterTipCheckoutSession({}), false);
  });

  /* ---------------- refunds ---------------- */
  console.log("\nRefunds");

  const tipDoc = (over = {}) => ({
    amountCents: $(20),
    refundedCents: 0,
    refundStatus: "",
    status: "succeeded",
    ...over,
  });

  await test("a full refund reduces the tip to nothing but keeps the record", () => {
    const tip = tipDoc();
    const result = tips.applyRefundToTip(tip, { amount_refunded: $(20) });
    assert.strictEqual(result.changed, true);
    assert.strictEqual(tip.status, "refunded");
    assert.strictEqual(tip.refundStatus, "full");
    assert.strictEqual(tips.netCents(tip), 0);
    assert.strictEqual(tip.amountCents, $(20), "the original amount must stay on record");
  });

  await test("a partial refund reduces by exactly the cents refunded", () => {
    const tip = tipDoc();
    tips.applyRefundToTip(tip, { amount_refunded: $(5) });
    assert.strictEqual(tip.status, "partially_refunded");
    assert.strictEqual(tips.netCents(tip), $(15));
  });

  await test("a redelivered refund event changes nothing", () => {
    const tip = tipDoc();
    tips.applyRefundToTip(tip, { amount_refunded: $(5) });
    const second = tips.applyRefundToTip(tip, { amount_refunded: $(5) });
    assert.strictEqual(second.changed, false);
    assert.strictEqual(tips.netCents(tip), $(15));
  });

  await test("a second partial refund adds to the first", () => {
    const tip = tipDoc();
    tips.applyRefundToTip(tip, { amount_refunded: $(5) });
    tips.applyRefundToTip(tip, { amount_refunded: $(12) });
    assert.strictEqual(tips.netCents(tip), $(8));
    assert.strictEqual(tip.refundStatus, "partial");
  });

  await test("a refund can never take a tip negative", () => {
    const tip = tipDoc();
    tips.applyRefundToTip(tip, { amount_refunded: $(500) });
    assert.strictEqual(tip.refundedCents, $(20));
    assert.strictEqual(tips.netCents(tip), 0);
  });

  /* ---------------- totals ---------------- */
  console.log("\nTotals");

  await test("the business week starts on Monday in New York", () => {
    assert.strictEqual(tips.weekStartNY(new Date("2026-08-12T16:00:00Z")), "2026-08-10");
    assert.strictEqual(tips.weekStartNY(new Date("2026-08-10T13:00:00Z")), "2026-08-10");
  });

  await test("a Sunday evening tip stays in the week it was earned", () => {
    // 2026-08-17T02:30Z is Sunday 22:30 in New York. Reading the day in UTC
    // would push it into the next week and short that week's payout.
    assert.strictEqual(tips.weekStartNY(new Date("2026-08-17T02:30:00Z")), "2026-08-10");
  });

  const now = new Date("2026-08-12T16:00:00Z");
  const ledger = [
    { fixter: "f1", fixterNameSnapshot: "Roman", amountCents: $(20), refundedCents: 0, receivedAt: new Date("2026-08-11T14:00:00Z") },
    { fixter: "f1", fixterNameSnapshot: "Roman", amountCents: $(30), refundedCents: $(10), receivedAt: new Date("2026-08-12T14:00:00Z") },
    { fixter: "f2", fixterNameSnapshot: "Alex", amountCents: $(15), refundedCents: 0, receivedAt: new Date("2026-08-04T14:00:00Z") },
    { fixter: null, amountCents: $(25), refundedCents: 0, receivedAt: new Date("2026-08-12T15:00:00Z") },
  ];

  await test("totals are summed from the records, in integer cents", () => {
    const summary = tips.summarizeTips(ledger, { now, weeks: 4 });
    assert.strictEqual(summary.totals.allTimeCents, $(20) + $(20) + $(15) + $(25));
    assert.strictEqual(summary.totals.count, 4);
    assert.ok(
      Number.isInteger(summary.totals.allTimeCents),
      "a total came out as a fraction of a cent"
    );
  });

  await test("a refunded tip reduces the week by exactly what went back", () => {
    const summary = tips.summarizeTips(ledger, { now, weeks: 4 });
    const roman = summary.fixters.find((row) => row.fixterId === "f1");
    assert.strictEqual(roman.thisWeekCents, $(20) + $(20));
    assert.strictEqual(roman.weekly["2026-08-10"], $(40));
  });

  await test("last week's tips stay in last week", () => {
    const summary = tips.summarizeTips(ledger, { now, weeks: 4 });
    const alex = summary.fixters.find((row) => row.fixterId === "f2");
    assert.strictEqual(alex.thisWeekCents, 0);
    assert.strictEqual(alex.weekly["2026-08-03"], $(15));
    assert.strictEqual(alex.allTimeCents, $(15));
  });

  await test("unassigned tips are kept apart, never spread across the Fixters", () => {
    const summary = tips.summarizeTips(ledger, { now, weeks: 4 });
    assert.strictEqual(summary.unassigned.allTimeCents, $(25));
    assert.strictEqual(summary.unassigned.count, 1);
    const credited = summary.fixters.reduce((sum, row) => sum + row.allTimeCents, 0);
    assert.strictEqual(
      credited,
      summary.totals.allTimeCents - summary.unassigned.allTimeCents,
      "unassigned money was credited to someone"
    );
  });

  await test("the week list ends on the current week", () => {
    const summary = tips.summarizeTips(ledger, { now, weeks: 4 });
    assert.strictEqual(summary.weekStarts.length, 4);
    assert.strictEqual(summary.weekStarts.at(-1), "2026-08-10");
    assert.strictEqual(summary.weekStarts[0], "2026-07-20");
    assert.strictEqual(summary.currentWeek, "2026-08-10");
  });

  await test("an empty ledger reports zeros rather than failing", () => {
    const summary = tips.summarizeTips([], { now, weeks: 4 });
    assert.strictEqual(summary.totals.allTimeCents, 0);
    assert.strictEqual(summary.fixters.length, 0);
    assert.strictEqual(summary.unassigned.allTimeCents, 0);
  });

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
