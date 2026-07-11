const assert = require("assert");
const { TEMPLATES } = require("../utils/emailService");
const { PUBLIC_CONTACT_EMAIL } = require("../utils/publicContact");

const sample = {
  name: "Taylor",
  otp: "123456",
  userId: "PF-1001",
  plan: "Plus",
  billingCycle: "monthly",
  address: "100 Main Street, Babylon, NY 11702",
  bookingNumber: "BK-2048",
  date: "2026-06-21T14:00:00.000Z",
  service: "Labor Only",
  accessEndDate: "July 31, 2026",
  canceledDate: "June 20, 2026",
  amount: "$49.00",
  billingDate: "June 20, 2026",
};

const oneTimeSample = {
  ...sample,
  service: "One-Time Handyman Visit",
  bookingType: "one_time_handyman_visit",
  accessType: "one_time",
  selectedTask: "Fix a loose handrail",
  price: "$99",
  durationMinutes: 90,
};

const customerTemplateKeys = [
  "welcome",
  "subscription_started",
  "booking_created",
  "booking_confirmed",
  "booking_completed",
  "booking_review_request",
  "booking_canceled",
  "booking_reminder_24h",
  "booking_reminder_60m",
  "subscription_cancellation_scheduled",
  "subscription_canceled",
  "payment_failed",
  "nurture_1",
  "nurture_2",
  "nurture_3",
  "nudge_subscribe",
  "password_otp",
  "password_changed",
];

const blockedPhrases = [
  "FREE!!!",
  "ACT NOW",
  "LIMITED TIME",
  "CLICK HERE",
  "GUARANTEED",
  "CONGRATULATIONS",
];

for (const key of customerTemplateKeys) {
  assert.strictEqual(typeof TEMPLATES[key], "function", `${key} is missing`);

  const rendered = TEMPLATES[key](sample);
  assert.ok(rendered.subject?.trim(), `${key} has no subject`);
  assert.ok(rendered.html?.trim(), `${key} has no HTML body`);
  assert.ok(rendered.text?.trim(), `${key} has no plain-text body`);
  assert.match(rendered.html, /max-width:600px/, `${key} is missing the 600px shell`);
  assert.match(rendered.html, /viewport/, `${key} is missing the mobile viewport`);
  assert.ok(rendered.html.includes(PUBLIC_CONTACT_EMAIL), `${key} is missing support contact`);
  assert.match(
    rendered.html,
    /Based in Babylon/,
    `${key} is missing the local business identity`
  );

  const combined = `${rendered.subject}\n${rendered.html}\n${rendered.text}`;
  for (const phrase of blockedPhrases) {
    assert.ok(!combined.includes(phrase), `${key} contains blocked phrase: ${phrase}`);
  }
}

const completed = TEMPLATES.booking_completed(sample);
assert.match(completed.html, /https:\/\/www\.profixter\.com\/tip/);
assert.match(completed.text, /https:\/\/www\.profixter\.com\/tip/);
assert.doesNotMatch(completed.html, /profixter\.com\/review/i);
assert.doesNotMatch(completed.text, /profixter\.com\/review/i);

const oneTimeReceipt = TEMPLATES.one_time_visit_payment_received(oneTimeSample);
assert.match(oneTimeReceipt.html, /\$99/);
assert.match(oneTimeReceipt.html, /90-minute One-Time Visit/);
assert.match(oneTimeReceipt.text, /admin review and final approval/i);
assert.match(oneTimeReceipt.text, /631-599-1363/);
assert.match(oneTimeReceipt.text, /does not offer appliance repair/i);
assert.match(oneTimeReceipt.text, /Project Estimate/i);
assert.doesNotMatch(`${oneTimeReceipt.html}\n${oneTimeReceipt.text}`, /subscription/i);

const oneTimeConfirmed = TEMPLATES.booking_confirmed(oneTimeSample);
assert.match(oneTimeConfirmed.html, /One-Time Visit/);
assert.match(oneTimeConfirmed.html, /\$99 \/ 90 minutes/);
assert.match(oneTimeConfirmed.text, /631-599-1363/);
assert.match(oneTimeConfirmed.text, /does not offer appliance repair/i);
assert.match(oneTimeConfirmed.text, /Project Estimate/i);
assert.doesNotMatch(`${oneTimeConfirmed.html}\n${oneTimeConfirmed.text}`, /subscription/i);

const oneTimeReminder24h = TEMPLATES.booking_reminder_24h(oneTimeSample);
assert.match(oneTimeReminder24h.text, /Cancellation or reschedule requests require admin approval/i);
assert.match(oneTimeReminder24h.text, /does not offer appliance repair/i);

const oneTimeReminder60m = TEMPLATES.booking_reminder_60m(oneTimeSample);
assert.match(oneTimeReminder60m.text, /If anything urgent changed, call 631-599-1363/i);
assert.match(oneTimeReminder60m.text, /does not offer appliance repair/i);

const oneTimeCompleted = TEMPLATES.booking_completed(oneTimeSample);
assert.match(oneTimeCompleted.text, /Compare membership/);
assert.match(oneTimeCompleted.text, /Book another visit/);
assert.doesNotMatch(oneTimeCompleted.text, /subscription/i);

const review = TEMPLATES.booking_review_request(sample);
assert.match(review.html, /https:\/\/www\.profixter\.com\/review/);
assert.match(review.text, /https:\/\/www\.profixter\.com\/review/);
assert.doesNotMatch(review.html, /profixter\.com\/tip/i);
assert.doesNotMatch(review.text, /profixter\.com\/tip/i);

for (const key of ["password_otp", "password_changed"]) {
  const rendered = TEMPLATES[key](sample);
  assert.doesNotMatch(rendered.html, /<a[^>]+background:#1d4ed8/i);
}

console.log(
  `Customer email template validation passed (${customerTemplateKeys.length} templates).`
);
