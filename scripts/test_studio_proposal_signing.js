/**
 * Shower Studio -> existing proposal and signing workflow, end to end:
 *   staff design -> Studio proposal (Project + Estimate with the frozen price)
 *   -> contract draft from that estimate -> contract PDF -> native signature
 *   request -> the customer signs through the public signing route.
 *
 * Uses the REAL existing contract, signature and public-signing routers; only
 * S3, email and the admin activity log are replaced (in memory).
 *   node scripts/test_studio_proposal_signing.js
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "studio-test-secret";
process.env.MAIL_ADMIN = "owner@test.local";
process.env.STUDIO_STORAGE = "memory";
process.env.S3_BUCKET = "test-bucket";
process.env.ESIGN_ALLOW_UNSIGNED_COMPANY = "true";
process.env.PUBLIC_SITE_BASE_URL = "https://profixter.test";

const path = require("path");
const assert = require("assert");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");

const s3Store = new Map();
const emails = [];
function stub(rel, exports) {
  const resolved = require.resolve(path.join(__dirname, "..", rel));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub("utils/s3", {
  async putPrivateObject({ Key, Body }) { s3Store.set(Key, Buffer.from(Body)); return { Key }; },
  async getObjectBuffer({ Key }) { if (!s3Store.has(Key)) throw new Error(`missing ${Key}`); return s3Store.get(Key); },
  async putPublicObject() { throw new Error("nothing in this flow may write a public object"); },
  async deletePublicObjects() { return { deleted: 0 }; },
});
stub("utils/emailService", {
  async sendRaw(p) { emails.push(p); return { messageId: `m${emails.length}` }; },
  async sendTx(p) { emails.push(p); return { messageId: "tx" }; },
  async sendPromo() { return {}; },
});
stub("utils/adminActivityLog", { async createAdminActivityLog() { return null; }, async markAdminActivityLog() { return null; } });
stub("utils/adminLeadNotification", { async sendAdminLeadNotification() { return {}; } });

const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL  ${name}\n        ${e.stack.split("\n").slice(0, 3).join("\n        ")}`); }
}

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const User = require("../models/User");
  const StudioProduct = require("../models/studio/StudioProduct");
  const StudioPricing = require("../models/studio/StudioPricing");
  const Estimate = require("../models/Estimate");
  const Project = require("../models/Project");
  const ESignature = require("../models/ESignature");

  const app = express();
  app.use("/api/admin/studio", require("../routes/adminStudio"));
  app.use(express.json({ limit: "5mb" }));
  app.use("/api/admin/contracts", require("../routes/adminContracts"));
  app.use("/api/admin/signatures", require("../routes/adminSignatures"));
  app.use("/api/sign", require("../routes/publicSigning"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const owner = await User.create({ userId: "u-owner", name: "Owner", email: "owner@test.local", role: "admin" });
  const studioOnly = await User.create({ userId: "u-s", name: "Studio Only", email: "s@test.local", role: "employee", adminSections: ["studio"] });
  const tok = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
  async function call(method, url, { user = owner, body, form } = {}) {
    const h = { Authorization: `Bearer ${tok(user)}` };
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { h["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers: h, body: payload });
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, body: ct.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  }

  // a priced, published starter catalog
  const starter = require("../data/studio/starter-catalog.json");
  await StudioProduct.insertMany(starter.products.map((p) => ({ ...p, status: "published" })));
  const prices = { "slimline-6030": 89000, "qwall-vs-white": 120000, "delta-bt13210": 32000, "duet-6072": 95000 };
  for (const [sku, c] of Object.entries(prices)) await StudioProduct.updateOne({ sku }, { $set: { "pricing.priceCents": c } });
  const pricing = await StudioPricing.current();
  pricing.projectTypes.find((t) => t.key === "tub-to-shower").basePriceCents = 450000;
  pricing.adders.find((a) => a.key === "door-install").priceCents = 25000;
  await pricing.save();

  let designId, proposal;
  await test("staff design for a customer: photo, design, re-priced", async () => {
    const r = await call("POST", "/api/admin/studio/designs", { body: { customer: { name: "Hannah Home", email: "hannah@example.com", phone: "6315550100", address: "12 Elm St, Smithtown NY", zip: "11787" } } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    designId = r.body.design.id;
    const f = new FormData();
    f.append("photo", new Blob([await sharp({ create: { width: 681, height: 1023, channels: 3, background: "#d8c48a" } }).jpeg().toBuffer()], { type: "image/jpeg" }), "p.jpg");
    assert.strictEqual((await call("POST", `/api/admin/studio/designs/${designId}/photo`, { form: f })).status, 201);
    const state = {
      marks: { wallTL: [220, 160], wallTR: [444, 140], wallBL: [221, 703], wallBR: [412, 748] },
      points: { valve: [318, 628], head: [323, 163] },
      design: { measure: { facingWidth: 30, sideLength: 60, rimHeight: 15, leftWall: true, rightWall: false, aboveMode: "keep" }, baseId: "slimline-6030", drainId: "end", finishId: "qwall-vs-white", fixtureId: "delta-bt13210", enclosureId: "duet-6072", curtain: false, accessories: [] },
      masks: { remove: null, keep: null }, autoRemove: true,
    };
    const put = await call("PUT", `/api/admin/studio/designs/${designId}`, { body: { state } });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(put.body.design.priceSnapshot.totalCents, 450000 + 89000 + 120000 + 32000 + 95000 + 25000);
  });

  await test("creating a proposal needs Projects access", async () => {
    const r = await call("POST", `/api/admin/studio/designs/${designId}/proposal`, { user: studioOnly, body: {} });
    assert.strictEqual(r.status, 403);
  });

  await test("Studio proposal = a Bathroom Project + an Estimate reproducing the frozen price to the cent", async () => {
    const r = await call("POST", `/api/admin/studio/designs/${designId}/proposal`, { body: {} });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    proposal = r.body;
    const est = await Estimate.findById(proposal.estimateId).lean();
    const proj = await Project.findById(proposal.projectId).lean();
    assert.strictEqual(proj.projectType, "Bathroom");
    assert.strictEqual(proj.customerName, "Hannah Home");
    assert.strictEqual(est.total, 8110);
    assert.ok(est.lineItems.some((l) => /QWALL-VS White/.test(l.description)));
    assert.match(est.description, /Shower Studio/);
    const again = await call("POST", `/api/admin/studio/designs/${designId}/proposal`, { body: {} });
    assert.strictEqual(String(again.body.projectId), String(proposal.projectId), "a second proposal reuses the project");
  });

  let contractId;
  await test("the existing contract workflow drafts and generates a contract from the Studio estimate", async () => {
    const est = await Estimate.findById(proposal.estimateId).lean();
    const total = Math.round(est.total * 100);
    const deposit = Math.round(total * 0.3);
    const draft = await call("POST", `/api/admin/contracts/project/${proposal.projectId}/draft`, {
      body: {
        workType: "Bathroom", estimateId: proposal.estimateId, dates: { contractDate: new Date().toISOString().slice(0, 10) },
        projectDescription: est.title, scopeText: est.description,
        originalContractPriceCents: total, depositAmountCents: deposit,
        paymentSchedule: [{ label: "Deposit", amountCents: deposit, dueCondition: "At signing" }, { label: "Balance", amountCents: total - deposit, dueCondition: "On completion" }],
      },
    });
    assert.strictEqual(draft.status, 201, JSON.stringify(draft.body));
    contractId = draft.body.contract._id || draft.body.contract.id;
    const gen = await call("POST", `/api/admin/contracts/${contractId}/generate?projectId=${proposal.projectId}`, { body: { projectId: proposal.projectId } });
    assert.ok(gen.status === 200 || gen.status === 201, JSON.stringify(gen.body).slice(0, 300));
  });

  let signingToken;
  await test("native e-signature request for the contract (existing signing system)", async () => {
    const r = await call("POST", "/api/admin/signatures/native/send", { body: { documentType: "CONTRACT", documentId: contractId, mode: "REMOTE" } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body).slice(0, 300));
    signingToken = r.body.signingUrl.split("/sign/")[1];
    assert.ok(signingToken);
    assert.ok(emails.some((e) => /sign/i.test(e.subject || "")), "signature request email (stubbed)");
  });

  await test("the customer signs through the public signing link", async () => {
    const view = await fetch(`${base}/api/sign/${signingToken}`);
    assert.strictEqual(view.status, 200);
    const png = await sharp({ create: { width: 300, height: 100, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="300" height="100"><path d="M10 70 C 60 10, 120 90, 290 30" stroke="black" stroke-width="4" fill="none"/></svg>'), top: 0, left: 0 }]).png().toBuffer();
    const sign = await fetch(`${base}/api/sign/${signingToken}/sign`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consentAccepted: true, signatureImage: `data:image/png;base64,${png.toString("base64")}`, signerName: "Hannah Home", typedName: "Hannah Home" }),
    });
    const body = await sign.json();
    assert.strictEqual(sign.status, 200, JSON.stringify(body).slice(0, 300));
    const sig = await ESignature.findOne({}).lean();
    assert.strictEqual(sig.status, "Completed");
  });

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
