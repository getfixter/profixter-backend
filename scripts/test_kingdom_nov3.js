/**
 * The Kingdom's Nov 3 2026 fixes.
 *
 *   - a one-step (no account) free-visit request on a person's own email or
 *     phone keeps them out of every "please book" follow-up - Marcus's
 *     never-booked audience and the lifecycle's Track A - but never puts
 *     them into Track B, and never links or merges anything
 *   - a completed guest visit joins the ONE account that proved its phone or
 *     email; none, or two, and nothing happens
 *   - follow-up email buttons carry utm tags; Marcus and Arthur see the exact
 *     link and the per-person results
 *   - one-step requests are credited per utm_campaign
 *   - marketing texts switched on by staff are "needs_confirmation" in the
 *     counts, the same as the sender reads them
 *   - "just note it" records are notes, not decisions, on the board and badge
 *   - a duplicate of the owner's own task is archived without an archive request
 *
 * In-memory MongoDB, no model calls.
 *   node scripts/test_kingdom_nov3.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

const DAY = 864e5;

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const User = require("../models/User");
  const Booking = require("../models/Booking");
  const Request = require("../models/Request");
  const EmailPlaybook = require("../models/EmailPlaybook");
  const GrowthAction = require("../models/GrowthAction");
  const { CouncilDecision, CouncilTask } = require("../models/Council");
  const { SEGMENT_DEFS } = require("../utils/growth/segments");
  const lifecycle = require("../utils/marketing/freeVisitLifecycle");
  const { linkCompletedGuestVisit } = require("../utils/freeVisit/guestLink");
  const playbookEmail = require("../utils/growth/actions/playbookEmail");
  const { consentStatus } = require("../utils/consent/status");
  const { decisionBoard } = require("../utils/council/board");
  const { archiveItem } = require("../utils/council/archive");
  const { TOOL_DEFS } = require("../utils/agents/tools");

  const now = new Date();
  const ago = (d) => new Date(now - d * DAY);
  const id = () => new mongoose.Types.ObjectId();

  const user = (over) => ({
    _id: id(),
    userId: `U${Math.random().toString(36).slice(2, 10)}`,
    name: "Pat Home",
    role: "customer",
    isActive: true,
    createdAt: ago(10),
    ...over,
  });
  const guestBooking = (over) => ({
    _id: id(),
    bookingNumber: `B${Math.random().toString(36).slice(2, 8)}`,
    date: new Date(now.getTime() + 2 * DAY),
    service: "Free visit",
    name: "Pat Home",
    subscription: "free",
    guestRequestId: id(),
    user: null,
    status: "Confirmed",
    isFreeFirstVisit: true,
    createdAt: ago(3),
    ...over,
  });

  const booked = user({ email: "booked@example.com", phone: "(631) 555-0101" });
  const viaPhone = user({ email: "other@example.com", phone: "6315550102" });
  const cancelled = user({ email: "cancelled@example.com", phone: "" });
  const neverBooked = user({ email: "never@example.com", phone: "6315550104" });
  const declined = user({ email: "declined@example.com" });
  await User.collection.insertMany([booked, viaPhone, cancelled, neverBooked, declined]);
  await Booking.collection.insertMany([
    guestBooking({ email: "booked@example.com", phone: "+16315550199" }),
    guestBooking({ email: "nobody@example.com", phone: "+16315550102" }),
    guestBooking({ email: "cancelled@example.com", phone: "+16315550103", status: "Canceled" }),
  ]);
  await Request.collection.insertMany([
    { _id: id(), serviceType: "free_visit_request", status: "declined", email: "declined@example.com", phone: "+16315550105", createdAt: ago(4) },
  ]);

  await test("never-booked: a one-step request on the same email or phone keeps a person out", async () => {
    const members = new Set(await SEGMENT_DEFS.registered_never_booked.members({ now, limit: 50 }));
    assert.ok(!members.has(String(booked._id)), "same email as a guest visit");
    assert.ok(!members.has(String(viaPhone._id)), "same phone (stored in another format) as a guest visit");
    assert.ok(!members.has(String(declined._id)), "a request the owner declined is not re-asked");
    assert.ok(members.has(String(cancelled._id)), "a visit the customer cancelled gives the offer back");
    assert.ok(members.has(String(neverBooked._id)), "a person with nothing booked stays in");
    assert.strictEqual(await SEGMENT_DEFS.registered_never_booked.includes(await User.findById(booked._id).lean(), { now }), false, "the send-time re-check agrees");
  });

  await test("lifecycle: an unlinked guest request is OPEN (no Track A), never COMPLETED (no Track B)", async () => {
    const s = await lifecycle.freeVisitStateForUser(await User.findById(booked._id).lean());
    assert.strictEqual(s.state, lifecycle.STATE.OPEN);
    assert.strictEqual(s.unlinkedGuestRequest, true);
    await Booking.collection.updateOne({ email: "booked@example.com" }, { $set: { status: "Completed", completedAt: ago(5) } });
    const after = await lifecycle.freeVisitStateForUser(await User.findById(booked._id).lean());
    assert.strictEqual(after.state, lifecycle.STATE.OPEN, "a completed but unlinked visit holds Track A back; a contact match alone never starts Track B");
    assert.strictEqual((await lifecycle.freeVisitStateForUser(await User.findById(neverBooked._id).lean())).state, lifecycle.STATE.AVAILABLE);
  });

  await test("completion link: only the ONE account that proved the contact, and nothing is merged", async () => {
    const visit = await Booking.findOne({ email: "booked@example.com" }).lean();
    assert.strictEqual(await linkCompletedGuestVisit(visit), 0, "an unproved email is not enough");
    await User.collection.updateOne({ _id: booked._id }, { $set: { emailVerifiedAt: ago(1) } });
    assert.strictEqual(await linkCompletedGuestVisit(visit), 1, "proved email: linked");
    const linked = await Booking.findById(visit._id).lean();
    assert.strictEqual(String(linked.user), String(booked._id));
    const s = await lifecycle.freeVisitStateForUser(await User.findById(booked._id).lean());
    assert.strictEqual(s.state, lifecycle.STATE.COMPLETED, "now on the account, Track B can start");
    assert.ok(!s.unlinkedGuestRequest);

    // two accounts proved the same handset: left for the owner
    const shared = guestBooking({ email: "shared@example.com", phone: "+16315550177", status: "Completed", completedAt: ago(1) });
    await Booking.collection.insertOne(shared);
    await User.collection.insertMany([
      user({ email: "a@example.com", phone: "+16315550177", phoneVerifiedAt: ago(2) }),
      user({ email: "b@example.com", phone: "+16315550177", phoneVerifiedAt: ago(2) }),
    ]);
    assert.strictEqual(await linkCompletedGuestVisit(await Booking.findById(shared._id).lean()), 0);
    assert.strictEqual((await Booking.findById(shared._id).lean()).user, null);
  });

  await test("follow-up email: the button is the tagged /book/free link, and Marcus sees it and the results", async () => {
    const pb = { key: "registered-never-booked-v1", segment: "registered_never_booked", ctaRoute: "bookFree" };
    const url = new URL(playbookEmail.ctaUrlOf(pb));
    assert.strictEqual(`${url.origin}${url.pathname}`, "https://www.profixter.com/book/free");
    assert.strictEqual(url.searchParams.get("utm_source"), "email");
    assert.strictEqual(url.searchParams.get("utm_campaign"), "registered-never-booked-v1");
    assert.strictEqual(new URL(playbookEmail.ctaUrlOf({ ...pb, ctaRoute: "book" })).pathname, "/book/free", "the old 'book' route still means the free visit");

    await EmailPlaybook.create({ ...pb, name: "Never booked", subject: "s", headline: "h", paragraphs: ["p"], ctaLabel: "Pick a time", status: "approved", version: 1, approvedVersion: 1 });
    await GrowthAction.collection.insertOne({ _id: id(), type: "playbook_email", idempotencyKey: "k1", status: "succeeded", executedAt: ago(4), payload: { userId: String(neverBooked._id), playbookKey: pb.key } });
    await Request.collection.insertOne({ _id: id(), serviceType: "free_visit_request", email: "never@example.com", createdAt: ago(2), attribution: { url: { utm_source: "email", utm_campaign: pb.key } } });
    const [row] = await TOOL_DEFS.list_email_playbooks.run({}, {});
    assert.strictEqual(row.buttonRoute, "bookFree");
    assert.ok(row.buttonLink.startsWith("https://www.profixter.com/book/free?"));
    assert.strictEqual(row.results.emailsAccepted, 1);
    assert.strictEqual(row.results.oneStepRequestAfter, 1);
    assert.strictEqual(row.results.oneStepRequestsWithThisEmailsLink, 1);
  });

  await test("copy rules: the Free Visit promises no labor (the approved email and the Google posts stop at send time)", () => {
    const { checkCopy } = require("../utils/agents/copyRules");
    assert.ok(checkCopy("New customers get one free first visit: a real working visit of up to 90 minutes spent on your list.").length);
    assert.ok(checkCopy("One of our handymen comes to your home and spends up to 90 minutes working on the jobs on your list.").length);
    assert.deepStrictEqual(checkCopy("Your Free Visit: we walk through your to-do list together and help you choose the right Profixter service. One per customer, for new customers."), []);
    assert.ok(playbookEmail.playbookText({ subject: "s", preheader: "A real working visit of up to 90 minutes at your home.", headline: "h", paragraphs: [], ctaLabel: "c", closing: "x" }).includes("90 minutes"));
  });

  await test("marketing texts staff switched on are counted as needing the customer's confirmation", () => {
    const base = { _id: id(), role: "customer", isActive: true, email: "t@example.com", phone: "+16315550111" };
    assert.strictEqual(consentStatus({ ...base, smsPreferences: { marketingEnabled: true, marketingConsentSource: "admin_phone" } }).smsMarketing, "needs_confirmation");
    assert.strictEqual(consentStatus({ ...base, smsPreferences: { marketingEnabled: true, marketingConsentSource: "account_settings" } }).smsMarketing, "opted_in");
    assert.strictEqual(consentStatus({ ...base, smsPreferences: { transactionalEnabled: true } }).smsService, "opted_in", "service texts unchanged");
  });

  await test("board: a 'just note it' record is a note, not a decision", async () => {
    await CouncilDecision.create([
      { category: "decision", subject: "Approve the post?", recommendation: { choice: "approve", reason: "r" }, status: "open", inbox: "needs_you" },
      { category: "decision", subject: "Rename Nextdoor page", recommendation: { choice: "acknowledge", reason: "owner login" }, status: "open", inbox: "needs_you" },
    ]);
    const board = await decisionBoard({ now });
    assert.strictEqual(board.counts.decisions, 1);
    assert.strictEqual(board.counts.info, 1);
    const note = board.sections[0].items.find((i) => i.subject === "Rename Nextdoor page");
    assert.match(note.type, /no decision/);
    const { attentionSummary } = require("../utils/council/attention");
    assert.strictEqual((await attentionSummary()).needsYou, 1, "the badge says the same");
  });

  await test("archive: a duplicate of the owner's own task is archived, kept and restorable; other reasons still ask", async () => {
    const [keep, dup, other] = await CouncilTask.create([
      { agent: "conversion", instruction: "Draft v2 with the bookFree button", origin: "arthur", status: "completed" },
      { agent: "conversion", instruction: "Draft a follow-up email playbook", origin: "owner", status: "blocked" },
      { agent: "conversion", instruction: "Look at something else entirely", origin: "owner", status: "assigned" },
    ]);
    const r = await archiveItem({ kind: "task", id: String(dup._id), reason: "The newer task does the same job with the working button.", category: "duplicate", duplicateOf: String(keep._id) });
    assert.strictEqual(r.archived, true);
    const t = await CouncilTask.findById(dup._id).lean();
    assert.strictEqual(t.status, "archived");
    assert.strictEqual(t.archive.previousStatus, "blocked");
    await assert.rejects(
      archiveItem({ kind: "task", id: String(other._id), reason: "Not about marketing at all, it is billing.", category: "stale" }),
      /stale/,
      "a fresh owner task is not stale"
    );
  });

  await test("daily limit: rolling back yesterday's post today does not use up today's post", async () => {
    const { usedToday } = require("../utils/growth/actionEngine");
    await GrowthAction.collection.insertMany([
      { _id: id(), type: "gbp_post", idempotencyKey: "old-1", status: "rolled_back", createdAt: ago(1.2), executedAt: ago(1.1), updatedAt: now },
      { _id: id(), type: "gbp_post", idempotencyKey: "old-2", status: "rolled_back", createdAt: ago(7), executedAt: ago(7), updatedAt: now },
    ]);
    assert.strictEqual(await usedToday("gbp_post", now), 0);
    await GrowthAction.collection.insertOne({ _id: id(), type: "gbp_post", idempotencyKey: "today", status: "approved", createdAt: ago(0.1), executedAt: null, updatedAt: ago(0.1) });
    assert.strictEqual(await usedToday("gbp_post", now), 1, "a post approved today, not yet run, counts");
  });

  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
