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
/*
 * The telemarketer sales desk (2026-11, owner brief). INBOUND only: GHL calls
 * us (signed, off by default) with do-not-disturb changes and call/text
 * METADATA for contacts an employee mapped by hand; Profixter stores the GHL
 * contact id and builds deep links. It sends nothing to GHL and makes no
 * outbound HTTP call (asserted below).
 */
const SALES_DESK = [
  path.join("routes", "sales.js"),
  path.join("routes", "adminSalesDesk.js"),
  path.join("utils", "sales", "ghl.js"),
  path.join("utils", "sales", "leads.js"),
  path.join("utils", "sales", "views.js"),
  path.join("models", "Sales.js"),
];

const ALLOWED = new Set([
  ...SALES_DESK,
  /* Legacy route file: /lead-assigned now answers 410 and writes nothing. */
  path.join("routes", "ghl.js"),
  /* Stores rep ownership of a cold lead. Our record, our database. */
  path.join("models", "RepAttribution.js"),
  /* Mounts the inbound route and allows its shared-secret header. */
  "server.js",
  /*
   * LEAD WORK, READ-ONLY since 2026-11-12 (owner decision Q-6). Strangers in
   * GHL, never Profixter customers:
   * - the narrow GHL client: read one contact and search contacts. Its send,
   *   tag and note calls were removed with the reply agent.
   * - the old reply agent's service and (retired, never-sending) action, kept
   *   so stored threads and past actions stay readable;
   * - the postal-mail audience: READS the cold list to build mailing waves;
   *   writes nothing to GHL; existing customers are excluded by hash.
   * - their models, which only hold GHL ids for our own records.
   * The Google Business Profile Social Planner client (utils/ghl/socialPlanner.js)
   * was deleted on 2026-11-12: nothing may publish through GoHighLevel.
   */
  path.join("utils", "ghl", "client.js"),
  path.join("utils", "conversation", "service.js"),
  path.join("utils", "growth", "actions", "conversationReply.js"),
  path.join("utils", "outreach", "audience.js"),
  path.join("models", "ConversationThread.js"),
  path.join("models", "Outreach.js"),
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
  // the retired send paths (2026-11-12): replies, notes and Social Planner posts
  "sendReply",
  "addNote",
  "socialPlanner",
  "/social-media-posting",
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

  test("the old lead-assignment route is retired: it answers 410 and writes nothing", () => {
    const code = codeOf(path.join("routes", "ghl.js"));
    assert.match(code, /\/lead-assigned/);
    assert.match(code, /status\(410\)/, "retired, not silently accepting");
    assert.ok(!/RepAttribution|\.save\(|\.create\(/.test(code), "it must write nothing");
  });

  test("the sales desk only RECEIVES from GHL: no outbound call, no GHL API host", () => {
    for (const file of SALES_DESK) {
      const code = codeOf(file);
      assert.ok(!code.includes("leadconnectorhq"), `${file} must never call the GHL API`);
      assert.ok(!/\bfetch\s*\(|axios|https?\.request\(/.test(code), `${file} must make no outbound HTTP call`);
    }
  });

  test("it is inbound only - it sends nothing to GHL", () => {
    const code = codeOf(path.join("routes", "ghl.js"));
    assert.ok(!code.includes("leadconnectorhq"), "the lead route must never call out to GHL");
    assert.ok(!/fetch\s*\(/.test(code), "the lead route must make no outbound HTTP call at all");
  });

  test("server still mounts it and allows its header", () => {
    const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    assert.match(src, /app\.use\("\/api\/ghl"/, "the legacy route file stays mounted (to answer 410)");
    assert.match(src, /app\.post\("\/api\/ghl\/webhook", express\.raw/, "the signed sales-desk webhook is mounted with a raw body");
  });

  test("RepAttribution survives as a read-only archive of the retired commission (history is preserved)", () => {
    const src = fs.readFileSync(path.join(ROOT, "models", "RepAttribution.js"), "utf8");
    for (const field of ["commissionAmount", "commissionRate", "commissionStatus"]) {
      assert.ok(src.includes(field), `${field} is historical evidence and must not be removed`);
    }
    // ...and nothing writes to it any more: no signup or checkout path credits the old way.
    for (const file of [path.join("routes", "webhook.js"), path.join("utils", "auth", "accounts.js"), path.join("routes", "auth.js")]) {
      const code = codeOf(file);
      assert.ok(!/await markLeadSubscribed\(|await markLeadRegistered\(/.test(code), `${file} must not run the retired commission`);
    }
  });

  /* ==================================================================== */
  section("Retired 2026-11-12: the GHL reply agent and Google posting through GHL");

  test("the GHL client is read-only: no POST to conversations, tags or notes", () => {
    const code = codeOf(path.join("utils", "ghl", "client.js"));
    for (const gone of ["sendReply", "addTag", "addNote", "/conversations/messages", "/tags", "/notes"]) {
      assert.ok(!code.includes(gone), `utils/ghl/client.js still contains ${gone}`);
    }
  });

  test("the Social Planner client is deleted and no secret for it is loaded", () => {
    assert.ok(!fs.existsSync(path.join(ROOT, "utils", "ghl", "socialPlanner.js")));
    assert.ok(!codeOf(path.join("utils", "secrets.js")).includes("GHL_SOCIAL_TOKEN"));
  });

  test("the inbound-message webhook and the conversation poller are gone", () => {
    assert.ok(!codeOf(path.join("routes", "ghl.js")).includes("/inbound-message"));
    const jobs = codeOf(path.join("jobs", "conversations.js"));
    assert.ok(!jobs.includes("pollOnce") && !jobs.includes("*/10 * * * *"), "no 10-minute GHL poller");
    assert.ok(!jobs.includes("processWaiting"), "the poller no longer asks the reply agent to decide");
  });

  test("the communication settings no longer warn about GHL workflows overlapping native messages", () => {
    const code = codeOf(path.join("utils", "communications", "communicationSettings.js"));
    assert.ok(!/GHL (workflows|reminder_24h|reminder_60m)/.test(code));
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
