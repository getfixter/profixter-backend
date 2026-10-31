/*
 * The Halloween 2026 campaign sender (scripts/ops/send_halloween_campaign.js),
 * against an in-memory MongoDB. Email goes to a recording fake; SMS goes
 * through the REAL sendMarketingSms with SMS_ENABLED=false (consent, STOP,
 * quiet hours and the dedupe claim all real; the provider call simulated).
 * No real customer, no real message.
 *
 *   node scripts/test_halloween_campaign.js
 */
process.env.NODE_ENV = "test";
process.env.SMS_ENABLED = "false";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-halloween";
process.env.SMS_MARKETING_ENABLED = "true";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake_for_unit_tests";

const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const MarketingSend = require("../models/MarketingSend");
const SmsMessage = require("../models/SmsMessage");
const SmsOptOut = require("../models/SmsOptOut");
const EmailSuppression = require("../models/EmailSuppression");
const { runHalloweenCampaign, SMS_BODY, EMAIL_TEMPLATE } = require("./ops/send_halloween_campaign");
const { renderMarketingEmail } = require("../utils/marketing/marketingRenderer");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

// 1:30 PM New York on Halloween: inside the marketing SMS hours (11:00-18:00).
const AFTERNOON = () => new Date("2026-10-31T17:30:00Z");
const EVENING = () => new Date("2026-10-31T23:30:00Z"); // 7:30 PM: outside them

let seq = 0;
async function person({ email = true, smsMarketing = false, member = null, extra = {} } = {}) {
  seq += 1;
  const u = await User.create({
    userId: `8100${seq}`,
    name: `Person ${seq}`,
    firstName: `Person${seq}`,
    email: email ? `person${seq}@mailbox.org` : undefined,
    phone: `+1631555${String(2000 + seq)}`,
    phoneVerifiedAt: new Date(),
    role: "customer",
    addresses: [{ label: "Primary", line1: `${seq} Test St`, city: "Babylon", state: "NY", zip: "11702" }],
    smsPreferences: {
      transactionalEnabled: true,
      transactionalConsentAt: new Date(),
      ...(smsMarketing ? { marketingEnabled: true, marketingConsentAt: new Date("2026-09-01"), marketingConsentSource: "signup_web_form" } : {}),
    },
    ...extra,
  });
  if (member) {
    await Subscription.create({ user: u._id, userId: u.userId, subscriptionType: "basic", addressId: u.addresses[0]._id, status: member, accessStatus: member === "active" ? "active" : "inactive", planPrice: 149, startDate: new Date("2026-01-01"), latestPaymentDate: new Date("2026-10-01"), nextPaymentDate: new Date("2026-11-30"), currentPeriodEnd: member === "active" ? new Date("2026-11-30") : new Date("2026-03-01") });
  }
  return u;
}

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([MarketingSend.init(), SmsMessage.init()]);
  const emails = [];
  const fakeEmail = async (to, msg) => {
    emails.push({ to, ...msg });
    return { messageId: `ses-${emails.length}` };
  };

  try {
    const both = await person({ smsMarketing: true });
    const emailOnly = await person({ smsMarketing: false });
    const former = await person({ smsMarketing: true, member: "canceled" });
    const activeMember = await person({ smsMarketing: true, member: "active" });
    const pastDue = await person({ smsMarketing: true, member: "past_due" });
    const unsubscribed = await person({ smsMarketing: true });
    await EmailSuppression.create({ email: unsubscribed.email, reason: "unsubscribe", suppressedAt: new Date() });
    await SmsOptOut.create({ phone: unsubscribed.phone, scope: "all", optedOutAt: new Date(), source: "carrier_keyword" });
    const excluded = await person({ smsMarketing: true, extra: { excludeFromMarketing: true } });
    // Marketing SMS switched on by staff after a phone call: not the customer's own written consent.
    const staffConsent = await person({ smsMarketing: false, extra: { smsPreferences: { transactionalEnabled: true, marketingEnabled: true, marketingConsentAt: new Date("2026-10-30"), marketingConsentSource: "admin_phone" } } });
    void staffConsent;

    // A legacy customer imported before the role field existed (most of the real base), and a staff account.
    const legacy = await person({ smsMarketing: false });
    await User.collection.updateOne({ _id: legacy._id }, { $unset: { role: "" }, $set: { legacyRegisteredUser: true } });
    const staff = await person({ smsMarketing: true, extra: { role: "employee", employeePosition: "General Fixter" } });
    void staff;

    await check("the SMS is the owner's copy, a working link, nothing personal, STOP appended", async () => {
      assert.match(SMS_BODY, /^Happy Halloween from Profixter! 🎃 We've got a treat for you: 20% OFF your first payment on ANY Profixter membership plan!/);
      assert.match(SMS_BODY, /https:\/\/www\.profixter\.com\/halloween\?c=sms$/);
      assert.ok(SMS_BODY.length <= 240);
    });
    await check("the email: subject, preheader, CTA to /halloween, business address and one-click unsubscribe", async () => {
      const r = renderMarketingEmail(EMAIL_TEMPLATE, { name: "Dana", email: "dana@mailbox.org", audience: "non_member" });
      assert.strictEqual(r.subject, "🎃 Happy Halloween! Here's 20% OFF from Profixter!");
      assert.strictEqual(r.preheader, "A special Halloween treat for your home.");
      assert.match(r.html, /CLAIM MY 20% OFF/);
      assert.match(r.html, /https:\/\/www\.profixter\.com\/halloween\?c=email/);
      assert.match(r.html, /245 42nd Street, Lindenhurst, NY 11757/);
      assert.ok(r.unsubscribeUrl && r.html.includes(r.unsubscribeUrl));
      assert.match(r.text, /renewals are at the regular price/);
      assert.match(r.html, /https:\/\/www\.profixter\.com\/account\?tab=personal#texts/, "the text opt-in link points at account settings");
      assert.doesNotMatch(r.html + r.text, /every month|all payments|recurring discount/i);
    });

    let dry;
    await check("dry run: counts, nothing sent, nothing written", async () => {
      dry = await runHalloweenCampaign({ send: false, senders: { sendPromo: fakeEmail }, clock: AFTERNOON, pauseMs: 0 });
      assert.strictEqual(emails.length, 0);
      assert.strictEqual(await MarketingSend.countDocuments(), 0);
      assert.strictEqual(await SmsMessage.countDocuments(), 0);
    });
    await check("members (active, past due) are never in the audience; former members are", async () => {
      assert.strictEqual(dry.customers, 9, "role-less legacy customer counted, the employee not");
      assert.strictEqual(dry.withoutLiveMembership, 7, JSON.stringify(dry));
      assert.strictEqual(dry.audience.former_member, 1);
    });
    await check("email: unsubscribed and excluded people are skipped", async () => {
      assert.strictEqual(dry.email.eligible, 5, JSON.stringify(dry.email));
    });
    await check("SMS: only recorded marketing consent, not transactional, not STOP", async () => {
      assert.strictEqual(dry.sms.eligible, 2, JSON.stringify(dry.sms));
      assert.strictEqual(dry.sms.skipped.phone_consent_awaiting_customer_confirmation, 1, "staff-recorded consent is not texted");
    });

    let run1;
    await check("send: one email and one SMS per eligible person", async () => {
      run1 = await runHalloweenCampaign({ send: true, senders: { sendPromo: fakeEmail }, clock: AFTERNOON, pauseMs: 0 });
      assert.strictEqual(run1.email.accepted, 5, JSON.stringify(run1.email));
      assert.strictEqual(run1.sms.accepted, 2, JSON.stringify(run1.sms));
      const to = emails.map((e) => e.to).sort();
      assert.deepStrictEqual(to, [both.email, emailOnly.email, former.email, staffConsent.email, legacy.email].sort());
      for (const e of emails) assert.ok(e.headers["List-Unsubscribe"] && e.headers["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click");
      const sms = await SmsMessage.find({ campaignId: "halloween-2026" }).lean();
      assert.deepStrictEqual(sms.map((m) => String(m.user)).sort(), [String(both._id), String(former._id)].sort());
      assert.ok(sms.every((m) => /Reply STOP to opt out\.$/.test(m.body)), sms.map((m) => m.body).join(" | "));
    });
    await check("nobody with a membership, STOP, unsubscribe or exclusion was contacted", async () => {
      const contacted = new Set([...emails.map((e) => e.to), ...(await SmsMessage.find().lean()).map((m) => String(m.user))]);
      for (const u of [activeMember, pastDue, unsubscribed, excluded]) {
        assert.ok(!contacted.has(u.email) && !contacted.has(String(u._id)), u.email);
      }
    });
    await check("a second run (or a retry after a crash) sends nothing again", async () => {
      const before = emails.length;
      const run2 = await runHalloweenCampaign({ send: true, senders: { sendPromo: fakeEmail }, clock: AFTERNOON, pauseMs: 0 });
      assert.strictEqual(emails.length, before);
      assert.strictEqual(run2.email.accepted, 0);
      assert.strictEqual(run2.email.duplicate, 5);
      assert.strictEqual(run2.sms.accepted, 0);
      assert.strictEqual(run2.sms.duplicate, 2);
      assert.strictEqual(await SmsMessage.countDocuments({ campaignId: "halloween-2026" }), 2);
    });
    await check("someone who joins between the count and the send is not messaged", async () => {
      const late = await person({ smsMarketing: true });
      await Subscription.create({ user: late._id, userId: late.userId, subscriptionType: "plus", addressId: late.addresses[0]._id, status: "active", accessStatus: "active", planPrice: 249, startDate: new Date(), latestPaymentDate: new Date(), nextPaymentDate: new Date("2026-11-30"), currentPeriodEnd: new Date("2026-11-30") });
      const before = emails.length;
      await runHalloweenCampaign({ send: true, senders: { sendPromo: fakeEmail }, clock: AFTERNOON, pauseMs: 0 });
      assert.strictEqual(emails.length, before);
    });
    await check("outside the marketing hours no SMS goes out", async () => {
      const evening = await person({ smsMarketing: true });
      const tally = await runHalloweenCampaign({ send: true, channels: ["sms"], senders: { sendPromo: fakeEmail }, clock: EVENING, pauseMs: 0 });
      assert.strictEqual(tally.sms.accepted, 0, JSON.stringify(tally.sms));
      assert.strictEqual(await SmsMessage.countDocuments({ user: evening._id }), 0);
    });
    await check("staff-recorded consent becomes textable only after the customer confirms it in account settings", async () => {
      const before = await runHalloweenCampaign({ send: false, channels: ["sms"], senders: { sendPromo: fakeEmail }, clock: AFTERNOON, pauseMs: 0 });
      assert.ok(before.sms.skipped.phone_consent_awaiting_customer_confirmation >= 1);
      // What PUT /api/users/me/sms-preferences records when the customer presses Confirm in account settings.
      await User.updateOne({ _id: staffConsent._id }, { $set: { "smsPreferences.marketingConsentSource": "account_settings", "smsPreferences.marketingConsentAt": new Date() } });
      const after = await runHalloweenCampaign({ send: true, channels: ["sms"], senders: { sendPromo: fakeEmail }, clock: AFTERNOON, pauseMs: 0 });
      // Also the person held back by the evening check, now inside the hours.
      assert.strictEqual(after.sms.accepted, 2, JSON.stringify(after.sms));
      assert.strictEqual(await SmsMessage.countDocuments({ user: staffConsent._id }), 1);
    });
    await check("an SMS the provider refused outright (no SID) is retried exactly once; never twice", async () => {
      const refused = await person({ smsMarketing: true });
      const { campaignKey } = require("../utils/sms/smsDedupe");
      await SmsMessage.collection.insertOne({ dedupeKey: campaignKey("halloween-2026", refused, 0), user: refused._id, campaignId: "halloween-2026", notificationType: "SEASONAL_MARKETING", status: "failed", providerMessageSid: "", providerErrorCode: "20001", attempts: 1, createdAt: new Date() });
      const first = await runHalloweenCampaign({ send: true, channels: ["sms"], senders: { sendPromo: fakeEmail }, clock: AFTERNOON, pauseMs: 0 });
      assert.strictEqual(first.sms.accepted, 1, JSON.stringify(first.sms));
      assert.strictEqual(await SmsMessage.countDocuments({ user: refused._id }), 2, "the refused attempt kept, one retry added");
      const again = await runHalloweenCampaign({ send: true, channels: ["sms"], senders: { sendPromo: fakeEmail }, clock: AFTERNOON, pauseMs: 0 });
      assert.strictEqual(again.sms.accepted, 0, JSON.stringify(again.sms));
      assert.strictEqual(await SmsMessage.countDocuments({ user: refused._id }), 2);
    });
    await check("a failed email is recorded as failed, not sent, and not retried as a duplicate send", async () => {
      const unlucky = await person({ smsMarketing: false });
      const tally = await runHalloweenCampaign({ send: true, channels: ["email"], senders: { sendPromo: async () => { throw new Error("SES throttled"); } }, clock: AFTERNOON, pauseMs: 0 });
      // The unlucky one, and the person added for the evening SMS check (never emailed yet).
      // Also the people added for the evening-SMS and refused-SMS checks (never emailed yet).
      assert.strictEqual(tally.email.failed, 3, JSON.stringify(tally.email));
      const row = await MarketingSend.findOne({ user: unlucky._id }).lean();
      assert.strictEqual(row.status, "failed");
      // The retry: the failed one is sent, nobody else gets a second email.
      const before = emails.length;
      const retry = await runHalloweenCampaign({ send: true, channels: ["email"], senders: { sendPromo: fakeEmail }, clock: AFTERNOON, pauseMs: 0 });
      assert.strictEqual(retry.email.accepted, 3, JSON.stringify(retry.email));
      assert.ok(emails.slice(before).map((e) => e.to).includes(unlucky.email));
      assert.strictEqual(retry.email.duplicate, 5, "everyone already sent stays sent once");
      const after = await MarketingSend.findOne({ user: unlucky._id }).lean();
      assert.strictEqual(after.status, "sent");
      assert.strictEqual(after.attempts, 2);
    });
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
