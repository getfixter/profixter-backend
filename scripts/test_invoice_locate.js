/**
 * GET /api/admin/invoices/:id tells old Admin email links which project an
 * invoice belongs to - ids only - and only to people with projects.manage.
 *
 *   node scripts/test_invoice_locate.js
 */
Object.assign(process.env, {
  NODE_ENV: "test",
  S3_BUCKET: "test-bucket",
  AWS_REGION: "us-east-1",
  JWT_SECRET: "test-secret-invoice-locate",
  MAIL_ADMIN: "owner@example.com",
});

const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../models/User");
const Invoice = require("../models/Invoice");

const app = express();
app.use(express.json());
app.use("/api/admin/invoices", require("../routes/adminInvoices"));

let base;
const token = (u) => jwt.sign({ id: String(u._id), tv: 0 }, process.env.JWT_SECRET);
async function get(path, user) {
  const r = await fetch(`${base}${path}`, { headers: user ? { Authorization: `Bearer ${token(user)}` } : {} });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  let failed = 0;
  try {
    const owner = await User.create({ userId: "90000001", name: "Owner Person", email: "owner@example.com", role: "admin" });
    const fixter = await User.create({ userId: "90000002", name: "Fix Person", email: "fix@example.com", role: "employee", employeePosition: "Fixter" });
    const projectId = new mongoose.Types.ObjectId();
    const raw = await Invoice.collection.insertOne({ projectId, invoiceNumber: "INV-T-1", status: "Sent", payments: [], lineItems: [] });
    const id = String(raw.insertedId);

    const ok = await get(`/api/admin/invoices/${id}`, owner);
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ok.body).sort(), ["invoiceId", "invoiceNumber", "projectId", "status"]);
    assert.equal(ok.body.projectId, String(projectId));
    console.log("  PASS  owner gets the project id and nothing else");

    assert.equal((await get(`/api/admin/invoices/${id}`, fixter)).status, 403);
    assert.equal((await get(`/api/admin/invoices/${id}`)).status, 401);
    console.log("  PASS  a Fixter and an anonymous caller are refused");

    assert.equal((await get(`/api/admin/invoices/${new mongoose.Types.ObjectId()}`, owner)).status, 404);
    assert.equal((await get(`/api/admin/invoices/not-an-id`, owner)).status, 404);
    console.log("  PASS  unknown and malformed ids are 404");
  } catch (error) {
    failed = 1;
    console.log(`  FAIL  ${error.stack}`);
  } finally {
    server.close();
    await mongoose.disconnect();
    await mongod.stop();
  }
  console.log(failed ? "\n0 passed, 1 failed" : "\n3 passed, 0 failed");
  process.exit(failed);
})();
