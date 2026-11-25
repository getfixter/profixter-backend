const crypto = require("crypto");
const { CommMediaUpload } = require("../../models/Comms");
const s3 = require("../s3");

/**
 * Pictures in texts (MMS). Everything is stored PRIVATELY in S3; nothing is
 * ever put in a public bucket.
 *
 * OUTBOUND: an admin uploads an image; it is re-encoded as JPEG (which also
 * strips location and camera metadata) and stored privately. Twilio must
 * fetch it to deliver the MMS, so the send passes Twilio a backend URL
 * carrying an HMAC signature that expires after two hours. That URL serves
 * this one image and nothing else.
 *
 * INBOUND: Twilio's copy is downloaded with our credentials and stored
 * privately. Admin sees it only through an authenticated, permission-checked
 * endpoint (routes/adminComms.js), never through a direct S3 or Twilio link.
 */
const MAX_INPUT_BYTES = 15 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4.5 * 1024 * 1024; // under Twilio's 5 MB image limit
const ACCEPTED = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif"]);
const SIGNED_TTL_MS = 2 * 60 * 60 * 1000;

const secret = () => `${process.env.JWT_SECRET || ""}:comms-media`;
const sign = (id, exp) => crypto.createHmac("sha256", secret()).update(`${id}.${exp}`).digest("base64url");

function publicApiBase() {
  return String(process.env.PUBLIC_API_URL || process.env.PUBLIC_API_BASE_URL || "").replace(/\/+$/, "");
}

/** The signed URL Twilio fetches an outbound image from. */
function signedMediaUrl(uploadId, now = Date.now()) {
  const exp = now + SIGNED_TTL_MS;
  return `${publicApiBase()}/api/comms/media/${uploadId}?exp=${exp}&sig=${sign(String(uploadId), exp)}`;
}

function verifySignedMedia(id, exp, sig, now = Date.now()) {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < now || e > now + SIGNED_TTL_MS + 60000) return false;
  const expected = Buffer.from(sign(String(id), e));
  const given = Buffer.from(String(sig || ""));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

async function normalizeImage(buffer) {
  const sharp = require("sharp");
  let quality = 82;
  let width = 1600;
  for (let i = 0; i < 4; i++) {
    const out = await sharp(buffer, { failOn: "none" }).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality }).toBuffer();
    if (out.length <= MAX_OUTPUT_BYTES) return out;
    quality -= 12;
    width = Math.round(width * 0.8);
  }
  throw Object.assign(new Error("This picture is too large to text."), { status: 413 });
}

/** Store an uploaded image for a future MMS. Returns the upload record. */
async function storeUpload({ buffer, contentType, name, user }) {
  if (!buffer?.length) throw Object.assign(new Error("No file received."), { status: 400 });
  if (buffer.length > MAX_INPUT_BYTES) throw Object.assign(new Error("Pictures must be under 15 MB."), { status: 413 });
  if (!ACCEPTED.has(String(contentType || "").toLowerCase())) throw Object.assign(new Error("Only pictures (JPEG, PNG, GIF, WebP, HEIC) can be texted."), { status: 415 });
  const jpeg = await normalizeImage(buffer);
  const key = `comms/outbound/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.jpg`;
  await s3.putPrivateObject({ Key: key, Body: jpeg, ContentType: "image/jpeg" });
  return CommMediaUpload.create({ key, contentType: "image/jpeg", size: jpeg.length, name: String(name || "picture").slice(0, 120), uploadedBy: user._id });
}

/** Copy an inbound MMS attachment into private storage. */
async function storeInbound({ buffer, contentType, sid, index }) {
  const ext = /png/.test(contentType) ? "png" : /gif/.test(contentType) ? "gif" : /jpe?g/.test(contentType) ? "jpg" : "bin";
  const key = `comms/inbound/${new Date().toISOString().slice(0, 10)}/${sid}-${index}.${ext}`;
  await s3.putPrivateObject({ Key: key, Body: buffer, ContentType: contentType });
  return { key, contentType, size: buffer.length, name: `picture-${index + 1}.${ext}` };
}

const readObject = (key) => s3.getObjectBuffer({ Key: key });

module.exports = { ACCEPTED, MAX_OUTPUT_BYTES, publicApiBase, readObject, signedMediaUrl, storeInbound, storeUpload, verifySignedMedia };
