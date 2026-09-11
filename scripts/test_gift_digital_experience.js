/**
 * The Digital Gift: presentation, and the line it must not cross.
 *
 * The whole risk in this feature is that "how the gift looks" quietly becomes
 * "what the gift is". An occasion is allowed to change a headline. It is not
 * allowed to change a price, a duration, an entitlement or anything Stripe
 * sees — otherwise we have six products wearing one name.
 *
 * The other risk is the personal message, which is the only free text a
 * stranger can put in front of another customer, and which is rendered into
 * assembled HTML in the invitation email.
 */

process.env.GIFTS_ENABLED = "true";
/*
 * Set before any require: utils/subscriptionManagement reads the key once at
 * module load, so setting it later leaves hasStripeSecretKey() false and the
 * checkout route answers 503 before the gate under test is ever reached.
 * A placeholder is enough — no Stripe call is made anywhere in this suite.
 */
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_placeholder_unused";

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

const {
  DEFAULT_OCCASION,
  MESSAGE_MAX_LENGTH,
  OCCASIONS,
  OCCASION_KEYS,
  normalizeOccasion,
  occasionCopy,
  sanitizeDisplayName,
  sanitizePersonalMessage,
} = require("../utils/gifts/giftOccasions");
const { quoteGift, stripeLineItem, termWindow } = require("../utils/gifts/giftPricing");
const { createGiftEmailTemplates } = require("../utils/gifts/giftEmailTemplates");

const escapeHtml = (v) =>
  String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const templates = createGiftEmailTemplates({ escapeHtml, urls: {} });

const has = (src, snippet, message) => assert(src.includes(snippet), message || snippet);

/*
 * Strip comments before asserting a file does NOT contain something.
 *
 * Without this the suite reads its own documentation as evidence: a comment
 * saying "the purchaser is never involved" contains the word purchaser, and
 * one saying "SMS stays off until Twilio" contains Twilio. Both produced
 * false failures. Absence has to be asserted against code.
 */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const FAKE_PRODUCT = "prod_GiftPlusTest01";

console.log("\nOccasions\n");

test("the six occasions exist, with neutral as the default", () => {
  assert.deepStrictEqual(OCCASION_KEYS.sort(), [
    "birthday",
    "congratulations",
    "just_because",
    "neutral",
    "new_home",
    "thank_you",
  ]);
  assert.strictEqual(DEFAULT_OCCASION, "neutral");
  assert.strictEqual(occasionCopy(undefined).key, "neutral");
});

test("every occasion has a title and a kicker that do not repeat each other", () => {
  for (const key of OCCASION_KEYS) {
    const copy = OCCASIONS[key];
    assert(copy.title && copy.title.length > 2, `${key} has no title`);
    assert(copy.kicker && copy.kicker.length > 2, `${key} has no kicker`);
    assert(copy.label, `${key} has no picker label`);
    assert.notStrictEqual(
      copy.title.toLowerCase(),
      copy.kicker.toLowerCase(),
      `${key} kicker just repeats the title`
    );
  }
});

test("an unknown, empty or hostile occasion falls back to neutral", () => {
  for (const value of ["", "   ", null, undefined, "lolz", "__proto__", "constructor", 42, {}]) {
    assert.strictEqual(normalizeOccasion(value), "neutral", `${String(value)} was not neutralised`);
  }
  assert.strictEqual(normalizeOccasion("NEW_HOME"), "new_home", "case should not matter");
  assert.strictEqual(normalizeOccasion("  birthday  "), "birthday", "whitespace should not matter");
});

test("a prototype-polluting key cannot become a real occasion", () => {
  const copy = occasionCopy("__proto__");
  assert.strictEqual(copy.key, "neutral");
  assert.strictEqual(typeof copy.title, "string");
});

console.log("\nPresentation cannot change the product\n");

test("the price is identical for every occasion", () => {
  const base = quoteGift({ plan: "plus", durationMonths: 2 });
  assert(base.ok);
  for (const key of OCCASION_KEYS) {
    // Occasion is not even an input to pricing. This asserts the shape of that
    // fact: there is no argument through which it could become one.
    const again = quoteGift({ plan: "plus", durationMonths: 2, occasion: key });
    assert.strictEqual(again.totalCents, base.totalCents, `${key} changed the total`);
    assert.strictEqual(again.durationMonths, base.durationMonths, `${key} changed the duration`);
  }
});

test("the Stripe line item is byte-identical across occasions", () => {
  const reference = JSON.stringify(
    stripeLineItem({ plan: "plus", durationMonths: 2, productId: FAKE_PRODUCT })
  );
  for (const key of OCCASION_KEYS) {
    const item = JSON.stringify(
      stripeLineItem({ plan: "plus", durationMonths: 2, productId: FAKE_PRODUCT, occasion: key })
    );
    assert.strictEqual(item, reference, `${key} altered what Stripe is sent`);
  }
});

test("the entitlement window is identical across occasions", () => {
  const start = new Date("2026-04-01T12:00:00Z");
  const reference = termWindow(start, 2).endAt.toISOString();
  for (const key of OCCASION_KEYS) {
    // termWindow takes only a date and a count; there is no occasion argument.
    assert.strictEqual(termWindow(start, 2).endAt.toISOString(), reference, `${key} moved the term`);
  }
});

test("occasion and message never reach pricing or access code", () => {
  for (const file of ["utils/gifts/giftPricing.js", "utils/gifts/giftAccess.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert(!source.includes("occasion"), `${file} reads the occasion`);
    assert(!source.includes("personalMessage"), `${file} reads the personal message`);
  }
});

test("the gift schema stores presentation apart from terms", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "models", "GiftMembership.js"),
    "utf8"
  );
  assert.match(source, /occasion:\s*\{[\s\S]*?enum:/, "occasion must be an enum, not free text");
  assert.match(source, /personalMessage:\s*\{[\s\S]*?maxlength:\s*200/, "message must be capped");
});

console.log("\nThe personal message\n");

test("a message is optional", () => {
  for (const empty of ["", null, undefined, "   ", "\n\n"]) {
    assert.strictEqual(sanitizePersonalMessage(empty), "", `${JSON.stringify(empty)} was not empty`);
  }
});

test("a message is capped at the documented length", () => {
  assert.strictEqual(MESSAGE_MAX_LENGTH, 200);
  const long = "x".repeat(5000);
  assert.strictEqual(sanitizePersonalMessage(long).length, 200);
  // The cap is applied after cleaning, so padding with junk cannot smuggle
  // extra visible characters past it.
  assert(sanitizePersonalMessage(" ".repeat(300) + "y".repeat(300)).length <= 200);
});

test("no HTML tag can survive, whatever the payload", () => {
  const payloads = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<svg/onload=alert(1)>",
    "<iframe src=javascript:alert(1)>",
    "<a href='javascript:alert(1)'>click</a>",
    "<<script>script>alert(1)<</script>/script>",
    "<style>body{display:none}</style>",
  ];
  for (const payload of payloads) {
    const clean = sanitizePersonalMessage(payload);
    assert(!clean.includes("<"), `a < survived: ${clean}`);
    assert(!clean.includes(">"), `a > survived: ${clean}`);
  }
});

test("control characters are removed but real line breaks are kept", () => {
  assert.strictEqual(sanitizePersonalMessage("a\u0000b\u0007c"), "abc");
  assert.strictEqual(sanitizePersonalMessage("one\r\ntwo"), "one\ntwo");
  assert.strictEqual(sanitizePersonalMessage("one\n\n\n\n\ntwo"), "one\n\ntwo");
  assert.strictEqual(sanitizePersonalMessage("a   b"), "a b");
});

test("a display name is cleaned to one line", () => {
  assert.strictEqual(sanitizeDisplayName("  Maria   Smith  "), "Maria Smith");
  assert.strictEqual(sanitizeDisplayName("Maria\nSmith"), "Maria Smith");
  assert(!sanitizeDisplayName("<b>Maria</b>").includes("<"));
  assert.strictEqual(sanitizeDisplayName("x".repeat(200)).length, 80);
});

console.log("\nThe invitation email\n");

function invitation(over = {}) {
  return templates.gift_invitation({
    name: "John",
    from: "Maria Smith",
    plan: "Plus",
    durationMonths: 2,
    claimUrl: "https://www.profixter.com/gift/claim/TOKEN",
    occasion: "new_home",
    personalMessage: "Congratulations on your new home!\nWishing you many happy years here.",
    ...over,
  });
}

test("the email leads with the occasion and who it is from", () => {
  const email = invitation();
  assert(email.html.includes("A Gift for Your New Home"), "the occasion title is missing");
  assert(email.html.includes("Maria Smith"), "the sender is missing");
  assert(email.html.includes("2 months of ProFixter Plus"), "the plan and duration are missing");
  assert(email.subject.includes("Maria Smith"), "the subject should say who sent it");
});

test("the email carries the personal message, with its line breaks", () => {
  const email = invitation();
  assert(email.html.includes("Wishing you many happy years"));
  assert(email.html.includes("home!<br>Wishing"), "line breaks must survive as <br>");
  assert(email.text.includes("Wishing you many happy years"), "the text part needs it too");
});

test("a message-less gift produces no empty quote block", () => {
  const email = invitation({ personalMessage: "" });
  assert(!email.html.includes("#D4A574; style=\"width:3px"), "an empty message rule was rendered");
  assert(!email.text.includes('""'), "the text part has an empty quote");
});

test("the email escapes anything that reaches it unsanitised", () => {
  // Defence in depth: the server strips angle brackets before storing, and the
  // template escapes again on render. Either alone would do; both is the point.
  const email = invitation({ personalMessage: "<img src=x onerror=alert(1)>" });
  assert(!email.html.includes("<img src=x"), "raw markup reached the email body");
  assert(email.html.includes("&lt;img"), "it should be escaped, not dropped silently");
});

test("the email uses only what email clients actually render", () => {
  const email = invitation();
  assert(!/display:\s*(flex|grid)/.test(email.html), "flex/grid do not work in Outlook");
  assert(!/<style|<link/.test(email.html), "no stylesheet may be required");
  assert(!/background-image/.test(email.html), "background images are stripped or blocked");
  assert(/bgcolor=/.test(email.html), "block colour should use bgcolor for old clients");
  assert(/role="presentation"/.test(email.html), "layout tables must be marked presentational");
  assert(email.html.length < 25000, "Gmail clips long messages");
});

test("the CTA is a real link with a real tap target", () => {
  const email = invitation();
  assert(email.html.includes("Open your gift"));
  assert(email.html.includes("https://www.profixter.com/gift/claim/TOKEN"));
  const padding = email.html.match(/padding:(\d+)px \d+px;[^"]*font-size:16px/);
  assert(padding && Number(padding[1]) >= 14, "the button needs vertical padding to be tappable");
});

test("the email still never implies a recurring charge", () => {
  const email = invitation();
  const body = `${email.html} ${email.text}`.toLowerCase();
  for (const forbidden of ["renew", "your card will be charged", "update your payment method", "subscription will continue"]) {
    assert(!body.includes(forbidden), `the invitation says "${forbidden}"`);
  }
  assert(body.includes("nothing to pay"), "it should say there is nothing to pay");
});

test("every occasion produces a sane email", () => {
  for (const key of OCCASION_KEYS) {
    const email = invitation({ occasion: key });
    assert(email.html.includes(OCCASIONS[key].title), `${key} title missing from the email`);
    assert(email.subject.length < 120, `${key} subject is too long`);
    assert(email.html.includes("Open your gift"), `${key} lost its CTA`);
  }
});

console.log("\nContinuation must not bill over gift coverage\n");

const stripeRouteSource = fs.readFileSync(
  path.join(__dirname, "..", "routes", "stripe.js"),
  "utf8"
);

test("subscription checkout defers billing to the end of gift coverage", () => {
  has(
    stripeRouteSource,
    "projectedGiftCoverageEnd",
    "checkout must ask how long gift coverage runs"
  );
  has(stripeRouteSource, "trial_end: trialEndUnix", "and defer the first charge to it");
  assert.match(
    stripeRouteSource,
    /trialEndUnix\s*=\s*Math\.max\(/,
    "the deferral must never be brought forward below Stripe's floor"
  );
});

test("the deferral can only ever delay a charge, never advance one", () => {
  // Clamping upward is the safe direction: a gift ending in an hour bills a
  // little late rather than billing over covered time.
  const clamp = stripeRouteSource.slice(
    stripeRouteSource.indexOf("const MIN_TRIAL_SECONDS"),
    stripeRouteSource.indexOf("const stripeCustomerId")
  );
  assert.match(clamp, /Math\.max\(Math\.floor\(giftCoverageEndsAt/);
  assert(!/Math\.min\(/.test(clamp), "nothing may pull the billing date earlier");
});

test("the deferral uses the RECIPIENT's own Stripe customer, never the purchaser's", () => {
  // The gift lookup is by the signed-in user's own id and address; the
  // customer is still resolved from that same account.
  assert.match(
    stripeRouteSource,
    /projectedGiftCoverageEnd\(user\._id, address\._id/,
    "coverage is looked up for the signed-in recipient's own property"
  );
  assert.match(stripeRouteSource, /resolveUserStripeCustomerId\(user\)/);
  assert(
    !/purchaser/i.test(codeOnly(stripeRouteSource)),
    "no code in the subscription path may read anything about a purchaser"
  );
});

test("a failed gift lookup bills as before rather than blocking the sale", () => {
  const guard = stripeRouteSource.slice(
    stripeRouteSource.indexOf("let giftCoverageEndsAt"),
    stripeRouteSource.indexOf("const MIN_TRIAL_SECONDS")
  );
  has(guard, "catch", "the lookup must be guarded");
  has(guard, "subscription_checkout_gift_coverage_lookup_failed", "and logged loudly");
});

test("the customer is told when billing starts", () => {
  has(stripeRouteSource, "billingStartsAt", "the response must carry the date");
});

console.log("\nPublic claim preview carries no private data\n");

const giftRouteSource = fs.readFileSync(path.join(__dirname, "..", "routes", "gifts.js"), "utf8");

test("the unauthenticated preview exposes no email, address or surname", () => {
  const preview = giftRouteSource.slice(
    giftRouteSource.indexOf('router.get("/claim/:token"'),
    giftRouteSource.indexOf('router.get("/claim/:token/details"')
  );
  assert(preview.length > 0, "the preview route could not be isolated");

  const payload = preview.slice(preview.indexOf("return res.json({"), preview.indexOf("hasAccount"));
  for (const leaked of [
    "recipientEmail:",
    "recipientLastName:",
    "addressSnapshot:",
    "purchaserSnapshot?.email",
  ]) {
    assert(!payload.includes(leaked), `the public preview must not return ${leaked}`);
  }
  has(payload, "recipientEmailHint", "only a masked hint may be sent");
});

test("the email hint is masked, and keeps the domain", () => {
  const source = giftRouteSource.slice(
    giftRouteSource.indexOf("function maskEmail"),
    giftRouteSource.indexOf("/** Why a purchase was refused")
  );
  // eslint-disable-next-line no-eval
  const maskEmail = eval(`(${source.slice(source.indexOf("function maskEmail"))})`);
  assert.strictEqual(maskEmail("john.smith@example.com"), "jo\u2022\u2022\u2022\u2022\u2022\u2022@example.com");
  assert.strictEqual(maskEmail(""), "");
  assert(!maskEmail("john.smith@example.com").includes("hn.smith"), "the local part must be hidden");
});

test("the address is released only to a verified recipient", () => {
  const details = giftRouteSource.slice(
    giftRouteSource.indexOf('router.get("/claim/:token/details"'),
    giftRouteSource.indexOf('router.post("/claim/:token"')
  );
  has(details, '"/claim/:token/details", auth', "the details route must require authentication");
  has(details, "claimantMatches", "and must check identity, not merely a session");
  has(details, "RECIPIENT_MISMATCH");
  has(details, "addressSnapshot");
});

console.log("\nRefund notification\n");

test("Admin is emailed when a gift is refunded, and only for new refunds", () => {
  const webhook = fs.readFileSync(
    path.join(__dirname, "..", "utils", "gifts", "giftWebhook.js"),
    "utf8"
  );
  has(webhook, "sendGiftRefundAdminNotice", "a refund must notify Admin");
  assert.match(
    webhook,
    /if \(synced\?\.ok && !synced\.duplicate\)/,
    "a replayed webhook must not send a second notice"
  );
});

test("the refund notice says the gift was NOT revoked", () => {
  const templates = createGiftEmailTemplates({ escapeHtml, urls: {} });
  const email = templates.gift_refunded_admin({
    giftNumber: "GA1B2C3D4",
    purchaserName: "Maria Smith",
    purchaserEmail: "maria@example.com",
    recipientName: "John Smith",
    recipientEmail: "john@example.com",
    plan: "Plus",
    durationMonths: 2,
    refundAmount: "$100.00",
    refundedTotal: "$100.00",
    amountPaid: "$541.58",
    refundStatus: "partial",
    giftState: "active",
  });
  for (const needed of [
    "GA1B2C3D4",
    "Maria Smith",
    "John Smith",
    "Plus",
    "$100.00",
    "$541.58",
    "partial",
  ]) {
    assert(email.html.includes(needed), `the notice should identify ${needed}`);
  }
  assert(/has NOT been revoked/i.test(email.html), "it must say access is unchanged");
  assert(email.subject.includes("GA1B2C3D4"));
});

test("nothing in the gift feature reaches for SMS", () => {
  // SMS is switched off pending Twilio, and gift launch must not depend on it.
  for (const file of [
    "utils/gifts/giftEmails.js",
    "utils/gifts/giftWebhook.js",
    "utils/gifts/giftService.js",
    "routes/gifts.js",
    "jobs/giftLifecycle.js",
  ]) {
    const source = codeOnly(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
    for (const sms of ["sendSms", "smsService", "utils/sms", "twilio"]) {
      assert(
        !source.toLowerCase().includes(sms.toLowerCase()),
        `${file} must not reference ${sms}`
      );
    }
  }
});

console.log("\nPromotion codes and the trial floor\n");

test("gift checkout accepts promotion codes, through Stripe's own system", () => {
  /*
   * Approved deliberately: every active code is unrestricted and two are
   * worth 100%. What matters is that nothing here reimplements any of it —
   * eligibility, expiry, redemption limits, first-time-customer rules and
   * the arithmetic are all Stripe's answers.
   */
  const giftRoute = fs.readFileSync(path.join(__dirname, "..", "routes", "gifts.js"), "utf8");
  assert.match(giftRoute, /allow_promotion_codes:\s*true/);

  // No discount may be computed, chosen or capped on our side.
  const code = codeOnly(giftRoute);
  for (const forbidden of ["percent_off", "amount_off", "discounts:", "coupon:"]) {
    assert(!code.includes(forbidden), `gift checkout must not reimplement ${forbidden}`);
  }

  // And membership checkout is unchanged.
  const stripeRoute = fs.readFileSync(path.join(__dirname, "..", "routes", "stripe.js"), "utf8");
  assert.match(stripeRoute, /allow_promotion_codes:\s*true/);
});

test("a 100% discount still produces a gift", () => {
  /*
   * The case that would have failed silently. A 100% code takes the total to
   * zero, and Stripe completes that session as "no_payment_required" with no
   * payment intent — accepting only "paid" meant the purchaser checked out
   * and no gift was ever created.
   */
  const webhook = fs.readFileSync(
    path.join(__dirname, "..", "utils", "gifts", "giftWebhook.js"),
    "utf8"
  );
  assert.match(webhook, /no_payment_required/, "a zero-total session must count as settled");
  assert.match(webhook, /SETTLED\.includes\(session\.payment_status\)/);

  // A null payment intent must not break the record.
  assert.match(webhook, /session\?\.payment_intent\?\.id \|\| null/);
});

test("the money recorded is Stripe's, discount included", () => {
  const webhook = fs.readFileSync(
    path.join(__dirname, "..", "utils", "gifts", "giftWebhook.js"),
    "utf8"
  );
  for (const field of [
    "amount_subtotal",
    "total_details?.amount_discount",
    "total_details?.amount_tax",
    "amount_total",
  ]) {
    assert(webhook.includes(field), `${field} must be read from the session`);
  }
  // Nothing derives a total locally.
  const code = codeOnly(webhook);
  assert(!/amountPaidCents:.*[-+*/]/.test(code), "the paid total must not be arithmetic");
});

test("the trial floor matches Stripe's measured minimum", () => {
  // Measured against live Stripe: 48h accepted, 47h rejected, with the error
  // "The `trial_end` date has to be at least 2 days in the future."
  const stripeRoute = fs.readFileSync(path.join(__dirname, "..", "routes", "stripe.js"), "utf8");
  assert.match(stripeRoute, /MIN_TRIAL_SECONDS = 48 \* 60 \* 60/);
});

console.log("\nDurations and pricing\n");

test("all five lengths are on sale, and one month is the default", () => {
  const saved = process.env.GIFT_DURATIONS;
  delete process.env.GIFT_DURATIONS;
  const config = require("../utils/gifts/giftConfig");
  assert.deepStrictEqual(config.offeredDurations(), [1, 2, 3, 6, 12]);
  assert.strictEqual(config.defaultDuration(), 1, "the screen starts on one month");
  if (saved !== undefined) process.env.GIFT_DURATIONS = saved;
});

test("every price is the monthly catalogue rate times the months", () => {
  const { quoteGift } = require("../utils/gifts/giftPricing");
  const { PLAN_CATALOG } = require("../utils/subscriptionManagement");

  /*
   * The approved table, in cents. Twelve months is the ANNUAL membership
   * price - Pay 10, Get 12 - and every shorter length is the monthly rate
   * times the months.
   */
  const expected = {
    basic: { 1: 14900, 2: 29800, 3: 44700, 6: 89400, 12: 149000 },
    plus: { 1: 24900, 2: 49800, 3: 74700, 6: 149400, 12: 249000 },
    premium: { 1: 34900, 2: 69800, 3: 104700, 6: 209400, 12: 349000 },
    elite: { 1: 49900, 2: 99800, 3: 149700, 6: 299400, 12: 499000 },
  };

  for (const [plan, byMonths] of Object.entries(expected)) {
    const monthly = Math.round(Number(PLAN_CATALOG[plan].monthly.price) * 100);
    for (const [months, cents] of Object.entries(byMonths)) {
      const quote = quoteGift({ plan, durationMonths: Number(months) });
      assert.strictEqual(quote.ok, true, `${plan}/${months} should quote`);
      assert.strictEqual(
        quote.totalCents,
        cents,
        `${plan} x ${months} should be ${cents}, got ${quote.totalCents}`
      );
      /*
       * And genuinely derived from the catalog, not a second copy of the
       * table: twelve months reads the annual price, everything else the
       * monthly one.
       */
      const fromCatalog =
        Number(months) === 12
          ? Math.round(Number(PLAN_CATALOG[plan].annual.price) * 100)
          : monthly * Number(months);
      assert.strictEqual(quote.totalCents, fromCatalog);
    }
  }
});

test("the annual rate comes from the catalog, not a second price list", () => {
  /*
   * The rule reversed on instruction: a twelve-month gift now costs what a
   * year of membership costs. The thing worth protecting is that there is
   * ONE annual price - change it for membership and the gift follows.
   */
  const { quoteGift } = require("../utils/gifts/giftPricing");
  const { PLAN_CATALOG } = require("../utils/subscriptionManagement");

  for (const plan of ["basic", "plus", "premium", "elite"]) {
    const twelve = quoteGift({ plan, durationMonths: 12 });
    assert.strictEqual(
      twelve.totalCents,
      Math.round(Number(PLAN_CATALOG[plan].annual.price) * 100),
      `${plan} must read the catalog's annual price`
    );
  }

  /* No gift price may be written down anywhere but the catalog. */
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(
    path.join(__dirname, "../utils/gifts/giftPricing.js"),
    "utf8"
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const literal of ["149000", "249000", "349000", "499000", "1490", "2490", "3490", "4990"]) {
    assert.ok(
      !code.includes(literal),
      `giftPricing hardcodes ${literal}; prices belong in the catalog`
    );
  }
});

test("the line item carries the chosen length, at every length", () => {
  const { stripeLineItem } = require("../utils/gifts/giftPricing");
  for (const months of [1, 2, 3, 6, 12]) {
    const item = stripeLineItem({ plan: "plus", durationMonths: months, productId: FAKE_PRODUCT });
    /*
     * The charged amount, which is the point: the Checkout line item must
     * carry the same total the purchase screen quoted, annual rate included.
     */
    const { quoteGift } = require("../utils/gifts/giftPricing");
    const expectedCents = quoteGift({ plan: "plus", durationMonths: months }).totalCents;
    assert.strictEqual(item.price_data.unit_amount, expectedCents);
    if (months === 12) {
      const { PLAN_CATALOG } = require("../utils/subscriptionManagement");
      assert.strictEqual(
        expectedCents,
        Math.round(Number(PLAN_CATALOG.plus.annual.price) * 100),
        "a twelve-month gift must CHARGE the annual price, not just display it"
      );
    }
    assert(!JSON.stringify(item).includes("recurring"), "still no recurring at any length");
  }
});

console.log("\nThe launch duration gate\n");

/*
 * A real request against the real router, with no database and no Stripe.
 *
 * The unit tests already prove isOfferedDuration(6) is false. That is not the
 * same claim as "a purchaser cannot buy six months", which is about the route
 * and is what actually protects the launch. The gate sits ahead of the
 * database lookup precisely so this can be asserted end to end here.
 */
function callCheckout(durationMonths, { offered } = {}) {
  const express = require("express");
  const http = require("http");

  const previous = process.env.GIFT_DURATIONS;
  if (offered !== undefined) process.env.GIFT_DURATIONS = offered;

  // Products must look configured or the selling gate answers first.
  const productEnv = {
    STRIPE_PRODUCT_GIFT_BASIC: "prod_GiftBasicTest01",
    STRIPE_PRODUCT_GIFT_PLUS: "prod_GiftPlusTest01",
    STRIPE_PRODUCT_GIFT_PREMIUM: "prod_GiftPremiumTest1",
    STRIPE_PRODUCT_GIFT_ELITE: "prod_GiftEliteTest01",
  };
  const savedProducts = {};
  for (const [k, v] of Object.entries(productEnv)) {
    savedProducts[k] = process.env[k];
    process.env[k] = v;
  }
  const savedKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = savedKey || "sk_test_placeholder";

  return new Promise((resolve) => {
    /*
     * Replace the auth middleware in the module cache before the router is
     * loaded. The route attaches auth itself, so an app-level shim cannot get
     * past it, and the real one would need a database. Authentication is not
     * what is under test here — the duration gate is, and it runs before the
     * user is ever loaded.
     */
    const authPath = require.resolve("../middleware/auth");
    const routerPath = require.resolve("../routes/gifts");
    const realAuth = require.cache[authPath];
    require.cache[authPath] = {
      id: authPath,
      filename: authPath,
      loaded: true,
      exports: (req, _res, next) => {
        req.user = { id: "000000000000000000000001" };
        next();
      },
    };
    delete require.cache[routerPath];
    const giftRouter = require("../routes/gifts");
    delete require.cache[routerPath];
    if (realAuth) require.cache[authPath] = realAuth;
    else delete require.cache[authPath];

    const app = express();
    app.use(express.json());
    app.use("/api/gifts", giftRouter);

    const server = app.listen(0, () => {
      const body = JSON.stringify({
        plan: "elite",
        durationMonths,
        recipient: { email: "someone@example.com", firstName: "A", lastName: "B" },
        address: { line1: "1 Main St", city: "Babylon", state: "NY", zip: "11702" },
      });
      const req = http.request(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path: "/api/gifts/checkout-session",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => {
            server.close();
            for (const [k, v] of Object.entries(savedProducts)) {
              if (v === undefined) delete process.env[k];
              else process.env[k] = v;
            }
            if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
            if (previous === undefined) delete process.env.GIFT_DURATIONS;
            else process.env.GIFT_DURATIONS = previous;
            let parsed = {};
            try {
              parsed = JSON.parse(raw);
            } catch (e) {
              parsed = { raw };
            }
            resolve({ status: res.statusCode, body: parsed });
          });
        }
      );
      req.on("error", () => resolve({ status: "ERR", body: {} }));
      req.write(body);
      req.end();
    });
  });
}

async function durationGateTests() {
  // 1, 2, 3, 6 and 12 are on sale now; everything else is still refused.
  const mustRefuse = [24, 0, -2, 2.5, 4, 18, 100, null, undefined, "two", "", {}];
  for (const value of mustRefuse) {
    const res = await callCheckout(value);
    const label = `a request for ${JSON.stringify(value)} months is refused`;
    try {
      assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
      assert.strictEqual(res.body.code, "UNSUPPORTED_DURATION");
      passed += 1;
      console.log(`  PASS  ${label}`);
    } catch (error) {
      failures.push({ name: label, error });
      console.log(`  FAIL  ${label}\n        ${error.message}`);
    }
  }

  // The gate is config, not a hardcoded 2: it opens when launch says so.
  const label = "the gate is configuration, so a length can still be withdrawn";
  try {
    const openNow = await callCheckout(6);
    assert.notStrictEqual(openNow.body.code, "UNSUPPORTED_DURATION", "6 is on sale today");
    const withdrawn = await callCheckout(6, { offered: "1,2" });
    assert.strictEqual(
      withdrawn.body.code,
      "UNSUPPORTED_DURATION",
      "narrowing GIFT_DURATIONS must close it again"
    );
    passed += 1;
    console.log(`  PASS  ${label}`);
  } catch (error) {
    failures.push({ name: label, error });
    console.log(`  FAIL  ${label}\n        ${error.message}`);
  }

  const twoLabel = "every offered length is actually purchasable";
  try {
    const { offeredDurations } = require("../utils/gifts/giftConfig");
    const saved = process.env.GIFT_DURATIONS;
    delete process.env.GIFT_DURATIONS;
    for (const months of offeredDurations()) {
      const res = await callCheckout(months);
      assert.notStrictEqual(
        res.body.code,
        "UNSUPPORTED_DURATION",
        `${months} months is offered and must be buyable`
      );
    }
    if (saved !== undefined) process.env.GIFT_DURATIONS = saved;
    passed += 1;
    console.log(`  PASS  ${twoLabel}`);
  } catch (error) {
    failures.push({ name: twoLabel, error });
    console.log(`  FAIL  ${twoLabel}\n        ${error.message}`);
  }
}

/* ------------------------------------------------------------------ */

durationGateTests().then(() => {
  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) {
    for (const { name, error } of failures) {
      console.error(`\n--- ${name} ---`);
      console.error(error);
    }
    process.exit(1);
  }
});
