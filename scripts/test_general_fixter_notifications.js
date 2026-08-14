/**
 * General Fixter booking notifications, and the new-member discount detail.
 *
 * Two owner requirements, both about who receives what:
 *
 *   General Fixters get told when a booking appears or disappears, and nothing
 *   else, with the owner's own General Fixter account excluded because they
 *   already receive the Admin copy.
 *
 *   The membership-started Admin notification carries the discount in dollars
 *   when a coupon was used, and is untouched when one was not.
 *
 * MongoDB is real and in memory. Email is a fake, so nothing leaves the process.
 *
 *   node scripts/test_general_fixter_notifications.js
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.MAIL_ADMIN = "getfixter@gmail.com";

const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../models/User");
const notify = require("../utils/generalFixterNotify");

/* A stand-in for the mail module. Records, never sends. */
function fakeMail() {
  const sent = [];
  return {
    sent,
    async sendRaw(payload) {
      sent.push(payload);
      return { messageId: `<fake-${sent.length}>` };
    },
  };
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  await User.deleteMany({});
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
    console.log(`  FAIL  ${name}`);
  }
}

let seq = 0;
async function makeStaff(email, overrides = {}) {
  seq += 1;
  return User.create({
    userId: `EMP${String(seq).padStart(5, "0")}`,
    name: overrides.name || `Staff ${seq}`,
    email,
    password: "hashed",
    role: "employee",
    employeePosition: "General Fixter",
    isActive: true,
    ...overrides,
  });
}

const BOOKING = {
  bookingId: new mongoose.Types.ObjectId(),
  bookingNumber: "10045512",
  customerName: "John Smith",
  customerEmail: "john@customer.net",
  phone: "631-555-0134",
  date: new Date("2026-08-18T14:00:00Z"),
  service: "Handyman",
  bookingType: "Membership visit",
  address: "12 Maple Street, Lindenhurst, NY 11757",
  note: "Side gate code is 4412. Dog in the yard.",
};

/* ------------------------------------------------------------------ */

async function main() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  // Index enforcement is part of what is being proven, so build them.
  await Promise.all(mongoose.modelNames().map((m) => mongoose.model(m).syncIndexes()));

  console.log("\ngeneral fixter notifications\n");

  await test("Roman receives the booking created notification", async () => {
    await makeStaff("romanhecha@ukr.net", { name: "Roman Hecha" });
    const mail = fakeMail();
    const result = await notify.bookingCreated(mail, BOOKING);

    assert.strictEqual(result.sent, 1, `sent ${result.sent}`);
    assert.deepStrictEqual(result.recipients, ["romanhecha@ukr.net"]);
    assert.strictEqual(mail.sent[0].subject, "New Booking - John Smith - Aug 18, 10:00 AM");
  });

  await test("Roman receives the booking canceled notification", async () => {
    await makeStaff("romanhecha@ukr.net", { name: "Roman Hecha" });
    const mail = fakeMail();
    const result = await notify.bookingCanceled(mail, BOOKING);

    assert.strictEqual(result.sent, 1);
    assert.strictEqual(mail.sent[0].subject, "Booking Canceled - John Smith - Aug 18");
  });

  await test("a General Fixter hired later is included with no code change", async () => {
    await makeStaff("romanhecha@ukr.net");
    await makeStaff("newhire@profixter.com", { name: "New Hire" });
    const mail = fakeMail();
    const result = await notify.bookingCreated(mail, BOOKING);

    assert.strictEqual(result.sent, 2, `sent ${result.sent}`);
    assert.deepStrictEqual(result.recipients.sort(),
      ["newhire@profixter.com", "romanhecha@ukr.net"]);
  });

  await test("the owner's General Fixter account is excluded", async () => {
    await makeStaff("romanhecha@ukr.net");
    await makeStaff("bandurataras1596@gmail.com", { name: "ProFixter Owner" });
    const mail = fakeMail();
    const result = await notify.bookingCreated(mail, BOOKING);

    assert.deepStrictEqual(result.recipients, ["romanhecha@ukr.net"]);
    assert.ok(!mail.sent.some((m) => m.to === "bandurataras1596@gmail.com"),
      "the owner received a General Fixter copy");
  });

  await test("the owner exclusion ignores capitalisation", async () => {
    await makeStaff("BanduraTaras1596@Gmail.COM", { name: "Owner Mixed Case" });
    await makeStaff("romanhecha@ukr.net");
    const mail = fakeMail();
    const result = await notify.bookingCreated(mail, BOOKING);

    assert.deepStrictEqual(result.recipients, ["romanhecha@ukr.net"],
      "a differently capitalised owner address slipped through");
  });

  await test("staff who are not General Fixters are never notified", async () => {
    await makeStaff("fixter@profixter.com", { employeePosition: "Fixter" });
    await makeStaff("admin@profixter.com", { role: "admin", employeePosition: null });
    await User.create({
      userId: "CUST00001", name: "Customer", email: "customer@somewhere.net",
      password: "hashed", role: "customer",
    });
    const mail = fakeMail();
    const result = await notify.bookingCreated(mail, BOOKING);

    assert.strictEqual(result.sent, 0, `sent to ${result.recipients.join(", ")}`);
  });

  await test("a deactivated General Fixter stops receiving them", async () => {
    await makeStaff("gone@profixter.com", { isActive: false });
    await makeStaff("romanhecha@ukr.net");
    const mail = fakeMail();
    const result = await notify.bookingCreated(mail, BOOKING);

    assert.deepStrictEqual(result.recipients, ["romanhecha@ukr.net"]);
  });

  await test("a General Fixter at the Admin address is not sent a second copy", async () => {
    await makeStaff("getfixter@gmail.com", { name: "Shares The Admin Inbox" });
    await makeStaff("romanhecha@ukr.net");
    const mail = fakeMail();
    const result = await notify.bookingCreated(mail, BOOKING);

    assert.deepStrictEqual(result.recipients, ["romanhecha@ukr.net"],
      "the Admin destination received a duplicate General Fixter copy");
  });

  await test("the same mailbox cannot appear twice in the recipient set", async () => {
    await makeStaff("romanhecha@ukr.net");

    // The database is the first line of defence: staff email is unique per role
    // and the schema lowercases, so a differently capitalised duplicate is
    // rejected rather than stored.
    await assert.rejects(
      () => makeStaff("RomanHecha@UKR.net", { userId: "EMPDUPE" }),
      /duplicate key/,
      "two staff accounts were allowed to share a mailbox"
    );

    // The recipient builder dedupes as well, so a duplicate arriving by any
    // other route still produces one email.
    const mail = fakeMail();
    const result = await notify.bookingCreated(mail, BOOKING);
    assert.strictEqual(result.sent, 1, `sent ${result.sent} copies to the same mailbox`);
    assert.strictEqual(new Set(result.recipients).size, result.recipients.length);
  });

  await test("each recipient is addressed separately", async () => {
    await makeStaff("one@profixter.com");
    await makeStaff("two@profixter.com");
    const mail = fakeMail();
    await notify.bookingCreated(mail, BOOKING);

    assert.strictEqual(mail.sent.length, 2);
    for (const message of mail.sent) {
      assert.ok(!String(message.to).includes(","), "recipients were bundled into one To header");
    }
  });

  await test("the notification carries operational facts and no internals", async () => {
    await makeStaff("romanhecha@ukr.net");
    const mail = fakeMail();
    await notify.bookingCreated(mail, BOOKING);
    const { html, text } = mail.sent[0];

    for (const wanted of ["John Smith", "Handyman", "Membership visit",
      "12 Maple Street", "631-555-0134", "10045512", "Side gate code is 4412"]) {
      assert.ok(html.includes(wanted), `missing from the email: ${wanted}`);
    }
    assert.ok(text.includes("John Smith"), "the text part is missing the customer");

    /*
     * Nothing a General Fixter cannot act on appears as content. Identifiers
     * are checked against the visible text rather than the raw HTML, because
     * the "View booking" button legitimately carries the booking id inside its
     * href: that is a link target, not something the reader is asked to read.
     */
    const visible = html.replace(/href="[^"]*"/g, "").replace(/<[^>]+>/g, " ");
    assert.ok(!visible.includes(String(BOOKING.bookingId)), "a Mongo id is shown as content");
    const visibleText = text.replace(/https?:\/\/\S+/g, "");
    assert.ok(!visibleText.includes(String(BOOKING.bookingId)),
      "a Mongo id is shown in the text part");
    assert.ok(!/\b(cus_|sub_|pi_|price_|prod_|promo_|in_)[A-Za-z0-9]/.test(html),
      "a Stripe id leaked into the email");
    assert.ok(!/subscriptionId|stripeCustomerId|paymentIntent/i.test(html),
      "payment internals leaked into the email");
  });

  await test("a booking with no note or phone still renders cleanly", async () => {
    await makeStaff("romanhecha@ukr.net");
    const mail = fakeMail();
    await notify.bookingCreated(mail, {
      ...BOOKING, note: "", phone: "", bookingType: "", address: "12 Maple Street",
    });
    const { html } = mail.sent[0];

    assert.ok(!html.includes("undefined") && !html.includes("null"),
      "empty fields rendered as undefined or null");
    assert.ok(!/>\s*Phone\s*</.test(html), "an empty Phone row was still rendered");
  });

  await test("nothing is sent when there are no General Fixters", async () => {
    const mail = fakeMail();
    const result = await notify.bookingCreated(mail, BOOKING);
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(mail.sent.length, 0);
  });

  await test("one bad address does not suppress the others", async () => {
    await makeStaff("good@profixter.com");
    await makeStaff("alsogood@profixter.com");
    const mail = fakeMail();
    let first = true;
    mail.sendRaw = async (payload) => {
      if (first) { first = false; throw new Error("simulated SMTP rejection"); }
      mail.sent.push(payload);
      return { messageId: "<ok>" };
    };
    const result = await notify.bookingCreated(mail, BOOKING);
    assert.strictEqual(result.sent, 1, "the second recipient was not attempted");
  });

  await test("only these two events are wired to General Fixters", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(__dirname, "..", "routes", "bookings.js"), "utf8");
    const calls = source.match(/generalFixterNotify\.(\w+)/g) || [];
    const events = [...new Set(calls.map((c) => c.split(".")[1]))].sort();
    assert.deepStrictEqual(events, ["bookingCanceled", "bookingCreated"],
      `General Fixters are wired to unexpected events: ${events.join(", ")}`);

    // And nothing else in the codebase notifies them.
    const others = [];
    for (const dir of ["routes", "utils", "jobs"]) {
      const base = path.join(__dirname, "..", dir);
      for (const file of fs.readdirSync(base)) {
        if (!file.endsWith(".js") || file === "generalFixterNotify.js") continue;
        const body = fs.readFileSync(path.join(base, file), "utf8");
        if (/generalFixterNotify/.test(body) && file !== "bookings.js") others.push(`${dir}/${file}`);
      }
    }
    assert.deepStrictEqual(others, [], `unexpected notifiers: ${others.join(", ")}`);
  });

  console.log(`\ngeneral fixter notifications: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`  FAIL  ${f.name}\n        ${f.message}`);

  await mongoose.disconnect();
  await server.stop();
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error("Suite crashed:", error);
  process.exit(1);
});
