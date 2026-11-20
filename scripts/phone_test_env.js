/**
 * The private phone-test backend (2026-11-20): the welcome flow end to end on
 * real phones, with nothing real at stake. NOT production, never deployed.
 *
 *   node scripts/phone_test_env.js            (real texts + Stripe test mode)
 *   node scripts/phone_test_env.js --codes-in-mailbox   (Stripe test mode; phone codes shown on /__mail, not texted)
 *   node scripts/phone_test_env.js --dry      (no texts: phone codes appear on /__mail; no Stripe) - for checking the stack only
 *
 * What it is:
 *   - The real customer routes (auth, bookings, guest checkout, membership
 *     checkout, calendar, service area, subscriptions, track...) on
 *     127.0.0.1:5079, reached from the phones only through this computer's
 *     Tailscale network (tailscale serve), never the public internet.
 *   - A throwaway in-memory database, seeded with a schedule and two Fixters.
 *   - Emails are CAPTURED, never sent: https://<this host>:8444/__mail lists them
 *     (including email codes).
 *   - Phone codes go through a DEDICATED Twilio Verify service, and only to the
 *     numbers listed in the approved-numbers file; any other number is refused
 *     before Twilio is called. Every other text (reminders, notices) is simulated.
 *   - Stripe TEST mode only: the key is the Stripe CLI's test key (refuses a live
 *     key and checks Stripe says livemode=false); webhooks arrive through
 *     `stripe listen`, started here.
 *   - Every other outbound request (Meta, Google, AWS...) is refused.
 *
 * Inputs (files, never chat):
 *   ~/.config/stripe/config.toml            from `stripe login` (test key)
 *   C:\Users\Taras\.profixter\phone-test.env   TWILIO_ACCOUNT_SID, TWILIO_VERIFY_API_KEY,
 *                                            TWILIO_VERIFY_API_SECRET, TWILIO_VERIFY_SERVICE_SID
 *                                            (a Verify service made for testing)
 *   C:\Users\Taras\.profixter\test-phones.txt  one approved mobile number per line
 *
 * Env: PHONE_TEST_SITE (the frontend origin, e.g. https://host.ts.net:8443),
 *      PHONE_TEST_API  (this API as the phones reach it, e.g. https://host.ts.net:8444)
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const DRY = process.argv.includes("--dry");
/* --codes-in-mailbox: Stripe test mode is real, but phone codes are shown on /__mail instead of texted (before Twilio is set up). */
const NO_TEXTS = DRY || process.argv.includes("--codes-in-mailbox");
const PORT = Number(process.env.PHONE_TEST_PORT || 5079);
const SITE = String(process.env.PHONE_TEST_SITE || "").replace(/\/$/, "");
const API = String(process.env.PHONE_TEST_API || "").replace(/\/$/, "");
const SECRETS_DIR = process.env.PHONE_TEST_SECRETS || path.join(os.homedir(), ".profixter");
if (!SITE || !API) {
  console.error("Set PHONE_TEST_SITE and PHONE_TEST_API (the Tailscale https origins of the site and this API).");
  process.exit(2);
}

function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
function digits10(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

/* ------------------------------------------------ inputs */
let stripeKey = "";
let approved = new Set();
if (!DRY) {
  // Stripe: the CLI's test key only.
  const toml = fs.readFileSync(path.join(os.homedir(), ".config", "stripe", "config.toml"), "utf8");
  const keyLine = toml.match(/^\s*test_mode_api_key\s*=\s*['"]([^'"]+)['"]/m);
  const expLine = toml.match(/^\s*test_mode_key_expires_at\s*=\s*['"]([^'"]+)['"]/m);
  stripeKey = keyLine ? keyLine[1] : "";
  if (!/^(sk|rk)_test_/.test(stripeKey)) {
    console.error("No Stripe TEST key in the Stripe CLI config. Run `stripe login` on this computer first.");
    process.exit(2);
  }
  if (expLine && new Date(expLine[1]) < new Date()) {
    console.error(`The Stripe CLI test login expired on ${expLine[1]}. Run \`stripe login\` again.`);
    process.exit(2);
  }
}
if (!NO_TEXTS) {
  // Twilio: a Verify service made for testing.
  const twilioFile = path.join(SECRETS_DIR, "phone-test.env");
  if (!fs.existsSync(twilioFile)) {
    console.error(`Missing ${twilioFile} (TWILIO_ACCOUNT_SID, TWILIO_VERIFY_API_KEY, TWILIO_VERIFY_API_SECRET, TWILIO_VERIFY_SERVICE_SID).`);
    process.exit(2);
  }
  const tw = readEnvFile(twilioFile);
  for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_VERIFY_SERVICE_SID"]) {
    if (!tw[k]) {
      console.error(`${twilioFile} has no ${k}.`);
      process.exit(2);
    }
  }
  if (!(tw.TWILIO_VERIFY_API_KEY && tw.TWILIO_VERIFY_API_SECRET) && !tw.TWILIO_AUTH_TOKEN) {
    console.error(`${twilioFile} needs TWILIO_VERIFY_API_KEY + TWILIO_VERIFY_API_SECRET (or TWILIO_AUTH_TOKEN).`);
    process.exit(2);
  }
  for (const [k, v] of Object.entries(tw)) if (/^TWILIO_/.test(k)) process.env[k] = v;
  const phonesFile = path.join(SECRETS_DIR, "test-phones.txt");
  if (fs.existsSync(phonesFile)) approved = new Set(fs.readFileSync(phonesFile, "utf8").split(/\r?\n/).map(digits10).filter((d) => d.length === 10));
  if (!approved.size) {
    console.error(`No approved test numbers: put one mobile number per line in ${phonesFile}.`);
    process.exit(2);
  }
}

/* ------------------------------------------------ environment (before any app module loads) */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex"); /* sessions die with this process */
process.env.CLIENT_URL = SITE;
process.env.SMS_ENABLED = "false"; /* notices are simulated; only Verify codes are real */
process.env.SMS_OTP_ENABLED = NO_TEXTS ? "false" : "true";
process.env.S3_BUCKET = "phone-test-bucket";
process.env.ENABLE_RESERVATION_ENGINE = "true";
process.env.MAIL_ADMIN = "owner@phone-test.invalid";
process.env.STRIPE_SECRET_KEY = stripeKey || "sk_test_dry_run_no_stripe";
process.env.OTP_WEBOTP_DOMAIN = new URL(SITE).hostname;
for (const k of ["MONGO_URI", "META_PIXEL_ID", "META_ACCESS_TOKEN", "GHL_SALES_SYNC_ENABLED", "META_ADS_SYNC_ENABLED"]) delete process.env[k];

const ALLOWED_HOSTS = new Set(["api.stripe.com", "files.stripe.com", "verify.twilio.com", "127.0.0.1", "localhost"]);
const passThrough = global.fetch;
global.fetch = async (url, init) => {
  const host = new URL(String(url)).hostname;
  if (!ALLOWED_HOSTS.has(host)) throw new Error(`phone-test: blocked outbound request to ${host}`);
  return passThrough(url, init);
};

(async () => {
  /* ------------------------------------------------ Stripe test mode */
  let stripe = null;
  let listen = null;
  if (!DRY) {
    stripe = require("stripe")(stripeKey);
    const balance = await stripe.balance.retrieve();
    if (balance.livemode !== false) {
      console.error("Refusing: Stripe reports livemode for this key.");
      process.exit(2);
    }
    const ensurePrice = async ({ lookupKey, name, unitAmount, recurring }) => {
      const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
      if (found.data[0]) return found.data[0].id;
      const product = await stripe.products.create({ name: `${name} (TEST)`, metadata: { profixter_testmode: "phone_test" } });
      return (await stripe.prices.create({ product: product.id, currency: "usd", unit_amount: unitAmount, lookup_key: lookupKey, ...(recurring ? { recurring } : {}) })).id;
    };
    const { PLAN_CATALOG } = require("../utils/subscriptionManagement");
    for (const plan of Object.keys(PLAN_CATALOG)) {
      for (const cycle of ["monthly", "annual"]) {
        process.env[`STRIPE_PRICE_${plan.toUpperCase()}_${cycle.toUpperCase()}`] = await ensurePrice({
          lookupKey: `pfx_testmode_${plan}_${cycle}`,
          name: `Profixter ${plan} ${cycle}`,
          unitAmount: Math.round(PLAN_CATALOG[plan][cycle].price * 100),
          recurring: { interval: cycle === "annual" ? "year" : "month" },
        });
      }
    }
    process.env.STRIPE_PRICE_ONE_TIME_HANDYMAN_VISIT = await ensurePrice({ lookupKey: "pfx_testmode_one_time", name: "Profixter One-Time Visit", unitAmount: 9900 });
    // Webhooks: `stripe listen` with the same test key, forwarding to this API.
    const events = "checkout.session.completed,checkout.session.expired,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,payment_intent.payment_failed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed";
    const secret = execFileSync("stripe", ["listen", "--print-secret", "--api-key", stripeKey], { encoding: "utf8" }).trim();
    if (!/^whsec_/.test(secret)) throw new Error("stripe listen gave no webhook secret");
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    listen = spawn("stripe", ["listen", "--api-key", stripeKey, "--events", events, "--forward-to", `http://127.0.0.1:${PORT}/api/stripe/webhook`], { stdio: ["ignore", "ignore", "pipe"] });
    listen.stderr.on("data", (d) => {
      const line = String(d).trim();
      if (/Ready|error/i.test(line)) console.log(`[stripe listen] ${line.replace(/whsec_\w+/g, "whsec_…")}`);
    });
    console.log("Stripe TEST mode confirmed; prices ready; webhooks forwarded.");
  }

  /* ------------------------------------------------ throwaway database, seeded */
  const { MongoMemoryReplSet } = require("mongodb-memory-server");
  const mongoose = require("mongoose");
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri());
  const User = require("../models/User");
  const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
  await require("../utils/visitEntitlementIndexSafety").ensureVisitEntitlementIndexes({ logger: { log() {}, warn() {} } });
  for (const n of [1, 2]) {
    await User.create({ name: `Test Fixter ${n}`, email: `fixter${n}@phone-test.invalid`, password: crypto.randomBytes(12).toString("hex"), phone: "+15550002222", userId: `8300000${n}`, role: "employee", employeePosition: "Fixter", isActive: true });
  }
  await CompanyAvailabilityTemplate.create({
    active: true, timezone: "America/New_York", slotMinutes: 30, minLeadMinutes: 0, maxAdvanceDays: 120, defaultCapacity: 1, visitDurationMinutes: 90,
    weeklySchedule: Array.from({ length: 7 }, (_, weekday) => ({ weekday, enabled: weekday !== 0, starts: ["09:00", "10:30", "13:00", "14:30"].map((time) => ({ time, capacity: null })), intervals: [{ startTime: "09:00", endTime: "17:00", capacity: null }] })),
  });

  /* ------------------------------------------------ nothing leaves: mail captured, S3 and Meta stubbed */
  const mailbox = [];
  const mail = require("../utils/emailService");
  mail.transporter.sendMail = async (m) => {
    mailbox.unshift({ at: new Date().toISOString(), to: m.to, subject: m.subject, text: m.text || "" });
    return { messageId: `captured-${mailbox.length}`, response: "250 captured", accepted: [m.to], rejected: [], envelope: { to: [m.to] } };
  };
  require("../utils/metaCapi").sendDetached = () => {};
  const s3 = require("../utils/s3");
  s3.putPublicObject = async ({ Key }) => `https://phone-test-bucket.invalid/${Key}`;
  s3.deletePublicObjects = async ({ Keys }) => ({ deleted: Keys.length });

  /* ------------------------------------------------ phone codes: approved numbers only */
  const delivery = require("../utils/auth/otpDelivery");
  const authV2 = require("../routes/authV2");
  authV2.deps.deliver = async ({ channel, target, code }) => {
    if (channel === "email") {
      mailbox.unshift({ at: new Date().toISOString(), to: target, subject: "Your Profixter code", text: `Code: ${code}` });
      return;
    }
    if (NO_TEXTS) {
      mailbox.unshift({ at: new Date().toISOString(), to: target, subject: "(not texted) phone code", text: `No text sent in this mode. Code: ${code}` });
      return;
    }
    if (!approved.has(digits10(target))) {
      console.log(JSON.stringify({ event: "phone_test_refused_number", last4: digits10(target).slice(-4) }));
      const { OtpDeliveryError } = delivery;
      throw new OtpDeliveryError("SMS_UNAVAILABLE", "This test only texts approved numbers.");
    }
    await delivery.startVerify(target);
  };
  // Real runs: Verify checks the code (only ever for an approved number). Dry runs keep the code locally.
  if (!NO_TEXTS) authV2.deps.checkRemote = async ({ target, code }) => approved.has(digits10(target)) && delivery.checkVerify(target, code);

  /* ------------------------------------------------ the customer routes */
  const express = require("express");
  const cors = require("cors");
  const app = express();
  app.use(cors({ origin: [SITE], credentials: true, methods: "GET,POST,PUT,PATCH,DELETE", allowedHeaders: ["Authorization", "Content-Type"] }));
  app.post("/api/stripe/webhook", express.raw({ type: "application/json", limit: "2mb" }), require("../routes/webhook"));
  require("../utils/http/serverHardening").applyBodyParsers(app);
  app.use("/api/auth", require("../routes/auth"));
  app.use("/api/auth", authV2);
  app.use("/api/stripe/checkout", require("../routes/stripe"));
  app.use("/api/password-reset", require("../routes/passwordReset"));
  app.use("/api/subscriptions", require("../routes/subscriptions"));
  app.use("/api/bookings/guest", require("../routes/guestBookings"));
  app.use("/api/bookings", require("../routes/bookings"));
  app.use("/api/free-visit-requests", require("../routes/freeVisitRequests"));
  app.use("/api/recent-work", require("../routes/recentWork"));
  app.use("/api/service-area", require("../routes/serviceArea"));
  app.use("/api", require("../routes/promotionPopup"));
  app.use("/api/calendar", require("../routes/calendar"));
  app.use("/api/track", require("../routes/track"));
  app.use("/api/users", require("../routes/users"));
  app.use("/api/gifts", require("../routes/gifts"));

  /* The captured mailbox (this computer's Tailscale network only). */
  app.get("/__mail", (req, res) => {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Captured email</title>
<style>body{font:16px system-ui;margin:16px;max-width:720px}article{border:1px solid #ccc;border-radius:10px;padding:12px;margin:10px 0}pre{white-space:pre-wrap;font:14px system-ui}</style>
<h1>Captured email (${mailbox.length})</h1><p>Nothing here was sent. Newest first. <a href="/__mail">Refresh</a></p>
${mailbox.map((m) => `<article><b>${esc(m.subject)}</b><br><small>to ${esc(m.to)} · ${esc(m.at)}</small><pre>${esc(m.text).slice(0, 4000)}</pre></article>`).join("")}`);
  });
  app.get("/__health", (req, res) => res.json({ ok: true, dry: DRY, texts: !NO_TEXTS, approvedNumbers: approved.size, stripe: Boolean(stripe) }));

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`phone-test API on http://127.0.0.1:${PORT} (${DRY ? "DRY RUN" : `${NO_TEXTS ? "codes on /__mail" : `real codes to ${approved.size} approved number(s)`}; Stripe test mode`})`);
    console.log(`site ${SITE}  api ${API}  mailbox ${API}/__mail`);
  });

  const stop = async () => {
    try {
      if (listen) listen.kill();
      await mongoose.disconnect();
      await replSet.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
})().catch((error) => {
  console.error("phone-test failed:", error.message);
  process.exit(1);
});
