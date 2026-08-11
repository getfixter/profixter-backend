/**
 * Authenticated Admin QA environment.
 *
 * Stands up a fully isolated stack and proves it works end to end:
 *
 *   in-memory MongoDB -> deterministic fixtures -> real backend -> frontend
 *   built against that backend -> Playwright with a minted Admin JWT
 *
 * This pass is a SMOKE TEST of the environment, not the viewport sweep. Success
 * means the authenticated Admin renders seeded fixture data and no request ever
 * reaches production.
 *
 *   node scripts/qa_admin_env.js
 *
 * Everything fails loudly. There is no path where a stale port, a failed seed,
 * a bad token or a request to the production API is quietly tolerated - a QA
 * environment that lies is worse than no QA environment.
 *
 * All child processes are killed on success, failure and interrupt.
 */

const { spawn } = require("child_process");
const path = require("path");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
// Playwright lives in the FrontEnd workspace; this script runs from BackEnd.
const { chromium } = require(path.join(__dirname, "..", "..", "FrontEnd", "node_modules", "playwright"));

const { seedAdminFixtures, ADMIN_EMAIL, LONG_NAME } = require("./qa_seed_admin_fixtures");

const BACKEND_PORT = Number(process.env.QA_BACKEND_PORT || 5099);
const FRONTEND_PORT = Number(process.env.QA_FRONTEND_PORT || 3099);
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const FRONTEND_URL = `http://127.0.0.1:${FRONTEND_PORT}`;
const FRONTEND_DIR = path.join(__dirname, "..", "..", "FrontEnd");

/** Test-only secret. Never a production value. */
const TEST_JWT_SECRET = "qa-only-jwt-secret-not-for-production-use";
const PRODUCTION_HOST = "api.profixter.com";

const children = [];
let mongo = null;
let browser = null;

function fail(message) {
  throw new Error(message);
}

function log(step, detail = "") {
  console.log(`  ${step}${detail ? " — " + detail : ""}`);
}

/** Refuse to start if something is already holding a port we need. */
async function assertPortFree(port, label) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    fail(
      `Port ${port} (${label}) is already in use and answered with HTTP ${response.status}. ` +
        "Stop that process: a stale server would make this QA run meaningless."
    );
  } catch (error) {
    if (error.message && error.message.includes("already in use")) throw error;
    // Anything else means nothing is listening, which is what we want.
  }
}

function spawnChild(label, command, args, options) {
  const child = spawn(command, args, { shell: true, ...options });
  children.push({ label, child });
  child.stdout?.on("data", (data) => {
    const text = String(data);
    if (/error|Error|EADDRINUSE/.test(text)) process.stdout.write(`    [${label}] ${text}`);
  });
  child.stderr?.on("data", (data) => process.stderr.write(`    [${label}!] ${data}`));
  return child;
}

async function waitForHttp(url, label, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail(`${label} did not become reachable at ${url} within ${timeoutMs / 1000}s.`);
  return false;
}

async function cleanup() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  for (const { label, child } of children) {
    try {
      // Windows needs the tree killed: npm spawns the real server as a grandchild.
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: true, stdio: "ignore" });
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
      log("stopped", label);
    } catch {
      /* already gone */
    }
  }
  children.length = 0;
  await mongoose.disconnect().catch(() => {});
  if (mongo) {
    await mongo.stop().catch(() => {});
    mongo = null;
  }
}

async function main() {
  console.log("\nAdmin QA environment\n");

  await assertPortFree(BACKEND_PORT, "backend");
  await assertPortFree(FRONTEND_PORT, "frontend");
  log("ports free", `${BACKEND_PORT}, ${FRONTEND_PORT}`);

  /* --- 1. in-memory mongo --- */
  mongo = await MongoMemoryServer.create();
  const mongoUri = mongo.getUri("profixter_admin_qa");
  await mongoose.connect(mongoUri);
  log("mongo booted", mongoUri.replace(/\/\/.*@/, "//"));

  /* --- 2. seed --- */
  const seed = await seedAdminFixtures();
  if (!seed.projectId || !seed.adminId) fail("Seed did not return the expected fixture ids.");
  log("seeded", `project ${seed.projectNumber}, ${Object.keys(seed.agreements).length} agreements, ${Object.keys(seed.changeOrders).length} change orders, ${Object.keys(seed.signatures).length} signatures`);

  /* --- 3. backend against that database --- */
  const backendEnv = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(BACKEND_PORT),
    MONGO_URI: mongoUri,
    JWT_SECRET: TEST_JWT_SECRET,
    JWT_RESET_SECRET: TEST_JWT_SECRET + "-reset",
    S3_BUCKET: "qa-test-bucket",
    MAIL_ADMIN: ADMIN_EMAIL,
    // Keep background work and outbound integrations out of a QA run.
    BOOKING_REMINDERS_ENABLED: "false",
    BOOKING_REVIEW_REQUESTS_ENABLED: "false",
    ESIGN_ADOBE_STARTUP: "false",
    ESIGN_ALLOW_UNSIGNED_COMPANY: "true",
    PUBLIC_API_BASE_URL: BACKEND_URL,
    PUBLIC_SITE_BASE_URL: FRONTEND_URL,
    // The QA frontend runs on a non-default port, which is not in the
    // production CORS allowlist. Without this the browser blocks /api/auth/me,
    // refreshUser fails, and the app logs itself out - which looked exactly
    // like a rejected token.
    EXTRA_CORS_ORIGINS: `${FRONTEND_URL},http://localhost:${FRONTEND_PORT}`,
  };
  spawnChild("backend", "node", ["server.js"], { cwd: path.join(__dirname, ".."), env: backendEnv });
  await waitForHttp(`${BACKEND_URL}/`, "backend");
  log("backend up", BACKEND_URL);

  /* --- 4. admin token, minted against the test secret --- */
  const token = jwt.sign({ id: seed.adminId }, TEST_JWT_SECRET, { expiresIn: "2h" });
  const authCheck = await fetch(`${BACKEND_URL}/api/admin/contracts/meta`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (authCheck.status !== 200) {
    fail(`Admin JWT was rejected by the backend (HTTP ${authCheck.status}). Auth setup is wrong.`);
  }
  log("admin authenticated", `${ADMIN_EMAIL} (HTTP 200 on an admin route)`);

  // And prove an unauthenticated call is still refused - a QA environment with
  // auth accidentally disabled would validate nothing.
  const anonCheck = await fetch(`${BACKEND_URL}/api/admin/contracts/meta`);
  if (anonCheck.status !== 401) {
    fail(`Unauthenticated admin request returned ${anonCheck.status}, expected 401. Auth is not being enforced.`);
  }
  log("auth enforced", "anonymous admin request correctly refused");

  /* --- 5. frontend built against the LOCAL backend --- */
  log("building frontend", "against " + BACKEND_URL);
  await new Promise((resolve, reject) => {
    const build = spawn("npx", ["next", "build"], {
      cwd: FRONTEND_DIR,
      shell: true,
      env: { ...process.env, NEXT_PUBLIC_API_URL: BACKEND_URL },
      stdio: "ignore",
    });
    build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("Frontend build failed"))));
  });

  spawnChild("frontend", "npx", ["next", "start", "-p", String(FRONTEND_PORT)], {
    cwd: FRONTEND_DIR,
    env: { ...process.env, NEXT_PUBLIC_API_URL: BACKEND_URL, PORT: String(FRONTEND_PORT) },
  });
  await waitForHttp(FRONTEND_URL, "frontend");
  log("frontend up", FRONTEND_URL);

  /* --- 6. authenticated smoke test --- */
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });
  page.on("response", (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 120)}`);
  });

  // Hard assertion: nothing may reach production, ever.
  const productionCalls = [];
  page.on("request", (request) => {
    if (request.url().includes(PRODUCTION_HOST)) productionCalls.push(request.url());
  });
  await page.route(`**://*${PRODUCTION_HOST}/**`, (route) => {
    productionCalls.push(route.request().url());
    return route.abort();
  });

  /*
   * The API client reads `token`, but the Admin page's auth guard also reads
   * the cached `user` object and redirects to /signin when it is absent. Both
   * are what a real signed-in admin has, so both are injected.
   */
  await page.addInitScript(
    (auth) => {
      window.localStorage.setItem("token", auth.token);
      window.localStorage.setItem("user", JSON.stringify(auth.user));
    },
    {
      token,
      user: {
        _id: seed.adminId,
        userId: "QA-ADMIN-0001",
        name: "QA Admin",
        email: ADMIN_EMAIL,
        role: "admin",
        isActive: true,
      },
    }
  );

  // Land directly on Projects: /admin defaults to another tab, so the seeded
  // project would not be on screen and "no fixtures" would be a false negative.
  await page.goto(`${FRONTEND_URL}/admin?tab=projects`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);

  const diag = await page.evaluate(() => ({
    url: window.location.href,
    pathname: window.location.pathname,
    text: document.body.innerText.slice(0, 500),
    hasPasswordInput: Boolean(document.querySelector('input[type="password"]')),
    hasLoginForm: Boolean(
      document.querySelector('form input[type="password"]') ||
        document.querySelector('[data-testid="signin-form"]')
    ),
    hasProject: document.body.innerText.includes("P-QA-0001"),
  }));

  console.log("\n  --- smoke diagnostic ---");
  console.log(`  url               ${diag.url}`);
  console.log(`  password input    ${diag.hasPasswordInput}`);
  console.log(`  login form        ${diag.hasLoginForm}`);
  console.log(`  P-QA-0001 present ${diag.hasProject}`);
  console.log(`  console errors    ${consoleErrors.length ? consoleErrors.slice(0, 3).join(" | ") : "none"}`);
  console.log(`  failed requests   ${failedRequests.length ? failedRequests.slice(0, 5).join(" | ") : "none"}`);
  console.log(`  body[0:500]       ${diag.text.replace(/\s+/g, " ").slice(0, 500)}`);
  console.log("  ------------------------\n");

  // Login state is decided by the URL and a real password field, never by the
  // word "sign in" appearing somewhere in site chrome.
  const onLoginPage = diag.pathname.includes("/signin") || diag.hasLoginForm;
  if (onLoginPage) {
    fail(`Admin was redirected to a login form at ${diag.url}. The session was genuinely rejected.`);
  }
  if (!diag.hasProject) {
    fail(`Authenticated Admin rendered without the seeded project P-QA-0001 at ${diag.url}.`);
  }
  log("admin rendered seeded data", "P-QA-0001 visible");

  if (productionCalls.length) {
    fail(`Frontend attempted ${productionCalls.length} request(s) to production: ${productionCalls[0]}`);
  }
  log("production untouched", `0 requests to ${PRODUCTION_HOST}`);

  console.log("\nADMIN QA ENVIRONMENT READY\n");
  console.log(`  backend    ${BACKEND_URL}`);
  console.log(`  frontend   ${FRONTEND_URL}`);
  console.log(`  project    ${seed.projectId} (${seed.projectNumber})`);
  console.log(`  admin      ${seed.adminId} <${ADMIN_EMAIL}>`);
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

main()
  .then(async () => {
    await cleanup();
    console.log("\n  cleanup complete — no processes left running.\n");
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(`\n  FAILED: ${error.message}\n`);
    await cleanup();
    console.error("  cleanup complete — no processes left running.\n");
    process.exit(1);
  });
