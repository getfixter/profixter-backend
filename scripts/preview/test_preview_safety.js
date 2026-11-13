/**
 * The local preview's guards (scripts/preview/safety.js, fakes.js, start.js).
 *
 *   - live-looking environments are refused: a remote MongoDB, a Stripe live or
 *     restricted key, Twilio / SES / Anthropic / GoHighLevel / OpenAI / Meta
 *     credentials; generic AWS credentials are scrubbed, not trusted
 *   - start.js itself exits with code 2 on such an environment, before it starts
 *     MongoDB or loads the app
 *   - the network guard refuses fetch, raw sockets, TLS and DNS to any
 *     non-loopback host and records each attempt, while loopback still works
 *   - the module fakes: Stripe refunds and webhooks refuse, Checkout returns a
 *     localhost URL, mail goes to the outbox, S3 writes to local disk and
 *     refuses keys outside its folder
 *
 * No database, no network: deterministic, so it runs in CI.
 *
 *   node scripts/preview/test_preview_safety.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const dns = require("dns");
const http = require("http");
const https = require("https");
const { spawnSync } = require("child_process");

const safety = require("./safety");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${String(error && error.stack ? error.stack : error).split("\n").slice(0, 4).join("\n      ")}`);
  }
}

/** A clean environment for child processes: only what Node needs to run. */
function baseEnv(extra = {}) {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ComSpec", "PATHEXT"];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}

async function main() {
  console.log("\nEnvironment guard");

  await check("a clean environment and a local MongoDB pass", async () => {
    const result = safety.checkEnv({ PATH: "/usr/bin", MONGO_URI: "mongodb://127.0.0.1:27555/profixter_preview?directConnection=true", STRIPE_SECRET_KEY: "sk_test_abc" });
    assert.strictEqual(result.ok, true, result.problems.join("; "));
  });

  const refused = {
    "remote mongodb+srv": { MONGO_URI: "mongodb+srv://user:pass@cluster0.example.mongodb.net/prod" },
    "remote mongodb host": { MONGO_URI: "mongodb://db.example.com:27017/prod" },
    "remote host hidden in a replica list": { MONGODB_URI: "mongodb://127.0.0.1:27017,db2.example.com:27017/prod?replicaSet=rs0" },
    "remote mongo under any variable name": { SOME_OTHER_URL: "mongodb://10.0.0.5:27017/prod" },
    "Stripe live secret key": { STRIPE_SECRET_KEY: "sk_live_" + "x".repeat(24) },
    "Stripe restricted live key in another variable": { BILLING_KEY: "rk_live_" + "y".repeat(24) },
    "Twilio auth token": { TWILIO_AUTH_TOKEN: "abc" },
    "Twilio API key": { TWILIO_API_KEY: "SK123" },
    "SES SMTP password": { AWS_SES_SMTP_PASS: "abc" },
    "Anthropic key": { ANTHROPIC_API_KEY: "sk-ant-abc" },
    "GoHighLevel token": { GHL_API_TOKEN: "abc" },
    "OpenAI key": { OPENAI_API_KEY: "sk-abc" },
    "Meta CAPI token": { META_CAPI_TOKEN: "abc" },
    "Google Places key": { GOOGLE_PLACES_API_KEY: "abc" },
  };
  for (const [label, env] of Object.entries(refused)) {
    await check(`refuses: ${label}`, async () => {
      const result = safety.checkEnv({ PATH: "/usr/bin", ...env });
      assert.strictEqual(result.ok, false);
      const name = Object.keys(env)[0];
      assert.ok(result.problems.some((p) => p.startsWith(name)), result.problems.join("; "));
      assert.throws(() => safety.assertSafeEnv({ ...env }), (error) => error.code === "PREVIEW_UNSAFE_ENV");
    });
  }

  await check("problems name the variable, never its value", async () => {
    const secret = "sk_live_" + "s3cr3tvalue".repeat(3);
    const result = safety.checkEnv({ STRIPE_SECRET_KEY: secret, TWILIO_AUTH_TOKEN: "tok-should-not-print" });
    const text = result.problems.join("\n");
    assert.ok(!text.includes(secret) && !text.includes("tok-should-not-print"), text);
  });

  await check("empty credential variables are not treated as present", async () => {
    assert.strictEqual(safety.checkEnv({ TWILIO_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "  " }).ok, true);
  });

  await check("generic AWS credentials are scrubbed, not trusted", async () => {
    const result = safety.checkEnv({ AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "x", AWS_PROFILE: "eb" });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.scrub.sort(), ["AWS_ACCESS_KEY_ID", "AWS_PROFILE", "AWS_SECRET_ACCESS_KEY"]);
  });

  console.log("\nstart.js refuses before starting anything");
  for (const [label, extra] of [
    ["Stripe live key", { STRIPE_SECRET_KEY: "sk_live_" + "z".repeat(24) }],
    ["remote MongoDB", { MONGO_URI: "mongodb+srv://u:p@cluster.example.mongodb.net/x" }],
    ["Twilio credential", { TWILIO_ACCOUNT_SID: "AC123" }],
  ]) {
    await check(`start.js exits 2 with a ${label} in the environment`, async () => {
      const started = Date.now();
      const result = spawnSync(process.execPath, [path.join(__dirname, "start.js"), "--data", path.join(os.tmpdir(), "preview-guard-never-created")], {
        env: baseEnv(extra),
        encoding: "utf8",
        timeout: 30000,
      });
      assert.strictEqual(result.status, 2, `exit ${result.status}\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /Refusing to start the preview/);
      assert.ok(!/MongoDB|seeding|Server running/.test(result.stdout), result.stdout);
      assert.ok(!fs.existsSync(path.join(os.tmpdir(), "preview-guard-never-created")), "created the data folder before refusing");
      assert.ok(Date.now() - started < 30000);
    });
  }

  console.log("\nNetwork guard");
  const lines = [];
  safety.installNetworkGuard({ log: (line) => lines.push(line) });

  await check("global fetch to an external host is refused and logged", async () => {
    await assert.rejects(fetch("https://api.stripe.com/v1/charges"), (error) => error.cause && error.cause.code === "PREVIEW_NETWORK_BLOCKED");
    assert.ok(lines.some((l) => l.includes("[preview blocked] outbound fetch to api.stripe.com")), lines.join("\n"));
  });

  await check("a raw TCP socket to an external host is refused", async () => {
    const error = await new Promise((resolve) => {
      const socket = net.connect(587, "email-smtp.us-east-1.amazonaws.com");
      socket.on("error", resolve);
      socket.on("connect", () => resolve(new Error("connected!")));
    });
    assert.strictEqual(error.code, "PREVIEW_NETWORK_BLOCKED");
  });

  await check("https.request (node-fetch, SDKs) to an external host is refused", async () => {
    const error = await new Promise((resolve) => {
      const request = https.request({ host: "api.twilio.com", port: 443, path: "/", method: "POST" });
      request.on("error", resolve);
      request.on("response", () => resolve(new Error("got a response!")));
      request.end();
    });
    assert.strictEqual(error.code, "PREVIEW_NETWORK_BLOCKED");
  });

  await check("an IP address outside loopback is refused", async () => {
    const error = await new Promise((resolve) => {
      const socket = net.connect({ host: "10.1.2.3", port: 27017 });
      socket.on("error", resolve);
      socket.on("connect", () => resolve(new Error("connected!")));
    });
    assert.strictEqual(error.code, "PREVIEW_NETWORK_BLOCKED");
  });

  await check("DNS lookups of external names are refused", async () => {
    const error = await new Promise((resolve) => dns.lookup("api.anthropic.com", (err) => resolve(err)));
    assert.ok(error && error.errno === "PREVIEW_NETWORK_BLOCKED", String(error));
    await assert.rejects(dns.promises.lookup("services.leadconnectorhq.com"));
  });

  await check("every refusal is recorded", async () => {
    const hosts = safety.blockedAttempts().map((b) => b.host);
    for (const host of ["api.stripe.com", "email-smtp.us-east-1.amazonaws.com", "api.twilio.com", "10.1.2.3", "api.anthropic.com"]) {
      assert.ok(hosts.includes(host), `${host} missing from ${hosts.join(", ")}`);
    }
  });

  await check("loopback still works (the app, MongoDB, the frontend)", async () => {
    const server = http.createServer((req, res) => res.end("ok"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      assert.strictEqual(await res.text(), "ok");
      const viaName = await fetch(`http://localhost:${port}/`).then((r) => r.text()).catch(() => "ok-ipv6-only");
      assert.ok(viaName.startsWith("ok"));
    } finally {
      server.close();
    }
  });

  console.log("\nModule fakes");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "preview-fakes-"));
  Object.assign(process.env, { NODE_ENV: "test", S3_BUCKET: "preview-local-bucket", AWS_REGION: "us-east-1", JWT_SECRET: "test", STRIPE_SECRET_KEY: "sk_test_preview_fake", PARAMETER_STORE_DISABLED: "true" });
  const { installFakes } = require("./fakes");
  const fakes = installFakes({ s3Root: path.join(tmp, "s3"), publicBase: "http://localhost:5055", log: (l) => lines.push(l), loadStripeData: async () => ({ catalog: {}, customers: [], subscriptions: [] }) });
  const BACKEND = path.resolve(__dirname, "..", "..");
  const requireApp = (request) => require(require.resolve(request, { paths: [BACKEND] }));

  await check("require('stripe') is the fake: refunds and webhooks refuse, Checkout stays on localhost", async () => {
    const stripe = requireApp("stripe")("sk_live_" + "q".repeat(24));
    await assert.rejects(stripe.refunds.create({ payment_intent: "pi_1" }), (e) => e.code === "preview_refunds_refused");
    assert.throws(() => stripe.webhooks.constructEvent("{}", "sig", "whsec"), (e) => e.code === "preview_webhooks_disabled");
    const session = await stripe.checkout.sessions.create({ mode: "payment", line_items: [] });
    assert.ok(session.url.startsWith("http://localhost:5055/"), session.url);
    const sm = requireApp(path.join(BACKEND, "utils", "subscriptionManagement.js"));
    assert.strictEqual(sm.stripe, stripe, "the app's Stripe client is not the fake");
  });

  await check("mail goes to the outbox, never to SES", async () => {
    const transport = requireApp("nodemailer").createTransport({ host: "email-smtp.us-east-1.amazonaws.com" });
    const info = await transport.sendMail({ to: "someone@example.test", subject: "Hello from the test", text: "hi" });
    assert.match(info.response, /preview outbox/);
    const items = await fakes.outbox.list();
    assert.ok(items.some((m) => m.subject === "Hello from the test" && m.channel === "email"));
    const emailService = requireApp(path.join(BACKEND, "utils", "emailService.js"));
    assert.strictEqual(emailService.transporter.sendMail, transport.sendMail);
  });

  await check("SMS go to the outbox through the faked Twilio provider", async () => {
    const provider = requireApp(path.join(BACKEND, "utils", "sms", "twilioProvider.js"));
    const result = await provider.sendMessage({ to: "+15165550101", body: "Test text", notificationType: "booking_confirmed" });
    assert.match(result.sid, /^SMpreview/);
    assert.ok((await fakes.outbox.list()).some((m) => m.channel === "sms" && m.body === "Test text"));
  });

  await check("utils/s3 writes to local disk, serves localhost URLs, and refuses keys outside its folder", async () => {
    const s3 = requireApp(path.join(BACKEND, "utils", "s3.js"));
    const url = await s3.putPublicObject({ Key: "uploads/test/a.jpg", Body: Buffer.from("jpg") });
    assert.strictEqual(url, "http://localhost:5055/preview-s3/uploads/test/a.jpg");
    assert.strictEqual(fs.readFileSync(path.join(tmp, "s3", "uploads", "test", "a.jpg"), "utf8"), "jpg");
    assert.strictEqual(String(await s3.getObjectBuffer({ Key: "uploads/test/a.jpg" })), "jpg");
    await assert.rejects(s3.putPrivateObject({ Key: "../../escape.txt", Body: Buffer.from("x") }));
    await assert.rejects(s3.getObjectBuffer({ Key: "missing.pdf" }), (e) => e.name === "NoSuchKey");
  });

  await check("AWS SDK clients refuse to send", async () => {
    const { SESv2Client } = requireApp("@aws-sdk/client-sesv2");
    await assert.rejects(new SESv2Client({ region: "us-east-1" }).send({}), (e) => e.name === "PreviewAwsDisabled");
  });

  await check("schedulers are replaced, and a .env file cannot add credentials", async () => {
    const reminders = requireApp(path.join(BACKEND, "jobs", "bookingReminders.js"));
    await reminders.startBookingReminders();
    assert.ok(fakes.disabled.includes("jobs/bookingReminders.startBookingReminders"));
    assert.deepStrictEqual(requireApp("dotenv").config(), { parsed: {} });
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
