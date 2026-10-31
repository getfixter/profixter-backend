/*
 * Admin-managed marketing-SMS consent, against an in-memory MongoDB:
 * the Admin switch with how the customer agreed and the evidence, the
 * evidence-based eligibility rule (utils/consent/marketingSmsBasis.js), the
 * one-click confirmation link (utils/consent/smsConfirmLink.js), and the
 * Halloween sender on top. Email goes to a recording fake; SMS goes through
 * the real sendMarketingSms with SMS_ENABLED=false. No real message.
 *
 *   node scripts/test_admin_marketing_consent.js
 */
process.env.NODE_ENV = "test";
process.env.SMS_ENABLED = "false";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-admin-consent";
process.env.SMS_MARKETING_ENABLED = "true";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake_for_unit_tests";
delete process.env.SMS_ADMIN_ASSISTED_OPTIN_REGISTERED;

const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const ConsentEvent = require("../models/ConsentEvent");
const MarketingSend = require("../models/MarketingSend");
const SmsMessage = require("../models/SmsMessage");
const SmsOptOut = require("../models/SmsOptOut");
const EmailSuppression = require("../models/EmailSuppression");
const { setCommunicationPreference, communicationState } = require("../utils/admin/communicationControls");
const { checkEligibility } = require("../utils/sms/smsEligibility");
const { marketingSmsBasis } = require("../utils/consent/marketingSmsBasis");
const {
  confirmSmsMarketing,
  createConfirmToken,
  describeConfirmation,
  requestSmsConfirmation,
} = require("../utils/consent/smsConfirmLink");
const { runHalloweenCampaign } = require("./ops/send_halloween_campaign");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${error.stack}`);
  }
}

const AFTERNOON = new Date("2026-10-31T17:30:00Z"); // 1:30 PM New York
const admin = { _id: new mongoose.Types.ObjectId(), name: "Owner" };
const req = { headers: { "user-agent": "TestBrowser/1.0", "x-forwarded-for": "203.0.113.9" }, ip: "203.0.113.9" };

let seq = 0;
async function customer({ marketing = null, member = null, legacy = false } = {}) {
  seq += 1;
  const u = await User.create({
    userId: `8200${seq}`,
    name: `Pat ${seq}`,
    firstName: `Pat${seq}`,
    email: `pat${seq}@mailbox.org`,
    phone: `+1631555${String(3000 + seq)}`,
    phoneVerifiedAt: new Date(),
    role: "customer",
    addresses: [{ label: "Primary", line1: `${seq} Oak St`, city: "Babylon", state: "NY", zip: "11702" }],
    smsPreferences: { transactionalEnabled: true, transactionalConsentAt: new Date(), ...(marketing || {}) },
  });
  if (legacy) await User.collection.updateOne({ _id: u._id }, { $unset: { role: "" } });
  if (member) {
    await Subscription.create({ user: u._id, userId: u.userId, subscriptionType: "basic", addressId: u.addresses[0]._id, status: member, accessStatus: "active", planPrice: 149, startDate: new Date("2026-01-01"), latestPaymentDate: new Date("2026-10-01"), nextPaymentDate: new Date("2026-11-30"), currentPeriodEnd: new Date("2026-11-30") });
  }
  return u;
}
async function registered(fn) {
  process.env.SMS_ADMIN_ASSISTED_OPTIN_REGISTERED = "true";
  try {
    return await fn();
  } finally {
    delete process.env.SMS_ADMIN_ASSISTED_OPTIN_REGISTERED;
  }
}
/* The customer confirms in account settings - what routes/users.js records. */
const confirmInSettings = (id) =>
  User.updateOne({ _id: id }, { $set: { "smsPreferences.marketingEnabled": true, "smsPreferences.marketingConsentSource": "account_settings", "smsPreferences.marketingConsentAt": new Date() } });
const fresh = (id) => User.findById(id).lean();
const marketingOk = async (id) => (await checkEligibility({ notificationType: "SEASONAL_MARKETING", user: await fresh(id), now: AFTERNOON })).eligible;
const reason = async (id) => (await checkEligibility({ notificationType: "SEASONAL_MARKETING", user: await fresh(id), now: AFTERNOON })).reason;

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([MarketingSend.init(), SmsMessage.init()]);
  const emails = [];
  const fakeEmail = async (to, msg) => {
    emails.push({ to, ...msg });
    return { messageId: `ses-${emails.length}` };
  };
  const linkIn = (mail) => decodeURIComponent(mail.text.match(/\/texts\/confirm\?t=([^\s]+)/)[1]);

  try {
    await check("Admin enables marketing SMS after a call: on at once, audited with method, admin and time; nobody is emailed or texted", async () => {
      const u = await customer();
      const before = { emails: emails.length, sms: await SmsMessage.countDocuments() };
      const r = await setCommunicationPreference({ userId: u._id, key: "marketing.sms", enabled: true, admin, req, at: AFTERNOON });
      assert.strictEqual(r.changed, true);
      assert.strictEqual(r.after.marketing.sms.enabled, true);
      const prefs = (await fresh(u._id)).smsPreferences;
      assert.strictEqual(prefs.marketingConsentSource, "admin_phone");
      assert.strictEqual(prefs.marketingConsentMethod, "phone_call");
      assert.strictEqual(String(prefs.marketingConsentRecordedBy), String(admin._id));
      const ev = await ConsentEvent.findOne({ user: u._id, channel: "sms", purpose: "marketing" }).lean();
      assert.strictEqual(ev.action, "granted");
      assert.strictEqual(ev.method, "phone_call");
      assert.strictEqual(String(ev.recordedBy), String(admin._id));
      assert.strictEqual(ev.consentVersion, "sms_marketing.admin_phone.v1");
      assert.strictEqual(new Date(ev.at).getTime(), AFTERNOON.getTime());
      assert.match(ev.detail, /Phone call; recorded by Owner/);
      assert.strictEqual(emails.length, before.emails, "no email");
      assert.strictEqual(await SmsMessage.countDocuments(), before.sms, "no text");
    });

    await check("a phone call alone is kept on record but does not qualify for marketing texts; service texts are unaffected", async () => {
      const u = await customer();
      await setCommunicationPreference({ userId: u._id, key: "marketing.sms", enabled: true, admin, req });
      assert.strictEqual(marketingSmsBasis(await fresh(u._id)).status, "needs_confirmation");
      assert.strictEqual(await reason(u._id), "marketing_consent_needs_confirmation");
      const svc = await checkEligibility({ notificationType: "BOOKING_CONFIRMED", user: await fresh(u._id), now: AFTERNOON });
      assert.strictEqual(svc.eligible, true, svc.reason);
      const state = await communicationState(u._id);
      assert.strictEqual(state.marketing.sms.consent.status, "needs_confirmation");
    });

    await check("Admin disables marketing SMS: off at once, a withdrawn event, the earlier grant is kept", async () => {
      const u = await customer();
      await setCommunicationPreference({ userId: u._id, key: "marketing.sms", enabled: true, admin, req });
      const r = await setCommunicationPreference({ userId: u._id, key: "marketing.sms", enabled: false, admin, req });
      assert.strictEqual(r.after.marketing.sms.enabled, false);
      const evs = await ConsentEvent.find({ user: u._id, channel: "sms", purpose: "marketing" }).sort({ at: 1, _id: 1 }).lean();
      assert.deepStrictEqual(evs.map((e) => e.action), ["granted", "withdrawn"]);
      assert.strictEqual(evs[1].source, "admin_change");
      assert.strictEqual(await reason(u._id), "marketing_not_opted_in");
    });

    await check("written permission needs its evidence described; with it, it is recorded as admin_written", async () => {
      const u = await customer();
      await assert.rejects(
        setCommunicationPreference({ userId: u._id, key: "marketing.sms", enabled: true, admin, method: "customer_email", evidence: "" }),
        (e) => e.code === "EVIDENCE_REQUIRED" && e.status === 400
      );
      await assert.rejects(setCommunicationPreference({ userId: u._id, key: "marketing.sms", enabled: true, admin, method: "telepathy" }), (e) => e.code === "BAD_METHOD");
      await setCommunicationPreference({ userId: u._id, key: "marketing.sms", enabled: true, admin, req, method: "customer_email", evidence: "Email from pat@mailbox.org on 10/31 2:05 PM: 'Yes, text me your offers'" });
      const ev = await ConsentEvent.findOne({ user: u._id, purpose: "marketing" }).lean();
      assert.strictEqual(ev.source, "admin_written");
      assert.strictEqual(ev.method, "customer_email");
      assert.match(ev.evidence, /Yes, text me your offers/);
      assert.strictEqual(ev.consentVersion, "sms_marketing.admin_written.v1");
    });

    await check("Admin-recorded written consent qualifies by its evidence, once the A2P campaign describes it (flag), not before", async () => {
      const u = await customer();
      await setCommunicationPreference({ userId: u._id, key: "marketing.sms", enabled: true, admin, method: "customer_text", evidence: "Text from the customer's phone 10/31 3:12 PM: 'YES send me deals'" });
      assert.strictEqual(await reason(u._id), "marketing_consent_awaiting_registration");
      assert.strictEqual(await registered(() => marketingOk(u._id)), true);
    });

    await check("written evidence added for a customer already on by phone call is recorded (a new event, the call kept)", async () => {
      const u = await customer();
      await setCommunicationPreference({ userId: u._id, key: "marketing.sms", enabled: true, admin });
      const r = await setCommunicationPreference({ userId: u._id, key: "marketing.sms", enabled: true, admin, method: "signed_form", evidence: "Signed paper form at the 10/31 visit, kept in the office file" });
      assert.strictEqual(r.changed, true);
      const evs = await ConsentEvent.find({ user: u._id, purpose: "marketing" }).sort({ _id: 1 }).lean();
      assert.deepStrictEqual(evs.map((e) => e.method), ["phone_call", "signed_form"]);
      // A phone call recorded over the customer's own opt-in does not downgrade it.
      const own = await customer({ marketing: { marketingEnabled: true, marketingConsentAt: new Date(), marketingConsentSource: "account_settings" } });
      const same = await setCommunicationPreference({ userId: own._id, key: "marketing.sms", enabled: true, admin });
      assert.strictEqual(same.changed, false);
      assert.strictEqual((await fresh(own._id)).smsPreferences.marketingConsentSource, "account_settings");
    });

    await check("confirmation email before the carrier registration: sends the customer to account settings (the registered opt-in), which qualifies at once", async () => {
      const u = await customer();
      await setCommunicationPreference({ userId: u._id, key: "marketing.sms", enabled: true, admin });
      const sent = await requestSmsConfirmation({ userId: u._id, admin, sendPromo: fakeEmail, now: AFTERNOON });
      assert.strictEqual(sent.oneClick, false);
      const mail = emails[emails.length - 1];
      assert.match(mail.text, /Confirm in my account: https:\/\/www\.profixter\.com\/account\?tab=personal#texts/);
      assert.doesNotMatch(mail.text, /texts\/confirm/);
      assert.match(mail.text, /sign in and tap "Text me occasional ProFixter offers"/);
      await confirmInSettings(u._id);
      assert.strictEqual(await marketingOk(u._id), true);
    });

    await check("one-click link (once registered): emailed only on request, opening changes nothing, the button records the customer's own consent", async () => {
      const u = await customer();
      await setCommunicationPreference({ userId: u._id, key: "marketing.sms", enabled: true, admin });
      const n = emails.length;
      const sent = await registered(() => requestSmsConfirmation({ userId: u._id, admin, sendPromo: fakeEmail, now: AFTERNOON }));
      assert.strictEqual(sent.oneClick, true);
      assert.strictEqual(emails.length, n + 1);
      const mail = emails[emails.length - 1];
      assert.strictEqual(mail.to, u.email);
      assert.strictEqual(sent.sentTo, u.email);
      assert.match(mail.subject, /Confirm ProFixter offers by text/);
      assert.match(mail.html, /Unsubscribe/);
      assert.match(mail.headers["List-Unsubscribe"], /unsubscribe/);
      assert.match(mail.text, /ending in \d{4}/);
      const token = linkIn(mail);

      const view = await describeConfirmation(token);
      assert.strictEqual(view.confirmed, false);
      assert.strictEqual(view.phoneLast4, u.phone.slice(-4));
      assert.strictEqual(marketingSmsBasis(await fresh(u._id)).status, "needs_confirmation", "opening the page changes nothing");

      const done = await confirmSmsMarketing({ token, req });
      assert.deepStrictEqual(done, { confirmed: true, already: false });
      const prefs = (await fresh(u._id)).smsPreferences;
      assert.strictEqual(prefs.marketingConsentSource, "sms_confirm_link");
      assert.strictEqual(await reason(u._id), "marketing_consent_awaiting_registration", "recorded, but not texted until the carrier registration says so");
      assert.strictEqual(await registered(() => marketingOk(u._id)), true);
      const evs = await ConsentEvent.find({ user: u._id, purpose: "marketing" }).sort({ _id: 1 }).lean();
      assert.deepStrictEqual(evs.map((e) => e.source), ["admin_phone", "sms_confirm_link"], "the call stays on record");
      assert.strictEqual(evs[1].consentVersion, "sms_marketing.confirm_link.v1");
      assert.strictEqual(evs[1].ip, "203.0.113.9");
      assert.strictEqual(evs[1].userAgent, "TestBrowser/1.0");
      assert.deepStrictEqual(await confirmSmsMarketing({ token, req }), { confirmed: true, already: true }, "pressing twice is harmless");
    });

    await check("confirmation link: not resent within 20 hours; not sent when already qualifying, unsubscribed or stopped", async () => {
      const u = await customer();
      await setCommunicationPreference({ userId: u._id, key: "marketing.sms", enabled: true, admin });
      await requestSmsConfirmation({ userId: u._id, admin, sendPromo: fakeEmail, now: AFTERNOON });
      await assert.rejects(requestSmsConfirmation({ userId: u._id, admin, sendPromo: fakeEmail, now: new Date(AFTERNOON.getTime() + 3600e3) }), (e) => e.code === "RECENTLY_SENT");
      const own = await customer({ marketing: { marketingEnabled: true, marketingConsentAt: new Date(), marketingConsentSource: "signup_web_form" } });
      await assert.rejects(requestSmsConfirmation({ userId: own._id, admin, sendPromo: fakeEmail }), (e) => e.code === "ALREADY_CONFIRMED");
      const unsub = await customer();
      await EmailSuppression.create({ email: unsub.email, reason: "unsubscribe", suppressedAt: new Date() });
      await assert.rejects(requestSmsConfirmation({ userId: unsub._id, admin, sendPromo: fakeEmail }), (e) => e.code === "EMAIL_UNSUBSCRIBED");
      const stopped = await customer();
      await SmsOptOut.create({ phone: stopped.phone, scope: "all", optedOutAt: new Date(), source: "carrier_keyword" });
      await assert.rejects(requestSmsConfirmation({ userId: stopped._id, admin, sendPromo: fakeEmail }), (e) => e.code === "STOPPED");
    });

    await check("STOP always wins: the link cannot lift it, Admin cannot switch it on, no marketing text goes out", async () => {
      const u = await customer();
      await setCommunicationPreference({ userId: u._id, key: "marketing.sms", enabled: true, admin });
      const token = createConfirmToken(u._id, u.phone);
      await SmsOptOut.create({ phone: u.phone, scope: "all", optedOutAt: new Date(), source: "carrier_keyword" });
      await assert.rejects(confirmSmsMarketing({ token, req }), (e) => e.code === "STOPPED");
      const v = await customer();
      await SmsOptOut.create({ phone: v.phone, scope: "all", optedOutAt: new Date(), source: "carrier_keyword" });
      await assert.rejects(setCommunicationPreference({ userId: v._id, key: "marketing.sms", enabled: true, admin }), (e) => e.code === "LOCKED_STOPPED");
      const w = await customer({ marketing: { marketingEnabled: true, marketingConsentAt: new Date(), marketingConsentSource: "account_settings" } });
      await SmsOptOut.create({ phone: w.phone, scope: "marketing", optedOutAt: new Date(), source: "carrier_keyword" });
      assert.strictEqual(await reason(w._id), "opted_out_marketing");
    });

    await check("a tampered, expired or other-phone link is refused", async () => {
      const u = await customer();
      const token = createConfirmToken(u._id, u.phone);
      await assert.rejects(confirmSmsMarketing({ token: `${token}x`, req }), (e) => e.code === "INVALID_LINK");
      const forged = `${Buffer.from(JSON.stringify({ u: String(u._id), p: u.phone, e: Date.now() + 1e9 })).toString("base64url")}.AAAA`;
      await assert.rejects(confirmSmsMarketing({ token: forged, req }), (e) => e.code === "INVALID_LINK");
      const old = createConfirmToken(u._id, u.phone, Date.now() - 31 * 864e5);
      await assert.rejects(confirmSmsMarketing({ token: old, req }), (e) => e.code === "LINK_EXPIRED");
      await User.updateOne({ _id: u._id }, { $set: { phone: "+16315559999" } });
      await assert.rejects(confirmSmsMarketing({ token, req }), (e) => e.code === "PHONE_CHANGED");
      assert.strictEqual((await fresh(u._id)).smsPreferences.marketingEnabled, undefined, "nothing was switched on");
    });

    await check("legacy customers (no role field) work the same: Admin switch, link, eligibility", async () => {
      const u = await customer({ legacy: true });
      await setCommunicationPreference({ userId: u._id, key: "marketing.sms", enabled: true, admin });
      await registered(() => requestSmsConfirmation({ userId: u._id, admin, sendPromo: fakeEmail, now: AFTERNOON }));
      await confirmSmsMarketing({ token: linkIn(emails[emails.length - 1]), req });
      assert.strictEqual(await registered(() => marketingOk(u._id)), true);
      const v = await customer({ legacy: true });
      await setCommunicationPreference({ userId: v._id, key: "marketing.sms", enabled: true, admin });
      await confirmInSettings(v._id);
      assert.strictEqual(await marketingOk(v._id), true);
    });

    await check("Halloween sender: confirmed customers get exactly one text, phone-only and members do not, a rerun sends nothing", async () => {
      await SmsMessage.deleteMany({});
      // Only the people this check creates matter; earlier ones are skipped or already confirmed.
      const confirmed = await customer();
      await setCommunicationPreference({ userId: confirmed._id, key: "marketing.sms", enabled: true, admin });
      await requestSmsConfirmation({ userId: confirmed._id, admin, sendPromo: fakeEmail, now: AFTERNOON });
      await confirmInSettings(confirmed._id);
      const linkOnly = await customer();
      await setCommunicationPreference({ userId: linkOnly._id, key: "marketing.sms", enabled: true, admin });
      await confirmSmsMarketing({ token: createConfirmToken(linkOnly._id, linkOnly.phone), req });
      const phoneOnly = await customer();
      await setCommunicationPreference({ userId: phoneOnly._id, key: "marketing.sms", enabled: true, admin });
      const member = await customer({ marketing: { marketingEnabled: true, marketingConsentAt: new Date(), marketingConsentSource: "sms_confirm_link" }, member: "active" });

      const first = await runHalloweenCampaign({ send: true, channels: ["sms"], clock: () => AFTERNOON, pauseMs: 0 });
      const to = new Set((await SmsMessage.find({ notificationType: "SEASONAL_MARKETING" }).lean()).map((m) => String(m.user)));
      assert.ok(to.has(String(confirmed._id)), "the confirmed customer is texted");
      assert.ok(!to.has(String(phoneOnly._id)), "a call alone is not texted");
      assert.ok(!to.has(String(linkOnly._id)), "the one-click link waits for the carrier registration");
      assert.ok(first.sms.skipped.written_consent_awaiting_a2p_registration >= 1, JSON.stringify(first.sms));
      assert.ok(!to.has(String(member._id)), "members are not texted");
      assert.ok(first.sms.skipped.phone_consent_awaiting_customer_confirmation >= 1, JSON.stringify(first.sms));
      const count = await SmsMessage.countDocuments({ notificationType: "SEASONAL_MARKETING" });
      const again = await runHalloweenCampaign({ send: true, channels: ["sms"], clock: () => AFTERNOON, pauseMs: 0 });
      assert.strictEqual(again.sms.accepted || 0, 0, JSON.stringify(again.sms));
      assert.strictEqual(await SmsMessage.countDocuments({ notificationType: "SEASONAL_MARKETING" }), count, "no duplicate");
    });
    await check("bulk request: dry run sends nothing; the send reaches only phone-call customers who have not confirmed, once", async () => {
      const { runConfirmationRequests } = require("./ops/send_sms_confirmation_requests");
      const fake = await customer();
      await setCommunicationPreference({ userId: fake._id, key: "marketing.sms", enabled: true, admin });
      const n = emails.length;
      const dry = await runConfirmationRequests({ send: false, sendPromo: fakeEmail, pauseMs: 0 });
      assert.strictEqual(emails.length, n, "dry run sends nothing");
      assert.ok(dry.eligible >= 1);
      const real = await runConfirmationRequests({ send: true, sendPromo: fakeEmail, pauseMs: 0 });
      assert.strictEqual(real.sent, dry.eligible);
      assert.ok(emails.slice(n).some((m) => m.to === fake.email));
      const own = emails.slice(n).map((m) => m.to);
      assert.strictEqual(new Set(own).size, own.length, "one each");
      const again = await runConfirmationRequests({ send: true, sendPromo: fakeEmail, pauseMs: 0 });
      assert.strictEqual(again.sent, 0, JSON.stringify(again));
      assert.ok(again.skipped.RECENTLY_SENT >= 1);
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
