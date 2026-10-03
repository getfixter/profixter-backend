/**
 * Event display: customer booking photos on a tablet at a public booth.
 *
 * The bugs this feature can have are not crashes. They are a customer's name
 * riding along in the JSON, a Fixter or a customer reading the library, a photo
 * the admin hid coming back on screen, or an old HEIC with GPS in it being
 * shown at all. Since 2026-10-02 every eligible photo plays unless hidden (the
 * owner's explicit choice); these tests pin that down.
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
const sharp = require("sharp");

/* ---- the bucket, in memory: the public kiosk reads images through utils/s3 ---- */
const bucket = new Map();
let s3Reads = 0;
function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub("../utils/s3", {
  async getObjectBuffer({ Key }) {
    s3Reads += 1;
    if (!bucket.has(Key)) {
      const error = new Error("NoSuchKey");
      error.name = "NoSuchKey";
      throw error;
    }
    return bucket.get(Key);
  },
  async putPublicObject() {
    throw new Error("the event display must never upload");
  },
  async putPrivateObject() {
    throw new Error("the event display must never upload");
  },
  async deletePublicObjects() {
    throw new Error("the event display must never delete");
  },
});

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

  await test("without a decision a photo is unreviewed AND displayed; only hidden is not", () => {
    const list = photos.withStatus(
      [{ id: "a", url: "u1", group: "g" }, { id: "b", url: "u2", group: "g" }, { id: "c", url: "u3", group: "g" }],
      [{ photoId: "a", status: "approved" }, { photoId: "b", status: "hidden" }]
    );
    assert.deepStrictEqual(list.map((p) => p.status), ["approved", "hidden", "unreviewed"]);
    assert.deepStrictEqual(photos.displayable(list).map((p) => p.id), ["a", "c"]);
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
  expressApp.use("/api/event-display", require("../routes/eventDisplay"));
  const library = require("../utils/eventDisplayLibrary");

  // Real JPEGs for the three eligible photos, one carrying EXIF with GPS.
  const jpeg = (w, h, withGps) => {
    let img = sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 90, b: 60 } } });
    if (withGps) {
      img = img.withExif({
        IFD0: { Copyright: "Jane Secretname", Make: "TestPhone" },
        GPS: { GPSLatitudeRef: "N", GPSLongitudeRef: "W" },
      });
    }
    return img.jpeg().toBuffer();
  };
  bucket.set("uploads/2026-09-20/booking-B-1001/1-customer-ceiling.jpg", await jpeg(2400, 1800, true));
  bucket.set("uploads/2026-09-20/booking-B-1001/2-ceiling2.jpg", await jpeg(1200, 1600, false));
  bucket.set("uploads/2026-09-21/booking-B-1002/3-fence.jpg", await jpeg(1600, 1200, false));
  // Photos that later tests add to bookings.
  bucket.set("uploads/2026-10-02/booking-B-2001/1-customer-leaking-sink.jpg", await jpeg(1600, 1200, false));
  bucket.set("uploads/2026-10-02/booking-B-3001/1-customer-cracked-tile.jpg", await jpeg(1600, 1200, false));
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
    await test("customer → 403 on the review scope too", async () => {
      assert.strictEqual((await call("GET", "/api/admin/event-display/photos?scope=review", sign(customer))).status, 403);
    });
    await test("a customer cannot hide or restore photos", async () => {
      const r = await call("PUT", "/api/admin/event-display/photos", sign(customer), { ids: ["x"], status: "hidden" });
      assert.strictEqual(r.status, 403);
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
      assert.deepStrictEqual(review.body.counts, { approved: 0, hidden: 0, unreviewed: 3 });
      assert.ok(!review.raw.includes(".heic"));
    });

    await test("photos on staff-owned (test) bookings are not candidates", async () => {
      assert.ok(!review.raw.includes("google-logo-icon"));
      assert.ok(!review.raw.includes("fixter-test"));
    });

    let display;
    await test("every eligible photo is on the display without any review", async () => {
      display = await call("GET", "/api/admin/event-display/photos", adminToken);
      assert.strictEqual(display.status, 200);
      assert.deepStrictEqual(
        display.body.photos.map((p) => p.id).sort(),
        review.body.photos.map((p) => p.id).sort()
      );
      assert.strictEqual(display.body.total, 3);
    });

    await test("the display response carries only id, url and group", async () => {
      for (const photo of display.body.photos) {
        assert.deepStrictEqual(Object.keys(photo).sort(), ["group", "id", "url"]);
      }
      assert.deepStrictEqual(Object.keys(display.body).sort(), ["photos", "total"]);
      for (const secret of ["Secretname", "Privacy Lane", "5559999", "jane.secret", "Gate code", "4321", String(customer._id), "premium", "Huntington", "2026-09-20T"]) {
        assert.ok(!display.raw.includes(secret), `leaked ${secret}`);
      }
    });

    await test("responses never carry customer or booking details", async () => {
      for (const secret of ["Secretname", "Privacy Lane", "5559999", "jane.secret", "Gate code", String(customer._id), "premium"]) {
        assert.ok(!review.raw.includes(secret), `leaked ${secret}`);
      }
      for (const photo of review.body.photos) {
        assert.deepStrictEqual(Object.keys(photo).sort(), ["group", "id", "status", "url"]);
      }
    });

    await test("two photos of one job share a group, another job does not", async () => {
      const groups = review.body.photos.map((p) => p.group);
      assert.strictEqual(new Set(groups).size, 2);
    });

    section("Hiding");

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

    await test("hiding one photo removes exactly that photo from the display", async () => {
      const [a, b, c] = review.body.photos;
      const r = await call("PUT", "/api/admin/event-display/photos", adminToken, { ids: [c.id], status: "hidden" });
      assert.strictEqual(r.body.updated, 1);
      const shown = await call("GET", "/api/admin/event-display/photos?scope=display", adminToken);
      assert.deepStrictEqual(shown.body.photos.map((p) => p.id).sort(), [a.id, b.id].sort());
      const again = await call("GET", "/api/admin/event-display/photos?scope=review", adminToken);
      assert.deepStrictEqual(again.body.counts, { approved: 0, hidden: 1, unreviewed: 2 });
    });

    await test("an approved photo is still displayed, and hiding it removes it", async () => {
      const [a] = review.body.photos;
      await call("PUT", "/api/admin/event-display/photos", adminToken, { ids: [a.id], status: "approved" });
      let shown = await call("GET", "/api/admin/event-display/photos", adminToken);
      assert.ok(shown.body.photos.some((p) => p.id === a.id));
      await call("PUT", "/api/admin/event-display/photos", adminToken, { ids: [a.id], status: "hidden" });
      shown = await call("GET", "/api/admin/event-display/photos", adminToken);
      assert.ok(!shown.body.photos.some((p) => p.id === a.id));
    });

    await test("a hidden photo stays hidden when its job gets new photos", async () => {
      const [, , c] = review.body.photos;
      const extra = `${B}/2026-09-21/booking-B-1002/9-gutter.jpg`;
      await Booking.updateOne({ bookingNumber: "B-1002" }, { $push: { images: extra } });
      const shown = await call("GET", "/api/admin/event-display/photos", adminToken);
      assert.ok(!shown.body.photos.some((p) => p.id === c.id), "the hidden photo came back");
      assert.ok(shown.raw.includes("9-gutter"), "the new photo of that job should join");
      await Booking.updateOne({ bookingNumber: "B-1002" }, { $pull: { images: extra } });
    });

    await test("restoring (unreviewed) deletes the decision and puts the photo back", async () => {
      const [a] = review.body.photos;
      await call("PUT", "/api/admin/event-display/photos", adminToken, { ids: [a.id], status: "unreviewed" });
      assert.strictEqual(await EventDisplayPhoto.countDocuments({ photoId: a.id }), 0);
      const shown = await call("GET", "/api/admin/event-display/photos", adminToken);
      assert.ok(shown.body.photos.some((p) => p.id === a.id));
    });

    section("New bookings");

    await test("a new booking's eligible photos join the display with no approval", async () => {
      const before = await call("GET", "/api/admin/event-display/photos", adminToken);
      await Booking.create({
        ...bookingBase,
        bookingNumber: "B-2001",
        images: [
          `${B}/2026-10-02/booking-B-2001/1-customer-leaking-sink.jpg`,
          `${B}/2026-10-02/booking-B-2001/2-customer-scan.png`,
        ],
      });
      const after = await call("GET", "/api/admin/event-display/photos", adminToken);
      assert.strictEqual(after.body.photos.length, before.body.photos.length + 1, "exactly the new JPEG joins");
      assert.ok(after.raw.includes("leaking-sink"));
      assert.ok(!after.raw.includes("scan.png"), "a non-JPEG must not join");
    });

    await test("a new photo on a staff test booking does not join", async () => {
      const before = await call("GET", "/api/admin/event-display/photos", adminToken);
      await Booking.create({
        ...bookingBase,
        bookingNumber: "B-2002",
        user: admin._id,
        userId: admin.userId,
        images: [`${B}/2026-10-02/booking-B-2002/1-admin-test.jpg`],
      });
      const after = await call("GET", "/api/admin/event-display/photos", adminToken);
      assert.strictEqual(after.body.photos.length, before.body.photos.length);
    });

    await test("hiding and restoring never touch a booking", async () => {
      const bookings = await Booking.find({ bookingNumber: { $in: ["B-1001", "B-1002"] } }).sort({ bookingNumber: 1 }).lean();
      assert.deepStrictEqual(bookings[0].images, [`${B}/2026-09-20/booking-B-1001/1-customer-ceiling.jpg`, `${B}/2026-09-20/booking-B-1001/2-ceiling2.jpg`]);
      assert.deepStrictEqual(bookings[1].images, [`${B}/2025-10-20/booking-B-1002/1-old.heic`, `${B}/2026-09-21/booking-B-1002/3-fence.jpg`]);
    });

    section("Public kiosk: what a visitor can do");

    library.invalidate();
    const feed = await call("GET", "/api/event-display/photos");
    await test("the public feed needs no login and lists every displayable photo", async () => {
      assert.strictEqual(feed.status, 200);
      const adminView = await call("GET", "/api/admin/event-display/photos", adminToken);
      assert.deepStrictEqual(
        feed.body.photos.map((p) => p.id).sort(),
        adminView.body.photos.map((p) => p.id).sort()
      );
      assert.strictEqual(feed.body.total, feed.body.photos.length);
    });

    await test("the public feed carries only opaque ids and groups: no URL, date, booking or person", async () => {
      assert.deepStrictEqual(Object.keys(feed.body).sort(), ["photos", "total"]);
      for (const photo of feed.body.photos) {
        assert.deepStrictEqual(Object.keys(photo).sort(), ["group", "id"]);
        assert.ok(/^[0-9a-f]{20}$/.test(photo.id) && /^[0-9a-f]{12}$/.test(photo.group));
      }
      for (const secret of ["amazonaws", "uploads/", "booking-", "B-100", "2026-09", ".jpg", "Secretname", "Privacy Lane", "5559999", "jane.secret", "Gate code", "premium", String(customer._id), "status"]) {
        assert.ok(!feed.raw.includes(secret), `public feed leaked ${secret}`);
      }
    });

    const shownId = feed.body.photos[0].id;

    await test("a public image is a JPEG with no EXIF, no GPS and no name in it", async () => {
      // Every eligible photo, including the one uploaded with GPS and a name in EXIF.
      for (const { id } of feed.body.photos) {
        const res = await fetch(`http://127.0.0.1:${app.address().port}/api/event-display/photos/${id}/image`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get("content-type"), "image/jpeg");
        const buf = Buffer.from(await res.arrayBuffer());
        const meta = await sharp(buf).metadata();
        assert.strictEqual(meta.format, "jpeg");
        assert.ok(!meta.exif, "EXIF survived");
        assert.ok(Math.max(meta.width, meta.height) <= 1600);
        assert.ok(!buf.includes(Buffer.from("Secretname")), "a name survived in the bytes");
        assert.ok(!buf.includes(Buffer.from("GPS")), "GPS survived in the bytes");
      }
    });

    await test("served images are cached, not re-fetched from S3 every time", async () => {
      const before = s3Reads;
      await fetch(`http://127.0.0.1:${app.address().port}/api/event-display/photos/${shownId}/image`);
      assert.strictEqual(s3Reads, before);
    });

    await test("unknown, malformed and path-like ids are 404, never an S3 read", async () => {
      const before = s3Reads;
      for (const bad of ["0123456789abcdef0123", "nope", "..%2F..%2Fsecret", "uploads%2F2026", photos.photoId("https://evil.example.com/a.jpg")]) {
        const res = await fetch(`http://127.0.0.1:${app.address().port}/api/event-display/photos/${bad}/image`);
        assert.strictEqual(res.status, 404, bad);
      }
      assert.strictEqual(s3Reads, before);
    });

    await test("a photo on a staff test booking is not servable publicly", async () => {
      const staffUrl = `${B}/2026-09-22/booking-B-1004/1-google-logo-icon.jpg`;
      const res = await fetch(`http://127.0.0.1:${app.address().port}/api/event-display/photos/${photos.photoId(staffUrl)}/image`);
      assert.strictEqual(res.status, 404);
    });

    await test("hiding a photo removes it from the public feed and its image at once", async () => {
      const hide = await call("PUT", "/api/admin/event-display/photos", adminToken, { ids: [shownId], status: "hidden" });
      assert.strictEqual(hide.status, 200);
      const after = await call("GET", "/api/event-display/photos");
      assert.ok(!after.body.photos.some((p) => p.id === shownId), "still in the public feed");
      const img = await fetch(`http://127.0.0.1:${app.address().port}/api/event-display/photos/${shownId}/image`);
      assert.strictEqual(img.status, 404, "a cached copy was still served");
      await call("PUT", "/api/admin/event-display/photos", adminToken, { ids: [shownId], status: "unreviewed" });
      const back = await call("GET", "/api/event-display/photos");
      assert.ok(back.body.photos.some((p) => p.id === shownId));
    });

    await test("a new booking's photo reaches the public feed with no approval", async () => {
      const url = `${B}/2026-10-02/booking-B-3001/1-customer-cracked-tile.jpg`;
      await Booking.create({ ...bookingBase, bookingNumber: "B-3001", images: [url] });
      library.invalidate(); // the feed caches for a minute
      const after = await call("GET", "/api/event-display/photos");
      assert.ok(after.body.photos.some((p) => p.id === photos.photoId(url)));
    });

    await test("images never use up the feed's rate limit (the 2026-10-03 outage)", async () => {
      require("../utils/rateLimit")._reset();
      // A kiosk that has shown well over 120 photos from one network...
      for (let i = 0; i < 130; i += 1) {
        const res = await fetch(`http://127.0.0.1:${app.address().port}/api/event-display/photos/${shownId}/image`);
        assert.strictEqual(res.status, 200, `image ${i} answered ${res.status}`);
        await res.arrayBuffer();
      }
      // ...must still be able to load the library on its next start.
      const again = await call("GET", "/api/event-display/photos");
      assert.strictEqual(again.status, 200, `feed answered ${again.status} after 130 images`);
      require("../utils/rateLimit")._reset();
    });

    for (const [who, token] of [["anonymous", null], ["customer", sign(customer)], ["General Fixter", sign(fixter)]]) {
      await test(`${who}: the public routes are read-only and admin routes stay closed`, async () => {
        const review = await call("GET", "/api/admin/event-display/photos?scope=review", token);
        assert.ok([401, 403].includes(review.status), `review ${review.status}`);
        const adminFeed = await call("GET", "/api/admin/event-display/photos", token);
        assert.ok([401, 403].includes(adminFeed.status), `admin feed ${adminFeed.status}`);
        const hide = await call("PUT", "/api/admin/event-display/photos", token, { ids: [shownId], status: "hidden" });
        assert.ok([401, 403].includes(hide.status), `hide ${hide.status}`);
        for (const method of ["PUT", "POST", "DELETE", "PATCH"]) {
          const r = await call(method, "/api/event-display/photos", token, { ids: [shownId], status: "hidden" });
          assert.strictEqual(r.status, 404, `${method} on the public feed answered ${r.status}`);
        }
        const still = await call("GET", "/api/event-display/photos");
        assert.ok(still.body.photos.some((p) => p.id === shownId), "a non-admin changed the display");
      });
    }
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
