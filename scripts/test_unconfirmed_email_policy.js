/*
 * What reaches an email address only typed at checkout (2026-11-20).
 *
 *   node scripts/test_unconfirmed_email_policy.js
 *
 * In-memory database, the real templates and sendTx/sendRaw, the mail
 * transport replaced by a recorder (nothing is sent). Pins
 * utils/communications/unconfirmedEmailPolicy:
 *  - billing notices arrive, without the home address or the job
 *  - visit updates arrive as a short note with no details and no token
 *  - reminders, tip and review links, loyalty news, payment and access links,
 *    marketing and unknown keys are held
 *  - the code that confirms the address still arrives
 *  - a confirmed email, a guest address and an older unverified email are untouched
 *  - Stripe/billing lookups by email never pick an unconfirmed account
 */
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const User = require("../models/User");
const EmailLog = require("../models/EmailLog");
const emailService = require("../utils/emailService");
const { policyFor } = require("../utils/communications/unconfirmedEmailPolicy");
const { findBillingUserByEmail } = require("../utils/userLookup");

const ADDRESS = "17 Secret Lane, Huntington, NY 11743";
const TASK = "Fix the back door lock";
const TIP_TOKEN = "tipTOKENsecret123";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const sent = [];
  emailService.transporter.sendMail = async (mail) => {
    sent.push(mail);
    return { messageId: `m${sent.length}`, response: "250 OK", accepted: [mail.to], rejected: [], envelope: { to: [mail.to] } };
  };
  EmailLog.create = async (payload) => payload;

  let seq = 0;
  const make = (fields) =>
    User.collection.insertOne({ name: "Pat Doe", userId: `PF-U${++seq}`, role: "customer", createdAt: new Date(), ...fields });
  await make({ email: "typed@example.com", phone: "+16315550101", phoneVerifiedAt: new Date(), emailUnconfirmedAt: new Date(), emailVerifiedAt: null });
  await make({ email: "proved@example.com", phone: "+16315550102", phoneVerifiedAt: new Date(), emailUnconfirmedAt: null, emailVerifiedAt: new Date() });
  await make({ email: "older@example.com", phone: "+16315550103", emailVerifiedAt: null });
  await make({ email: "fixed@example.com", phone: "+16315550104", emailUnconfirmedAt: new Date(Date.now() - 864e5), emailVerifiedAt: new Date() });

  const last = () => sent[sent.length - 1];
  const body = (m) => `${m.subject}\n${m.html}\n${m.text}`;
  const send = async (key, to, vars) => {
    const before = sent.length;
    const result = await emailService.sendTx(key, to, vars, { bccAdmin: false, logContext: { source: "test" } });
    return { result, mail: sent.length > before ? last() : null };
  };

  await test("billing notice (membership active) arrives, without the home address", async () => {
    const { mail } = await send("subscription_started", "typed@example.com", { name: "Pat", plan: "Plus", billingCycle: "monthly", address: ADDRESS });
    assert.ok(mail, "sent");
    assert.match(body(mail), /membership is active/i);
    assert.match(body(mail), /Plus/);
    assert.ok(!body(mail).includes("Secret Lane"), "no address");
  });

  await test("billing notice (payment failed) arrives in full", async () => {
    const { mail } = await send("payment_failed", "typed@example.com", { name: "Pat", plan: "Plus", amount: "$129.00", billingDate: "Dec 1, 2026" });
    assert.ok(mail);
    assert.match(body(mail), /\$129\.00/);
  });

  await test("cancellation notices arrive, without the address", async () => {
    for (const key of ["subscription_cancellation_scheduled", "subscription_canceled"]) {
      const { mail } = await send(key, "typed@example.com", { name: "Pat", plan: "Plus", address: ADDRESS, accessEndDate: "Dec 1, 2026", canceledDate: "Dec 1, 2026" });
      assert.ok(mail, key);
      assert.ok(!body(mail).includes("Secret Lane"), key);
    }
  });

  await test("a paid One-Time Visit receipt arrives with the price, without address or job", async () => {
    const { mail } = await send("one_time_visit_payment_received", "typed@example.com", { name: "Pat", bookingNumber: "1042", date: new Date(), service: TASK, selectedTask: TASK, address: ADDRESS, price: "$99" });
    assert.ok(mail);
    assert.match(body(mail), /\$99/);
    assert.ok(!body(mail).includes("Secret Lane") && !body(mail).includes("back door"));
  });

  await test("a visit update becomes a short note: no address, job, time or token", async () => {
    for (const key of ["booking_created", "booking_confirmed", "booking_rescheduled", "booking_canceled"]) {
      const { mail } = await send(key, "typed@example.com", { name: "Pat", bookingNumber: "1042", date: new Date("2026-12-02T15:00:00Z"), service: TASK, task: TASK, address: ADDRESS });
      assert.ok(mail, key);
      assert.equal(mail.subject, "An update on your Profixter visit", key);
      const b = body(mail);
      assert.ok(!b.includes("Secret Lane") && !b.includes("back door") && !b.includes("1042"), key);
      assert.match(b, /sign in/i);
    }
  });

  await test("held: reminders, tip and review links, loyalty, payment and access links, marketing, unknown keys", async () => {
    const before = sent.length;
    for (const key of ["booking_reminder_24h", "booking_reminder_60m", "booking_completed", "booking_review_request"]) {
      const { result } = await send(key, "typed@example.com", { name: "Pat", bookingNumber: "1042", date: new Date(), address: ADDRESS, tipUrl: `https://www.profixter.com/tip?t=${TIP_TOKEN}` });
      assert.equal(result?.reason, "email_unconfirmed", key);
    }
    for (const templateKey of ["payment_link", "admin_account_created", "campaign", "promo", "growth:checkout_recovery_v1", "loyalty_first_benefit", "", "something_new"]) {
      const r = await emailService.sendRaw({ to: "typed@example.com", subject: "x", html: `<p>${TIP_TOKEN}</p>`, logContext: { templateKey } });
      assert.equal(r?.reason, "email_unconfirmed", templateKey || "(none)");
    }
    assert.equal(sent.length, before, "nothing sent");
  });

  await test("a raw visit update (pick another time) is a note, not the details", async () => {
    await emailService.sendRaw({ to: "typed@example.com", subject: "Please pick another time", html: `<p>${ADDRESS}</p>`, logContext: { templateKey: "first_visit_pick_another_time" } });
    assert.equal(last().subject, "An update on your Profixter visit");
    assert.ok(!body(last()).includes("Secret Lane"));
  });

  await test("the code that confirms the address still arrives", async () => {
    await emailService.sendRaw({ to: "typed@example.com", subject: "Your Profixter code", html: "<p>123456</p>", logContext: { templateKey: "login_code" } });
    assert.match(body(last()), /123456/);
  });

  await test("a confirmed email, an older unverified email and a guest address are untouched", async () => {
    for (const to of ["proved@example.com", "older@example.com", "fixed@example.com", "guest@example.com"]) {
      const { mail } = await send("booking_confirmed", to, { name: "Pat", bookingNumber: "1042", date: new Date(), address: ADDRESS, task: TASK });
      assert.ok(mail && body(mail).includes("Secret Lane"), to);
      const r = await send("booking_reminder_24h", to, { name: "Pat", date: new Date(), address: ADDRESS });
      assert.ok(r.mail, `${to} reminder`);
    }
  });

  await test("billing lookups by email never pick the unconfirmed account", async () => {
    assert.equal(await findBillingUserByEmail("typed@example.com"), null);
    assert.ok(await findBillingUserByEmail("proved@example.com"));
  });

  await test("every customer template key has a decision on purpose (unknown = held)", async () => {
    assert.equal(policyFor("login_code").action, "send");
    assert.equal(policyFor("subscription_started").action, "redact");
    assert.equal(policyFor("booking_confirmed").action, "notice");
    assert.equal(policyFor("booking_completed").action, "hold");
    assert.equal(policyFor("whatever").action, "hold");
  });

  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
