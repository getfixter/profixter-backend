/**
 * The marketing engine against a real database.
 *
 * The unit suite proves the rules. This proves the guarantees only a database
 * can give:
 *
 *   one person receives one campaign once, however many instances are running
 *   an unsubscribe stops marketing and nothing else
 *   a person who changes between claim and send is never sent to
 *
 * Email and Stripe are fakes. MongoDB is real and in memory.
 *
 *   node scripts/test_marketing_engine_integration.js
 *
 * Not part of `npm test`: it downloads and boots a MongoDB binary.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.EMAIL_TOKEN_SECRET = process.env.EMAIL_TOKEN_SECRET || "test-secret-for-unsubscribe";
process.env.ENABLE_MARKETING_EMAILS = "true";
process.env.MARKETING_MAX_PER_RUN = "50";
process.env.MARKETING_MAX_PER_DAY = "500";
// No Stripe key, so the annual price check fails closed without a network call.
delete process.env.STRIPE_SECRET_KEY;

const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

/* ------------------------------------------------------------------ */
/* Fakes, installed before anything under test loads them              */
/* ------------------------------------------------------------------ */

const sentEmails = [];
let sendShouldFail = false;

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub("../utils/emailService", {
  async sendRaw({ to, subject, html, text, headers }) {
    if (sendShouldFail) throw new Error("simulated SMTP failure");
    sentEmails.push({ to, subject, html, text, headers });
    return { messageId: `<fake-${sentEmails.length}@profixter>` };
  },
  sendTx: async () => ({ messageId: "<tx@profixter>" }),
  TEMPLATES: {},
  FROM: "ProFixter <my@profixter.com>",
});

const User = require("../models/User");
const Booking = require("../models/Booking");
const Subscription = require("../models/Subscription");
const EmailSuppression = require("../models/EmailSuppression");
const EstimateLead = require("../models/EstimateLead");
const MarketingSend = require("../models/MarketingSend");
const { runMarketingCycle } = require("../utils/marketing/marketingRunner");
const {
  buildProfile,
  personEligible,
  templateEligible,
} = require("../utils/marketing/marketingEligibility");
const { selectCampaign } = require("../utils/marketing/marketingScheduler");
const { ALL_TEMPLATES, audiencesOf } = require("../utils/marketing/marketingLibrary");
const { COOLDOWN_DAYS } = require("../utils/marketing/marketingConfig");

const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY);

let passed = 0;
const failures = [];
async function test(name, fn) {
  await reset();
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
    console.log(`  FAIL  ${name}`);
  }
}

async function reset() {
  sentEmails.length = 0;
  sendShouldFail = false;
  await Promise.all([
    User.deleteMany({}), Booking.deleteMany({}), Subscription.deleteMany({}),
    EmailSuppression.deleteMany({}), MarketingSend.deleteMany({}),
  ]);
}

let seq = 0;
async function makeCustomer(overrides = {}) {
  seq += 1;
  return User.create({
    userId: `CUST${String(seq).padStart(5, "0")}`,
    name: `Test Customer ${seq}`,
    firstName: "Test",
    lastName: `Customer${seq}`,
    email: `customer${seq}@mailbox.test-fixture.net`,
    password: "hashed-not-used",
    role: "customer",
    createdAt: ago(30),
    ...overrides,
  });
}

async function makeMember(user, overrides = {}) {
  return Subscription.create({
    user: user._id,
    userId: user.userId,
    addressId: new mongoose.Types.ObjectId(),
    subscriptionType: "plus",
    billingCycle: "monthly",
    startDate: ago(4),
    latestPaymentDate: ago(4),
    nextPaymentDate: new Date(Date.now() + 20 * DAY),
    currentPeriodEnd: new Date(Date.now() + 20 * DAY),
    status: "active",
    ...overrides,
  });
}

/**
 * Age a history row past every cooldown.
 *
 * Written through the native collection because Mongoose treats createdAt as
 * immutable, so a normal update silently leaves it at "now" and the test then
 * proves nothing.
 */
async function ageHistory(userId, days) {
  await MarketingSend.collection.updateMany(
    { user: userId },
    { $set: { createdAt: ago(days), sentAt: ago(days), updatedAt: ago(days) } }
  );
}

/**
 * Put every campaign except one on cooldown, and age that one past the reuse
 * window, so the scheduler has exactly one legal choice: repeat it.
 *
 * Without this a reuse test proves nothing, because a person who has received
 * one campaign still has fifty fresh ones and the scheduler rightly prefers
 * those.
 */
async function onlyOneCampaignLeft(user, targetId) {
  const rows = ALL_TEMPLATES.map((t) => ({
    user: user._id, userId: user.userId, email: user.email,
    campaignId: t.id, cycle: 0, audience: audiencesOf(t)[0],
    category: t.category, kind: t.kind, topic: t.topic,
    status: "sent", sentAt: ago(t.id === targetId ? COOLDOWN_DAYS.campaignReuse + 40 : 30),
  }));
  await MarketingSend.insertMany(rows);
  await MarketingSend.collection.updateMany(
    { user: user._id },
    [{ $set: { createdAt: "$sentAt", updatedAt: "$sentAt" } }]
  );
  return targetId;
}

/** Always force, so tests do not depend on the wall clock being 10am ET. */
const cycle = (options = {}) => runMarketingCycle({ force: true, ...options });

/* ------------------------------------------------------------------ */

async function main() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await Promise.all(mongoose.modelNames().map((m) => mongoose.model(m).syncIndexes()));

  console.log("\nmarketing engine, against a live database\n");

  /* --- Sending at all ------------------------------------------- */

  await test("a settled non-member receives the first lifecycle email", async () => {
    await makeCustomer();
    const result = await cycle();
    assert.strictEqual(result.sent, 1, `sent ${result.sent}`);
    assert.strictEqual(sentEmails.length, 1);
    assert.strictEqual(sentEmails[0].subject, "Your first ProFixter visit is free");

    const record = await MarketingSend.findOne({});
    assert.strictEqual(record.status, "sent");
    assert.strictEqual(record.campaignId, "nonmember_free_visit_v1");
    assert.ok(record.sentAt, "sentAt not recorded");
    assert.ok(record.providerMessageId, "provider message id not recorded");
  });

  await test("somebody who signed up today is left alone", async () => {
    await makeCustomer({ createdAt: new Date() });
    const result = await cycle();
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(sentEmails.length, 0);
  });

  await test("staff accounts are never emailed", async () => {
    await makeCustomer({ role: "admin", email: "admin@profixter.com" });
    await makeCustomer({ role: "employee", email: "fixter@profixter.com" });
    await makeCustomer({ employeePosition: "Fixter", email: "dual@profixter.com" });
    const result = await cycle();
    assert.strictEqual(result.sent, 0, `sent to ${sentEmails.map((e) => e.to).join(", ")}`);
  });

  await test("a legacy account with no role is still reached", async () => {
    const user = await makeCustomer();
    // Strip the field the way the pre-role records in production actually are.
    await User.collection.updateOne({ _id: user._id }, { $unset: { role: "", isActive: "" } });

    const result = await cycle();
    assert.strictEqual(result.sent, 1, "the legacy customer was skipped");
    assert.strictEqual(sentEmails[0].to, user.email);
  });

  /* --- Frequency ------------------------------------------------- */

  await test("nobody hears from marketing twice in a week", async () => {
    await makeCustomer();
    const first = await cycle();
    assert.strictEqual(first.sent, 1);

    const second = await cycle();
    assert.strictEqual(second.sent, 0, "a second email went out the same day");
    assert.strictEqual(second.skipReasons.frequency_cap || 0, 0,
      "should have been filtered out before profiling");
    assert.strictEqual(sentEmails.length, 1);
  });

  await test("a campaign will not repeat inside its cooldown", async () => {
    const user = await makeCustomer();
    await cycle();
    // Old enough to clear the frequency cap, nowhere near the reuse cooldown.
    await ageHistory(user._id, 60);

    const again = await cycle();
    assert.strictEqual(again.sent, 1, "the rotation should have moved on to something new");
    const ids = (await MarketingSend.find({ user: user._id }).lean()).map((c) => c.campaignId);
    assert.strictEqual(new Set(ids).size, ids.length, `repeated too soon: ${ids.join(", ")}`);
  });

  await test("a campaign repeats deliberately once the cooldown has passed", async () => {
    const user = await makeCustomer({ createdAt: ago(500) });
    const target = await onlyOneCampaignLeft(user, "fix_doors_v1");

    await cycle();
    const rows = await MarketingSend.find({ user: user._id, campaignId: target })
      .sort({ cycle: 1 }).lean();
    assert.strictEqual(rows.length, 2, `the campaign was never reused (${rows.length} rows)`);
    assert.deepStrictEqual(rows.map((r) => r.cycle), [0, 1], "cycle did not advance");
    assert.strictEqual(sentEmails.length, 1, "exactly one email should have gone out");
  });

  await test("a reusable campaign is still protected against concurrent duplicates", async () => {
    const user = await makeCustomer({ createdAt: ago(500) });
    const target = await onlyOneCampaignLeft(user, "fix_doors_v1");

    // Four workers all see "they have had this once" and all compute cycle 1.
    const results = await Promise.all([cycle(), cycle(), cycle(), cycle()]);
    const totalSent = results.reduce((sum, r) => sum + r.sent, 0);

    assert.strictEqual(totalSent, 1, `${totalSent} emails went out for one reuse`);
    assert.strictEqual(sentEmails.length, 1);
    const live = await MarketingSend.find({
      user: user._id, campaignId: target, status: { $in: ["sent", "claimed"] },
    }).lean();
    assert.strictEqual(live.length, 2, `a duplicate cycle slipped through (${live.length} rows)`);
  });

  /* --- Audience -------------------------------------------------- */

  await test("becoming a member changes what arrives next", async () => {
    const user = await makeCustomer({ createdAt: ago(200) });
    const before = await buildProfile(user.toObject(), new Date());
    assert.strictEqual(before.audience, "non_member");

    await makeMember(user);
    const after = await buildProfile(user.toObject(), new Date());
    assert.strictEqual(after.audience, "member");
    assert.strictEqual(after.plan, "plus");

    const { template } = selectCampaign(after, { annualPricingWorking: false });
    assert.strictEqual(template.audience, "member");
    assert.strictEqual(template.id, "member_activation_day3_v1");
  });

  await test("a lapsed membership makes somebody a former member, not a member", async () => {
    const user = await makeCustomer({ createdAt: ago(200) });
    await makeMember(user, {
      status: "canceled",
      currentPeriodEnd: ago(30),
      cancellationDate: ago(30),
    });
    const profile = await buildProfile(user.toObject(), new Date());
    assert.strictEqual(profile.audience, "former_member");

    const { template } = selectCampaign(profile, { annualPricingWorking: false });
    assert.ok(template, "a former member had nothing to receive");
    assert.ok(
      audiencesOf(template).includes("former_member"),
      `${template.id} is not for former members`
    );
    assert.notStrictEqual(template.category, "activation");
  });

  await test("a member who has booked is not nagged to activate", async () => {
    const user = await makeCustomer({ createdAt: ago(200) });
    await makeMember(user);
    await Booking.create({
      bookingNumber: `${10000000 + seq}`,
      user: user._id, userId: user.userId, name: user.name, email: user.email,
      phone: "6315551234", address: "1 Test St", service: "Handyman",
      subscription: "plus", accessType: "membership",
      date: new Date(), time: "9:00 AM", status: "Confirmed",
    });
    const profile = await buildProfile(user.toObject(), new Date());
    assert.strictEqual(profile.hasMembershipBooking, true);
    const { template } = selectCampaign(profile, { annualPricingWorking: false });
    assert.notStrictEqual(template?.category, "activation");
  });

  /* --- Unsubscribe ------------------------------------------------ */

  await test("an unsubscribe stops marketing immediately", async () => {
    const user = await makeCustomer();
    await EmailSuppression.create({ email: user.email, reason: "unsubscribe" });

    const result = await cycle();
    assert.strictEqual(result.sent, 0, "marketing went to an unsubscribed address");
    assert.strictEqual(result.skipReasons.unsubscribed, 1);
  });

  await test("an unsubscribe is judged on the address, whatever its case", async () => {
    const user = await makeCustomer();
    await EmailSuppression.create({ email: user.email.toUpperCase(), reason: "unsubscribe" });
    const profile = await buildProfile(user.toObject(), new Date());
    const verdict = await personEligible(profile);
    assert.strictEqual(verdict.eligible, false);
    assert.strictEqual(verdict.reason, "unsubscribed");
  });

  /* --- The master safety rule -------------------------------------- */

  await test("a person who changes between claim and send is not sent to", async () => {
    const user = await makeCustomer();

    // Simulate the race exactly: they unsubscribe after the claim row is
    // written and before the transport is called.
    const realCreate = MarketingSend.create.bind(MarketingSend);
    MarketingSend.create = async (...args) => {
      const record = await realCreate(...args);
      await EmailSuppression.create({ email: user.email, reason: "unsubscribe" });
      return record;
    };

    try {
      const result = await cycle();
      assert.strictEqual(result.sent, 0, "sent to somebody who had just unsubscribed");
      assert.strictEqual(result.cancelled, 1, "the claim was not cancelled");
      assert.strictEqual(sentEmails.length, 0);

      const record = await MarketingSend.findOne({ user: user._id });
      assert.strictEqual(record.status, "cancelled");
      assert.strictEqual(record.cancelledReason, "recheck_unsubscribed");
    } finally {
      MarketingSend.create = realCreate;
    }
  });

  await test("a cancelled claim does not bar the campaign forever", async () => {
    const user = await makeCustomer();
    await MarketingSend.create({
      user: user._id, userId: user.userId, email: user.email,
      campaignId: "nonmember_free_visit_v1", audience: "non_member",
      category: "free_visit", topic: "free_visit",
      status: "cancelled", cancelledReason: "recheck_unsubscribed", createdAt: ago(30),
    });
    const result = await cycle();
    assert.strictEqual(result.sent, 1, "a cancelled claim permanently blocked the campaign");
    assert.strictEqual(sentEmails[0].subject, "Your first ProFixter visit is free");
  });

  /* --- Concurrency ------------------------------------------------- */

  await test("four instances running at once send exactly one email each", async () => {
    for (let i = 0; i < 6; i += 1) await makeCustomer();

    const results = await Promise.all([cycle(), cycle(), cycle(), cycle()]);
    const totalSent = results.reduce((sum, r) => sum + r.sent, 0);

    assert.strictEqual(sentEmails.length, totalSent, "accounting disagrees with the transport");
    assert.strictEqual(totalSent, 6, `${totalSent} emails for 6 people`);

    const perPerson = {};
    for (const email of sentEmails) perPerson[email.to] = (perPerson[email.to] || 0) + 1;
    const duplicated = Object.entries(perPerson).filter(([, n]) => n > 1);
    assert.deepStrictEqual(duplicated, [], `duplicate sends: ${JSON.stringify(duplicated)}`);

    const claimed = await MarketingSend.countDocuments({ status: { $in: ["sent", "claimed"] } });
    assert.strictEqual(claimed, 6);
  });

  /* --- Failure handling --------------------------------------------- */

  await test("a transport failure is recorded, not silently swallowed", async () => {
    await makeCustomer();
    sendShouldFail = true;
    const result = await cycle();
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(result.failed, 1);

    const record = await MarketingSend.findOne({});
    assert.strictEqual(record.status, "failed");
    assert.ok(record.failureReason.includes("simulated SMTP failure"));
    assert.ok(record.failedAt);
  });

  await test("a failed campaign is not retried into a loop", async () => {
    const user = await makeCustomer();
    sendShouldFail = true;
    await cycle();
    sendShouldFail = false;

    await MarketingSend.updateOne({ user: user._id }, { $set: { createdAt: ago(30) } });
    const retry = await cycle();
    const records = await MarketingSend.find({ user: user._id }).lean();
    const ids = records.map((r) => r.campaignId);
    assert.strictEqual(new Set(ids).size, ids.length, "the failed campaign was reattempted");
    assert.ok(retry.sent <= 1);
  });

  /* --- Dry run ------------------------------------------------------- */

  await test("a dry run sends nothing and writes nothing", async () => {
    for (let i = 0; i < 3; i += 1) await makeCustomer();
    const result = await cycle({ dryRun: true });

    assert.strictEqual(result.selected, 3);
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(sentEmails.length, 0, "a dry run sent mail");
    assert.strictEqual(await MarketingSend.countDocuments({}), 0, "a dry run wrote history");
    assert.strictEqual(result.plans.length, 3);
    assert.ok(!result.plans[0].email.includes("customer1@"), "the dry run logged a full address");
  });

  await test("the flag alone stops every send", async () => {
    await makeCustomer();
    process.env.ENABLE_MARKETING_EMAILS = "false";
    try {
      const result = await cycle();
      assert.strictEqual(result.stoppedBecause, "disabled");
      assert.strictEqual(sentEmails.length, 0);
      assert.strictEqual(await MarketingSend.countDocuments({}), 0);
    } finally {
      process.env.ENABLE_MARKETING_EMAILS = "true";
    }
  });

  /* --- The correction pass, against real data ------------------------ */

  await test("the audience ramp restricts who is reachable", async () => {
    const visitor = await makeCustomer();
    const member = await makeCustomer({ createdAt: ago(200) });
    await makeMember(member, { startDate: ago(300) });
    await Booking.create({
      bookingNumber: `${20000000 + seq}`, user: member._id, userId: member.userId,
      name: member.name, email: member.email, phone: "6315551234", address: "1 Test St",
      service: "Handyman", subscription: "plus", accessType: "membership",
      date: new Date(), time: "9:00 AM", status: "Confirmed",
    });

    process.env.MARKETING_AUDIENCES = "member";
    try {
      const result = await cycle();
      assert.strictEqual(result.sent, 1, `sent ${result.sent}`);
      assert.strictEqual(sentEmails[0].to, member.email, "the wrong audience was mailed");
      assert.ok(result.skipReasons.audience_disabled_non_member >= 1);
    } finally {
      delete process.env.MARKETING_AUDIENCES;
    }

    const opened = await cycle();
    assert.strictEqual(opened.sent, 1, "the non member should be reachable once the ramp opens");
    assert.strictEqual(sentEmails[1].to, visitor.email);
  });

  await test("a past due subscription stops selling but not helping", async () => {
    const user = await makeCustomer({ createdAt: ago(300) });
    await makeMember(user, { startDate: ago(300), status: "past_due" });

    const profile = await buildProfile(user.toObject(), new Date());
    assert.strictEqual(profile.paymentTrouble, true, "the failed payment was not detected");

    const { template } = selectCampaign(profile, { annualPricingWorking: true });
    assert.ok(template, "they went completely silent, which was not the intent");
    assert.strictEqual(template.kind, "help", `a ${template.kind} email was chosen: ${template.id}`);
  });

  await test("an estimate request pauses project marketing", async () => {
    const user = await makeCustomer({ createdAt: ago(300) });
    await EstimateLead.create({
      service: "kitchen", name: user.name, phone: "6315551234",
      email: user.email, address: "1 Test St",
    });

    const profile = await buildProfile(user.toObject(), new Date());
    assert.ok(profile.projectLead, "the estimate request was not found");

    const projectCampaigns = ALL_TEMPLATES.filter((t) => t.category === "project");
    for (const t of projectCampaigns) {
      const verdict = templateEligible(t, profile, { annualPricingWorking: false });
      assert.ok(!verdict.eligible, `${t.id} was still allowed`);
    }
    const { template } = selectCampaign(profile, { annualPricingWorking: false });
    assert.ok(template, "they went silent after asking for an estimate");
    assert.notStrictEqual(template.category, "project");
  });

  await test("an abandoned claim is released rather than blocking forever", async () => {
    const user = await makeCustomer({ createdAt: ago(500) });
    await onlyOneCampaignLeft(user, "fix_doors_v1");

    /*
     * A worker died mid-send and left its claim behind. Dated 8 days ago
     * because a claim inside the last 7 days legitimately keeps the person out
     * of the candidate query anyway; the permanent block only bites afterwards.
     */
    const orphan = await MarketingSend.create({
      user: user._id, userId: user.userId, email: user.email,
      campaignId: "fix_doors_v1", cycle: 1, audience: "non_member",
      category: "fix", kind: "help", topic: "doors",
      status: "claimed", claimedAt: ago(8),
    });
    await MarketingSend.collection.updateOne(
      { _id: orphan._id }, { $set: { createdAt: ago(8), updatedAt: ago(8) } }
    );

    const result = await cycle();
    assert.strictEqual(result.sent, 1, "the stale claim blocked the campaign permanently");
    const released = await MarketingSend.findOne({
      user: user._id, campaignId: "fix_doors_v1", status: "cancelled",
    }).lean();
    assert.strictEqual(released.cancelledReason, "stale_claim_released");
  });

  await test("a fresh claim from another worker is left alone", async () => {
    const user = await makeCustomer({ createdAt: ago(500) });
    await onlyOneCampaignLeft(user, "fix_doors_v1");
    await MarketingSend.create({
      user: user._id, userId: user.userId, email: user.email,
      campaignId: "fix_doors_v1", cycle: 1, audience: "non_member",
      category: "fix", kind: "help", topic: "doors",
      status: "claimed", claimedAt: new Date(),
    });

    const result = await cycle();
    assert.strictEqual(result.sent, 0, "a live claim from another worker was stolen");
    assert.strictEqual(sentEmails.length, 0);
  });

  await test("a home fix email points a member at their membership booking page", async () => {
    const user = await makeCustomer({ createdAt: ago(500) });
    await makeMember(user, { startDate: ago(400) });
    await Booking.create({
      bookingNumber: `${30000000 + seq}`, user: user._id, userId: user.userId,
      name: user.name, email: user.email, phone: "6315551234", address: "1 Test St",
      service: "Handyman", subscription: "plus", accessType: "membership",
      date: new Date(), time: "9:00 AM", status: "Confirmed",
    });
    await onlyOneCampaignLeft(user, "fix_doors_v1");

    await cycle();
    assert.strictEqual(sentEmails.length, 1);
    assert.ok(sentEmails[0].html.includes("visit=membership"),
      "a member was sent to the generic booking page");
  });

  /* --- Compliance in the wire format --------------------------------- */

  await test("what actually goes out carries the one-click unsubscribe header", async () => {
    await makeCustomer();
    await cycle();
    const email = sentEmails[0];
    assert.ok(email.headers["List-Unsubscribe"], "no List-Unsubscribe header");
    assert.strictEqual(email.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert.ok(email.headers["List-Unsubscribe"].includes("/api/email/unsubscribe?token="));
    assert.ok(email.html.includes("245 42nd Street, Lindenhurst, NY 11757"));
  });

  /* ------------------------------------------------------------------ */

  console.log(`\nmarketing engine: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`  FAIL  ${f.name}\n        ${f.message}`);

  await mongoose.disconnect();
  await server.stop();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error("Suite crashed:", error);
  process.exit(1);
});
