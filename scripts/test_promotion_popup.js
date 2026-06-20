const assert = require("node:assert/strict");
const {
  validActionUrl,
  validateInput,
} = require("../routes/promotionPopup");

assert.equal(validActionUrl("/membership"), true);
assert.equal(validActionUrl("https://www.profixter.com/membership"), true);
assert.equal(validActionUrl("//example.com"), false);
assert.equal(validActionUrl("http://example.com"), false);
assert.equal(validActionUrl("javascript:alert(1)"), false);

const valid = validateInput({
  enabled: true,
  title: "A useful homeowner offer",
  message: "A short, professional message.",
  promoCode: " summer10 ",
  ctaText: "View membership",
  ctaUrl: "/membership",
  secondaryText: "Request an estimate",
  secondaryUrl: "/estimate",
  startAt: "2026-06-20T12:00:00.000Z",
  endAt: "2026-06-21T12:00:00.000Z",
  target: "all_public",
});

assert.equal(valid.promoCode, "SUMMER10");
assert.equal(valid.target, "all_public");
assert.equal(valid.startAt.toISOString(), "2026-06-20T12:00:00.000Z");

assert.throws(
  () => validateInput({ enabled: true }),
  /Title is required/
);
assert.throws(
  () =>
    validateInput({
      enabled: true,
      title: "Title",
      message: "Message",
      ctaText: "Open",
      ctaUrl: "http://example.com",
    }),
  /CTA URL must be/
);
assert.throws(
  () =>
    validateInput({
      startAt: "2026-06-21T12:00:00.000Z",
      endAt: "2026-06-20T12:00:00.000Z",
    }),
  /End date must be after start date/
);

console.log("Promotion popup validation tests passed.");
