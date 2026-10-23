/**
 * The homepage free-visit request: one step, no account.
 *
 * Drives POST /api/free-visit-requests against an in-memory database, with S3,
 * email and the Meta Conversions API stubbed. SMS stays off (SMS_ENABLED unset),
 * so a message that passes every consent check is recorded as "simulated" and
 * one that does not is recorded as "suppressed" - which is exactly the
 * difference these cases assert on.
 *
 *   node scripts/test_free_visit_request.js
 */
const assert = require("assert");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.S3_BUCKET = "test-bucket";
process.env.META_CAPI_TOKEN = "test-token";
process.env.OWNER_ALERT_PHONE = "6315991363";
process.env.MAIL_ADMIN = "owner@example.com";
delete process.env.SMS_ENABLED;
delete process.env.META_TEST_EVENT_CODE;
delete process.env.FB_TEST_CODE;
delete process.env.ENABLE_RESERVATION_ENGINE;

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

const CONSENT =
  "By booking, you agree to be contacted by call or text about your visit. Msg & data rates may apply.";

async function waitFor(check, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

function futureSlot(days = 3) {
  const moment = require("moment-timezone");
  return { date: moment.tz("America/New_York").add(days, "days").format("YYYY-MM-DD"), time: "10:00" };
}

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  /* Stubs, installed before the route captures them. */
  const s3 = require("../utils/s3");
  const uploads = [];
  s3.putPublicObject = async ({ Key }) => {
    uploads.push(Key);
    return `https://test-bucket.s3.amazonaws.com/${Key}`;
  };
  const mail = require("../utils/emailService");
  const emails = [];
  mail.sendRaw = async (msg) => {
    emails.push(msg);
    return { ok: true };
  };
  const capi = [];
  const passThrough = global.fetch;
  global.fetch = async (url, init) => {
    if (!String(url).includes("graph.facebook.com")) return passThrough(url, init);
    capi.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ events_received: 1 }), text: async () => "" };
  };

  const Request = require("../models/Request");
  const SmsMessage = require("../models/SmsMessage");
  const SmsOptOut = require("../models/SmsOptOut");
  const { checkEligibility } = require("../utils/sms/smsEligibility");
  await Request.init();
  await SmsMessage.init();
  await SmsOptOut.init();

  const app = express();
  app.set("trust proxy", true);
  app.use("/api/free-visit-requests", require("../routes/freeVisitRequests"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/free-visit-requests`;

  async function post(fields, photos = []) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
    for (const p of photos) form.append("images", new Blob([p], { type: "image/png" }), "kitchen sink.png");
    const res = await fetch(base, { method: "POST", body: form, headers: { "user-agent": "Mozilla/5.0 test" } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  const sharp = require("sharp");
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#336699" } }).png().toBuffer();
  const slot = futureSlot();
  const good = {
    name: "Jane Doe",
    phone: "(631) 555-0142",
    email: "Jane.Doe@Example.com",
    note: "The bathroom faucet drips and a towel bar fell off",
    requestedDate: slot.date,
    requestedTime: slot.time,
    consentText: CONSENT,
    eventId: "evt-free-visit-1",
    pageUrl: "https://www.profixter.com/?utm_source=fb&utm_medium=paid&utm_campaign=120200",
    sourcePage: "/",
    urlParams: { utm_source: "fb", utm_medium: "paid", utm_campaign: "120200", fbclid: "IwAR123", junk: "x" },
    attribution: { utmSource: "fb", fbclid: "IwAR123", fbclidAt: 1760000000000, nested: { no: 1 } },
    fbp: "fb.1.1760000000000.123456",
  };

  console.log("\nA one-step request");
  let first;
  await test("a valid request is saved as a pending free-visit Lead", async () => {
    first = await post(good, [png]);
    assert.strictEqual(first.status, 201, JSON.stringify(first.body));
    assert.strictEqual(first.body.eventId, "evt-free-visit-1");
    const row = await Request.findById(first.body.requestId).lean();
    assert.strictEqual(row.serviceType, "free_visit_request");
    assert.strictEqual(row.status, "pending_confirmation");
    assert.strictEqual(row.email, "jane.doe@example.com");
    assert.strictEqual(row.phone, "+16315550142");
    assert.strictEqual(row.requestedDate, slot.date);
    assert.strictEqual(row.requestedTime, "10:00");
    assert.strictEqual(row.message, good.note);
    assert.strictEqual(row.images.length, 1);
    assert.ok(row.images[0].includes(`/free-visit-requests/${row._id}/`));
    assert.deepStrictEqual(row.attribution.url, { utm_source: "fb", utm_medium: "paid", utm_campaign: "120200", fbclid: "IwAR123" });
    assert.strictEqual(row.attribution.firstTouch.nested, undefined, "objects are not stored from the browser");
    assert.strictEqual(row.contactConsent.text, CONSENT);
    assert.ok(row.contactConsent.at);
  });

  await test("the server Lead goes to Meta once, with the browser's event id and hashed contact", async () => {
    await waitFor(() => capi.length >= 1, 10000);
    assert.strictEqual(capi.length, 1);
    const event = capi[0].data[0];
    assert.strictEqual(event.event_name, "Lead");
    assert.strictEqual(event.event_id, "evt-free-visit-1");
    assert.strictEqual(event.custom_data.lead_type, "free_visit_request");
    assert.ok(event.user_data.em && event.user_data.ph, "email and phone are hashed in");
    assert.ok(!JSON.stringify(event).includes("jane.doe@example.com"), "never in the clear");
    assert.strictEqual(event.user_data.fbp, good.fbp);
  });

  await test("the owner gets an email with the details, and so does the customer", async () => {
    await waitFor(() => emails.length >= 2, 10000);
    const owner = emails.find((m) => m.logContext?.templateKey === "admin_free_visit_request");
    const customer = emails.find((m) => m.logContext?.templateKey === "free_visit_request_received");
    assert.ok(owner, "owner email");
    assert.ok(owner.to.includes("owner@example.com"));
    for (const bit of ["Jane Doe", "(631) 555-0142", "jane.doe@example.com", "faucet", "utm_campaign", "120200"]) {
      assert.ok(owner.text.includes(bit), `owner email mentions ${bit}`);
    }
    assert.ok(customer, "customer email");
    assert.strictEqual(customer.to, "jane.doe@example.com");
    assert.ok(customer.text.includes("Got it! A Profixter team member will call you shortly to confirm your free visit on"));
    assert.ok(customer.html.includes("/signup"), "the optional account link");
  });

  await test("both texts pass every consent check (simulated, because SMS is off here)", async () => {
    // A message is written "pending" and settled a moment later; wait for both to settle.
    const rows = await waitFor(async () => {
      const r = await SmsMessage.find({}).lean();
      return r.length >= 2 && r.every((m) => m.status !== "pending") ? r : null;
    }, 10000);
    const customer = rows.find((r) => r.notificationType === "FREE_VISIT_REQUEST_RECEIVED");
    const owner = rows.find((r) => r.notificationType === "OWNER_LEAD_ALERT");
    assert.strictEqual(customer.status, "simulated", customer.suppressionReason);
    assert.strictEqual(customer.toPhone, "+16315550142");
    assert.ok(/^Got it! A Profixter team member will call you shortly to confirm your free visit on \w+day, \w+ \d+ at 10:00 AM\. Reply STOP to opt out\.$/.test(customer.body), customer.body);
    assert.strictEqual(owner.status, "simulated", owner.suppressionReason);
    assert.strictEqual(owner.toPhone, "+16315991363");
    assert.ok(owner.body.includes("Jane Doe") && owner.body.includes("(631) 555-0142") && owner.body.includes("faucet"));
  });

  await test("the same press twice is one lead, one Meta event and no second message", async () => {
    const again = await post(good);
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.duplicate, true);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(await Request.countDocuments({ serviceType: "free_visit_request" }), 1);
    assert.strictEqual(capi.length, 1);
    assert.strictEqual(await SmsMessage.countDocuments({}), 2);
  });

  console.log("\nValidation");
  for (const [label, patch, code] of [
    ["a 9-digit phone", { phone: "631555014" }, "INVALID_PHONE"],
    ["a non-US-shaped phone", { phone: "+44 20 7946 0958" }, "INVALID_PHONE"],
    ["a bad email", { email: "jane@" }, "INVALID_EMAIL"],
    ["a single name", { name: "Jane" }, "INVALID_NAME"],
    ["no job description", { note: "fix" }, "NOTE_REQUIRED"],
    ["a different consent line", { consentText: "By booking you agree." }, "CONSENT_MISMATCH"],
    ["a day in the past", { requestedDate: "2020-01-01" }, "DATE_UNAVAILABLE"],
  ]) {
    await test(`refuses ${label}`, async () => {
      const res = await post({ ...good, ...patch, eventId: `evt-${code}-${Math.random()}` });
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, code);
    });
  }
  await test("nothing was saved or sent for any refused request", async () => {
    assert.strictEqual(await Request.countDocuments({ serviceType: "free_visit_request" }), 1);
    assert.strictEqual(capi.length, 1);
  });

  console.log("\nThe consent rule stays narrow");
  const fresh = { text: CONSENT, at: new Date(), phone: "+16315550142" };
  await test("the request text is refused without its stored consent", async () => {
    const v = await checkEligibility({ notificationType: "FREE_VISIT_REQUEST_RECEIVED", phone: "+16315550142" });
    assert.strictEqual(v.eligible, false);
    assert.strictEqual(v.reason, "request_consent_missing");
  });
  await test("...or with consent given for a different phone", async () => {
    const v = await checkEligibility({ notificationType: "FREE_VISIT_REQUEST_RECEIVED", phone: "+16315550199", requestConsent: fresh });
    assert.strictEqual(v.reason, "request_consent_other_phone");
  });
  await test("...or more than an hour after the press", async () => {
    const stale = { ...fresh, at: new Date(Date.now() - 2 * 60 * 60 * 1000) };
    const v = await checkEligibility({ notificationType: "FREE_VISIT_REQUEST_RECEIVED", phone: fresh.phone, requestConsent: stale });
    assert.strictEqual(v.reason, "request_consent_stale");
  });
  await test("the stored consent does not unlock any other message", async () => {
    const v = await checkEligibility({ notificationType: "BOOKING_CONFIRMED", phone: fresh.phone, requestConsent: fresh });
    assert.strictEqual(v.reason, "transactional_requires_account");
  });
  await test("the owner alert cannot go to any number but OWNER_ALERT_PHONE", async () => {
    const v = await checkEligibility({ notificationType: "OWNER_LEAD_ALERT", phone: "+16315550142" });
    assert.strictEqual(v.reason, "owner_alert_wrong_phone");
  });
  await test("STOP still wins over the stored consent", async () => {
    await SmsOptOut.create({ phone: "+16315550177", scope: "all", source: "carrier_keyword", optedOutAt: new Date() });
    const v = await checkEligibility({
      notificationType: "FREE_VISIT_REQUEST_RECEIVED",
      phone: "+16315550177",
      requestConsent: { ...fresh, phone: "+16315550177" },
    });
    assert.strictEqual(v.eligible, false, "an opted-out number is never texted");
  });

  server.close();
  await mongoose.disconnect();
  await mongod.stop();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
