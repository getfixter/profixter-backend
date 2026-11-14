#!/usr/bin/env node
/**
 * Local Admin PREVIEW stack: the real Express app (server.js, every route it
 * mounts) on http://localhost:5055, against a local MongoDB replica set kept in
 * ../preview-data, with invented seed data and every external effect made
 * impossible.
 *
 *   node scripts/preview/start.js            start (seeds on first run)
 *   node scripts/preview/start.js --reset    wipe preview-data and reseed
 *
 * Options: --port 5055  --mongo-port 27555  --data <dir>
 *          --frontend http://localhost:3105 (for email links and CORS)
 *
 * See scripts/preview/README.md for accounts, what is faked and the guards.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

const BACKEND = path.resolve(__dirname, "..", "..");
const fromBackend = (request) => require.resolve(request, { paths: [BACKEND] });

function parseArgs(argv) {
  const out = { reset: false, port: 5055, mongoPort: 27555, data: path.resolve(BACKEND, "..", "preview-data"), frontend: "http://localhost:3105" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--reset") out.reset = true;
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--mongo-port") out.mongoPort = Number(argv[++i]);
    else if (a === "--data") out.data = path.resolve(argv[++i]);
    else if (a === "--frontend") out.frontend = String(argv[++i]).replace(/\/+$/, "");
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown option ${a}`);
  }
  return out;
}

const log = (line) => console.log(line);

/** Fixed, obviously fake configuration. Applied only after the guard passed. */
function previewEnv({ port, frontend }) {
  const api = `http://localhost:${port}`;
  return {
    NODE_ENV: "development",
    PORT: String(port),
    JWT_SECRET: "preview-only-jwt-secret-not-for-production",
    JWT_RESET_SECRET: "preview-only-reset-secret-not-for-production",
    EMAIL_UNSUBSCRIBE_SECRET: "preview-only-unsubscribe-secret",
    GIFT_CLAIM_SECRET: "preview-only-gift-secret",
    TIP_TOKEN_SECRET: "preview-only-tip-secret",
    ADMIN_PREVIEW_SECRET: "preview-only-admin-preview-secret",
    STRIPE_SECRET_KEY: "sk_test_preview_fake_not_a_real_key",
    STRIPE_WEBHOOK_SECRET: "whsec_preview_fake_not_a_real_secret",
    STRIPE_RECONCILIATION_ENABLED: "false",
    S3_BUCKET: "preview-local-bucket",
    S3_REGION: "us-east-1",
    AWS_REGION: "us-east-1",
    AWS_EC2_METADATA_DISABLED: "true",
    PARAMETER_STORE_DISABLED: "true",
    MAIL_ADMIN: "owner@preview.test",
    MAIL_FROM: "Profixter Preview <no-reply@preview.test>",
    MAIL_REPLY_TO: "hello@preview.test",
    MARKETING_FROM: "Profixter Preview <news@preview.test>",
    CLIENT_URL: frontend,
    SITE_URL: frontend,
    PUBLIC_SITE_BASE_URL: frontend,
    PLANS_URL: `${frontend}/membership/plans`,
    SCHEDULE_URL: `${frontend}/book`,
    REVIEW_URL: `${frontend}/review?via=email`,
    TIP_LINK: `${frontend}/tip`,
    PUBLIC_API_BASE_URL: api,
    PUBLIC_API_URL: api,
    SMS_STATUS_CALLBACK_URL: "",
    EXTRA_CORS_ORIGINS: [frontend, frontend.replace("localhost", "127.0.0.1"), "http://localhost:3000"].join(","),
    ENABLE_RESERVATION_ENGINE: "true",
    // SMS "sends" go to the preview outbox through the faked provider.
    SMS_ENABLED: "true",
    SMS_OTP_ENABLED: "false",
    TWILIO_ACCOUNT_SID: "ACpreview0000000000000000000000000",
    TWILIO_API_KEY: "SKpreview0000000000000000000000000",
    TWILIO_API_SECRET: "preview-not-a-secret",
    TWILIO_PHONE_NUMBER: "+15550100000",
    BOOKING_REMINDERS_ENABLED: "false",
    BOOKING_REVIEW_REQUESTS_ENABLED: "false",
    ENABLE_MARKETING_EMAILS: "false",
    AGENTS_ENABLED: "false",
    GROWTH_ACTIONS_ENABLED: "false",
    OUTREACH_SYNC_ENABLED: "false",
    META_ADS_SYNC_ENABLED: "false",
    META_CAMPAIGN_AUDIT_ENABLED: "false",
    ESIGN_ADOBE_STARTUP: "false",
    ESIGN_WEBHOOK_AUTO_PROVISION: "false",
    ESIGN_ALLOW_UNSIGNED_COMPANY: "true",
    LOYALTY_ENABLED: "true",
    LOYALTY_EFFECTIVE_AT: "2026-01-01T00:00:00.000Z",
    GIFTS_ENABLED: "true",
  };
}

function previewPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#111827;background:#fff}code,pre{background:#f3f4f6;padding:2px 4px;border-radius:4px}pre{padding:12px;white-space:pre-wrap}.tag{display:inline-block;background:#fee2e2;color:#991b1b;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e5e7eb;padding:6px;text-align:left;vertical-align:top;font-size:13px}</style></head>
<body><p class="tag">LOCAL PREVIEW - nothing here is real</p>${body}</body></html>`;
}

const escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function previewRouter({ express, s3, outbox, safety, StripeFactory, state }) {
  const router = express.Router();
  const sendStored = (key, res) => {
    const clean = String(key || "").replace(/^\/+/, "");
    const file = path.resolve(s3.root, clean);
    if (!file.startsWith(path.resolve(s3.root) + path.sep) || !fs.existsSync(file)) return res.status(404).json({ message: "Not in the preview store", code: "NOT_FOUND" });
    res.setHeader("Cache-Control", "no-cache");
    return res.sendFile(file, { dotfiles: "deny" });
  };
  router.get("/preview-s3/*", (req, res) => sendStored(decodeURIComponent(req.params[0] || ""), res));
  // server.js redirects these to the S3 bucket; in the preview they come from disk.
  router.get(["/uploads/*", "/api/uploads/*"], (req, res) => {
    const prefix = (process.env.S3_PREFIX || "uploads").replace(/^\/+|\/+$/g, "");
    const rest = decodeURIComponent(req.params[0] || "").replace(/^\/+/, "");
    return sendStored(rest.startsWith(`${prefix}/`) ? rest : `${prefix}/${rest}`, res);
  });

  router.get("/__preview/status", async (req, res) => {
    res.json({
      preview: true,
      startedAt: state.startedAt,
      seed: state.seed,
      mongo: state.mongoUri,
      disabledJobs: state.disabled(),
      blockedOutbound: safety.blockedAttempts(),
      outbox: (await outbox.list({ limit: 500 })).length,
    });
  });
  router.get("/__preview/outbox", async (req, res) => {
    const items = await outbox.list({ limit: Math.min(500, Number(req.query.limit) || 100) });
    if (req.query.format === "json" || !String(req.headers.accept || "").includes("text/html")) {
      return res.json({ items: items.map(({ html, ...rest }) => ({ ...rest, text: String(rest.text || "").slice(0, 600) })) });
    }
    const rows = items
      .map((m) => `<tr><td>${escapeHtml(new Date(m.at).toLocaleString("en-US", { timeZone: "America/New_York" }))}</td><td>${escapeHtml(m.channel)}</td><td>${escapeHtml(m.to)}</td><td>${m.channel === "email" ? `<a href="/__preview/outbox/${encodeURIComponent(m._id)}">${escapeHtml(m.subject)}</a>` : escapeHtml(m.body)}</td></tr>`)
      .join("");
    return res.type("html").send(previewPage("Preview outbox", `<h1>Outbox</h1><p>Every email and text the app "sent" since the data was seeded. Nothing left this machine.</p><table><tr><th>When (NY)</th><th>Channel</th><th>To</th><th>Subject / text</th></tr>${rows || "<tr><td colspan=4>Empty</td></tr>"}</table>`));
  });
  router.get("/__preview/outbox/:id", async (req, res) => {
    const m = await outbox.get(req.params.id);
    if (!m) return res.status(404).send("Not found");
    if (m.channel === "email" && m.html) return res.type("html").send(`<div style="font:13px system-ui;background:#fee2e2;color:#991b1b;padding:8px 12px">LOCAL PREVIEW OUTBOX - to ${escapeHtml(m.to)} - not sent</div>${m.html}`);
    return res.type("html").send(previewPage("Outbox item", `<pre>${escapeHtml(JSON.stringify(m, null, 2))}</pre>`));
  });
  const fakeStripePage = (kind) => (req, res) => {
    const session = StripeFactory._preview.state.sessions.get(req.params.id);
    res.type("html").send(
      previewPage(
        `Preview ${kind}`,
        `<h1>Stripe ${kind} (fake)</h1><p>This is where Stripe would open. In the local preview no card can be entered and nothing is charged.</p>${session ? `<pre>${escapeHtml(JSON.stringify({ id: session.id, mode: session.mode, amount: session.amount_total, metadata: session.metadata }, null, 2))}</pre>${session.cancel_url ? `<p><a href="${escapeHtml(session.cancel_url)}">Back</a></p>` : ""}` : ""}`
      )
    );
  };
  router.get("/__preview/checkout/:id", fakeStripePage("Checkout"));
  router.get("/__preview/portal/:id", fakeStripePage("billing portal"));
  router.get("/__preview/invoice/:id", fakeStripePage("hosted invoice"));
  return router;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]);
    return;
  }

  /* 1. Refuse a live-looking environment, then make the network unreachable. */
  const safety = require("./safety");
  let envCheck;
  try {
    envCheck = safety.assertSafeEnv(process.env);
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exit(2);
  }
  for (const name of envCheck.scrub) delete process.env[name];
  if (envCheck.scrub.length) log(`[preview] removed AWS credential variables from this process: ${envCheck.scrub.join(", ")}`);
  safety.installNetworkGuard({ log });

  /* 2. Fixed fake configuration. */
  Object.assign(process.env, previewEnv(args));

  const dbPath = path.join(args.data, "db");
  const s3Root = path.join(args.data, "s3");
  if (args.reset) {
    for (const dir of [dbPath, s3Root]) fs.rmSync(dir, { recursive: true, force: true });
    log(`[preview] --reset: cleared ${args.data}`);
  }
  fs.mkdirSync(s3Root, { recursive: true });

  /* 3. Fakes, before anything from the app is loaded. */
  const { installFakes } = require("./fakes");
  const fakes = installFakes({ s3Root, publicBase: `http://localhost:${args.port}`, log, loadStripeData: () => require("./seed").loadStripeData() });

  /* 4. Local MongoDB (replica set, on disk). */
  const { startPersistentReplSet } = require("./mongo");
  const mongo = await startPersistentReplSet({ dbPath, port: args.mongoPort, log });
  process.env.MONGO_URI = mongo.uri;
  safety.assertSafeEnv({ MONGO_URI: mongo.uri });

  /* 5. Seed once (or after --reset). */
  const mongoose = require(fromBackend("mongoose"));
  await mongoose.connect(mongo.uri);
  let meta = await mongoose.connection.collection("preview_meta").findOne({ _id: "seed" });
  if (!meta) {
    log("[preview] seeding invented data...");
    const { seedPreview } = require("./seed");
    const t0 = Date.now();
    await seedPreview({ s3: fakes.s3, log });
    meta = await mongoose.connection.collection("preview_meta").findOne({ _id: "seed" });
    log(`[preview] seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${JSON.stringify(meta.counts)}`);
  } else {
    log(`[preview] using existing data seeded ${new Date(meta.seededAt).toISOString()} (dates do not move; use --reset for a fresh two-week window)`);
  }
  // Sales desk demo data (telemarketers, leads, verified sales), once.
  await require("./seedSales").seedSales({ log });
  await mongoose.disconnect();

  /* 6. The real app, wrapped so preview-only routes come first. */
  const express = require(fromBackend("express"));
  const state = { startedAt: new Date(), seed: { seededAt: meta.seededAt, counts: meta.counts, projects: meta.projects, signUrlPath: meta.signUrlPath }, mongoUri: mongo.uri, disabled: () => fakes.disabled.slice() };
  const servers = [];
  const originalListen = express.application.listen;
  express.application.listen = function previewListen(...listenArgs) {
    express.application.listen = originalListen;
    const inner = this;
    const outer = express();
    outer.disable("x-powered-by");
    outer.use(previewRouter({ express, s3: fakes.s3, outbox: fakes.outbox, safety, StripeFactory: fakes.StripeFactory, state }));
    outer.use(inner);
    const callback = listenArgs.find((a) => typeof a === "function");
    const primary = http.createServer(outer);
    primary.on("error", (error) => {
      console.error(`\n[preview] cannot listen on 127.0.0.1:${args.port}: ${error.code || error.message}. Is another preview running?\n`);
      shutdown(1);
    });
    primary.listen(args.port, "127.0.0.1", () => {
      callback && callback();
      banner();
    });
    servers.push(primary);
    // Also answer on ::1, because "localhost" may resolve to IPv6 first.
    const v6 = http.createServer(outer);
    v6.on("error", () => {});
    v6.listen(args.port, "::1");
    servers.push(v6);
    return primary;
  };

  require(path.join(BACKEND, "server.js"));

  function banner() {
    const { ACCOUNTS } = require("./seed");
    const lines = [
      "",
      "================ Profixter Admin PREVIEW (local only) ================",
      `API          http://localhost:${args.port}   (bound to loopback only)`,
      `Frontend     ${args.frontend}  (start it with preview.cmd / preview.ps1)`,
      `Outbox       http://localhost:${args.port}/__preview/outbox`,
      `Status       http://localhost:${args.port}/__preview/status`,
      `Data         ${args.data}   (MongoDB ${mongo.uri.replace(/\?.*$/, "")})`,
      "",
      "Accounts (invented):",
      ...Object.entries(ACCOUNTS).map(([role, a]) => `  ${role.padEnd(9)} ${a.email.padEnd(26)} ${a.password}`),
      ...(meta.signUrlPath ? ["", `Signing link for the awaiting agreement: ${args.frontend}${meta.signUrlPath}`] : []),
      "",
      "Faked: Stripe, email (SES), SMS (Twilio), S3, Anthropic, AWS SDK. Outbound network: BLOCKED.",
      `Not started: ${fakes.disabled.length} scheduler(s) (see /__preview/status). Ctrl+C to stop.`,
      "=======================================================================",
      "",
    ];
    console.log(lines.join("\n"));
  }

  let stopping = false;
  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    log("[preview] stopping...");
    for (const s of servers) await new Promise((resolve) => s.close(() => resolve())).catch(() => {});
    await mongoose.disconnect().catch(() => {});
    await mongo.stop();
    process.exit(code);
  }
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGBREAK", () => shutdown(0));
}

main().catch((error) => {
  console.error("[preview] failed to start:", error && error.stack ? error.stack : error);
  process.exit(1);
});
