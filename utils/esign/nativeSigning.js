/**
 * ProFixter native signing engine.
 *
 * Replaces the provider-dependent signing ceremony. The document system around
 * it - numbering, revisioning, snapshots, private storage, audit history - is
 * unchanged; only the act of signing moved in-house.
 *
 * Three properties this module exists to guarantee:
 *
 *   1. WHAT WAS SIGNED IS PROVABLE. The document is frozen and hashed when the
 *      request is created. Nothing regenerates it afterwards, so a later draft
 *      edit cannot retroactively change what a signer agreed to.
 *
 *   2. A LINK CANNOT BE GUESSED, AND A LEAK OF THE DATABASE DOES NOT PRODUCE
 *      ONE. Tokens are 256 bits of CSPRNG output; only their SHA-256 hash is
 *      stored, and lookup is by hash.
 *
 *   3. A REQUEST EXECUTES AT MOST ONCE. Completion is a single conditional
 *      update, so a double-tap, a retry, or two racing tabs cannot produce two
 *      executed documents.
 *
 * The server is authoritative throughout. Nothing the browser sends about
 * price, version, identity, timestamps or hashes is trusted or even read.
 */

const crypto = require("crypto");

const ESignature = require("../../models/ESignature");
const { DISCLOSURE_VERSION } = require("../../config/electronicSignatureDisclosure");

/** How long a remote signing link stays usable unless configured otherwise. */
const DEFAULT_EXPIRY_DAYS = Number(process.env.ESIGN_LINK_EXPIRY_DAYS || 30);

/**
 * In-person sessions are created by an authenticated admin standing next to the
 * customer, so they are deliberately short-lived.
 */
const IN_PERSON_EXPIRY_MINUTES = Number(process.env.ESIGN_IN_PERSON_EXPIRY_MINUTES || 60);

/** Audit event names. Append-only; never renamed once written to records. */
const AUDIT = Object.freeze({
  CREATED: "SIGNATURE_REQUEST_CREATED",
  EMAIL_SENT: "SIGNATURE_EMAIL_SENT",
  LINK_OPENED: "SIGNATURE_LINK_OPENED",
  CONSENT: "ELECTRONIC_CONSENT_ACCEPTED",
  SUBMITTED: "SIGNATURE_SUBMITTED",
  EXECUTED: "DOCUMENT_EXECUTED",
  DECLINED: "SIGNATURE_DECLINED",
  REVOKED: "SIGNATURE_REQUEST_REVOKED",
  EXPIRED: "SIGNATURE_REQUEST_EXPIRED",
  MANUAL_UPLOAD: "SIGNED_DOCUMENT_MANUALLY_UPLOADED",
});

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

/**
 * A fresh signing token.
 *
 * 32 bytes of CSPRNG output - the same strength as a session key. base64url so
 * it survives a URL, an email client and a copy-paste without escaping.
 * Returned once, to the caller, and never stored in this form.
 */
function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

/** Deterministic lookup key. The raw token is never written to the database. */
function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

/**
 * Compare a token hash without leaking timing information.
 * Lookup is by indexed hash, so this guards the final equality check only.
 */
function tokenHashesMatch(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length || !left.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** SHA-256 over exact bytes. The integrity primitive for every artifact. */
function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Token state                                                         */
/* ------------------------------------------------------------------ */

/**
 * Why a token cannot be used, or null when it can.
 * Expiry is evaluated against the server clock only.
 */
function tokenRejectionReason(signature, now = new Date()) {
  const token = signature?.signingToken;
  if (!token?.hash) return "not_found";

  switch (token.state) {
    case "completed":
      return "completed";
    case "declined":
      return "declined";
    case "revoked":
      return "revoked";
    case "expired":
      return "expired";
    default:
      break;
  }

  if (token.expiresAt && token.expiresAt.getTime() <= now.getTime()) return "expired";
  if (signature.isTerminal()) return "completed";
  return null;
}

function expiryFromNow(days = DEFAULT_EXPIRY_DAYS) {
  return new Date(Date.now() + Math.max(1, days) * 24 * 60 * 60 * 1000);
}

function inPersonExpiry(minutes = IN_PERSON_EXPIRY_MINUTES) {
  return new Date(Date.now() + Math.max(5, minutes) * 60 * 1000);
}

/* ------------------------------------------------------------------ */
/* Lookup                                                              */
/* ------------------------------------------------------------------ */

/**
 * Find a signature request by raw token.
 *
 * Returns { signature, reason }. A wrong token and a revoked token are
 * deliberately indistinguishable to the caller's error path, so the endpoint
 * cannot be used to probe which tokens exist.
 */
async function findByToken(rawToken) {
  const token = String(rawToken || "");
  // Cheap shape check first: avoids a database round trip on obvious junk.
  if (!token || token.length < 40 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return { signature: null, reason: "not_found" };
  }

  const hash = hashToken(token);
  const signature = await ESignature.findOne({ "signingToken.hash": hash });
  if (!signature || !tokenHashesMatch(signature.signingToken?.hash, hash)) {
    return { signature: null, reason: "not_found" };
  }

  return { signature, reason: tokenRejectionReason(signature) };
}

/* ------------------------------------------------------------------ */
/* Completion                                                          */
/* ------------------------------------------------------------------ */

/**
 * Claim the exclusive right to complete this request.
 *
 * The whole single-use guarantee rests here: the update matches only while the
 * token is still `active`, so among any number of concurrent submissions
 * exactly one observes a document and the rest get null. Callers must treat
 * null as "already handled", not as an error.
 */
async function claimForCompletion(signatureId) {
  return ESignature.findOneAndUpdate(
    {
      _id: signatureId,
      "signingToken.state": "active",
      status: { $nin: ["Completed", "Declined", "Cancelled", "Expired"] },
    },
    { $set: { "signingToken.state": "completed" } },
    { new: true }
  );
}

/** Same atomicity for a decline: a declined request cannot later be signed. */
async function claimForDecline(signatureId) {
  return ESignature.findOneAndUpdate(
    {
      _id: signatureId,
      "signingToken.state": "active",
      status: { $nin: ["Completed", "Declined", "Cancelled", "Expired"] },
    },
    { $set: { "signingToken.state": "declined" } },
    { new: true }
  );
}

/** Release a claim when completion failed, so the customer can retry. */
async function releaseClaim(signatureId) {
  return ESignature.findOneAndUpdate(
    { _id: signatureId, "signingToken.state": "completed", status: { $ne: "Completed" } },
    { $set: { "signingToken.state": "active" } },
    { new: true }
  );
}

/* ------------------------------------------------------------------ */
/* Signature payload                                                   */
/* ------------------------------------------------------------------ */

/** Upper bound on an accepted signature image. Generous for a drawn signature. */
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

/**
 * Validate and decode a submitted signature image.
 *
 * Accepts only a PNG data URL: a drawn signature has no reason to be anything
 * else, and narrowing the surface keeps arbitrary bytes out of the PDF
 * pipeline. Returns { buffer } or { error }.
 */
function decodeSignatureImage(dataUrl) {
  const value = String(dataUrl || "");
  const match = value.match(/^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return { error: "A drawn signature is required." };

  let buffer;
  try {
    buffer = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  } catch {
    return { error: "The signature could not be read." };
  }

  if (!buffer.length) return { error: "A drawn signature is required." };
  if (buffer.length > MAX_SIGNATURE_BYTES) return { error: "The signature image is too large." };

  // PNG magic number: reject anything mislabelled.
  const isPng =
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
  if (!isPng) return { error: "The signature could not be read." };

  // A blank pad still produces a valid PNG; a real signature has substance.
  if (buffer.length < 512) return { error: "Please draw your signature before submitting." };

  return { buffer };
}

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */

/**
 * Request evidence worth retaining.
 *
 * Supporting evidence only - an IP address does not establish identity, and
 * nothing here is treated as proof of who signed. No fingerprinting.
 */
function requestEvidence(req) {
  const forwarded = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return {
    ip: (forwarded || req?.ip || req?.socket?.remoteAddress || "").slice(0, 64),
    userAgent: String(req?.headers?.["user-agent"] || "").slice(0, 400),
  };
}

module.exports = {
  AUDIT,
  DEFAULT_EXPIRY_DAYS,
  IN_PERSON_EXPIRY_MINUTES,
  MAX_SIGNATURE_BYTES,
  DISCLOSURE_VERSION,
  generateToken,
  hashToken,
  tokenHashesMatch,
  sha256,
  tokenRejectionReason,
  expiryFromNow,
  inPersonExpiry,
  findByToken,
  claimForCompletion,
  claimForDecline,
  releaseClaim,
  decodeSignatureImage,
  requestEvidence,
};
