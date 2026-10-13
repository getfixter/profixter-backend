/**
 * Shower Studio isolated demo / QA stack. NOTHING here touches production:
 *
 *   in-memory MongoDB  -> seeded TEST staff, a test customer, the researched
 *                         starter catalog (published, with TEST prices)
 *   real backend       -> server.js with no .env, private Studio storage in a
 *                         temporary folder, email to a local SMTP catcher that
 *                         records messages and never relays them
 *   frontend           -> next dev against that backend
 *
 *   node scripts/studio_demo_env.js          # start and keep running (prints logins)
 *   node scripts/studio_demo_env.js --demo   # the owner's homeowner demo: curated DEMO catalog,
 *                                            # optimized build, open to phones/tablets on this Wi-Fi
 *   require("./studio_demo_env").start()     # used by the end-to-end test
 *
 * Refuses to start if a port is busy (a stale server would make results lie).
 */
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const net = require("net");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const BACKEND_PORT = Number(process.env.STUDIO_QA_BACKEND_PORT || 5098);
const FRONTEND_PORT = Number(process.env.STUDIO_QA_FRONTEND_PORT || 3098);
const SMTP_PORT = Number(process.env.STUDIO_QA_SMTP_PORT || 2598);
const S3_PORT = Number(process.env.STUDIO_QA_S3_PORT || 9098);
let BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
let FRONTEND_URL = `http://127.0.0.1:${FRONTEND_PORT}`;

/** This computer's address on the local Wi-Fi/Ethernet (for phones and tablets on the same network). */
function lanAddress() {
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === "IPv4" && !a.internal && !/vEthernet|WSL|VirtualBox|VMware|Hyper-V/i.test(name)) list.push({ name, address: a.address });
  }
  const priv = list.find((x) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(x.address));
  return (priv || list[0])?.address || null;
}
const FRONTEND_DIR = path.join(__dirname, "..", "..", "FrontEnd");
const SECRET = "studio-qa-only-secret-not-for-production";
const OWNER_EMAIL = "owner@studio-qa.test";
/** Demo-only password for the seeded TEST accounts (in-memory database, gone when the demo stops). */
const DEMO_PASSWORD = "studio-demo";

const children = [];
const mail = [];
let mongo = null;
let smtp = null;
let s3 = null;
const s3Objects = new Map();
const s3Log = [];

/**
 * A storing S3 stub (path-style): every AWS SDK call from the demo backend
 * lands here, never on AWS. Objects live in memory.
 */
function startS3Stub() {
  s3 = require("http").createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const key = decodeURIComponent(req.url.split("?")[0]);
      s3Log.push(`${req.method} ${key}`);
      if (req.method === "PUT") { s3Objects.set(key, Buffer.concat(chunks)); res.writeHead(200, { ETag: '"qa"' }); return res.end(); }
      if (req.method === "GET" || req.method === "HEAD") {
        if (!s3Objects.has(key)) { res.writeHead(404, { "Content-Type": "application/xml" }); return res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>not found</Message></Error>'); }
        const body = s3Objects.get(key);
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
        return res.end(req.method === "HEAD" ? undefined : body);
      }
      if (req.method === "DELETE") { s3Objects.delete(key); res.writeHead(204); return res.end(); }
      if (req.method === "POST" && /[?&]delete/.test(req.url)) {
        for (const m of Buffer.concat(chunks).toString().matchAll(/<Key>([^<]+)<\/Key>/g)) s3Objects.delete(key.replace(/\/$/, "") + "/" + m[1]);
        res.writeHead(200, { "Content-Type": "application/xml" }); return res.end('<?xml version="1.0"?><DeleteResult></DeleteResult>');
      }
      res.writeHead(200, { "Content-Type": "application/xml" }); res.end("");
    });
  });
  return new Promise((resolve) => s3.listen(S3_PORT, "127.0.0.1", resolve));
}

function log(step, detail = "") { console.log(`  ${step}${detail ? " - " + detail : ""}`); }

async function assertPortFree(port, label) {
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", () => reject(new Error(`Port ${port} (${label}) is busy. Stop that process first.`)));
    s.once("listening", () => s.close(resolve));
    s.listen(port, "127.0.0.1");
  });
}

async function waitForHttp(url, label, ms = 240000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (r.status < 500) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} did not come up at ${url}`);
}

/** A minimal SMTP server: accepts every message, records it, relays nothing. */
function startSmtpCatcher() {
  smtp = net.createServer((sock) => {
    let data = false, buf = "", current = { from: "", to: [], body: "" };
    const say = (l) => sock.write(l + "\r\n");
    say("220 studio-qa smtp catcher");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) {
          if (line === ".") {
            data = false;
            const subject = /^Subject: (.*)$/im.exec(current.body)?.[1] || "";
            mail.push({ ...current, subject, at: new Date().toISOString() });
            if (require.main === module) console.log(`  [caught on this computer, not sent] ${subject}`);
            current = { from: "", to: [], body: "" };
            say("250 queued (not delivered - QA catcher)");
          } else current.body += line + "\n";
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") { sock.write("250-studio-qa\r\n250 AUTH PLAIN LOGIN\r\n"); }
        else if (cmd === "AUTH") say("235 ok");
        else if (cmd === "MAIL") { current.from = line; say("250 ok"); }
        else if (cmd === "RCPT") { current.to.push(line); say("250 ok"); }
        else if (cmd === "DATA") { data = true; say("354 go"); }
        else if (cmd === "QUIT") { say("221 bye"); sock.end(); }
        else say("250 ok");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) => smtp.listen(SMTP_PORT, "127.0.0.1", resolve));
}

function spawnChild(label, cmd, args, opts) {
  const child = spawn(cmd, args, { shell: true, ...opts, stdio: ["ignore", "pipe", "pipe"] });
  const logFile = path.join(os.tmpdir(), `studio-qa-${label}.log`);
  const out = fs.createWriteStream(logFile);
  child.stdout.pipe(out); child.stderr.pipe(out);
  children.push(child);
  return child;
}

async function seed({ catalog = "starter" } = {}) {
  const User = require("../models/User");
  const StudioProduct = require("../models/studio/StudioProduct");
  const StudioPricing = require("../models/studio/StudioPricing");
  const hash = require("bcryptjs").hashSync(DEMO_PASSWORD, 8);
  const mk = (name, email, role, extra = {}) => User.create({ userId: `qa-${email}`, name, email, role, password: hash, ...extra });
  const users = {
    owner: await mk("QA Owner", OWNER_EMAIL, "admin"),
    seller: await mk("Sam Seller", "sam@studio-qa.test", "employee", { adminSections: ["studio", "projects", "leads"] }),
    pricer: await mk("Pat Pricer", "pat@studio-qa.test", "employee", { adminSections: ["studio", "studio-pricing", "projects"] }),
    cataloger: await mk("Cat Alog", "cat@studio-qa.test", "employee", { adminSections: ["studio-catalog"] }),
    outsider: await mk("Otto Outsider", "otto@studio-qa.test", "employee", { adminSections: ["leads"] }),
    customer: await mk("Carla Customer", "carla@studio-qa.test", "customer", { phone: "6315550199" }),
  };
  const tokens = Object.fromEntries(Object.entries(users).map(([k, u]) => [k, { id: String(u._id), email: u.email, token: jwt.sign({ id: String(u._id) }, SECRET, { expiresIn: "12h" }) }]));
  if (catalog === "demo") {
    const info = await require("./studio_demo_catalog").seedDemoCatalog({ ownerId: users.owner._id });
    log("demo catalog", info.swanFile ? `${info.swanProducts} Swan + ${info.starterProducts} starter products, DEMO prices (Swan file ${info.swanFile})` : `starter products only (no Swan file in catalog-imports/), DEMO prices`);
    return tokens;
  }
  const starter = require("../data/studio/starter-catalog.json");
  // TEST prices only (the owner sets real ones). Round numbers make totals easy to check.
  const PRICES = {
    wall: 120000, base: 90000, fixture: 35000, enclosure: 95000, accessory: 12000,
  };
  await StudioProduct.insertMany(starter.products.map((p) => ({ ...p, status: "published", pricing: { priceCents: PRICES[p.category], installCents: 0, internalNote: "QA test price" } })));
  const pricing = await StudioPricing.current();
  for (const t of pricing.projectTypes) t.basePriceCents = { "tub-to-shower": 450000, "shower-replacement": 400000, "tub-replacement": 380000 }[t.key];
  for (const a of pricing.adders) a.priceCents = { "paint-above": 60000, "door-install": 25000, "grab-bar-blocking": 15000, "seat-backing": 20000, "valve-relocation": 50000 }[a.key];
  await pricing.save();
  return tokens;
}

async function start({ frontend = true, demo = false } = {}) {
  // --demo: reachable from phones/tablets on this network, optimized (production) build, DEMO labels
  const lan = demo ? lanAddress() : null;
  if (lan) { BACKEND_URL = `http://${lan}:${BACKEND_PORT}`; FRONTEND_URL = `http://${lan}:${FRONTEND_PORT}`; }
  await assertPortFree(BACKEND_PORT, "backend");
  if (frontend) await assertPortFree(FRONTEND_PORT, "frontend");
  await assertPortFree(SMTP_PORT, "smtp");
  await assertPortFree(S3_PORT, "s3 stub");
  mongo = await MongoMemoryServer.create();
  const mongoUri = mongo.getUri();
  await mongoose.connect(mongoUri);
  log("mongo (in memory)", "isolated");
  const users = await seed({ catalog: demo ? "demo" : "starter" });
  log("seeded", demo ? "test staff, test customer, curated DEMO catalog" : "test staff, test customer, starter catalog with TEST prices");
  await startSmtpCatcher();
  await startS3Stub();
  log("s3 stub", `127.0.0.1:${S3_PORT} (no request can reach AWS)`);
  const noCreds = path.join(os.tmpdir(), "studio-qa-no-aws-credentials");
  log("smtp catcher", `127.0.0.1:${SMTP_PORT} (records, never relays)`);
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-qa-private-"));
  spawnChild("backend", "node", ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      NODE_ENV: "test", PORT: String(BACKEND_PORT), MONGO_URI: mongoUri, JWT_SECRET: SECRET, JWT_RESET_SECRET: SECRET + "-reset",
      MAIL_ADMIN: OWNER_EMAIL, LEADS_EMAIL: "leads@studio-qa.test", S3_BUCKET: "studio-qa-bucket", STUDIO_STORAGE: "local", STUDIO_LOCAL_DIR: storageDir,
      // every AWS SDK client goes to the local stub; this machine's own AWS credentials are never read
      AWS_ENDPOINT_URL: `http://127.0.0.1:${S3_PORT}`, AWS_ACCESS_KEY_ID: "qa", AWS_SECRET_ACCESS_KEY: "qa", AWS_REGION: "us-east-1", S3_REGION: "us-east-1",
      AWS_SHARED_CREDENTIALS_FILE: noCreds, AWS_CONFIG_FILE: noCreds, AWS_EC2_METADATA_DISABLED: "true", AWS_PROFILE: "",
      HOME: os.tmpdir(), USERPROFILE: os.tmpdir(),
      AWS_SES_SMTP_HOST: "127.0.0.1", AWS_SES_SMTP_PORT: String(SMTP_PORT), AWS_SES_SMTP_USER: "qa", AWS_SES_SMTP_PASS: "qa",
      BOOKING_REMINDERS_ENABLED: "false", BOOKING_REVIEW_REQUESTS_ENABLED: "false", ESIGN_ADOBE_STARTUP: "false", ESIGN_ALLOW_UNSIGNED_COMPANY: "true",
      SMS_ENABLED: "false", STUDIO_PUBLIC_ENABLED: "true", PUBLIC_API_BASE_URL: BACKEND_URL, PUBLIC_SITE_BASE_URL: FRONTEND_URL,
      EXTRA_CORS_ORIGINS: `${FRONTEND_URL},http://localhost:${FRONTEND_PORT},http://127.0.0.1:${FRONTEND_PORT}`,
    },
  });
  await waitForHttp(`http://127.0.0.1:${BACKEND_PORT}/api/studio/catalog`, "backend");
  log("backend", BACKEND_URL);
  if (frontend && demo) {
    // An optimized build is much faster on a phone than the development server.
    // It goes to its own folder (.next-studio-demo) so it never mixes with other builds.
    const env = { ...process.env, NEXT_PUBLIC_API_URL: BACKEND_URL, NEXT_PUBLIC_STUDIO_DEMO: "1", NEXT_DIST_DIR: ".next-studio-demo", NEXT_TELEMETRY_DISABLED: "1" };
    log("frontend", "building the optimized demo site (about 2-3 minutes)...");
    // next build rewrites tsconfig.json for the extra build folder: put it back afterwards (keep the code tree clean)
    const tsconfig = path.join(FRONTEND_DIR, "tsconfig.json");
    const tsconfigBefore = fs.readFileSync(tsconfig);
    const build = spawnChild("frontend-build", "npx", ["next", "build"], { cwd: FRONTEND_DIR, env });
    const code = await new Promise((resolve) => build.on("exit", resolve));
    fs.writeFileSync(tsconfig, tsconfigBefore);
    if (code !== 0) throw new Error(`The demo site did not build (see ${path.join(os.tmpdir(), "studio-qa-frontend-build.log")}).`);
    spawnChild("frontend", "npx", ["next", "start", "-p", String(FRONTEND_PORT), "-H", lan ? "0.0.0.0" : "127.0.0.1"], { cwd: FRONTEND_DIR, env: { ...env, PORT: String(FRONTEND_PORT) } });
    await waitForHttp(`http://127.0.0.1:${FRONTEND_PORT}/shower-studio`, "frontend", 300000);
    log("frontend", FRONTEND_URL);
  } else if (frontend) {
    spawnChild("frontend", "npx", ["next", "dev", "-p", String(FRONTEND_PORT), "-H", "127.0.0.1"], {
      cwd: FRONTEND_DIR,
      env: { ...process.env, NEXT_PUBLIC_API_URL: BACKEND_URL, PORT: String(FRONTEND_PORT), NEXT_TELEMETRY_DISABLED: "1" },
    });
    await waitForHttp(`${FRONTEND_URL}/shower-studio`, "frontend", 300000);
    log("frontend", FRONTEND_URL);
  }
  return { BACKEND_URL, FRONTEND_URL, users, mail, storageDir, secret: SECRET, s3Log, lan };
}

async function stop() {
  for (const c of children) {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { shell: true, stdio: "ignore" });
      else c.kill("SIGTERM");
    } catch { /* gone */ }
  }
  smtp?.close();
  s3?.close();
  await mongoose.disconnect().catch(() => {});
  await mongo?.stop().catch(() => {});
}

module.exports = { start, stop, OWNER_EMAIL };

if (require.main === module) {
  const demoMode = process.argv.includes("--demo");
  start({ demo: demoMode }).then((env) => {
    console.log("\nShower Studio demo is running (Ctrl+C to stop):");
    if (demoMode) {
      console.log(env.lan ? `  On your phone or tablet (same Wi-Fi):  ${env.FRONTEND_URL}/shower-studio` : "  (No Wi-Fi address found: phones cannot reach this computer.)");
      console.log("  If a phone cannot open it: allow Node.js on Private networks when Windows asks (Windows Security > Firewall).");
      console.log("  Prices are DEMO prices; requests you send are caught here and never reach anyone.");
    }
    if (process.argv.includes("--open")) spawn("cmd", ["/c", "start", "", `${env.FRONTEND_URL}/shower-studio`], { stdio: "ignore", detached: true });
    console.log(`  Public Studio:  ${env.FRONTEND_URL}/shower-studio`);
    console.log(`  Admin sign-in:  ${env.FRONTEND_URL}/signin   (password for every test account: ${DEMO_PASSWORD})`);
    const who = { owner: "you (owner): everything", seller: "salesperson: Shower Studio + Projects + Leads", pricer: "salesperson who may also give discounts", cataloger: "catalog & prices only", outsider: "Leads only (no Studio)", customer: "a customer account" };
    for (const [k, u] of Object.entries(env.users)) console.log(`    ${u.email.padEnd(26)} ${who[k] || ""}`);
    console.log("  Staff notification emails are caught on this computer, never sent.");
    console.log("  Everything here is test data in memory: closing this window erases it.");
  }).catch(async (e) => { console.error(e.message); await stop(); process.exit(1); });
  process.on("SIGINT", async () => { await stop(); process.exit(0); });
}
