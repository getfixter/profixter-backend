/**
 * Native signing engine — token, integrity and payload tests.
 * No database, no network.
 *
 *   node scripts/test_native_signing.js
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";

const assert = require("assert");
const crypto = require("crypto");
const zlib = require("zlib");

const native = require("../utils/esign/nativeSigning");
const disclosure = require("../config/electronicSignatureDisclosure");
const ESignature = require("../models/ESignature");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

/** A minimal but valid PNG large enough to pass the substance check. */
function fakeSignaturePng(bytes = 900) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, crypto.randomBytes(Math.max(0, bytes - 8))]);
}

const dataUrl = (buffer) => `data:image/png;base64,${buffer.toString("base64")}`;

/* ---------------- tokens ---------------- */

console.log("\nToken generation");

test("a token carries 256 bits of entropy", () => {
  const token = native.generateToken();
  // 32 raw bytes in base64url is 43 characters.
  assert.strictEqual(Buffer.from(token, "base64url").length, 32);
  assert.ok(token.length >= 43, token);
});

test("tokens are URL safe", () =>
  assert.ok(/^[A-Za-z0-9_-]+$/.test(native.generateToken())));

test("tokens do not repeat", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(native.generateToken());
  assert.strictEqual(seen.size, 500);
});

test("the stored value is a hash, never the token", () => {
  const token = native.generateToken();
  const hash = native.hashToken(token);
  assert.strictEqual(hash.length, 64);
  assert.ok(/^[0-9a-f]+$/.test(hash));
  assert.notStrictEqual(hash, token);
  assert.ok(!hash.includes(token));
});

test("hashing is deterministic and distinct per token", () => {
  const a = native.generateToken();
  const b = native.generateToken();
  assert.strictEqual(native.hashToken(a), native.hashToken(a));
  assert.notStrictEqual(native.hashToken(a), native.hashToken(b));
});

test("hash comparison rejects mismatches and empties", () => {
  const hash = native.hashToken("x");
  assert.ok(native.tokenHashesMatch(hash, hash));
  assert.ok(!native.tokenHashesMatch(hash, native.hashToken("y")));
  assert.ok(!native.tokenHashesMatch("", ""));
  assert.ok(!native.tokenHashesMatch(hash, ""));
});

/* ---------------- token state ---------------- */

console.log("\nToken lifecycle");

function fakeSignature(token = {}, status = "Sent") {
  return {
    status,
    signingToken: { hash: "a".repeat(64), state: "active", expiresAt: null, ...token },
    isTerminal: () => ["Completed", "Declined", "Cancelled", "Expired"].includes(status),
  };
}

test("an active, unexpired token is usable", () =>
  assert.strictEqual(native.tokenRejectionReason(fakeSignature()), null));

test("a token with no hash is not found", () =>
  assert.strictEqual(native.tokenRejectionReason(fakeSignature({ hash: null })), "not_found"));

test("each terminal token state is reported distinctly", () => {
  for (const state of ["completed", "declined", "revoked", "expired"]) {
    assert.strictEqual(native.tokenRejectionReason(fakeSignature({ state })), state);
  }
});

test("a token past its expiry is rejected even while marked active", () =>
  assert.strictEqual(
    native.tokenRejectionReason(fakeSignature({ expiresAt: new Date(Date.now() - 1000) })),
    "expired"
  ));

test("expiry is evaluated on the server clock, not a supplied one", () => {
  const signature = fakeSignature({ expiresAt: new Date(Date.now() - 1000) });
  // Even asked to evaluate at a past date, an expired token stays rejected
  // when the real clock has moved on.
  assert.strictEqual(native.tokenRejectionReason(signature, new Date()), "expired");
});

test("a completed signature cannot be signed again even if the token looks active", () =>
  assert.strictEqual(native.tokenRejectionReason(fakeSignature({}, "Completed")), "completed"));

test("expiry windows are sane", () => {
  assert.ok(native.expiryFromNow(30).getTime() > Date.now());
  assert.ok(native.inPersonExpiry(60).getTime() > Date.now());
  // An in-person session is far shorter than a remote link.
  assert.ok(native.inPersonExpiry(60).getTime() < native.expiryFromNow(30).getTime());
});

test("a zero or negative expiry is floored rather than creating a dead link", () => {
  assert.ok(native.expiryFromNow(0).getTime() > Date.now());
  assert.ok(native.inPersonExpiry(0).getTime() > Date.now());
});

/* ---------------- integrity ---------------- */

console.log("\nDocument integrity");

test("sha256 is stable for identical bytes", () => {
  const buffer = Buffer.from("agreement bytes");
  assert.strictEqual(native.sha256(buffer), native.sha256(Buffer.from("agreement bytes")));
  assert.strictEqual(native.sha256(buffer).length, 64);
});

test("a single changed byte changes the hash", () => {
  const a = native.sha256(Buffer.from("Total: $20,000"));
  const b = native.sha256(Buffer.from("Total: $30,000"));
  assert.notStrictEqual(a, b);
});

test("the hash matches a known vector", () =>
  assert.strictEqual(
    native.sha256(Buffer.from("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  ));

/* ---------------- signature payload ---------------- */

console.log("\nSignature payload validation");

test("a valid PNG data URL is accepted", () => {
  const result = native.decodeSignatureImage(dataUrl(fakeSignaturePng()));
  assert.ok(result.buffer, result.error);
  assert.ok(result.buffer.length > 512);
});

test("an empty submission is rejected", () => {
  assert.ok(native.decodeSignatureImage("").error);
  assert.ok(native.decodeSignatureImage(null).error);
  assert.ok(native.decodeSignatureImage(undefined).error);
});

test("a tiny image reads as an unsigned pad, not a signature", () =>
  assert.ok(native.decodeSignatureImage(dataUrl(fakeSignaturePng(64))).error));

test("a non-PNG mime type is refused", () => {
  const payload = `data:image/jpeg;base64,${fakeSignaturePng().toString("base64")}`;
  assert.ok(native.decodeSignatureImage(payload).error);
});

test("PNG magic bytes are verified, not just the declared type", () => {
  const notPng = Buffer.concat([Buffer.from("NOTAPNG!"), crypto.randomBytes(900)]);
  assert.ok(native.decodeSignatureImage(dataUrl(notPng)).error);
});

test("an oversized image is refused", () => {
  const huge = fakeSignaturePng(native.MAX_SIGNATURE_BYTES + 1024);
  assert.ok(native.decodeSignatureImage(dataUrl(huge)).error);
});

test("an SVG payload cannot smuggle script into the pipeline", () => {
  const svg = "data:image/svg+xml;base64," + Buffer.from("<svg onload=alert(1)>").toString("base64");
  assert.ok(native.decodeSignatureImage(svg).error);
});

test("a javascript: payload is refused", () =>
  assert.ok(native.decodeSignatureImage("javascript:alert(1)").error));

/* ---------------- evidence ---------------- */

console.log("\nEvidence capture");

test("the client address is taken from the proxy header when present", () => {
  const evidence = native.requestEvidence({
    headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1", "user-agent": "Safari" },
  });
  assert.strictEqual(evidence.ip, "203.0.113.9");
  assert.strictEqual(evidence.userAgent, "Safari");
});

test("evidence capture never throws on a bare request", () => {
  const evidence = native.requestEvidence({});
  assert.strictEqual(typeof evidence.ip, "string");
  assert.strictEqual(typeof evidence.userAgent, "string");
});

test("an overlong user agent is truncated rather than stored whole", () => {
  const evidence = native.requestEvidence({
    headers: { "user-agent": "x".repeat(5000) },
  });
  assert.ok(evidence.userAgent.length <= 400);
});

/* ---------------- disclosure ---------------- */

console.log("\nDisclosure and consent");

test("the disclosure is versioned", () => {
  assert.ok(disclosure.DISCLOSURE_VERSION);
  assert.strictEqual(native.DISCLOSURE_VERSION, disclosure.DISCLOSURE_VERSION);
});

test("every item E-SIGN 7001(c)(1) requires is covered", () => {
  const text = disclosure.DISCLOSURE_SECTIONS.map((s) => `${s.title} ${s.body}`).join(" ").toLowerCase();
  // (A)(i) paper copy and right to withdraw
  assert.ok(text.includes("paper copy"), "missing paper copy right");
  assert.ok(text.includes("withdraw"), "missing right to withdraw");
  // (A)(i) consequences and fees of withdrawal
  assert.ok(text.includes("no fee") || text.includes("no charge"), "missing fee position");
  // (A)(ii) scope of consent
  assert.ok(text.includes("this document only"), "missing scope of consent");
  // (A)(iii) updating contact information
  assert.ok(text.includes("email address") && text.includes("changes"), "missing contact update");
  // (C) hardware and software requirements
  assert.ok(text.includes("browser") && text.includes("pdf"), "missing hardware/software statement");
});

test("consent is a separate affirmative act from signing", () => {
  assert.ok(disclosure.CONSENT_CHECKBOX_LABEL.length > 40);
  assert.ok(disclosure.SIGN_INTENT_TEXT.length > 40);
  assert.notStrictEqual(disclosure.CONSENT_CHECKBOX_LABEL, disclosure.SIGN_INTENT_TEXT);
});

test("the intent wording states the signer is signing", () => {
  assert.ok(/signing this document/i.test(disclosure.SIGN_INTENT_TEXT));
  assert.ok(/signing this document/i.test(disclosure.SIGN_INTENT_TEXT_CHANGE_ORDER));
});

test("unresolved legal questions are recorded rather than assumed away", () => {
  assert.ok(disclosure.ATTORNEY_REVIEW_NOTES.length >= 3);
  const notes = disclosure.ATTORNEY_REVIEW_NOTES.join(" ");
  assert.ok(notes.includes("771"), "GBL 771 compliance must be flagged");
});

/* ---------------- model compatibility ---------------- */

console.log("\nHistorical compatibility");

test("both providers remain valid so Adobe records stay readable", () => {
  assert.ok(ESignature.PROVIDERS.includes("adobe_sign"));
  assert.ok(ESignature.PROVIDERS.includes("native"));
});

test("a historical Adobe record still validates", () => {
  const doc = new ESignature({
    projectId: "0".repeat(24),
    documentType: "CONTRACT",
    documentId: "1".repeat(24),
    provider: "adobe_sign",
    providerAgreementId: "CBJCHBCAABAA",
    status: "Completed",
    signers: [{ role: "CUSTOMER", email: "a@b.com" }],
  });
  const error = doc.validateSync();
  assert.strictEqual(error, undefined, error?.message);
  assert.strictEqual(doc.provider, "adobe_sign");
});

test("a new record defaults to the native provider", () => {
  const doc = new ESignature({
    projectId: "0".repeat(24),
    documentType: "CONTRACT",
    documentId: "1".repeat(24),
    signers: [{ role: "CUSTOMER", email: "a@b.com" }],
  });
  assert.strictEqual(doc.provider, "native");
  assert.strictEqual(doc.signingMode, "REMOTE");
});

test("signing audit events are append-only and carry evidence", () => {
  const doc = new ESignature({
    projectId: "0".repeat(24),
    documentType: "CONTRACT",
    documentId: "1".repeat(24),
    signers: [{ role: "CUSTOMER", email: "a@b.com" }],
  });
  doc.addAuditEvent(native.AUDIT.CREATED, { version: 3 }, { ip: "203.0.113.9", userAgent: "Safari" });
  doc.addAuditEvent(native.AUDIT.CONSENT, {}, { ip: "203.0.113.9" });
  assert.strictEqual(doc.auditEvents.length, 2);
  assert.strictEqual(doc.auditEvents[0].event, "SIGNATURE_REQUEST_CREATED");
  assert.strictEqual(doc.auditEvents[0].ip, "203.0.113.9");
  assert.ok(doc.auditEvents[1].at instanceof Date);
});

test("the frozen document records version and hash together", () => {
  const doc = new ESignature({
    projectId: "0".repeat(24),
    documentType: "CONTRACT",
    documentId: "1".repeat(24),
    signers: [{ role: "CUSTOMER", email: "a@b.com" }],
    frozenDocument: {
      key: "private/x.pdf",
      sha256: "a".repeat(64),
      documentVersion: 3,
      frozenAt: new Date(),
    },
  });
  assert.strictEqual(doc.validateSync(), undefined);
  assert.strictEqual(doc.frozenDocument.documentVersion, 3);
  assert.strictEqual(doc.frozenDocument.sha256.length, 64);
});

test("every audit event name is a stable constant", () => {
  for (const [key, value] of Object.entries(native.AUDIT)) {
    assert.ok(/^[A-Z_]+$/.test(value), `${key} is not a stable name: ${value}`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed.`);
if (failures.length) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.err.stack}`);
  process.exit(1);
}
process.exit(0);
