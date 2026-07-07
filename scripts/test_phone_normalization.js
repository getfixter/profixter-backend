const assert = require("node:assert/strict");
const {
  extractUSNationalPhoneDigits,
  normalizePhone,
  normalizePhoneE164,
} = require("../utils/identity");

const validCases = [
  ["6315991363", "6315991363", "16315991363", "+16315991363"],
  ["(631) 599-1363", "6315991363", "16315991363", "+16315991363"],
  ["1 631 599 1363", "6315991363", "16315991363", "+16315991363"],
  ["+1 (631) 599-1363", "6315991363", "16315991363", "+16315991363"],
  ["11 631 599 1363", "6315991363", "16315991363", "+16315991363"],
  ["+1 1 631 599 1363", "6315991363", "16315991363", "+16315991363"],
  ["1 (347) 865-5452", "3478655452", "13478655452", "+13478655452"],
  ["+1 347 865 5452", "3478655452", "13478655452", "+13478655452"],
];

for (const [input, national, normalized, e164] of validCases) {
  assert.equal(extractUSNationalPhoneDigits(input), national, `national digits for ${input}`);
  assert.equal(normalizePhone(input), normalized, `normalized digits for ${input}`);
  assert.equal(normalizePhoneE164(input), e164, `E.164 for ${input}`);
}

const invalidCases = [
  "",
  "555",
  "11347865452",
  "+1 134 786 5452",
  "6311991363",
  "1315991363",
];

for (const input of invalidCases) {
  assert.equal(extractUSNationalPhoneDigits(input), null, `invalid national digits for ${input}`);
  assert.equal(normalizePhone(input), null, `invalid normalized digits for ${input}`);
  assert.equal(normalizePhoneE164(input), null, `invalid E.164 for ${input}`);
}

console.log("Phone normalization tests passed");
