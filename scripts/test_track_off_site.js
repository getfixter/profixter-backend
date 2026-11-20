/*
 * The live API counts only the live site (2026-11-20, routes/track.js fromOffSitePage).
 *
 *   node scripts/test_track_off_site.js
 *
 * No database: the decision is the Origin header alone. In production a page on
 * any other host (a Vercel preview, a local build) is refused; profixter.com and
 * www are counted; a request with no Origin (a server, a test) is not refused;
 * and outside production nothing is refused, so a local backend still records.
 */
const assert = require("node:assert/strict");
const { fromOffSitePage } = require("../routes/track");

const req = (origin) => ({ headers: origin === undefined ? {} : { origin }, path: "/visit" });
const cases = [
  ["https://www.profixter.com", false],
  ["https://profixter.com", false],
  ["https://profixter-frontend-7ramha060-taras-projects-ddb61be0.vercel.app", true],
  ["http://localhost:3123", true],
  ["http://127.0.0.1:3000", true],
  ["https://www.profixter.com.evil.example", true],
  ["https://staging.profixter.com", true],
  ["not a url", true],
  [undefined, false],
  ["null", false],
];

let passed = 0;
const env = process.env.NODE_ENV;
process.env.NODE_ENV = "production";
for (const [origin, refused] of cases) {
  assert.equal(fromOffSitePage(req(origin)), refused, `production ${origin}`);
  passed += 1;
}
process.env.NODE_ENV = "development";
for (const [origin] of cases) {
  assert.equal(fromOffSitePage(req(origin)), false, `development ${origin}`);
  passed += 1;
}
process.env.NODE_ENV = env;
console.log(`${passed} passed, 0 failed`);
