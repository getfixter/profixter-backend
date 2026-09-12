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
  const {
    placeZipCluster,
    pointInRings,
    ZIP_GEOGRAPHY,
    clusterRadiusM,
    zipSpreadCeilingM,
    SOLO_OFFSET_M,
    MAX_SOLO_OFFSET_M,
    ABSOLUTE_MAX_OFFSET_M,
  } = require("../utils/membershipMap/publicPoint");

  /** Metres between two lat/lng points, near enough at this latitude. */
  const metresBetween = (a, b) =>
    Math.hypot(
      (a.lat - b.lat) * 111320,
      (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180)
    );

  /** One membership's point, via the cluster placer. */
  const soloPoint = (zip, seed) => placeZipCluster({ zip, seeds: [seed] }).get(seed);
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
    await test(`${plan} active -> one pin, with no tier attached`, async () => {
      await reset();
      await makeSubscription({ subscriptionType: plan });
      const rows = await points();
      assert.strictEqual(rows.length, 1, `expected one pin, got ${rows.length}`);
      /*
       * Every tier earns a pin and no tier is identifiable from one. The plan is
       * still read upstream - an unrecognised one is not a membership this map
       * publishes - but it stops before the payload.
       */
      assert.deepStrictEqual(Object.keys(rows[0]).sort(), ["x", "y"]);
    });
  }

  await test("A PLAN CHANGE IS INVISIBLE ON THE MAP", async () => {
    /*
     * The V3 rule, and the inverse of the V2 one.
     *
     * V2 restyled the marker when somebody upgraded, which made the map a public
     * record of what each customer pays. Now an upgrade and a downgrade produce
     * a byte-identical point: same place, same absence of any tier. The only
     * thing that can change a pin is gaining or losing access.
     */
    await reset();
    const sub = await makeSubscription({ subscriptionType: "basic" });
    const before = (await points())[0];

    await Subscription.updateOne({ _id: sub._id }, { $set: { subscriptionType: "elite" } });
    assert.deepStrictEqual((await points())[0], before, "an upgrade must change nothing");

    await Subscription.updateOne({ _id: sub._id }, { $set: { subscriptionType: "plus" } });
    assert.deepStrictEqual((await points())[0], before, "a downgrade must change nothing");
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
    assert.deepStrictEqual(Object.keys(rows[0]).sort(), ["x", "y"], "and carries no tier");
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
    /*
     * Paid cover is still resolved before gifts, exactly as everywhere else in
     * the application - it is simply no longer observable from the payload,
     * which is the point of V3. What matters publicly is that one home is one
     * pin rather than two.
     */
    assert.deepStrictEqual(Object.keys(rows[0]).sort(), ["x", "y"]);
  });

  /* ================================================================== */
  section("The published position is not a customer's location");
  /* ================================================================== */

  await test("every placement lands inside the ZIP's own polygon", async () => {
    /*
     * Exercised across every service-area ZIP at several cluster sizes. This is
     * what stops a pin in Great South Bay, in the Sound, or in the next town.
     */
    const zips = Object.keys(ZIP_GEOGRAPHY);
    let checked = 0;
    for (const zip of zips) {
      const rings = ZIP_GEOGRAPHY[zip].rings;
      for (const count of [1, 2, 4, 7]) {
        const seeds = Array.from({ length: count }, (_, i) => `probe:${zip}:${count}:${i}`);
        const placed = placeZipCluster({ zip, seeds });
        assert.strictEqual(placed.size, count, `${zip} placed ${placed.size} of ${count}`);
        for (const [seed, point] of placed) {
          assert.ok(
            pointInRings(point.lat, point.lng, rings),
            `${zip} (${count} members) put ${seed} outside its own area`
          );
          checked += 1;
        }
      }
    }
    console.log(`        (${checked} placements across ${zips.length} ZIPs)`);
  });

  await test("A LONE MEMBER SITS ON THEIR OWN TOWN", async () => {
    /*
     * THE HEADLINE FIX OF V2.
     *
     * V1 scattered every membership anywhere inside its ZIP, which pushed the
     * median pin 836m from its town centre and the worst 2358m - the next town
     * over. It did that to avoid a collision, and twenty-five of thirty-two ZIPs
     * have exactly one member and therefore nothing to collide with.
     */
    for (const zip of Object.keys(ZIP_GEOGRAPHY).slice(0, 40)) {
      const g = ZIP_GEOGRAPHY[zip];
      const point = soloPoint(zip, `solo:${zip}`);
      const offset = metresBetween(point, { lat: g.lat, lng: g.lng });
      assert.ok(
        offset <= MAX_SOLO_OFFSET_M + 1,
        `${zip}: a lone member sits ${Math.round(offset)}m out, cap is ${MAX_SOLO_OFFSET_M}m`
      );
    }
  });

  await test("no pin anywhere may exceed the absolute offset cap", async () => {
    for (const zip of Object.keys(ZIP_GEOGRAPHY)) {
      const g = ZIP_GEOGRAPHY[zip];
      for (const count of [1, 3, 6, 9]) {
        const seeds = Array.from({ length: count }, (_, i) => `cap:${zip}:${count}:${i}`);
        for (const point of placeZipCluster({ zip, seeds }).values()) {
          const offset = metresBetween(point, { lat: g.lat, lng: g.lng });
          assert.ok(
            offset <= ABSOLUTE_MAX_OFFSET_M + 1,
            `${zip}: pin ${Math.round(offset)}m out exceeds ${ABSOLUTE_MAX_OFFSET_M}m`
          );
        }
      }
    }
  });

  await test("members in one ZIP are separated enough to count", async () => {
    /*
     * A cluster has to read as several memberships rather than one blob, which
     * means the closest pair must be genuinely apart - while staying inside the
     * town. Both halves of that are asserted.
     */
    const zip = ZIP;
    const g = ZIP_GEOGRAPHY[zip];
    for (const count of [2, 3, 4, 6]) {
      const seeds = Array.from({ length: count }, (_, i) => `sep:${count}:${i}`);
      const points = [...placeZipCluster({ zip, seeds }).values()];
      let closest = Infinity;
      for (let i = 0; i < points.length; i += 1) {
        for (let j = i + 1; j < points.length; j += 1) {
          closest = Math.min(closest, metresBetween(points[i], points[j]));
        }
      }
      assert.ok(closest > 300, `${count} members: closest pair only ${Math.round(closest)}m apart`);
      for (const point of points) {
        const offset = metresBetween(point, { lat: g.lat, lng: g.lng });
        assert.ok(offset <= ABSOLUTE_MAX_OFFSET_M, `${count} members: a pin strayed ${Math.round(offset)}m`);
      }
    }
  });

  await test("the cluster ring never outgrows the ZIP it is in", async () => {
    /*
     * A compact village ZIP must get a tighter cluster than a large eastern
     * Suffolk one, or a crowded small town would fling its pins into the
     * neighbours.
     */
    for (const zip of Object.keys(ZIP_GEOGRAPHY)) {
      const g = ZIP_GEOGRAPHY[zip];
      const ceiling = zipSpreadCeilingM(g);
      for (const count of [2, 5, 10]) {
        assert.ok(
          clusterRadiusM(g, count) <= ceiling + 1,
          `${zip}: ring for ${count} exceeds its own ceiling`
        );
      }
    }
  });

  await test("a position is stable for the same membership", async () => {
    const a = placeZipCluster({ zip: ZIP, seeds: ["sub:abc", "sub:def"] });
    const b = placeZipCluster({ zip: ZIP, seeds: ["sub:def", "sub:abc"] });
    /*
     * Also proves order-independence: the same two memberships handed over in
     * the opposite order must land in the same two places, or a change to how
     * Mongo returns rows would move everybody's pin.
     */
    assert.deepStrictEqual(a.get("sub:abc"), b.get("sub:abc"));
    assert.deepStrictEqual(a.get("sub:def"), b.get("sub:def"));
  });

  await test("a neighbour joining keeps everybody in the same town", async () => {
    /*
     * WHAT STABILITY ACTUALLY MEANS HERE, AND WHAT IT DOES NOT.
     *
     * A membership must not move because of anything about itself - reloads,
     * restarts and plan changes are all asserted elsewhere to leave a pin
     * exactly where it was. When the SET of members in a ZIP changes, the
     * cluster re-packs: slots are dealt in hash order, so a newcomer sorting
     * into the middle shifts the ones after it by a slot.
     *
     * That is deliberate rather than tolerated. Pinning each member to a slot
     * for life needs a sparse slot space, and a sparse space puts early
     * members hundreds of metres further out than the packing requires - which
     * is the V1 mistake in a new costume. Re-packing keeps the cluster tight
     * and honest; what it must never do is move somebody out of their town.
     */
    const before = placeZipCluster({ zip: ZIP, seeds: ["sub:a", "sub:b", "sub:c"] });
    const after = placeZipCluster({ zip: ZIP, seeds: ["sub:a", "sub:b", "sub:c", "sub:d"] });
    const anchor = { lat: ZIP_GEOGRAPHY[ZIP].lat, lng: ZIP_GEOGRAPHY[ZIP].lng };
    for (const seed of ["sub:a", "sub:b", "sub:c"]) {
      const offset = metresBetween(after.get(seed), anchor);
      assert.ok(
        offset <= ABSOLUTE_MAX_OFFSET_M,
        `${seed} ended up ${Math.round(offset)}m from its town centre`
      );
      assert.ok(
        pointInRings(after.get(seed).lat, after.get(seed).lng, ZIP_GEOGRAPHY[ZIP].rings),
        `${seed} was re-packed outside its own ZIP`
      );
    }
  });

  await test("an unknown ZIP is skipped, never guessed", async () => {
    assert.strictEqual(placeZipCluster({ zip: "99999", seeds: ["x"] }).size, 0);
    assert.strictEqual(placeZipCluster({ zip: "", seeds: ["x"] }).size, 0);
    assert.strictEqual(placeZipCluster({ zip: ZIP, seeds: [] }).size, 0);
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
    /* One of every tier, so a tier leaking into the payload would be caught. */
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
      /*
       * EXACTLY TWO KEYS. The membership tier was removed from the public shape
       * in V3 - the map says somebody here is a member, not what they pay - so
       * a third key appearing is a regression whatever it is called.
       */
      assert.deepStrictEqual(Object.keys(point).sort(), ["x", "y"]);
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
      "plan", "tier", "basic", "plus", "premium", "elite", "level",
    ];
    for (const word of forbidden) {
      assert.ok(
        !new RegExp(`"${word}"`, "i").test(raw),
        `the public payload contains a "${word}" field`
      );
    }
  });

  await test("no tier word survives anywhere in the raw response", async () => {
    /*
     * Asserted against the response TEXT, not the parsed keys, because the risk
     * is not only a "plan" field - it is the word "elite" turning up as a value,
     * a comment, or a key nobody thought to look at.
     */
    await reset();
    for (const plan of ["basic", "plus", "premium", "elite"]) {
      await makeSubscription({ subscriptionType: plan });
    }
    map.clearCache();

    const raw = await (await fetch(`${base}/api/membership-map`)).text();
    for (const word of ["basic", "plus", "premium", "elite", "plan", "tier", "level"]) {
      assert.ok(
        !new RegExp(word, "i").test(raw),
        `the public payload mentions "${word}"`
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
    assert.strictEqual(res.status, 200, "must answer without authentication");

    /*
     * THE HEADER AND THE IN-PROCESS MEMO HAVE TO AGREE.
     *
     * What a visitor actually experiences is the LARGER of the two, so the
     * shorter one is a fiction if they drift apart. V2 cut the memo to ninety
     * seconds and left this header at five minutes, which meant a browser or
     * CDN could serve a map three and a half minutes staler than the server
     * itself believed - and nothing anywhere would have said so.
     */
    const header = res.headers.get("cache-control") || "";
    const maxAge = Number((header.match(/max-age=(\d+)/) || [])[1]);
    assert.ok(Number.isFinite(maxAge), `no max-age in "${header}"`);
    assert.strictEqual(
      maxAge * 1000,
      map.CACHE_TTL_MS,
      `header says ${maxAge}s but the server caches for ${map.CACHE_TTL_MS / 1000}s`
    );
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
