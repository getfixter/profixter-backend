/**
 * Module-level fakes for the local preview. Installed BEFORE server.js is
 * required, so every module the app loads sees them.
 *
 *   stripe               -> scripts/preview/fakeStripe (stateful, from the preview DB)
 *   nodemailer           -> a transport that writes to the preview outbox (SES never used)
 *   utils/sms/twilioProvider.sendMessage -> writes to the preview outbox
 *   utils/s3             -> local disk under preview-data/s3, served at /preview-s3/*
 *   @aws-sdk/* clients   -> every send() refuses (SES suppression sync, SSM, raw S3)
 *   @anthropic-ai/sdk    -> canned "[preview]" answer, no request
 *   utils/secrets        -> Parameter Store never loaded
 *   dotenv               -> no-op, so a stray .env can never add real credentials
 *   jobs/* schedulers    -> not started (reminders, marketing, SMS sweeps, growth,
 *                           agents, visibility, Meta, Stripe ledger, e-sign
 *                           provisioning...). Kept: the campaign sender (its mail
 *                           goes to the outbox) and the template-override refresh
 *                           (database only).
 *
 * Under all of this the network guard (safety.js) refuses any non-loopback
 * connection, so a fake that is missed still cannot reach anyone.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BACKEND = path.resolve(__dirname, "..", "..");
const fromBackend = (request) => require.resolve(request, { paths: [BACKEND] });
const local = (rel) => path.join(BACKEND, rel);

function stubModule(resolvedPath, exports) {
  require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports, children: [], paths: [] };
}

/* ------------------------------------------------------------------ */
/* Outbox                                                               */
/* ------------------------------------------------------------------ */

function createOutbox({ log }) {
  const recent = [];
  let collection = null;

  function connectionCollection() {
    if (collection) return collection;
    const mongoose = require(fromBackend("mongoose"));
    if (mongoose.connection.readyState !== 1) return null;
    collection = mongoose.connection.collection("preview_outbox");
    return collection;
  }

  async function record(entry) {
    const doc = { _id: crypto.randomUUID(), at: new Date(), ...entry };
    recent.unshift(doc);
    if (recent.length > 200) recent.pop();
    const target = connectionCollection();
    if (target) await target.insertOne(doc).catch(() => {});
    const who = entry.channel === "sms" ? entry.to : entry.to;
    const what = entry.channel === "sms" ? JSON.stringify(String(entry.body || "").slice(0, 90)) : JSON.stringify(entry.subject || "");
    log(`[preview outbox] ${entry.channel} to ${who}: ${what}`);
    return doc;
  }

  async function list({ limit = 100 } = {}) {
    const target = connectionCollection();
    if (target) return target.find({}).sort({ at: -1 }).limit(limit).toArray();
    return recent.slice(0, limit);
  }

  async function get(id) {
    const target = connectionCollection();
    if (target) return target.findOne({ _id: String(id) });
    return recent.find((x) => x._id === id) || null;
  }

  return { record, list, get };
}

/* ------------------------------------------------------------------ */
/* Local S3                                                             */
/* ------------------------------------------------------------------ */

function createLocalS3({ root, publicBase, log }) {
  fs.mkdirSync(root, { recursive: true });
  const resolveKey = (Key) => {
    const clean = String(Key || "").replace(/\\/g, "/").replace(/^\/+/, "");
    const full = path.resolve(root, clean);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error(`[preview s3] refused key outside the store: ${Key}`);
    return full;
  };
  const toBuffer = (Body) => (Buffer.isBuffer(Body) ? Body : typeof Body === "string" ? Buffer.from(Body) : Buffer.from(Body || []));
  const publicUrl = (Key) => `${publicBase}/preview-s3/${String(Key).split("/").map(encodeURIComponent).join("/")}`;

  return {
    root,
    publicUrl,
    async putPublicObject({ Key, Body }) {
      if (!Key) throw new Error("putPublicObject requires Key");
      if (!Body) throw new Error("putPublicObject requires Body");
      const file = resolveKey(Key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, toBuffer(Body));
      log(`[preview s3] stored public ${Key}`);
      return publicUrl(Key);
    },
    async putPrivateObject({ Bucket, Key, Body }) {
      if (!Key) throw new Error("putPrivateObject requires Key");
      if (!Body) throw new Error("putPrivateObject requires Body");
      const file = resolveKey(Key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, toBuffer(Body));
      log(`[preview s3] stored private ${Key}`);
      return { Bucket, Key };
    },
    async getObjectBuffer({ Key }) {
      if (!Key) throw new Error("getObjectBuffer requires Key");
      const file = resolveKey(Key);
      if (!fs.existsSync(file)) {
        const error = new Error(`NoSuchKey: ${Key} (preview store)`);
        error.name = "NoSuchKey";
        error.Code = "NoSuchKey";
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return fs.readFileSync(file);
    },
    async deletePublicObjects({ Keys = [] }) {
      let deleted = 0;
      for (const Key of [...new Set(Keys.filter(Boolean))]) {
        try {
          fs.unlinkSync(resolveKey(Key));
          deleted += 1;
        } catch {
          /* already gone */
        }
      }
      return { deleted };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Install                                                              */
/* ------------------------------------------------------------------ */

const DISABLED_STARTERS = [
  ["jobs/bookingReminders", "startBookingReminders"],
  ["jobs/marketingEmails", "startMarketingEmails"],
  ["jobs/bookingReviewRequests", "startBookingReviewRequests"],
  ["jobs/oneTimeVisitHolds", "startOneTimeVisitHoldCleanup"],
  ["jobs/smsJobs", "startSmsJobs"],
  ["jobs/giftLifecycle", "startGiftLifecycle"],
  ["jobs/membershipNotices", "startMembershipNotices"],
  ["jobs/loyaltyReminders", "startLoyaltyReminders"],
  ["jobs/growthActions", "startGrowthJobs"],
  ["jobs/visibility", "startVisibilityJobs"],
  ["jobs/agents", "startAgentJobs"],
  ["jobs/conversations", "startConversationJobs"],
  ["jobs/recentWorkPublisher", "startRecentWorkPublisher"],
  ["jobs/signatureExpiry", "startSignatureExpiry"],
  ["utils/analytics/stripeRevenue", "startRevenueLedgerSync"],
  ["utils/analytics/metaAdSpend", "startMetaAdSpendSync"],
  ["utils/analytics/metaCampaignAudit", "startMetaCampaignAudit"],
  ["utils/growth/selfCheck", "scheduleSelfCheck"],
  ["utils/esign/webhookProvisioner", "runStartupProvisioning"],
  ["utils/secrets", "startParameterSecrets"],
];

function installFakes({ s3Root, publicBase, log = console.log, loadStripeData }) {
  const outbox = createOutbox({ log });
  const disabled = [];

  /* dotenv: a .env file must never add real credentials behind the guard. */
  stubModule(fromBackend("dotenv"), { config: () => ({ parsed: {} }), parse: () => ({}), configDotenv: () => ({ parsed: {} }) });

  /* Stripe */
  const { createFakeStripeFactory } = require("./fakeStripe");
  const StripeFactory = createFakeStripeFactory({ log, publicBase, loadData: loadStripeData });
  stubModule(fromBackend("stripe"), StripeFactory);

  /* Email: nodemailer transport -> outbox (EmailLog rows are still written by the app). */
  const realNodemailer = require(fromBackend("nodemailer"));
  const fakeTransport = {
    async sendMail(mail = {}) {
      const to = [].concat(mail.to || []).join(", ");
      const messageId = mail.messageId || `<preview-${crypto.randomUUID()}@preview.local>`;
      await outbox.record({
        channel: "email",
        to,
        bcc: mail.bcc ? [].concat(mail.bcc).join(", ") : "",
        from: String(mail.from || ""),
        subject: String(mail.subject || ""),
        text: String(mail.text || "").slice(0, 20000),
        html: String(mail.html || "").slice(0, 200000),
        attachments: (mail.attachments || []).map((a) => a.filename || "attachment"),
        messageId,
      });
      return { messageId, accepted: [to], rejected: [], response: "250 preview outbox (not sent)", envelope: { from: mail.from, to: [to] } };
    },
    async verify() {
      return true;
    },
    close() {},
    on() {},
  };
  stubModule(fromBackend("nodemailer"), { ...realNodemailer, createTransport: () => fakeTransport });

  /* Anthropic */
  class PreviewAnthropic {
    constructor() {
      this.messages = {
        async create() {
          log("[preview] Anthropic call answered locally (no request made)");
          return {
            id: "msg_preview",
            type: "message",
            role: "assistant",
            model: "preview",
            content: [{ type: "text", text: "[preview] AI is disabled in the local preview." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0 },
          };
        },
        async countTokens() {
          return { input_tokens: 0 };
        },
      };
    }
  }
  try {
    stubModule(fromBackend("@anthropic-ai/sdk"), { Anthropic: PreviewAnthropic, default: PreviewAnthropic });
  } catch {
    /* not installed: nothing to fake */
  }

  /* AWS SDK: any client that is constructed anyway refuses to send. */
  for (const [pkg, names] of [
    ["@aws-sdk/client-s3", ["S3Client"]],
    ["@aws-sdk/client-sesv2", ["SESv2Client"]],
    ["@aws-sdk/client-ssm", ["SSMClient"]],
  ]) {
    try {
      const mod = require(fromBackend(pkg));
      for (const name of names) {
        if (!mod[name]) continue;
        mod[name].prototype.send = async function refusedSend(command) {
          const label = command?.constructor?.name || "command";
          log(`[preview blocked] AWS ${name}.${label} refused`);
          const error = new Error(`[preview] AWS ${name} is disabled`);
          error.name = "PreviewAwsDisabled";
          throw error;
        };
      }
    } catch {
      /* package absent */
    }
  }

  /* S3 -> local disk */
  const s3 = createLocalS3({ root: s3Root, publicBase, log });
  stubModule(local("utils/s3.js"), {
    putPublicObject: s3.putPublicObject,
    putPrivateObject: s3.putPrivateObject,
    getObjectBuffer: s3.getObjectBuffer,
    deletePublicObjects: s3.deletePublicObjects,
  });

  /* Twilio -> outbox */
  const twilio = require(local("utils/sms/twilioProvider.js"));
  twilio.sendMessage = async function previewSendMessage({ to, body, notificationType = "" }) {
    const sid = `SMpreview${crypto.randomBytes(12).toString("hex")}`;
    await outbox.record({ channel: "sms", to: String(to || ""), body: String(body || ""), notificationType, sid });
    return { sid, status: "sent", numSegments: Math.max(1, Math.ceil(String(body || "").length / 153)), to: String(to || "") };
  };

  /* Schedulers that are not started. */
  for (const [rel, name] of DISABLED_STARTERS) {
    const mod = require(local(`${rel}.js`));
    if (typeof mod[name] !== "function") {
      log(`[preview] WARNING: expected ${rel}.${name} to exist; nothing to disable`);
      continue;
    }
    mod[name] = function disabledStarter() {
      disabled.push(`${rel}.${name}`);
      return Promise.resolve(null);
    };
  }

  return { outbox, s3, StripeFactory, disabled };
}

module.exports = { installFakes, createLocalS3, createOutbox, DISABLED_STARTERS, stubModule };
