/**
 * "A customer just signed (or declined) a document."
 *
 * Online payment already tells the owner (invoicePaymentNotification.js); a
 * signature is the other moment a renovation moves forward, and a decline is
 * the moment it needs a phone call. Both go to the owner inbox through the same
 * admin email shell, so one definition of where owner mail goes is kept.
 *
 * Sent once per signature: the caller sends it only after completion or decline
 * is durable, and the completion path is idempotent (a replay returns the
 * stored record without reaching this code a second time).
 */

const { ADMIN, REPLY_TO, FROM, sendRaw } = require("../emailService");
const adminSubjects = require("../adminSubjects");
const {
  formatSubmittedAt,
  renderAdminEventEmail,
  resolveLeadReplyTo,
} = require("../adminLeadNotification");
const { adminLink } = require("../operationalEmail");

function documentKind(signature) {
  return signature?.documentType === "CHANGE_ORDER" ? "Change Order" : "Agreement";
}

/** The email, as data. Pure so the contents can be asserted on without sending. */
function buildOwnerSigningNotification({ signature, target, outcome, reason = "" }) {
  const kind = documentKind(signature);
  const customerName = String(target?.customerName || signature?.signers?.[0]?.name || "").trim();
  const signed = outcome === "completed";
  const when = signed ? signature?.completedAt : signature?.declinedAt;

  const fields = [
    ["Customer", customerName || "Not available"],
    ["Customer email", String(target?.customerEmail || signature?.signers?.[0]?.email || "") || "Not available"],
    ["Document", target?.label || `${kind} ${signature?.documentNumber || ""}`.trim()],
    ["Property", String(target?.propertyAddress || "") || "Not available"],
    ["How", signature?.signingMode === "IN_PERSON" ? "Signed in person" : "Signed through the emailed link"],
    [signed ? "Signed at" : "Declined at", formatSubmittedAt(when || new Date())],
  ];
  if (!signed) {
    fields.splice(4, 1);
    fields.push(["Reason given", String(reason || "").trim() || "No reason given"]);
  }

  const event = signed ? `${kind} Signed` : `${kind.toUpperCase()} DECLINED`;
  const note = signed
    ? signature?.documentType === "CHANGE_ORDER"
      ? "The change order is executed and now counts toward the agreement value."
      : "Next step: send the deposit invoice from the project."
    : "Call the customer to find out what needs to change.";

  return {
    subject: adminSubjects.subject([event, customerName || "Customer"]),
    heading: signed ? `${kind} signed` : `${kind} declined`,
    who: customerName,
    fields,
    note,
    action: {
      label: "Open project",
      url: adminLink.project(signature?.projectId),
    },
  };
}

async function sendOwnerSigningNotification({ signature, target, outcome, reason = "" }) {
  const notification = buildOwnerSigningNotification({ signature, target, outcome, reason });
  const rendered = renderAdminEventEmail(notification);
  return sendRaw({
    to: ADMIN,
    from: FROM,
    replyTo: resolveLeadReplyTo(target?.customerEmail, REPLY_TO),
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    bccAdmin: false,
    logContext: {
      templateKey: outcome === "completed" ? "admin_document_signed" : "admin_document_declined",
      recipientEmail: ADMIN,
      customerName: target?.customerName || "",
      customerEmail: target?.customerEmail || "",
      emailType: "admin",
      source: "publicSigning",
    },
  });
}

module.exports = {
  buildOwnerSigningNotification,
  sendOwnerSigningNotification,
};
