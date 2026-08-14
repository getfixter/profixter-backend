/**
 * Pre-deployment gate for the marketing engine.
 *
 * The engine is being deployed switched OFF, so the only thing that matters at
 * this stage is that nothing can send. This proves that by exercising the real
 * code rather than by reading it: it boots an in-memory database, populates it
 * with people who would all be eligible, runs the cron cycle, the admin dry
 * run and the preview renderer, and asserts that the transport is never called.
 *
 *   node scripts/marketing_deployment_gate.js
 *
 * Exits non-zero if anything could send. Run before every deploy while
 * marketing is disabled.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || "gate-secret";
process.env.EMAIL_UNSUBSCRIBE_SECRET = process.env.EMAIL_UNSUBSCRIBE_SECRET || "gate-unsub-secret";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.ENABLE_MARKETING_EMAILS;
delete process.env.MARKETING_AUDIENCES;

const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

/* The transport is replaced by a tripwire. Any call at all is a failure. */
const transportCalls = [];
const resolved = require.resolve("../utils/emailService");
require.cache[resolved] = {
  id: resolved, filename: resolved, loaded: true,
  exports: {
    async sendRaw(mail) { transportCalls.push(mail); return { messageId: "<gate>" }; },
    async sendTx(...args) { transportCalls.push(args); return { messageId: "<gate>" }; },
    async sendPromo(...args) { transportCalls.push(args); return { messageId: "<gate>" }; },
    TEMPLATES: {}, FROM: "gate", REPLY_TO: "gate", ADMIN: "gate",
  },
};

const User = require("../models/User");
const MarketingSend = require("../models/MarketingSend");
const { ALL_TEMPLATES, audiencesOf } = require("../utils/marketing/marketingLibrary");
const { BUSINESS, marketingEnabled, enabledAudiences } = require("../utils/marketing/marketingConfig");
const { renderMarketingEmail } = require("../utils/marketing/marketingRenderer");
const { previewCampaign, runMarketingCycle } = require("../utils/marketing/marketingRunner");

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
    console.log(`  FAIL  ${name}`);
  }
}

async function main() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await Promise.all(mongoose.modelNames().map((m) => mongoose.model(m).syncIndexes()));

  console.log("\nmarketing deployment gate: proving nothing can send\n");

  // Twelve people who would all be eligible if marketing were on.
  for (let i = 1; i <= 12; i += 1) {
    await User.create({
      userId: `GATE${String(i).padStart(4, "0")}`,
      name: `Gate Customer ${i}`, firstName: "Gate",
      email: `gate${i}@mailbox.gate-fixture.net`,
      password: "hashed", role: "customer",
      createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
    });
  }

  await check("ENABLE_MARKETING_EMAILS is off when unset", () => {
    assert.strictEqual(process.env.ENABLE_MARKETING_EMAILS, undefined, "the variable is set");
    assert.strictEqual(marketingEnabled(), false, "marketing reports itself enabled");
  });

  await check("the cron cycle sends nothing and writes nothing while disabled", async () => {
    const result = await runMarketingCycle({ force: true });
    assert.strictEqual(result.stoppedBecause, "disabled", `stopped because ${result.stoppedBecause}`);
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(transportCalls.length, 0, "the transport was called");
    assert.strictEqual(await MarketingSend.countDocuments({}), 0, "history rows were written");
  });

  await check("an audience allow-list cannot switch marketing on", async () => {
    process.env.MARKETING_AUDIENCES = "member,non_member,former_member";
    try {
      assert.deepStrictEqual([...enabledAudiences()].sort(),
        ["former_member", "member", "non_member"], "the allow-list did not parse");
      // The master switch is still off, so this must change nothing.
      const result = await runMarketingCycle({ force: true });
      assert.strictEqual(result.stoppedBecause, "disabled",
        "an audience list bypassed the global kill switch");
      assert.strictEqual(transportCalls.length, 0);
      assert.strictEqual(await MarketingSend.countDocuments({}), 0);
    } finally {
      delete process.env.MARKETING_AUDIENCES;
    }
  });

  await check("the send window does not matter while disabled", async () => {
    // No force: the real clock decides the window, and the answer is still no.
    const result = await runMarketingCycle({});
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(transportCalls.length, 0);
  });

  await check("a dry run reads only, even when marketing is disabled", async () => {
    const result = await runMarketingCycle({ force: true, dryRun: true, limit: 50 });
    assert.ok(result.selected > 0, "the dry run found nobody, so it proved nothing");
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(transportCalls.length, 0, "a dry run called the transport");
    assert.strictEqual(await MarketingSend.countDocuments({}), 0, "a dry run wrote history");
    assert.ok(!result.plans.some((p) => p.email.includes("@mailbox.gate-fixture.net")) ||
      result.plans.every((p) => p.email.includes("***")), "the dry run logged a full address");
  });

  await check("the preview renderer cannot send", async () => {
    for (const template of ALL_TEMPLATES) {
      const out = previewCampaign(template.id, { name: "Sam", email: "preview@profixter.com" });
      assert.ok(out.html.length > 400, `${template.id} rendered thin`);
    }
    assert.strictEqual(transportCalls.length, 0, "the preview called the transport");
    assert.strictEqual(await MarketingSend.countDocuments({}), 0, "the preview wrote history");
  });

  await check("every campaign carries the postal address and an unsubscribe link", () => {
    const promise = "You will still receive booking and account emails";
    for (const template of ALL_TEMPLATES) {
      for (const audience of audiencesOf(template)) {
        const out = renderMarketingEmail(template, {
          name: "Sam", email: "sam@customer.net", audience,
        });
        assert.ok(out.html.includes(BUSINESS.addressLine), `${template.id} has no postal address`);
        assert.ok(out.text.includes(BUSINESS.addressLine), `${template.id} text has no address`);
        assert.ok(/\/api\/email\/unsubscribe\?token=/.test(out.unsubscribeUrl),
          `${template.id} has no unsubscribe link`);
        assert.ok(out.html.includes(promise), `${template.id} omits the transactional promise`);
        assert.ok(out.ctaUrl.startsWith("https://"), `${template.id} CTA is not absolute`);
      }
    }
  });

  await check("the marketing cron registers without sending", async () => {
    const { startMarketingEmails } = require("../jobs/marketingEmails");
    startMarketingEmails();
    // node-cron fires on the schedule, never on registration.
    assert.strictEqual(transportCalls.length, 0, "registering the cron sent mail");
    assert.strictEqual(await MarketingSend.countDocuments({}), 0);
  });

  await check("transactional email never consults the marketing suppression list", () => {
    const fs = require("fs");
    const path = require("path");
    const service = fs.readFileSync(
      path.join(__dirname, "..", "utils", "emailService.js"), "utf8"
    );
    assert.ok(!/EmailSuppression/.test(service),
      "the transactional sender reads the suppression list, so an unsubscribe could block a booking email");
  });

  await check("nothing outside the runner can reach the transport", () => {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "..", "utils", "marketing");
    const senders = fs.readdirSync(dir).filter((file) => {
      const body = fs.readFileSync(path.join(dir, file), "utf8");
      return /require\(["'][^"']*emailService["']\)/.test(body);
    });
    assert.deepStrictEqual(senders, ["marketingRunner.js"],
      `unexpected modules can send: ${senders.join(", ")}`);
  });

  console.log(`\nmarketing deployment gate: ${passed} passed, ${failures.length} failed`);
  console.log(`transport calls during the whole gate: ${transportCalls.length}`);
  for (const f of failures) console.error(`  FAIL  ${f.name}\n        ${f.message}`);

  await mongoose.disconnect();
  await server.stop();
  process.exit(failures.length || transportCalls.length ? 1 : 0);
}

main().catch((error) => {
  console.error("Gate crashed:", error);
  process.exit(1);
});
