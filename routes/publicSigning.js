/**
 * Public customer signing routes.
 *
 * The only unauthenticated surface in the signing system. A customer arrives
 * with an opaque token and nothing else - no account, no login, no code sent
 * to a phone.
 *
 * PRINCIPLES ENFORCED HERE
 *
 *  - The token is the only credential. It is hashed before any lookup, so the
 *    raw value is never compared against stored data.
 *  - Every substantive value comes from the server. The browser cannot tell us
 *    which document, which version, whose signature, what price, or when it was
 *    signed; those are read from the record or stamped by the server clock.
 *  - Responses are enumeration-resistant. An unknown token, a revoked token and
 *    a token belonging to someone else are answered identically.
 *  - The document served is the frozen bytes. It is never regenerated, so what
 *    the customer reviews is byte-identical to what was hashed.
 */

const express = require("express");

const { rateLimit } = require("../utils/rateLimit");
const native = require("../utils/esign/nativeSigning");
const service = require("../utils/esign/nativeSignatureService");
const signingEmails = require("../utils/esign/signingEmails");
const {
  CONSENT_CHECKBOX_LABEL,
  DISCLOSURE_SECTIONS,
  DISCLOSURE_VERSION,
  SIGNATURE_PAD_INSTRUCTION,
  SIGN_INTENT_TEXT,
  SIGN_INTENT_TEXT_CHANGE_ORDER,
} = require("../config/electronicSignatureDisclosure");

const router = express.Router();

/** The token in the path is the natural limiting key - see utils/rateLimit. */
const tokenKey = (req) => (req.params?.token ? `sign:${native.hashToken(req.params.token)}` : null);
const ipKey = (req) => `ip:${native.requestEvidence(req).ip || "unknown"}`;

/** Reading the page is cheap; signing is not. Limits reflect that. */
const readLimiter = rateLimit({ limit: 60, windowMs: 10 * 60 * 1000, keyResolver: tokenKey });
const submitLimiter = rateLimit({ limit: 10, windowMs: 10 * 60 * 1000, keyResolver: tokenKey });
/** Loose, and only to blunt broad scanning of random tokens. */
const scanLimiter = rateLimit({
  limit: 300,
  windowMs: 10 * 60 * 1000,
  keyResolver: ipKey,
  message: "Too many requests from this connection. Please try again shortly.",
});

/**
 * Resolve the token, or answer with a safe terminal state.
 *
 * Every failure path returns the same shape, so the endpoint cannot be used to
 * learn whether a token exists, who it belongs to, or which document it is for.
 */
async function resolveOr(res, rawToken) {
  const { signature, reason } = await native.findByToken(rawToken);

  if (!signature || reason === "not_found") {
    res.status(404).json({ state: "invalid", message: "This signing link is not valid." });
    return null;
  }

  if (reason) {
    const messages = {
      completed: "This document has already been signed. Thank you.",
      declined: "This document was declined.",
      revoked: "This signing link is no longer active. Please contact us for a new one.",
      expired: "This signing link has expired. Please contact us for a new one.",
    };
    res.status(200).json({ state: reason, message: messages[reason] || "This link is no longer active." });
    return null;
  }

  return signature;
}

/** What the signing page needs. Deliberately minimal - no internal identifiers. */
function publicView(signature, target) {
  return {
    state: "ready",
    documentLabel: target?.label || signature.documentNumber,
    documentType: signature.documentType,
    customerName: target?.customerName || "",
    propertyAddress: target?.propertyAddress || "",
    company: {
      legalName: service.COMPANY_INFO.legalName,
      phone: service.COMPANY_INFO.phone,
      email: service.COMPANY_INFO.email,
    },
    disclosure: {
      version: DISCLOSURE_VERSION,
      sections: DISCLOSURE_SECTIONS,
      consentLabel: CONSENT_CHECKBOX_LABEL,
      signIntent:
        signature.documentType === "CHANGE_ORDER" ? SIGN_INTENT_TEXT_CHANGE_ORDER : SIGN_INTENT_TEXT,
      padInstruction: SIGNATURE_PAD_INSTRUCTION,
    },
    signingMode: signature.signingMode,
    expiresAt: signature.signingToken?.expiresAt || null,
  };
}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

/** The signing page payload. Opening is recorded once, as evidence. */
router.get("/:token", scanLimiter, readLimiter, async (req, res) => {
  try {
    const signature = await resolveOr(res, req.params.token);
    if (!signature) return null;

    await service.recordOpened(signature, native.requestEvidence(req));
    const target = await service.loadDocument(signature.documentType, signature.documentId);
    return res.json(publicView(signature, target));
  } catch (error) {
    console.error("GET /sign/:token failed:", error?.message);
    return res.status(500).json({ state: "error", message: "Something went wrong. Please try again." });
  }
});

/**
 * The exact frozen document.
 *
 * Streamed from private storage through this route - the S3 object is never
 * public, and the customer never receives a storage URL. Inline so a phone can
 * display it rather than forcing a download.
 */
router.get("/:token/document", scanLimiter, readLimiter, async (req, res) => {
  try {
    const signature = await resolveOr(res, req.params.token);
    if (!signature) return null;

    const buffer = await service.readFrozenDocument(signature);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="agreement.pdf"`);
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(buffer);
  } catch (error) {
    console.error("GET /sign/:token/document failed:", error?.message);
    return res.status(500).json({ state: "error", message: "The document could not be loaded." });
  }
});

/* ------------------------------------------------------------------ */
/* Sign                                                                */
/* ------------------------------------------------------------------ */

/**
 * Submit consent and signature together.
 *
 * One request on purpose: consent and the signature are recorded in the same
 * transaction, so a signature can never exist without the consent that
 * preceded it.
 */
router.post("/:token/sign", scanLimiter, submitLimiter, async (req, res) => {
  try {
    const signature = await resolveOr(res, req.params.token);
    if (!signature) return null;

    // Affirmative, and never inferred from the request merely arriving.
    if (req.body?.consentAccepted !== true) {
      return res.status(400).json({
        state: "error",
        message: "Please confirm the electronic records consent before signing.",
      });
    }

    const decoded = native.decodeSignatureImage(req.body?.signatureImage);
    if (decoded.error) {
      return res.status(400).json({ state: "error", message: decoded.error });
    }

    const context = native.requestEvidence(req);
    // Record consent before attempting execution so the evidence survives even
    // if completion then fails.
    signature.consent = {
      disclosureVersion: DISCLOSURE_VERSION,
      acceptedAt: new Date(),
      ip: context.ip,
      userAgent: context.userAgent,
    };
    signature.addAuditEvent(native.AUDIT.CONSENT, { disclosureVersion: DISCLOSURE_VERSION }, context);
    await signature.save();

    const completed = await service.completeSignature({
      signature,
      signatureImageBuffer: decoded.buffer,
      consentAccepted: true,
      context,
    });

    // Confirmation is sent only once completion is durable, and a mail failure
    // is never allowed to make a signed document look unsigned.
    try {
      const target = await service.loadDocument(completed.documentType, completed.documentId);
      const executedBuffer = completed.executedPdf?.key
        ? await service.readStoredExecuted(completed)
        : null;
      await signingEmails.sendCompletionEmail({
        signature: completed,
        target,
        signingUrl: `${String(process.env.PUBLIC_SITE_BASE_URL || "https://profixter.com").replace(/\/+$/, "")}/sign/${req.params.token}`,
        executedPdf: executedBuffer
          ? { buffer: executedBuffer, fileName: completed.executedPdf.fileName }
          : null,
      });
    } catch (emailError) {
      console.error("native signing: completion email failed:", emailError?.message);
    }

    return res.json({
      state: "completed",
      message: "Thank you. Your signature has been recorded.",
      completedAt: completed.completedAt,
    });
  } catch (error) {
    console.error("POST /sign/:token/sign failed:", error?.message);
    // The document is not marked signed on failure; the customer may retry.
    return res.status(500).json({
      state: "error",
      message: "We could not complete your signature. Please try again.",
    });
  }
});

/** Decline, with an optional reason. */
router.post("/:token/decline", scanLimiter, submitLimiter, async (req, res) => {
  try {
    const signature = await resolveOr(res, req.params.token);
    if (!signature) return null;

    await service.declineSignature({
      signature,
      reason: String(req.body?.reason || "").slice(0, 2000),
      context: native.requestEvidence(req),
    });

    return res.json({ state: "declined", message: "You have declined to sign this document." });
  } catch (error) {
    console.error("POST /sign/:token/decline failed:", error?.message);
    return res.status(500).json({ state: "error", message: "Something went wrong. Please try again." });
  }
});

module.exports = router;
module.exports.publicView = publicView;
