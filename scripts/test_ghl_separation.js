/**
 * ProFixter customers live in ProFixter. GoHighLevel is for strangers.
 *
 * THE LINE THIS FILE DEFENDS
 *
 * A registered ProFixter user, customer, member or booking must never be
 * created, updated, tagged or synced into GHL because of their ProFixter
 * activity. Operational messaging is ours: our database, our email, our Twilio
 * number. GHL keeps the job it is actually good at - independent cold leads
 * and prospects who have no account here.
 *
 * WHY A TEST AND NOT A NOTE
 *
 * The integration that was removed was not one function. It was thirty-two
 * call sites spread across registration, four booking transitions, three
 * payment handlers, the reminder cron and two admin maintenance endpoints,
 * each individually reasonable and each wrapped in its own try/catch so it
 * failed quietly. Nothing about adding a thirty-third would have looked wrong
 * in review. This file is what makes it look wrong.
 *
 * WHAT IS DELIBERATELY STILL ALLOWED
 *
 * routes/ghl.js is INBOUND only: GoHighLevel calls us when a cold-call lead is
 * assigned to a rep, and we record it as a RepAttribution. It sends nothing to
 * GHL, it carries no customer data outward, and it is the front half of rep
 * commission tracking. It stays, and so does the CORS header it needs.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/**
 * The only files permitted to mention GoHighLevel at all.
 *
 * An allowlist rather than a directory rule, so adding a file to it is a
 * visible decision in a diff rather than a side effect of where somebody put
 * something.
 */
const ALLOWED = new Set([
  /* Inbound lead assignment. Receives from GHL; sends nothing. */
  path.join("routes", "ghl.js"),
  /* Stores rep ownership of a cold lead. Our record, our database. */
  path.join("models", "RepAttribution.js"),
  /* Mounts the inbound route and allows its shared-secret header. */
  "server.js",
  /* This file. */
  path.join("scripts", "test_ghl_separation.js"),
]);

/** Directories that ship to production. Tests and scripts are scanned separately. */
const PRODUCTION_DIRS = ["routes", "utils", "jobs", "models", "middleware", "services"];

/** The names that mean somebody is talking to GoHighLevel. */
const FORBIDDEN = [
  "leadconnectorhq",
  "createOrUpdateContact",
  "addTag",
  "removeTag",
  "updateContactFields",
  "ghlContact",
  "ghlSync",
  "syncGhlConversion",
];

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error?.message || error}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function walk(dir) {
  const out = [];
  const base = path.join(ROOT, dir);
  if (!fs.existsSync(base)) return out;
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (entry.name.endsWith(".js")) out.push(rel);
  }
  return out;
}

/**
 * Source with comments stripped.
 *
 * The removal left explanatory comments behind on purpose - a future reader
 * should find out WHY registration no longer touches GHL at the place it used
 * to. Those sentences name the thing they removed, so a scan of raw source
 * would fail on its own documentation. Code is what this test is about.
 */
function codeOf(file) {
  return fs
    .readFileSync(path.join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function main() {
  /* ==================================================================== */
  section("No production code talks to GoHighLevel");

  const productionFiles = PRODUCTION_DIRS.flatMap(walk);

  test("the scan actually found the application", () => {
    assert.ok(
      productionFiles.length > 50,
      `only ${productionFiles.length} files scanned - the walk is broken, not the code`
    );
  });

  for (const term of FORBIDDEN) {
    test(`no production file references ${term}`, () => {
      const offenders = productionFiles.filter(
        (file) => !ALLOWED.has(file) && codeOf(file).includes(term)
      );
      assert.deepStrictEqual(
        offenders,
        [],
        `${term} reappeared in: ${offenders.join(", ")}. ProFixter customer activity ` +
          `must not reach GoHighLevel. If this is genuinely independent lead work, ` +
          `add the file to ALLOWED in this test and say why.`
      );
    });
  }

  test("the two outbound GHL modules no longer exist", () => {
    for (const gone of ["utils/ghlContact.js", "utils/ghlSync.js"]) {
      assert.ok(
        !fs.existsSync(path.join(ROOT, gone)),
        `${gone} is back; it is the only thing that could create a GHL contact`
      );
    }
  });

  test("nothing anywhere can reach leadconnectorhq outbound", () => {
    const everything = [...productionFiles, "server.js"];
    const callers = everything.filter((file) => {
      if (ALLOWED.has(file)) return false;
      return codeOf(file).includes("leadconnectorhq");
    });
    assert.deepStrictEqual(callers, [], `outbound GHL host reachable from: ${callers.join(", ")}`);
  });

  /* ==================================================================== */
  section("The operational hooks are gone from the exact places they were");

  /*
   * Asserted as the ABSENCE OF A CALL, not the absence of a string.
   *
   * The first version of this checked each file for its old tag names and
   * failed on all four - because "booking_created" is also a native email
   * template key, "booking_confirmed" is an admin timeline label, and
   * "booking_reminder_24h" is the name of an email. Every one of those is
   * legitimate and none of them touches GoHighLevel. A test that cannot tell a
   * tag from a template name would be paid off by deleting the wrong thing.
   *
   * The forbidden-term scan above already proves no file can call addTag,
   * createOrUpdateContact or reach leadconnectorhq at all, which is the real
   * guarantee. What is left to assert here is narrower and unambiguous: the
   * two admin endpoints that existed only to push customers into GHL are gone,
   * and the reminder job's tag machinery is gone with them.
   */
  const GONE = {
    "routes/admin.js": ["ghl/sync-all-users", "ghl/subscription-tags/cleanup"],
    "jobs/bookingReminders.js": [
      "applyReminderTag",
      "retryPendingTags",
      "sendReminderSmsTag",
      "tagField",
      "tagAttemptsField",
      "ghlTag",
    ],
  };

  for (const [file, names] of Object.entries(GONE)) {
    test(`${file} no longer contains its GHL machinery`, () => {
      const code = codeOf(file);
      for (const name of names) {
        assert.ok(!code.includes(name), `${file} still contains ${name}`);
      }
    });
  }

  test("the reminder job keeps its own bookkeeping fields", () => {
    /*
     * Only the TAG fields were removed. The email and SMS fields that make a
     * reminder idempotent must survive, or a cron restart resends everything.
     */
    const code = codeOf(path.join("jobs", "bookingReminders.js"));
    for (const field of ["sentField", "queuedField", "attemptsField", "messageIdField"]) {
      assert.ok(code.includes(field), `${field} is reminder idempotency and must remain`);
    }
  });

  /* ==================================================================== */
  section("Independent lead generation is untouched");

  test("the inbound lead-assignment route still exists", () => {
    const src = fs.readFileSync(path.join(ROOT, "routes", "ghl.js"), "utf8");
    assert.match(src, /\/lead-assigned/, "the cold-lead intake endpoint must remain");
    assert.match(src, /RepAttribution/, "it must still record rep ownership");
    assert.match(src, /GHL_WEBHOOK_SECRET/, "it must stay authenticated");
  });

  test("it is inbound only - it sends nothing to GHL", () => {
    const code = codeOf(path.join("routes", "ghl.js"));
    assert.ok(!code.includes("leadconnectorhq"), "the lead route must never call out to GHL");
    assert.ok(!/fetch\s*\(/.test(code), "the lead route must make no outbound HTTP call at all");
  });

  test("server still mounts it and allows its header", () => {
    const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    assert.match(src, /app\.use\("\/api\/ghl"/, "the inbound route must stay mounted");
    assert.match(src, /x-ghl-secret/, "its shared-secret header must stay allowed through CORS");
  });

  test("RepAttribution survives, with its commission fields", () => {
    const src = fs.readFileSync(path.join(ROOT, "models", "RepAttribution.js"), "utf8");
    for (const field of ["commissionAmount", "commissionRate"]) {
      assert.ok(src.includes(field), `${field} is rep attribution data and must not be removed`);
    }
  });

  /* ==================================================================== */
  section("Native channels still exist");

  test("reminders still send email and native SMS", () => {
    const code = codeOf(path.join("jobs", "bookingReminders.js"));
    assert.ok(code.includes("applyReminderSms"), "the native SMS reminder must remain");
    assert.ok(
      /sendReminderEmail|mail\.|sendTx/.test(code),
      "the email reminder must remain - it is the operational fallback"
    );
  });

  test("registration still sends its welcome email", () => {
    const code = codeOf(path.join("routes", "auth.js"));
    assert.ok(/sendTx\(\s*["']welcome["']/.test(code), "the welcome email must survive");
  });

  test("the native SMS notification layer is still wired in", () => {
    for (const file of ["routes/auth.js", "routes/bookings.js", "routes/admin.js", "routes/webhook.js"]) {
      const code = codeOf(file);
      assert.ok(
        code.includes("smsNotify") || code.includes("smsNotifications"),
        `${file} lost its native SMS notifications`
      );
    }
  });

  /* ==================================================================== */
  console.log("");
  if (failures.length) {
    console.log(`${passed} passed, ${failures.length} failed`);
    process.exit(1);
  }
  console.log(`${passed} passed, 0 failed`);
}

main();
