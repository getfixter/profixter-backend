/**
 * Adobe Acrobat Sign webhook endpoint.
 *
 * Adobe's verification contract (per current Acrobat Sign webhook docs):
 *  - On registration it sends GET with header `X-AdobeSign-ClientId`.
 *  - On every notification it sends POST with the same header.
 *  - In BOTH cases the endpoint must return 2XX AND echo the client id, either
 *    in an `X-AdobeSign-ClientId` response header or as `xAdobeSignClientId`
 *    in a JSON body.
 *  - If the client id is not recognised, we must NOT return success.
 *
 * That header check is the authentication mechanism Adobe provides, so it is
 * enforced on both verbs. Processing is idempotent on the provider event id.
 */

const express = require("express");
const router = express.Router();

const ESignature = require("../models/ESignature");
const adobe = require("../utils/esign/adobeSignClient");
const signatureService = require("../utils/esign/signatureService");

const CLIENT_ID_HEADER = "x-adobesign-clientid";

/** Constant-time-ish comparison to avoid leaking the id via timing. */
function safeEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

/**
 * The value Adobe echoes in X-AdobeSign-ClientId.
 *
 * With an OAuth application this is the application's client id. With an
 * integration key, or a webhook created from the Acrobat Sign web UI, it is
 * whatever id that webhook was registered under - so it is configurable
 * separately rather than assumed to equal the OAuth client id.
 */
function expectedClientId() {
  return String(
    process.env.ADOBE_SIGN_WEBHOOK_CLIENT_ID || process.env.ADOBE_SIGN_CLIENT_ID || ""
  ).trim();
}

/**
 * Verify and echo. Returns the client id when valid, or null after having
 * already sent a rejection response.
 */
function verifyAndEcho(req, res) {
  const provided = req.get(CLIENT_ID_HEADER);
  const expected = expectedClientId();

  if (!expected) {
    // Refusing rather than accepting blindly: an unconfigured endpoint must
    // never appear healthy to Adobe.
    console.error(
      "esign webhook: no expected client id configured (set ADOBE_SIGN_WEBHOOK_CLIENT_ID)"
    );
    res.status(503).json({ message: "Webhook not configured" });
    return null;
  }

  if (!safeEqual(provided, expected)) {
    // No detail in the response: do not confirm or deny what the real id is.
    res.status(401).json({ message: "Unauthorized" });
    return null;
  }

  res.set("X-AdobeSign-ClientId", expected);
  return expected;
}

/**
 * Pull the pieces we need out of an Acrobat Sign notification, tolerating the
 * variation between conditional-parameter configurations.
 */
function parseNotification(body) {
  const agreement = body?.agreement || {};
  const participants = [];

  const sets = agreement?.participantSetsInfo || agreement?.participantSets || [];
  for (const set of Array.isArray(sets) ? sets : []) {
    for (const member of set?.memberInfos || []) {
      participants.push({
        email: member?.email,
        status: set?.status || member?.status || "",
        signedAt: member?.completedDate ? new Date(member.completedDate) : null,
        viewedAt: member?.lastViewedDate ? new Date(member.lastViewedDate) : null,
      });
    }
  }

  const occurredRaw = body?.event?.date || body?.eventDate || body?.event_date;

  return {
    providerEventId: String(body?.webhookNotificationId || body?.event?.id || "").trim(),
    eventType: String(body?.event || body?.eventType || "").trim(),
    agreementId: String(agreement?.id || body?.agreementId || "").trim(),
    providerStatus: String(agreement?.status || "").trim(),
    participants,
    declineReason:
      agreement?.agreementRejectionInfo?.rejectionReason ||
      body?.participantUser?.rejectionReason ||
      "",
    occurredAt: occurredRaw ? new Date(occurredRaw) : new Date(),
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/** Registration/verification probe. */
router.get("/adobe-sign", (req, res) => {
  const clientId = verifyAndEcho(req, res);
  if (!clientId) return null;
  return res.status(200).json({ xAdobeSignClientId: clientId });
});

/** Notification delivery. */
router.post("/adobe-sign", async (req, res) => {
  const clientId = verifyAndEcho(req, res);
  if (!clientId) return null;

  // Adobe also probes the POST endpoint during registration with an empty body.
  if (!req.body || !Object.keys(req.body).length) {
    return res.status(200).json({ xAdobeSignClientId: clientId });
  }

  const parsed = parseNotification(req.body);
  const normalizedEvent = adobe.mapWebhookEvent(parsed.eventType);

  // Acknowledge before doing slow work: Adobe retries on non-2XX, and the
  // event is already durable in our records by the time we return.
  const ack = () => res.status(200).json({ xAdobeSignClientId: clientId });

  try {
    if (!parsed.agreementId) {
      console.warn("esign webhook: notification without agreement id", {
        eventType: parsed.eventType,
      });
      return ack();
    }

    const signature = await ESignature.findOne({
      providerAgreementId: parsed.agreementId,
    });

    if (!signature) {
      // Not ours - an agreement created outside ProFixter. Acknowledge so
      // Adobe stops retrying, but change nothing.
      console.warn("esign webhook: no matching signature record", {
        agreementId: parsed.agreementId,
        eventType: parsed.eventType,
      });
      return ack();
    }

    // Fall back to the agreement id plus event type when Adobe omits a
    // notification id, so idempotency still holds.
    const providerEventId =
      parsed.providerEventId ||
      `${parsed.agreementId}:${parsed.eventType}:${parsed.occurredAt.toISOString()}`;

    const result = await signatureService.applyEvent({
      signature,
      providerEventId,
      eventType: parsed.eventType,
      normalizedEvent,
      providerStatus: parsed.providerStatus,
      participants: parsed.participants,
      declineReason: parsed.declineReason,
      occurredAt: parsed.occurredAt,
    });

    if (result.duplicated) return ack();

    await signatureService.syncDocumentStatus(signature);

    // Respond first, then fetch the executed PDF. A retrieval failure must not
    // turn into a webhook retry - completion is already recorded, and the
    // backlog job will retry the download.
    ack();

    if (signature.status === "Completed") {
      try {
        await signatureService.retrieveExecutedDocuments(signature);
      } catch (error) {
        console.error("esign webhook: executed document retrieval failed", {
          signatureId: String(signature._id),
          message: error?.message,
        });
      }
    }
    return null;
  } catch (error) {
    console.error("esign webhook: processing failed", { message: error?.message });
    // 5xx so Adobe retries a genuinely unprocessed event.
    if (!res.headersSent) {
      return res.status(500).json({ message: "Webhook processing failed" });
    }
    return null;
  }
});

module.exports = router;
module.exports.parseNotification = parseNotification;
module.exports.safeEqual = safeEqual;
