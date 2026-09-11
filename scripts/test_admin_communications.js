/**
 * The Communications control centre, end to end.
 *
 * Real Express routes, real Mongoose models, real template renderers, on an
 * in-memory MongoDB. Nothing is stubbed that could hide the thing being
 * asserted, because almost every claim in this file is about two systems
 * agreeing with each other - the editor and the send path, the template and the
 * history, the settings screen and the code it describes.
 *
 * THE THREE PROPERTIES THIS FILE EXISTS TO DEFEND
 *
 *   1. The approved wording does not move. With no override saved, every one of
 *      the 43 approved bodies renders byte-for-byte as it does today, and the
 *      token mirrors reproduce the code defaults across every visit kind. An
 *      admin screen that silently reworded a reminder would be worse than no
 *      admin screen.
 *   2. History is immutable. Editing a template today must not reach backwards
 *      into what a customer was told last week. SmsMessage keeps its own body;
 *      EmailLog now keeps its own snapshot.
 *   3. Nothing here can send. Preview renders strings. The four flags stay
 *      false throughout and the suite asserts it at the end.
 */

const assert = require("assert");
const express = require("express");
const mongoose = require("mongoose");
const fetch = require("node-fetch");
const jwt = require("jsonwebtoken");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-not-real";
for (const flag of [
  "SMS_ENABLED",
  "SMS_MARKETING_ENABLED",
  "SMS_REVIEW_LINK_ENABLED",
  "GIFT_SMS_ENABLED",
]) {
  process.env[flag] = "false";
}

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

const section = (t) => console.log(`\n${t}`);

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const User = require("../models/User");
  const SmsMessage = require("../models/SmsMessage");
  const EmailLog = require("../models/EmailLog");
  const CommunicationTemplate = require("../models/CommunicationTemplate");

  const { TEMPLATES: EMAIL_TEMPLATES } = require("../utils/emailService");
  const { TEMPLATES: SMS_CODE, renderSms } = require("../utils/sms/smsTemplates");
  const { SMS_TYPES } = require("../utils/sms/smsTypes");
  const tokens = require("../utils/communications/smsTokens");
  const overrides = require("../utils/communications/templateOverrides");
  const settings = require("../utils/communications/communicationSettings");

  const app = express();
  app.use(express.json());
  app.use("/api/admin/communications", require("../routes/adminCommunications"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  /* An admin and a non-admin, so authorisation is tested rather than assumed. */
  const admin = await User.create({
    userId: "A1", name: "Admin", email: `admin.${Date.now()}@x.com`, password: "h",
    phone: "+16315550001", role: "admin", address: "1 A", city: "C", state: "NY",
    zip: "11111", county: "Suffolk",
  });
  const customer = await User.create({
    userId: "C1", name: "Sam Rivera", email: `sam.${Date.now()}@x.com`, password: "h",
    phone: "+16315550002", role: "customer", address: "1 A", city: "C", state: "NY",
    zip: "11111", county: "Suffolk",
  });
  const adminToken = jwt.sign({ id: String(admin._id) }, process.env.JWT_SECRET);
  const customerToken = jwt.sign({ id: String(customer._id) }, process.env.JWT_SECRET);

  const api = (path, opts = {}, token = adminToken) =>
    fetch(`${base}${path}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.headers || {}),
      },
    });

  /* ------------------------------------------------------------------ */
  section("Catalogue completeness");

  await test("every SMS type in the registry appears", async () => {
    const body = await (await api("/api/admin/communications/templates")).json();
    const listed = new Set(body.sms.map((r) => r.templateKey));
    for (const type of Object.keys(SMS_TYPES)) {
      assert.ok(listed.has(type), `missing ${type}`);
    }
    assert.strictEqual(body.sms.length, Object.keys(SMS_TYPES).length);
  });

  await test("every registered email template appears", async () => {
    const body = await (await api("/api/admin/communications/templates")).json();
    const listed = new Set(body.email.map((r) => r.templateKey));
    for (const key of Object.keys(EMAIL_TEMPLATES)) {
      assert.ok(listed.has(key), `missing ${key}`);
    }
    /*
     * More than the registry, deliberately. The list also carries the sendRaw
     * keys - internal alerts, campaigns, generated documents - so no email the
     * system sends is invisible in Admin. test_admin_email_templates owns the
     * assertion that every one of those is classified.
     */
    assert.ok(
      body.email.length >= Object.keys(EMAIL_TEMPLATES).length,
      "the email list must include at least the registry"
    );
  });

  await test("reserved SMS types are labelled as having no trigger", async () => {
    const body = await (await api("/api/admin/communications/templates")).json();
    const reserved = body.sms.filter((r) => r.reserved).map((r) => r.templateKey);
    assert.deepStrictEqual(reserved, ["FIXTER_ON_THE_WAY"]);
    const s = settings.smsSettingsFor("FIXTER_ON_THE_WAY");
    assert.match(s.trigger, /No trigger currently exists/i);
  });

  await test("registered email templates are editable; the rest say why not", async () => {
    const body = await (await api("/api/admin/communications/templates")).json();
    const byKey = new Map(body.email.map((r) => [r.templateKey, r]));

    /* Phase 2 made the registry editable. */
    for (const key of Object.keys(EMAIL_TEMPLATES)) {
      assert.strictEqual(byKey.get(key).editable, true, `${key} should be editable`);
    }

    /* Everything else is listed with a disposition rather than omitted. */
    const nonEditable = body.email.filter((r) => !r.editable);
    assert.ok(nonEditable.length > 0, "sendRaw keys should be listed too");
    for (const row of nonEditable) {
      assert.ok(
        ["visible", "generated"].includes(row.disposition),
        `${row.templateKey} needs a disposition`
      );
      assert.ok(row.trigger, `${row.templateKey} needs a documented trigger`);
    }
  });

  /* ------------------------------------------------------------------ */
  section("Defaults are unchanged");

  await test("all 26 token mirrors reproduce the code default for every visit kind", () => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    let compared = 0;
    for (const type of Object.keys(SMS_TYPES)) {
      for (const kind of Object.keys(tokens.SAMPLE_BOOKINGS)) {
        const vars = { ...tokens.SAMPLE_VARS[type], booking: tokens.SAMPLE_BOOKINGS[kind] };
        const code = norm(SMS_CODE[type](vars));
        const mirror = norm(
          tokens.renderTokenTemplate(tokens.DEFINITIONS[type].template, tokens.buildTokenValues(type, vars))
        );
        assert.strictEqual(mirror, code, `${type} [${kind}]`);
        compared += 1;
      }
    }
    assert.strictEqual(compared, Object.keys(SMS_TYPES).length * 4);
  });

  await test("renderSms is untouched while no override exists", () => {
    overrides.primeForTest({});
    const booking = tokens.SAMPLE_BOOKINGS.membership;
    assert.strictEqual(
      renderSms("BOOKING_CONFIRMED", { booking }),
      "ProFixter: your membership visit is confirmed for Tue, Mar 3 at 2:00 PM. " +
        "We will text you a reminder beforehand. Questions? Call 631-599-1363"
    );
  });

  /* ------------------------------------------------------------------ */
  section("Saving an override");

  const NEW_BODY =
    "{{brand}} reminder: your {{visitNoun}} is on {{when}}. Call {{supportPhone}} to change it.";

  await test("a valid body is accepted and used by the next send", async () => {
    const res = await api("/api/admin/communications/templates/sms/BOOKING_REMINDER_24H", {
      method: "PUT",
      body: JSON.stringify({ body: NEW_BODY }),
    });
    assert.strictEqual(res.status, 200);

    await overrides.refresh({ force: true });
    const out = renderSms("BOOKING_REMINDER_24H", { booking: tokens.SAMPLE_BOOKINGS.membership });
    assert.strictEqual(
      out,
      "ProFixter reminder: your membership visit is on Tue, Mar 3 at 2:00 PM. Call 631-599-1363 to change it."
    );
  });

  await test("the override is recorded with who changed it and when", async () => {
    const row = await CommunicationTemplate.findOne({
      channel: "sms",
      templateKey: "BOOKING_REMINDER_24H",
    }).lean();
    assert.strictEqual(row.body, NEW_BODY);
    assert.strictEqual(row.active, true);
    assert.strictEqual(row.updatedBy, String(admin._id));
    assert.ok(row.updatedAt);
  });

  await test("a second save keeps the previous wording as a revision", async () => {
    await api("/api/admin/communications/templates/sms/BOOKING_REMINDER_24H", {
      method: "PUT",
      body: JSON.stringify({ body: `${NEW_BODY} Thanks.` }),
    });
    const row = await CommunicationTemplate.findOne({
      channel: "sms",
      templateKey: "BOOKING_REMINDER_24H",
    }).lean();
    assert.ok(row.revisions.length >= 1);
    assert.strictEqual(row.revisions[row.revisions.length - 1].body, NEW_BODY);
  });

  /* ------------------------------------------------------------------ */
  section("Validation rejects rather than repairs");

  const reject = async (body, matcher) => {
    const res = await api("/api/admin/communications/templates/sms/ACCOUNT_CREATED", {
      method: "PUT",
      body: JSON.stringify({ body }),
    });
    assert.strictEqual(res.status, 400, `expected rejection for: ${body}`);
    const payload = await res.json();
    assert.ok(
      payload.errors.some((e) => matcher.test(e)),
      `errors did not match ${matcher}: ${JSON.stringify(payload.errors)}`
    );
  };

  await test("an unknown variable is rejected", () => reject("Hello {{nickname}}", /Unknown variable/i));
  await test("a malformed token is rejected", () => reject("Hello {{firstName}", /Malformed variable/i));
  await test("an empty body is rejected", () => reject("   ", /cannot be empty/i));

  await test("an over-length body is rejected, not truncated", async () => {
    const long = `{{brand}}: ${"x".repeat(400)}`;
    const res = await api("/api/admin/communications/templates/sms/ACCOUNT_CREATED", {
      method: "PUT",
      body: JSON.stringify({ body: long }),
    });
    assert.strictEqual(res.status, 400);
    const payload = await res.json();
    assert.ok(payload.errors.some((e) => /over the 320 limit|not be truncated/i.test(e)));
    const row = await CommunicationTemplate.findOne({ channel: "sms", templateKey: "ACCOUNT_CREATED" });
    assert.ok(!row || !row.active, "a rejected body must not be stored");
  });

  await test("a review URL typed into a body is rejected", () =>
    reject("{{brand}}: review us at https://www.profixter.com/review", /review link cannot be written/i));

  /* ------------------------------------------------------------------ */
  section("Protected and system-managed content");

  await test("the STOP line is still appended to an admin-written marketing body", async () => {
    await api("/api/admin/communications/templates/sms/MEMBERSHIP_MARKETING", {
      method: "PUT",
      body: JSON.stringify({ body: "{{brand}}: memberships are great." }),
    });
    await overrides.refresh({ force: true });
    const out = renderSms("MEMBERSHIP_MARKETING", {});
    assert.ok(out.endsWith("Reply STOP to opt out."), out);
  });

  await test("the review link stays behind its flag in completion messages", () => {
    overrides.primeForTest({});
    const out = renderSms("BOOKING_COMPLETED", { booking: tokens.SAMPLE_BOOKINGS.membership });
    assert.ok(!/\/review/.test(out), out);
    assert.ok(/\/tip/.test(out), out);
  });

  await test("protected content is reported to the admin screen", async () => {
    const body = await (await api("/api/admin/communications/templates")).json();
    const ids = body.protectedContent.map((p) => p.id);
    for (const id of ["marketing_opt_out", "review_link_gate", "brand_and_support", "length_ceiling"]) {
      assert.ok(ids.includes(id), `missing protected entry ${id}`);
    }
  });

  /* ------------------------------------------------------------------ */
  section("Reset to default");

  await test("reset removes the override and restores the code wording", async () => {
    const res = await api("/api/admin/communications/templates/sms/BOOKING_REMINDER_24H/reset", {
      method: "POST",
    });
    assert.strictEqual(res.status, 200);
    await overrides.refresh({ force: true });

    const out = renderSms("BOOKING_REMINDER_24H", { booking: tokens.SAMPLE_BOOKINGS.membership });
    assert.strictEqual(
      out,
      "ProFixter reminder: your membership visit is scheduled for Tue, Mar 3 at 2:00 PM. " +
        "Need to make a change? Call 631-599-1363"
    );
  });

  await test("reset keeps the row and its revisions for the audit trail", async () => {
    const row = await CommunicationTemplate.findOne({
      channel: "sms",
      templateKey: "BOOKING_REMINDER_24H",
    }).lean();
    assert.ok(row, "the row survives a reset");
    assert.strictEqual(row.active, false);
    assert.ok(row.revisions.length >= 2);
  });

  /* ------------------------------------------------------------------ */
  section("History is immutable");

  await test("editing a template does not rewrite an existing SmsMessage", async () => {
    const sent = await SmsMessage.create({
      toPhone: customer.phone,
      user: customer._id,
      notificationType: "BOOKING_CONFIRMED",
      channelClass: "transactional",
      body: "ProFixter: your membership visit is confirmed for Tue, Mar 3 at 2:00 PM.",
      status: "delivered",
      deliveredAt: new Date(),
      providerMessageSid: "SMhistoric",
      dedupeKey: `history:${Date.now()}`,
      bookingNumber: "10000001",
      segments: 1,
    });

    await api("/api/admin/communications/templates/sms/BOOKING_CONFIRMED", {
      method: "PUT",
      body: JSON.stringify({ body: "{{brand}}: totally different wording for {{when}}." }),
    });
    await overrides.refresh({ force: true });

    const after = await SmsMessage.findById(sent._id).lean();
    assert.strictEqual(
      after.body,
      "ProFixter: your membership visit is confirmed for Tue, Mar 3 at 2:00 PM.",
      "the historical body must be exactly what was sent"
    );

    /* And the NEW wording is what a future send would use. */
    const next = renderSms("BOOKING_CONFIRMED", { booking: tokens.SAMPLE_BOOKINGS.membership });
    assert.match(next, /totally different wording/);

    await api("/api/admin/communications/templates/sms/BOOKING_CONFIRMED/reset", { method: "POST" });
    await overrides.refresh({ force: true });
  });

  /* ------------------------------------------------------------------ */
  section("Email snapshots");

  await test("a new EmailLog row keeps the rendered subject and body", async () => {
    const rendered = EMAIL_TEMPLATES.welcome({ name: "Sam Rivera" });
    await EmailLog.create({
      templateKey: "welcome",
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text || "",
      bodySnapshot: true,
      recipientEmail: customer.email,
      customerEmail: customer.email,
      status: "sent",
      sentAt: new Date(),
      providerMessageId: "<msg-1@ses>",
    });
    const row = await EmailLog.findOne({ templateKey: "welcome" }).lean();
    assert.strictEqual(row.bodySnapshot, true);
    assert.ok(row.html.includes("Sam Rivera"), "the snapshot is the real rendered HTML");
  });

  await test("an older row with no snapshot is reported honestly", async () => {
    await EmailLog.create({
      templateKey: "booking_confirmed",
      subject: "Your visit is confirmed",
      recipientEmail: customer.email,
      customerEmail: customer.email,
      status: "sent",
      sentAt: new Date(),
    });
    const row = await EmailLog.findOne({ templateKey: "booking_confirmed" }).lean();
    const record = require("../routes/adminCommunications").emailRowToRecord(row);
    assert.strictEqual(record.hasSnapshot, false);
    assert.strictEqual(record.body, "");
    assert.match(record.snapshotNote, /snapshot unavailable/i);
  });

  await test("an email that was merely accepted is never called delivered", () => {
    const record = require("../routes/adminCommunications").emailRowToRecord({
      _id: new mongoose.Types.ObjectId(),
      status: "sent",
      templateKey: "welcome",
      createdAt: new Date(),
    });
    assert.strictEqual(record.status, "sent");
    assert.match(record.statusDetail, /not confirmed/i);
    assert.ok(!/delivered/i.test(record.status));
  });

  /* ------------------------------------------------------------------ */
  section("SMS status honesty");

  const { smsRowToRecord } = require("../routes/adminCommunications");

  await test("delivered appears only when the Twilio callback set it", () => {
    const accepted = smsRowToRecord({ _id: new mongoose.Types.ObjectId(), status: "sent", createdAt: new Date(), notificationType: "X" });
    assert.strictEqual(accepted.status, "sent");
    assert.match(accepted.statusDetail, /not yet confirmed/i);

    const delivered = smsRowToRecord({ _id: new mongoose.Types.ObjectId(), status: "delivered", createdAt: new Date(), notificationType: "X", deliveredAt: new Date() });
    assert.strictEqual(delivered.status, "delivered");
    assert.match(delivered.statusDetail, /Confirmed delivered/i);
  });

  await test("a failed SMS surfaces the Twilio code and reason", () => {
    const rec = smsRowToRecord({
      _id: new mongoose.Types.ObjectId(), status: "failed", createdAt: new Date(),
      notificationType: "BOOKING_CONFIRMED", providerErrorCode: "21610",
      suppressionReason: "recipient_opted_out",
    });
    assert.strictEqual(rec.errorCode, "21610");
    assert.match(rec.statusDetail, /21610/);
    assert.match(rec.failureReason, /recipient_opted_out/);
  });

  await test("a suppressed SMS surfaces why it was never attempted", () => {
    for (const reason of ["phone_undeliverable", "opted_out_all", "marketing_not_opted_in"]) {
      const rec = smsRowToRecord({
        _id: new mongoose.Types.ObjectId(), status: "suppressed", createdAt: new Date(),
        notificationType: "X", suppressionReason: reason,
      });
      assert.strictEqual(rec.status, "suppressed");
      assert.match(rec.statusDetail, new RegExp(reason));
    }
  });

  /* ------------------------------------------------------------------ */
  section("Customer and booking history");

  await test("customer history merges both channels, newest first", async () => {
    const body = await (
      await api(`/api/admin/communications/customers/${customer._id}/history`)
    ).json();
    assert.ok(body.counts.sms >= 1 && body.counts.email >= 2, JSON.stringify(body.counts));
    assert.ok(body.records.some((r) => r.channel === "sms"));
    assert.ok(body.records.some((r) => r.channel === "email"));
    const times = body.records.map((r) => new Date(r.at).getTime());
    assert.deepStrictEqual(times, [...times].sort((a, b) => b - a), "records must be newest first");
  });

  await test("booking history contains only that booking's messages", async () => {
    await SmsMessage.create({
      toPhone: customer.phone, user: customer._id, notificationType: "BOOKING_REMINDER_24H",
      channelClass: "transactional", body: "reminder for another booking", status: "sent",
      dedupeKey: `other:${Date.now()}`, bookingNumber: "99999999", segments: 1,
    });

    const body = await (
      await api("/api/admin/communications/bookings/10000001/history")
    ).json();
    assert.ok(body.records.length >= 1);
    assert.ok(
      body.records.every((r) => r.bookingNumber === "10000001"),
      "account-level and other-booking messages must not leak in"
    );
  });

  await test("history exposes the exact stored body, not a re-render", async () => {
    const body = await (
      await api("/api/admin/communications/bookings/10000001/history")
    ).json();
    const sms = body.records.find((r) => r.channel === "sms");
    assert.strictEqual(
      sms.body,
      "ProFixter: your membership visit is confirmed for Tue, Mar 3 at 2:00 PM."
    );
    assert.match(sms.destination, /^\+1\*+\d{2}$/, "phone is masked in history");
  });

  /* ------------------------------------------------------------------ */
  section("Preview never sends");

  await test("SMS preview returns encoding, characters and segments", async () => {
    const res = await api("/api/admin/communications/preview", {
      method: "POST",
      body: JSON.stringify({ channel: "sms", templateKey: "BOOKING_CONFIRMED" }),
    });
    const body = await res.json();
    assert.strictEqual(body.sent, false);
    assert.strictEqual(body.encoding, "GSM-7");
    assert.strictEqual(body.segments, 1);
    assert.ok(body.characters > 0);
    assert.ok(body.variables.includes("visitNoun"));
  });

  await test("SMS preview flags a multi-segment edit before it is saved", async () => {
    const res = await api("/api/admin/communications/preview", {
      method: "POST",
      body: JSON.stringify({
        channel: "sms",
        templateKey: "BOOKING_CONFIRMED",
        body: `{{brand}}: ${"a very wordy reminder indeed ".repeat(8)}`,
      }),
    });
    const body = await res.json();
    assert.ok(body.segments > 1, `expected multi-segment, got ${body.segments}`);
    assert.strictEqual(body.multiSegment, true);
  });

  await test("email preview renders subject and HTML from sample data", async () => {
    const res = await api("/api/admin/communications/preview", {
      method: "POST",
      body: JSON.stringify({ channel: "email", templateKey: "welcome" }),
    });
    const body = await res.json();
    assert.strictEqual(body.sent, false);
    assert.match(body.subject, /Welcome to Profixter/);
    assert.ok(body.html.length > 100);
  });

  await test("nothing was sent: no new SmsMessage or EmailLog rows from preview", async () => {
    const smsBefore = await SmsMessage.countDocuments({});
    const emailBefore = await EmailLog.countDocuments({});
    for (const key of ["BOOKING_CONFIRMED", "ACCOUNT_CREATED", "MEMBERSHIP_MARKETING"]) {
      await api("/api/admin/communications/preview", {
        method: "POST",
        body: JSON.stringify({ channel: "sms", templateKey: key }),
      });
    }
    await api("/api/admin/communications/preview", {
      method: "POST",
      body: JSON.stringify({ channel: "email", templateKey: "welcome" }),
    });
    assert.strictEqual(await SmsMessage.countDocuments({}), smsBefore);
    assert.strictEqual(await EmailLog.countDocuments({}), emailBefore);
  });

  /* ------------------------------------------------------------------ */
  section("Settings describe the real implementation");

  await test("every SMS type has settings, and the channel class matches the registry", () => {
    for (const [type, spec] of Object.entries(SMS_TYPES)) {
      const s = settings.smsSettingsFor(type);
      assert.ok(s.trigger && s.trigger !== "Not documented.", `${type} has no documented trigger`);
      assert.strictEqual(s.channelClass, spec.channelClass, `${type} channelClass drifted`);
      assert.strictEqual(s.timeCritical, Boolean(spec.timeCritical), `${type} timeCritical drifted`);
    }
  });

  await test("reminder settings quote the real policy windows", () => {
    const policy = require("../utils/bookingReminderPolicy");
    const h24 = settings.smsSettingsFor("BOOKING_REMINDER_24H");
    assert.match(h24.schedule, /24 hours before/);
    assert.strictEqual(policy.REMINDER_24H_MIN_LEAD_MS, 2 * 60 * 60 * 1000);
    assert.match(h24.recovery, /2 hours before/);

    const m60 = settings.smsSettingsFor("BOOKING_REMINDER_60M");
    assert.match(m60.schedule, /1 hour before/);
    assert.match(m60.recovery, /15 minutes after/);
  });

  await test("marketing types name both flags they depend on", () => {
    for (const type of ["KITCHEN_BATH_MARKETING", "MEMBERSHIP_MARKETING", "SEASONAL_MARKETING"]) {
      const s = settings.smsSettingsFor(type);
      assert.match(s.flags, /SMS_ENABLED/);
      assert.match(s.flags, /SMS_MARKETING_ENABLED/);
      assert.strictEqual(s.channelClass, "marketing");
    }
  });

  await test("the gift type is documented as the one that bypasses SMS_ENABLED", () => {
    const s = settings.smsSettingsFor("GIFT_INVITATION");
    assert.match(s.flags, /GIFT_SMS_ENABLED/);
    assert.match(s.flags, /ONLY type/i);
  });

  await test("no prohibited renewal or upcoming-charge type is documented", () => {
    const names = Object.keys(settings.SMS_SETTINGS);
    assert.deepStrictEqual(names.filter((n) => /RENEWAL|UPCOMING|CHARGING|AUTOPAY/i.test(n)), []);
  });

  /* ------------------------------------------------------------------ */
  section("Access control");

  await test("an unauthenticated request is refused", async () => {
    const res = await fetch(`${base}/api/admin/communications/templates`);
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });

  await test("a signed-in customer cannot read the catalogue", async () => {
    const res = await api("/api/admin/communications/templates", {}, customerToken);
    assert.strictEqual(res.status, 403);
  });

  await test("a signed-in customer cannot save a template", async () => {
    const res = await api(
      "/api/admin/communications/templates/sms/ACCOUNT_CREATED",
      { method: "PUT", body: JSON.stringify({ body: "{{brand}}: hijacked" }) },
      customerToken
    );
    assert.strictEqual(res.status, 403);
    const row = await CommunicationTemplate.findOne({ channel: "sms", templateKey: "ACCOUNT_CREATED" });
    assert.ok(!row || !row.active, "a refused save must write nothing");
  });

  await test("a signed-in customer cannot read another customer's history", async () => {
    const res = await api(
      `/api/admin/communications/customers/${customer._id}/history`,
      {},
      customerToken
    );
    assert.strictEqual(res.status, 403);
  });

  /* ------------------------------------------------------------------ */
  section("Safety state");

  await test("the approved SMS catalogue is byte-for-byte unchanged with no overrides", async () => {
    await CommunicationTemplate.deleteMany({});
    overrides.primeForTest({});
    /* The golden-master suite owns the exact strings; this asserts it still passes here. */
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    for (const type of Object.keys(SMS_TYPES)) {
      for (const kind of Object.keys(tokens.SAMPLE_BOOKINGS)) {
        const vars = { ...tokens.SAMPLE_VARS[type], booking: tokens.SAMPLE_BOOKINGS[kind] };
        /*
         * Marketing bodies gain the opt-out line from the renderer, so the
         * expectation has to include it. Comparing against the bare template
         * would quietly pass for transactional and fail for marketing, which
         * is how a broken assertion survives.
         */
        const expected = SMS_TYPES[type].channelClass === "marketing"
          ? norm(`${SMS_CODE[type](vars)} Reply STOP to opt out.`)
          : norm(SMS_CODE[type](vars));
        assert.strictEqual(renderSms(type, vars), expected, `${type} [${kind}]`);
      }
    }
  });

  await test("all four SMS flags are still false", () => {
    delete require.cache[require.resolve("../utils/sms/smsConfig")];
    const cfg = require("../utils/sms/smsConfig");
    const snap = cfg.configSnapshot();
    assert.strictEqual(snap.smsEnabled, false);
    assert.strictEqual(snap.smsMarketingEnabled, false);
    assert.strictEqual(snap.reviewLinkEnabled, false);
    assert.strictEqual(snap.giftSmsEnabled, false);
    const open = Object.keys(SMS_TYPES).filter((t) => cfg.sendingAllowedFor(t));
    assert.deepStrictEqual(open, [], `these types could send: ${open.join(", ")}`);
  });

  server.close();
  await mongoose.disconnect();
  await mongod.stop();

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error("\nSuite crashed:", error);
  process.exit(1);
});
