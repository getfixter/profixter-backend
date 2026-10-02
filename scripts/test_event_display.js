/**
 * Event display: customer booking photos on a tablet at a public booth.
 *
 * The bugs this feature can have are not crashes. They are a customer's name
 * riding along in the JSON, a Fixter or a customer reading the curated set, an
 * unreviewed photo of someone's mail reaching the screen, or an old HEIC with
 * GPS in it being shown at all.
 *
 *   node scripts/test_event_display.js
 *
 * Boots an in-memory MongoDB, as test_recent_work.js does.
 */

process.env.S3_BUCKET = "test-bucket";
process.env.S3_REGION = "us-east-1";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";

const assert = require("assert");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../models/User");
const Booking = require("../models/Booking");
const EventDisplayPhoto = require("../models/EventDisplayPhoto");
const photos = require("../utils/eventDisplayPhotos");

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

const B = "https://test-bucket.s3.amazonaws.com/uploads";
const STORAGE = { bucket: "test-bucket", region: "us-east-1" };

/* ---------------- pure selection rules ---------------- */

async function unitTests() {
  section("Which photos are candidates");

  await test("only JPEGs on our bucket are candidates", () => {
    const list = photos.collectCandidates(
      [
        {
          _id: "b1",
          images: [
            `${B}/2026-09-01/booking-1/1-customer-leak.jpg`,
            `${B}/2026-09-01/booking-1/2-wall.JPEG`,
            `${B}/2025-10-01/booking-1/3-old.heic`,
            `${B}/2025-10-01/booking-1/4-shot.png`,
            `${B}/2025-10-01/booking-1/5-doc.pdf`,
            `${B}/2025-10-01/booking-1/6-x.webp`,
            "local://leak.jpg",
            "https://evil.example.com/uploads/a.jpg",
            "http://test-bucket.s3.amazonaws.com/uploads/plain-http.jpg",
            `${B}/2026-09-01/booking-1/7-signed.jpg?X-Amz-Signature=abc`,
            null,
            42,
          ],
        },
      ],
      STORAGE
    );
    assert.deepStrictEqual(
      list.map((p) => p.url),
      [`${B}/2026-09-01/booking-1/1-customer-leak.jpg`, `${B}/2026-09-01/booking-1/2-wall.JPEG`]
    );
  });

  await test("regional bucket host is accepted, a lookalike host is not", () => {
    const ok = photos.parseUploadUrl(
      "https://test-bucket.s3.us-east-1.amazonaws.com/uploads/a/1-x.jpg",
      photos.allowedHosts(STORAGE)
    );
    const bad = photos.parseUploadUrl(
      "https://test-bucket.s3.amazonaws.com.evil.com/uploads/a/1-x.jpg",
      photos.allowedHosts(STORAGE)
    );
    assert.ok(ok);
    assert.strictEqual(bad, null);
  });

  await test("no bucket configured → nothing is a candidate", () => {
    const list = photos.collectCandidates(
      [{ _id: "b1", images: [`${B}/a/1-x.jpg`] }],
      { bucket: "" }
    );
    assert.strictEqual(list.length, 0);
  });

  await test("a re-uploaded original filename is shown once, newest booking wins", () => {
    const list = photos.collectCandidates(
      [
        { _id: "new", images: [`${B}/2026-09-02/booking-2/200-customer-IMG_8031.jpeg`] },
        { _id: "old", images: [`${B}/2026-09-01/booking-1/100-IMG_8031.jpeg`] },
      ],
      STORAGE
    );
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].group, photos.groupId("new"));
  });

  await test("generic phone names like image.jpg are never treated as repeats", () => {
    const list = photos.collectCandidates(
      [
        { _id: "a", images: [`${B}/d/booking-1/1-image.jpg`, `${B}/d/booking-1/2-image.jpg`] },
        { _id: "b", images: [`${B}/d/booking-2/3-unnamed.jpg`, `${B}/d/booking-2/4-image-3.jpg`] },
      ],
      STORAGE
    );
    assert.strictEqual(list.length, 4);
  });

  await test("the same URL on two bookings is one photo", () => {
    const url = `${B}/d/booking-1/1-door.jpg`;
    const list = photos.collectCandidates(
      [{ _id: "a", images: [url] }, { _id: "b", images: [url] }],
      STORAGE
    );
    assert.strictEqual(list.length, 1);
  });

  await test("ids and groups are stable, opaque and carry no booking id", () => {
    const [p] = photos.collectCandidates(
      [{ _id: "65f0c0ffee0000000000abcd", images: [`${B}/d/booking-77/1-tile.jpg`] }],
      STORAGE
    );
    assert.deepStrictEqual(Object.keys(p).sort(), ["group", "id", "url"]);
    assert.ok(/^[0-9a-f]{20}$/.test(p.id));
    assert.ok(/^[0-9a-f]{12}$/.test(p.group));
    assert.ok(!"65f0c0ffee0000000000abcd".includes(p.group));
    assert.strictEqual(p.id, photos.photoId(p.url));
  });

  section("Tonight's shortlist");

  const many = (jobs, perJob) => {
    const list = [];
    for (let j = 0; j < jobs; j += 1) {
      for (let k = 0; k < perJob; k += 1) list.push({ id: `j${j}p${k}`, url: "u", group: `g${j}`, status: "unreviewed" });
    }
    return list;
  };

  await test("the shortlist is capped, one photo per job before any second", () => {
    const picked = photos.shortlist(many(200, 4));
    assert.strictEqual(picked.size, photos.SHORTLIST_SIZE);
    assert.ok([...picked].every((id) => id.endsWith("p0")), "a second photo of a job was taken while new jobs remained");
  });

  await test("newest jobs come first", () => {
    const picked = photos.shortlist(many(200, 1), { limit: 10 });
    assert.deepStrictEqual([...picked], Array.from({ length: 10 }, (_, j) => `j${j}p0`));
  });

  await test("with few jobs, it takes more per job, never more than three", () => {
    const picked = photos.shortlist(many(10, 6));
    assert.strictEqual(picked.size, 30);
  });

  await test("reviewed photos are never shortlisted", () => {
    const list = many(5, 1);
    list[0].status = "approved";
    list[1].status = "hidden";
    const picked = photos.shortlist(list);
    assert.ok(!picked.has("j0p0") && !picked.has("j1p0"));
    assert.strictEqual(picked.size, 3);
  });

  await test("without a decision a photo is unreviewed and not displayable", () => {
    const list = photos.withStatus(
      [{ id: "a", url: "u1", group: "g" }, { id: "b", url: "u2", group: "g" }, { id: "c", url: "u3", group: "g" }],
      [{ photoId: "a", status: "approved" }, { photoId: "b", status: "hidden" }]
    );
    assert.deepStrictEqual(list.map((p) => p.status), ["approved", "hidden", "unreviewed"]);
    assert.deepStrictEqual(photos.displayable(list).map((p) => p.id), ["a"]);
  });
}

/* ---------------- the routes ---------------- */

let app;

async function call(method, path, token, body) {
  const init = { method, headers: {} };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${app.address().port}${path}`, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json, raw: text };
}

async function routeTests() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { dbName: "eventdisplay" });
  await EventDisplayPhoto.init();

  const mk = (n, extra) =>
    User.create({
      userId: `8000000${n}`, name: `Person ${n}`, email: `p${n}@example.com`, password: "h",
      phone: `+1631555000${n}`, address: `${n} Main St`, city: "Huntington", state: "NY", zip: "11743",
      ...extra,
    });
  const admin = await mk(1, { role: "admin" });
  const customer = await mk(2, { role: "customer" });
  const fixter = await mk(3, { role: "employee", employeePosition: "General Fixter", isActive: true });
  const sign = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
  const adminToken = sign(admin);

  const bookingBase = {
    date: new Date("2026-09-20T14:00:00Z"),
    service: "Handyman",
    user: customer._id,
    userId: customer.userId,
    name: "Jane Secretname",
    address: "99 Privacy Lane, Huntington NY",
    phone: "+16315559999",
    email: "jane.secret@example.com",
    subscription: "premium",
    note: "Gate code 4321, dog in yard",
  };
  await Booking.create([
    {
      ...bookingBase,
      bookingNumber: "B-1001",
      images: [`${B}/2026-09-20/booking-B-1001/1-customer-ceiling.jpg`, `${B}/2026-09-20/booking-B-1001/2-ceiling2.jpg`],
    },
    {
      ...bookingBase,
      bookingNumber: "B-1002",
      images: [`${B}/2025-10-20/booking-B-1002/1-old.heic`, `${B}/2026-09-21/booking-B-1002/3-fence.jpg`],
    },
    { ...bookingBase, bookingNumber: "B-1003", images: [] },
    {
      ...bookingBase,
      bookingNumber: "B-1004",
      user: admin._id,
      userId: admin.userId,
      images: [`${B}/2026-09-22/booking-B-1004/1-google-logo-icon.jpg`],
    },
    {
      ...bookingBase,
      bookingNumber: "B-1005",
      user: fixter._id,
      userId: fixter.userId,
      images: [`${B}/2026-09-22/booking-B-1005/1-fixter-test.jpg`],
    },
  ]);

  const expressApp = express();
  expressApp.use(express.json());
  expressApp.use("/api/admin/event-display", require("../routes/adminEventDisplay"));
  app = expressApp.listen(0);

  try {
    section("Who may read the photos");

    await test("no token → 401", async () => {
      assert.strictEqual((await call("GET", "/api/admin/event-display/photos")).status, 401);
    });
    await test("customer → 403", async () => {
      assert.strictEqual((await call("GET", "/api/admin/event-display/photos", sign(customer))).status, 403);
    });
    await test("General Fixter (can read bookings) → still 403", async () => {
      assert.strictEqual(
        (await call("GET", "/api/admin/event-display/photos?scope=review", sign(fixter))).status,
        403
      );
    });
    await test("a Fixter cannot approve photos", async () => {
      const r = await call("PUT", "/api/admin/event-display/photos", sign(fixter), { ids: ["x"], status: "approved" });
      assert.strictEqual(r.status, 403);
    });

    section("What the admin gets");

    let review;
    await test("review lists every candidate as unreviewed, HEIC excluded", async () => {
      review = await call("GET", "/api/admin/event-display/photos?scope=review", adminToken);
      assert.strictEqual(review.status, 200);
      assert.strictEqual(review.body.total, 3);
      assert.deepStrictEqual(review.body.counts, { approved: 0, hidden: 0, unreviewed: 3, shortlist: 3 });
      assert.ok(!review.raw.includes(".heic"));
    });

    await test("photos on staff-owned (test) bookings are not candidates", async () => {
      assert.ok(!review.raw.includes("google-logo-icon"));
      assert.ok(!review.raw.includes("fixter-test"));
    });

    await test("nothing reaches the display before review", async () => {
      const r = await call("GET", "/api/admin/event-display/photos", adminToken);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body.photos, []);
    });

    await test("responses never carry customer or booking details", async () => {
      for (const secret of ["Secretname", "Privacy Lane", "5559999", "jane.secret", "Gate code", String(customer._id), "premium"]) {
        assert.ok(!review.raw.includes(secret), `leaked ${secret}`);
      }
      for (const photo of review.body.photos) {
        assert.deepStrictEqual(Object.keys(photo).sort(), ["group", "id", "shortlisted", "status", "url"]);
      }
    });

    await test("two photos of one job share a group, another job does not", async () => {
      const groups = review.body.photos.map((p) => p.group);
      assert.strictEqual(new Set(groups).size, 2);
    });

    section("Reviewing");

    await test("invalid status → 400", async () => {
      const r = await call("PUT", "/api/admin/event-display/photos", adminToken, { ids: ["a"], status: "public" });
      assert.strictEqual(r.status, 400);
    });
    await test("empty ids → 400", async () => {
      const r = await call("PUT", "/api/admin/event-display/photos", adminToken, { ids: [], status: "approved" });
      assert.strictEqual(r.status, 400);
    });
    await test("ids that are not candidates are refused, nothing stored", async () => {
      const r = await call("PUT", "/api/admin/event-display/photos", adminToken, {
        ids: [photos.photoId("https://evil.example.com/a.jpg")],
        status: "approved",
      });
      assert.strictEqual(r.status, 404);
      assert.strictEqual(await EventDisplayPhoto.countDocuments(), 0);
    });

    await test("approve two, hide one → display shows exactly the approved two", async () => {
      const [a, b, c] = review.body.photos;
      assert.strictEqual(
        (await call("PUT", "/api/admin/event-display/photos", adminToken, { ids: [a.id, b.id], status: "approved" })).body.updated,
        2
      );
      await call("PUT", "/api/admin/event-display/photos", adminToken, { ids: [c.id], status: "hidden" });
      const shown = await call("GET", "/api/admin/event-display/photos?scope=display", adminToken);
      assert.deepStrictEqual(shown.body.photos.map((p) => p.id).sort(), [a.id, b.id].sort());
      for (const photo of shown.body.photos) {
        assert.deepStrictEqual(Object.keys(photo).sort(), ["group", "id", "url"]);
      }
    });

    await test("hiding an approved photo removes it from the display", async () => {
      const [a] = review.body.photos;
      await call("PUT", "/api/admin/event-display/photos", adminToken, { ids: [a.id], status: "hidden" });
      const shown = await call("GET", "/api/admin/event-display/photos", adminToken);
      assert.ok(!shown.body.photos.some((p) => p.id === a.id));
    });

    await test("un-reviewing deletes the decision", async () => {
      const [a] = review.body.photos;
      await call("PUT", "/api/admin/event-display/photos", adminToken, { ids: [a.id], status: "unreviewed" });
      assert.strictEqual(await EventDisplayPhoto.countDocuments({ photoId: a.id }), 0);
    });

    await test("reviewing never touches a booking", async () => {
      const bookings = await Booking.find().sort({ bookingNumber: 1 }).lean();
      assert.strictEqual(bookings[0].images.length, 2);
      assert.strictEqual(bookings[1].images.length, 2);
    });
  } finally {
    app.close();
    await mongoose.disconnect();
    await server.stop();
  }
}

(async () => {
  try {
    await unitTests();
    await routeTests();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
