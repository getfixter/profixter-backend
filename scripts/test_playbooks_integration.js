/**
 * Email playbooks and cancellation feedback.
 *
 *   - an agent can draft a playbook, never approve it; copy rules refuse
 *     discounts, prices and banned wording
 *   - only approved playbooks at the approved version propose sends; sends
 *     start in shadow; revising sends a playbook back to draft
 *   - every send re-checks segment, unsubscribe, the 4-day quiet period, and
 *     one-per-person
 *   - cancellation feedback is optional, after the fact, and stored apart from
 *     the system's cancellationReason
 *
 * In-memory MongoDB; mail is stubbed.
 *   node scripts/test_playbooks_integration.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const assert = require("assert");
const path = require("path");
const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const sent = [];
const emailServicePath = require.resolve(path.join(__dirname, "../utils/emailService"));
require.cache[emailServicePath] = {
  id: emailServicePath,
  filename: emailServicePath,
  loaded: true,
  exports: { sendRaw: async (m) => (sent.push(m), { messageId: `m${sent.length}` }), sendTx: async () => ({}) },
};

const User = require("../models/User");
const Booking = require("../models/Booking");
const Subscription = require("../models/Subscription");
const MarketingSend = require("../models/MarketingSend");
const EmailSuppression = require("../models/EmailSuppression");
const EmailPlaybook = require("../models/EmailPlaybook");
const GrowthAction = require("../models/GrowthAction");
require("../utils/growth/actions");
const engine = require("../utils/growth/actionEngine");
const { proposePlaybookEmails } = require("../utils/growth/actions/playbookEmail");
const { TOOL_DEFS } = require("../utils/agents/tools");

let passed = 0;
async function test(name, fn) {
  await Promise.all([User.deleteMany({}), Booking.deleteMany({}), Subscription.deleteMany({}), EmailPlaybook.deleteMany({}), GrowthAction.deleteMany({}), MarketingSend.deleteMany({}), EmailSuppression.deleteMany({})]);
  sent.length = 0;
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    throw e;
  }
}

const DAY = 864e5;
let n = 0;
const makeUser = (over = {}) =>
  User.create({
    name: "Pat Doe",
    firstName: "Pat",
    email: `pat${(n += 1)}@homeowner-fixture.net`,
    password: "x".repeat(20),
    phone: "6315550100",
    userId: String(20000000 + n),
    ...over,
  });
const freeVisitDone = (user, daysAgo) =>
  Booking.collection.insertOne({ user: user._id, isFreeFirstVisit: true, status: "completed", completedAt: new Date(Date.now() - daysAgo * DAY), createdAt: new Date(Date.now() - (daysAgo + 1) * DAY) });

const ctx = { agent: "conversion", agentLabel: "Conversion & Customer Growth agent", runId: null, findingsThisRun: 0, findingIds: [], actionIds: [] };
const good = {
  key: "free-visit-undecided-v1",
  name: "After the free visit",
  segment: "free_visit_undecided",
  purpose: "7 people had the free visit and did not join",
  measure: "members joining within 14 days",
  subject: "How did your first visit go?",
  preheader: "Membership keeps help on hand for the rest of the list.",
  headline: "What's next on your list?",
  paragraphs: ["Thanks for having us out.", "Membership means the next job is one booking away."],
  cta_label: "See membership",
  cta_route: "membership",
  closing: "Questions? Just reply.",
};

/* Marcus queues sends only 9:00-18:00 New York time; the proposer tests run at 2 pm today. */
const DAYTIME = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }) + "T14:00:00-04:00");

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([EmailPlaybook.init(), GrowthAction.init()]);
  console.log("playbooks");

  await test("an agent drafts a playbook; banned copy is refused with the reason", async () => {
    const out = await TOOL_DEFS.save_email_playbook.run(good, ctx);
    assert.strictEqual(out.status, "draft");
    await assert.rejects(() => TOOL_DEFS.save_email_playbook.run({ ...good, key: "bad-1", paragraphs: ["Come back and get 20% off"] }, ctx), /No discounts/);
    await assert.rejects(() => TOOL_DEFS.save_email_playbook.run({ ...good, key: "bad-2", paragraphs: ["Plans from $149"] }, ctx), /No prices/);
    assert.strictEqual(await EmailPlaybook.countDocuments({}), 1);
  });

  await test("the button goes to a real page: previews show the real link, never-booked goes to /book/free, the free visit is never offered twice", async () => {
    const { explainPlaybook } = require("../utils/growth/explain");
    const { templateOf, ctaRouteOf } = require("../utils/growth/actions/playbookEmail");
    const { renderMarketingEmail } = require("../utils/marketing/marketingRenderer");
    const preview = JSON.stringify(explainPlaybook({ ...good, ctaLabel: good.cta_label, ctaRoute: "plans" }));
    assert.match(preview, /https:\/\/www\.profixter\.com\/membership\/plans/);
    assert.doesNotMatch(preview, /profixter\.com(plans|book|membership)/, "never the route key glued onto the domain");
    // an older draft said "book" for never-booked prospects: it means the free visit
    const legacy = { key: "x", segment: "registered_never_booked", subject: "s", headline: "h", paragraphs: ["p"], ctaLabel: "Book your free visit", ctaRoute: "book" };
    assert.strictEqual(ctaRouteOf(legacy), "bookFree");
    assert.strictEqual(renderMarketingEmail(templateOf(legacy), { name: "A", email: "a@example.com" }).ctaUrl, "https://www.profixter.com/book/free");
    await assert.rejects(() => TOOL_DEFS.save_email_playbook.run({ ...good, key: "fv-again", cta_route: "bookFree" }, ctx), /already had their free visit/);
    await assert.rejects(() => TOOL_DEFS.save_email_playbook.run({ ...good, key: "per-home", paragraphs: ["The free visit is one per home."] }, ctx), /ONE PER CUSTOMER/);
    const nb = await TOOL_DEFS.save_email_playbook.run({ ...good, key: "never-booked-v1", segment: "registered_never_booked", cta_route: "bookFree" }, ctx);
    assert.strictEqual(nb.status, "draft");
    await EmailPlaybook.deleteMany({ key: { $ne: good.key } });
  });

  await test("drafts propose nothing; approved playbooks propose in shadow for the segment only", async () => {
    delete process.env.GROWTH_ACTIONS_ENABLED;
    await TOOL_DEFS.save_email_playbook.run(good, ctx);
    const inSeg = await makeUser();
    await freeVisitDone(inSeg, 10);
    const tooRecent = await makeUser();
    await freeVisitDone(tooRecent, 1);
    assert.strictEqual((await proposePlaybookEmails({ propose: engine.propose, now: DAYTIME })).proposed, 0);
    await EmailPlaybook.updateOne({ key: good.key }, { $set: { status: "approved", approvedVersion: 1, approvedBy: "Owner" } });
    const r = await proposePlaybookEmails({ propose: engine.propose, now: DAYTIME });
    assert.strictEqual(r.proposed, 1);
    const a = await GrowthAction.findOne({ type: "playbook_email" }).lean();
    assert.strictEqual(a.status, "shadow");
    assert.strictEqual(a.subject.entityId, String(inSeg._id));
    assert.strictEqual((await proposePlaybookEmails({ propose: engine.propose, now: DAYTIME })).proposed, 0, "idempotent per person");
  });

  await test("revising an approved playbook sends it back to draft and stops its sends", async () => {
    await TOOL_DEFS.save_email_playbook.run(good, ctx);
    await EmailPlaybook.updateOne({ key: good.key }, { $set: { status: "approved", approvedVersion: 1 } });
    const revised = await TOOL_DEFS.save_email_playbook.run({ ...good, subject: "A quick question after your visit" }, ctx);
    assert.strictEqual(revised.status, "draft");
    assert.strictEqual(revised.version, 2);
    const u = await makeUser();
    await freeVisitDone(u, 10);
    assert.strictEqual((await proposePlaybookEmails({ propose: engine.propose, now: DAYTIME })).proposed, 0);
  });

  await test("a send re-checks segment, unsubscribe and quiet period; sends once with unsubscribe", async () => {
    process.env.GROWTH_ACTIONS_ENABLED = "true";
    await engine.setPolicyMode("playbook_email", "supervised", { kind: "owner" });
    await TOOL_DEFS.save_email_playbook.run(good, ctx);
    await EmailPlaybook.updateOne({ key: good.key }, { $set: { status: "approved", approvedVersion: 1 } });

    const ok = await makeUser();
    await freeVisitDone(ok, 10);
    const unsub = await makeUser();
    await freeVisitDone(unsub, 10);
    await EmailSuppression.collection.insertOne({ email: unsub.email, reason: "unsubscribe", suppressedAt: new Date() });
    const busy = await makeUser();
    await freeVisitDone(busy, 10);
    await MarketingSend.collection.insertOne({ user: busy._id, status: "sent", sentAt: new Date(Date.now() - DAY), campaignId: "x", audience: "non_member" });
    const joined = await makeUser();
    await freeVisitDone(joined, 10);

    await proposePlaybookEmails({ propose: engine.propose, now: DAYTIME });
    // Joined between proposal and send:
    await Subscription.collection.insertOne({
      user: joined._id, userId: joined.userId, addressId: new mongoose.Types.ObjectId(), subscriptionType: "basic",
      status: "active", accessStatus: "active", stripeSubscriptionId: "sub_x", startDate: new Date(),
      currentPeriodEnd: new Date(Date.now() + 20 * DAY), nextPaymentDate: new Date(), latestPaymentDate: new Date(),
    });
    // the unsubscribed and the recently emailed are not even queued (and not used up)
    const queued = await GrowthAction.find({ type: "playbook_email" }).lean();
    assert.deepStrictEqual(queued.map((a) => a.subject.entityId).sort(), [String(ok._id), String(joined._id)].sort());
    const { execute: sendPlaybook } = require("../utils/growth/actions/playbookEmail");
    const run = async (user) => {
      const a = queued.find((q) => q.subject.entityId === String(user._id)) || { _id: new mongoose.Types.ObjectId(), payload: { userId: String(user._id), playbookKey: good.key } };
      const out = await sendPlaybook(a.payload, { action: a, now: DAYTIME });
      return out.outcome === "done" ? "sent" : out.outcome === "defer" ? "waits" : out.reason;
    };
    assert.strictEqual(await run(ok), "sent");
    assert.strictEqual(await run(joined), "membership_purchased", "a membership stops follow-ups at the moment of sending");
    // had they been queued before it changed: re-checked at the moment of sending
    assert.strictEqual(await run(unsub), "unsubscribed");
    assert.strictEqual(await run(busy), "waits", "emailed this week: waits, is not lost");
    assert.strictEqual(sent.length, 1);
    assert.ok(sent[0].headers["List-Unsubscribe"]);
    assert.strictEqual(sent[0].logContext.templateKey, "playbook:free-visit-undecided-v1");
    assert.match(sent[0].html, /Hi Pat,/);
    delete process.env.GROWTH_ACTIONS_ENABLED;
  });

  await test("a retired playbook cannot be revived by an agent", async () => {
    await TOOL_DEFS.save_email_playbook.run(good, ctx);
    await EmailPlaybook.updateOne({ key: good.key }, { $set: { status: "retired" } });
    await assert.rejects(() => TOOL_DEFS.save_email_playbook.run(good, ctx), /retired/);
  });

  await test("agents have the playbook tools but no way to approve or send", async () => {
    const { AGENTS } = require("../utils/agents/definitions");
    assert.ok(AGENTS.conversion.tools.includes("save_email_playbook"));
    for (const a of Object.values(AGENTS)) {
      assert.ok(!a.tools.some((t) => /approve|send_email/.test(t)), `${a.name}: ${a.tools.join(",")}`);
      // propose_action is allowed only for website-wording actions, never customer messages.
      assert.ok(!a.allowedActions.some((t) => /email|sms|message|playbook|recovery/.test(t)), `${a.name}: ${a.allowedActions}`);
    }
  });

  console.log("cancellation feedback");

  await test("feedback is optional, after the cancellation, and kept apart from the system reason", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/subscriptions", require("../routes/subscriptions"));
    const server = http.createServer(app).listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/subscriptions/manage/address`;
    try {
      const addressId = new mongoose.Types.ObjectId();
      const user = await makeUser({ addresses: [{ _id: addressId, line1: "1 Main St", city: "Lindenhurst", state: "NY", zip: "11757" }] });
      const token = jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET);
      const post = (body) =>
        fetch(`${base}/${addressId}/cancellation-feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
      assert.strictEqual((await post({ category: "price" })).status, 404, "nothing cancelled yet");
      await Subscription.collection.insertOne({
        user: user._id, userId: user.userId, addressId, subscriptionType: "basic", status: "active", accessStatus: "active",
        cancelAtPeriodEnd: true, cancellationReason: null, startDate: new Date(Date.now() - 90 * DAY), currentPeriodEnd: new Date(Date.now() + 9 * DAY),
        nextPaymentDate: new Date(), latestPaymentDate: new Date(), stripeSubscriptionId: "sub_y", updatedAt: new Date(),
      });
      assert.strictEqual((await post({ category: "free_beer" })).status, 400);
      const ok = await post({ category: "not_using_enough", note: "  Didn't have many jobs.  Call me 631-555-0100 " });
      assert.strictEqual(ok.status, 200);
      const sub = await Subscription.findOne({ user: user._id }).lean();
      assert.strictEqual(sub.cancellationFeedback.category, "not_using_enough");
      assert.match(sub.cancellationFeedback.note, /^Didn't have many jobs\. Call me/);
      assert.strictEqual(sub.cancellationReason, null, "the system field is untouched");
      // The marketing agents never see cancellation reasons or notes at all (Oct 2026).
      const { TOOL_DEFS } = require("../utils/agents/tools");
      assert.ok(!TOOL_DEFS.get_conversion_details && !TOOL_DEFS.get_business_overview, "no cancellation analysis tool exists");
    } finally {
      server.close();
    }
  });

  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} passed`);
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
