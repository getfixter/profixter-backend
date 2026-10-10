/**
 * Outreach (postal mail): who is mailable, household de-duplication, the
 * nightly sync's gating and resume, the agent's wave planning rules, and that
 * GoHighLevel is only ever READ.
 *
 * Fake GoHighLevel (no real person is contacted), in-memory MongoDB.
 *   node scripts/test_outreach_integration.js
 */
process.env.NODE_ENV = "test";
const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { OutreachRecipient, OutreachWave } = require("../models/Outreach");
const AnalyticsState = require("../models/AnalyticsState");
const User = require("../models/User");
const audience = require("../utils/outreach/audience");
const { syncOutreachOnce } = require("../jobs/conversations");
const { runTool } = require("../utils/agents/tools");
const { AGENTS } = require("../utils/agents/definitions");

/* Fake GoHighLevel contact search: two pages, then empty. */
const calls = [];
const contact = (id, over = {}) => ({
  id,
  firstName: "Pat",
  lastName: `Home${id}`,
  address1: `${id} Main St`,
  city: "Lindenhurst",
  state: "NY",
  postalCode: "11757",
  email: `p${id}@example.com`,
  phone: `+1631555${String(id).padStart(4, "0")}`,
  tags: ["cold_prospects_2026"],
  searchAfter: [id],
  ...over,
});
const PAGES = [
  [
    contact(1),
    contact(2, { postalCode: "10001", city: "New York" }), // outside service area
    contact(3, { address1: "" }), // no street address
    contact(4, { dnd: true }), // asked to stop
    contact(5, { email: "member@example.com" }), // existing customer
    contact(6, { firstName: "Test", lastName: "Test" }), // junk
  ],
  [
    contact(7, { address1: "1 Main St.", lastName: "Spouse" }), // same household as #1? no: "1 main st" vs "1 main st" -> yes
    contact(8, { dndSettings: { SMS: { status: "active", message: "Carrier error" } } }), // carrier DND: still mailable
    contact(9, { dndSettings: { SMS: { status: "permanent" } } }), // asked to stop
  ],
];
const fetchImpl = async (url, init = {}) => {
  const u = new URL(String(url));
  calls.push({ method: init.method, path: u.pathname });
  assert.ok(u.hostname === "services.leadconnectorhq.com");
  const body = init.body ? JSON.parse(init.body) : {};
  const page = body.searchAfter ? (body.searchAfter[0] === 6 ? PAGES[1] : []) : PAGES[0];
  return { ok: true, status: 200, json: async () => ({ contacts: page }) };
};
const ENV = { GHL_API_TOKEN: "test-token-not-real", OUTREACH_SYNC_ENABLED: "true" };

let passed = 0;
async function test(name, fn) {
  calls.length = 0;
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}`);
    throw e;
  }
}

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await User.collection.insertOne({ userId: "u-member", email: "member@example.com", phone: "6310000000" });

  await test("sync is inert without the flag or the token, and calls nothing", async () => {
    assert.deepStrictEqual(await syncOutreachOnce({ env: { GHL_API_TOKEN: "x" }, fetchImpl }), { skipped: true });
    assert.deepStrictEqual(await syncOutreachOnce({ env: { OUTREACH_SYNC_ENABLED: "true" }, fetchImpl }), { skipped: true });
    assert.strictEqual(calls.length, 0);
  });

  await test("sync classifies who is mailable, resumes, and only reads GoHighLevel", async () => {
    const first = await syncOutreachOnce({ env: { ...ENV, OUTREACH_SYNC_PAGES: "1" }, fetchImpl });
    assert.strictEqual(first.done, false);
    const second = await syncOutreachOnce({ env: ENV, fetchImpl });
    assert.strictEqual(second.done, true);
    assert.ok(calls.every((c) => c.method === "POST" && c.path === "/contacts/search"), JSON.stringify(calls));
    const by = Object.fromEntries((await OutreachRecipient.find({}).lean()).map((r) => [r.ghlContactId, r]));
    assert.strictEqual(by["1"].eligible, true);
    assert.strictEqual(by["2"].excludedReason, "outside_service_area");
    assert.strictEqual(by["3"].excludedReason, "no_street_address");
    assert.strictEqual(by["4"].excludedReason, "asked_to_stop");
    assert.strictEqual(by["5"].excludedReason, "existing_customer");
    assert.strictEqual(by["6"].excludedReason, "junk_record");
    assert.strictEqual(by["7"].excludedReason, "same_household");
    assert.strictEqual(by["8"].eligible, true, "carrier-error DND does not block mail");
    assert.strictEqual(by["9"].excludedReason, "asked_to_stop");
    assert.ok(!("email" in by["1"]) && !("phone" in by["1"]), "raw email/phone are not stored");
    assert.ok(by["1"].code && by["1"].code !== by["8"].code);
    // A completed sync rests for 30 days.
    assert.deepStrictEqual(await syncOutreachOnce({ env: ENV, fetchImpl }), { skipped: "fresh" });
    assert.ok((await AnalyticsState.findOne({ key: "outreach:sync-cursor" }).lean()).value.completedAt);
  });

  await test("the agent sees counts only", async () => {
    const s = JSON.stringify(await audience.audienceSummary());
    assert.match(s, /"eligible":2/);
    assert.ok(!/Main St|example\.com|Home1/.test(s), s);
  });

  const ctx = { agent: "outreach", agentLabel: "Outreach agent", toolNames: AGENTS.outreach.tools, allowedActions: [] };
  const plan = (over = {}) =>
    runTool(
      "plan_mail_wave",
      {
        name: "Lindenhurst test",
        target_zips: ["11757"],
        size: 100,
        headline: "Your first Profixter visit is free",
        body: "A local Fixter comes to your home and takes care of real handyman work on your small jobs. Book a time online that suits you.",
        call_to_action: "Scan to book your free first visit",
        rationale: "Customers already in Lindenhurst",
        ...over,
      },
      ctx
    );

  await test("wave planning refuses ZIPs outside the area, bad sizes, too few homes and banned copy", async () => {
    await assert.rejects(plan({ target_zips: ["10001"] }), /service area/);
    await assert.rejects(plan({ size: 50 }), /Size must be/);
    await assert.rejects(plan({ size: 100 }), /Only 2 mailable/);
    await OutreachRecipient.insertMany(
      Array.from({ length: 120 }, (_, i) => ({ ghlContactId: `x${i}`, zip: "11757", eligible: true, code: `c${i}`, address1: `${i} Elm St`, city: "Lindenhurst" }))
    );
    await assert.rejects(plan({ body: "Get 20% off your first repair - a free estimate for your home." }), /Rewrite needed/);
    assert.strictEqual(await OutreachWave.countDocuments({}), 0);
  });

  await test("a valid plan is only a draft with its cost; nothing is mailed or exported", async () => {
    const out = await plan();
    assert.strictEqual(out.status, "draft");
    assert.strictEqual(out.estimatedCost, "$95.00");
    const w = await OutreachWave.findOne({ key: out.key }).lean();
    assert.strictEqual(w.status, "draft");
    assert.strictEqual(await OutreachRecipient.countDocuments({ lastMailedAt: { $ne: null } }), 0);
  });

  await test("wave results count registrations and first free visits by tracked code", async () => {
    const Booking = require("../models/Booking");
    const u = await User.collection.insertOne({ userId: "u-new", email: "new@example.com", attribution: { utmContent: "w261010ab-c1" } });
    await Booking.collection.insertOne({ user: u.insertedId, isFreeFirstVisit: true });
    await User.collection.insertOne({ userId: "u-other", email: "other@example.com", attribution: { utmContent: "w999999zz-c2" } });
    assert.deepStrictEqual(await audience.waveResults("w261010ab"), { registrations: 1, firstFreeVisits: 1 });
  });

  await test("the outreach agent has no messaging, booking or action powers", async () => {
    assert.deepStrictEqual(AGENTS.outreach.allowedActions, []);
    for (const t of AGENTS.outreach.tools) assert.ok(!/send|propose_action|book|calendar|bulk/.test(t), t);
  });

  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
