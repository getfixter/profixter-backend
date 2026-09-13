/**
 * The Free First Visit lifecycle: Track A, Track B, and the bug between them.
 *
 * THE BUG THIS SUITE EXISTS FOR.
 *
 * Marketing used to ask "has this person any booking flagged isFreeFirstVisit?"
 * and treat any answer above zero as "offer used". A customer who booked their
 * free visit and cancelled it was therefore disqualified for life from an offer
 * the product still says is theirs - eight real customers, at the time this was
 * written. Half of this file is that distinction, asserted from every angle,
 * because it is the kind of thing that gets refactored back into a count.
 *
 * Everything here is pure. No database, no network, no email. The state machine
 * is fed literal bookings and the eligibility rules are fed literal profiles.
 *
 *   node scripts/test_free_visit_lifecycle.js
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake_for_unit_tests";
process.env.EMAIL_TOKEN_SECRET = process.env.EMAIL_TOKEN_SECRET || "test-secret-for-unsubscribe";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const assert = require("assert");

const {
  STATE,
  resolveFreeVisitState,
} = require("../utils/marketing/freeVisitLifecycle");
const {
  ALL_TEMPLATES,
  BY_ID,
  FINAL_FREE_VISIT_CAMPAIGN_ID,
  POST_FREE_VISIT,
} = require("../utils/marketing/marketingLibrary");
const {
  inPostFreeVisitSequence,
  personEligible,
  templateEligible,
} = require("../utils/marketing/marketingEligibility");
const { selectCampaign } = require("../utils/marketing/marketingScheduler");
const { renderMarketingEmail } = require("../utils/marketing/marketingRenderer");
const { renderSms } = require("../utils/sms/smsTemplates");
const { isMarketing } = require("../utils/sms/smsTypes");
const { estimateSegments, isUnicodeBody } = require("../utils/sms/smsPhone");

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
async function asyncTest(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
  }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-15T14:00:00Z");
const ago = (days) => new Date(NOW.getTime() - days * DAY);

const t = (id) => {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`test refers to missing template ${id}`);
  return found;
};
const allows = (tpl, p) => templateEligible(tpl, p).eligible;
const blocks = (tpl, p) => templateEligible(tpl, p).reason;

/** A person who passes everything, so each test breaks exactly one thing. */
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
    sentCategoryAt: new Map(),
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
    freeVisitState: STATE.AVAILABLE,
    freeVisitUsed: false,
    freeVisitOpen: false,
    freeVisitCompletedAt: null,
    daysSinceFreeVisit: Infinity,
    freeVisitSequenceClosed: false,
    ...overrides,
  };
}

/** Somebody who has had their free visit, n days ago. */
function trackB(days, overrides = {}) {
  return profile({
    freeVisitState: STATE.COMPLETED,
    freeVisitUsed: true,
    freeVisitCompletedAt: ago(days),
    daysSinceFreeVisit: days,
    everBooked: true,
    ...overrides,
  });
}

/* ================================================================== */
/* 1. The state machine                                               */
/* ================================================================== */

test("no bookings at all means the offer is available", () => {
  const r = resolveFreeVisitState([]);
  assert.strictEqual(r.state, STATE.AVAILABLE);
  assert.strictEqual(r.completedAt, null);
});

test("A CANCELLED FREE VISIT IS NOT A USED FREE VISIT", () => {
  /* The whole point of this module. Eight real customers were in this state. */
  for (const status of ["Canceled", "Cancelled", "canceled", "CANCELLED"]) {
    const r = resolveFreeVisitState([{ status, completedAt: null }]);
    assert.strictEqual(r.state, STATE.AVAILABLE, `${status} should return the offer`);
    assert.strictEqual(r.cancelledCount, 1);
  }
});

test("a booked visit that has not happened yet is open, not available", () => {
  for (const status of ["Pending", "Confirmed", "Scheduled", "", null]) {
    const r = resolveFreeVisitState([{ status, completedAt: null }]);
    assert.strictEqual(r.state, STATE.OPEN, `${status} should be open`);
  }
});

test("a completed visit is completed, by status or by completedAt", () => {
  const byStatus = resolveFreeVisitState([{ status: "Completed", completedAt: null }]);
  assert.strictEqual(byStatus.state, STATE.COMPLETED);

  const when = ago(5);
  const byStamp = resolveFreeVisitState([{ status: "Confirmed", completedAt: when }]);
  assert.strictEqual(byStamp.state, STATE.COMPLETED);
  assert.strictEqual(byStamp.completedAt.getTime(), when.getTime());
});

test("an unrecognised status leaves the offer spoken for rather than regranted", () => {
  /* No-show, Failed, anything new. We would rather they call us than be handed
     a second free visit on a guess. */
  const r = resolveFreeVisitState([{ status: "No-Show", completedAt: null }]);
  assert.strictEqual(r.state, STATE.OPEN);
});

test("completion wins over a later cancellation", () => {
  const r = resolveFreeVisitState([
    { status: "Completed", completedAt: ago(40) },
    { status: "Cancelled", completedAt: null },
  ]);
  assert.strictEqual(r.state, STATE.COMPLETED, "we have already been to the house");
});

test("the most recent completion is the anchor", () => {
  const r = resolveFreeVisitState([
    { status: "Completed", completedAt: ago(40) },
    { status: "Completed", completedAt: ago(3) },
  ]);
  assert.strictEqual(Math.round((NOW - r.completedAt) / DAY), 3);
});

test("cancel then rebook reads as open, and the offer was never lost", () => {
  const r = resolveFreeVisitState([
    { status: "Cancelled", completedAt: null },
    { status: "Confirmed", completedAt: null },
  ]);
  assert.strictEqual(r.state, STATE.OPEN);
  assert.strictEqual(r.cancelledCount, 1);
  assert.strictEqual(r.openCount, 1);
});

/* ================================================================== */
/* 2. Track A eligibility                                             */
/* ================================================================== */

const TRACK_A = ALL_TEMPLATES.filter((x) => x.requiresFreeVisitEligible);

test("Track A is four emails, in the approved order", () => {
  assert.deepStrictEqual(
    TRACK_A.map((x) => x.lifecycleDay),
    [2, 9, 21, 45]
  );
});

test("every Track A email leads with the free visit, not with membership", () => {
  for (const tpl of TRACK_A) {
    assert.strictEqual(tpl.category, "free_visit", `${tpl.id} is not a free-visit email`);
    assert.match(tpl.ctaLabel, /free visit/i, `${tpl.id} CTA should book the free visit`);
    assert.strictEqual(tpl.ctaRoute, "book", `${tpl.id} should point at booking`);
  }
});

test("A CUSTOMER WHOSE FREE VISIT WAS CANCELLED STAYS ELIGIBLE", () => {
  /* The bug, asserted through the rules rather than the state machine. */
  const cancelled = profile({ freeVisitState: STATE.AVAILABLE, freeVisitUsed: false });
  for (const tpl of TRACK_A) {
    assert.ok(allows(tpl, cancelled), `${tpl.id} should still be allowed`);
  }
});

test("nobody is told to book a visit they have already booked", () => {
  const open = profile({ freeVisitState: STATE.OPEN, freeVisitOpen: true });
  for (const tpl of TRACK_A) {
    assert.strictEqual(blocks(tpl, open), "free_visit_already_booked", tpl.id);
  }
});

test("a completed free visit ends Track A", () => {
  const done = trackB(1);
  for (const tpl of TRACK_A) {
    assert.strictEqual(blocks(tpl, done), "free_visit_already_used", tpl.id);
  }
});

test("a member never receives Track A", () => {
  const member = profile({ audience: "member", plan: "basic" });
  for (const tpl of TRACK_A) {
    /* Blocked by audience before the free-visit rule is even reached, which is
       a stronger refusal than the one this test originally named. */
    assert.ok(
      ["wrong_audience", "free_visit_members_not_eligible"].includes(blocks(tpl, member)),
      tpl.id
    );
  }
});

test("THE LAST REMINDER IS THE LAST REMINDER", () => {
  /*
   * The day 45 email says "this is the last time we will bring this up". A
   * promise the scheduler cannot keep is worse copy than no promise.
   */
  const closed = profile({ freeVisitSequenceClosed: true });
  for (const tpl of TRACK_A) {
    if (tpl.finalFreeVisitReminder) continue;
    assert.strictEqual(blocks(tpl, closed), "free_visit_sequence_closed", tpl.id);
  }
  /* And the sequence is closed by the campaign that makes the promise. */
  assert.strictEqual(
    TRACK_A.find((x) => x.finalFreeVisitReminder).id,
    FINAL_FREE_VISIT_CAMPAIGN_ID
  );
});

test("Track A emails wait for their day", () => {
  assert.strictEqual(blocks(t("nonmember_free_visit_v2"), profile({ registeredAt: ago(1) })), "lifecycle_not_due");
  assert.strictEqual(blocks(t("nonmember_free_visit_final_v1"), profile({ registeredAt: ago(30) })), "lifecycle_not_due");
  assert.ok(allows(t("nonmember_free_visit_final_v1"), profile({ registeredAt: ago(46) })));
});

test("nothing is sold before the free visit is settled", () => {
  /* A membership pitch at day 15 used to land between the second and third
     free-visit reminders; a paid single visit landed three days before we told
     them their first was free. Both now sit behind the whole sequence. */
  const lastFreeVisitDay = Math.max(...TRACK_A.map((x) => x.lifecycleDay));
  for (const id of ["nonmember_membership_intro_v1", "nonmember_one_time_v1"]) {
    assert.ok(t(id).lifecycleDay > lastFreeVisitDay, `${id} still interrupts Track A`);
  }
});

/* ================================================================== */
/* 3. Track B eligibility                                             */
/* ================================================================== */

test("Track B is four emails, on the approved days", () => {
  assert.deepStrictEqual(POST_FREE_VISIT.map((x) => x.trackBDay), [2, 6, 14, 30]);
});

test("TRACK B IS COUNTED FROM THE VISIT, NOT FROM THE ACCOUNT", () => {
  /*
   * Somebody who registered six months ago and had their visit yesterday is on
   * day one of this sequence. Anchoring to registration would have skipped them
   * to the end of a conversation they had not started.
   */
  const old = trackB(1, { registeredAt: ago(180) });
  assert.strictEqual(blocks(t("postfree_thanks_v1"), old), "track_b_not_due");

  const due = trackB(3, { registeredAt: ago(180) });
  assert.ok(allows(t("postfree_thanks_v1"), due), "day 3 from the visit is due");

  /* And registration age does not gate it in either direction. */
  const brandNew = trackB(3, { registeredAt: ago(4) });
  assert.ok(allows(t("postfree_thanks_v1"), brandNew));
});

test("Track B needs a completed free visit", () => {
  for (const state of [STATE.AVAILABLE, STATE.OPEN]) {
    const p = profile({ freeVisitState: state, daysSinceFreeVisit: Infinity });
    assert.strictEqual(blocks(t("postfree_thanks_v1"), p), "no_completed_free_visit");
  }
});

test("A MEMBERSHIP STOPS TRACK B IMMEDIATELY", () => {
  const joined = trackB(7, { audience: "member", plan: "basic" });
  for (const tpl of POST_FREE_VISIT) {
    assert.ok(
      ["wrong_audience", "already_a_member"].includes(blocks(tpl, joined)),
      `${tpl.id} reached a member`
    );
  }
});

test("each Track B email waits for its own day", () => {
  for (const tpl of POST_FREE_VISIT) {
    assert.strictEqual(blocks(tpl, trackB(tpl.trackBDay - 0.5)), "track_b_not_due", tpl.id);
    assert.ok(allows(tpl, trackB(tpl.trackBDay + 0.5)), tpl.id);
  }
});

test("B1 sells membership, not another booking", () => {
  /* The owner's correction: the free trial is over, membership is the ask. */
  const b1 = t("postfree_thanks_v1");
  assert.strictEqual(b1.ctaRoute, "membership");
  assert.match(b1.ctaLabel, /membership/i);
  assert.strictEqual(b1.closingLinkRoute, "book", "booking stays available, secondary");
});

test("Track B never repeats the completion cluster", () => {
  /* The completion email, the tip link and the review request all land within
     an hour of the Fixter leaving. Nothing here may be a fourth copy. */
  for (const tpl of POST_FREE_VISIT) {
    assert.ok(tpl.trackBDay >= 2, `${tpl.id} lands inside the completion cluster`);
    const text = JSON.stringify(tpl);
    assert.ok(!/\btip\b/i.test(text), `${tpl.id} mentions tipping`);
    assert.ok(!/\breview\b/i.test(text), `${tpl.id} mentions reviews`);
  }
});

/* ================================================================== */
/* 4. Frequency, and the one place it bends                           */
/* ================================================================== */

test("the shorter floor applies only inside the sequence", () => {
  assert.ok(inPostFreeVisitSequence(trackB(6)), "day 6 is inside");
  assert.ok(!inPostFreeVisitSequence(trackB(200)), "day 200 is not");
  assert.ok(!inPostFreeVisitSequence(profile()), "never had a visit");
  assert.ok(
    !inPostFreeVisitSequence(trackB(6, { audience: "member", plan: "basic" })),
    "a member is not in it"
  );
});

asyncTest("day 6 follows day 2 without waiting for the seven day floor", async () => {
  /* B1 went out on day 2. Under the ordinary floor B2 would be held to day 9
     and the sequence would drift out of step with its own copy. */
  const p = trackB(6, { lastMarketingAt: ago(4) });
  const verdict = await personEligible(p);
  assert.ok(verdict.eligible, `held back: ${verdict.reason}`);

  const { template } = selectCampaign(p, { annualPricingWorking: false });
  assert.strictEqual(template && template.id, "postfree_whats_next_v1");
});

asyncTest("the floor still stops two in one day", async () => {
  const p = trackB(6, { lastMarketingAt: ago(1) });
  const verdict = await personEligible(p);
  assert.ok(!verdict.eligible, "a one day gap should still be refused");
  assert.strictEqual(verdict.reason, "frequency_cap");
});

asyncTest("an ordinary non-member keeps the full seven day floor", async () => {
  const p = profile({ lastMarketingAt: ago(4) });
  const verdict = await personEligible(p);
  assert.strictEqual(verdict.reason, "frequency_cap");
});

test("the sequence does not let unrelated mail through its shorter floor", () => {
  /* The gap Track B opens is for Track B only. */
  const p = trackB(6, { lastMarketingAt: ago(4) });
  const { template } = selectCampaign(p, { annualPricingWorking: false });
  assert.ok(template.trackBDay !== undefined, `${template.id} slipped through the gap`);
});

/* ================================================================== */
/* 5. Selection, end to end                                           */
/* ================================================================== */

test("a new account starts Track A and walks it in order", () => {
  const seen = [];
  let p = profile({ registeredAt: ago(3), lastMarketingAt: null, everMarketed: false });

  for (let step = 0; step < 4; step += 1) {
    const { template } = selectCampaign(p, { annualPricingWorking: false });
    if (!template) break;
    seen.push(template.id);
    /* Walk the clock forward to the next campaign's day and record the send. */
    const nextDay = (TRACK_A[step + 1] || {}).lifecycleDay || 120;
    p = profile({
      registeredAt: ago(400),
      now: NOW,
      lastMarketingAt: ago(30),
      lastMarketingCategory: template.category,
      campaignLastSentAt: new Map([...p.campaignLastSentAt, [template.id, ago(30)]]),
      sentTopicAt: new Map([...p.sentTopicAt, [template.topic, ago(30)]]),
      freeVisitSequenceClosed: template.id === FINAL_FREE_VISIT_CAMPAIGN_ID,
    });
    void nextDay;
  }

  assert.deepStrictEqual(seen, TRACK_A.map((x) => x.id), "Track A out of order");
});

test("after the final reminder the person leaves Track A for good", () => {
  const closed = profile({
    registeredAt: ago(400),
    freeVisitSequenceClosed: true,
    campaignLastSentAt: new Map(TRACK_A.map((x) => [x.id, ago(30)])),
    sentTopicAt: new Map(TRACK_A.map((x) => [x.topic, ago(30)])),
  });
  const { template } = selectCampaign(closed, { annualPricingWorking: false });
  assert.ok(template, "they should still receive ordinary marketing");
  assert.notStrictEqual(template.category, "free_visit", "still being nagged");
});

test("a completed free visit routes to Track B, not back into Track A", () => {
  const p = trackB(3, { lastMarketingAt: ago(30) });
  const { template } = selectCampaign(p, { annualPricingWorking: false });
  assert.strictEqual(template.id, "postfree_thanks_v1");
});

/* ================================================================== */
/* 6. The copy itself                                                 */
/* ================================================================== */

const RECIPIENT = { name: "Dana", email: "dana@example.com", audience: "non_member" };

test("every lifecycle email renders, and carries the law", () => {
  for (const tpl of [...TRACK_A, ...POST_FREE_VISIT]) {
    const out = renderMarketingEmail(tpl, RECIPIENT);
    assert.ok(out.subject.length > 0, `${tpl.id} has no subject`);
    assert.ok(out.html.includes("245 42nd Street"), `${tpl.id} is missing the postal address`);
    assert.ok(/unsubscribe/i.test(out.html), `${tpl.id} has no unsubscribe link`);
    assert.ok(out.text.length > 120, `${tpl.id} has a thin text part`);
  }
});

test("no lifecycle email invents urgency, a discount or a deadline", () => {
  const forbidden = /\b(hurry|act now|limited time|expires|last chance|only \d+ left|% off|discount)\b/i;
  for (const tpl of [...TRACK_A, ...POST_FREE_VISIT]) {
    const out = renderMarketingEmail(tpl, RECIPIENT);
    assert.ok(!forbidden.test(out.text), `${tpl.id} invents urgency`);
  }
});

test("the price we quote is the price we charge", () => {
  for (const tpl of [...TRACK_A, ...POST_FREE_VISIT]) {
    const out = renderMarketingEmail(tpl, RECIPIENT);
    const prices = out.text.match(/\$\d+/g) || [];
    for (const price of prices) {
      assert.strictEqual(price, "$149", `${tpl.id} quotes ${price}, not the Basic price`);
    }
  }
});

test("Track A subjects are all different, and all about the free visit", () => {
  const subjects = TRACK_A.map((x) => x.subject);
  assert.strictEqual(new Set(subjects).size, subjects.length, "duplicate subject lines");
  for (const s of subjects) {
    assert.match(s, /free|unclaimed/i, `"${s}" does not mention the free visit`);
  }
});

test("Track B subjects do not all read as the same advertisement", () => {
  const subjects = POST_FREE_VISIT.map((x) => x.subject);
  assert.strictEqual(new Set(subjects).size, subjects.length, "duplicate subject lines");
  const shouty = subjects.filter((s) => /membership/i.test(s));
  assert.ok(shouty.length <= 1, "every subject is selling membership by name");
});

/* ================================================================== */
/* 7. The SMS half                                                    */
/* ================================================================== */

const LIFECYCLE_SMS = [
  "FREE_VISIT_REMINDER",
  "FREE_VISIT_LAST_CALL",
  "POST_FREE_VISIT_THANKS",
  "POST_FREE_VISIT_MEMBERSHIP",
];

test("EVERY LIFECYCLE TEXT IS MARKETING, NOT SERVICE", () => {
  /*
   * These ride alongside a service the customer is already receiving, which is
   * exactly what makes them tempting to misclassify. Under the A2P architecture
   * a marketing text needs an explicit marketing opt-in and service consent
   * never substitutes for one.
   */
  for (const type of LIFECYCLE_SMS) {
    assert.ok(isMarketing(type), `${type} is not classified as marketing`);
  }
});

test("every lifecycle text fits one segment and carries STOP", () => {
  for (const type of LIFECYCLE_SMS) {
    const body = renderSms(type, {});
    assert.ok(!isUnicodeBody(body), `${type} left GSM-7 and doubled in cost`);
    assert.strictEqual(estimateSegments(body), 1, `${type} is ${body.length} chars`);
    assert.match(body, /Reply STOP to opt out\./, `${type} has no opt-out line`);
    assert.match(body, /ProFixter/, `${type} does not say who is texting`);
  }
});

test("no lifecycle text promises something the email does not", () => {
  for (const type of LIFECYCLE_SMS) {
    const body = renderSms(type, {});
    const prices = body.match(/\$\d+/g) || [];
    for (const price of prices) assert.strictEqual(price, "$149", `${type} quotes ${price}`);
  }
});

/* ================================================================== */

(async () => {
  /* The async tests above register themselves; give them a tick to finish. */
  await new Promise((resolve) => setTimeout(resolve, 50));

  console.log(`\nfree visit lifecycle: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`  FAIL  ${f.name}\n        ${f.message}`);
    process.exit(1);
  }
  console.log(
    `Track A: ${TRACK_A.length} emails on days ${TRACK_A.map((x) => x.lifecycleDay).join(", ")}`
  );
  console.log(
    `Track B: ${POST_FREE_VISIT.length} emails on days ${POST_FREE_VISIT.map((x) => x.trackBDay).join(", ")} from the visit`
  );
  console.log(`Lifecycle SMS: ${LIFECYCLE_SMS.length} templates, all marketing-class, all 1 segment`);
  process.exit(0);
})();
