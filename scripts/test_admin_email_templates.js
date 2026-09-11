/**
 * Phase 2: admin-editable email templates.
 *
 * THE ONE PROPERTY EVERYTHING ELSE DEPENDS ON
 *
 * With no override stored, all 34 registered templates must render exactly as
 * they did before this feature existed. Phase 2 adds an editor; it must not
 * change a single customer email merely by making one editable. That is
 * asserted first, byte for byte, against a snapshot taken from the code
 * templates themselves.
 *
 * AFTER THAT, THE INTERESTING RISKS ARE SECURITY-SHAPED
 *
 * An email body stored in a database and rendered into mail we send under our
 * own domain is a genuinely dangerous idea if done carelessly. So: nothing an
 * admin types survives as markup, links can only be https, and the emails whose
 * entire purpose is to carry a secure action - a password code, a gift claim
 * link - cannot be saved with that action removed. Each of those is asserted
 * against real rendering rather than by reading the validator's opinion of
 * itself.
 */

const assert = require("assert");
const express = require("express");
const mongoose = require("mongoose");
const fetch = require("node-fetch");
const jwt = require("jsonwebtoken");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-not-real";
for (const flag of ["SMS_ENABLED", "SMS_MARKETING_ENABLED", "SMS_REVIEW_LINK_ENABLED", "GIFT_SMS_ENABLED"]) {
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
  const EmailLog = require("../models/EmailLog");
  const CommunicationTemplate = require("../models/CommunicationTemplate");

  const emailService = require("../utils/emailService");
  const { TEMPLATES } = emailService;
  const overrides = require("../utils/communications/templateOverrides");
  const markup = require("../utils/communications/emailMarkup");
  const { EMAIL_DEFINITIONS, SAMPLE_EMAIL_VARS, emailTokenNames, protectedTokensFor } =
    require("../utils/communications/emailTokens");
  const { NON_REGISTRY_EMAILS, nonRegistryEntry } = require("../utils/communications/emailCatalogue");

  const app = express();
  app.use(express.json());
  app.use("/api/admin/communications", require("../routes/adminCommunications"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const admin = await User.create({
    userId: "A1", name: "Admin", email: `admin.${Date.now()}@x.com`, password: "h",
    phone: "+16315550001", role: "admin", address: "1 A", city: "C", state: "NY", zip: "11111", county: "Suffolk",
  });
  const customer = await User.create({
    userId: "C1", name: "Sam Rivera", email: `sam.${Date.now()}@x.com`, password: "h",
    phone: "+16315550002", role: "customer", address: "1 A", city: "C", state: "NY", zip: "11111", county: "Suffolk",
  });
  const adminToken = jwt.sign({ id: String(admin._id) }, process.env.JWT_SECRET);
  const customerToken = jwt.sign({ id: String(customer._id) }, process.env.JWT_SECRET);

  const api = (path, opts = {}, token = adminToken) =>
    fetch(`${base}${path}`, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
    });

  /* ------------------------------------------------------------------ */
  section("Defaults are untouched");

  /* Snapshot taken with no override in force, straight from the code templates. */
  overrides.primeForTest({}, {});
  const GOLDEN = {};
  for (const key of Object.keys(TEMPLATES)) {
    GOLDEN[key] = TEMPLATES[key](SAMPLE_EMAIL_VARS);
  }

  await test("all 34 registered templates render byte-identically with no override", () => {
    overrides.primeForTest({}, {});
    let compared = 0;
    for (const key of Object.keys(TEMPLATES)) {
      const now = TEMPLATES[key](SAMPLE_EMAIL_VARS);
      assert.strictEqual(now.subject, GOLDEN[key].subject, `${key} subject`);
      assert.strictEqual(now.html, GOLDEN[key].html, `${key} html`);
      compared += 1;
    }
    assert.strictEqual(compared, 34);
  });

  await test("the override module is inert until something is saved", () => {
    overrides.primeForTest({}, {});
    for (const key of Object.keys(TEMPLATES)) {
      assert.strictEqual(overrides.hasEmailOverride(key), false);
      assert.strictEqual(overrides.renderEmailOverride(key, SAMPLE_EMAIL_VARS), null);
    }
  });

  /* ------------------------------------------------------------------ */
  section("Catalogue");

  await test("every registered template is listed and marked editable", async () => {
    const body = await (await api("/api/admin/communications/templates?channel=email")).json();
    const byKey = new Map(body.email.map((r) => [r.templateKey, r]));
    for (const key of Object.keys(TEMPLATES)) {
      assert.ok(byKey.has(key), `missing ${key}`);
      assert.strictEqual(byKey.get(key).editable, true, `${key} should be editable`);
    }
  });

  await test("every non-registry email key is listed with a disposition", async () => {
    const body = await (await api("/api/admin/communications/templates?channel=email")).json();
    const byKey = new Map(body.email.map((r) => [r.templateKey, r]));
    for (const key of Object.keys(NON_REGISTRY_EMAILS)) {
      assert.ok(byKey.has(key), `missing ${key}`);
      const row = byKey.get(key);
      assert.ok(["visible", "generated"].includes(row.disposition), `${key} disposition`);
      assert.ok(["A", "B", "C"].includes(row.category), `${key} category`);
      assert.ok(row.trigger, `${key} has no trigger`);
    }
  });

  await test("NO MYSTERY EMAIL: every templateKey in the codebase is classified", () => {
    /*
     * Walk the source rather than shelling out. This has to run identically on
     * a Windows checkout and in CI, and a grep that silently found nothing
     * would turn the whole assertion into a rubber stamp.
     */
    const fs = require("fs");
    const path = require("path");
    const root = path.join(__dirname, "..");
    const found = new Set();
    const KEY_LITERAL = /templateKey:\s*["']([^"']+)["']/g;

    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) {
          const src = fs.readFileSync(full, "utf8");
          for (const m of src.matchAll(KEY_LITERAL)) found.add(m[1]);
        }
      }
    };
    for (const dir of ["utils", "routes", "jobs"]) walk(path.join(root, dir));

    const keys = [...found];
    assert.ok(keys.length > 20, `expected to find many keys, found ${keys.length}`);

    const unclassified = keys.filter((k) => !TEMPLATES[k] && !nonRegistryEntry(k));
    assert.deepStrictEqual(
      unclassified,
      [],
      `these email keys are sent but appear nowhere in Communications: ${unclassified.join(", ")}`
    );
  });

  await test("generated documents are marked generated, not editable", async () => {
    const body = await (await api("/api/admin/communications/templates?channel=email")).json();
    const byKey = new Map(body.email.map((r) => [r.templateKey, r]));
    for (const key of [
      "premium_island_contract",
      "premium_island_change_order",
      "premium_island_invoice",
      "premium_island_paid_invoice",
      "native_signature_completed",
    ]) {
      const row = byKey.get(key);
      assert.strictEqual(row.disposition, "generated", key);
      assert.strictEqual(row.editable, false, key);
      assert.ok(row.protectedNote, `${key} must explain why`);
    }
  });

  /* ------------------------------------------------------------------ */
  section("Editing an email");

  const NEW_SUBJECT = "Welcome aboard, {{firstName}}";
  const NEW_BODY =
    "# Hi {{firstName}}\n\nYou are all set with {{brand}}.\n\n- Book whenever you like\n- Cancel any time\n\n{{bookButton}}";

  await test("a valid subject and body are accepted", async () => {
    const res = await api("/api/admin/communications/templates/email/welcome", {
      method: "PUT",
      body: JSON.stringify({ subject: NEW_SUBJECT, body: NEW_BODY }),
    });
    assert.strictEqual(res.status, 200, JSON.stringify(await res.json()));
  });

  await test("the next send uses the saved version", async () => {
    await overrides.refresh({ force: true });
    const rendered = TEMPLATES.welcome; // unchanged code default
    const out = overrides.renderEmailOverride("welcome", SAMPLE_EMAIL_VARS);
    assert.ok(out, "override should render");
    assert.strictEqual(out.subject, "Welcome aboard, Sam");
    assert.ok(out.html.includes("Hi Sam"), "body content rendered");
    assert.notStrictEqual(out.html, rendered(SAMPLE_EMAIL_VARS).html, "should differ from the default");
  });

  await test("the branded frame survives the edit", async () => {
    const out = overrides.renderEmailOverride("welcome", SAMPLE_EMAIL_VARS);
    /* Header wordmark, tagline and the frame's table shell all still present. */
    assert.ok(out.html.includes("Long Island Home Maintenance"), "header tagline");
    assert.ok(out.html.includes("max-width:640px"), "frame width");
    assert.ok(out.html.includes('role="presentation"'), "frame table");
  });

  await test("markup becomes our own styled HTML, list and button included", () => {
    const out = overrides.renderEmailOverride("welcome", SAMPLE_EMAIL_VARS);
    assert.ok(out.html.includes("<h2"), "heading");
    assert.ok(out.html.includes("<ul"), "list");
    assert.ok(out.html.includes("<li"), "list item");
    assert.ok(out.html.includes("Book your first visit"), "system button label");
  });

  await test("plain text is derived from the rendered HTML", () => {
    const out = overrides.renderEmailOverride("welcome", SAMPLE_EMAIL_VARS);
    assert.ok(out.text.length > 20);
    assert.ok(!out.text.includes("<"), "text part must not contain markup");
  });

  await test("resetting returns the code default immediately", async () => {
    const res = await api("/api/admin/communications/templates/email/welcome/reset", { method: "POST" });
    assert.strictEqual(res.status, 200);
    await overrides.refresh({ force: true });
    assert.strictEqual(overrides.renderEmailOverride("welcome", SAMPLE_EMAIL_VARS), null);
    assert.strictEqual(TEMPLATES.welcome(SAMPLE_EMAIL_VARS).html, GOLDEN.welcome.html);
  });

  /* ------------------------------------------------------------------ */
  section("Validation");

  const rejectEmail = async (subject, body, matcher, key = "welcome") => {
    const res = await api(`/api/admin/communications/templates/email/${key}`, {
      method: "PUT",
      body: JSON.stringify({ subject, body }),
    });
    assert.strictEqual(res.status, 400, `expected rejection for: ${body}`);
    const payload = await res.json();
    assert.ok(
      payload.errors.some((e) => matcher.test(e)),
      `errors did not match ${matcher}: ${JSON.stringify(payload.errors)}`
    );
  };

  await test("unknown variables are rejected", () =>
    rejectEmail("Hi", "Hello {{nickname}}", /Unknown variable/i));
  await test("malformed tokens are rejected", () =>
    rejectEmail("Hi", "Hello {{firstName}", /Malformed variable/i));
  await test("an empty body is rejected", () => rejectEmail("Hi", "   ", /body cannot be empty/i));
  await test("an empty subject is rejected", () => rejectEmail("  ", "Hello", /subject cannot be empty/i));
  await test("raw HTML is rejected", () =>
    rejectEmail("Hi", "<b>bold</b> and <script>alert(1)</script>", /HTML tags are not allowed/i));
  await test("a non-https link target is rejected", () =>
    rejectEmail("Hi", "[click](http://evil.test)", /not allowed/i));
  await test("a javascript: link target is rejected", () =>
    rejectEmail("Hi", "[click](javascript:alert(1))", /not allowed/i));

  await test("a non-editable template cannot be saved", async () => {
    const res = await api("/api/admin/communications/templates/email/premium_island_contract", {
      method: "PUT",
      body: JSON.stringify({ subject: "x", body: "y" }),
    });
    assert.strictEqual(res.status, 404);
  });

  /* ------------------------------------------------------------------ */
  section("Security-critical actions cannot be removed");

  await test("a password reset without its code is rejected", () =>
    rejectEmail("Your code", "# Hi {{firstName}}\n\nSomebody asked to reset your password.", /verificationCode/, "password_otp"));

  await test("a gift invitation without its claim button is rejected", () =>
    rejectEmail("A gift for you", "# Hi {{firstName}}\n\n{{fromName}} sent you something.", /giftClaimButton/, "gift_invitation"));

  await test("a payment-failed email without its account button is rejected", () =>
    rejectEmail("Payment problem", "# Hi {{firstName}}\n\nYour card was declined.", /accountButton/, "payment_failed"));

  await test("the code itself is system-rendered and carries the real value", async () => {
    const res = await api("/api/admin/communications/templates/email/password_otp", {
      method: "PUT",
      body: JSON.stringify({
        subject: "Your {{brand}} code",
        body: "# Hi {{firstName}}\n\nHere is your code.\n\n{{verificationCode}}\n\nIt expires in five minutes.",
      }),
    });
    assert.strictEqual(res.status, 200, JSON.stringify(await res.json()));
    await overrides.refresh({ force: true });

    const out = overrides.renderEmailOverride("password_otp", { ...SAMPLE_EMAIL_VARS, otp: "987654" });
    assert.ok(out.html.includes("987654"), "the real code is rendered");
    assert.ok(out.html.includes("letter-spacing:4px"), "as the system-styled block");

    await api("/api/admin/communications/templates/email/password_otp/reset", { method: "POST" });
    await overrides.refresh({ force: true });
  });

  await test("a claim URL cannot be retargeted by an admin", async () => {
    /* The only way to emit the button is the token; a typed link cannot reach the claim host. */
    const values = require("../utils/communications/emailTokens").buildEmailTokens("gift_invitation", {
      ...SAMPLE_EMAIL_VARS,
      claimUrl: "https://www.profixter.com/gift/claim/real-token",
    });
    const rendered = markup.renderBody("{{giftClaimButton}}", values);
    assert.ok(rendered.includes("gift/claim/real-token"), "system button carries the real URL");

    /*
     * The guarantee is about the ACTION, not a ban on links.
     *
     * An admin writing copy can link to an https page, exactly as they can
     * write misleading prose - that is editorial trust, and it is the same
     * trust that lets them author the email at all. What they cannot do is
     * change where the claim BUTTON points, because its href is never part of
     * the editable content, nor delete it (asserted above).
     */
    const rerendered = markup.renderBody("Open it here:\n\n{{giftClaimButton}}", values);
    assert.ok(rerendered.includes("gift/claim/real-token"), "the button URL comes from the system");
    assert.ok(!/\{\{/.test(rerendered), "the token is consumed, not echoed to the customer");
    assert.strictEqual(
      (rerendered.match(/href="https:\/\/www\.profixter\.com\/gift\/claim\/real-token"/g) || []).length,
      1,
      "exactly one claim link, pointing where the system put it"
    );
  });

  /* ------------------------------------------------------------------ */
  section("Injection is neutralised at render time");

  await test("no admin input can emit a tag we did not build", () => {
    const values = require("../utils/communications/emailTokens").buildEmailTokens("welcome", SAMPLE_EMAIL_VARS);
    const ALLOWED = /<\/?(p|h2|ul|li|strong|br|a|div|table|tr|td|tbody)\b[^>]*>/gi;
    for (const attack of [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      '<a href="http://evil.test">steal</a>',
      "<style>body{}</style>",
      "<iframe src=http://evil.test></iframe>",
    ]) {
      const out = markup.renderBody(attack, values);
      const residual = out.replace(ALLOWED, "");
      assert.ok(!/<[a-zA-Z/!]/.test(residual), `rogue tag survived: ${attack} -> ${out}`);
      assert.strictEqual((out.match(/<a\b/g) || []).length, 0, `anchor emitted for: ${attack}`);
    }
  });

  await test("token values are escaped when they are customer data", () => {
    const values = require("../utils/communications/emailTokens").buildEmailTokens("welcome", {
      name: '<script>alert(1)</script>',
    });
    const out = markup.renderBody("Hello {{name}}", values);
    assert.ok(out.includes("&lt;script&gt;"), "a hostile name is escaped");
    assert.ok(!out.includes("<script>"), "and never emitted raw");
  });

  /* ------------------------------------------------------------------ */
  section("Preview never sends");

  await test("email preview renders a candidate through the real path", async () => {
    const res = await api("/api/admin/communications/preview", {
      method: "POST",
      body: JSON.stringify({
        channel: "email",
        templateKey: "welcome",
        subject: "Hi {{firstName}}",
        body: "# Hello {{firstName}}\n\nWelcome.",
      }),
    });
    const body = await res.json();
    assert.strictEqual(body.sent, false);
    assert.strictEqual(body.subject, "Hi Sam");
    assert.ok(body.html.includes("Long Island Home Maintenance"), "framed like a real send");
    assert.ok(body.text.length > 10);
  });

  await test("preview of a stored default still works with no override", async () => {
    const res = await api("/api/admin/communications/preview", {
      method: "POST",
      body: JSON.stringify({ channel: "email", templateKey: "booking_confirmed" }),
    });
    const body = await res.json();
    assert.strictEqual(body.sent, false);
    assert.ok(body.subject.length > 0);
    assert.ok(body.html.length > 200);
  });

  await test("no EmailLog row is created by previewing", async () => {
    const before = await EmailLog.countDocuments({});
    for (const key of ["welcome", "password_otp", "gift_invitation", "booking_confirmed"]) {
      await api("/api/admin/communications/preview", {
        method: "POST",
        body: JSON.stringify({ channel: "email", templateKey: key }),
      });
    }
    assert.strictEqual(await EmailLog.countDocuments({}), before);
  });

  /* ------------------------------------------------------------------ */
  section("History stays immutable");

  await test("editing a template does not rewrite an existing EmailLog row", async () => {
    const original = TEMPLATES.booking_confirmed(SAMPLE_EMAIL_VARS);
    const row = await EmailLog.create({
      templateKey: "booking_confirmed",
      subject: original.subject,
      html: original.html,
      text: original.text || "",
      bodySnapshot: true,
      recipientEmail: customer.email,
      customerEmail: customer.email,
      bookingNumber: "10000001",
      status: "sent",
      sentAt: new Date(),
    });

    await api("/api/admin/communications/templates/email/booking_confirmed", {
      method: "PUT",
      body: JSON.stringify({ subject: "Completely new subject", body: "# Totally different wording" }),
    });
    await overrides.refresh({ force: true });

    const after = await EmailLog.findById(row._id).lean();
    assert.strictEqual(after.subject, original.subject, "the historical subject is frozen");
    assert.strictEqual(after.html, original.html, "the historical body is frozen");

    /* And the new wording is what a future send would use. */
    const next = overrides.renderEmailOverride("booking_confirmed", SAMPLE_EMAIL_VARS);
    assert.strictEqual(next.subject, "Completely new subject");
  });

  await test("history exposes the frozen snapshot, not a re-render", async () => {
    const body = await (
      await api("/api/admin/communications/bookings/10000001/history")
    ).json();
    const record = body.records.find((r) => r.channel === "email");
    assert.ok(record.hasSnapshot);
    assert.ok(!record.subject.includes("Completely new subject"), "history must show what was sent");
  });

  /* ------------------------------------------------------------------ */
  section("Revisions and restore");

  await test("a previous version can be restored", async () => {
    const row = await CommunicationTemplate.findOne({ channel: "email", templateKey: "booking_confirmed" }).lean();
    assert.ok(row, "an override row exists");

    await api("/api/admin/communications/templates/email/booking_confirmed", {
      method: "PUT",
      body: JSON.stringify({ subject: "Second wording", body: "# Second body" }),
    });

    const withRevisions = await CommunicationTemplate.findOne({
      channel: "email", templateKey: "booking_confirmed",
    }).lean();
    const index = withRevisions.revisions.length - 1;
    assert.strictEqual(withRevisions.revisions[index].subject, "Completely new subject");

    const res = await api(
      `/api/admin/communications/templates/email/booking_confirmed/restore/${index}`,
      { method: "POST" }
    );
    const restored = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(restored));
    assert.strictEqual(restored.subject, "Completely new subject");
  });

  await test("cleanup: booking_confirmed is reset to default", async () => {
    await api("/api/admin/communications/templates/email/booking_confirmed/reset", { method: "POST" });
    await overrides.refresh({ force: true });
    assert.strictEqual(overrides.renderEmailOverride("booking_confirmed", SAMPLE_EMAIL_VARS), null);
    assert.strictEqual(TEMPLATES.booking_confirmed(SAMPLE_EMAIL_VARS).html, GOLDEN.booking_confirmed.html);
  });

  /* ------------------------------------------------------------------ */
  section("Variables are scoped per template");

  await test("each template offers only its own variables", () => {
    assert.ok(emailTokenNames("password_otp").includes("verificationCode"));
    assert.ok(!emailTokenNames("password_otp").includes("bookingWhen"), "no booking data on a password email");
    assert.ok(emailTokenNames("booking_confirmed").includes("bookingWhen"));
    assert.ok(!emailTokenNames("booking_confirmed").includes("verificationCode"));
    assert.ok(emailTokenNames("gift_invitation").includes("giftClaimButton"));
  });

  await test("protected tokens are reported for the editor", () => {
    assert.deepStrictEqual(protectedTokensFor("password_otp"), ["verificationCode"]);
    assert.deepStrictEqual(protectedTokensFor("gift_invitation"), ["giftClaimButton"]);
    assert.deepStrictEqual(protectedTokensFor("welcome"), []);
  });

  /* ------------------------------------------------------------------ */
  section("Access control");

  await test("a customer cannot save an email template", async () => {
    const res = await api(
      "/api/admin/communications/templates/email/welcome",
      { method: "PUT", body: JSON.stringify({ subject: "x", body: "# y" }) },
      customerToken
    );
    assert.strictEqual(res.status, 403);
  });

  await test("a customer cannot reset or restore", async () => {
    const reset = await api("/api/admin/communications/templates/email/welcome/reset", { method: "POST" }, customerToken);
    assert.strictEqual(reset.status, 403);
    const restore = await api("/api/admin/communications/templates/email/welcome/restore/0", { method: "POST" }, customerToken);
    assert.strictEqual(restore.status, 403);
  });

  await test("an unauthenticated request cannot preview", async () => {
    const res = await fetch(`${base}/api/admin/communications/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "email", templateKey: "welcome" }),
    });
    assert.ok(res.status === 401 || res.status === 403);
  });

  /* ------------------------------------------------------------------ */
  section("Nothing else moved");

  await test("SMS defaults are still byte-for-byte unchanged", () => {
    const { TEMPLATES: SMS_CODE, renderSms } = require("../utils/sms/smsTemplates");
    const { SMS_TYPES } = require("../utils/sms/smsTypes");
    const tokens = require("../utils/communications/smsTokens");
    overrides.primeForTest({}, {});
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    for (const type of Object.keys(SMS_TYPES)) {
      for (const kind of Object.keys(tokens.SAMPLE_BOOKINGS)) {
        const vars = { ...tokens.SAMPLE_VARS[type], booking: tokens.SAMPLE_BOOKINGS[kind] };
        const expected = SMS_TYPES[type].channelClass === "marketing"
          ? norm(`${SMS_CODE[type](vars)} Reply STOP to opt out.`)
          : norm(SMS_CODE[type](vars));
        assert.strictEqual(renderSms(type, vars), expected, `${type} [${kind}]`);
      }
    }
  });

  await test("all four SMS flags remain false", () => {
    delete require.cache[require.resolve("../utils/sms/smsConfig")];
    const cfg = require("../utils/sms/smsConfig");
    const snap = cfg.configSnapshot();
    assert.strictEqual(snap.smsEnabled, false);
    assert.strictEqual(snap.smsMarketingEnabled, false);
    assert.strictEqual(snap.reviewLinkEnabled, false);
    assert.strictEqual(snap.giftSmsEnabled, false);
  });

  await test("every registered template still renders after all of this", () => {
    overrides.primeForTest({}, {});
    for (const key of Object.keys(TEMPLATES)) {
      const out = TEMPLATES[key](SAMPLE_EMAIL_VARS);
      assert.strictEqual(out.html, GOLDEN[key].html, `${key} drifted`);
    }
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
