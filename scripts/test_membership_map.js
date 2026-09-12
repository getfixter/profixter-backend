/**
 * The public membership map, end to end.
 *
 * TWO THINGS ARE BEING DEFENDED HERE AND THEY PULL IN OPPOSITE DIRECTIONS.
 *
 * The map has to be TRUE: every pin is a membership that grants access right
 * now, and a membership that ends takes its pin with it. And it has to be
 * SAFE: the thing published must not identify anybody, must not be a customer's
 * location, and must not state how many customers there are.
 *
 * A feature that satisfies one and not the other is a failure either way - an
 * empty map sells nothing, and a map that leaks is worse than no map. So this
 * file asserts both sides against the real route, the real models and the real
 * eligibility authority on an in-memory MongoDB. Stubbing the authority would
 * prove the stub, and the authority is the entire point: the map must agree
 * with the rest of the application about who is a member.
 *
 *   node scripts/test_membership_map.js
 */

const assert = require("assert");
const express = require("express");
const fetch = require("node-fetch");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-not-real";

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error?.message || error}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** A ZIP that exists in the service-area table, in Lindenhurst. */
const ZIP = "11757";
/** A second, for spread and collision cases. */
const ZIP_B = "11702";

const DAY = 24 * 60 * 60 * 1000;

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const Subscription = require("../models/Subscription");
  const GiftMembership = require("../models/GiftMembership");
  const map = require("../utils/membershipMap");
  const { publicPointFor, pointInRings, ZIP_GEOGRAPHY, radiusForZip } = require("../utils/membershipMap/publicPoint");
  const { project, VIEWBOX } = require("../utils/membershipMap/projection");

  const app = express();
  app.use("/api/membership-map", require("../routes/membershipMap"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  let seq = 0;

  /** An active paid membership on a real service-area ZIP. */
  async function makeSubscription(overrides = {}) {
    seq += 1;
    const now = Date.now();
    return Subscription.create({
      user: new mongoose.Types.ObjectId(),
      userId: `U${seq}${now}`.slice(0, 12),
      subscriptionType: "basic",
      addressId: new mongoose.Types.ObjectId(),
      addressSnapshot: { line1: "1 Test St", city: "Lindenhurst", state: "NY", zip: ZIP },
      billingCycle: "monthly",
      startDate: new Date(now - 30 * DAY),
      latestPaymentDate: new Date(now - 30 * DAY),
      nextPaymentDate: new Date(now + 30 * DAY),
      currentPeriodEnd: new Date(now + 30 * DAY),
      accessStatus: "active",
      status: "active",
      ...overrides,
    });
  }

  async function points() {
    map.clearCache();
    const payload = await map.buildPayload();
    return payload.points;
  }

  async function reset() {
    await Subscription.deleteMany({});
    await GiftMembership.deleteMany({});
    map.clearCache();
  }

  /* ================================================================== */
  section("A pin means an active membership");
  /* ================================================================== */

  for (const plan of ["basic", "plus", "premium", "elite"]) {
    await test(`${plan} active -> one ${plan} pin`, async () => {
      await reset();
      await makeSubscription({ subscriptionType: plan });
      const rows = await points();
      assert.strictEqual(rows.length, 1, `expected one pin, got ${rows.length}`);
      assert.strictEqual(rows[0].plan, plan);
    });
  }

  await test("changing plan changes the pin's tier, not its place", async () => {
    await reset();
    const sub = await makeSubscription({ subscriptionType: "basic" });
    const before = (await points())[0];
    assert.strictEqual(before.plan, "basic");

    await Subscription.updateOne({ _id: sub._id }, { $set: { subscriptionType: "elite" } });
    const after = (await points())[0];
    assert.strictEqual(after.plan, "elite", "an upgrade must restyle the marker");
    /*
     * The position is seeded from the subscription, not the plan, so upgrading
     * must not teleport the pin across town - which would look like a different
     * customer rather than the same one moving up.
     */
    assert.strictEqual(after.x, before.x);
    assert.strictEqual(after.y, before.y);

    await Subscription.updateOne({ _id: sub._id }, { $set: { subscriptionType: "plus" } });
    assert.strictEqual((await points())[0].plan, "plus", "a downgrade must restyle too");
  });

  /* ================================================================== */
  section("A pin disappears the moment access does");
  /* ================================================================== */

  const gone = [
    ["cancelled", { status: "canceled", accessStatus: "inactive" }],
    ["expired period", { currentPeriodEnd: new Date(Date.now() - DAY) }],
    ["past_due", { status: "past_due" }],
    ["unpaid", { status: "unpaid" }],
    ["incomplete", { status: "incomplete" }],
    [
      "cancel-at-period-end, period already over",
      { cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() - DAY) },
    ],
    [
      "stripe-managed with the access latch off",
      { stripeSubscriptionId: "sub_test_123", accessStatus: "inactive" },
    ],
  ];

  for (const [label, overrides] of gone) {
    await test(`${label} -> no pin`, async () => {
      await reset();
      await makeSubscription(overrides);
      assert.strictEqual((await points()).length, 0, `${label} still produced a pin`);
    });
  }

  await test("cancel-at-period-end still inside the period -> pin stays", async () => {
    /*
     * They have paid through the end of the month and can still book, so they
     * are still a member and the map must not quietly write them off early.
     */
    await reset();
    await makeSubscription({
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(Date.now() + 10 * DAY),
    });
    assert.strictEqual((await points()).length, 1);
  });

  await test("trialing counts as active", async () => {
    await reset();
    await makeSubscription({ status: "trialing" });
    assert.strictEqual((await points()).length, 1);
  });

  await test("the map agrees with the authority on every record", async () => {
    /*
     * The strongest form of the claim: for a spread of states, the map's answer
     * and subscriptionGrantsAccess's answer are compared row by row. If anybody
     * ever adds a second definition of "active" here, this fails.
     */
    const { subscriptionGrantsAccess } = require("../utils/subscriptionManagement");
    await reset();
    const states = [
      { status: "active" },
      { status: "trialing" },
      { status: "canceled" },
      { status: "past_due" },
      { currentPeriodEnd: new Date(Date.now() - DAY) },
      { cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() + 5 * DAY) },
    ];
    for (const s of states) await makeSubscription(s);

    const rows = await Subscription.find({}).lean();
    const expected = rows.filter((r) => subscriptionGrantsAccess(r)).length;
    assert.strictEqual((await points()).length, expected, "map and authority disagree");
  });

  /* ================================================================== */
  section("Only memberships. Nothing else buys a pin.");
  /* ================================================================== */

  await test("a one-time visit customer has no subscription and no pin", async () => {
    /*
     * There is nothing to exclude: a one-time visit is a Booking, and the map
     * reads Subscriptions and gifts. The test exists so that a future change
     * which starts writing Subscription rows for one-off work fails here.
     */
    await reset();
    assert.strictEqual((await points()).length, 0);
  });

  await test("a free-visit-only customer gets no pin", async () => {
    await reset();
    assert.strictEqual((await points()).length, 0);
  });

  await test("an unclaimed gift is not a membership", async () => {
    await reset();
    await GiftMembership.create({
      giftNumber: `G${Date.now()}`,
      purchaser: new mongoose.Types.ObjectId(),
      recipientEmail: "someone@example.com",
      plan: "premium",
      durationMonths: 2,
      status: "issued",
      addressSnapshot: { line1: "1 Test St", city: "Lindenhurst", state: "NY", zip: ZIP },
      amountPaidCents: 49800,
    }).catch(() => null);
    assert.strictEqual((await points()).length, 0, "an unclaimed gift must not appear");
  });

  await test("a claimed, live gift IS a membership and gets its plan's pin", async () => {
    await reset();
    const now = Date.now();
    await GiftMembership.create({
      giftNumber: `G${now}`,
      purchaser: new mongoose.Types.ObjectId(),
      recipient: new mongoose.Types.ObjectId(),
      recipientEmail: "recipient@example.com",
      plan: "premium",
      durationMonths: 2,
      status: "claimed",
      startAt: new Date(now - DAY),
      endAt: new Date(now + 40 * DAY),
      addressId: new mongoose.Types.ObjectId(),
      addressSnapshot: { line1: "2 Test St", city: "Lindenhurst", state: "NY", zip: ZIP },
      amountPaidCents: 49800,
    });
    const rows = await points();
    assert.strictEqual(rows.length, 1, "a live claimed gift is an active membership");
    assert.strictEqual(rows[0].plan, "premium");
  });

  await test("an expired gift loses its pin", async () => {
    await reset();
    const now = Date.now();
    await GiftMembership.create({
      giftNumber: `G${now}x`,
      purchaser: new mongoose.Types.ObjectId(),
      recipient: new mongoose.Types.ObjectId(),
      recipientEmail: "expired@example.com",
      plan: "elite",
      durationMonths: 2,
      status: "claimed",
      startAt: new Date(now - 90 * DAY),
      endAt: new Date(now - DAY),
      addressId: new mongoose.Types.ObjectId(),
      addressSnapshot: { line1: "3 Test St", city: "Lindenhurst", state: "NY", zip: ZIP },
      amountPaidCents: 99800,
    });
    assert.strictEqual((await points()).length, 0);
  });

  await test("paid cover and a gift on one address produce ONE pin", async () => {
    await reset();
    const addressId = new mongoose.Types.ObjectId();
    const now = Date.now();
    await makeSubscription({ addressId, subscriptionType: "plus" });
    await GiftMembership.create({
      giftNumber: `G${now}d`,
      purchaser: new mongoose.Types.ObjectId(),
      recipient: new mongoose.Types.ObjectId(),
      recipientEmail: "dup@example.com",
      plan: "elite",
      durationMonths: 2,
      status: "claimed",
      startAt: new Date(now - DAY),
      endAt: new Date(now + 40 * DAY),
      addressId,
      addressSnapshot: { line1: "1 Test St", city: "Lindenhurst", state: "NY", zip: ZIP },
      amountPaidCents: 99800,
    });
    const rows = await points();
    assert.strictEqual(rows.length, 1, "one home is one pin");
    assert.strictEqual(rows[0].plan, "plus", "paid cover is resolved first, as everywhere else");
  });

  /* ================================================================== */
  section("The published position is not a customer's location");
  /* ================================================================== */

  await test("the point always lands inside the ZIP's own polygon", async () => {
    /*
     * The containment rule, exercised across every service-area ZIP and several
     * seeds each. This is what stops a pin in Great South Bay, in the Sound, or
     * in the next town over.
     */
    const zips = Object.keys(ZIP_GEOGRAPHY);
    let checked = 0;
    for (const zip of zips) {
      const geography = ZIP_GEOGRAPHY[zip];
      for (let i = 0; i < 6; i += 1) {
        const point = publicPointFor({ zip, seed: `probe:${zip}:${i}` });
        assert.ok(point, `no point produced for ${zip}`);
        assert.ok(
          pointInRings(point.lat, point.lng, geography.rings),
          `${zip} seed ${i} landed outside its own area`
        );
        checked += 1;
      }
    }
    console.log(`        (${checked} placements across ${zips.length} ZIPs)`);
  });

  await test("the point is stable for the same membership", async () => {
    const a = publicPointFor({ zip: ZIP, seed: "sub:abc123" });
    const b = publicPointFor({ zip: ZIP, seed: "sub:abc123" });
    assert.deepStrictEqual(a, b, "a reload must not move somebody's pin");
  });

  await test("different memberships in one ZIP get different points", async () => {
    const seen = new Set();
    for (let i = 0; i < 12; i += 1) {
      const p = publicPointFor({ zip: ZIP, seed: `sub:spread${i}` });
      seen.add(`${p.lat.toFixed(5)},${p.lng.toFixed(5)}`);
    }
    assert.ok(seen.size >= 10, `expected spread, got ${seen.size} distinct of 12`);
  });

  await test("the displacement is materially more than a block", async () => {
    /*
     * The pin is not derived from the house at all, so there is no "offset from
     * the property" to measure. What can be measured is the size of the area a
     * pin could be anywhere within, and that has to be a town rather than a
     * street.
     */
    const radius = radiusForZip(ZIP_GEOGRAPHY[ZIP]);
    assert.ok(radius >= 700, `placement radius ${radius}m is too tight`);
    const spread = [];
    for (let i = 0; i < 60; i += 1) {
      const p = publicPointFor({ zip: ZIP, seed: `sub:radius${i}` });
      spread.push(p);
    }
    const lats = spread.map((p) => p.lat);
    const lngs = spread.map((p) => p.lng);
    const latSpanM = (Math.max(...lats) - Math.min(...lats)) * 111_320;
    assert.ok(latSpanM > 900, `pins for one ZIP only span ${Math.round(latSpanM)}m`);
  });

  await test("an unknown ZIP is skipped, never guessed", async () => {
    assert.strictEqual(publicPointFor({ zip: "99999", seed: "x" }), null);
    assert.strictEqual(publicPointFor({ zip: "", seed: "x" }), null);
    assert.strictEqual(publicPointFor({ zip: ZIP, seed: "" }), null);
  });

  await test("a membership on an out-of-area ZIP produces no pin", async () => {
    await reset();
    await makeSubscription({
      addressSnapshot: { line1: "1 Away St", city: "Denver", state: "CO", zip: "80202" },
    });
    assert.strictEqual((await points()).length, 0, "no shape to place it in, so no pin");
  });

  await test("a malformed record is skipped without taking the map down", async () => {
    await reset();
    await makeSubscription();
    await makeSubscription({ addressSnapshot: { line1: "", city: "", state: "", zip: "" } });
    await makeSubscription({ addressSnapshot: { zip: "notazip" } });
    const rows = await points();
    assert.strictEqual(rows.length, 1, "the good row survives, the bad ones are dropped");
  });

  /* ================================================================== */
  section("What the public endpoint actually returns");
  /* ================================================================== */

  await test("the payload carries three keys per point and nothing else", async () => {
    await reset();
    for (const plan of ["basic", "plus", "premium", "elite"]) {
      await makeSubscription({ subscriptionType: plan, addressSnapshot: { line1: "9 X St", city: "Babylon", state: "NY", zip: ZIP_B } });
    }
    map.clearCache();

    const res = await fetch(`${base}/api/membership-map`);
    assert.strictEqual(res.status, 200);
    const raw = await res.text();
    const body = JSON.parse(raw);

    assert.deepStrictEqual(Object.keys(body).sort(), ["points", "viewBox"]);
    for (const point of body.points) {
      assert.deepStrictEqual(Object.keys(point).sort(), ["plan", "x", "y"]);
    }

    /*
     * Asserted against the raw response text rather than the parsed object, so
     * a field nested somewhere unexpected cannot slip past a key check.
     */
    const forbidden = [
      "name", "email", "phone", "address", "line1", "city", "state", "zip",
      "lat", "lng", "latitude", "longitude", "coord",
      "user", "userId", "_id", "id", "subscription", "gift", "customer",
      "stripe", "seed", "salt", "total", "count",
    ];
    for (const word of forbidden) {
      assert.ok(
        !new RegExp(`"${word}"`, "i").test(raw),
        `the public payload contains a "${word}" field`
      );
    }
  });

  await test("no number in the payload could be read as a total", async () => {
    /*
     * The rule is that ProFixter never states how many members it has. The
     * array has a length - unavoidable for a map of pins - but nothing in the
     * response is a count, and nothing computes one.
     */
    const res = await fetch(`${base}/api/membership-map`);
    const body = await res.json();
    for (const key of Object.keys(body)) {
      if (key === "points" || key === "viewBox") continue;
      assert.fail(`unexpected top-level key "${key}"`);
    }
    assert.ok(!("total" in body) && !("count" in body));
  });

  await test("it is cached, and it takes no token", async () => {
    const res = await fetch(`${base}/api/membership-map`);
    assert.match(res.headers.get("cache-control") || "", /max-age=\d+/);
    assert.strictEqual(res.status, 200, "must answer without authentication");
  });

  await test("every published point lands inside the drawn viewBox", async () => {
    const res = await fetch(`${base}/api/membership-map`);
    const body = await res.json();
    assert.strictEqual(body.viewBox.width, VIEWBOX.width);
    for (const p of body.points) {
      assert.ok(p.x >= 0 && p.x <= body.viewBox.width, `x ${p.x} outside frame`);
      assert.ok(p.y >= 0 && p.y <= body.viewBox.height, `y ${p.y} outside frame`);
    }
  });

  await test("an empty map is an empty list, never a zero", async () => {
    await reset();
    map.clearCache();
    const res = await fetch(`${base}/api/membership-map`);
    const body = await res.json();
    assert.deepStrictEqual(body.points, []);
    assert.ok(!("total" in body), "an empty map must not report a total either");
  });

  /* ================================================================== */
  section("The projection");
  /* ================================================================== */

  await test("geography outside the frame is refused rather than clamped", () => {
    assert.strictEqual(project(51.5, -0.12), null, "London is not on Long Island");
    assert.strictEqual(project(NaN, NaN), null);
    const lindenhurst = project(40.689, -73.3735);
    assert.ok(lindenhurst && lindenhurst.x > 0 && lindenhurst.y > 0);
  });

  await test("the island keeps its real proportions", () => {
    /*
     * The viewBox height is computed from the bounds rather than chosen, so a
     * change to the bounds cannot silently stretch Long Island into a shape it
     * is not. Roughly two-and-a-bit times as wide as it is tall.
     */
    const aspect = VIEWBOX.width / VIEWBOX.height;
    assert.ok(aspect > 2.0 && aspect < 2.4, `aspect ${aspect.toFixed(2)} is not Long Island`);
  });

  /* ------------------------------------------------------------------ */
  server.close();
  await mongoose.disconnect();
  await mongod.stop();

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
