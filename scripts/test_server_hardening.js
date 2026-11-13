/**
 * HTTP hardening from server.js: body limits, the error handler, CORS origins,
 * the public lead rate limits, and the retired /api/test/ping.
 *
 * server.js itself cannot be required in a test (it connects to MongoDB and
 * starts every cron), so the pieces live in utils/http/serverHardening and are
 * exercised here on a small app; server.js is checked for wiring by reading it.
 * No database, no network beyond 127.0.0.1.
 *
 *   node scripts/test_server_hardening.js
 */

process.env.NODE_ENV = "test";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");

const hardening = require("../utils/http/serverHardening");
const { _reset: resetRateLimits } = require("../utils/rateLimit");

let passed = 0;
const failures = [];
async function test(name, fn) {
  resetRateLimits();
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.stack}`);
  }
}

function buildApp() {
  const app = express();
  hardening.applyBodyParsers(app);
  app.post("/api/requests/public", hardening.publicLeadLimiter("test_lead_ip", { limit: 3 }), (req, res) => res.json({ ok: true }));
  app.post("/api/sign/:token/complete", (req, res) => res.json({ bytes: String(req.body?.signatureImage || "").length }));
  app.post("/api/echo", (req, res) => res.json({ keys: Object.keys(req.body || {}) }));
  app.get("/boom", () => {
    throw new Error("E11000 duplicate key error collection: prod.users index: email_1");
  });
  app.get("/teapot", (_req, _res, next) => {
    const err = new Error("That booking is already closed.");
    err.status = 409;
    next(err);
  });
  app.use(hardening.errorHandler);
  return app;
}

let base;
async function post(p, body, headers = {}) {
  const response = await fetch(`${base}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  let json = {};
  try {
    json = await response.json();
  } catch {
    json = {};
  }
  return { status: response.status, body: json };
}

async function run() {
  await test("a public lead route answers 429 RATE_LIMITED after its per-IP ceiling", async () => {
    for (let i = 0; i < 3; i += 1) assert.equal((await post("/api/requests/public", { name: "x" })).status, 200);
    const limited = await post("/api/requests/public", { name: "x" });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, "RATE_LIMITED");
    assert.ok(limited.body.message);
  });

  await test("the per-IP key is the client address, not a spoofable left-hand X-Forwarded-For", async () => {
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await post("/api/requests/public", {}, { "X-Forwarded-For": `203.0.113.${i + 1}, 198.51.100.7` })).status, 200);
    }
    assert.equal((await post("/api/requests/public", {}, { "X-Forwarded-For": "203.0.113.99, 198.51.100.7" })).status, 429);
  });

  await test("a JSON body over 2 MB on an ordinary route is refused with 413", async () => {
    const big = JSON.stringify({ blob: "a".repeat(2.2 * 1024 * 1024) });
    const res = await post("/api/echo", big);
    assert.equal(res.status, 413);
    assert.deepEqual(res.body, { message: "Request body too large", code: "PAYLOAD_TOO_LARGE" });
  });

  await test("a urlencoded body over 2 MB is refused with 413", async () => {
    const response = await fetch(`${base}/api/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `blob=${"a".repeat(2.2 * 1024 * 1024)}`,
    });
    assert.equal(response.status, 413);
  });

  await test("a signature-sized body (2.7 MB base64) is still accepted on the signing path", async () => {
    const image = `data:image/png;base64,${"A".repeat(Math.ceil((2 * 1024 * 1024 * 4) / 3))}`;
    const res = await post("/api/sign/tok123/complete", { signatureImage: image });
    assert.equal(res.status, 200);
    assert.equal(res.body.bytes, image.length);
  });

  await test("an ordinary small body parses as before", async () => {
    const res = await post("/api/echo", { a: 1, b: 2 });
    assert.deepEqual(res.body, { keys: ["a", "b"] });
  });

  await test("a 500 never echoes the internal message", async () => {
    const response = await fetch(`${base}/boom`);
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.deepEqual(body, { message: "Internal Server Error", code: "SERVER_ERROR" });
    assert.ok(!JSON.stringify(body).includes("E11000"));
  });

  await test("a deliberate 4xx keeps its message for the user", async () => {
    const response = await fetch(`${base}/teapot`);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).message, "That booking is already closed.");
  });

  await test("malformed JSON is a 400 without the parser's internals", async () => {
    const res = await post("/api/echo", "{not json");
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: "Invalid JSON request body", code: "INVALID_JSON" });
  });

  await test("CORS: production HTTPS, localhost dev and EXTRA_CORS_ORIGINS only; no dead HTTP origins", async () => {
    const origins = hardening.corsOrigins({ EXTRA_CORS_ORIGINS: "http://localhost:3101, " });
    assert.deepEqual(origins.sort(), ["http://localhost:3000", "http://localhost:3101", "https://profixter.com", "https://www.profixter.com"].sort());
    assert.ok(!origins.some((o) => /s3-website|elasticbeanstalk|http:\/\/(www\.)?profixter\.com/.test(o)));
    assert.ok(!origins.includes("*"));
  });

  await test("server.js wiring: no /api/test mount, no 500mb parser, shared handlers used", async () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    assert.ok(!/app\.use\(\s*["']\/api\/test["']/.test(source), "/api/test is not mounted");
    assert.ok(!fs.existsSync(path.join(__dirname, "..", "routes", "test.js")), "routes/test.js is gone");
    assert.ok(!/500mb/i.test(source), "no 500 MB body limit");
    assert.ok(/serverHardening\.applyBodyParsers\(app\)/.test(source));
    assert.ok(/serverHardening\.corsOrigins\(/.test(source));
    assert.ok(!/error:\s*err\.message/.test(source), "no handler echoes err.message");
    assert.ok(!/handyman-frontend-v1\.s3-website/.test(source));
  });

  await test("public lead routes are wired to a per-IP limiter", async () => {
    const read = (f) => fs.readFileSync(path.join(__dirname, "..", "routes", f), "utf8");
    assert.match(read("estimates.js"), /router\.post\("\/", publicLeadLimiter\(/);
    const requests = read("requests.js");
    for (const p of ["/", "/public", "/membership"]) {
      assert.ok(requests.includes(`router.post("${p}", publicLeadLimiter(`), `requests ${p}`);
    }
    assert.match(requests, /router\.post\("\/callback", callbackIpLimit/);
    assert.match(read("freeVisitRequests.js"), /router\.post\("\/", ipLimit/);
    assert.match(read("feedback.js"), /router\.post\("\/", feedbackLimiter/);
  });
}

(async () => {
  const server = buildApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const originalError = console.error;
  console.error = () => {};
  try {
    await run();
  } finally {
    console.error = originalError;
    server.close();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
