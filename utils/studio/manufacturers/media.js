/**
 * Manufacturer media links: checking that they still work, and - only after
 * the owner has confirmed the manufacturer's image rights - copying an image
 * into Profixter's private storage so the Studio can show it.
 *
 * The server only ever contacts the manufacturer's own hosts (the adapter's
 * `mediaHosts`), over HTTPS, without following redirects elsewhere. Nothing
 * fetched is passed back to the browser except a status.
 */
const crypto = require("crypto");
const StudioSupplierItem = require("../../../models/studio/StudioSupplierItem");
const StudioMediaCheck = require("../../../models/studio/StudioMediaCheck");
const StudioManufacturer = require("../../../models/studio/StudioManufacturer");
const StudioAsset = require("../../../models/studio/StudioAsset");
const storage = require("../storage");
const { adapterFor } = require("./index");

const CHECK_KINDS = ["photo", "drawing", "installGuide", "cad", "model3d"];
const TIMEOUT_MS = 12_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

let fetchImpl = (...a) => fetch(...a);
function setFetch(fn) { fetchImpl = fn; }

/** Is this URL one the server may contact for this manufacturer? */
function allowedUrl(adapter, raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const host = u.hostname.toLowerCase();
  if (!adapter.mediaHosts.includes(host)) return null;
  const prefixes = adapter.mediaPathPrefixes?.[host];
  if (prefixes && !prefixes.some((p) => u.pathname.startsWith(p))) return null;
  return u;
}

async function request(adapter, url, init, hops = 0) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(url.toString(), { ...init, redirect: "manual", signal: ctl.signal, headers: { "user-agent": "ProfixterCatalogCheck/1.0", ...(init.headers || {}) } });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location") && hops < 2) {
      const next = allowedUrl(adapter, new URL(r.headers.get("location"), url).toString());
      if (!next) return { status: r.status, response: r, offsite: true };
      return request(adapter, next, init, hops + 1);
    }
    return { status: r.status, response: r };
  } finally {
    clearTimeout(timer);
  }
}

/** Check one link: ok (2xx), broken (4xx/5xx or not allowed), unreachable (no answer). */
async function checkOne(adapter, raw) {
  const u = allowedUrl(adapter, raw);
  if (!u) return { status: "broken", error: "Not a link on the manufacturer's own site.", httpStatus: null };
  try {
    let r = await request(adapter, u, { method: "HEAD" });
    if ([403, 405, 501].includes(r.status)) {
      r = await request(adapter, u, { method: "GET", headers: { range: "bytes=0-0" } });
      try { await r.response.body?.cancel(); } catch { /* ignore */ }
    }
    if (r.offsite) return { status: "broken", httpStatus: r.status, error: "Redirects away from the manufacturer's site." };
    const ok = r.status >= 200 && r.status < 300;
    const len = Number(r.response.headers.get("content-length"));
    return { status: ok ? "ok" : "broken", httpStatus: r.status, contentType: String(r.response.headers.get("content-type") || "").slice(0, 100), bytes: Number.isFinite(len) ? len : null, error: ok ? "" : `HTTP ${r.status}` };
  } catch (e) {
    return { status: "unreachable", httpStatus: null, error: e.name === "AbortError" ? "Timed out" : String(e.cause?.code || e.message || "No answer").slice(0, 120) };
  }
}

/**
 * Check every image/document link of a manufacturer's catalog, a few at a
 * time, recording each result. One check runs at a time per manufacturer.
 */
async function runLinkCheck({ key, concurrency = 6, onlyKinds = CHECK_KINDS } = {}) {
  const adapter = adapterFor(key);
  if (!adapter) throw Object.assign(new Error("Unknown manufacturer."), { status: 404 });
  await StudioManufacturer.forKey(key);
  const stale = new Date(Date.now() - 2 * 3600 * 1000);
  const claimed = await StudioManufacturer.findOneAndUpdate(
    { key, $or: [{ "linkCheck.status": { $ne: "running" } }, { "linkCheck.startedAt": { $lt: stale } }] },
    { $set: { "linkCheck.status": "running", "linkCheck.startedAt": new Date(), "linkCheck.finishedAt": null, "linkCheck.checked": 0, "linkCheck.ok": 0, "linkCheck.broken": 0, "linkCheck.unreachable": 0 } },
    { new: true }
  );
  if (!claimed) throw Object.assign(new Error("A link check is already running."), { status: 409 });
  const rows = await StudioSupplierItem.aggregate([
    { $match: { manufacturer: key, availability: { $ne: "discontinued" } } },
    { $unwind: "$media" },
    { $match: { "media.kind": { $in: onlyKinds } } },
    { $group: { _id: "$media.url" } },
  ]);
  const urls = rows.map((r) => r._id);
  const tally = { checked: 0, ok: 0, broken: 0, unreachable: 0 };
  await StudioManufacturer.updateOne({ key }, { $set: { "linkCheck.total": urls.length } });
  try {
    let i = 0;
    const worker = async () => {
      while (i < urls.length) {
        const url = urls[i++];
        const r = await checkOne(adapter, url);
        tally.checked++;
        tally[r.status]++;
        await StudioMediaCheck.updateOne({ url }, { $set: { url, manufacturer: key, host: (() => { try { return new URL(url).hostname; } catch { return ""; } })(), ...r, checkedAt: new Date() } }, { upsert: true });
        if (tally.checked % 50 === 0) await StudioManufacturer.updateOne({ key }, { $set: { "linkCheck.checked": tally.checked, "linkCheck.ok": tally.ok, "linkCheck.broken": tally.broken, "linkCheck.unreachable": tally.unreachable } });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(12, concurrency)) }, worker));
    await StudioManufacturer.updateOne({ key }, { $set: { "linkCheck.status": "done", "linkCheck.finishedAt": new Date(), "linkCheck.checked": tally.checked, "linkCheck.ok": tally.ok, "linkCheck.broken": tally.broken, "linkCheck.unreachable": tally.unreachable } });
  } catch (e) {
    await StudioManufacturer.updateOne({ key }, { $set: { "linkCheck.status": "failed", "linkCheck.finishedAt": new Date() } });
    throw e;
  }
  return { total: urls.length, ...tally };
}

/** Link-check results for a set of URLs (url -> status). */
async function statusFor(urls) {
  const list = urls.length ? await StudioMediaCheck.find({ url: { $in: urls } }).select("url status httpStatus error checkedAt").lean() : [];
  return new Map(list.map((x) => [x.url, x]));
}

/**
 * Copy a manufacturer image into Profixter's private storage as a Studio
 * asset - only when the owner has confirmed image rights for this
 * manufacturer. Re-encoded (optimized JPEG, metadata removed). The same
 * source link is never stored twice.
 */
async function copyManufacturerImage({ key, url, kind = "photo", actorId = null }) {
  const adapter = adapterFor(key);
  if (!adapter) throw Object.assign(new Error("Unknown manufacturer."), { status: 404 });
  const mfr = await StudioManufacturer.forKey(key);
  if (mfr.imageRights?.status !== "approved") throw Object.assign(new Error(`${adapter.name} image rights are not confirmed. Record your permission in Manufacturers → ${adapter.name} first, or upload images you are licensed to use.`), { status: 403 });
  const u = allowedUrl(adapter, url);
  if (!u) throw Object.assign(new Error("That link is not on the manufacturer's own site."), { status: 400 });
  const existing = await StudioAsset.findOne({ "source.url": u.toString() });
  if (existing) return { asset: existing, reused: true };
  const r = await request(adapter, u, { method: "GET" });
  if (r.offsite || r.status < 200 || r.status >= 300) throw Object.assign(new Error(`The manufacturer's server answered ${r.status}.`), { status: 502 });
  const declared = Number(r.response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw Object.assign(new Error("The image is larger than 25 MB."), { status: 400 });
  const chunks = [];
  let total = 0;
  for await (const c of r.response.body) {
    total += c.length;
    if (total > MAX_IMAGE_BYTES) throw Object.assign(new Error("The image is larger than 25 MB."), { status: 400 });
    chunks.push(Buffer.from(c));
  }
  const { sanitizeImageBuffer } = require("../../imageSanitizer");
  let clean;
  try { clean = await sanitizeImageBuffer(Buffer.concat(chunks)); } catch (e) { throw Object.assign(new Error(`Not a usable image: ${e.message}`), { status: 400 }); }
  const meta = await require("sharp")(clean.buffer).metadata();
  const sha = crypto.createHash("sha256").update(clean.buffer).digest("hex");
  const same = await StudioAsset.findOne({ sha256: sha, kind });
  if (same) return { asset: same, reused: true };
  const storageKey = storage.newKey("catalog");
  await storage.put(storageKey, clean.buffer, "image/jpeg");
  const { randomId } = require("../signedLinks");
  const asset = await StudioAsset.create({
    publicId: randomId(18), kind, storageKey, contentType: "image/jpeg", bytes: clean.buffer.length, width: meta.width, height: meta.height, sha256: sha,
    originalName: u.pathname.split("/").pop().slice(0, 200), source: { manufacturer: key, url: u.toString() }, createdBy: actorId,
  });
  return { asset, reused: false };
}

module.exports = { runLinkCheck, checkOne, statusFor, copyManufacturerImage, allowedUrl, setFetch, CHECK_KINDS };
