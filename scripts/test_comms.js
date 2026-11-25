/*
 * Communications, end to end (routes/adminComms.js, utils/comms/*, the Twilio
 * SMS and voice webhooks): permissions, webhook signatures, replayed and
 * out-of-order callbacks, inbound replies and unread, unknown and ambiguous
 * numbers, manual sends (idempotency, failures, ambiguous timeouts and
 * reconciliation, explicit retry), opt-outs, bulk sends (preview, exclusions,
 * confirm ceiling, approval, overlapping workers, crash recovery, cancel,
 * opt-out after scheduling, retry of failures), history imports resumed after
 * interruption, the automated-text mirror, the customer timeline, recycled
 * numbers, search, and MMS media access.
 *
 * Real routes and a real in-memory MongoDB replica set. Twilio and GoHighLevel
 * are faked at the network layer; S3 is in memory. Nothing leaves the machine.
 *
 *   node scripts/test_comms.js
 */
const crypto = require("crypto");
Object.assign(process.env, {
  NODE_ENV: "test",
  JWT_SECRET: "test-secret-comms",
  STRIPE_SECRET_KEY: "sk_test_fake_for_unit_tests",
  S3_BUCKET: "test-bucket",
  AWS_REGION: "us-east-1",
  MAIL_ADMIN: "owner@example.test",
  SMS_ENABLED: "true",
  SMS_MARKETING_ENABLED: "true",
  SMS_MARKETING_LAUNCH_AT: "2020-01-01T00:00:00Z",
  TWILIO_ACCOUNT_SID: "ACtest0000000000000000000000000000",
  TWILIO_API_KEY: "SKtest",
  TWILIO_API_SECRET: "secret-test",
  TWILIO_AUTH_TOKEN: "auth-token-test",
  TWILIO_MESSAGING_SERVICE_SID: "MGtest00000000000000000000000000",
  TWILIO_PHONE_NUMBER: "+16318886340",
  PUBLIC_API_BASE_URL: "https://api.test.profixter",
  GHL_API_TOKEN: "ghl-test-not-real",
  GHL_LOCATION_ID: "LOCtest",
});
const LINE = "+16318886340";

const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

/* ------------------------------------------------------------ fake S3 */
const s3Objects = new Map();
stub("../utils/s3", {
  async putPrivateObject({ Key, Body, ContentType }) {
    s3Objects.set(Key, { Body, ContentType });
    return { Key };
  },
  async putPublicObject({ Key }) {
    return `https://test/${Key}`;
  },
  async getObjectBuffer({ Key }) {
    if (!s3Objects.has(Key)) throw new Error("NoSuchKey");
    return s3Objects.get(Key).Body;
  },
  async deletePublicObjects() {
    return { deleted: 0 };
  },
});
stub("../utils/growth/checkoutRecovery", { async proposeCheckoutRecovery() {} });

/* -------------------------------------------------------- fake Twilio */
const twilio = { posts: [], sent: [], mode: null, seq: 0, beforeRespond: null, pages: {}, failPage: null, gets: [] };
function resp(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] || null },
    text: async () => text,
    json: async () => JSON.parse(text),
    arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(text)),
  };
}
async function fakeTwilio(url, init = {}) {
  const u = new URL(url);
  if (u.hostname === "api.twilio.com" && u.pathname.endsWith("/Messages.json") && init.method === "POST") {
    const p = new URLSearchParams(init.body);
    twilio.posts.push(p);
    if (twilio.mode === "timeout") throw new Error("network timeout");
    if (twilio.mode && twilio.mode.code) return resp(400, { code: twilio.mode.code, message: twilio.mode.message || "refused" });
    const sid = `SMfake${String(++twilio.seq).padStart(6, "0")}`;
    if (twilio.beforeRespond) await twilio.beforeRespond(sid, p);
    twilio.sent.push({ sid, to: p.get("To"), from: p.get("From") || LINE, body: p.get("Body"), status: "accepted", date_created: new Date().toUTCString() });
    return resp(201, { sid, status: "accepted", num_segments: "1", to: p.get("To"), from: p.get("From") || "" });
  }
  if (u.hostname === "api.twilio.com" && init.method !== "POST") {
    twilio.gets.push(u.pathname + u.search);
    if (u.pathname.endsWith("/Messages.json") && u.searchParams.get("To")) {
      return resp(200, { messages: twilio.sent.filter((m) => m.to === u.searchParams.get("To")) });
    }
    const key = u.pathname + u.search;
    if (twilio.failPage && key.includes(twilio.failPage)) {
      twilio.failCount = (twilio.failCount || 1) - 1;
      if (twilio.failCount <= 0) twilio.failPage = null;
      throw new Error("connection reset");
    }
    if (twilio.pages[key]) return resp(200, twilio.pages[key]);
    if (u.pathname.includes("/Media/")) return resp(200, Buffer.from("fake-image"), { "content-type": "image/jpeg" });
    return resp(404, { message: "not found" });
  }
  throw new Error(`unexpected outbound request in test: ${url}`);
}
stub("node-fetch", fakeTwilio);

/* ---------------------------------------------------- fake GoHighLevel */
const ghl = { conversations: [], messages: {}, calls: 0, failOnce: null };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const s = String(url);
  if (s.startsWith("https://services.leadconnectorhq.com")) {
    ghl.calls += 1;
    const u = new URL(s);
    if (u.pathname === "/conversations/search") {
      if (ghl.failOnce === "search") {
        ghl.failOnce = null;
        return new Response(JSON.stringify({ message: "rate limited" }), { status: 429 });
      }
      const after = Number(u.searchParams.get("startAfterDate") || 0);
      const limit = Number(u.searchParams.get("limit") || 20);
      const list = ghl.conversations.filter((c) => c.sort[0] > after).slice(0, limit);
      return new Response(JSON.stringify({ conversations: list, total: list.length }), { status: 200 });
    }
    const m = /^\/conversations\/([^/]+)\/messages$/.exec(u.pathname);
    if (m) {
      const all = ghl.messages[m[1]] || [];
      const last = u.searchParams.get("lastMessageId");
      const start = last ? all.findIndex((x) => x.id === last) + 1 : 0;
      const page = all.slice(start, start + 2);
      return new Response(JSON.stringify({ messages: { lastMessageId: page.length ? page[page.length - 1].id : null, nextPage: start + 2 < all.length, messages: page } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }
  return realFetch(url, init);
};

const { MongoMemoryReplSet } = require("mongodb-memory-server");
const User = require("../models/User");
const SmsMessage = require("../models/SmsMessage");
const SmsOptOut = require("../models/SmsOptOut");
const CommConversation = require("../models/CommConversation");
const CommMessage = require("../models/CommMessage");
const Blacklist = require("../models/Blacklist");
const EmailLog = require("../models/EmailLog");
const Booking = require("../models/Booking");
const { CommBulkSend, CommBulkRecipient, CommSettings, CommImportRun, CommPendingStatus } = require("../models/Comms");
const core = require("../utils/comms/core");
const sendMod = require("../utils/comms/send");
const bulkMod = require("../utils/comms/bulk");
const importsMod = require("../utils/comms/imports");
const { sendTransactionalSms } = require("../utils/sms/smsService");

/* ----------------------------------------------------------------- app */
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api/admin/comms", require("../routes/adminComms"));
app.use("/api/comms", require("../routes/commsPublic"));
app.use("/api/sms/webhook", require("../routes/smsWebhook"));
app.use("/api/voice/webhook", require("../routes/voiceWebhook"));

let base;
const tokenFor = (u) => jwt.sign({ id: String(u._id), tv: Number(u.tokenVersion || 0) }, process.env.JWT_SECRET, { expiresIn: "10m" });
async function call(method, path, user, body) {
  const r = await realFetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(user ? { authorization: `Bearer ${tokenFor(user)}` } : {}) },
    body: body && method !== "GET" ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try {
    json = JSON.parse(await r.text());
  } catch {
    json = {};
  }
  return { status: r.status, body: json };
}
function signTwilio(url, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac("sha1", process.env.TWILIO_AUTH_TOKEN).update(Buffer.from(data, "utf-8")).digest("base64");
}
async function webhook(path, params, { badSig = false } = {}) {
  const url = `https://api.test.profixter${path}`;
  const r = await realFetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": badSig ? "nope" : signTwilio(url, params) },
    body: new URLSearchParams(params).toString(),
  });
  return r.status;
}
let inSeq = 0;
const inbound = (from, body, extra = {}) => webhook("/api/sms/webhook/inbound", { MessageSid: `SMin${String(++inSeq).padStart(6, "0")}`, From: from, To: LINE, Body: body, NumMedia: "0", ...extra });
const status = (sid, s, extra = {}) => webhook("/api/sms/webhook/status", { MessageSid: sid, MessageStatus: s, ...extra });
const key = () => `k${crypto.randomUUID().replace(/-/g, "")}`;
const settle = () => new Promise((r) => setTimeout(r, 50));
/* The automation mirror runs just after a send (off its path): wait for the row it writes. */
async function eventually(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

let passed = 0;
let failed = 0;
async function check(name, fn) {
  twilio.mode = null;
  twilio.beforeRespond = null;
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(error.stack || error.message).split("\n").slice(0, 6).join("\n      ")}`);
  }
}

let seq = 0;
async function customer(fields = {}) {
  seq += 1;
  return User.create({
    userId: String(81000000 + seq),
    name: fields.name || `Customer ${seq}`,
    firstName: (fields.name || `Customer ${seq}`).split(" ")[0],
    email: `c${seq}@example.test`,
    phone: fields.phone === undefined ? `+1631555${String(1000 + seq).slice(-4)}` : fields.phone,
    role: "customer",
    smsPreferences: fields.smsPreferences || {},
    ...fields,
  });
}
const optedIn = { transactionalEnabled: true, transactionalConsentAt: new Date(), transactionalConsentSource: "signup_web_form" };
const enableSending = (on = true) => CommSettings.updateOne({ _id: "comms" }, { $set: { manualSendingEnabled: on, bulkSendingEnabled: on } }, { upsert: true }).then(() => core.clearSettingsCache());
const ny2pm = () => {
  // The next 2pm New York (19:00 UTC in November) that is still ahead: inside every send window, after any send confirmed now.
  const d = new Date();
  d.setUTCHours(19, 0, 0, 0);
  if (d.getTime() <= Date.now() + 60000) d.setUTCDate(d.getUTCDate() + 1);
  return d;
};

(async () => {
  const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri());
  await Promise.all([CommMessage.init(), CommConversation.init(), CommBulkRecipient.init(), CommBulkSend.init(), SmsMessage.init(), CommImportRun.init()]);
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;

  const owner = await User.create({ userId: "70000001", name: "Owner Person", email: "owner@example.test", role: "admin" });
  const fixter = await User.create({ userId: "70000002", name: "Fred Field", email: "ff@example.test", role: "employee", employeePosition: "Fixter", isActive: true });
  const agent = await User.create({ userId: "70000003", name: "Ivy Inbox", email: "ivy@example.test", role: "employee", employeePosition: null, adminSections: ["conversations"], isActive: true });
  const marketer = await User.create({ userId: "70000004", name: "Bea Bulk", email: "bea@example.test", role: "employee", employeePosition: null, adminSections: ["bulk-texts"], isActive: true });
  const tele = await User.create({ userId: "70000005", name: "Tom Tele", email: "tom@example.test", role: "employee", employeePosition: "Telemarketer", isActive: true });

  /* ================================================================ permissions */
  await check("permissions: field Fixter, Telemarketer and signed-out callers see nothing; sections grant only what they say", async () => {
    for (const who of [fixter, tele]) {
      for (const [m, p] of [["GET", "/api/admin/comms/bootstrap"], ["GET", "/api/admin/comms/conversations"], ["POST", "/api/admin/comms/send"], ["GET", "/api/admin/comms/bulk"], ["GET", "/api/admin/comms/search?q=ab"]]) {
        assert.strictEqual((await call(m, p, who, {})).status, 403, `${who.name} ${m} ${p}`);
      }
    }
    assert.strictEqual((await call("GET", "/api/admin/comms/conversations", null)).status, 401);
    const boot = (await call("GET", "/api/admin/comms/bootstrap", agent)).body;
    assert.deepStrictEqual([boot.can.send, boot.can.bulk, boot.can.approve, boot.can.settings], [true, false, false, false]);
    assert.strictEqual((await call("GET", "/api/admin/comms/bulk", agent)).status, 403, "inbox section cannot bulk");
    assert.strictEqual((await call("GET", "/api/admin/comms/settings", agent)).status, 403);
    assert.strictEqual((await call("POST", "/api/admin/comms/send", marketer, {})).status, 403, "bulk section cannot text one-to-one");
    assert.strictEqual((await call("GET", "/api/admin/comms/bulk", marketer)).status, 200);
    assert.strictEqual((await call("GET", "/api/admin/comms/settings", owner)).status, 200);
  });

  /* ================================================================== webhooks */
  const ana = await customer({ name: "Ana Reply", phone: "+16315550101" });
  await check("webhook: a bad signature is refused and stores nothing", async () => {
    assert.strictEqual(await webhook("/api/sms/webhook/inbound", { MessageSid: "SMforged2", From: "+16315550101", To: LINE, Body: "x" }, { badSig: true }), 403);
    assert.ok(!(await CommMessage.exists({ providerId: "SMforged2" })));
    assert.strictEqual(await webhook("/api/sms/webhook/status", { MessageSid: "SMx", MessageStatus: "delivered" }, { badSig: true }), 403);
  });
  await check("inbound reply lands in the customer's thread, unread, needs reply; a replayed webhook changes nothing (and auto-replies once)", async () => {
    const before = twilio.posts.length;
    const params = { MessageSid: "SMreplay01", From: "(631) 555-0101", To: LINE, Body: "Is Tuesday still on?", NumMedia: "0" };
    assert.strictEqual(await webhook("/api/sms/webhook/inbound", params), 200);
    assert.strictEqual(await webhook("/api/sms/webhook/inbound", params), 200);
    const msgs = await CommMessage.find({ providerId: "SMreplay01" }).lean();
    assert.strictEqual(msgs.length, 1);
    const conv = await CommConversation.findById(msgs[0].conversation).lean();
    assert.strictEqual(String(conv.user), String(ana._id));
    assert.deepStrictEqual([conv.unreadCount, conv.needsReply, conv.linkState, msgs[0].body], [1, true, "linked", "Is Tuesday still on?"]);
    assert.strictEqual(twilio.posts.length - before, 1, "the existing 'not monitored' auto-reply still goes out by default, once");
    assert.strictEqual(twilio.posts[twilio.posts.length - 1].get("To"), "+16315550101");
  });
  await check("the owner can switch the 'not monitored' auto-reply off; replies are still stored", async () => {
    await CommSettings.updateOne({ _id: "comms" }, { $set: { inboundAutoReply: "off" } }, { upsert: true });
    core.clearSettingsCache();
    const before = twilio.posts.length;
    await inbound("+16315550101", "Also, can you look at the gate?");
    assert.strictEqual(twilio.posts.length, before);
    assert.strictEqual((await CommConversation.findOne({ externalPhone: "+16315550101" }).lean()).unreadCount, 2);
  });
  await check("a reply brings an archived conversation back; reading clears unread for everyone", async () => {
    const conv = await CommConversation.findOne({ externalPhone: "+16315550101" });
    assert.strictEqual((await call("POST", `/api/admin/comms/conversations/${conv._id}/archive`, agent)).status, 200);
    await inbound("+16315550101", "Hello?");
    const after = await CommConversation.findById(conv._id).lean();
    assert.strictEqual(after.archived, false);
    assert.strictEqual((await call("POST", `/api/admin/comms/conversations/${conv._id}/read`, agent)).body.conversation.unreadCount, 0);
  });

  /* ============================================== unknown and ambiguous numbers */
  const twinA = await customer({ name: "Twin Alpha", phone: "+16315550202" });
  const twinB = await customer({ name: "Twin Beta", phone: "631-555-0202" });
  await check("unknown and ambiguous numbers: never attached to a customer until someone links them explicitly", async () => {
    await inbound("+16315559999", "Who is this?");
    const unknown = await CommConversation.findOne({ externalPhone: "+16315559999" }).lean();
    assert.deepStrictEqual([unknown.linkState, unknown.user], ["unknown", null]);
    await inbound("+16315550202", "Hi it's one of the twins");
    const amb = await CommConversation.findOne({ externalPhone: "+16315550202" }).lean();
    assert.strictEqual(amb.linkState, "ambiguous");
    assert.strictEqual(amb.candidateUsers.length, 2);
    const msg = await CommMessage.findOne({ conversation: amb._id }).lean();
    assert.strictEqual(msg.user, null, "nobody's timeline gets it yet");
    const unmatched = (await call("GET", "/api/admin/comms/conversations?filter=unmatched", agent)).body.items.map((c) => c.id);
    assert.ok(unmatched.includes(String(amb._id)) && unmatched.includes(String(unknown._id)));
    const detail = (await call("GET", `/api/admin/comms/conversations/${amb._id}`, agent)).body;
    assert.strictEqual(detail.candidates.length, 2);
    const link = await call("POST", `/api/admin/comms/conversations/${amb._id}/link`, agent, { userId: String(twinB._id) });
    assert.strictEqual(link.status, 200, JSON.stringify(link.body));
    assert.strictEqual(String((await CommMessage.findOne({ conversation: amb._id, channel: "sms" }).lean()).user), String(twinB._id));
    const relink = await call("POST", `/api/admin/comms/conversations/${amb._id}/link`, agent, { userId: String(twinA._id) });
    assert.strictEqual(relink.status, 409, "relinking to someone else needs explicit confirmation");
    // Texting twin A from their record must not write into twin B's thread.
    await enableSending(true);
    const cross = await call("POST", "/api/admin/comms/send", owner, { userId: String(twinA._id), toPhone: "+16315550202", lineNumber: LINE, body: "Hi", idempotencyKey: key(), quietHoursAck: true });
    assert.strictEqual(cross.status, 409);
    assert.strictEqual(cross.body.code, "PHONE_BELONGS_TO_OTHER");
    await enableSending(false);
  });

  /* ================================================================ manual sends */
  const cam = await customer({ name: "Cam Consent", smsPreferences: optedIn });
  const nora = await customer({ name: "Nora Noconsent" });
  await check("manual sending is OFF until the owner switches it on, and says so", async () => {
    const r = await call("POST", "/api/admin/comms/send", agent, { userId: String(cam._id), lineNumber: LINE, body: "Hi", idempotencyKey: key(), quietHoursAck: true });
    assert.deepStrictEqual([r.status, r.body.code], [409, "SENDING_OFF"]);
    assert.match(r.body.message, /owner can turn it on/);
  });
  await check("consent: service texts need an opt-in or a conversation the customer started; promotions need qualifying marketing consent", async () => {
    await enableSending(true);
    const none = await call("POST", "/api/admin/comms/send", agent, { userId: String(nora._id), lineNumber: LINE, body: "Hi", idempotencyKey: key(), quietHoursAck: true });
    assert.deepStrictEqual([none.status, none.body.reason], [422, "no_service_consent"]);
    assert.match(none.body.message, /hasn't texted us in the last 30 days/);
    const promo = await call("POST", "/api/admin/comms/send", agent, { userId: String(cam._id), lineNumber: LINE, body: "Sale!", purpose: "marketing", idempotencyKey: key(), quietHoursAck: true });
    assert.deepStrictEqual([promo.status, promo.body.reason], [422, "marketing_not_opted_in"]);
    // Ana texted us: replying is allowed without an opt-in.
    const conv = await CommConversation.findOne({ externalPhone: "+16315550101" });
    const reply = await call("POST", "/api/admin/comms/send", agent, { conversationId: String(conv._id), lineNumber: LINE, body: "Yes, Tuesday at 10.", idempotencyKey: key(), quietHoursAck: true });
    assert.strictEqual(reply.status, 201, JSON.stringify(reply.body));
  });
  await check("send once: double-click and replay produce ONE Twilio request; the chosen line is the From; accepted is not delivered", async () => {
    const k = key();
    const before = twilio.posts.length;
    const body = { userId: String(cam._id), lineNumber: LINE, body: "Your Fixter is on the way.", idempotencyKey: k, quietHoursAck: true };
    const [a, b] = await Promise.all([call("POST", "/api/admin/comms/send", agent, body), call("POST", "/api/admin/comms/send", agent, body)]);
    const again = await call("POST", "/api/admin/comms/send", agent, body);
    assert.strictEqual(twilio.posts.length - before, 1, "one request to Twilio");
    assert.ok([a.status, b.status].includes(201) && again.body.duplicate === true);
    const p = twilio.posts[twilio.posts.length - 1];
    assert.deepStrictEqual([p.get("From"), p.get("MessagingServiceSid"), p.get("To")], [LINE, process.env.TWILIO_MESSAGING_SERVICE_SID, cam.phone]);
    assert.strictEqual(again.body.message.status, "queued", "Twilio accepted it; nobody claims it was delivered");
    const sid = (await CommMessage.findById(again.body.message.id).lean()).providerId;
    await status(sid, "delivered");
    await status(sid, "sent"); // out of order: must not move it back
    const m = await CommMessage.findById(again.body.message.id).lean();
    assert.strictEqual(m.status, "delivered");
    assert.ok(m.deliveredAt);
  });
  await check("a status callback that beats its own send is parked and applied once the SID is saved", async () => {
    twilio.beforeRespond = async (sid) => {
      assert.strictEqual(await status(sid, "delivered"), 200);
    };
    const r = await call("POST", "/api/admin/comms/send", agent, { userId: String(cam._id), lineNumber: LINE, body: "Early callback test", idempotencyKey: key(), quietHoursAck: true });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.message.status, "delivered");
    assert.strictEqual(await CommPendingStatus.countDocuments({}), 0);
  });
  await check("a refused send fails clearly, keeps a record, and a Twilio opt-out (21610) is written into our own suppression", async () => {
    const dana = await customer({ name: "Dana Stopped", smsPreferences: optedIn });
    twilio.mode = { code: 21610, message: "Attempt to send to unsubscribed recipient" };
    const r = await call("POST", "/api/admin/comms/send", agent, { userId: String(dana._id), lineNumber: LINE, body: "Hello", idempotencyKey: key(), quietHoursAck: true });
    assert.strictEqual(r.body.message.status, "failed");
    assert.ok(await SmsOptOut.exists({ phone: dana.phone }));
    twilio.mode = null;
    const next = await call("POST", "/api/admin/comms/send", agent, { userId: String(dana._id), lineNumber: LINE, body: "Hello again", idempotencyKey: key(), quietHoursAck: true });
    assert.deepStrictEqual([next.status, next.body.reason], [422, "opted_out_all"]);
  });
  await check("a timed-out send is 'unknown', never resent; reconciliation adopts Twilio's record, or fails it after 15 minutes so retry opens", async () => {
    const eve = await customer({ name: "Eve Timeout", smsPreferences: optedIn });
    // Twilio accepted it but our request timed out.
    twilio.mode = "timeout";
    const before = twilio.posts.length;
    const r = await call("POST", "/api/admin/comms/send", agent, { userId: String(eve._id), lineNumber: LINE, body: "Timed out message", idempotencyKey: key(), quietHoursAck: true });
    assert.strictEqual(r.body.message.status, "unknown");
    twilio.mode = null;
    twilio.sent.push({ sid: "SMlanded01", to: eve.phone, from: LINE, body: "Timed out message", status: "delivered", date_created: new Date().toUTCString() });
    const retryEarly = await call("POST", `/api/admin/comms/messages/${r.body.message.id}/retry`, agent, { idempotencyKey: key(), quietHoursAck: true });
    assert.strictEqual(retryEarly.body.code, "STILL_CHECKING");
    await sendMod.reconcileUnknown({ now: new Date(Date.now() + 2 * 60 * 1000) });
    const adopted = await CommMessage.findById(r.body.message.id).lean();
    assert.deepStrictEqual([adopted.providerId, adopted.status], ["SMlanded01", "delivered"]);
    // Twilio never got the second one.
    twilio.mode = "timeout";
    const r2 = await call("POST", "/api/admin/comms/send", agent, { userId: String(eve._id), lineNumber: LINE, body: "Never arrived", idempotencyKey: key(), quietHoursAck: true });
    twilio.mode = null;
    await sendMod.reconcileUnknown({ now: new Date(Date.now() + 5 * 60 * 1000) });
    assert.strictEqual((await CommMessage.findById(r2.body.message.id).lean()).status, "unknown", "not failed before 15 minutes");
    await sendMod.reconcileUnknown({ now: new Date(Date.now() + 16 * 60 * 1000) });
    assert.strictEqual((await CommMessage.findById(r2.body.message.id).lean()).status, "failed");
    assert.strictEqual(twilio.posts.length - before, 2, "exactly the two original attempts; nothing resent automatically");
  });
  await check("explicit retry of a confirmed failure sends once and links to the original; a second retry is the same message", async () => {
    const fay = await customer({ name: "Fay Filtered", smsPreferences: optedIn });
    const r = await call("POST", "/api/admin/comms/send", agent, { userId: String(fay._id), lineNumber: LINE, body: "Carrier filtered", idempotencyKey: key(), quietHoursAck: true });
    const sid = (await CommMessage.findById(r.body.message.id).lean()).providerId;
    await status(sid, "undelivered", { ErrorCode: "30007" });
    const conv = await CommConversation.findById(r.body.conversationId).lean();
    assert.strictEqual(conv.deliveryProblem, true);
    const before = twilio.posts.length;
    const r1 = await call("POST", `/api/admin/comms/messages/${r.body.message.id}/retry`, agent, { idempotencyKey: key(), quietHoursAck: true });
    const r2 = await call("POST", `/api/admin/comms/messages/${r.body.message.id}/retry`, agent, { idempotencyKey: key(), quietHoursAck: true });
    assert.strictEqual(r1.status, 201, JSON.stringify(r1.body));
    assert.strictEqual(r2.body.message.id, r1.body.message.id);
    assert.strictEqual(twilio.posts.length - before, 1);
  });
  await check("internal notes are stored in the thread and never sent", async () => {
    const conv = await CommConversation.findOne({ externalPhone: cam.phone });
    const before = twilio.posts.length;
    const k = key();
    const n = await call("POST", `/api/admin/comms/conversations/${conv._id}/notes`, agent, { body: "Prefers mornings.", idempotencyKey: k });
    const again = await call("POST", `/api/admin/comms/conversations/${conv._id}/notes`, agent, { body: "Prefers mornings.", idempotencyKey: k });
    assert.deepStrictEqual([n.status, n.body.message.channel, n.body.message.direction, again.body.duplicate], [201, "note", "internal", true]);
    assert.strictEqual(twilio.posts.length, before);
  });
  await check("assign, archive, reopen and 'mine' filter; bulk inbox action refuses when the selection moved", async () => {
    const conv = await CommConversation.findOne({ externalPhone: cam.phone });
    const a = await call("POST", `/api/admin/comms/conversations/${conv._id}/assign`, agent, { userId: String(agent._id) });
    assert.strictEqual(a.body.conversation.assignedToName, "Ivy Inbox");
    assert.strictEqual((await call("POST", `/api/admin/comms/conversations/${conv._id}/assign`, agent, { userId: String(fixter._id) })).status, 400, "cannot assign to someone without access");
    const mine = (await call("GET", "/api/admin/comms/conversations?filter=mine", agent)).body.items;
    assert.ok(mine.some((c) => c.id === String(conv._id)));
    const unread = (await call("GET", "/api/admin/comms/conversations?filter=unread", agent)).body.items.length;
    const wrong = await call("POST", "/api/admin/comms/conversations/bulk", agent, { action: "archive", matching: { filter: "unread" }, expectedCount: unread + 5 });
    assert.strictEqual(wrong.status, 409);
    const ok = await call("POST", "/api/admin/comms/conversations/bulk", agent, { action: "read", ids: [String(conv._id)], expectedCount: 1 });
    assert.strictEqual(ok.body.updated, 1);
  });
  await check("STOP from a customer: thread shows it, suppression is recorded, manual texts are refused", async () => {
    const gus = await customer({ name: "Gus Stop", smsPreferences: optedIn });
    await inbound(gus.phone, "STOP");
    assert.ok(await SmsOptOut.exists({ phone: gus.phone }));
    const conv = await CommConversation.findOne({ externalPhone: gus.phone }).lean();
    assert.ok(await CommMessage.exists({ conversation: conv._id, channel: "system", body: /opted out/ }));
    const r = await call("POST", "/api/admin/comms/send", agent, { conversationId: String(conv._id), lineNumber: LINE, body: "Hi", idempotencyKey: key(), quietHoursAck: true });
    assert.strictEqual(r.body.reason, "opted_out_all");
  });

  /* ================================================================== live inbox */
  await check("live updates: the changes feed returns a conversation the moment a reply arrives", async () => {
    const t0 = (await call("GET", "/api/admin/comms/changes", agent)).body.serverTime;
    await new Promise((r) => setTimeout(r, 30));
    await inbound(cam.phone, "Thanks!");
    const ch = (await call("GET", `/api/admin/comms/changes?since=${encodeURIComponent(t0)}`, agent)).body;
    const row = ch.items.find((c) => c.phone === cam.phone);
    assert.ok(row && row.unreadCount >= 1 && row.lastPreview === "Thanks!");
    assert.ok(ch.counts.unread >= 1);
  });

  /* ======================================================== automation mirror */
  await check("automated texts appear in the thread as automation, with their delivery status, without changing how they send", async () => {
    const hal = await customer({ name: "Hal Auto", smsPreferences: optedIn });
    const r = await sendTransactionalSms({ notificationType: "ACCOUNT_CREATED", dedupeKey: `t:${hal._id}`, user: hal, vars: { name: "Hal" }, now: ny2pm() });
    assert.strictEqual(r.status, "sent", JSON.stringify(r));
    const sms = await SmsMessage.findById(r.id).lean();
    const m = await eventually(() => CommMessage.findOne({ smsMessage: sms._id }).lean());
    assert.deepStrictEqual([m.kind, m.automationType, m.status], ["automation", "ACCOUNT_CREATED", "queued"]);
    await status(sms.providerMessageSid, "delivered");
    assert.strictEqual((await eventually(async () => ((await CommMessage.findById(m._id).lean()).status === "delivered" ? "delivered" : null))), "delivered");
    assert.strictEqual((await SmsMessage.findById(r.id).lean()).status, "delivered", "the automation's own record still updates");
    const suppressed = await sendTransactionalSms({ notificationType: "ACCOUNT_CREATED", dedupeKey: `t:${nora._id}`, user: nora, vars: {}, now: ny2pm() });
    assert.strictEqual(suppressed.status, "suppressed");
    const sm = await eventually(() => CommMessage.findOne({ smsMessage: suppressed.id }).lean());
    assert.deepStrictEqual([sm.status, /Not sent/.test(sm.errorMessage)], ["suppressed", true]);
  });

  /* ============================================================ bulk sending */
  const bulkPeople = [];
  for (let i = 0; i < 4; i++) bulkPeople.push(await customer({ name: `Bulk Person${i}`, smsPreferences: optedIn }));
  const noPhone = await customer({ name: "No Phone", phone: "", smsPreferences: optedIn });
  const dup = await customer({ name: "Dup Phone", phone: bulkPeople[0].phone, smsPreferences: optedIn });
  const noOpt = await customer({ name: "No Optin" });
  const stopped = await customer({ name: "Stopped Person", smsPreferences: optedIn });
  await SmsOptOut.create({ phone: stopped.phone, scope: "all", source: "carrier_keyword", optedOutAt: new Date() });
  const blockedP = await customer({ name: "Blocked Person", smsPreferences: optedIn });
  await Blacklist.create({ user: blockedP._id, userId: blockedP.userId, email: blockedP.email, phone: blockedP.phone, phoneDigits: blockedP.phone.slice(2), reason: "test" });
  const audience = [...bulkPeople, noPhone, dup, noOpt, stopped, blockedP].map((u) => String(u._id));
  let bulkId;

  await check("bulk preview freezes the audience and explains every exclusion", async () => {
    const d = await call("POST", "/api/admin/comms/bulk", owner, { name: "Gate check", purpose: "service", lineNumber: LINE, body: "Hi {firstName}, we're in your area Friday.", audience: { type: "selected", userIds: audience } });
    assert.strictEqual(d.status, 201, JSON.stringify(d.body));
    bulkId = d.body.bulk.id;
    const p = (await call("POST", `/api/admin/comms/bulk/${bulkId}/preview`, owner)).body;
    assert.deepStrictEqual([p.bulk.counts.total, p.bulk.counts.eligible], [9, 4]);
    const reasons = Object.fromEntries(p.exclusions.map((e) => [e.reason, e.count]));
    assert.deepStrictEqual(reasons, { no_valid_phone: 1, duplicate_phone: 1, bulk_requires_opt_in: 1, opted_out_all: 1, blocked: 1 });
    assert.strictEqual(p.samples[0].body, "Hi Bulk, we're in your area Friday.");
  });
  await check("confirm must quote the previewed count; a non-owner's confirmation waits for the owner's approval", async () => {
    const wrong = await call("POST", `/api/admin/comms/bulk/${bulkId}/confirm`, owner, { expectedEligible: 5, confirmKey: key() });
    assert.strictEqual(wrong.body.code, "COUNT_CHANGED");
    const mk = await call("POST", "/api/admin/comms/bulk", marketer, { purpose: "service", lineNumber: LINE, body: "Hello {firstName}", audience: { type: "selected", userIds: [String(bulkPeople[1]._id)] } });
    await call("POST", `/api/admin/comms/bulk/${mk.body.bulk.id}/preview`, marketer);
    const c = await call("POST", `/api/admin/comms/bulk/${mk.body.bulk.id}/confirm`, marketer, { expectedEligible: 1, confirmKey: key() });
    assert.strictEqual(c.body.bulk.status, "pending_approval");
    assert.strictEqual((await call("POST", `/api/admin/comms/bulk/${mk.body.bulk.id}/approve`, marketer)).status, 403);
    await bulkMod.runBulkTick({ now: ny2pm() });
    assert.strictEqual(await CommMessage.countDocuments({ bulkSend: mk.body.bulk.id }), 0, "nothing sent before approval");
    await call("POST", `/api/admin/comms/bulk/${mk.body.bulk.id}/cancel`, owner);
  });
  await check("a later member of the audience is NOT texted: only the confirmed snapshot is sent", async () => {
    // Somebody joins the selection list after preview: the confirmed audience cannot grow.
    await CommBulkSend.updateOne({ _id: bulkId }, { $push: { "audience.userIds": (await customer({ name: "Late Joiner", smsPreferences: optedIn }))._id } });
    const c = await call("POST", `/api/admin/comms/bulk/${bulkId}/confirm`, owner, { expectedEligible: 4, confirmKey: key() });
    assert.strictEqual(c.body.bulk.status, "scheduled", JSON.stringify(c.body));
    assert.strictEqual(c.body.bulk.confirmedCount, 4);
  });
  await check("opt-out after scheduling is honoured; overlapping workers send each person exactly once", async () => {
    await inbound(bulkPeople[3].phone, "STOP");
    const before = twilio.posts.length;
    await Promise.all([bulkMod.runBulkTick({ now: ny2pm() }), bulkMod.runBulkTick({ now: ny2pm() }), bulkMod.runBulkTick({ now: ny2pm() })]);
    for (let i = 0; i < 3; i++) await bulkMod.runBulkTick({ now: ny2pm() });
    const posts = twilio.posts.slice(before).map((p) => p.get("To"));
    assert.deepStrictEqual(posts.sort(), [bulkPeople[0].phone, bulkPeople[1].phone, bulkPeople[2].phone].sort(), "three texts, no duplicates, nobody extra");
    const r = await CommBulkRecipient.findOne({ bulk: bulkId, phone: bulkPeople[3].phone }).lean();
    assert.strictEqual(r.status, "skipped");
    assert.match(r.reason, /STOP/);
    const b = await CommBulkSend.findById(bulkId).lean();
    assert.strictEqual(b.status, "completed");
  });
  await check("bulk outcomes: delivery callbacks update recipients; retry of confirmed failures sends each failure once", async () => {
    const recips = await CommBulkRecipient.find({ bulk: bulkId, status: "sent" }).lean();
    const m0 = await CommMessage.findById(recips[0].message).lean();
    const m1 = await CommMessage.findById(recips[1].message).lean();
    await status(m0.providerId, "delivered");
    await status(m1.providerId, "undelivered", { ErrorCode: "30003" });
    assert.strictEqual((await CommBulkRecipient.findById(recips[0]._id).lean()).status, "delivered");
    assert.strictEqual((await CommBulkRecipient.findById(recips[1]._id).lean()).status, "undelivered");
    const before = twilio.posts.length;
    const r1 = await call("POST", `/api/admin/comms/bulk/${bulkId}/retry-failed`, owner);
    const r2 = await call("POST", `/api/admin/comms/bulk/${bulkId}/retry-failed`, owner);
    assert.deepStrictEqual([r1.body.created, r2.body.created], [1, 0]);
    await bulkMod.runBulkTick({ now: ny2pm() });
    await bulkMod.runBulkTick({ now: ny2pm() });
    assert.strictEqual(twilio.posts.length - before, 1);
    const list = (await call("GET", `/api/admin/comms/bulk/${bulkId}/recipients`, owner)).body.items;
    assert.ok(list.some((x) => x.status === "excluded" && /blocked/i.test(x.reason)));
  });
  await check("a worker that died mid-send is resumed without a second text (idempotent per recipient)", async () => {
    const p = await customer({ name: "Crash Person", smsPreferences: optedIn });
    const d = await call("POST", "/api/admin/comms/bulk", owner, { purpose: "service", lineNumber: LINE, body: "Crash test", audience: { type: "selected", userIds: [String(p._id)] } });
    await call("POST", `/api/admin/comms/bulk/${d.body.bulk.id}/preview`, owner);
    await call("POST", `/api/admin/comms/bulk/${d.body.bulk.id}/confirm`, owner, { expectedEligible: 1, confirmKey: key() });
    await bulkMod.runBulkTick({ now: ny2pm() });
    const r = await CommBulkRecipient.findOne({ bulk: d.body.bulk.id }).lean();
    // Simulate: the worker sent, then died before recording the outcome.
    await CommBulkRecipient.updateOne({ _id: r._id }, { $set: { status: "sending", lockExpiresAt: new Date(Date.now() - 1000) } });
    await CommBulkSend.updateOne({ _id: d.body.bulk.id }, { $set: { status: "sending" } });
    const before = twilio.posts.length;
    await bulkMod.runBulkTick({ now: ny2pm() });
    assert.strictEqual(twilio.posts.length, before, "the resumed send found the text already sent");
    assert.strictEqual(await CommMessage.countDocuments({ bulkRecipient: r._id }), 1);
  });
  await check("cancel a scheduled send: pending recipients are canceled and nothing goes out", async () => {
    const p = await customer({ name: "Cancel Person", smsPreferences: optedIn });
    const d = await call("POST", "/api/admin/comms/bulk", owner, { purpose: "service", lineNumber: LINE, body: "Later", audience: { type: "selected", userIds: [String(p._id)] } });
    await call("POST", `/api/admin/comms/bulk/${d.body.bulk.id}/preview`, owner);
    const when = new Date(Date.now() + 3600e3).toISOString();
    const c = await call("POST", `/api/admin/comms/bulk/${d.body.bulk.id}/confirm`, owner, { expectedEligible: 1, scheduledFor: when, confirmKey: key() });
    assert.strictEqual(c.body.bulk.status, "scheduled");
    const x = await call("POST", `/api/admin/comms/bulk/${d.body.bulk.id}/cancel`, owner);
    assert.deepStrictEqual([x.body.bulk.status, x.body.canceled], ["canceled", 1]);
    const before = twilio.posts.length;
    await bulkMod.runBulkTick({ now: new Date(Date.now() + 2 * 3600e3) });
    assert.strictEqual(twilio.posts.length, before);
  });
  await check("bulk sending is off until the owner turns it on; promotions exclude people without qualifying consent", async () => {
    await CommSettings.updateOne({ _id: "comms" }, { $set: { bulkSendingEnabled: false } });
    core.clearSettingsCache();
    const d = await call("POST", "/api/admin/comms/bulk", owner, { purpose: "marketing", lineNumber: LINE, body: "20% off", audience: { type: "selected", userIds: [String(cam._id)] } });
    const p = (await call("POST", `/api/admin/comms/bulk/${d.body.bulk.id}/preview`, owner)).body;
    assert.deepStrictEqual(p.exclusions.map((e) => e.reason), ["marketing_not_opted_in"]);
    const c = await call("POST", `/api/admin/comms/bulk/${d.body.bulk.id}/confirm`, owner, { expectedEligible: 0, confirmKey: key() });
    assert.strictEqual(c.status, 409);
    await enableSending(true);
  });

  /* ================================================================ imports */
  await check("Twilio history import: resumes after an interruption, recovers replies, skips sign-in codes, and re-runs only count duplicates", async () => {
    const acct = `/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}`;
    twilio.pages[`${acct}/Messages.json?PageSize=200`] = {
      messages: [
        { sid: "SMhist1", direction: "inbound", from: "+16315550101", to: LINE, body: "Old reply from August", status: "received", messaging_service_sid: process.env.TWILIO_MESSAGING_SERVICE_SID, date_sent: "Mon, 03 Aug 2026 15:00:00 +0000", num_media: "0" },
        { sid: "SMverify", direction: "outbound-api", from: LINE, to: "+16315550101", body: "Your code is 123456", status: "delivered", messaging_service_sid: "MGverifyservice", date_sent: "Mon, 03 Aug 2026 15:01:00 +0000" },
      ],
      next_page_uri: `${acct}/Messages.json?PageSize=200&Page=1&PageToken=PA2`,
    };
    twilio.pages[`${acct}/Messages.json?PageSize=200&Page=1&PageToken=PA2`] = {
      messages: [{ sid: "SMhist2", direction: "inbound", from: "+16315558888", to: LINE, body: "Stranger in July", status: "received", messaging_service_sid: process.env.TWILIO_MESSAGING_SERVICE_SID, date_sent: "Fri, 10 Jul 2026 15:00:00 +0000" }],
      next_page_uri: null,
    };
    twilio.failPage = "PageToken=PA2";
    twilio.failCount = 2; // the provider retries with its second credential, so fail both
    await importsMod.start({ source: "twilio_messages", actor: owner });
    await importsMod.runImportsTick();
    let run = await CommImportRun.findOne({ source: "twilio_messages" }).lean();
    assert.strictEqual(run.status, "running", "interrupted on page 2, still running");
    assert.ok(run.cursor.includes("PA2"), "checkpoint saved after page 1");
    await importsMod.runImportsTick();
    run = await CommImportRun.findOne({ source: "twilio_messages" }).lean();
    assert.strictEqual(run.status, "done");
    assert.deepStrictEqual([run.counts.inserted, run.counts.skipped], [2, 1]);
    assert.ok(!(await CommMessage.exists({ providerId: "SMverify" })), "sign-in codes are never imported");
    assert.strictEqual((await CommMessage.findOne({ providerId: "SMhist1" }).lean()).body, "Old reply from August");
    await importsMod.reset({ source: "twilio_messages" });
    await importsMod.start({ source: "twilio_messages", actor: owner });
    await importsMod.runImportsTick();
    run = await CommImportRun.findOne({ source: "twilio_messages" }).lean();
    assert.deepStrictEqual([run.counts.inserted, run.counts.duplicates], [0, 2]);
    const stranger = await CommConversation.findOne({ externalPhone: "+16315558888" }).lean();
    assert.strictEqual(stranger.importOnly, true, "an unmatched history-only contact stays out of the everyday inbox");
    const all = (await call("GET", "/api/admin/comms/conversations", agent)).body.items.map((c) => c.id);
    assert.ok(!all.includes(String(stranger._id)));
  });
  await check("GoHighLevel import: links by phone, keeps unmatched contacts for review, resumes from its checkpoint after a rate limit", async () => {
    ghl.conversations = [
      { id: "gc1", contactId: "ct1", contactName: "Ana Reply", phone: "+16315550101", email: "", sort: [1000] },
      { id: "gc2", contactId: "ct2", contactName: "Cold Prospect", phone: null, email: "cold@nowhere.test", sort: [2000] },
    ];
    ghl.messages.gc1 = [
      { id: "gm1", direction: "outbound", messageType: "TYPE_SMS", body: "From GHL: see you Monday", dateAdded: "2026-05-01T14:00:00Z", source: "app", status: "delivered" },
      { id: "gm2", direction: "inbound", messageType: "TYPE_CALL", body: "", dateAdded: "2026-04-30T14:00:00Z", meta: { call: { duration: 125, status: "completed" } } },
      { id: "gm3", direction: "outbound", messageType: "TYPE_EMAIL", body: "<p>Estimate attached</p>", meta: { email: { subject: "Your estimate" } }, dateAdded: "2026-04-29T14:00:00Z", source: "workflow" },
    ];
    ghl.messages.gc2 = [{ id: "gm4", direction: "outbound", messageType: "TYPE_SMS", body: "Cold call follow-up", dateAdded: "2026-03-13T14:00:00Z", source: "app" }];
    ghl.failOnce = "search";
    await importsMod.start({ source: "ghl", actor: owner });
    await importsMod.runImportsTick();
    await importsMod.runImportsTick();
    await importsMod.runImportsTick();
    const run = await CommImportRun.findOne({ source: "ghl" }).lean();
    assert.strictEqual(run.status, "done", JSON.stringify(run));
    assert.strictEqual(run.counts.inserted, 4);
    const call1 = await CommMessage.findOne({ providerId: "gm2", provider: "ghl" }).lean();
    assert.deepStrictEqual([call1.channel, call1.call.durationSec, String(call1.user)], ["call", 125, String(ana._id)]);
    const email = await CommMessage.findOne({ providerId: "gm3" }).lean();
    assert.deepStrictEqual([email.channel, email.subject, email.body, email.kind], ["email", "Your estimate", "Estimate attached", "automation"]);
    const cold = await CommConversation.findOne({ contactKey: "ghl:ct2" }).lean();
    assert.deepStrictEqual([cold.linkState, cold.importOnly], ["unknown", true]);
    const unmatched = (await call("GET", "/api/admin/comms/conversations?filter=unmatched", agent)).body.items.map((c) => c.id);
    assert.ok(unmatched.includes(String(cold._id)));
  });

  /* ================================================================ timeline */
  await check("customer timeline merges texts, calls, emails and bookings with source labels and history range", async () => {
    await EmailLog.create({ templateKey: "booking_confirmed", subject: "Your visit is confirmed", recipientEmail: ana.email, customerEmail: ana.email, userId: ana._id, status: "sent", sentAt: new Date("2026-06-01T12:00:00Z"), text: "See you soon" });
    await Booking.collection.insertOne({ bookingNumber: "PF-1001", date: new Date("2026-06-05T14:00:00Z"), service: "Handyman visit", user: ana._id, userId: ana.userId, name: ana.name, address: "1 Main St", phone: ana.phone, email: ana.email, subscription: "basic", status: "Confirmed", createdAt: new Date("2026-06-01T11:00:00Z") });
    const all = (await call("GET", `/api/admin/comms/customers/${ana._id}/timeline?limit=60`, agent)).body;
    const kinds = new Set(all.items.map((i) => i.channel));
    for (const k of ["sms", "call", "email", "booking"]) assert.ok(kinds.has(k), `has ${k}`);
    assert.ok(all.items.some((i) => i.source === "GoHighLevel") && all.items.some((i) => i.source === "Profixter email"));
    assert.ok(all.sources.some((s) => s.source === "GoHighLevel"));
    const calls = (await call("GET", `/api/admin/comms/customers/${ana._id}/timeline?channel=call`, agent)).body.items;
    assert.ok(calls.length && calls.every((i) => i.channel === "call"));
    const page1 = (await call("GET", `/api/admin/comms/customers/${ana._id}/timeline?limit=3`, agent)).body;
    const page2 = (await call("GET", `/api/admin/comms/customers/${ana._id}/timeline?limit=3&before=${encodeURIComponent(page1.nextCursor)}`, agent)).body;
    assert.ok(page2.items.length && new Date(page2.items[0].occurredAt) < new Date(page1.items[2].occurredAt), "older history pages in");
  });
  await check("a recycled number never shows the old owner's history to the new owner", async () => {
    const oldOwner = await customer({ name: "Olga Oldnumber", phone: "+16315557777" });
    await inbound("+16315557777", "Olga's private message");
    oldOwner.phone = "+16315556666";
    await oldOwner.save(); // through the model, as every real phone change is (refreshes search.phone)
    const newOwner = await customer({ name: "Ned Newnumber", phone: "+16315557777" });
    await inbound("+16315557777", "Ned here, new number");
    const conv = await CommConversation.findOne({ externalPhone: "+16315557777" }).lean();
    assert.strictEqual(conv.linkState, "ambiguous", "needs a person to decide");
    const nedTimeline = (await call("GET", `/api/admin/comms/customers/${newOwner._id}/timeline`, agent)).body.items;
    assert.ok(!nedTimeline.some((i) => /Olga/.test(i.body || "")), "Ned never sees Olga's message");
    const olgaTimeline = (await call("GET", `/api/admin/comms/customers/${oldOwner._id}/timeline`, agent)).body.items;
    assert.ok(olgaTimeline.some((i) => /Olga's private/.test(i.body)) && !olgaTimeline.some((i) => /Ned here/.test(i.body || "")));
  });

  /* ================================================================== search */
  await check("search finds customers by partial name, phone in any format and email (even never texted), and message history", async () => {
    const never = await customer({ name: "Quentin Neverwritten", phone: "+16315554321" });
    for (const q of ["Quen", "quentin never", "(631) 555-4321", "5554321", never.email]) {
      const r = (await call("GET", `/api/admin/comms/search?q=${encodeURIComponent(q)}`, agent)).body;
      assert.ok(r.customers.some((c) => c.id === String(never._id)), `found by ${q}`);
      assert.strictEqual(r.customers.find((c) => c.id === String(never._id)).conversationId, null);
    }
    const msg = (await call("GET", `/api/admin/comms/search?q=${encodeURIComponent("gate")}`, agent)).body.messages;
    assert.ok(msg.some((m) => /gate/i.test(m.snippet) && m.conversationId));
    const contacts = (await call("GET", `/api/admin/comms/search?q=${encodeURIComponent("5559999")}`, agent)).body.contacts;
    assert.ok(contacts.some((c) => c.phone === "+16315559999"), "unknown numbers are findable too");
  });

  /* =================================================================== media */
  await check("MMS: pictures are stored privately, Twilio gets a signed expiring URL, and only Communications readers can view them", async () => {
    const sharp = require("sharp");
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#f00" } }).png().toBuffer();
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "photo.png");
    const up = await realFetch(`${base}/api/admin/comms/media`, { method: "POST", headers: { authorization: `Bearer ${tokenFor(agent)}` }, body: form });
    const upBody = await up.json();
    assert.strictEqual(up.status, 201, JSON.stringify(upBody));
    const r = await call("POST", "/api/admin/comms/send", agent, { userId: String(cam._id), lineNumber: LINE, body: "Here's the photo", mediaIds: [upBody.id], idempotencyKey: key(), quietHoursAck: true });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const mediaUrl = twilio.posts[twilio.posts.length - 1].get("MediaUrl");
    assert.match(mediaUrl, /^https:\/\/api\.test\.profixter\/api\/comms\/media\/[a-f0-9]{24}\?exp=\d+&sig=/);
    const path = mediaUrl.replace("https://api.test.profixter", "");
    assert.strictEqual((await realFetch(`${base}${path}`)).status, 200);
    assert.strictEqual((await realFetch(`${base}${path.replace(/sig=[^&]+/, "sig=forged")}`)).status, 404);
    assert.strictEqual((await call("GET", `/api/admin/comms/messages/${r.body.message.id}/media/0`, agent)).status, 200);
    assert.strictEqual((await call("GET", `/api/admin/comms/messages/${r.body.message.id}/media/0`, fixter)).status, 403);
    const reuse = await call("POST", "/api/admin/comms/send", agent, { userId: String(cam._id), lineNumber: LINE, body: "Again", mediaIds: [upBody.id], idempotencyKey: key(), quietHoursAck: true });
    assert.strictEqual(reuse.body.code, "BAD_MEDIA", "an upload is sent once");
  });
  await check("inbound calls to the Twilio number are logged in the caller's thread (metadata only) and still hear the announcement", async () => {
    const url = "https://api.test.profixter/api/voice/webhook/inbound";
    const params = { CallSid: "CAtest01", From: "+16315550101", To: LINE, CallStatus: "ringing" };
    const r = await realFetch(`${base}/api/voice/webhook/inbound`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signTwilio(url, params) }, body: new URLSearchParams(params).toString() });
    assert.match(await r.text(), /<Say/);
    await settle();
    const m = await CommMessage.findOne({ providerId: "CAtest01" }).lean();
    assert.deepStrictEqual([m.channel, m.metadataOnly, String(m.user)], ["call", true, String(ana._id)]);
  });

  server.close();
  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
