/*
 * Meta tracking: one dataset, one event id, no double counting.
 *
 * The failures this guards against are all silent. A wrong pixel id still
 * returns 200. An event sent twice under two ids still shows up in Events
 * Manager, just twice. An unhashed email is accepted and simply never matches.
 * None of it breaks the site, so none of it surfaces without a test that looks.
 *
 *   node scripts/test_meta_tracking.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const FRONTEND =
  process.env.META_TEST_FRONTEND || path.join(__dirname, "..", "..", "FrontEnd");
/*
 * CI checks out this repo alone, with no FrontEnd beside it. The checks that
 * read frontend source are skipped there rather than failed, so they guard
 * every local run without blocking every backend deploy.
 */
const HAS_FRONTEND = fs.existsSync(path.join(FRONTEND, "package.json"));
const metaCapi = require("../utils/metaCapi");

/** The only dataset application code may write to. */
const CORRECT_PIXEL = "3668264173327839";
/** The pixel that was live for months and belongs to the wrong account. */
const OLD_PIXEL = "4096130163937669";
/** A mistaken id supplied during this work and corrected before release. */
const WRONG_PIXEL = "2681929598889944";

let passed = 0;
const failures = [];

function test(name, fn) {
  if (!HAS_FRONTEND && /FRONTEND/.test(fn.toString())) {
    console.log(`SKIP  ${name}  (no FrontEnd checkout)`);
    return;
  }
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

/** Read a source file, newline-normalised so CRLF checkouts match the same way. */
function read(...parts) {
  const file = path.join(...parts);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/**
 * Every tracked source file in a repo, excluding build output and deps.
 *
 * This file is excluded from its own scan. It names all three pixel ids and the
 * old environment variable on purpose - they are what it is looking for - and
 * without the exclusion the suite reports itself as the offender every time.
 */
function sourceFiles(root) {
  const out = [];
  const skip = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage"]);
  const selfPath = path.resolve(__filename);
  /*
   * The tracking tests are excluded from the scan, in both repos. They name all
   * three pixel ids and the retired environment variable deliberately - that is
   * what they are searching for - and including them means the suite reports
   * itself as the offender every time.
   */
  const isTrackingTest = (name) => /^test_meta_(tracking|browser)\.js$/.test(name);
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        /\.(ts|tsx|js|jsx)$/.test(entry.name) &&
        path.resolve(full) !== selfPath &&
        !isTrackingTest(entry.name)
      ) {
        out.push(full);
      }
    }
  })(root);
  return out;
}

console.log("\n--- the dataset ---");

test("application code names exactly one Meta pixel, and it is the right one", () => {
  const repos = [path.join(__dirname, ".."), FRONTEND];
  const hits = { correct: [], old: [], wrong: [] };

  for (const repo of repos) {
    if (!fs.existsSync(repo)) continue;
    for (const file of sourceFiles(repo)) {
      const body = fs.readFileSync(file, "utf8");
      if (body.includes(CORRECT_PIXEL)) hits.correct.push(file);
      if (body.includes(OLD_PIXEL)) hits.old.push(file);
      if (body.includes(WRONG_PIXEL)) hits.wrong.push(file);
    }
  }

  assert.equal(
    hits.old.length,
    0,
    `the old pixel ${OLD_PIXEL} is still in source: ${hits.old.join(", ")}`
  );
  assert.equal(
    hits.wrong.length,
    0,
    `the mistaken pixel ${WRONG_PIXEL} is still in source: ${hits.wrong.join(", ")}`
  );
  assert.equal(
    hits.correct.length,
    2,
    `expected the pixel id in exactly two constants (lib/meta.ts and utils/metaCapi.js), found ${hits.correct.length}: ${hits.correct.join(", ")}`
  );
});

test("the browser and the server agree on the dataset", () => {
  /*
   * The id lives in lib/meta-config.ts, which carries no "use client".
   * It used to be declared in lib/meta.ts, and the root layout - a Server
   * Component - imported it from there to interpolate into the pixel snippet.
   * A constant imported from a client module reaches a server component as a
   * client reference rather than a string, so the site shipped a pixel with an
   * empty id: script present, noscript present, nothing attributable.
   */
  const config = read(FRONTEND, "lib", "meta-config.ts");
  assert.ok(config, "FrontEnd/lib/meta-config.ts not found");
  assert.ok(
    config.includes(`export const META_PIXEL_ID = "${CORRECT_PIXEL}"`),
    "lib/meta-config.ts does not declare the correct pixel"
  );
  assert.ok(
    !/^\s*["']use client["']/m.test(config),
    'lib/meta-config.ts must NOT be a client module, or the server layout renders an empty pixel id'
  );
  assert.equal(metaCapi.META_PIXEL_ID, CORRECT_PIXEL, "utils/metaCapi.js disagrees");

  const layout = read(FRONTEND, "app", "layout.tsx");
  assert.ok(
    layout.includes('from "@/lib/meta-config"'),
    "the root layout must import the id from the non-client module"
  );
});

test("no environment variable can redirect events to another dataset", () => {
  const sender = read(__dirname, "..", "utils", "metaCapi.js");
  const pixelLine = sender.split("\n").find((l) => l.includes("const META_PIXEL_ID"));
  assert.ok(
    !/process\.env/.test(pixelLine),
    "the pixel id must be a literal, not read from the environment"
  );

  // The old env-driven id is what put events in the wrong account. Nothing may read it.
  for (const file of sourceFiles(path.join(__dirname, ".."))) {
    const body = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const codeOnly = body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(
      !/process\.env\.FB_PIXEL_ID/.test(codeOnly),
      `${path.basename(file)} still reads process.env.FB_PIXEL_ID`
    );
  }
});

console.log("\n--- exactly one pixel initialisation ---");

test("fbq('init') for the base pixel happens in exactly one place", () => {
  const inits = [];
  for (const file of sourceFiles(FRONTEND)) {
    const body = fs.readFileSync(file, "utf8");
    // The base install, as opposed to an advanced-matching re-init.
    if (/fbq\(\s*['"]init['"]\s*,\s*[`'"]\$\{?\w*PIXEL/.test(body) || /fbq\('init', '\$\{FB_PIXEL_ID\}'\)/.test(body)) {
      inits.push(file);
    }
  }
  assert.equal(inits.length, 1, `expected one base init, found: ${inits.join(", ")}`);
  assert.ok(inits[0].endsWith("layout.tsx"), `base init should be in layout.tsx, found ${inits[0]}`);
});

/*
 * Two call sites, each with one job: the snippet in layout.tsx counts the first
 * load, MetaPageView counts client-side route changes. fbevents.js's own
 * pushState listener must stay off, or every navigation counts twice.
 */
test("PageView is tracked once per page", () => {
  const sites = [];
  for (const file of sourceFiles(FRONTEND)) {
    const body = fs.readFileSync(file, "utf8");
    const n = (body.match(/fbq\(\s*['"]track['"]\s*,\s*['"]PageView['"]/g) || []).length;
    for (let i = 0; i < n; i += 1) sites.push(path.basename(file));
  }
  assert.deepEqual(
    sites.sort(),
    ["MetaPageView.tsx", "layout.tsx"],
    `PageView call sites: ${sites.join(", ") || "none"}`
  );
  const layout = read(FRONTEND, "app", "layout.tsx");
  assert.ok(
    layout.includes("fbq.disablePushState = true"),
    "the pixel's automatic pushState PageView is not disabled"
  );
  // Without this, fbevents.js drops every route-change PageView as a duplicate.
  assert.ok(
    layout.includes("fbq.allowDuplicatePageViews = true"),
    "route-change PageViews will be dropped by fbevents.js"
  );
});

test("GTM stays installed", () => {
  const layout = read(FRONTEND, "app", "layout.tsx");
  assert.ok(layout.includes("GTM-KFPSD2P6"), "the GTM container was removed");
});

console.log("\n--- identity is hashed, and only where it should be ---");

test("email, phone, names, city, state and zip are all SHA-256", () => {
  const userData = metaCapi.buildUserData({
    user: { email: "Taras@Example.com", phone: "(631) 599-1363", name: "Taras Bandura" },
    address: { city: "Bay Shore", state: "NY", zip: "11706-0001" },
    externalId: "u-1",
  });

  for (const key of ["em", "ph", "fn", "ln", "ct", "st", "zp", "external_id"]) {
    assert.ok(userData[key], `${key} missing`);
    assert.match(userData[key][0], /^[a-f0-9]{64}$/, `${key} is not a SHA-256 digest`);
  }

  const raw = JSON.stringify(userData);
  assert.ok(!raw.includes("Taras"), "a plaintext name reached the payload");
  assert.ok(!raw.includes("example.com"), "a plaintext email reached the payload");
  assert.ok(!raw.includes("6315991363"), "a plaintext phone reached the payload");
});

test("the identifiers Meta requires raw are NOT hashed", () => {
  const userData = metaCapi.buildUserData({
    user: { email: "a@b.com" },
    fbp: "fb.1.1700000000000.1234567890",
    fbc: "fb.1.1700000000000.ABC",
    clientIp: "203.0.113.9",
    userAgent: "Mozilla/5.0",
  });
  assert.equal(userData.fbp, "fb.1.1700000000000.1234567890");
  assert.equal(userData.fbc, "fb.1.1700000000000.ABC");
  assert.equal(userData.client_ip_address, "203.0.113.9");
  assert.equal(userData.client_user_agent, "Mozilla/5.0");
});

test("a phone becomes digits beginning with the country code", () => {
  assert.equal(metaCapi.normalizePhone("(631) 599-1363"), "16315991363");
  assert.equal(metaCapi.normalizePhone("+1 631-599-1363"), "16315991363");
  assert.equal(metaCapi.normalizePhone("631.599.1363"), "16315991363");
  assert.equal(metaCapi.normalizePhone(""), "");
});

test("a ZIP+4 is reduced to five digits", () => {
  assert.equal(metaCapi.normalizeZip("11706-0001"), "11706");
  assert.equal(metaCapi.normalizeZip("11706"), "11706");
});

console.log("\n--- deduplication ---");

test("fbc is rebuilt from an fbclid when the cookie is missing", () => {
  const built = metaCapi.resolveFbc({
    fbclid: "IwAR123",
    fbclidAt: 1700000000000,
    req: { headers: {} },
  });
  assert.equal(built, "fb.1.1700000000000.IwAR123");
});

test("an existing _fbc cookie wins over a rebuilt one", () => {
  const fromCookie = metaCapi.resolveFbc({
    fbclid: "IwAR123",
    req: { headers: { cookie: "_fbc=fb.1.999.REAL; _fbp=fb.1.2.3" } },
  });
  assert.equal(fromCookie, "fb.1.999.REAL");
});

test("the one-time Purchase id is derivable by both sides from the Stripe session", () => {
  /*
   * The browser and the webhook never exchange this id - each computes it from
   * the session id, which both hold. If either side changes the shape, the two
   * stop deduplicating and every paid visit is counted twice.
   */
  const webhook = read(__dirname, "..", "routes", "webhook.js");
  const browser = read(FRONTEND, "app", "book", "confirmation", "BookConfirmationTracker.tsx");
  assert.ok(webhook.includes("eventId: `sess_${session.id}`"), "webhook id shape changed");
  assert.ok(browser.includes("eventId: `sess_${sessionId}`"), "browser id shape changed");
});

test("the membership Subscribe id survives the User schema", () => {
  /*
   * routes/stripe.js has always written lastPurchase.eventId; the schema used
   * to drop it, so the webhook fell back to a session-derived id the browser
   * could not know and every membership was counted twice.
   */
  const User = require("../models/User");
  const declared = Object.keys(User.schema.paths).filter((p) => p.startsWith("lastPurchase."));
  for (const field of ["eventId", "fbp", "fbc", "clientIp", "userAgent", "sourceUrl"]) {
    assert.ok(
      declared.includes(`lastPurchase.${field}`),
      `lastPurchase.${field} is not declared and will be silently discarded on write`
    );
  }
});

test("the confirmation page reads that id back instead of minting its own", () => {
  const track = read(__dirname, "..", "routes", "track.js");
  const page = read(FRONTEND, "app", "confirmationpage", "ConfirmationClient.tsx");
  assert.ok(track.includes("eventId: user.lastPurchase.eventId"), "the endpoint stopped returning the id");
  assert.ok(page.includes("eventId: data.eventId"), "the confirmation page stopped using it");
});

console.log("\n--- no double counting ---");

test("a membership is Subscribe, never Purchase", () => {
  const webhook = read(__dirname, "..", "routes", "webhook.js");
  const page = read(FRONTEND, "app", "confirmationpage", "ConfirmationClient.tsx");
  assert.ok(webhook.includes('eventName: "Subscribe"'), "the webhook no longer sends Subscribe");
  assert.ok(page.includes("trackSubscribe("), "the confirmation page no longer sends Subscribe");
  assert.ok(!page.includes("trackPurchase("), "the confirmation page still sends Purchase too");
});

test("the browser does not relay a conversion the server already sent", () => {
  const page = read(FRONTEND, "app", "confirmationpage", "ConfirmationClient.tsx");
  const book = read(FRONTEND, "app", "book", "confirmation", "BookConfirmationTracker.tsx");
  const signup = read(FRONTEND, "app", "(auth)", "signup", "page.tsx");
  assert.ok(page.includes("relay: false"), "confirmation page would relay a Subscribe the webhook sent");
  assert.ok(book.includes("relay: false"), "book confirmation would relay a Purchase the webhook sent");
  assert.ok(signup.includes("relay: false"), "signup would relay a Lead the register handler sent");
});

test("the old un-deduplicated trackPurchase is gone from lib/analytics", () => {
  const analytics = read(FRONTEND, "lib", "analytics.ts");
  assert.ok(
    !/export function trackPurchase/.test(analytics),
    "lib/analytics still exports a Purchase helper with no eventID"
  );
});

test("each conversion has exactly one browser call site", () => {
  const counts = { trackSubscribe: 0, trackStartSignup: 0 };
  for (const file of sourceFiles(FRONTEND)) {
    if (file.endsWith(path.join("lib", "meta.ts"))) continue;
    const body = fs.readFileSync(file, "utf8");
    for (const name of Object.keys(counts)) {
      counts[name] += (body.match(new RegExp(`${name}\\(`, "g")) || []).length;
    }
  }
  assert.equal(counts.trackSubscribe, 1, `Subscribe fires from ${counts.trackSubscribe} places`);
  assert.equal(counts.trackStartSignup, 1, `StartSignup fires from ${counts.trackStartSignup} places`);
});

test("the relay refuses event names outside the three conversions", () => {
  const track = read(__dirname, "..", "routes", "track.js");
  assert.ok(
    track.includes('new Set(["Lead", "Subscribe", "Purchase"])'),
    "the relay allow-list is missing - it would be an open door to the dataset"
  );
});

console.log("\n--- failures cost nothing ---");

test("no token means no send, and no throw", async () => {
  const saved = [process.env.META_CAPI_TOKEN, process.env.FB_ACCESS_TOKEN];
  process.env.META_CAPI_TOKEN = "";
  process.env.FB_ACCESS_TOKEN = "";
  const result = await metaCapi.send({ eventName: "Lead", user: { email: "a@b.com" } });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "not_configured");
  [process.env.META_CAPI_TOKEN, process.env.FB_ACCESS_TOKEN] = saved;
});

test("an event nobody can be matched to is not sent", async () => {
  process.env.META_CAPI_TOKEN = "test-token";
  const result = await metaCapi.send({ eventName: "Lead" });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "no_identifiers");
  delete process.env.META_CAPI_TOKEN;
});

test("sendDetached never rejects", () => {
  assert.doesNotThrow(() => metaCapi.sendDetached({ eventName: "Lead" }));
  assert.doesNotThrow(() => metaCapi.sendDetached({}));
});

test("the token is never exposed to the browser", () => {
  for (const file of sourceFiles(FRONTEND)) {
    const body = fs.readFileSync(file, "utf8");
    assert.ok(!body.includes("META_CAPI_TOKEN"), `${path.basename(file)} references the CAPI token`);
    assert.ok(
      !/NEXT_PUBLIC_.*(CAPI|ACCESS_TOKEN)/.test(body),
      `${path.basename(file)} exposes a token through a NEXT_PUBLIC variable`
    );
  }
});

test("registration still succeeds when tracking cannot", () => {
  const auth = read(__dirname, "..", "routes", "auth.js");
  const block = auth.slice(auth.indexOf('eventName: "Lead"') - 900, auth.indexOf('eventName: "Lead"') + 1400);
  assert.ok(block.includes("sendDetached"), "the Lead is awaited on the registration path");
  assert.ok(/try\s*{/.test(block), "the Lead dispatch is not wrapped");
});

console.log("\n--- the dataLayer ---");

test("all five dataLayer names are pushed", () => {
  const meta = read(FRONTEND, "lib", "meta.ts");
  for (const name of ["start_signup", "free_visit_booked", "subscribe", "purchase", "phone_click"]) {
    assert.ok(meta.includes(`"${name}"`), `dataLayer event ${name} is missing`);
  }
});

const total = passed + failures.length;
console.log(`\n${passed}/${total} checks passed`);
if (failures.length) {
  console.log("FAILURES:");
  failures.forEach((f) => console.log(` - ${f.name}: ${f.message}`));
  process.exit(1);
}
