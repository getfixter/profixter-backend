/*
 * Customer notification accuracy (2026-11-03).
 *
 *  - A booking waiting for Admin approval is never told it is "confirmed"
 *    (SMS wording and its own dedupe key, so the real confirmation still goes).
 *  - The Free Visit confirmation email describes a to-do-list walkthrough with
 *    no labor, and no work-area or materials instructions. Other visits keep
 *    their wording.
 *  - The post-Free-Visit marketing emails never say work was done.
 *
 * No database, network or sending.
 *
 *   node scripts/test_notification_accuracy.js
 */
process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
const assert = require("assert");
const { TEMPLATES } = require("../utils/sms/smsTemplates");
const dedupe = require("../utils/sms/smsDedupe");
const emailService = require("../utils/emailService");
const { POST_FREE_VISIT } = require("../utils/marketing/marketingLibrary");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}
const booking = (extra = {}) => ({
  _id: "64b000000000000000000001",
  bookingNumber: "123",
  date: new Date("2026-11-10T15:00:00Z"),
  selectedTask: "Hang a shelf",
  ...extra,
});
const strip = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

console.log("\nSMS: pending is a request, not a confirmation");
for (const [type, kind] of [
  ["BOOKING_CONFIRMED", {}],
  ["ONE_TIME_VISIT_CONFIRMED", { accessType: "one_time" }],
  ["FULL_DAY_CONFIRMED", { bookingType: "full_day" }],
]) {
  check(`${type}: pending says "received", confirmed says "confirmed"`, () => {
    for (const status of ["Pending", "pending_confirmation"]) {
      const text = TEMPLATES[type]({ booking: booking({ ...kind, status }) });
      assert.ok(/received/i.test(text) && /once it's confirmed/i.test(text), text);
      assert.ok(!/\bis confirmed\b|\bconfirmed for\b|\bsee you\b/i.test(text), text);
    }
    const confirmed = TEMPLATES[type]({ booking: booking({ ...kind, status: "Confirmed" }) });
    assert.ok(/confirm/i.test(confirmed) && !/we received your/i.test(confirmed), confirmed);
  });
}
check("the request and the confirmation have different dedupe keys", () => {
  const b = booking();
  assert.notStrictEqual(dedupe.bookingKey("BOOKING_REQUESTED", b), dedupe.bookingKey("BOOKING_CONFIRMED", b));
  const src = require("fs").readFileSync(require.resolve("../utils/sms/smsNotifications"), "utf8");
  assert.ok(src.includes('/pending/i.test(String(booking?.status || "")) ? "BOOKING_REQUESTED" : "BOOKING_CONFIRMED"'));
});

console.log("\nEmail: the Free Visit confirmation");
check("a Free Visit is a to-do-list walkthrough with no labor, no materials", () => {
  const e = emailService.TEMPLATES.booking_confirmed({ bookingNumber: "1", service: "Free Visit", freeVisitPurpose: "consultation" });
  for (const body of [strip(e.html), e.text]) {
    assert.ok(/to-do list/.test(body) && /Repairs and labor are not included in the Free Visit/.test(body), body);
    assert.ok(!/work area|materials/i.test(body), body);
  }
});
check("every other visit keeps its preparation lines", () => {
  for (const vars of [{}, { accessType: "one_time" }, { bookingType: "full_day" }, { freeVisitPurpose: "" }]) {
    const e = emailService.TEMPLATES.booking_confirmed({ bookingNumber: "2", service: "Repair", ...vars });
    assert.ok(/materials/i.test(strip(e.html)) && /work area and any required materials/.test(e.text), JSON.stringify(vars));
    assert.ok(!/Repairs and labor are not included/.test(e.text));
  }
});

console.log("\nMarketing: after a Free Visit, nothing says work was done");
check("post-Free-Visit emails never claim repairs, fixes or labor were done", () => {
  const LABOR = /\b(we|our fixter) (fixed|repaired|finished|installed|took care of)\b|work we did|job we did|the repair|the fix\b|job got done|used us once|another single visit|handle that job/i;
  for (const t of POST_FREE_VISIT) {
    const parts = [t.subject, t.altSubject, t.preheader, t.headline, t.closing, ...(t.paragraphs || [])].map((p) =>
      typeof p === "function" ? p({ name: "Ann" }) : String(p || "")
    );
    for (const p of parts) assert.ok(!LABOR.test(p), `${t.id}: ${p}`);
  }
});

console.log("\nAdmin: an On marketing switch says when nothing will be sent");
check("the first reason wins, and a qualifying switch with everything on is sending", () => {
  const { deliveryNote } = require("../utils/admin/communicationControls");
  const saved = { ...process.env };
  try {
    process.env.ENABLE_MARKETING_EMAILS = "false";
    assert.deepStrictEqual(deliveryNote({ channel: "email", enabled: true }), { sending: false, reason: "marketing_email_paused" });
    process.env.ENABLE_MARKETING_EMAILS = "true";
    assert.deepStrictEqual(deliveryNote({ channel: "email", enabled: true }), { sending: true, reason: null });
    assert.deepStrictEqual(deliveryNote({ channel: "email", enabled: false }), { sending: false, reason: null });
    process.env.SMS_ENABLED = "true";
    process.env.SMS_MARKETING_ENABLED = "false";
    assert.strictEqual(deliveryNote({ channel: "sms", enabled: true }).reason, "marketing_texts_off");
    process.env.SMS_MARKETING_ENABLED = "true";
    assert.strictEqual(deliveryNote({ channel: "sms", enabled: true, phoneStatus: { status: "undeliverable" } }).reason, "phone_undeliverable");
    assert.strictEqual(deliveryNote({ channel: "sms", enabled: true, consentStatus: "needs_confirmation" }).reason, "needs_confirmation");
    assert.deepStrictEqual(deliveryNote({ channel: "sms", enabled: true }), { sending: true, reason: null });
  } finally {
    for (const k of ["ENABLE_MARKETING_EMAILS", "SMS_ENABLED", "SMS_MARKETING_ENABLED"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
