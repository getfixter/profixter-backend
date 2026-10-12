/**
 * Private storage for Shower Studio files (customer photos, catalog images).
 *
 * Nothing here is ever written to the public `uploads/` prefix (the one the
 * booking photos use and the bucket policy exposes). Keys live under
 * `private/studio/`, the same private area as contracts and invoices, and are
 * random - they cannot be guessed or listed through the app.
 *
 * Drivers (STUDIO_STORAGE):
 *   s3     - private S3 objects through utils/s3.js (production; needs S3_BUCKET)
 *   local  - a private folder on disk (development; STUDIO_LOCAL_DIR)
 *   memory - in-process (tests)
 * Default: s3 when S3_BUCKET is set, otherwise local.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PREFIX = (process.env.STUDIO_S3_PREFIX || "private/studio").replace(/^\/+|\/+$/g, "");
if (!PREFIX.startsWith("private/")) throw new Error("STUDIO_S3_PREFIX must stay under private/");

function driverName() {
  return process.env.STUDIO_STORAGE || (process.env.S3_BUCKET ? "s3" : "local");
}

const memory = new Map();

function localDir() {
  return path.resolve(process.env.STUDIO_LOCAL_DIR || path.join(__dirname, "..", "..", ".studio-private"));
}

/** A fresh, unguessable key under the private prefix. */
function newKey(kind, ext = ".jpg") {
  const month = new Date().toISOString().slice(0, 7);
  return `${PREFIX}/${kind}/${month}/${crypto.randomBytes(24).toString("hex")}${ext}`;
}

function safeLocalPath(key) {
  if (!key.startsWith(`${PREFIX}/`) || key.includes("..") || /[\\:]/.test(key)) throw new Error("bad storage key");
  return path.join(localDir(), key);
}

async function put(key, buffer, contentType) {
  const d = driverName();
  if (d === "memory") { memory.set(key, { buffer: Buffer.from(buffer), contentType }); return; }
  if (d === "local") {
    const p = safeLocalPath(key);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, buffer, { mode: 0o600 });
    return;
  }
  const { putPrivateObject } = require("../s3");
  await putPrivateObject({ Key: key, Body: buffer, ContentType: contentType, CacheControl: "private, max-age=0, no-store" });
}

async function get(key) {
  const d = driverName();
  if (d === "memory") {
    const v = memory.get(key);
    if (!v) throw Object.assign(new Error("not found"), { status: 404 });
    return v.buffer;
  }
  if (d === "local") return fs.promises.readFile(safeLocalPath(key));
  const { getObjectBuffer } = require("../s3");
  return getObjectBuffer({ Key: key });
}

async function remove(key) {
  const d = driverName();
  if (d === "memory") { memory.delete(key); return; }
  if (d === "local") { await fs.promises.rm(safeLocalPath(key), { force: true }); return; }
  const { deletePublicObjects } = require("../s3"); // deletes any key; the name is historical
  await deletePublicObjects({ Keys: [key] });
}

module.exports = { put, get, remove, newKey, driverName, PREFIX, _memory: memory };
