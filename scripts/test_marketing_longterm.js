/**
 * The marketing engine over years, not over single decisions.
 *
 * The first version of this system passed 76 tests and still had two defects
 * that only appear after months of decisions: former members went permanently
 * silent after seven emails, and every audience ran out of content inside a
 * year. Both were invisible to tests that asked "is this one campaign allowed
 * right now".
 *
 * So this suite does not test a decision. It runs the real selectCampaign
 * across a simulated calendar, day by day, for two to three years, and asserts
 * properties of the whole resulting stream: that it never dries up, that the
 * mix stays mostly helpful for members, and that nothing is starved.
 *
 *   node scripts/test_marketing_longterm.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake_for_unit_tests";
process.env.EMAIL_TOKEN_SECRET = process.env.EMAIL_TOKEN_SECRET || "test-secret-for-unsubscribe";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const assert = require("assert");
const { KIND, audiencesOf, ALL_TEMPLATES } = require("../utils/marketing/marketingLibrary");
const { selectCampaign } = require("../utils/marketing/marketingScheduler");
const { COOLDOWN_DAYS, HELP_TARGET, FREQUENCY } = require("../utils/marketing/marketingConfig");

const DAY = 24 * 60 * 60 * 1000;
/** Day 0 is Monday 2026-09-14. */
const START = new Date("2026-09-14T14:00:00Z");
const dayDate = (d) => new Date(START.getTime() + d * DAY);
const ACTIVATION_WINDOW_DAYS = 14;

const weekday = (d) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(dayDate(d));
const isWeekday = (d) => !["Sat", "Sun"].includes(weekday(d));

function baseProfile(overrides = {}) {
  return {
    user: { _id: overrides.id || "sim", email: "sim@profixter-sim.net" },
    now: START,
    audience: "non_member",
    plan: null,
    billingCycle: "monthly",
    cancellationPending: false,
    memberSince: null,
    registeredAt: START,
    lastMarketingAt: null,
    lastMarketingCategory: "",
    everMarketed: false,
    helpShare: null,
    recentKinds: [],
    campaignLastSentAt: new Map(),
    campaignCycles: new Map(),
    sentTopicAt: new Map(),
    hasActiveBooking: false,
    everBooked: false,
    hasMembershipBooking: false,
    recentlyCancelledBooking: false,
    boughtFullDayRecently: false,
    boughtOneTimeRecently: false,
    freeVisitUsed: false,
    paymentTrouble: false,
    projectLead: null,
    inActivationWindow: false,
    ...overrides,
  };
}

const HELP_WINDOW = 12;

/**
 * Run the real scheduler across a calendar.
 *
 * Everything the runner would do to the profile after a send is done here too,
 * so the state the scheduler sees on day N is the state production would have.
 */
function simulate({ days, profile, events = {}, annual = false }) {
  const p = profile;
  const sent = [];
  const kinds = [];

  for (let d = 0; d <= days; d += 1) {
    if (events[d]) events[d](p, d);
    if (!isWeekday(d)) continue;
    p.now = dayDate(d);

    // findCandidates excludes accounts under 2 days old.
    if (p.now.getTime() - new Date(p.registeredAt).getTime() < 2 * DAY) continue;
    // personEligible blocks everything after a cancellation.
    if (p.cancelledAt && (p.now - p.cancelledAt) / DAY < COOLDOWN_DAYS.afterMembershipCancelled) continue;
    if (p.bookingCancelledAt && (p.now - p.bookingCancelledAt) / DAY < COOLDOWN_DAYS.afterBookingCancelled) continue;
    if (p.unsubscribedAt && p.now >= p.unsubscribedAt) continue;

    // The runner derives this from live booking state on every cycle.
    const memberDays = p.memberSince ? (p.now - new Date(p.memberSince)) / DAY : Infinity;
    p.inActivationWindow =
      p.audience === "member" && !p.hasMembershipBooking && memberDays <= ACTIVATION_WINDOW_DAYS;

    const { template } = selectCampaign(p, { annualPricingWorking: annual });
    if (!template) continue;

    sent.push({
      day: d, id: template.id, subject: template.subject,
      category: template.category, kind: template.kind, audience: p.audience,
    });

    kinds.push(template.kind);
    const recent = kinds.slice(-HELP_WINDOW);
    p.helpShare = recent.filter((k) => k === KIND.HELP).length / recent.length;
    p.lastMarketingAt = dayDate(d);
    p.lastMarketingCategory = template.category;
    p.everMarketed = true;
    p.campaignLastSentAt.set(template.id, dayDate(d));
    p.campaignCycles.set(template.id, (p.campaignCycles.get(template.id) || 0) + 1);
    p.sentTopicAt.set(template.topic, dayDate(d));
  }
  return sent;
}

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

const inYear = (rows, n) => rows.filter((r) => r.day > (n - 1) * 365 && r.day <= n * 365).length;
const helpRatio = (rows) => rows.filter((r) => r.kind === KIND.HELP).length / (rows.length || 1);
const maxGap = (rows) =>
  rows.length < 2 ? 0 : Math.max(...rows.slice(1).map((r, i) => r.day - rows[i].day));

/* ------------------------------------------------------------------ */
/* Two years, one audience at a time                                   */
/* ------------------------------------------------------------------ */

const NON_MEMBER = simulate({ days: 900, profile: baseProfile({ id: "nm" }) });
const MEMBER = simulate({
  days: 900, annual: true,
  profile: baseProfile({
    id: "mem", audience: "member", plan: "basic", billingCycle: "monthly",
    memberSince: new Date(START.getTime() - 400 * DAY),
    registeredAt: new Date(START.getTime() - 400 * DAY),
    hasMembershipBooking: true, everBooked: true, everMarketed: true,
  }),
});
const FORMER = simulate({
  days: 900,
  profile: baseProfile({
    id: "fm", audience: "former_member", everBooked: true, everMarketed: true,
    registeredAt: new Date(START.getTime() - 500 * DAY),
  }),
});

test("a non member still receives marketing in year two", () => {
  assert.ok(inYear(NON_MEMBER, 1) > 0, "year one is empty");
  assert.ok(inYear(NON_MEMBER, 2) >= 12, `year two had only ${inYear(NON_MEMBER, 2)} emails`);
});

test("a member still receives marketing in year two", () => {
  assert.ok(inYear(MEMBER, 2) >= 12, `year two had only ${inYear(MEMBER, 2)} emails`);
});

test("a former member still receives marketing in year two", () => {
  // The defect this suite exists for: 7 emails and then permanent silence.
  assert.ok(inYear(FORMER, 1) >= 15, `year one had only ${inYear(FORMER, 1)} emails`);
  assert.ok(inYear(FORMER, 2) >= 12, `year two had only ${inYear(FORMER, 2)} emails`);
});

test("nobody goes quiet for months at a time", () => {
  for (const [name, rows] of [["non member", NON_MEMBER], ["member", MEMBER], ["former member", FORMER]]) {
    assert.ok(maxGap(rows) <= 60, `${name} had a ${maxGap(rows)} day silence`);
  }
});

test("the former member reaches every campaign available to them", () => {
  const reachable = ALL_TEMPLATES.filter(
    (x) => audiencesOf(x).includes("former_member") && !x.firstContactOnly
  ).map((x) => x.id);
  const received = new Set(FORMER.map((r) => r.id));
  const never = reachable.filter((id) => !received.has(id));
  assert.deepStrictEqual(never, [], `unreachable for former members: ${never.join(", ")}`);
});

test("no campaign repeats inside its cooldown", () => {
  for (const [name, rows] of [["non member", NON_MEMBER], ["member", MEMBER], ["former member", FORMER]]) {
    const lastSeen = new Map();
    for (const r of rows) {
      if (lastSeen.has(r.id)) {
        const gap = r.day - lastSeen.get(r.id);
        assert.ok(gap >= COOLDOWN_DAYS.campaignReuse,
          `${name} saw ${r.id} again after ${gap} days`);
      }
      lastSeen.set(r.id, r.day);
    }
  }
});

test("campaigns do repeat once the cooldown has passed", () => {
  const repeated = new Set();
  for (const rows of [NON_MEMBER, MEMBER, FORMER]) {
    const seen = new Set();
    for (const r of rows) {
      if (seen.has(r.id)) repeated.add(r.id);
      seen.add(r.id);
    }
  }
  assert.ok(repeated.size > 0, "nothing ever repeated, so the library still runs dry");
});

test("the seven day floor is never broken", () => {
  for (const rows of [NON_MEMBER, MEMBER, FORMER]) {
    for (let i = 1; i < rows.length; i += 1) {
      const gap = rows[i].day - rows[i - 1].day;
      assert.ok(gap >= FREQUENCY.globalMinDays, `two emails ${gap} days apart`);
    }
  }
});

test("members get mostly helpful mail over the long run", () => {
  const ratio = helpRatio(MEMBER);
  assert.ok(ratio >= 0.6, `only ${(ratio * 100).toFixed(0)}% of member mail was helpful`);
  assert.ok(ratio <= 0.85, `${(ratio * 100).toFixed(0)}% helpful leaves no room to sell at all`);
});

test("the member help ratio lands near the configured target", () => {
  const ratio = helpRatio(MEMBER);
  assert.ok(Math.abs(ratio - HELP_TARGET) < 0.12,
    `ratio ${(ratio * 100).toFixed(0)}% against a target of ${(HELP_TARGET * 100).toFixed(0)}%`);
});

test("home fix content is the backbone for everyone", () => {
  for (const [name, rows] of [["non member", NON_MEMBER], ["member", MEMBER], ["former member", FORMER]]) {
    const fix = rows.filter((r) => r.category === "fix").length / rows.length;
    assert.ok(fix >= 0.25, `${name} received only ${(fix * 100).toFixed(0)}% home fix mail`);
  }
});

/* ------------------------------------------------------------------ */
/* Transitions                                                         */
/* ------------------------------------------------------------------ */

test("a new member finishes activation before ordinary marketing starts", () => {
  const rows = simulate({
    days: 120, annual: true,
    profile: baseProfile({
      id: "new", audience: "member", plan: "premium", memberSince: START,
      registeredAt: new Date(START.getTime() - 200 * DAY), everMarketed: true,
    }),
  });
  assert.ok(rows.length, "the new member received nothing at all");
  assert.strictEqual(rows[0].category, "activation", `first email was ${rows[0].id}`);
  assert.strictEqual(rows[0].day, 3, `activation landed on day ${rows[0].day}, not day 3`);
  assert.strictEqual(rows[1].category, "activation", "the second activation email was displaced");

  const firstOrdinary = rows.find((r) => r.category !== "activation");
  assert.ok(firstOrdinary.day > ACTIVATION_WINDOW_DAYS,
    `ordinary marketing started on day ${firstOrdinary.day}, inside the activation window`);
});

test("booking mid-activation stops the second nudge and hands over to rotation", () => {
  const rows = simulate({
    days: 120, annual: true,
    profile: baseProfile({
      id: "books", audience: "member", plan: "premium", memberSince: START,
      registeredAt: new Date(START.getTime() - 200 * DAY), everMarketed: true,
    }),
    events: { 4: (p) => { p.hasMembershipBooking = true; p.everBooked = true; } },
  });
  assert.strictEqual(rows.filter((r) => r.category === "activation").length, 1,
    "the second activation email should have been cancelled by the booking");
  assert.ok(rows.length > 1, "they never entered normal rotation");
});

test("a non member who joins switches streams immediately", () => {
  const rows = simulate({
    days: 200, profile: baseProfile({ id: "joins" }),
    events: {
      40: (p) => { p.audience = "member"; p.plan = "plus"; p.memberSince = dayDate(40); },
    },
  });
  const before = rows.filter((r) => r.day < 40);
  const after = rows.filter((r) => r.day > 40);
  assert.ok(before.length && after.length, "no emails on one side of the switch");
  assert.ok(before.every((r) => r.audience === "non_member"));
  assert.ok(after.every((r) => r.audience === "member"));
  assert.ok(!after.some((r) => r.category === "free_visit"), "a member was offered a free first visit");
});

test("switching to annual billing stops annual conversion mail", () => {
  const rows = simulate({
    days: 500, annual: true,
    profile: baseProfile({
      id: "annual", audience: "member", plan: "premium", billingCycle: "monthly",
      memberSince: new Date(START.getTime() - 300 * DAY),
      registeredAt: new Date(START.getTime() - 300 * DAY),
      hasMembershipBooking: true, everBooked: true, everMarketed: true,
    }),
    events: { 120: (p) => { p.billingCycle = "annual"; } },
  });
  const after = rows.filter((r) => r.day > 120 && r.category === "annual");
  assert.deepStrictEqual(after.map((r) => r.id), [], "annual mail continued after they went annual");
});

test("a member who cancels waits out the cooling period then gets former member mail", () => {
  const rows = simulate({
    days: 400, annual: true,
    profile: baseProfile({
      id: "cancels", audience: "member", plan: "plus",
      memberSince: new Date(START.getTime() - 300 * DAY),
      registeredAt: new Date(START.getTime() - 300 * DAY),
      hasMembershipBooking: true, everBooked: true, everMarketed: true,
    }),
    events: {
      100: (p) => { p.audience = "former_member"; p.cancelledAt = dayDate(100); p.plan = null; },
    },
  });
  const during = rows.filter((r) => r.day > 100 && r.day < 100 + COOLDOWN_DAYS.afterMembershipCancelled);
  assert.deepStrictEqual(during.map((r) => r.id), [], "marketing continued through the cooling period");
  const after = rows.filter((r) => r.day > 114);
  assert.ok(after.length >= 10, `only ${after.length} emails after cancelling`);
  assert.ok(after.every((r) => r.audience === "former_member"));
});

test("a former member who rejoins goes back to member content", () => {
  const rows = simulate({
    days: 400, annual: true,
    profile: baseProfile({
      id: "returns", audience: "former_member", everBooked: true, everMarketed: true,
      registeredAt: new Date(START.getTime() - 500 * DAY),
    }),
    events: {
      120: (p) => {
        p.audience = "member"; p.plan = "basic"; p.memberSince = dayDate(120);
        p.hasMembershipBooking = true;
      },
    },
  });
  const after = rows.filter((r) => r.day > 120);
  assert.ok(after.length >= 10, `only ${after.length} emails after rejoining`);
  assert.ok(after.every((r) => r.audience === "member"));
  assert.ok(helpRatio(after) >= 0.55, "a returning member was sold to more than helped");
});

test("a failed payment stops selling and lets helpful mail through", () => {
  const rows = simulate({
    days: 400, annual: true,
    profile: baseProfile({
      id: "declined", audience: "member", plan: "plus",
      memberSince: new Date(START.getTime() - 300 * DAY),
      registeredAt: new Date(START.getTime() - 300 * DAY),
      hasMembershipBooking: true, everBooked: true, everMarketed: true,
    }),
    events: {
      100: (p) => { p.paymentTrouble = true; },
      200: (p) => { p.paymentTrouble = false; },
    },
  });
  const during = rows.filter((r) => r.day > 100 && r.day <= 200);
  assert.ok(during.length, "they went completely silent, which was not the intent");
  assert.deepStrictEqual(
    during.filter((r) => r.kind === KIND.SELL).map((r) => r.id),
    [], "a selling email went out while their payment was failing"
  );
  const after = rows.filter((r) => r.day > 200 && r.kind === KIND.SELL);
  assert.ok(after.length, "selling never resumed after the payment recovered");
});

test("a project lead pauses project mail without silencing everything", () => {
  const rows = simulate({
    days: 400,
    profile: baseProfile({ id: "lead", registeredAt: new Date(START.getTime() - 300 * DAY), everMarketed: true }),
    events: {
      50: (p) => { p.projectLead = { service: "kitchen", createdAt: dayDate(50) }; },
      [50 + COOLDOWN_DAYS.afterProjectLead]: (p) => { p.projectLead = null; },
    },
  });
  const during = rows.filter((r) => r.day > 50 && r.day <= 50 + COOLDOWN_DAYS.afterProjectLead);
  assert.ok(during.length, "they went completely silent after asking for an estimate");
  assert.deepStrictEqual(
    during.filter((r) => r.category === "project").map((r) => r.id),
    [], "project mail continued while their estimate was in progress"
  );
});

test("unsubscribing mid rotation ends everything", () => {
  const rows = simulate({
    days: 400,
    profile: baseProfile({ id: "unsub", registeredAt: new Date(START.getTime() - 300 * DAY), everMarketed: true }),
    events: { 80: (p) => { p.unsubscribedAt = dayDate(80); } },
  });
  assert.ok(rows.some((r) => r.day < 80), "they received nothing before unsubscribing");
  assert.deepStrictEqual(rows.filter((r) => r.day >= 80).map((r) => r.id), [],
    "marketing continued after an unsubscribe");
});

test("an old account with no history is introduced before anything is sold", () => {
  const rows = simulate({
    days: 200,
    profile: baseProfile({
      id: "cold", registeredAt: new Date(START.getTime() - 300 * DAY), everMarketed: false,
    }),
  });
  assert.strictEqual(rows[0].category, "reintro", `first email was ${rows[0].id}`);
  assert.strictEqual(rows.filter((r) => r.category === "reintro").length, 1,
    "the reintroduction repeated");
});

/* ------------------------------------------------------------------ */

console.log(`\nmarketing long term: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f.name}\n        ${f.message}`);
  process.exit(1);
}
console.log(
  `two year volumes: non member ${NON_MEMBER.length}, member ${MEMBER.length}, former member ${FORMER.length}\n` +
  `member help ratio ${(helpRatio(MEMBER) * 100).toFixed(0)}% against a ${(HELP_TARGET * 100).toFixed(0)}% target`
);
process.exit(0);
