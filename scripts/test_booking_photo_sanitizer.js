/**
 * Booking photo sanitization.
 *
 * The bug these tests exist to pin: the old uploader asked path.extname() what
 * a file was. A JPEG carrying GPS coordinates, sent with no extension at all,
 * matched neither the convert list nor the re-encode list and was written to a
 * public bucket byte for byte - home coordinates, camera serial and all. The
 * same fallback stored whatever a client claimed as the Content-Type, so a
 * renamed HTML file could be served as HTML from our own domain.
 *
 * Every case below therefore describes a file whose NAME and declared MIME
 * type disagree with its BYTES, and asserts that only the bytes were believed.
 *
 *   node scripts/test_booking_photo_sanitizer.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";

/* Stub S3 before anything captures the real uploader. */
const s3 = require("../utils/s3");
const uploads = [];
s3.putPublicObject = async ({ Bucket, Key, Body, ContentType }) => {
  uploads.push({ Bucket, Key, Body, ContentType });
  return `https://${Bucket}.s3.amazonaws.com/${Key}`;
};

const {
  sanitizeImageBuffer,
  sanitizeUploadedPhotos,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS,
} = require("../utils/imageSanitizer");
const { storeAppointmentImages } = require("../utils/bookingAttachments");

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

/* ---------------------------------------------------------------- fixtures */

const NUL = String.fromCharCode(0);

/**
 * A real EXIF block: camera identity, an orientation flag, and GPS coordinates.
 * Written by hand because sharp will not emit GPS, and a test that cannot
 * produce the dangerous input cannot prove the danger is gone.
 */
function exifApp1(options) {
  const orientation = (options && options.orientation) || 1;
  const make = Buffer.from(`Apple${NUL}`, "latin1");
  const model = Buffer.from(`iPhone 13${NUL}`, "latin1");

  const rational = (parts) => {
    const b = Buffer.alloc(24);
    const pairs = [[parts[0], 1], [parts[1], 1], [Math.round(parts[2] * 100), 100]];
    pairs.forEach(([n, d], i) => {
      b.writeUInt32BE(n, i * 8);
      b.writeUInt32BE(d, i * 8 + 4);
    });
    return b;
  };
  const lat = rational([40, 44, 54.36]);
  const lon = rational([73, 59, 8.36]);

  const IFD0_AT = 8;
  const GPS_AT = IFD0_AT + 2 + 4 * 12 + 4;
  const DATA_AT = GPS_AT + 2 + 4 * 12 + 4;
  const MAKE_AT = DATA_AT;
  const MODEL_AT = MAKE_AT + make.length;
  const LAT_AT = MODEL_AT + model.length;
  const LON_AT = LAT_AT + lat.length;
  const total = LON_AT + lon.length;

  const t = Buffer.alloc(total);
  t.write("MM", 0, "latin1");
  t.writeUInt16BE(0x002a, 2);
  t.writeUInt32BE(IFD0_AT, 4);

  const entry = (at, tag, type, count, writeValue) => {
    t.writeUInt16BE(tag, at);
    t.writeUInt16BE(type, at + 2);
    t.writeUInt32BE(count, at + 4);
    writeValue(at + 8);
  };

  t.writeUInt16BE(4, IFD0_AT);
  let e = IFD0_AT + 2;
  entry(e, 0x010f, 2, make.length, (p) => t.writeUInt32BE(MAKE_AT, p)); e += 12;
  entry(e, 0x0110, 2, model.length, (p) => t.writeUInt32BE(MODEL_AT, p)); e += 12;
  entry(e, 0x0112, 3, 1, (p) => { t.writeUInt16BE(orientation, p); t.writeUInt16BE(0, p + 2); }); e += 12;
  entry(e, 0x8825, 4, 1, (p) => t.writeUInt32BE(GPS_AT, p)); e += 12;
  t.writeUInt32BE(0, e);

  t.writeUInt16BE(4, GPS_AT);
  let g = GPS_AT + 2;
  entry(g, 0x0001, 2, 2, (p) => t.write(`N${NUL}`, p, "latin1")); g += 12;
  entry(g, 0x0002, 5, 3, (p) => t.writeUInt32BE(LAT_AT, p)); g += 12;
  entry(g, 0x0003, 2, 2, (p) => t.write(`W${NUL}`, p, "latin1")); g += 12;
  entry(g, 0x0004, 5, 3, (p) => t.writeUInt32BE(LON_AT, p)); g += 12;
  t.writeUInt32BE(0, g);

  make.copy(t, MAKE_AT);
  model.copy(t, MODEL_AT);
  lat.copy(t, LAT_AT);
  lon.copy(t, LON_AT);

  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(2 + 6 + t.length, 2);
  return Buffer.concat([head, Buffer.from(`Exif${NUL}${NUL}`, "latin1"), t]);
}

/** A PNG that is nothing but a header, declaring whatever size we ask for. */
function pngHeaderOnly(width, height) {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Splice an APP1 EXIF block into a JPEG, right after SOI. */
function withExif(jpeg, options) {
  return Buffer.concat([jpeg.slice(0, 2), exifApp1(options), jpeg.slice(2)]);
}

const plainJpeg = (w, h) =>
  sharp({ create: { width: w || 800, height: h || 600, channels: 3, background: "#3366aa" } })
    .jpeg()
    .toBuffer();

/* ------------------------------------------------------------ EXIF reading */

function findExif(buf) {
  let o = 2;
  while (o + 4 <= buf.length) {
    if (buf[o] !== 0xff) return null;
    const m = buf[o + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
    if (m === 0xda) return null;
    const len = buf.readUInt16BE(o + 2);
    if (m === 0xe1 && buf.slice(o + 4, o + 10).toString("latin1") === `Exif${NUL}${NUL}`) {
      return buf.slice(o + 10, o + 2 + len);
    }
    o += 2 + len;
  }
  return null;
}

function hasGpsIfd(tiff) {
  if (!tiff) return false;
  const be = tiff.slice(0, 2).toString("latin1") === "MM";
  const u16 = (p) => (be ? tiff.readUInt16BE(p) : tiff.readUInt16LE(p));
  const u32 = (p) => (be ? tiff.readUInt32BE(p) : tiff.readUInt32LE(p));
  const i0 = u32(4);
  const n = u16(i0);
  for (let i = 0; i < n; i += 1) {
    if (u16(i0 + 2 + i * 12) === 0x8825) return true;
  }
  return false;
}

const containsAscii = (buf, s) => buf.includes(Buffer.from(s, "latin1"));

/* --------------------------------------------------------- the fake "files" */

const asFile = (buffer, originalname, mimetype) => ({ buffer, originalname, mimetype });

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

/** Run the express middleware and report whether it let the request through. */
function runMiddleware(files) {
  return new Promise((resolve) => {
    const req = { files };
    const res = fakeRes();
    let done = false;
    sanitizeUploadedPhotos(req, res, () => {
      done = true;
      resolve({ passedThrough: true, res, req });
    });
    const settle = () => {
      if (done) return;
      if (res.statusCode !== null) resolve({ passedThrough: false, res, req });
      else setImmediate(settle);
    };
    setImmediate(settle);
  });
}

/* ------------------------------------------------------------------- tests */

(async () => {
  console.log("\nContent-based image sanitization\n");

  const jpeg = await plainJpeg();
  const gpsJpeg = withExif(jpeg);
  const png = await sharp({
    create: { width: 400, height: 300, channels: 4, background: { r: 10, g: 200, b: 90, alpha: 0.4 } },
  }).png().toBuffer();
  const webp = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#884422" } }).webp().toBuffer();
  const gif = await sharp({ create: { width: 120, height: 90, channels: 3, background: "#123456" } }).gif().toBuffer();
  const tiff = await sharp({ create: { width: 200, height: 150, channels: 3, background: "#654321" } }).tiff().toBuffer();

  /* --- the fixture itself must be dangerous, or nothing below means anything --- */
  await test("fixture: the test JPEG really does carry GPS and camera identity", () => {
    const t = findExif(gpsJpeg);
    assert.ok(t, "fixture has no EXIF block");
    assert.ok(hasGpsIfd(t), "fixture has no GPS IFD");
    assert.ok(containsAscii(gpsJpeg, "iPhone 13"), "fixture has no camera model");
    assert.ok(containsAscii(gpsJpeg, "Apple"), "fixture has no camera make");
  });

  /* --- accepted formats, decided from bytes --- */
  const accepted = [
    ["normal JPEG", jpeg, "jpeg"],
    ["PNG", png, "png"],
    ["WEBP", webp, "webp"],
    ["GIF", gif, "gif"],
    ["TIFF", tiff, "tiff"],
  ];
  for (const [name, buf, fmt] of accepted) {
    await test(`accepts ${name} and returns a JPEG`, async () => {
      const out = await sanitizeImageBuffer(buf);
      assert.strictEqual(out.contentType, "image/jpeg");
      assert.strictEqual(out.ext, ".jpg");
      assert.strictEqual(out.sourceFormat, fmt);
      const meta = await sharp(out.buffer).metadata();
      assert.strictEqual(meta.format, "jpeg");
    });
  }

  await test("HEIC/HEIF decoding is available in this sharp build", () => {
    assert.ok(sharp.format.heif && sharp.format.heif.input.buffer,
      "sharp cannot decode HEIF here - iPhone uploads would be rejected");
  });

  /*
   * Every photo an iPhone takes arrives as HEIC, so this is the single most
   * common real upload. Only run the round-trip when this build can also write
   * HEIF, since that is the only way to make a fixture without shipping a
   * binary into the repo.
   */
  if (sharp.format.heif && sharp.format.heif.output.buffer) {
    await test("accepts a real HEIC frame and returns a clean JPEG", async () => {
      let heic;
      try {
        heic = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#2f7f4f" } })
          .heif({ compression: "av1", quality: 50 })
          .toBuffer();
      } catch {
        console.log("        (skipped: this build cannot encode HEIF fixtures)");
        return;
      }
      const out = await sanitizeImageBuffer(heic);
      assert.strictEqual(out.contentType, "image/jpeg");
      assert.strictEqual(out.ext, ".jpg");
      const meta = await sharp(out.buffer).metadata();
      assert.strictEqual(meta.format, "jpeg");
      assert.strictEqual(findExif(out.buffer), null);
    });
  }

  /* --- the privacy guarantee --- */
  await test("EXIF, GPS and camera identity are all removed", async () => {
    const out = await sanitizeImageBuffer(gpsJpeg);
    assert.strictEqual(findExif(out.buffer), null, "EXIF block survived");
    assert.ok(!containsAscii(out.buffer, "iPhone 13"), "camera model survived");
    assert.ok(!containsAscii(out.buffer, "Apple"), "camera make survived");
  });

  await test("orientation is baked into the pixels, not left in a tag", async () => {
    /* 6 means "rotate 90 CW to display": an 800x600 frame must come back 600x800. */
    const sideways = withExif(await plainJpeg(800, 600), { orientation: 6 });
    const out = await sanitizeImageBuffer(sideways);
    const meta = await sharp(out.buffer).metadata();
    assert.strictEqual(meta.width, 600, `width ${meta.width}`);
    assert.strictEqual(meta.height, 800, `height ${meta.height}`);
    assert.strictEqual(findExif(out.buffer), null, "orientation tag still present");
  });

  await test("the stored image does not depend on metadata to look right", async () => {
    const sideways = withExif(await plainJpeg(800, 600), { orientation: 6 });
    const out = await sanitizeImageBuffer(sideways);
    const meta = await sharp(out.buffer).metadata();
    assert.ok(meta.orientation === undefined || meta.orientation === 1,
      `residual orientation tag: ${meta.orientation}`);
  });

  /* --- the filename must never decide anything --- */
  await test("JPEG with NO extension is still sanitized (the original bug)", async () => {
    const out = await sanitizeImageBuffer(gpsJpeg);
    assert.strictEqual(findExif(out.buffer), null);
    assert.notStrictEqual(Buffer.compare(out.buffer, gpsJpeg), 0, "bytes passed through unchanged");
  });

  await test("JPEG misnamed .png is treated as the JPEG it is", async () => {
    const out = await sanitizeImageBuffer(gpsJpeg);
    assert.strictEqual(out.sourceFormat, "jpeg");
    assert.strictEqual(findExif(out.buffer), null);
  });

  await test("uppercase extension changes nothing", async () => {
    const { passedThrough, req } = await runMiddleware([asFile(gpsJpeg, "IMG_0042.JPG", "image/jpeg")]);
    assert.strictEqual(passedThrough, true);
    assert.strictEqual(req.files[0].sanitizedImage.ext, ".jpg");
    assert.strictEqual(findExif(req.files[0].buffer), null);
  });

  /* --- rejections --- */
  const rejects = [
    ["HTML renamed to .jpg", Buffer.from("<html><script>alert(1)</script></html>", "utf8")],
    ["SVG (script-capable, decodable by sharp)", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8")],
    ["PDF renamed to .jpg", Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", "latin1")],
    ["CSV renamed to .jpg", Buffer.from("a,b,c\n1,2,3\n", "utf8")],
    ["random bytes", Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 37) % 251))],
    ["empty file", Buffer.alloc(0)],
  ];
  for (const [name, buf] of rejects) {
    await test(`rejects ${name} with a clean 400`, async () => {
      await assert.rejects(
        () => sanitizeImageBuffer(buf),
        (e) => {
          assert.strictEqual(e.statusCode, 400, `status ${e.statusCode}`);
          assert.ok(e.message && !/sharp|vips|libvips|unsupported image format/i.test(e.message),
            `message leaks internals: ${e.message}`);
          return true;
        }
      );
    });
  }

  await test("a file over the byte limit is refused", async () => {
    await assert.rejects(
      () => sanitizeImageBuffer(Buffer.alloc(MAX_PHOTO_BYTES + 1, 0x41)),
      (e) => e.statusCode === 400
    );
  });

  await test("a decompression bomb is refused on its header, before any decode", async () => {
    /*
     * A 40000x40000 PNG header is 69 bytes on the wire and 4.8 gigapixels once
     * decoded. The point of the guard is that we never get as far as decoding
     * it, so the fixture is a header - which is also why this test costs
     * nothing to run.
     */
    const bomb = pngHeaderOnly(40000, 40000);
    assert.ok(bomb.length < 200, `bomb fixture should be tiny, was ${bomb.length}`);
    await assert.rejects(() => sanitizeImageBuffer(bomb), (e) => {
      assert.strictEqual(e.statusCode, 400, `status ${e.statusCode}`);
      return true;
    });
  });

  /* --- the MIME type is never believed --- */
  await test("a lying Content-Type cannot smuggle HTML through", async () => {
    const { passedThrough, res } = await runMiddleware([
      asFile(Buffer.from("<html>nope</html>", "utf8"), "totally-a-photo.jpg", "image/jpeg"),
    ]);
    assert.strictEqual(passedThrough, false, "HTML claiming image/jpeg was accepted");
    assert.strictEqual(res.statusCode, 400);
  });

  await test("a real JPEG declared application/octet-stream is still accepted", async () => {
    const { passedThrough } = await runMiddleware([asFile(jpeg, "photo", "application/octet-stream")]);
    assert.strictEqual(passedThrough, true, "a genuine phone photo was refused");
  });

  await test("a real JPEG with no filename at all is accepted and cleaned", async () => {
    const { passedThrough, req } = await runMiddleware([asFile(gpsJpeg, "", "")]);
    assert.strictEqual(passedThrough, true);
    assert.strictEqual(findExif(req.files[0].buffer), null);
  });

  await test("too many photos in one request is refused", async () => {
    const many = Array.from({ length: MAX_PHOTOS + 1 }, () => asFile(jpeg, "p.jpg", "image/jpeg"));
    const { passedThrough, res } = await runMiddleware(many);
    assert.strictEqual(passedThrough, false);
    assert.strictEqual(res.statusCode, 400);
  });

  /* --- end to end, through the real booking-photo storage path --- */
  await test("storeAppointmentImages stores a sanitized JPEG and our own Content-Type", async () => {
    uploads.length = 0;
    const files = [asFile(gpsJpeg, "IMG_0042", "image/jpeg")];
    const result = await storeAppointmentImages({
      files,
      bookingDate: new Date("2026-03-04T15:00:00Z"),
      bookingNumber: "12345678",
      source: "test",
    });
    assert.strictEqual(uploads.length, 1, "expected exactly one upload");
    const up = uploads[0];
    assert.strictEqual(up.ContentType, "image/jpeg", `content-type ${up.ContentType}`);
    assert.ok(up.Key.endsWith(".jpg"), `key ${up.Key}`);
    assert.strictEqual(findExif(up.Body), null, "EXIF reached S3");
    assert.ok(!containsAscii(up.Body, "iPhone 13"), "camera model reached S3");
    assert.notStrictEqual(Buffer.compare(up.Body, gpsJpeg), 0, "raw bytes reached S3 unchanged");
    assert.strictEqual(result.images.length, 1);
    assert.strictEqual(result.uploadedS3Keys.length, 1);
  });

  await test("one bad file in a batch stores NOTHING - no object, no record", async () => {
    uploads.length = 0;
    const files = [
      asFile(jpeg, "good-1.jpg", "image/jpeg"),
      asFile(jpeg, "good-2.jpg", "image/jpeg"),
      asFile(Buffer.from("<html>evil</html>", "utf8"), "third.jpg", "image/jpeg"),
      asFile(jpeg, "good-4.jpg", "image/jpeg"),
    ];
    await assert.rejects(
      () => storeAppointmentImages({
        files,
        bookingDate: new Date("2026-03-04T15:00:00Z"),
        bookingNumber: "87654321",
        source: "test",
      }),
      (e) => e.statusCode === 400
    );
    assert.strictEqual(uploads.length, 0,
      `${uploads.length} object(s) were orphaned in S3 before the batch failed`);
  });

  await test("the middleware refuses the batch before any storage runs", async () => {
    uploads.length = 0;
    const { passedThrough } = await runMiddleware([
      asFile(jpeg, "a.jpg", "image/jpeg"),
      asFile(Buffer.from("%PDF-1.7", "latin1"), "b.jpg", "image/jpeg"),
    ]);
    assert.strictEqual(passedThrough, false);
    assert.strictEqual(uploads.length, 0);
  });

  /* --- neither upload path may keep a bytes-through fallback --- */
  await test("no upload path retains a raw-bytes fallback", () => {
    const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\r\n/g, "\n");
    const bookings = read("routes/bookings.js");
    const attachments = read("utils/bookingAttachments.js");

    for (const [file, src] of [["routes/bookings.js", bookings], ["utils/bookingAttachments.js", attachments]]) {
      assert.ok(!/Body:\s*f\.buffer/.test(src), `${file} still uploads a raw request buffer`);
      assert.ok(!/ContentType:\s*f\.mimetype/.test(src), `${file} still trusts the client Content-Type`);
      assert.ok(!/ContentType:\s*file\.mimetype/.test(src), `${file} still trusts the client Content-Type`);
      assert.ok(/ensureSanitized/.test(src), `${file} does not sanitize`);
    }

    /* Every route that accepts photos must run the middleware. */
    const routeCount = (bookings.match(/upload\.array\("images", 10\),/g) || []).length;
    const guardCount = (bookings.match(/upload\.array\("images", 10\),\n\s*sanitizeUploadedPhotos,/g) || []).length;
    assert.ok(routeCount >= 4, `expected at least 4 photo routes, found ${routeCount}`);
    assert.strictEqual(guardCount, routeCount,
      `${routeCount - guardCount} photo route(s) are missing sanitizeUploadedPhotos`);
  });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
})().catch((err) => {
  console.error("harness error:", err);
  process.exit(1);
});
