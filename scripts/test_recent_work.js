/**
 * Recent Work: the rules that must hold before anybody's kitchen is on a website.
 *
 * Most of this file is about what must NOT happen. A gallery feature's bugs are
 * not crashes, they are a pending submission showing up on the homepage, a
 * street address riding along in a JSON field, or a photo carrying the GPS
 * coordinates of the house it was taken in.
 *
 *   node scripts/test_recent_work.js
 *
 * Not in `npm test`: it boots a MongoDB binary.
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";

const assert = require("assert");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const { MongoMemoryServer } = require("mongodb-memory-server");

/* ---- the bucket, in memory ---- */
const bucket = new Map();
let s3ShouldFail = false;

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stub("../utils/s3", {
  async putPublicObject({ Key, Body, ContentType }) {
    if (s3ShouldFail) throw new Error("S3 unavailable");
    bucket.set(Key, { body: Body, contentType: ContentType });
    return `https://test-bucket.s3.amazonaws.com/${Key}`;
  },
  async putPrivateObject() {
    return {};
  },
  async deletePublicObjects({ Keys = [] }) {
    if (s3ShouldFail) throw new Error("S3 unavailable");
    let deleted = 0;
    for (const key of Keys) if (bucket.delete(key)) deleted += 1;
    return { deleted };
  },
  async getObjectBuffer() {
    return Buffer.alloc(0);
  },
});

const WorkPhoto = require("../models/WorkPhoto");
const User = require("../models/User");
const service = require("../utils/recentWork/workPhotoService");
const { STATUS, UPLOADER_TYPE, FIXTER_PUBLISH_DELAY_MS } = require("../utils/recentWork/workPhotoStates");
const { runRecentWorkCycle } = require("../jobs/recentWorkPublisher");

let passed = 0;
const failures = [];

async function test(name, fn) {
  bucket.clear();
  s3ShouldFail = false;
  await WorkPhoto.deleteMany({});
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

/* ---- fixtures ---- */

/** A real JPEG carrying EXIF, including the location it was "taken". */
async function photoWithGps() {
  return sharp({
    create: { width: 1200, height: 900, channels: 3, background: { r: 90, g: 140, b: 200 } },
  })
    .withExif({
      IFD0: { Copyright: "Test Customer", Make: "TestPhone", Model: "TestPhone 15" },
      GPS: { GPSLatitudeRef: "N", GPSLongitudeRef: "W" },
    })
    .jpeg()
    .toBuffer();
}

async function plainPhoto(width = 900, height = 600) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 120, b: 60 } },
  })
    .jpeg()
    .toBuffer();
}

let app;
let adminToken;
let customerToken;
let memberToken;
let fixterToken;
let adminUser;
let memberUser;
let plainCustomer;
let fixterUser;

const api = (method, path, token) => {
  const url = `http://127.0.0.1:${app.address().port}${path}`;
  return { url, method, headers: token ? { Authorization: `Bearer ${token}` } : {} };
};

async function call(method, path, token, body) {
  const { url, headers } = api(method, path, token);
  const init = { method, headers: { ...headers } };
  if (body) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function uploadAs(token, files, fields = {}, path = "/api/admin/recent-work") {
  const form = new FormData();
  for (const [index, buffer] of files.entries()) {
    form.append("photos", new Blob([buffer], { type: "image/jpeg" }), `photo-${index}.jpg`);
  }
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));

  const { url } = api("POST", path, token);
  const res = await fetch(url, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** Create a photo straight through the service, bypassing HTTP. */
async function seed(uploaderType, overrides = {}, publishNow = false) {
  const buffer = await plainPhoto();
  return service.createFromBuffer({
    buffer,
    uploader: { uploaderType, role: uploaderType },
    actor: { userId: adminUser._id, name: "Seeder" },
    fields: { publishNow, ...overrides },
  });
}

/**
 * A row as it looked before Fixter uploads became reviewable.
 *
 * No upload path produces SCHEDULED any more, but rows written by the old
 * behaviour still exist and the worker still has to promote them correctly.
 * Built directly so that coverage survives the policy change.
 */
async function makeLegacyScheduled() {
  const photo = await seed(UPLOADER_TYPE.FIXTER);
  await WorkPhoto.updateOne(
    { _id: photo._id },
    { $set: { status: STATUS.SCHEDULED, publishAt: new Date(Date.now() + FIXTER_PUBLISH_DELAY_MS) } }
  );
  return WorkPhoto.findById(photo._id).lean();
}

async function run() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { dbName: "recentwork" });
  await WorkPhoto.init();

  adminUser = await User.create({
    userId: "70000001", name: "Taras", email: "admin@example.com", password: "h",
    phone: "+16315550001", role: "admin", address: "1 Main St", city: "Huntington",
    state: "NY", zip: "11743",
  });
  plainCustomer = await User.create({
    userId: "70000002", name: "No Plan", email: "noplan@example.com", password: "h",
    phone: "+16315550002", role: "customer", address: "2 Main St", city: "Huntington",
    state: "NY", zip: "11743",
  });
  memberUser = await User.create({
    userId: "70000003", name: "Member Person", email: "member@example.com", password: "h",
    phone: "+16315550003", role: "customer", address: "3 Main St", city: "Huntington",
    state: "NY", zip: "11743",
  });
  fixterUser = await User.create({
    userId: "70000004", name: "Roman Hecha", email: "fixter@example.com", password: "h",
    phone: "+16315550004", role: "employee", employeePosition: "Fixter", isActive: true,
    address: "4 Main St", city: "Huntington", state: "NY", zip: "11743",
  });

  const sign = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
  adminToken = sign(adminUser);
  customerToken = sign(plainCustomer);
  memberToken = sign(memberUser);
  fixterToken = sign(fixterUser);

  /*
   * Membership is asked of routes/auth's coverage builder. Stubbing that one
   * function keeps this suite about photo rules rather than about Stripe, while
   * still exercising the real call path the route takes.
   */
  const authRoutes = require("../routes/auth");
  const realCoverage = authRoutes.buildPerAddressCoverage;
  authRoutes.buildPerAddressCoverage = async (user) =>
    String(user?._id) === String(memberUser._id)
      ? { addr1: { active: true, plan: "premium", source: "subscription" } }
      : {};
  assert.equal(typeof realCoverage, "function", "routes/auth must export buildPerAddressCoverage");

  const expressApp = express();
  expressApp.use(express.json());
  expressApp.use("/api/recent-work", require("../routes/recentWork"));
  expressApp.use("/api/admin/recent-work", require("../routes/adminRecentWork"));
  app = expressApp.listen(0);

  try {
    /* ============================================================ */
    section("Admin upload");

    await test("admin upload lands in the Library by default", async () => {
      const res = await uploadAs(adminToken, [await plainPhoto()], { title: "New deck" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.created.length, 1);
      assert.equal(res.body.created[0].status, STATUS.LIBRARY);
      const pub = await call("GET", "/api/recent-work");
      assert.equal(pub.body.photos.length, 0, "library-only must not be public");
    });

    await test("admin can publish immediately at upload time", async () => {
      const res = await uploadAs(adminToken, [await plainPhoto()], {
        title: "Kitchen refit",
        category: "kitchen-remodeling",
        publishNow: "true",
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.created[0].status, STATUS.PUBLISHED);
      const pub = await call("GET", "/api/recent-work");
      assert.equal(pub.body.photos.length, 1);
      assert.equal(pub.body.photos[0].title, "Kitchen refit");
    });

    await test("one upload produces three sized variants", async () => {
      const res = await uploadAs(adminToken, [await plainPhoto(3000, 2000)]);
      assert.equal(res.status, 201);
      const doc = await WorkPhoto.findOne({}).lean();
      assert.ok(doc.thumb.key && doc.display.key && doc.full.key, "three keys");
      assert.equal(bucket.size, 3, "three objects stored");
      assert.ok(doc.thumb.width <= 480, `thumb ${doc.thumb.width}`);
      assert.ok(doc.display.width <= 1280, `display ${doc.display.width}`);
      assert.ok(doc.full.width <= 2000, `full ${doc.full.width}`);
      assert.ok(doc.thumb.bytes < doc.full.bytes, "thumb must be the smallest");
    });

    await test("a multi-photo batch shares one batchId", async () => {
      const res = await uploadAs(
        adminToken,
        [await plainPhoto(), await plainPhoto(800, 800), await plainPhoto(1200, 400)],
        { title: "Bathroom day", publishNow: "true" }
      );
      assert.equal(res.body.created.length, 3);
      const ids = new Set(res.body.created.map((p) => p.batchId));
      assert.equal(ids.size, 1, "one batch");
    });

    await test("a corrupt file fails alone, the good ones still land", async () => {
      const res = await uploadAs(adminToken, [
        await plainPhoto(),
        Buffer.from("<?php echo 'not a photo'; ?>"),
        await plainPhoto(),
      ]);
      assert.equal(res.status, 201);
      assert.equal(res.body.created.length, 2, "the two real photos");
      assert.equal(res.body.failed.length, 1, "the impostor is named");
      assert.equal(bucket.size, 6, "no objects left behind for the failure");
    });

    /* ============================================================ */
    section("Privacy of the public feed");

    await test("the public DTO carries no private field, ever", async () => {
      await seed(UPLOADER_TYPE.ADMIN, {
        title: "Deck rebuild",
        caption: "Replaced six boards",
        bookingNumber: "20000123",
        internalNote: "Customer was difficult",
        publicLocation: "Huntington",
        customerUserId: memberUser._id,
        bookingId: new mongoose.Types.ObjectId(),
      }, true);

      const res = await call("GET", "/api/recent-work");
      assert.equal(res.body.photos.length, 1);
      const dto = res.body.photos[0];

      /* No publishedAt, and no other timestamp: the public shape carries no date. */
      const allowed = [
        "id", "title", "caption", "category", "location", "featured",
        "thumbUrl", "imageUrl", "fullUrl", "width", "height",
      ].sort();
      assert.deepEqual(Object.keys(dto).sort(), allowed, "exact public key set");

      const serialized = JSON.stringify(res.body);
      for (const forbidden of [
        "20000123", "Customer was difficult", "member@example.com",
        "Member Person", "bookingId", "customerUserId", "uploadedBy",
        "internalNote", "uploaderType", "+1631",
      ]) {
        assert.ok(!serialized.includes(forbidden), `public payload leaked "${forbidden}"`);
      }
    });

    await test("member submissions awaiting review are not public", async () => {
      const photo = await seed(UPLOADER_TYPE.MEMBER, { title: "My new sink" });
      assert.equal(photo.status, STATUS.PENDING_REVIEW);
      const res = await call("GET", "/api/recent-work");
      assert.equal(res.body.photos.length, 0);
      assert.equal(res.body.total, 0);
    });

    await test("rejected submissions are not public", async () => {
      const photo = await seed(UPLOADER_TYPE.MEMBER);
      await service.reject(photo._id, { name: "Taras" }, "Blurry");
      const res = await call("GET", "/api/recent-work");
      assert.equal(res.body.photos.length, 0);
    });

    await test("unpublished photos are not public but are retained", async () => {
      const photo = await seed(UPLOADER_TYPE.ADMIN, { title: "Was live" }, true);
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 1);

      await service.unpublish(photo._id, { name: "Taras" });
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 0);

      const still = await WorkPhoto.findById(photo._id).lean();
      assert.equal(still.status, STATUS.LIBRARY, "kept in the library");
      assert.ok(still.firstPublishedAt, "history of having been live is kept");
      assert.equal(bucket.size, 3, "unpublish must not remove the images");
    });

    await test("A FIXTER UPLOAD NEVER PUBLISHES ITSELF", async () => {
      /*
       * This used to assert the opposite: a Fixter upload went SCHEDULED and
       * the worker put it on the website five minutes later, with the delay
       * acting as an undo window rather than a review.
       *
       * A Fixter is a contributor now, not a publisher. A photo taken inside
       * a customer's home is exactly the thing that needs a person to look
       * before the world does, and being trusted to do the work is not the
       * same as being the last check on what the company publishes.
       */
      const photo = await seed(UPLOADER_TYPE.FIXTER, { title: "Finished job" });
      assert.equal(photo.status, STATUS.PENDING_REVIEW);
      assert.equal(photo.publishAt, null, "there is no countdown to render");
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 0);

      /* Long past any old delay, and the worker still must not touch it. */
      await runRecentWorkCycle(new Date(Date.now() + FIXTER_PUBLISH_DELAY_MS * 10));
      assert.equal(
        (await WorkPhoto.findById(photo._id).lean()).status,
        STATUS.PENDING_REVIEW,
        "no clock may promote a contributor's photo"
      );
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 0);
    });

    await test("a category filter cannot be used to reach unpublished work", async () => {
      await seed(UPLOADER_TYPE.MEMBER, { category: "kitchen-remodeling" });
      const res = await call("GET", "/api/recent-work?category=kitchen-remodeling");
      assert.equal(res.body.photos.length, 0);
      const bogus = await call("GET", "/api/recent-work?category=../../etc&limit=9999");
      assert.equal(bogus.status, 200);
      assert.ok(bogus.body.limit <= 60, "page size is capped");
    });

    /* ============================================================ */
    section("The scheduled-publish worker (legacy rows only)");

    await test("the worker publishes a legacy scheduled row when its time passes", async () => {
      /*
       * Nothing creates SCHEDULED any longer - a Fixter upload now waits for a
       * person. The worker is kept because rows written under the old rule may
       * still be carrying a publishAt, and a promotion path that silently
       * stopped working would strand them forever.
       */
      const legacy = await makeLegacyScheduled();
      const photo = { _id: legacy._id };
      const after = new Date(Date.now() + FIXTER_PUBLISH_DELAY_MS + 1000);

      const result = await runRecentWorkCycle(after);
      assert.equal(result.published, 1);

      const reloaded = await WorkPhoto.findById(photo._id).lean();
      assert.equal(reloaded.status, STATUS.PUBLISHED);
      assert.ok(reloaded.publishedAt, "publishedAt recorded");
      assert.ok(reloaded.firstPublishedAt, "firstPublishedAt recorded");
      assert.equal(reloaded.publishAt, null, "the schedule is spent");
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 1);
    });

    await test("overlapping workers publish a legacy scheduled row exactly once", async () => {
      /*
       * SCHEDULED is no longer produced by any upload, but rows written
       * before Fixter uploads became reviewable still carry it, so the
       * worker's duplicate-safety is still worth proving. Built by hand for
       * that reason rather than through a submission.
       */
      await makeLegacyScheduled();
      await makeLegacyScheduled();
      const after = new Date(Date.now() + FIXTER_PUBLISH_DELAY_MS + 1000);

      const results = await Promise.all([
        runRecentWorkCycle(after),
        runRecentWorkCycle(after),
        runRecentWorkCycle(after),
      ]);
      const total = results.reduce((sum, r) => sum + r.published, 0);
      assert.equal(total, 2, `two photos, ${total} publications`);
      assert.equal((await call("GET", "/api/recent-work")).body.total, 2);
    });

    await test("a deleted submission stays deleted when the worker runs", async () => {
      const photo = await seed(UPLOADER_TYPE.FIXTER);
      await service.remove(photo._id, { name: "Roman Hecha" });

      await runRecentWorkCycle(new Date(Date.now() + FIXTER_PUBLISH_DELAY_MS + 1000));
      const reloaded = await WorkPhoto.findById(photo._id).lean();
      assert.equal(reloaded.status, STATUS.ARCHIVED);
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 0);
    });

    await test("an admin can send a submission to the Library instead", async () => {
      const photo = await seed(UPLOADER_TYPE.FIXTER);
      await service.unpublish(photo._id, { name: "Taras" });
      await runRecentWorkCycle(new Date(Date.now() + FIXTER_PUBLISH_DELAY_MS + 1000));
      const reloaded = await WorkPhoto.findById(photo._id).lean();
      assert.equal(reloaded.status, STATUS.LIBRARY, "and no worker resurrects it");
    });

    /* ============================================================ */
    section("Who may upload");

    await test("a customer with no membership is refused", async () => {
      const res = await uploadAs(
        customerToken, [await plainPhoto()], {}, "/api/recent-work/submissions"
      );
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.match(res.body.message, /active membership/i);
      assert.equal(await WorkPhoto.countDocuments({}), 0, "nothing was stored");
      assert.equal(bucket.size, 0, "and nothing reached the bucket");
    });

    await test("an active member's submission waits for approval", async () => {
      const res = await uploadAs(
        memberToken, [await plainPhoto()], { caption: "Love it" }, "/api/recent-work/submissions"
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.created[0].status, STATUS.PENDING_REVIEW);
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 0);
    });

    await test("a Fixter's submission waits for approval, like a member's", async () => {
      const res = await uploadAs(
        fixterToken, [await plainPhoto()], {}, "/api/recent-work/submissions"
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.created[0].status, STATUS.PENDING_REVIEW);
      assert.equal(res.body.created[0].publishAt, null);
      assert.equal(
        (await call("GET", "/api/recent-work")).body.photos.length,
        0,
        "and it is not on the public gallery"
      );
    });

    await test("an anonymous submission is refused", async () => {
      const res = await uploadAs(null, [await plainPhoto()], {}, "/api/recent-work/submissions");
      assert.equal(res.status, 401);
    });

    /* ============================================================ */
    section("Admin-only endpoints");

    await test("a customer cannot read the admin gallery", async () => {
      const res = await call("GET", "/api/admin/recent-work", customerToken);
      assert.equal(res.status, 403);
    });

    await test("a Fixter cannot moderate", async () => {
      const photo = await seed(UPLOADER_TYPE.MEMBER);
      const res = await call("POST", `/api/admin/recent-work/${photo._id}/publish`, fixterToken);
      assert.equal(res.status, 403);
      assert.equal((await WorkPhoto.findById(photo._id)).status, STATUS.PENDING_REVIEW);
    });

    await test("an unauthenticated caller cannot upload or delete", async () => {
      const photo = await seed(UPLOADER_TYPE.ADMIN);
      assert.equal((await call("GET", "/api/admin/recent-work")).status, 401);
      assert.equal((await call("DELETE", `/api/admin/recent-work/${photo._id}`)).status, 401);
      assert.equal((await uploadAs(null, [await plainPhoto()])).status, 401);
    });

    await test("a member cannot publish their own submission", async () => {
      const res = await uploadAs(
        memberToken, [await plainPhoto()], {}, "/api/recent-work/submissions"
      );
      const id = res.body.created[0].id;
      const attempt = await call("POST", `/api/admin/recent-work/${id}/publish`, memberToken);
      assert.equal(attempt.status, 403);
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 0);
    });

    /* ============================================================ */
    section("Hostile input");

    await test("a script renamed as a photo is refused", async () => {
      const res = await uploadAs(adminToken, [Buffer.from("#!/bin/sh\nrm -rf /\n")]);
      assert.equal(res.status, 400);
      assert.equal(res.body.created.length, 0);
      assert.equal(bucket.size, 0);
    });

    await test("an empty file is refused", async () => {
      const res = await uploadAs(adminToken, [Buffer.alloc(0)]);
      assert.equal(res.body.created.length, 0);
    });

    await test("the storage key owes nothing to the filename", async () => {
      const form = new FormData();
      form.append(
        "photos",
        new Blob([await plainPhoto()], { type: "image/jpeg" }),
        "../../../../etc/passwd.jpg"
      );
      const { url } = api("POST", "/api/admin/recent-work", adminToken);
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
        body: form,
      });
      assert.equal(res.status, 201);
      const doc = await WorkPhoto.findOne({}).lean();
      assert.ok(!doc.full.key.includes(".."), `traversal survived: ${doc.full.key}`);
      assert.ok(!doc.full.key.includes("passwd"), "the filename is not reused at all");
      assert.match(doc.full.key, /^recent-work\/\d{4}\/\d{2}\/[0-9a-f-]{36}\/full\.jpg$/);
    });

    await test("EXIF, including location, does not survive the pipeline", async () => {
      const source = await photoWithGps();
      const before = await sharp(source).metadata();
      assert.ok(before.exif, "the fixture must actually carry EXIF");

      await uploadAs(adminToken, [source], { publishNow: "true" });
      assert.equal(bucket.size, 3);

      for (const [key, object] of bucket.entries()) {
        const meta = await sharp(object.body).metadata();
        assert.equal(meta.exif, undefined, `${key} still carries EXIF`);
        assert.equal(meta.format, "jpeg", `${key} was not re-encoded`);
        const asText = object.body.toString("latin1");
        assert.ok(!asText.includes("TestPhone"), `${key} leaked the camera model`);
        assert.ok(!asText.includes("Test Customer"), `${key} leaked the copyright name`);
      }
    });

    await test("orientation is applied rather than merely described", async () => {
      const rotated = await sharp({
        create: { width: 1000, height: 500, channels: 3, background: { r: 10, g: 10, b: 10 } },
      })
        .withExif({ IFD0: { Orientation: "6" } })
        .jpeg()
        .toBuffer();

      await uploadAs(adminToken, [rotated]);
      const doc = await WorkPhoto.findOne({}).lean();
      assert.ok(doc.full.width > 0 && doc.full.height > 0, "dimensions recorded");
      const stored = await sharp(bucket.get(doc.full.key).body).metadata();
      assert.equal(stored.orientation, undefined, "no orientation tag left to misread");
    });

    /* ============================================================ */
    section("Moderation and races");

    await test("approving a member photo publishes it", async () => {
      const photo = await seed(UPLOADER_TYPE.MEMBER, { title: "Their kitchen" });
      const res = await call("POST", `/api/admin/recent-work/${photo._id}/publish`, adminToken);
      assert.equal(res.status, 200);
      assert.equal(res.body.photo.status, STATUS.PUBLISHED);
      assert.equal(res.body.photo.reviewedByName, "Taras", "who approved it is recorded");
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 1);
    });

    await test("rejecting records the reason and never publishes", async () => {
      const photo = await seed(UPLOADER_TYPE.MEMBER);
      const res = await call(
        "POST", `/api/admin/recent-work/${photo._id}/reject`, adminToken, { reason: "Too blurry" }
      );
      assert.equal(res.body.photo.status, STATUS.REJECTED);
      assert.equal(res.body.photo.rejectionReason, "Too blurry");
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 0);
    });

    await test("double-tapping Publish writes once", async () => {
      const photo = await seed(UPLOADER_TYPE.ADMIN);
      const [a, b, c] = await Promise.all([
        call("POST", `/api/admin/recent-work/${photo._id}/publish`, adminToken),
        call("POST", `/api/admin/recent-work/${photo._id}/publish`, adminToken),
        call("POST", `/api/admin/recent-work/${photo._id}/publish`, adminToken),
      ]);
      const statuses = [a.status, b.status, c.status];
      assert.ok(statuses.every((s) => s === 200 || s === 409), `unexpected: ${statuses}`);
      const reloaded = await WorkPhoto.findById(photo._id).lean();
      assert.equal(reloaded.status, STATUS.PUBLISHED);
      assert.equal((await call("GET", "/api/recent-work")).body.total, 1);
    });

    await test("publish then unpublish then publish keeps one history", async () => {
      const photo = await seed(UPLOADER_TYPE.ADMIN, {}, true);
      const first = (await WorkPhoto.findById(photo._id).lean()).firstPublishedAt;
      await call("POST", `/api/admin/recent-work/${photo._id}/unpublish`, adminToken);
      await call("POST", `/api/admin/recent-work/${photo._id}/publish`, adminToken);
      const reloaded = await WorkPhoto.findById(photo._id).lean();
      assert.equal(
        new Date(reloaded.firstPublishedAt).getTime(),
        new Date(first).getTime(),
        "firstPublishedAt is history and must not move"
      );
    });

    await test("an archived photo cannot be brought back", async () => {
      const photo = await seed(UPLOADER_TYPE.ADMIN, {}, true);
      await call("DELETE", `/api/admin/recent-work/${photo._id}`, adminToken);
      const res = await call("POST", `/api/admin/recent-work/${photo._id}/publish`, adminToken);
      assert.equal(res.status, 409);
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 0);
    });

    /* ============================================================ */
    section("Deletion and storage");

    await test("delete removes the photo and its objects", async () => {
      const photo = await seed(UPLOADER_TYPE.ADMIN, {}, true);
      assert.equal(bucket.size, 3);

      const res = await call("DELETE", `/api/admin/recent-work/${photo._id}`, adminToken);
      assert.equal(res.status, 200);
      assert.equal(res.body.storagePurged, true);
      assert.equal(bucket.size, 0, "the bytes are gone");

      const tombstone = await WorkPhoto.findById(photo._id).lean();
      assert.equal(tombstone.status, STATUS.ARCHIVED);
      assert.ok(tombstone.deletedAt && tombstone.storagePurgedAt);
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 0);
    });

    await test("a storage failure during delete is retried, not forgotten", async () => {
      const photo = await seed(UPLOADER_TYPE.ADMIN, {}, true);
      s3ShouldFail = true;
      const res = await call("DELETE", `/api/admin/recent-work/${photo._id}`, adminToken);
      assert.equal(res.status, 200);
      assert.equal(res.body.storagePurged, false, "the API must not claim a purge that failed");
      assert.equal(bucket.size, 3, "objects are still there");

      const mid = await WorkPhoto.findById(photo._id).lean();
      assert.equal(mid.status, STATUS.ARCHIVED, "gone from every view regardless");
      assert.equal(mid.storagePurgedAt, null);
      assert.ok(mid.storagePurgeError);

      s3ShouldFail = false;
      await runRecentWorkCycle(new Date());
      assert.equal(bucket.size, 0, "the sweep collected it");
      assert.ok((await WorkPhoto.findById(photo._id).lean()).storagePurgedAt);
    });

    await test("a database failure after upload does not orphan objects", async () => {
      const original = WorkPhoto.create;
      WorkPhoto.create = async () => {
        throw new Error("simulated write failure");
      };
      try {
        await assert.rejects(() => seed(UPLOADER_TYPE.ADMIN), /simulated write failure/);
      } finally {
        WorkPhoto.create = original;
      }
      assert.equal(bucket.size, 0, "the uploaded variants were taken back");
    });

    /* ============================================================ */
    section("Existing booking photos");

    await test("nothing imports booking photos on its own", async () => {
      const Booking = require("../models/Booking");
      await Booking.create({
        bookingNumber: "29999999",
        userId: "70000002",
        user: plainCustomer._id,
        name: "No Plan",
        email: "noplan@example.com",
        phone: "+16315550002",
        address: "2 Main St", city: "Huntington", state: "NY", zip: "11743",
        service: "Drywall repair",
        subscription: "none",
        date: new Date(),
        status: "Completed",
        images: ["https://test-bucket.s3.amazonaws.com/uploads/2026-01-01/booking-29999999/a.jpg"],
      });

      await runRecentWorkCycle(new Date());
      assert.equal(await WorkPhoto.countDocuments({}), 0, "booking photos stay where they are");
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 0);
      await Booking.deleteMany({});
    });

    /* ============================================================ */
    section("The whole lifecycle, one photo, in order");

    await test("upload -> publish -> public -> unpublish -> republish -> delete -> purge", async () => {
      const steps = [];
      const publicCount = async () => (await call("GET", "/api/recent-work")).body.photos.length;
      const row = async (id) => WorkPhoto.findById(id).lean();

      /* --- UPLOAD (library only, so publishing is its own observable step) --- */
      const uploaded = await uploadAs(adminToken, [await photoWithGps()], {
        title: "Lifecycle photo",
        category: "kitchen-remodeling",
        publicLocation: "Babylon, NY",
      });
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
      const id = uploaded.body.created[0].id;
      steps.push("uploaded");

      /* --- PROCESS + STORE: three variants, EXIF gone --- */
      const stored = await row(id);
      assert.equal(bucket.size, 3, "three objects");
      for (const variant of ["thumb", "display", "full"]) {
        const object = bucket.get(stored[variant].key);
        assert.ok(object, `${variant} missing from storage`);
        const meta = await sharp(object.body).metadata();
        assert.equal(meta.format, "jpeg");
        assert.equal(meta.exif, undefined, `${variant} kept EXIF`);
      }
      assert.ok(stored.thumb.width <= 480 && stored.display.width <= 1280 && stored.full.width <= 2000);
      steps.push("processed+stored");

      /* --- ADMIN PREVIEW: the admin list shows it with a thumbnail --- */
      const library = await call("GET", "/api/admin/recent-work?view=library", adminToken);
      const inLibrary = library.body.photos.find((p) => p.id === id);
      assert.ok(inLibrary, "not in the admin library");
      assert.ok(inLibrary.thumbUrl, "no thumbnail for the admin to look at");
      assert.equal(inLibrary.status, STATUS.LIBRARY);
      assert.equal(await publicCount(), 0, "library-only must not be public");
      steps.push("admin-preview");

      /* --- PUBLISH --- */
      const published = await call("POST", `/api/admin/recent-work/${id}/publish`, adminToken);
      assert.equal(published.status, 200);
      assert.equal(published.body.photo.status, STATUS.PUBLISHED);
      steps.push("published");

      /* --- PUBLIC API: present, and wearing only public clothes --- */
      const feed = await call("GET", "/api/recent-work");
      assert.equal(feed.body.photos.length, 1);
      const dto = feed.body.photos[0];
      assert.equal(dto.id, id);
      assert.equal(dto.title, "Lifecycle photo");
      assert.equal(dto.location, "Babylon, NY");
      assert.deepEqual(
        Object.keys(dto).sort(),
        ["caption", "category", "featured", "fullUrl", "height", "id", "imageUrl",
         "location", "thumbUrl", "title", "width"].sort()
      );
      /* Every URL the public is handed must resolve to a real stored object. */
      for (const url of [dto.thumbUrl, dto.imageUrl, dto.fullUrl]) {
        const key = url.split(".amazonaws.com/")[1];
        assert.ok(bucket.has(key), `public URL points at nothing: ${url}`);
        assert.match(key, /^recent-work\//, "public URL must live under the owned prefix");
      }
      steps.push("public-api");

      /* --- UNPUBLISH: gone publicly, kept entirely --- */
      const unpublished = await call("POST", `/api/admin/recent-work/${id}/unpublish`, adminToken);
      assert.equal(unpublished.status, 200);
      assert.equal(await publicCount(), 0, "still public after unpublish");
      const kept = await row(id);
      assert.equal(kept.status, STATUS.LIBRARY);
      assert.ok(kept.firstPublishedAt, "history of having been live is kept");
      assert.equal(bucket.size, 3, "unpublish must not delete the images");
      const stillInLibrary = await call("GET", "/api/admin/recent-work?view=library", adminToken);
      assert.ok(stillInLibrary.body.photos.some((p) => p.id === id), "vanished from the library");
      steps.push("unpublished");

      /* --- REPUBLISH --- */
      await call("POST", `/api/admin/recent-work/${id}/publish`, adminToken);
      assert.equal(await publicCount(), 1, "did not come back");
      const republished = await row(id);
      assert.equal(
        new Date(republished.firstPublishedAt).getTime(),
        new Date(kept.firstPublishedAt).getTime(),
        "firstPublishedAt is history and must not move"
      );
      steps.push("republished");

      /* --- DELETE --- */
      const deleted = await call("DELETE", `/api/admin/recent-work/${id}`, adminToken);
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body.storagePurged, true);
      steps.push("deleted");

      /* --- VERIFY PUBLIC REMOVAL + S3 CLEANUP --- */
      assert.equal(await publicCount(), 0, "still public after delete");
      assert.equal(bucket.size, 0, "the image files are still in storage");
      const tombstone = await row(id);
      assert.equal(tombstone.status, STATUS.ARCHIVED);
      assert.ok(tombstone.deletedAt && tombstone.storagePurgedAt);
      assert.equal(tombstone.deletedByName, "Taras", "who deleted it is recorded");
      const gone = await call("GET", "/api/admin/recent-work?view=library", adminToken);
      assert.ok(!gone.body.photos.some((p) => p.id === id), "still listed after delete");
      steps.push("purged");

      assert.equal(
        steps.join(" -> "),
        "uploaded -> processed+stored -> admin-preview -> published -> public-api -> " +
        "unpublished -> republished -> deleted -> purged"
      );
    });

    await test("several photos at once survive the same walk", async () => {
      const upload = await uploadAs(
        adminToken,
        [await plainPhoto(1600, 1200), await plainPhoto(900, 1600), await plainPhoto(1000, 1000)],
        { title: "Bathroom day", category: "bathroom-remodeling", publishNow: "true" }
      );
      assert.equal(upload.body.created.length, 3);
      assert.equal(bucket.size, 9, "three photos, three variants each");
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 3);

      /* Mixed orientations must all survive with sane dimensions. */
      for (const photo of (await call("GET", "/api/recent-work")).body.photos) {
        assert.ok(photo.width > 0 && photo.height > 0, "public DTO needs dimensions for layout");
        assert.ok(photo.width <= 1280, `display too large: ${photo.width}`);
      }

      for (const photo of upload.body.created) {
        await call("DELETE", `/api/admin/recent-work/${photo.id}`, adminToken);
      }
      assert.equal(bucket.size, 0, "every object cleaned up");
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 0);
    });

    /* ============================================================ */
    section("Adversarial: the client does not get a vote");

    await test("a member cannot declare themselves a Fixter", async () => {
      const res = await uploadAs(
        memberToken,
        [await plainPhoto()],
        { uploaderType: "fixter", role: "fixter", accessRole: "admin" },
        "/api/recent-work/submissions"
      );
      assert.equal(res.status, 201);
      assert.equal(res.body.created[0].status, STATUS.PENDING_REVIEW, "still a member submission");
      const doc = await WorkPhoto.findOne({}).lean();
      assert.equal(doc.uploaderType, UPLOADER_TYPE.MEMBER, "the server decided, not the form");
    });

    await test("a Fixter cannot force an immediate publish", async () => {
      const res = await uploadAs(
        fixterToken,
        [await plainPhoto()],
        { publishNow: "true", status: "published" },
        "/api/recent-work/submissions"
      );
      assert.equal(res.status, 201);
      assert.equal(
        res.body.created[0].status,
        STATUS.PENDING_REVIEW,
        "review is not optional"
      );
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 0);
    });

    await test("a member cannot post status=published", async () => {
      const res = await uploadAs(
        memberToken,
        [await plainPhoto()],
        { status: "published", featured: "true" },
        "/api/recent-work/submissions"
      );
      assert.equal(res.body.created[0].status, STATUS.PENDING_REVIEW);
      const doc = await WorkPhoto.findOne({}).lean();
      assert.equal(doc.featured, false, "featured is not a field an uploader sets");
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 0);
    });

    await test("a client-supplied publishAt is ignored", async () => {
      const past = new Date(Date.now() - 86400000).toISOString();
      await uploadAs(
        fixterToken,
        [await plainPhoto()],
        { publishAt: past, publishAt2: past },
        "/api/recent-work/submissions"
      );
      const doc = await WorkPhoto.findOne({}).lean();
      /*
       * Stronger than it used to be. A backdated publishAt was previously
       * refused by being overwritten with the real countdown; now there is no
       * countdown to overwrite, so the field the worker reads is simply never
       * populated and there is nothing for a client to aim at.
       */
      assert.equal(doc.publishAt, null, "publishAt was steered");

      /* And the worker must not treat it as due. */
      await runRecentWorkCycle(new Date());
      assert.equal((await WorkPhoto.findById(doc._id).lean()).status, STATUS.PENDING_REVIEW);
    });

    await test("an admin cannot be impersonated through the submission route", async () => {
      /* The admin's own token on the members' door still gets admin treatment,
         but a member's token never does, whatever the body says. */
      const res = await uploadAs(
        memberToken,
        [await plainPhoto()],
        { adminOverride: "true", accessRole: "admin", permissions: "admin.all" },
        "/api/recent-work/submissions"
      );
      assert.equal((await WorkPhoto.findOne({}).lean()).uploaderType, UPLOADER_TYPE.MEMBER);
      assert.equal(res.body.created[0].status, STATUS.PENDING_REVIEW);
    });

    await test("a member cannot attach their photo to someone else's booking", async () => {
      const Booking = require("../models/Booking");
      const strangers = await Booking.create({
        bookingNumber: "28888888",
        userId: plainCustomer.userId,
        user: plainCustomer._id,
        name: "No Plan",
        email: "noplan@example.com",
        phone: "+16315550002",
        address: "77 Secret Lane", city: "Huntington", state: "NY", zip: "11743",
        service: "Drywall repair", subscription: "none",
        date: new Date(), status: "Completed",
      });

      const res = await uploadAs(
        memberToken,
        [await plainPhoto()],
        { bookingNumber: "28888888" },
        "/api/recent-work/submissions"
      );
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.match(res.body.message, /not yours/i);
      assert.equal(await WorkPhoto.countDocuments({}), 0, "nothing was stored");
      assert.equal(bucket.size, 0, "and no image was even processed");

      await Booking.deleteOne({ _id: strangers._id });
    });

    await test("a Fixter cannot attach a photo to a booking they were not assigned", async () => {
      const Booking = require("../models/Booking");
      const other = await Booking.create({
        bookingNumber: "28888889",
        userId: memberUser.userId, user: memberUser._id,
        name: "Member Person", email: "member@example.com", phone: "+16315550003",
        address: "3 Main St", city: "Huntington", state: "NY", zip: "11743",
        service: "Tiling", subscription: "Premium",
        date: new Date(), status: "Completed",
        assignedFixterId: new mongoose.Types.ObjectId(),
      });

      const res = await uploadAs(
        fixterToken, [await plainPhoto()], { bookingNumber: "28888889" }, "/api/recent-work/submissions"
      );
      assert.equal(res.status, 403);
      assert.match(res.body.message, /not assigned/i);
      await Booking.deleteOne({ _id: other._id });
    });

    await test("a member may attach a photo to their own booking", async () => {
      const Booking = require("../models/Booking");
      const mine = await Booking.create({
        bookingNumber: "28888890",
        userId: memberUser.userId, user: memberUser._id,
        name: "Member Person", email: "member@example.com", phone: "+16315550003",
        address: "3 Main St", city: "Huntington", state: "NY", zip: "11743",
        service: "Tiling", subscription: "Premium",
        date: new Date(), status: "Completed",
      });

      const res = await uploadAs(
        memberToken, [await plainPhoto()], { bookingNumber: "28888890" }, "/api/recent-work/submissions"
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const doc = await WorkPhoto.findOne({}).lean();
      assert.equal(doc.bookingNumber, "28888890");
      assert.ok(doc.bookingId, "the verified booking is linked by id, not by string");
      await Booking.deleteOne({ _id: mine._id });
    });

    await test("a membership that has lapsed is not a membership", async () => {
      const authRoutesInner = require("../routes/auth");
      const saved = authRoutesInner.buildPerAddressCoverage;
      /* Cover exists on the account but no address is active any more. */
      authRoutesInner.buildPerAddressCoverage = async () => ({
        addr1: { active: false, plan: "premium", source: "subscription" },
        addr2: { active: false, plan: "", source: "gift" },
      });
      try {
        const res = await uploadAs(
          memberToken, [await plainPhoto()], {}, "/api/recent-work/submissions"
        );
        assert.equal(res.status, 403);
        assert.match(res.body.message, /active membership/i);
      } finally {
        authRoutesInner.buildPerAddressCoverage = saved;
      }
    });

    await test("no non-published status can be coaxed out of the public feed", async () => {
      await seed(UPLOADER_TYPE.MEMBER, { title: "PENDING-SECRET" });
      const rejected = await seed(UPLOADER_TYPE.MEMBER, { title: "REJECTED-SECRET" });
      await service.reject(rejected._id, { name: "Taras" }, "no");
      await seed(UPLOADER_TYPE.FIXTER, { title: "SCHEDULED-SECRET" });
      await seed(UPLOADER_TYPE.ADMIN, { title: "LIBRARY-SECRET" });
      const archived = await seed(UPLOADER_TYPE.ADMIN, { title: "ARCHIVED-SECRET" }, true);
      await service.remove(archived._id, { name: "Taras" });

      /* Every shape of query manipulation we can think of. */
      const attempts = [
        "",
        "?status=pending_review",
        "?status[$ne]=published",
        "?status=rejected&category=other",
        "?limit=1000",
        "?limit=-5",
        "?page=0",
        "?page=-1",
        "?deletedAt=null",
        "?featured=true&status=library",
        "?category[$ne]=zzz",
        "?sort=-createdAt&status=scheduled",
      ];
      for (const qs of attempts) {
        const res = await call("GET", `/api/recent-work${qs}`);
        assert.equal(res.status, 200, `${qs} -> ${res.status}`);
        const body = JSON.stringify(res.body);
        for (const secret of [
          "PENDING-SECRET", "REJECTED-SECRET", "SCHEDULED-SECRET",
          "LIBRARY-SECRET", "ARCHIVED-SECRET",
        ]) {
          assert.ok(!body.includes(secret), `"${qs}" leaked ${secret}`);
        }
        assert.ok(res.body.limit <= 60 && res.body.limit >= 1, `${qs} limit ${res.body.limit}`);
        assert.ok(res.body.page >= 1, `${qs} page ${res.body.page}`);
      }
    });

    await test("a booking's street address never reaches the public feed", async () => {
      const Booking = require("../models/Booking");
      const booking = await Booking.create({
        bookingNumber: "27777777",
        userId: memberUser.userId, user: memberUser._id,
        name: "Member Person", email: "member@example.com", phone: "+16315550003",
        address: "412 Maple Avenue Apt 3B", city: "Babylon", state: "NY", zip: "11702",
        service: "Kitchen", subscription: "Premium",
        date: new Date(), status: "Completed",
      });

      /* The most linked-up photo we can make: booking, customer, and a town. */
      await seed(UPLOADER_TYPE.ADMIN, {
        title: "Kitchen finished",
        bookingId: booking._id,
        bookingNumber: "27777777",
        customerUserId: memberUser._id,
        publicLocation: "Babylon, NY",
      }, true);

      const res = await call("GET", "/api/recent-work");
      const body = JSON.stringify(res.body);
      assert.equal(res.body.photos.length, 1);
      assert.equal(res.body.photos[0].location, "Babylon, NY", "the town is allowed");

      for (const secret of [
        "412", "Maple", "Apt 3B", "11702", "27777777",
        "member@example.com", "Member Person", "+16315550003",
      ]) {
        assert.ok(!body.includes(secret), `public feed leaked "${secret}"`);
      }
      /* And nothing derived the town from the address behind our back. */
      const doc = await WorkPhoto.findOne({}).lean();
      assert.ok(!/412|Maple|Apt/.test(doc.publicLocation), "publicLocation is not an address");
      await Booking.deleteOne({ _id: booking._id });
    });

    await test("concurrent deletes purge once and do not error", async () => {
      const photo = await seed(UPLOADER_TYPE.ADMIN, {}, true);
      const results = await Promise.all([
        call("DELETE", `/api/admin/recent-work/${photo._id}`, adminToken),
        call("DELETE", `/api/admin/recent-work/${photo._id}`, adminToken),
        call("DELETE", `/api/admin/recent-work/${photo._id}`, adminToken),
      ]);
      assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join(","));
      assert.equal(bucket.size, 0);
      assert.equal(await WorkPhoto.countDocuments({ deletedAt: null }), 0);
    });

    await test("concurrent approve and reject cannot both win", async () => {
      const photo = await seed(UPLOADER_TYPE.MEMBER);
      const [a, b] = await Promise.all([
        call("POST", `/api/admin/recent-work/${photo._id}/publish`, adminToken),
        call("POST", `/api/admin/recent-work/${photo._id}/reject`, adminToken, { reason: "no" }),
      ]);
      assert.ok([a.status, b.status].includes(200), "one of them must succeed");
      const settled = await WorkPhoto.findById(photo._id).lean();
      assert.ok(
        [STATUS.PUBLISHED, STATUS.REJECTED].includes(settled.status),
        `ended up ${settled.status}`
      );
      const publicCount = (await call("GET", "/api/recent-work")).body.photos.length;
      assert.equal(
        publicCount,
        settled.status === STATUS.PUBLISHED ? 1 : 0,
        "the feed must agree with the record"
      );
    });

    await test("an oversized image is refused without reaching storage", async () => {
      /* 30 MB of noise: past the 25 MB ceiling. */
      const huge = Buffer.alloc(30 * 1024 * 1024, 7);
      const res = await uploadAs(adminToken, [huge]);
      assert.equal(res.status, 400);
      assert.equal(bucket.size, 0);
    });

    /* ============================================================ */
    section("What a contributor can see of their own");

    /*
     * The two endpoints the Customer and Fixter upload screens are built on.
     * Neither is the security boundary - assertBookingClaim still refuses a
     * booking the caller has no claim on whatever these return - but a picker
     * that offered somebody else's jobs would leak the existence of work the
     * caller has nothing to do with, which is a disclosure on its own.
     */

    await test("the job picker offers a member only their own jobs", async () => {
      const Booking = require("../models/Booking");
      const mine = await Booking.create({
        bookingNumber: "29000001",
        userId: memberUser.userId, user: memberUser._id,
        name: "Member Person", email: "member@example.com", phone: "+16315550003",
        address: "3 Main St", city: "Huntington", state: "NY", zip: "11743",
        service: "Tiling", subscription: "Premium",
        date: new Date(), status: "Completed",
      });
      const theirs = await Booking.create({
        bookingNumber: "29000002",
        userId: plainCustomer.userId, user: plainCustomer._id,
        name: "No Plan", email: "noplan@example.com", phone: "+16315550002",
        address: "77 Secret Lane", city: "Babylon", state: "NY", zip: "11702",
        service: "Drywall repair", subscription: "none",
        date: new Date(), status: "Completed",
      });

      const res = await call("GET", "/api/recent-work/my-jobs", memberToken);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const numbers = res.body.jobs.map((j) => j.bookingNumber);
      assert.ok(numbers.includes("29000001"), "their own job is offered");
      assert.ok(!numbers.includes("29000002"), "a stranger's job is not");

      /* And nothing about the customer rides along to draw a dropdown. */
      const raw = JSON.stringify(res.body);
      for (const leak of ["Secret Lane", "3 Main St", "@example.com", "+1631555", "No Plan"]) {
        assert.ok(!raw.includes(leak), `the job picker leaked: ${leak}`);
      }
      assert.deepEqual(
        Object.keys(res.body.jobs[0]).sort(),
        ["bookingNumber", "city", "date", "service", "status"]
      );

      await Booking.deleteMany({ _id: { $in: [mine._id, theirs._id] } });
    });

    await test("the job picker offers a Fixter only their assignments", async () => {
      const Booking = require("../models/Booking");
      const assigned = await Booking.create({
        bookingNumber: "29000003",
        userId: memberUser.userId, user: memberUser._id,
        name: "Member Person", email: "member@example.com", phone: "+16315550003",
        address: "3 Main St", city: "Huntington", state: "NY", zip: "11743",
        service: "Tiling", subscription: "Premium",
        date: new Date(), status: "Completed",
        assignedFixterId: fixterUser._id,
      });
      const somebodyElses = await Booking.create({
        bookingNumber: "29000004",
        userId: memberUser.userId, user: memberUser._id,
        name: "Member Person", email: "member@example.com", phone: "+16315550003",
        address: "9 Other Rd", city: "Babylon", state: "NY", zip: "11702",
        service: "Painting", subscription: "Premium",
        date: new Date(), status: "Completed",
        assignedFixterId: new mongoose.Types.ObjectId(),
      });

      const res = await call("GET", "/api/recent-work/my-jobs", fixterToken);
      assert.equal(res.status, 200);
      const numbers = res.body.jobs.map((j) => j.bookingNumber);
      assert.ok(numbers.includes("29000003"), "their assignment is offered");
      assert.ok(!numbers.includes("29000004"), "another Fixter's job is not");

      await Booking.deleteMany({ _id: { $in: [assigned._id, somebodyElses._id] } });
    });

    await test("the job picker refuses anyone who may not submit at all", async () => {
      /* A customer with no membership cannot upload, so has nothing to pick. */
      assert.equal((await call("GET", "/api/recent-work/my-jobs", customerToken)).status, 403);
      assert.equal((await call("GET", "/api/recent-work/my-jobs")).status, 401);
      assert.equal((await call("GET", "/api/recent-work/my-submissions")).status, 401);
    });

    await test("a contributor sees their own submissions and nobody else's", async () => {
      await uploadAs(memberToken, [await plainPhoto()], {}, "/api/recent-work/submissions");
      await uploadAs(fixterToken, [await plainPhoto()], {}, "/api/recent-work/submissions");

      const asMember = await call("GET", "/api/recent-work/my-submissions", memberToken);
      const asFixter = await call("GET", "/api/recent-work/my-submissions", fixterToken);
      assert.equal(asMember.body.submissions.length, 1);
      assert.equal(asFixter.body.submissions.length, 1);
      assert.notEqual(asMember.body.submissions[0].id, asFixter.body.submissions[0].id);

      /*
       * The status is shown because a contributor who uploads into silence
       * cannot tell a submission from a lost one. The admin's working notes
       * are not shown, because they are notes rather than correspondence.
       */
      assert.equal(asMember.body.submissions[0].status, STATUS.PENDING_REVIEW);
      const raw = JSON.stringify(asMember.body);
      for (const leak of ["internalNote", "rejectionReason", "reviewedBy", "uploadedByName"]) {
        assert.ok(!raw.includes(leak), `own-submissions leaked ${leak}`);
      }
    });

    await test("NOTHING A CONTRIBUTOR UPLOADS REACHES THE PUBLIC GALLERY", async () => {
      /*
       * The headline rule, asserted from the public endpoint rather than from
       * the row: both contributor roles upload, and the thing the world can
       * actually fetch stays empty until an admin acts.
       */
      await uploadAs(memberToken, [await plainPhoto()], {}, "/api/recent-work/submissions");
      await uploadAs(fixterToken, [await plainPhoto()], {}, "/api/recent-work/submissions");
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 0);

      /* Not after any amount of time, either. */
      await runRecentWorkCycle(new Date(Date.now() + FIXTER_PUBLISH_DELAY_MS * 20));
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 0);

      /* Only a deliberate admin publish puts one there. */
      const one = await WorkPhoto.findOne({ uploaderType: UPLOADER_TYPE.FIXTER }).lean();
      const published = await call("POST", `/api/admin/recent-work/${one._id}/publish`, adminToken);
      assert.equal(published.status, 200);
      assert.equal((await call("GET", "/api/recent-work")).body.photos.length, 1);
    });

    /* ============================================================ */
    section("What the public is allowed to read");

    /*
     * One field reaches a visitor: the caption an admin wrote or approved.
     * Everything else with words in it - the submitter's note, the admin's own
     * note, the title of a booking, a date - either stays on the row or is not
     * on the row at all. These tests are the fence.
     */

    await test("an approved caption is public; the note it came from is not", async () => {
      /* The whole workflow in one test: sent with a note, captioned by an
         admin, published - and only the admin's words come out. */
      await uploadAs(
        memberToken,
        [await plainPhoto()],
        { note: "My neighbour Karen said you were good, 14 Bayview Ave" },
        "/api/recent-work/submissions"
      );
      const row = await WorkPhoto.findOne({}).lean();

      const edited = await call("PATCH", `/api/admin/recent-work/${row._id}`, adminToken, {
        caption: "Mounted a 65-inch TV and concealed the wiring.",
      });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      await call("POST", `/api/admin/recent-work/${row._id}/publish`, adminToken);

      const feed = await call("GET", "/api/recent-work");
      assert.equal(feed.body.photos.length, 1);
      assert.equal(feed.body.photos[0].caption, "Mounted a 65-inch TV and concealed the wiring.");

      const raw = JSON.stringify(feed.body);
      for (const leak of ["Karen", "Bayview", "Customer note", "internalNote"]) {
        assert.ok(!raw.includes(leak), `the caption dragged along: ${leak}`);
      }

      /* And the note is still on the row, where the admin can read it. */
      const after = await WorkPhoto.findById(row._id).lean();
      assert.match(after.internalNote, /Karen/);
    });

    await test("a published photo with no caption is published with no words", async () => {
      const photo = await seed(UPLOADER_TYPE.ADMIN, { caption: "", title: "" }, true);
      const feed = await call("GET", "/api/recent-work");
      assert.equal(feed.body.photos.length, 1);
      assert.equal(feed.body.photos[0].caption, "", "an empty caption, not a substitute");
      assert.equal(feed.body.photos[0].id, String(photo._id));
    });

    await test("A NOTE NEVER BECOMES A CAPTION BY ITSELF", async () => {
      /*
       * The rule the whole feature rests on. A member writes something, an
       * admin publishes the photograph and writes nothing: the photograph goes
       * up and the member's sentence does not.
       */
      await uploadAs(
        memberToken, [await plainPhoto()], { note: "Kitchen looks brand new" }, "/api/recent-work/submissions"
      );
      const row = await WorkPhoto.findOne({}).lean();
      await call("POST", `/api/admin/recent-work/${row._id}/publish`, adminToken);

      const feed = await call("GET", "/api/recent-work");
      assert.equal(feed.body.photos[0].caption, "");
      assert.ok(!JSON.stringify(feed.body).includes("Kitchen looks brand new"));
    });

    await test("a Fixter's note does not become a caption either", async () => {
      await uploadAs(
        fixterToken, [await plainPhoto()], { note: "Old valve was seized" }, "/api/recent-work/submissions"
      );
      const row = await WorkPhoto.findOne({}).lean();
      await call("POST", `/api/admin/recent-work/${row._id}/publish`, adminToken);
      const feed = await call("GET", "/api/recent-work");
      assert.equal(feed.body.photos[0].caption, "");
      assert.ok(!JSON.stringify(feed.body).includes("seized"));
    });

    await test("an admin's own internal note is not public either", async () => {
      await seed(UPLOADER_TYPE.ADMIN, {
        caption: "Replaced a leaking shut-off valve.",
        internalNote: "Customer haggled, do not feature",
      }, true);
      const feed = await call("GET", "/api/recent-work");
      assert.equal(feed.body.photos[0].caption, "Replaced a leaking shut-off valve.");
      assert.ok(!JSON.stringify(feed.body).includes("haggled"));
    });

    await test("NO DATE REACHES THE PUBLIC FEED", async () => {
      await seed(UPLOADER_TYPE.ADMIN, { caption: "Hung a ceiling fan." }, true);
      const feed = await call("GET", "/api/recent-work");
      const dto = feed.body.photos[0];

      for (const key of Object.keys(dto)) {
        assert.ok(
          !/at$|date|time/i.test(key),
          "the public shape carries a date-shaped key: " + key,
        );
      }
      /* Not by name and not by value: no ISO timestamp anywhere in the body. */
      const raw = JSON.stringify(feed.body);
      assert.ok(
        !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw),
        "an ISO timestamp reached the public feed"
      );
    });

    await test("the admin still has the dates the public lost", async () => {
      const photo = await seed(UPLOADER_TYPE.ADMIN, { title: "Dated" }, true);
      const res = await call("GET", "/api/admin/recent-work?view=published", adminToken);
      const dto = res.body.photos.find((p) => p.id === String(photo._id));
      assert.ok(dto.publishedAt, "publishedAt is still on the admin shape");
      assert.ok(dto.createdAt, "so is createdAt");
    });

    /* ============================================================ */
    section("The words that come with a photo");

    /*
     * A customer sharing finished work can say what it was. Those words are
     * the whole reason this section exists as its own thing: they arrive from
     * the public internet, they describe somebody's home, and the one rule
     * that matters is that nothing about them is public until an admin
     * deliberately makes it so.
     */

    await test("a customer's note is filed as an internal note, not as a caption", async () => {
      const res = await uploadAs(
        memberToken,
        [await plainPhoto()],
        { note: "  Kitchen   sink had been leaking" + String.fromCharCode(10) + "for weeks  " },
        "/api/recent-work/submissions"
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const doc = await WorkPhoto.findOne({}).lean();
      /* Collapsed, trimmed, and attributed so nobody reads it as the office's. */
      assert.equal(doc.internalNote, "Customer note: Kitchen sink had been leaking for weeks");
      assert.equal(doc.caption, "", "the note did not become published copy");
      assert.equal(doc.title, "", "nor a title");

      /* Not even on the uploader's own receipt, which is the public shape. */
      assert.ok(!JSON.stringify(res.body).includes("leaking"));
    });

    await test("A CUSTOMER'S NOTE IS NOT PUBLIC, INCLUDING AFTER THE PHOTO IS", async () => {
      await uploadAs(
        memberToken,
        [await plainPhoto()],
        { note: "My neighbour Karen recommended you, 14 Bayview Ave" },
        "/api/recent-work/submissions"
      );
      const doc = await WorkPhoto.findOne({}).lean();

      /* The admin publishes the photo and writes nothing. */
      const published = await call("POST", `/api/admin/recent-work/${doc._id}/publish`, adminToken);
      assert.equal(published.status, 200, JSON.stringify(published.body));

      const feed = await call("GET", "/api/recent-work");
      assert.equal(feed.body.photos.length, 1, "the photo is public");
      const raw = JSON.stringify(feed.body);
      for (const leak of ["internalNote", "Karen", "Bayview", "Customer note"]) {
        assert.ok(!raw.includes(leak), `the public feed leaked: ${leak}`);
      }
      assert.equal(feed.body.photos[0].caption, "", "and the caption is still empty");
    });

    await test("the admin reads the note while deciding", async () => {
      await uploadAs(
        memberToken, [await plainPhoto()], { note: "Replaced the vanity" }, "/api/recent-work/submissions"
      );
      const res = await call("GET", "/api/admin/recent-work?view=pending", adminToken);
      assert.equal(res.status, 200);
      assert.equal(res.body.photos.length, 1);
      assert.match(res.body.photos[0].internalNote, /Customer note: Replaced the vanity/);
    });

    await test("the note travels with every photo in the batch", async () => {
      const res = await uploadAs(
        memberToken,
        [await plainPhoto(), await plainPhoto(800, 800), await plainPhoto(600, 900)],
        { note: "Three angles of the same shelf" },
        "/api/recent-work/submissions"
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const docs = await WorkPhoto.find({}).lean();
      assert.equal(docs.length, 3);
      assert.equal(new Set(docs.map((d) => d.batchId)).size, 1, "one batch");
      for (const doc of docs) {
        assert.equal(doc.internalNote, "Customer note: Three angles of the same shelf");
        assert.equal(doc.status, STATUS.PENDING_REVIEW);
      }
    });

    await test("a customer can share without naming a visit", async () => {
      /*
       * The booking is optional by design: somebody who cannot remember which
       * visit fixed the shelf still has a photo of the shelf. What is not
       * optional is that the submission still waits for review.
       */
      const res = await uploadAs(
        memberToken, [await plainPhoto()], { note: "Not sure which visit" }, "/api/recent-work/submissions"
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const doc = await WorkPhoto.findOne({}).lean();
      assert.equal(doc.bookingNumber, "");
      assert.equal(doc.bookingId || null, null);
      assert.equal(doc.status, STATUS.PENDING_REVIEW);
      /* Still attributable: the uploader is the customer, booking or not. */
      assert.equal(String(doc.uploadedByUserId), String(memberUser._id));
    });

    await test("an optional booking is still checked when one is named", async () => {
      /*
       * Optional means the field may be empty. It does not mean the field is
       * unchecked - the same claim is verified whether the picker offered the
       * number or somebody typed it into the request themselves.
       */
      const Booking = require("../models/Booking");
      const strangers = await Booking.create({
        bookingNumber: "28777777",
        userId: plainCustomer.userId, user: plainCustomer._id,
        name: "No Plan", email: "noplan@example.com", phone: "+16315550002",
        address: "77 Secret Lane", city: "Babylon", state: "NY", zip: "11702",
        service: "Drywall repair", subscription: "none",
        date: new Date(), status: "Completed",
      });

      const res = await uploadAs(
        memberToken,
        [await plainPhoto()],
        { note: "Nice work", bookingNumber: "28777777" },
        "/api/recent-work/submissions"
      );
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(await WorkPhoto.countDocuments({}), 0, "the note was not stored either");

      await Booking.deleteOne({ _id: strangers._id });
    });

    await test("a note longer than the field is trimmed, not refused", async () => {
      const res = await uploadAs(
        memberToken,
        [await plainPhoto()],
        { note: "x".repeat(4000) },
        "/api/recent-work/submissions"
      );
      assert.equal(res.status, 201, "a long note loses its tail, not the photo");
      const doc = await WorkPhoto.findOne({}).lean();
      assert.ok(doc.internalNote.length <= 500, doc.internalNote.length + " chars stored");
      assert.ok(doc.internalNote.startsWith("Customer note: "));
    });

    await test("a Fixter's note is attributed to a Fixter", async () => {
      await uploadAs(
        fixterToken, [await plainPhoto()], { note: "Old valve was seized" }, "/api/recent-work/submissions"
      );
      const doc = await WorkPhoto.findOne({}).lean();
      assert.equal(doc.internalNote, "Fixter note: Old valve was seized");
    });

    await test("no note at all is the ordinary case", async () => {
      const res = await uploadAs(memberToken, [await plainPhoto()], {}, "/api/recent-work/submissions");
      assert.equal(res.status, 201);
      assert.equal((await WorkPhoto.findOne({}).lean()).internalNote, "");
    });

    /* ============================================================ */
    section("Admin views");

    await test("the views separate pending, published and library", async () => {
      await seed(UPLOADER_TYPE.MEMBER, { title: "Pending one" });
      await seed(UPLOADER_TYPE.ADMIN, { title: "Live one" }, true);
      await seed(UPLOADER_TYPE.ADMIN, { title: "Library one" });
      await seed(UPLOADER_TYPE.FIXTER, { title: "Fixter submission" });

      const pending = await call("GET", "/api/admin/recent-work?view=pending", adminToken);
      const published = await call("GET", "/api/admin/recent-work?view=published", adminToken);
      const library = await call("GET", "/api/admin/recent-work?view=library", adminToken);

      /* Both contributor uploads queue for review now, member and Fixter alike. */
      assert.equal(pending.body.photos.length, 2);
      assert.deepEqual(
        pending.body.photos.map((x) => x.title).sort(),
        ["Fixter submission", "Pending one"]
      );
      assert.equal(published.body.photos.length, 1);
      assert.equal(published.body.photos[0].title, "Live one");
      assert.equal(library.body.photos.length, 4, "library holds everything we still have");
      assert.equal(library.body.counts.pending, 2);
      assert.equal(library.body.counts.scheduled, 0, "nothing schedules itself any more");
      assert.equal(library.body.counts.published, 1);
    });

    await test("admin search finds by title and booking number", async () => {
      await seed(UPLOADER_TYPE.ADMIN, { title: "Cedar fence", bookingNumber: "20005555" });
      await seed(UPLOADER_TYPE.ADMIN, { title: "Tile floor" });

      const byTitle = await call("GET", "/api/admin/recent-work?q=cedar", adminToken);
      assert.equal(byTitle.body.photos.length, 1);
      const byBooking = await call("GET", "/api/admin/recent-work?q=20005555", adminToken);
      assert.equal(byBooking.body.photos.length, 1);
    });

    await test("editing public wording does not change state", async () => {
      const photo = await seed(UPLOADER_TYPE.ADMIN, { title: "Before" }, true);
      const res = await call("PATCH", `/api/admin/recent-work/${photo._id}`, adminToken, {
        title: "After",
        caption: "Tidied up",
        category: "kitchen-remodeling",
        featured: true,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.photo.title, "After");
      assert.equal(res.body.photo.featured, true);
      assert.equal(res.body.photo.status, STATUS.PUBLISHED);

      const pub = await call("GET", "/api/recent-work");
      assert.equal(pub.body.photos[0].title, "After");
      assert.equal(pub.body.photos[0].category, "kitchen-remodeling");
    });

    await test("an unknown category is refused", async () => {
      const photo = await seed(UPLOADER_TYPE.ADMIN);
      const res = await call("PATCH", `/api/admin/recent-work/${photo._id}`, adminToken, {
        category: "<script>alert(1)</script>",
      });
      assert.equal(res.status, 400);
    });

    await test("featured work sorts to the front of the public feed", async () => {
      await seed(UPLOADER_TYPE.ADMIN, { title: "Ordinary" }, true);
      const star = await seed(UPLOADER_TYPE.ADMIN, { title: "Star" }, true);
      await service.updateDetails(star._id, { featured: true });

      const res = await call("GET", "/api/recent-work");
      assert.equal(res.body.photos[0].title, "Star");
    });
  } finally {
    authRoutes.buildPerAddressCoverage = realCoverage;
    app.close();
    await mongoose.disconnect();
    await server.stop();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`\n${f.name}\n`, f.error);
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
