/**
 * Supporting files for sales-credit requests. Stored PRIVATELY in S3 (never a
 * public URL) and served only through the authenticated routes, after the
 * caller's access to that request is checked: the employee who made it, or
 * the owner. The type is decided by the file's bytes, not by what the browser
 * claimed: PDF, PNG and JPEG only, up to 5 MB.
 */
const crypto = require("crypto");
const { SalesError } = require("./ledger");

const MAX_BYTES = 5 * 1024 * 1024;
const PREFIX = (process.env.S3_PRIVATE_PREFIX || "private").replace(/\/+$/, "");

function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  if (buf.slice(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  return null;
}

const s3 = () => require("../s3");

async function storeFile({ requestId, file }) {
  if (!file?.buffer?.length) throw new SalesError("EMPTY_FILE", "The file is empty.");
  if (file.buffer.length > MAX_BYTES) throw new SalesError("TOO_BIG", "Files can be up to 5 MB.");
  const type = sniff(file.buffer);
  if (!type) throw new SalesError("BAD_TYPE", "Upload a PDF, PNG or JPEG.");
  const key = `${PREFIX}/sales-evidence/${requestId}/${crypto.randomUUID()}.${type.ext}`;
  await s3().putPrivateObject({ Key: key, Body: file.buffer, ContentType: type.mime, ContentDisposition: "attachment" });
  const name = String(file.originalname || `evidence.${type.ext}`).replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  return { fileKey: key, fileName: name, mime: type.mime, size: file.buffer.length };
}

async function sendFile(res, request, fileId) {
  const item = (request.evidence || []).find((e) => String(e._id) === String(fileId) && e.kind === "file" && e.fileKey);
  if (!item) throw new SalesError("NOT_FOUND", "File not found.", 404);
  const body = await s3().getObjectBuffer({ Key: item.fileKey });
  res.setHeader("Content-Type", item.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${item.fileName.replace(/"/g, "")}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  res.send(body);
}

module.exports = { MAX_BYTES, sniff, storeFile, sendFile };
