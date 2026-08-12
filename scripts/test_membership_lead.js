/**
 * The membership callback lead.
 *
 * Real MongoDB, real route, mocked email. Nothing leaves the process and no
 * message is sent, which matters because the notification goes to the live
 * admin inbox in production.
 *
 * What is worth losing sleep over here:
 *   1. A lead that does not reach the Leads list the admin actually reads.
 *   2. One person becoming two leads because they tapped twice.
 *   3. Junk saved because the browser was trusted.
 *   4. The notification subject drifting, since it is filtered on.
 *
 *   node scripts/test_membership_lead.js
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.MAIL_ADMIN = "owner@example.test";

const assert = require("assert");
const express = require("express");
const mongoose = require("mongoose");

const sent = [];
function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Capture notifications instead of sending them.
const realNotifier = require("../utils/adminLeadNotification");
stub("../utils/adminLeadNotification", {
  ...realNotifier,
  async sendAdminEventNotification(input) {
    sent.push(input);
    return { messageId: `fake-${sent.length}` };
  },
  async sendAdminLeadNotification(input) {
    sent.push(input);
    return { messageId: `fake-${sent.length}` };
  },
});

const { MongoMemoryServer } = require("mongodb-memory-server");
const Request = require("../models/Request");
const requestsRouter = require("../routes/requests");

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

/** Drive the real router over HTTP, so validation and status codes are real. */
function startServer() {
  const app = express();
  app.use(express.json());
  app.use("/api/requests", requestsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

async function post(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/requests/membership`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  // The dedupe guarantee is a unique index. Build it before racing it.
  await Request.syncIndexes();
  const { server, port } = await startServer();

  try {
    console.log("\nA visitor asking to be called");

    await test("a name and a phone number is all it takes", async () => {
      sent.length = 0;
      const res = await post(port, { name: "Dana Whitfield", phone: "(631) 555-0142", sourcePage: "/" });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.success, true);

      const lead = await Request.findOne({ name: "Dana Whitfield" }).lean();
      assert.ok(lead, "no lead was saved");
      assert.strictEqual(lead.serviceType, "membership_interest");
      assert.strictEqual(lead.status, "new");
      assert.strictEqual(lead.sourcePage, "/");
    });

    await test("it lands in the same Leads collection the admin already reads", async () => {
      // Admin's Leads tab reads Request documents. A separate collection would
      // be invisible there, which is the failure this guards against.
      const all = await Request.find({}).lean();
      assert.ok(all.length >= 1);
      assert.ok(all.every((r) => r.constructor !== undefined));
      const lead = all.find((r) => r.serviceType === "membership_interest");
      assert.ok(lead, "the membership lead is not a Request");
    });

    await test("the phone number is stored normalized, not as typed", async () => {
      const lead = await Request.findOne({ name: "Dana Whitfield" }).lean();
      assert.strictEqual(lead.phone, "+16315550142");
    });

    await test("no email is invented for a form that never asked for one", async () => {
      const lead = await Request.findOne({ name: "Dana Whitfield" }).lean();
      assert.strictEqual(lead.email, "", "a placeholder email was written into the Leads list");
    });

    console.log("\nThe notification");

    await test("the subject is exactly Subscription Lead!", async () => {
      const notice = sent.find((s) => s.subject === "Subscription Lead!");
      assert.ok(notice, `subject drifted: ${sent.map((s) => s.subject).join(", ")}`);
    });

    await test("it carries the four things worth knowing and nothing else", async () => {
      const notice = sent.find((s) => s.subject === "Subscription Lead!");
      const labels = notice.fields.map(([label]) => label);
      assert.deepStrictEqual(labels, ["Name", "Phone", "Source", "Submitted"]);
      const byLabel = Object.fromEntries(notice.fields);
      assert.strictEqual(byLabel.Name, "Dana Whitfield");
      assert.strictEqual(byLabel.Phone, "631-555-0142");
      assert.strictEqual(byLabel.Source, "Membership / Home website");
      assert.ok(byLabel.Submitted, "no submission time");
    });

    await test("a mail failure never costs the lead", async () => {
      const notifierPath = require.resolve("../utils/adminLeadNotification");
      const saved = require.cache[notifierPath].exports.sendAdminEventNotification;
      require.cache[notifierPath].exports.sendAdminEventNotification = async () => {
        throw new Error("Injected mail failure");
      };
      try {
        const res = await post(port, { name: "Mail Broke", phone: "631-555-0199" });
        assert.strictEqual(res.status, 201, "a mail failure was reported to the visitor");
        assert.ok(await Request.findOne({ name: "Mail Broke" }), "the lead was lost with the email");
      } finally {
        require.cache[notifierPath].exports.sendAdminEventNotification = saved;
      }
    });

    console.log("\nWhat it refuses");

    await test("a missing name is refused", async () => {
      const res = await post(port, { phone: "631-555-0143" });
      assert.strictEqual(res.status, 400);
      assert.match(res.body.message, /name/i);
    });

    await test("a missing phone number is refused", async () => {
      const res = await post(port, { name: "No Phone" });
      assert.strictEqual(res.status, 400);
      assert.match(res.body.message, /phone/i);
    });

    await test("an invalid phone number is refused", async () => {
      for (const phone of ["123", "abcdefghij", "555-01", "+44 20 7946 0958"]) {
        const res = await post(port, { name: "Bad Phone", phone });
        assert.strictEqual(res.status, 400, `"${phone}" was accepted`);
      }
      assert.strictEqual(await Request.countDocuments({ name: "Bad Phone" }), 0);
    });

    await test("a one-character name is refused", async () => {
      const res = await post(port, { name: "D", phone: "631-555-0144" });
      assert.strictEqual(res.status, 400);
    });

    await test("nothing rejected was written to the Leads list", async () => {
      assert.strictEqual(await Request.countDocuments({ name: "No Phone" }), 0);
      assert.strictEqual(await Request.countDocuments({ name: "D" }), 0);
    });

    console.log("\nDouble submission");

    await test("tapping twice creates one lead, not two", async () => {
      const before = await Request.countDocuments({ serviceType: "membership_interest" });
      const body = { name: "Double Tap", phone: "631-555-0150" };
      await Promise.all([post(port, body), post(port, body), post(port, body)]);
      const after = await Request.countDocuments({ serviceType: "membership_interest" });
      assert.strictEqual(after - before, 1, "repeated taps produced duplicate leads");
    });

    await test("the visitor is still told it worked on the duplicate", async () => {
      const res = await post(port, { name: "Double Tap", phone: "631-555-0150" });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true, "a repeat tap looked like a failure to the visitor");
    });

    await test("the same number typed differently is still one lead", async () => {
      const before = await Request.countDocuments({ serviceType: "membership_interest" });
      await post(port, { name: "Double Tap", phone: "(631) 555 0150" });
      const after = await Request.countDocuments({ serviceType: "membership_interest" });
      assert.strictEqual(after, before, "formatting alone created a second lead");
    });

    await test("a genuinely different person is not deduped away", async () => {
      const before = await Request.countDocuments({ serviceType: "membership_interest" });
      await post(port, { name: "Someone Else", phone: "631-555-0151" });
      assert.strictEqual(
        await Request.countDocuments({ serviceType: "membership_interest" }),
        before + 1
      );
    });
  } finally {
    server.close();
    await mongoose.disconnect();
    await mongo.stop();
  }

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
