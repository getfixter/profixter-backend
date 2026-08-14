/**
 * The marketing engine, everything that can be proven without a database.
 *
 * Covers the library's integrity, the rendered email's compliance, the send
 * window, and every suppression rule in templateEligible. The rules are the
 * product here: an email that goes to the wrong person is worse than an email
 * that never goes, so the suppression tests outnumber everything else.
 *
 *   node scripts/test_marketing_system.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake_for_unit_tests";
process.env.EMAIL_TOKEN_SECRET = process.env.EMAIL_TOKEN_SECRET || "test-secret-for-unsubscribe";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const assert = require("assert");

const { API_BASE_URL, BUSINESS, ROUTES, routeUrl } = require("../utils/marketing/marketingConfig");
const {
  ALL_TEMPLATES,
  BY_ID,
  FIX_LIBRARY,
  KIND,
  audiencesOf,
  ctaFor,
  NON_MEMBER_LIFECYCLE,
} = require("../utils/marketing/marketingLibrary");
const {
  daysSince,
  isMarketableAccount,
  seasonOf,
  templateEligible,
} = require("../utils/marketing/marketingEligibility");
const { inSendWindow, selectCampaign, wantsHelp } = require("../utils/marketing/marketingScheduler");
const { renderMarketingEmail } = require("../utils/marketing/marketingRenderer");

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
  }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-15T14:00:00Z");
const ago = (days) => new Date(NOW.getTime() - days * DAY);

/** A person who passes everything, so each test can break exactly one thing. */
function profile(overrides = {}) {
  return {
    user: { _id: "u1", email: "a@b.com", role: "customer", isActive: true },
    now: NOW,
    audience: "non_member",
    plan: null,
    billingCycle: "monthly",
    cancellationPending: false,
    memberSince: null,
    registeredAt: ago(400),
    lastMarketingAt: ago(60),
    lastMarketingCategory: "",
    campaignLastSentAt: new Map(),
    campaignCycles: new Map(),
    sentTopicAt: new Map(),
    everMarketed: true,
    helpShare: 1,
    recentKinds: [],
    paymentTrouble: false,
    projectLead: null,
    inActivationWindow: false,
    hasActiveBooking: false,
    everBooked: false,
    hasMembershipBooking: false,
    recentlyCancelledBooking: false,
    boughtFullDayRecently: false,
    boughtOneTimeRecently: false,
    freeVisitUsed: false,
    ...overrides,
  };
}

const t = (id) => {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`test refers to missing template ${id}`);
  return found;
};
const allows = (tpl, p, opts) => templateEligible(tpl, p, opts).eligible;
const blocks = (tpl, p, opts) => templateEligible(tpl, p, opts).reason;

/* ------------------------------------------------------------------ */
/* 1. Library integrity                                                */
/* ------------------------------------------------------------------ */

test("every campaign id is unique", () => {
  const ids = ALL_TEMPLATES.map((x) => x.id);
  assert.strictEqual(new Set(ids).size, ids.length, "duplicate campaign id");
});

test("every campaign id carries a version suffix", () => {
  const bad = ALL_TEMPLATES.filter((x) => !/_v\d+$/.test(x.id)).map((x) => x.id);
  assert.deepStrictEqual(bad, [], `unversioned: ${bad.join(", ")}`);
});

test("every campaign has the metadata the scheduler needs", () => {
  for (const tpl of ALL_TEMPLATES) {
    assert.ok(audiencesOf(tpl).every((a) => ["non_member", "member", "former_member"].includes(a)), `${tpl.id} audience`);
    assert.ok(tpl.category, `${tpl.id} category`);
    assert.ok(tpl.topic, `${tpl.id} topic`);
    assert.strictEqual(typeof tpl.priority, "number", `${tpl.id} priority`);
    assert.ok(tpl.subject && tpl.headline, `${tpl.id} copy`);
    assert.ok(Array.isArray(tpl.paragraphs) && tpl.paragraphs.length, `${tpl.id} paragraphs`);
  }
});

test("every call to action points at a real route", () => {
  for (const tpl of ALL_TEMPLATES) {
    assert.ok(ROUTES[tpl.ctaRoute], `${tpl.id} has unknown route ${tpl.ctaRoute}`);
    assert.ok(tpl.ctaLabel, `${tpl.id} has no CTA label`);
  }
});

test("every campaign offers an alternate subject line", () => {
  const missing = ALL_TEMPLATES.filter((x) => !x.altSubject).map((x) => x.id);
  assert.deepStrictEqual(missing, [], `no altSubject: ${missing.join(", ")}`);
});

test("subject lines are distinct within an audience", () => {
  for (const audience of ["non_member", "member"]) {
    const subjects = ALL_TEMPLATES.filter((x) => audiencesOf(x).includes(audience)).map((x) => x.subject);
    assert.strictEqual(
      new Set(subjects).size,
      subjects.length,
      `duplicate subject inside ${audience}`
    );
  }
});

test("the library is large enough to rotate for years", () => {
  const nonMember = ALL_TEMPLATES.filter((x) => audiencesOf(x).includes("non_member")).length;
  const member = ALL_TEMPLATES.filter((x) => audiencesOf(x).includes("member")).length;
  assert.ok(nonMember >= 25, `only ${nonMember} non-member templates`);
  assert.ok(member >= 20, `only ${member} member templates`);
});

test("no copy contains an em dash", () => {
  const offenders = [];
  for (const tpl of ALL_TEMPLATES) {
    const text = JSON.stringify([tpl.subject, tpl.altSubject, tpl.preheader, tpl.headline,
      tpl.paragraphs, tpl.bullets, tpl.closing, tpl.ctaLabel]);
    if (text.includes("—")) offenders.push(tpl.id);
  }
  assert.deepStrictEqual(offenders, [], `em dash in: ${offenders.join(", ")}`);
});

test("no campaign makes a claim we cannot honour", () => {
  // Guards against copy drifting into discounts, guarantees or urgency that the
  // product does not actually offer.
  const forbidden = /\b(guarantee|guaranteed|free estimate|limited time|act now|expires|24 hours only|lowest price|cheapest|best price)\b/i;
  const offenders = [];
  for (const tpl of ALL_TEMPLATES) {
    const text = [tpl.subject, tpl.altSubject, tpl.preheader, tpl.headline, tpl.closing,
      ...(tpl.paragraphs || []), ...(tpl.bullets || [])]
      .filter((x) => typeof x === "string").join(" ");
    if (forbidden.test(text)) offenders.push(tpl.id);
  }
  assert.deepStrictEqual(offenders, [], `unsupported claim in: ${offenders.join(", ")}`);
});

test("the non-member lifecycle runs in ascending day order", () => {
  const days = NON_MEMBER_LIFECYCLE.map((x) => x.lifecycleDay);
  assert.deepStrictEqual(days, [...days].sort((a, b) => a - b), "lifecycle out of order");
  assert.ok(days[0] >= 2, "first lifecycle email is too early");
});

test("the specific home-fix library is the largest non-member category", () => {
  const counts = {};
  for (const tpl of ALL_TEMPLATES.filter((x) => audiencesOf(x).includes("non_member"))) {
    counts[tpl.category] = (counts[tpl.category] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  assert.strictEqual(top[0], "fix", `largest category was ${top[0]}`);
  assert.ok(top[1] >= 10, `only ${top[1]} home-fix emails`);
});

test("every annual campaign is gated behind the price check", () => {
  const ungated = ALL_TEMPLATES.filter(
    (x) => x.category === "annual" && x.requiresAnnualPricingWorking !== true
  ).map((x) => x.id);
  assert.deepStrictEqual(ungated, [], `ungated annual: ${ungated.join(", ")}`);
});

/* ------------------------------------------------------------------ */
/* 2. The rendered email                                               */
/* ------------------------------------------------------------------ */

const SAMPLE_TO = { name: "Dana", email: "dana@example.com" };
const sample = renderMarketingEmail(t("nonmember_free_visit_v1"), SAMPLE_TO);

test("every email carries the postal address", () => {
  assert.ok(sample.html.includes(BUSINESS.addressLine));
  assert.ok(sample.text.includes(BUSINESS.addressLine));
});

test("the unsubscribe link points at the API host, not the website", () => {
  // /api/email/unsubscribe is an Express route. Aimed at the site it would 404,
  // which is both a dead link and a compliance failure.
  assert.strictEqual(
    sample.unsubscribeUrl.startsWith(API_BASE_URL),
    true,
    `unsubscribe pointed at ${sample.unsubscribeUrl}`
  );
  assert.notStrictEqual(API_BASE_URL, routeUrl("book").replace("/book", ""));
});

test("customer links avoid the apex redirect", () => {
  // CLIENT_URL and PUBLIC_SITE_BASE_URL are the apex in production and 307 to
  // www. Marketing links must not spend a redirect on every click.
  assert.ok(routeUrl("book").startsWith("https://www."), routeUrl("book"));
});

test("every email carries a working unsubscribe link", () => {
  assert.ok(/\/api\/email\/unsubscribe\?token=/.test(sample.unsubscribeUrl));
  assert.ok(sample.html.includes(sample.unsubscribeUrl.replace(/&/g, "&amp;")) ||
    sample.html.includes(sample.unsubscribeUrl));
  assert.ok(sample.text.includes(sample.unsubscribeUrl));
});

test("every email promises transactional mail continues", () => {
  const promise = "You will still receive booking and account emails";
  assert.ok(sample.html.includes(promise));
  assert.ok(sample.text.includes(promise));
});

test("the unsubscribe token is opaque and needs no login", () => {
  const token = sample.unsubscribeUrl.split("token=")[1];
  assert.ok(token.length > 40, "token too short to be safe");
  assert.ok(!decodeURIComponent(token).includes("dana@example.com"), "token leaks the address");
});

test("customer-supplied content cannot become markup", () => {
  const evil = renderMarketingEmail(t("nonmember_free_visit_v1"), {
    name: '<script>alert(1)</script>',
    email: "x@example.com",
  });
  assert.ok(!evil.html.includes("<script>"), "script tag survived escaping");
  assert.ok(evil.html.includes("&lt;script&gt;"));
});

test("the email refuses to render without a recipient", () => {
  assert.throws(() => renderMarketingEmail(t("nonmember_free_visit_v1"), { name: "A" }));
});

test("the email refuses to render without a postal address", () => {
  const original = BUSINESS.addressLine;
  BUSINESS.addressLine = "";
  try {
    assert.throws(
      () => renderMarketingEmail(t("nonmember_free_visit_v1"), { name: "A", email: "a@b.com" }),
      /addressLine/
    );
  } finally {
    BUSINESS.addressLine = original;
  }
});

test("the plain text version contains no markup", () => {
  assert.ok(!/<[a-z/][^>]*>/i.test(sample.text), "html leaked into the text part");
});

test("the email loads no remote images", () => {
  assert.ok(!/<img/i.test(sample.html), "remote image would break on image blocking");
});

test("every campaign in the library renders", () => {
  for (const tpl of ALL_TEMPLATES) {
    const out = renderMarketingEmail(tpl, { name: "Sam", email: "sam@example.com" });
    assert.ok(out.subject && out.html.length > 400 && out.text.length > 80, `${tpl.id} rendered thin`);
    assert.ok(out.ctaUrl.startsWith("https://"), `${tpl.id} CTA is not absolute`);
  }
});

test("the first-name variable is filled, never left raw", () => {
  const out = renderMarketingEmail(t("nonmember_free_visit_v1"), { name: "Dana", email: "d@e.com" });
  assert.ok(out.html.includes("Hi Dana,"), "greeting did not interpolate");
  assert.ok(!out.html.includes("${"), "unresolved template placeholder");
});

/* ------------------------------------------------------------------ */
/* 3. Send window                                                      */
/* ------------------------------------------------------------------ */

test("sends only inside the late morning window", () => {
  // 2026-09-15 is a Tuesday. New York is UTC-4 that week.
  assert.strictEqual(inSendWindow(new Date("2026-09-15T14:30:00Z")), true, "10:30 ET should send");
  assert.strictEqual(inSendWindow(new Date("2026-09-15T09:00:00Z")), false, "05:00 ET must not");
  assert.strictEqual(inSendWindow(new Date("2026-09-15T03:00:00Z")), false, "23:00 ET must not");
  assert.strictEqual(inSendWindow(new Date("2026-09-15T16:00:00Z")), false, "12:00 ET is past it");
});

test("never sends at the weekend", () => {
  assert.strictEqual(inSendWindow(new Date("2026-09-19T14:30:00Z")), false, "Saturday");
  assert.strictEqual(inSendWindow(new Date("2026-09-20T14:30:00Z")), false, "Sunday");
});

/* ------------------------------------------------------------------ */
/* 4. Who may be marketed to                                           */
/* ------------------------------------------------------------------ */

test("staff and test accounts are never marketed to", () => {
  assert.ok(isMarketableAccount({ role: "customer", email: "a@b.com" }));
  assert.ok(!isMarketableAccount({ role: "admin", email: "a@b.com" }), "admin");
  assert.ok(!isMarketableAccount({ role: "employee", email: "a@b.com" }), "employee");
  assert.ok(!isMarketableAccount({ role: "customer", email: "a@b.com", employeePosition: "Fixter" }), "fixter");
  assert.ok(!isMarketableAccount({ role: "customer", email: "a@b.com", isActive: false }), "deactivated");
  assert.ok(!isMarketableAccount({ role: "customer", email: "not-an-email" }), "malformed address");
  assert.ok(!isMarketableAccount(null), "missing user");
});

test("legacy accounts with no role are still customers", () => {
  // Most of the real customer base predates the role field. Reading a missing
  // role as "not a customer" would exclude the majority of the database.
  assert.ok(isMarketableAccount({ email: "legacy@optonline.net" }), "legacy customer excluded");
  assert.ok(
    !isMarketableAccount({ email: "legacy@optonline.net", employeePosition: "Fixter" }),
    "staff must still be identified positively"
  );
});

/* ------------------------------------------------------------------ */
/* 5. Suppression rules                                                */
/* ------------------------------------------------------------------ */

test("a campaign never reaches the wrong audience", () => {
  assert.strictEqual(blocks(t("member_referral_v1"), profile()), "wrong_audience");
  assert.strictEqual(
    blocks(t("nonmember_free_visit_v1"), profile({ audience: "member" })),
    "wrong_audience"
  );
});

test("a campaign rests for fifteen months before it can repeat", () => {
  const fresh = profile({ campaignLastSentAt: new Map([["nonmember_free_visit_v1", ago(200)]]) });
  assert.strictEqual(blocks(t("nonmember_free_visit_v1"), fresh), "campaign_cooldown");

  const stale = profile({
    campaignLastSentAt: new Map([["nonmember_free_visit_v1", ago(500)]]),
    sentTopicAt: new Map([["free_visit", ago(500)]]),
  });
  assert.ok(allows(t("nonmember_free_visit_v1"), stale), "should be reusable after the cooldown");
});

test("a topic rests for 90 days", () => {
  const recent = profile({ sentTopicAt: new Map([["doors", ago(30)]]) });
  assert.strictEqual(blocks(t("fix_doors_v1"), recent), "topic_cooldown");

  const stale = profile({ sentTopicAt: new Map([["doors", ago(120)]]) });
  assert.ok(allows(t("fix_doors_v1"), stale), "should be allowed after the cooldown");
});

test("the same category may follow itself, but never by preference", () => {
  // Superseded rule: this used to be a hard block, which permanently starved
  // any audience with few categories. It is now a sort preference.
  const p = profile({ lastMarketingCategory: "fix" });
  assert.ok(allows(t("fix_doors_v1"), p), "eligibility must not depend on the previous category");
  assert.ok(allows(t("nonmember_one_time_v1"), p));
});

test("the free first visit is never advertised to somebody who used it", () => {
  assert.strictEqual(
    blocks(t("nonmember_free_visit_v1"), profile({ freeVisitUsed: true })),
    "free_visit_already_used"
  );
});

test("an existing customer is never welcomed as a new one", () => {
  // The product would still grant the entitlement, but "thanks for setting up
  // your account" is wrong for somebody who has been booking for a year.
  assert.strictEqual(
    blocks(t("nonmember_free_visit_v1"), profile({ everBooked: true })),
    "already_an_existing_customer"
  );
  assert.ok(allows(t("nonmember_free_visit_v1"), profile({ registeredAt: ago(3) })));
});

test("annual campaigns stay suppressed while the prices are broken", () => {
  const p = profile({ registeredAt: ago(400) });
  assert.strictEqual(
    blocks(t("nonmember_annual_value_v1"), p, { annualPricingWorking: false }),
    "annual_pricing_unavailable"
  );
  assert.strictEqual(
    blocks(t("nonmember_annual_value_v1"), p, {}),
    "annual_pricing_unavailable",
    "an unknown price state must fail closed"
  );
  assert.ok(
    allows(t("nonmember_annual_value_v1"), p, { annualPricingWorking: true }),
    "should send once Stripe is fixed"
  );
});

test("annual is never offered to somebody already paying annually", () => {
  const annual = profile({ audience: "member", plan: "plus", billingCycle: "annual" });
  assert.strictEqual(
    blocks(t("member_annual_switch_v1"), annual, { annualPricingWorking: true }),
    "already_annual"
  );
});

test("an upgrade is never offered to the top plan", () => {
  const elite = profile({ audience: "member", plan: "elite" });
  assert.strictEqual(blocks(t("member_upgrade_next_plan_v1"), elite), "already_top_plan");

  const plus = profile({ audience: "member", plan: "plus" });
  assert.ok(allows(t("member_upgrade_next_plan_v1"), plus));
});

test("somebody who is leaving is not sold to", () => {
  const leaving = profile({ audience: "member", plan: "plus", cancellationPending: true });
  assert.strictEqual(blocks(t("member_upgrade_next_plan_v1"), leaving), "cancellation_pending");
  assert.strictEqual(blocks(t("member_referral_v1"), leaving), "cancellation_pending");
  assert.ok(allows(t("member_project_bigger_v1"), leaving), "helpful mail may continue");
});

test("a product is not advertised to somebody who just bought it", () => {
  assert.strictEqual(
    blocks(t("nonmember_full_day_v1"), profile({ boughtFullDayRecently: true })),
    "bought_full_day_recently"
  );
  assert.strictEqual(
    blocks(t("nonmember_one_time_v1"), profile({ boughtOneTimeRecently: true })),
    "bought_one_time_recently"
  );
});

test("activation stops the moment a member books", () => {
  const booked = profile({
    audience: "member", plan: "basic", memberSince: ago(4), hasMembershipBooking: true,
  });
  assert.strictEqual(
    blocks(t("member_activation_day3_v1"), booked),
    "already_booked_membership_visit"
  );
});

test("activation waits for its day, then gives up", () => {
  const early = profile({ audience: "member", plan: "basic", memberSince: ago(1) });
  assert.strictEqual(blocks(t("member_activation_day3_v1"), early), "activation_not_due");

  const due = profile({ audience: "member", plan: "basic", memberSince: ago(4) });
  assert.ok(allows(t("member_activation_day3_v1"), due), "day 4 should be due");

  const late = profile({ audience: "member", plan: "basic", memberSince: ago(40) });
  assert.strictEqual(blocks(t("member_activation_day3_v1"), late), "activation_window_passed");
});

test("lifecycle emails wait for their day", () => {
  const fresh = profile({ registeredAt: ago(1) });
  assert.strictEqual(blocks(t("nonmember_free_visit_v1"), fresh), "lifecycle_not_due");
  assert.ok(allows(t("nonmember_free_visit_v1"), profile({ registeredAt: ago(3) })));
});

test("seasonal emails only send in season", () => {
  const spring = new Date("2026-04-15T14:00:00Z");
  const member = profile({ audience: "member", plan: "basic", now: spring });
  assert.ok(allows(t("member_usage_season_spring_v1"), member), "spring in April");
  assert.strictEqual(blocks(t("member_usage_season_fall_v1"), member), "out_of_season");
  assert.strictEqual(seasonOf(new Date("2026-10-01T12:00:00Z")), "fall");
  assert.strictEqual(seasonOf(new Date("2026-01-05T12:00:00Z")), "winter");
});

test("a missing date reads as never, not as now", () => {
  assert.strictEqual(daysSince(null, NOW), Infinity);
  assert.strictEqual(Math.round(daysSince(ago(10), NOW)), 10);
});

/* ------------------------------------------------------------------ */
/* 6. Selection                                                        */
/* ------------------------------------------------------------------ */

test("a brand new account starts at the beginning of the sequence", () => {
  const p = profile({ registeredAt: ago(3), lastMarketingAt: null });
  const { template } = selectCampaign(p, { annualPricingWorking: false });
  assert.strictEqual(template.id, "nonmember_free_visit_v1");
});

test("activation outranks everything else for a new member", () => {
  const p = profile({
    audience: "member", plan: "basic", memberSince: ago(4),
    registeredAt: ago(200), lastMarketingAt: ago(60),
  });
  const { template } = selectCampaign(p, { annualPricingWorking: true });
  assert.strictEqual(template.id, "member_activation_day3_v1");
  assert.strictEqual(template.category, "activation");
});

test("the lifecycle is walked in order, not skipped", () => {
  const p = profile({
    registeredAt: ago(300),
    campaignLastSentAt: new Map([["nonmember_free_visit_v1", ago(200)]]),
    sentTopicAt: new Map([["free_visit", ago(200)]]),
    lastMarketingCategory: "free_visit",
  });
  const { template } = selectCampaign(p, { annualPricingWorking: false });
  assert.strictEqual(template.id, "nonmember_around_house_v1", "day 7 should follow day 2");
});

test("the frequency floor holds even when something is due", () => {
  const p = profile({ registeredAt: ago(300), lastMarketingAt: ago(3) });
  const { template } = selectCampaign(p, { annualPricingWorking: false });
  assert.strictEqual(template, null, "nothing should be selected inside the rotation pace");
});

test("a long-standing account still has somewhere to go", () => {
  // Everything already sent except the home-fix rotation: the engine must not
  // run out and start repeating.
  const sent = new Map(ALL_TEMPLATES.filter((x) => x.category !== "fix").map((x) => [x.id, ago(30)]));
  const p = profile({ registeredAt: ago(900), campaignLastSentAt: sent, lastMarketingCategory: "trust" });
  const { template, eligibleCount } = selectCampaign(p, { annualPricingWorking: false });
  assert.ok(template, "nothing left to send");
  assert.strictEqual(template.category, "fix");
  assert.ok(eligibleCount >= 10, `only ${eligibleCount} left in rotation`);
});

test("the least recently seen topic comes up first", () => {
  // Everything sent except the home-fix rotation itself, so priority and
  // lifecycle order are settled and only the topic recency tie-break is left.
  const fixIds = new Set(FIX_LIBRARY.map((x) => x.id));
  const sent = new Map(ALL_TEMPLATES.filter((x) => !fixIds.has(x.id)).map((x) => [x.id, ago(30)]));
  const p = profile({
    registeredAt: ago(900),
    campaignLastSentAt: sent,
    lastMarketingCategory: "trust",
    // Every home-fix topic is out of cooldown, and doors was seen longest ago.
    sentTopicAt: new Map([
      ...FIX_LIBRARY.map((x) => [x.topic, ago(95)]),
      ["doors", ago(400)],
    ]),
  });
  const { template } = selectCampaign(p, { annualPricingWorking: false });
  assert.strictEqual(template.id, "fix_doors_v1");
});

test("a former member is served, and never chased", () => {
  const p = profile({
    audience: "former_member", registeredAt: ago(500), lastMarketingAt: null,
  });
  const { template, eligibleCount } = selectCampaign(p, { annualPricingWorking: false });
  assert.ok(template, "a former member had nothing at all to receive");
  assert.ok(eligibleCount >= 10, `only ${eligibleCount} campaigns for former members`);

  // Nothing aimed at them may read as a win-back offer.
  const theirs = ALL_TEMPLATES.filter((x) => audiencesOf(x).includes("former_member"));
  const pushy = /\b(come back|we miss you|win.?back|reactivate|special offer|discount)\b/i;
  const offenders = theirs.filter((x) =>
    pushy.test([x.subject, x.headline, ...(x.paragraphs || [])].filter((s) => typeof s === "string").join(" "))
  ).map((x) => x.id);
  assert.deepStrictEqual(offenders, [], `chasing copy in: ${offenders.join(", ")}`);
});

test("a paying member is helped before being sold anything else", () => {
  // An existing member with no marketing history at all: the very first thing
  // they ever receive must not be a pitch for a 499 dollar Full Day.
  const p = profile({
    audience: "member", plan: "plus", memberSince: ago(400),
    registeredAt: ago(400), lastMarketingAt: null, hasMembershipBooking: true,
    // No marketing history at all, which is what the whole base looks like today.
    helpShare: null, everMarketed: true,
  });
  const { template } = selectCampaign(p, { annualPricingWorking: true });
  assert.strictEqual(template.category, "usage", `first member email was ${template.id}`);
});

test("selection is deterministic", () => {
  const build = () => profile({ registeredAt: ago(900), lastMarketingCategory: "trust" });
  const a = selectCampaign(build(), { annualPricingWorking: false }).template.id;
  const b = selectCampaign(build(), { annualPricingWorking: false }).template.id;
  assert.strictEqual(a, b, "the same input produced two different choices");
});

test("selection records why each campaign was rejected", () => {
  const { considered } = selectCampaign(profile({ registeredAt: ago(1) }), {});
  const reasons = new Set(considered.map((x) => x.rejected));
  assert.ok(reasons.has("wrong_audience"));
  assert.ok(reasons.has("lifecycle_not_due"));
});

/* ------------------------------------------------------------------ */
/* 7. The correction pass                                              */
/* ------------------------------------------------------------------ */

test("help and sell are declared on every campaign", () => {
  const bad = ALL_TEMPLATES.filter((x) => ![KIND.HELP, KIND.SELL].includes(x.kind)).map((x) => x.id);
  assert.deepStrictEqual(bad, [], `missing kind: ${bad.join(", ")}`);
});

test("most of what a member can receive is helpful", () => {
  const theirs = ALL_TEMPLATES.filter((x) => audiencesOf(x).includes("member"));
  const help = theirs.filter((x) => x.kind === KIND.HELP).length;
  assert.ok(help / theirs.length >= 0.6, `only ${help} of ${theirs.length} member campaigns help`);
});

test("the help steer follows the recent mix", () => {
  assert.strictEqual(wantsHelp(profile({ helpShare: 0.2 })), true, "behind target should want help");
  assert.strictEqual(wantsHelp(profile({ helpShare: 0.9 })), false, "ahead of target should allow a sell");
  assert.strictEqual(wantsHelp(profile({ helpShare: null })), true, "no history should start helpful");
});

test("category variety is a preference, never a veto", () => {
  const fixIds = new Set(FIX_LIBRARY.map((x) => x.id));
  const sent = new Map(ALL_TEMPLATES.filter((x) => !fixIds.has(x.id)).map((x) => [x.id, ago(30)]));
  const p = profile({
    audience: "former_member", registeredAt: ago(900),
    campaignLastSentAt: sent, lastMarketingCategory: "fix",
  });
  const { template } = selectCampaign(p, { annualPricingWorking: false });
  assert.ok(template, "a same-category campaign was blocked with nothing else available");
  assert.strictEqual(template.category, "fix");
});

test("a different category still wins when one is available", () => {
  const p = profile({ registeredAt: ago(900), lastMarketingCategory: "fix", helpShare: 0.2 });
  const { template } = selectCampaign(p, { annualPricingWorking: false });
  assert.notStrictEqual(template.category, "fix", "variety should be preferred when possible");
});

test("a failed payment stops everything with a price on it", () => {
  const broke = profile({ audience: "member", plan: "plus", paymentTrouble: true });
  assert.strictEqual(blocks(t("member_upgrade_next_plan_v1"), broke), "recent_payment_failure");
  assert.strictEqual(blocks(t("member_full_day_list_v1"), broke), "recent_payment_failure");
  assert.strictEqual(blocks(t("member_referral_v1"), broke), "recent_payment_failure");
  assert.ok(allows(t("member_usage_five_things_v1"), broke), "helpful mail should continue");
  assert.ok(allows(t("fix_doors_v1"), broke), "home fix mail should continue");
});

test("a recent project lead stops project marketing only", () => {
  const p = profile({ projectLead: { service: "kitchen", createdAt: ago(5) } });
  assert.strictEqual(blocks(t("nonmember_project_kitchen_bath_v1"), p), "recent_project_lead");
  assert.strictEqual(blocks(t("nonmember_project_exterior_v1"), p), "recent_project_lead");
  assert.ok(allows(t("fix_doors_v1"), p), "unrelated useful mail should continue");
});

test("a new member sees nothing but activation until they book", () => {
  const p = profile({
    audience: "member", plan: "plus", memberSince: ago(4), inActivationWindow: true,
  });
  assert.strictEqual(blocks(t("member_usage_five_things_v1"), p), "activation_window_in_progress");
  assert.strictEqual(blocks(t("member_full_day_list_v1"), p), "activation_window_in_progress");
  assert.ok(allows(t("member_activation_day3_v1"), p), "activation itself must still send");

  const { template } = selectCampaign(p, { annualPricingWorking: true });
  assert.strictEqual(template.id, "member_activation_day3_v1");
});

test("a first contact email only reaches an older account with no history", () => {
  const older = profile({ registeredAt: ago(200), everMarketed: false });
  assert.ok(allows(t("reintro_non_member_v1"), older));

  assert.strictEqual(
    blocks(t("reintro_non_member_v1"), profile({ registeredAt: ago(200), everMarketed: true })),
    "already_marketed"
  );
  assert.strictEqual(
    blocks(t("reintro_non_member_v1"), profile({ registeredAt: ago(10), everMarketed: false })),
    "account_too_new_for_reintro"
  );
});

test("first contact beats the rotation but loses to activation", () => {
  const p = profile({ registeredAt: ago(300), everMarketed: false, lastMarketingAt: null });
  const { template } = selectCampaign(p, { annualPricingWorking: false });
  assert.strictEqual(template.id, "reintro_non_member_v1");

  const newMember = profile({
    audience: "member", plan: "plus", memberSince: ago(4), registeredAt: ago(300),
    everMarketed: false, lastMarketingAt: null, inActivationWindow: true,
  });
  assert.strictEqual(
    selectCampaign(newMember, { annualPricingWorking: false }).template.id,
    "member_activation_day3_v1"
  );
});

test("every audience has a first contact message", () => {
  for (const audience of ["non_member", "member", "former_member"]) {
    const found = ALL_TEMPLATES.filter(
      (x) => x.firstContactOnly && audiencesOf(x).includes(audience)
    );
    assert.strictEqual(found.length, 1, `${audience} has ${found.length} first contact emails`);
  }
});

test("a home fix email sends a member to their membership booking page", () => {
  assert.strictEqual(ctaFor(t("fix_doors_v1"), "member").route, "bookMembership");
  assert.strictEqual(ctaFor(t("fix_doors_v1"), "non_member").route, "book");
  assert.strictEqual(ctaFor(t("fix_doors_v1"), "former_member").route, "bookOneTime");
});

test("the rendered button follows the reader's audience", () => {
  const forMember = renderMarketingEmail(t("fix_doors_v1"), { ...SAMPLE_TO, audience: "member" });
  const forVisitor = renderMarketingEmail(t("fix_doors_v1"), { ...SAMPLE_TO, audience: "non_member" });
  assert.ok(forMember.ctaUrl.includes("visit=membership"), forMember.ctaUrl);
  assert.ok(!forVisitor.ctaUrl.includes("visit="), forVisitor.ctaUrl);
});

test("staff, excluded and unreachable accounts are all kept out", () => {
  assert.ok(!isMarketableAccount({ email: "a@b.com", excludeFromMarketing: true }), "explicit flag");
  assert.ok(!isMarketableAccount({ email: "a@example.com" }), "reserved domain");
  assert.ok(!isMarketableAccount({ email: "a@thing.test" }), "reserved suffix");
  assert.ok(isMarketableAccount({ email: "a@test.com" }), "test.com is a real registered domain");
});

test("calls to action are more varied than before", () => {
  const labels = ALL_TEMPLATES.map((x) => x.ctaLabel);
  const counts = {};
  for (const l of labels) counts[l] = (counts[l] || 0) + 1;
  const commonest = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  assert.ok(commonest[1] <= 6, `"${commonest[0]}" is used ${commonest[1]} times`);
  assert.ok(new Set(labels).size >= 20, `only ${new Set(labels).size} distinct CTA labels`);
});

test("question subjects are no longer the dominant pattern", () => {
  const questions = ALL_TEMPLATES.filter((x) => x.subject.endsWith("?")).length;
  assert.ok(questions / ALL_TEMPLATES.length < 0.25,
    `${questions} of ${ALL_TEMPLATES.length} subjects are questions`);
});

test("the copy reads as American English", () => {
  const britishisms = /\b(get round to|sort out|proper look|round the house|whilst|amongst|realise|organise)\b/i;
  const offenders = [];
  for (const tpl of ALL_TEMPLATES) {
    const text = [tpl.subject, tpl.altSubject, tpl.preheader, tpl.headline, tpl.closing,
      ...(tpl.paragraphs || []), ...(tpl.bullets || [])]
      .filter((x) => typeof x === "string").join(" ");
    if (britishisms.test(text)) offenders.push(tpl.id);
  }
  assert.deepStrictEqual(offenders, [], `British phrasing in: ${offenders.join(", ")}`);
});

test("the campaigns cut in review are gone", () => {
  for (const id of ["member_upgrade_priority_v1", "nonmember_membership_value_v1",
    "nonmember_share_v1", "nonmember_annual_second_v1", "member_annual_simple_v1"]) {
    assert.strictEqual(BY_ID.has(id), false, `${id} should have been removed`);
  }
});

/* ------------------------------------------------------------------ */

console.log(`
marketing system: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f.name}\n        ${f.message}`);
  process.exit(1);
}
console.log(`library: ${ALL_TEMPLATES.length} campaigns, ` +
  `${ALL_TEMPLATES.filter((x) => audiencesOf(x).includes("non_member")).length} non-member, ` +
  `${ALL_TEMPLATES.filter((x) => audiencesOf(x).includes("member")).length} member`);
console.log(`routes checked against ${Object.keys(ROUTES).length} real paths (${routeUrl("book")})`);
process.exit(0);
