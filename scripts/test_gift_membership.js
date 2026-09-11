/**
 * Gift membership: the parts that need no database.
 *
 * Pricing, calendar-month terms, the claim token, the access state machine,
 * purchase validation, the email wording rules, and the schema guarantees that
 * keep the purchaser's card out of the recipient's reach.
 *
 *   node scripts/test_gift_membership.js
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
delete process.env.GIFTS_ENABLED;
delete process.env.GIFT_ALLOW_SELF_GIFT;

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const config = require("../utils/gifts/giftConfig");
const pricing = require("../utils/gifts/giftPricing");
const token = require("../utils/gifts/giftClaimToken");
const access = require("../utils/gifts/giftAccess");
const service = require("../utils/gifts/giftService");
const { TEMPLATES } = require("../utils/emailService");

let passed = 0;
const failures = [];
const pending = [];

function test(name, fn) {
  let result;
  try {
    result = fn();
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
    return;
  }
  if (result && typeof result.then === "function") {
    pending.push(
      result.then(
        () => {
          passed += 1;
          console.log(`  PASS  ${name}`);
        },
        (error) => {
          failures.push({ name, error });
          console.log(`  FAIL  ${name}\n        ${error.message}`);
        }
      )
    );
    return;
  }
  passed += 1;
  console.log(`  PASS  ${name}`);
}

function section(title) {
  console.log(`\n${title}`);
}

/* ========================================================================== */
section("Feature flag");
/* ========================================================================== */

test("GIFTS_ENABLED is false by default", () => {
  assert.equal(config.giftsEnabled(), false);
});

test("only the word 'true' enables the feature", () => {
  try {
    for (const value of ["", "false", "1", "yes", "on", "True!"]) {
      process.env.GIFTS_ENABLED = value;
      assert.equal(config.giftsEnabled(), false, `"${value}" must not enable gifts`);
    }
    process.env.GIFTS_ENABLED = "true";
    assert.equal(config.giftsEnabled(), true);
  } finally {
    delete process.env.GIFTS_ENABLED;
  }
});

test("every supported length is on sale, starting at one month", () => {
  // Gifting launched at two months only. It is an ordinary product now, so
  // all five lengths are offered and the screen starts on the cheapest.
  assert.deepEqual(config.offeredDurations(), [1, 2, 3, 6, 12]);
  assert.equal(config.defaultDuration(), 1);
  for (const months of [1, 2, 3, 6, 12]) {
    assert.equal(config.isOfferedDuration(months), true, `${months} should be on sale`);
  }
  // Anything the term arithmetic does not understand is still refused.
  for (const months of [4, 5, 18, 24, 0, -1]) {
    assert.equal(config.isOfferedDuration(months), false, `${months} must not be offered`);
  }
  assert.deepEqual(config.SUPPORTED_DURATIONS, [1, 2, 3, 6, 12]);
});

test("self-gifting is off by default", () => {
  assert.equal(config.selfGiftingAllowed(), false);
});

/* ========================================================================== */
section("Pricing, from the live plan catalogue");
/* ========================================================================== */

test("a 2-month gift is the monthly price times two", () => {
  const expected = { basic: 29800, plus: 49800, premium: 69800, elite: 99800 };
  for (const [plan, cents] of Object.entries(expected)) {
    const quote = pricing.quoteGift({ plan, durationMonths: 2 });
    assert.equal(quote.ok, true, plan);
    assert.equal(quote.totalCents, cents, `${plan} should be $${cents / 100}`);
  }
});

test("pricing is read from PLAN_CATALOG, not duplicated", () => {
  const { PLAN_CATALOG } = require("../utils/subscriptionManagement");
  for (const plan of ["basic", "plus", "premium", "elite"]) {
    assert.equal(
      pricing.monthlyPriceCents(plan),
      Math.round(PLAN_CATALOG[plan].monthly.price * 100),
      `${plan} must match the catalogue`
    );
  }
});

test("a twelve-month gift is priced like an annual membership", () => {
  /*
   * THE RULE CHANGED, on instruction. A year used to be quoted at twelve
   * times the monthly rate; the business decision is Pay 10, Get 12 - the
   * purchaser pays what a year costs and the recipient still receives all
   * twelve months.
   *
   * Read from the catalog rather than compared against a number written
   * here, so a gifted year and a bought year cannot drift apart.
   */
  const { PLAN_CATALOG } = require("../utils/subscriptionManagement");

  for (const plan of ["basic", "plus", "premium", "elite"]) {
    const twelve = pricing.quoteGift({ plan, durationMonths: 12 });
    const annualCents = Math.round(Number(PLAN_CATALOG[plan].annual.price) * 100);
    const monthlyCents = Math.round(Number(PLAN_CATALOG[plan].monthly.price) * 100);

    assert.equal(twelve.totalCents, annualCents, `${plan} must cost the annual price`);
    assert.equal(twelve.pricingBasis, "annual");
    assert.equal(twelve.savingsCents, monthlyCents * 12 - annualCents);
    /* And it is genuinely cheaper than paying by the month. */
    assert.ok(twelve.totalCents < monthlyCents * 12, `${plan} should save something`);
    /* Still twelve months of membership. */
    assert.equal(twelve.durationMonths, 12);
  }
});

test("no other gift length was touched by the annual rule", () => {
  const { PLAN_CATALOG } = require("../utils/subscriptionManagement");
  for (const plan of ["basic", "plus", "premium", "elite"]) {
    const monthlyCents = Math.round(Number(PLAN_CATALOG[plan].monthly.price) * 100);
    for (const months of [1, 2, 3, 6]) {
      const quote = pricing.quoteGift({ plan, durationMonths: months });
      assert.equal(quote.totalCents, monthlyCents * months, `${plan}/${months} must be unchanged`);
      assert.equal(quote.pricingBasis, "monthly");
      assert.equal(quote.savingsCents, 0);
    }
  }
});

test("unknown plans and durations are refused", () => {
  assert.equal(pricing.quoteGift({ plan: "gold", durationMonths: 2 }).reason, "unknown_plan");
  assert.equal(pricing.quoteGift({ plan: "plus", durationMonths: 5 }).reason, "unsupported_duration");
  assert.equal(pricing.quoteGift({ plan: "plus", durationMonths: 0 }).reason, "unsupported_duration");
});

test("the Stripe line item is a ONE-TIME inline price, never a recurring one", () => {
  /*
   * The load-bearing assertion of the whole feature. Handing Stripe the
   * membership's recurring price would create a subscription — putting the
   * purchaser on a renewing charge and giving the recipient something to
   * resume.
   */
  const item = pricing.stripeLineItem({ plan: "plus", durationMonths: 2 });
  assert.ok(item.price_data, "must use inline price_data");
  assert.equal(item.price_data.unit_amount, 49800);
  assert.ok(!item.price, "must NOT reference a stored price id");
  assert.ok(!item.price_data.recurring, "must NOT be recurring");
  assert.match(item.price_data.product_data.description, /one-time payment/i);
  assert.match(item.price_data.product_data.description, /does not renew/i);
});

/* ========================================================================== */
section("Calendar-month terms");
/* ========================================================================== */

const fmt = (d) => pricing.formatTermDate(d);

test("two months lands on the same day of the month", () => {
  const w = pricing.termWindow(new Date("2026-11-09T20:00:00Z"), 2);
  assert.equal(fmt(w.endAt), "January 9, 2027");
});

test("month-end is clamped rather than overflowing", () => {
  // 31 December plus two months is 28 February, not 3 March.
  assert.equal(fmt(pricing.termWindow(new Date("2026-12-31T17:00:00Z"), 2).endAt), "February 28, 2027");
  assert.equal(fmt(pricing.termWindow(new Date("2026-01-31T17:00:00Z"), 1).endAt), "February 28, 2026");
  assert.equal(fmt(pricing.termWindow(new Date("2026-08-31T18:00:00Z"), 6).endAt), "February 28, 2027");
});

test("a leap year is handled", () => {
  assert.equal(fmt(pricing.termWindow(new Date("2028-01-31T17:00:00Z"), 1).endAt), "February 29, 2028");
});

test("a term spanning a DST change keeps its calendar date", () => {
  // Starts in EST, ends in EDT.
  assert.equal(fmt(pricing.termWindow(new Date("2026-02-09T20:00:00Z"), 2).endAt), "April 9, 2026");
  // Starts in EDT, ends in EST.
  assert.equal(fmt(pricing.termWindow(new Date("2026-09-15T19:00:00Z"), 2).endAt), "November 15, 2026");
});

test("an invalid start yields no window rather than a wrong one", () => {
  assert.equal(pricing.termWindow(null, 2), null);
  assert.equal(pricing.termWindow("not a date", 2), null);
});

/* ========================================================================== */
section("Claim token");
/* ========================================================================== */

const GIFT_ID = "507f1f77bcf86cd799439011";

function giftWith(fields) {
  return { _id: GIFT_ID, ...fields };
}

test("a freshly minted token verifies", () => {
  const { token: t, fields } = token.createClaimToken({ giftId: GIFT_ID, version: 1 });
  assert.equal(token.verifyClaimToken(t, giftWith(fields)).ok, true);
});

test("the token itself is never stored — only its hash", () => {
  const { token: t, fields } = token.createClaimToken({ giftId: GIFT_ID, version: 1 });
  assert.ok(!JSON.stringify(fields).includes(t), "the raw token must not appear in stored fields");
  assert.equal(fields.claimTokenHash, token.hashToken(t));
});

test("a tampered token is refused", () => {
  const { token: t, fields } = token.createClaimToken({ giftId: GIFT_ID, version: 1 });
  const tampered = `${t.slice(0, -3)}xyz`;
  const verdict = token.verifyClaimToken(tampered, giftWith(fields));
  assert.equal(verdict.ok, false);
});

test("garbage is refused without throwing", () => {
  for (const junk of ["", "abc", null, undefined, "!!!!", "a".repeat(500)]) {
    const verdict = token.readClaimToken(junk);
    assert.equal(verdict.ok, false);
  }
});

test("a token signed with a different secret is refused", () => {
  const original = process.env.GIFT_CLAIM_SECRET;
  try {
    process.env.GIFT_CLAIM_SECRET = "attacker-secret";
    const forged = token.createClaimToken({ giftId: GIFT_ID, version: 1 });
    process.env.GIFT_CLAIM_SECRET = "the-real-secret";
    assert.equal(token.readClaimToken(forged.token).ok, false);
  } finally {
    if (original === undefined) delete process.env.GIFT_CLAIM_SECRET;
    else process.env.GIFT_CLAIM_SECRET = original;
  }
});

test("AN EXPIRED TOKEN DOES NOT DESTROY THE GIFT", () => {
  /*
   * The distinction Taras asked for. A link going stale in an inbox is a
   * security matter; the money is not. An expired token still identifies which
   * gift it belonged to, so Admin can send a fresh link to the right person.
   */
  const expired = token.createClaimToken({ giftId: GIFT_ID, version: 1, ttlDays: -1 });
  const verdict = token.readClaimToken(expired.token);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "expired", "must be distinguishable from invalid");
  assert.equal(verdict.giftId, GIFT_ID, "must still name the gift so it can be re-issued");
});

test("re-issuing kills every previously issued link", () => {
  const first = token.createClaimToken({ giftId: GIFT_ID, version: 1 });
  const gift = giftWith(first.fields);
  assert.equal(token.verifyClaimToken(first.token, gift).ok, true);

  // Admin re-issues.
  const second = token.createClaimToken({ giftId: GIFT_ID, version: 2 });
  const reissued = giftWith(second.fields);

  assert.equal(token.verifyClaimToken(second.token, reissued).ok, true, "the new link works");
  const old = token.verifyClaimToken(first.token, reissued);
  assert.equal(old.ok, false, "the OLD link must stop working");
  assert.equal(old.reason, "superseded");
});

test("a token for one gift cannot be used on another", () => {
  const { token: t } = token.createClaimToken({ giftId: GIFT_ID, version: 1 });
  const other = token.createClaimToken({ giftId: "507f1f77bcf86cd799439099", version: 1 });
  assert.equal(token.verifyClaimToken(t, giftWith(other.fields)).ok, false);
});

test("a gift with a cleared hash accepts nothing", () => {
  const { token: t } = token.createClaimToken({ giftId: GIFT_ID, version: 1 });
  const claimed = giftWith({ claimTokenHash: "", claimTokenVersion: 1 });
  assert.equal(token.verifyClaimToken(t, claimed).reason, "revoked");
});

/* ========================================================================== */
section("Access is computed from dates, never from a worker flag");
/* ========================================================================== */

const NOW = new Date("2026-11-20T12:00:00Z");
const mk = (start, end, status = "claimed") => ({
  status,
  startAt: start ? new Date(start) : null,
  endAt: end ? new Date(end) : null,
});

test("a gift whose window contains now is active", () => {
  const state = access.giftAccessState(mk("2026-11-09", "2027-01-09"), NOW);
  assert.equal(state.state, "active");
  assert.equal(state.active, true);
});

test("A GIFT IS USABLE EVEN IF NO WORKER HAS EVER TOUCHED IT", () => {
  /*
   * The reliability requirement. This record has never been seen by the
   * lifecycle sweep — no activation stamp, no status change beyond the claim.
   * Its dates say it is live, so it is live.
   */
  const untouched = {
    status: "claimed",
    startAt: new Date("2026-11-09"),
    endAt: new Date("2027-01-09"),
    // Deliberately absent: any field a worker would have set.
  };
  assert.equal(access.giftAccessState(untouched, NOW).active, true);
});

test("a queued gift is not yet active", () => {
  assert.equal(access.giftAccessState(mk("2026-12-01", "2027-02-01"), NOW).state, "queued");
});

test("a queued gift becomes active on its own the moment its start passes", () => {
  const gift = mk("2026-12-01", "2027-02-01");
  assert.equal(access.giftAccessState(gift, new Date("2026-11-30T23:59:00Z")).active, false);
  assert.equal(access.giftAccessState(gift, new Date("2026-12-01T00:01:00Z")).active, true);
});

test("an ended gift is not active", () => {
  assert.equal(access.giftAccessState(mk("2026-08-01", "2026-10-01"), NOW).state, "expired");
});

test("the boundary is inclusive at the start and exclusive at the end", () => {
  const gift = mk("2026-11-20T12:00:00Z", "2027-01-20T12:00:00Z");
  assert.equal(access.giftAccessState(gift, new Date("2026-11-20T12:00:00Z")).active, true);
  assert.equal(access.giftAccessState(gift, new Date("2027-01-20T12:00:00Z")).active, false);
});

test("an unclaimed or cancelled gift grants nothing", () => {
  assert.equal(access.giftAccessState(mk(null, null, "invited"), NOW).active, false);
  assert.equal(access.giftAccessState(mk("2026-11-09", "2027-01-09", "cancelled"), NOW).active, false);
});

test("a claimed gift with no window is reported, not silently granted", () => {
  assert.equal(access.giftAccessState(mk(null, null, "claimed"), NOW).state, "invalid_window");
  assert.equal(access.giftAccessState(mk(null, null, "claimed"), NOW).active, false);
});

/* ========================================================================== */
section("Stacking");
/* ========================================================================== */

test("nothing ahead means a gift starts now", () => {
  assert.equal(access.coverageEndsAt({ paidCoverageEndsAt: null, existingGifts: [] }, NOW), null);
});

test("a paid membership pushes a gift behind it", () => {
  const end = new Date("2026-12-25");
  const ahead = access.coverageEndsAt({ paidCoverageEndsAt: end, existingGifts: [] }, NOW);
  assert.equal(ahead.getTime(), end.getTime());
});

test("a running gift pushes the next one behind it, so no day is wasted", () => {
  const running = mk("2026-11-09", "2027-01-09");
  const ahead = access.coverageEndsAt({ existingGifts: [running] }, NOW);
  assert.equal(ahead.getTime(), new Date("2027-01-09").getTime());
});

test("two queued gifts chain rather than overlap", () => {
  const first = mk("2026-11-09", "2027-01-09");
  const second = mk("2027-01-09", "2027-03-09");
  const ahead = access.coverageEndsAt({ existingGifts: [first, second] }, NOW);
  assert.equal(ahead.getTime(), new Date("2027-03-09").getTime());
});

test("an expired gift does not delay anything", () => {
  const done = mk("2026-08-01", "2026-10-01");
  assert.equal(access.coverageEndsAt({ existingGifts: [done] }, NOW), null);
});

test("the later of paid coverage and a queued gift wins", () => {
  const gift = mk("2026-11-09", "2027-01-09");
  const ahead = access.coverageEndsAt(
    { paidCoverageEndsAt: new Date("2027-06-01"), existingGifts: [gift] },
    NOW
  );
  assert.equal(ahead.getTime(), new Date("2027-06-01").getTime());
});

/* ========================================================================== */
section("Self-gifting is blocked");
/* ========================================================================== */

const purchaser = { _id: "user_a", email: "sarah@example.com" };

test("gifting your own email address is refused", async () => {
  const verdict = await service.validateGiftPurchase({
    purchaser,
    plan: "plus",
    durationMonths: 2,
    recipientEmail: "sarah@example.com",
    UserLookup: { findCustomerByEmail: async () => null },
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "self_gift_not_allowed");
});

test("a different spelling of your own address is still refused", async () => {
  const verdict = await service.validateGiftPurchase({
    purchaser,
    plan: "plus",
    durationMonths: 2,
    recipientEmail: "  SARAH@Example.COM ",
    UserLookup: { findCustomerByEmail: async () => null },
  });
  assert.equal(verdict.reason, "self_gift_not_allowed");
});

test("a second email that resolves to your own ACCOUNT is refused", async () => {
  /*
   * Checked against the resolved account, not just the typed address, so
   * holding two addresses on one account is not a way round it.
   */
  const verdict = await service.validateGiftPurchase({
    purchaser,
    plan: "plus",
    durationMonths: 2,
    recipientEmail: "sarah.other@example.com",
    UserLookup: { findCustomerByEmail: async () => ({ _id: "user_a" }) },
  });
  assert.equal(verdict.reason, "self_gift_not_allowed");
});

test("gifting somebody else is allowed", async () => {
  const verdict = await service.validateGiftPurchase({
    purchaser,
    plan: "plus",
    durationMonths: 2,
    recipientEmail: "jane@example.com",
    UserLookup: { findCustomerByEmail: async () => ({ _id: "user_b" }) },
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.recipientEmail, "jane@example.com");
});

test("a malformed recipient address is refused", async () => {
  for (const bad of ["", "not-an-email", "@example.com", "jane@"]) {
    const verdict = await service.validateGiftPurchase({
      purchaser,
      plan: "plus",
      durationMonths: 2,
      recipientEmail: bad,
      UserLookup: { findCustomerByEmail: async () => null },
    });
    assert.equal(verdict.ok, false, `"${bad}" should be refused`);
  }
});

/* ========================================================================== */
section("Payment safety: the structural guarantees");
/* ========================================================================== */

const SCHEMA_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "models", "GiftMembership.js"),
  "utf8"
);

test("THE GIFT SCHEMA HAS NO FIELD THAT COULD REACH THE PURCHASER'S CARD", () => {
  /*
   * The single most important assertion in this suite.
   *
   * The billing portal resolves a Stripe customer by searching a user's
   * subscriptions for stripeCustomerId. A gift carrying one — or a
   * subscription id, or a saved payment method — would let the recipient open
   * the PURCHASER'S billing portal. Every other safeguard in the feature is
   * defence in depth around the fact that this field does not exist.
   */
  const GiftMembership = require("../models/GiftMembership");
  const paths = Object.keys(GiftMembership.schema.paths);

  const forbidden = paths.filter((p) =>
    /stripeCustomerId|stripeSubscriptionId|stripeSubscriptionItemId|paymentMethod|stripePriceId|customerId/i.test(p)
  );
  assert.deepEqual(forbidden, [], `these fields must never exist on a gift: ${forbidden}`);

  // And the same, read off the source, so a nested or commented-out addition
  // is caught too.
  const declarations = SCHEMA_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(
    !/stripeCustomerId\s*:/.test(declarations),
    "stripeCustomerId must not be declared on GiftMembership"
  );
  assert.ok(
    !/stripeSubscriptionId\s*:/.test(declarations),
    "stripeSubscriptionId must not be declared on GiftMembership"
  );
});

test("the synthetic membership handed to readers carries no Stripe identity", () => {
  const synthetic = access.syntheticGiftSubscription({
    _id: "gift1",
    giftNumber: "G1",
    plan: "plus",
    addressId: "addr1",
    recipient: "user_b",
    startAt: new Date("2026-11-09"),
    endAt: new Date("2027-01-09"),
    purchaserSnapshot: { name: "Sarah Chen", email: "sarah@example.com" },
  });

  assert.equal(synthetic.subscriptionType, "plus");
  assert.equal(synthetic.isGift, true);
  for (const field of ["stripeCustomerId", "stripeSubscriptionId", "stripePriceId", "_id"]) {
    assert.equal(synthetic[field], undefined, `${field} must be absent`);
  }
  // The purchaser's EMAIL is not exposed either; only their display name.
  assert.equal(synthetic.giftedBy, "Sarah Chen");
  assert.ok(!JSON.stringify(synthetic).includes("sarah@example.com"));
});

test("the synthetic membership is frozen, so nothing can add a Stripe field later", () => {
  const synthetic = access.syntheticGiftSubscription({ _id: "g", plan: "plus" });
  assert.throws(() => {
    "use strict";
    synthetic.stripeCustomerId = "cus_evil";
  });
  assert.equal(synthetic.stripeCustomerId, undefined);
});

test("NO GIFT CODE PATH CREATES A SUBSCRIPTION DOCUMENT", () => {
  /*
   * Read across every gift source file. A Subscription is only ever read —
   * for the end date of existing coverage, so a gift can be queued behind it —
   * and never created, updated or deleted.
   */
  const dir = path.join(__dirname, "..", "utils", "gifts");
  const files = fs.readdirSync(dir).map((f) => path.join(dir, f));
  files.push(path.join(__dirname, "..", "routes", "gifts.js"));
  files.push(path.join(__dirname, "..", "routes", "adminGifts.js"));
  files.push(path.join(__dirname, "..", "jobs", "giftLifecycle.js"));

  const writes = /Subscription(Model)?\s*\.\s*(create|insertMany|updateOne|updateMany|findOneAndUpdate|deleteOne|deleteMany|findByIdAndUpdate|save)\b/;
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(
      !writes.test(source),
      `${path.basename(file)} must never write to Subscription`
    );
  }
});

test("gift routes are gated on the feature flag", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "routes", "gifts.js"), "utf8");
  assert.match(source, /router\.use\(featureGate\)/, "every gift route must sit behind the gate");
  assert.match(source, /giftsEnabled\(\)/);
});

test("gift checkout is one-time, never a subscription", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "routes", "gifts.js"), "utf8");
  assert.match(source, /mode:\s*"payment"/, "checkout must be payment mode");
  assert.ok(!/mode:\s*"subscription"/.test(source), "checkout must never be subscription mode");
});

/* ========================================================================== */
section("Email wording");
/* ========================================================================== */

const GIFT_TEMPLATES = [
  "gift_purchase_confirmation",
  "gift_invitation",
  "gift_claimed",
  "gift_claimed_purchaser",
  "gift_claim_reminder",
  "gift_ending_soon",
  "gift_expired",
];

const EMAIL_VARS = {
  name: "Jane",
  from: "Sarah Chen",
  plan: "Plus",
  durationMonths: 2,
  recipientName: "Jane Doe",
  recipientEmail: "jane@example.com",
  amountPaid: "$498.00",
  giftNumber: "GA1B2C3D",
  claimUrl: "https://www.profixter.com/gift/claim/abc",
  startsOn: "December 1, 2026",
  activeThrough: "January 9, 2027",
  endsOn: "January 9, 2027",
  endedOn: "January 9, 2027",
  continueUrl: "https://www.profixter.com/membership",
};

test("all seven gift emails are registered and render", () => {
  for (const key of GIFT_TEMPLATES) {
    assert.equal(typeof TEMPLATES[key], "function", `${key} is not registered`);
    const rendered = TEMPLATES[key](EMAIL_VARS);
    assert.ok(rendered.subject, `${key} has no subject`);
    assert.ok(rendered.html, `${key} has no html`);
    assert.ok(rendered.text, `${key} has no text`);
  }
});

test("NO gift email uses renewal or recurring-charge language", () => {
  /*
   * A gift does not renew and no card of the recipient's is on file, so
   * "your membership renews" would be false and "update your payment method"
   * would point at nothing. Same rule the SMS registry enforces.
   */
  const banned = /renew|your card will be charged|update your payment method|upcoming charge|recurring|auto-?renew/i;
  for (const key of GIFT_TEMPLATES) {
    for (const queued of [false, true]) {
      const rendered = TEMPLATES[key]({ ...EMAIL_VARS, queued });
      const body = `${rendered.subject} ${rendered.html} ${rendered.text}`;
      assert.ok(!banned.test(body), `${key} uses forbidden renewal language`);
    }
  }
});

test("the invitation says who it is from and what it is", () => {
  const rendered = TEMPLATES.gift_invitation(EMAIL_VARS);
  assert.match(rendered.subject, /Sarah Chen sent you 2 months of ProFixter Plus/);
  assert.ok(rendered.html.includes(EMAIL_VARS.claimUrl));
  assert.match(rendered.text, /nothing to pay/i);
});

test("the queued claim email explains the delay rather than hiding it", () => {
  const rendered = TEMPLATES.gift_claimed({ ...EMAIL_VARS, queued: true });
  assert.match(rendered.html, /begins on/i);
  assert.match(rendered.html, /December 1, 2026/);
  assert.match(rendered.subject, /saved for later/i);
});

test("the ending emails offer a NEW membership, not a resumption", () => {
  for (const key of ["gift_ending_soon", "gift_expired"]) {
    const rendered = TEMPLATES[key](EMAIL_VARS);
    const body = `${rendered.html} ${rendered.text}`;
    assert.ok(!/resume/i.test(body), `${key} must not offer to resume anything`);
    assert.ok(!/reactivate/i.test(body), `${key} must not offer to reactivate anything`);
    assert.match(body, /your own membership|start your membership/i);
  }
});

test("no gift email leaks the purchaser's email address to the recipient", () => {
  for (const key of ["gift_invitation", "gift_claimed", "gift_claim_reminder"]) {
    const rendered = TEMPLATES[key]({ ...EMAIL_VARS, purchaserEmail: "sarah@example.com" });
    const body = `${rendered.subject} ${rendered.html} ${rendered.text}`;
    assert.ok(!body.includes("sarah@example.com"), `${key} leaks the purchaser email`);
  }
});

/* ========================================================================== */

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) {
    for (const { name, error } of failures) {
      console.error(`\n--- ${name} ---\n${error.stack || error.message}`);
    }
    process.exit(1);
  }
  process.exit(0);
});
