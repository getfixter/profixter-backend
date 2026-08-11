/**
 * Native signing emails.
 *
 * Three messages, all through ProFixter's existing email infrastructure. No
 * provider branding anywhere - the customer is dealing with Premium Island
 * Homes, not with a signature vendor.
 *
 * Nothing here exposes a storage URL. The signing link carries an opaque token;
 * the completion message points back at the same link, which serves the
 * completed document through an authenticated application route rather than
 * handing out an S3 object.
 *
 * Sending is deliberately NOT part of the completion transaction. A mail
 * failure must never leave a signed document looking unsigned, so callers send
 * after completion is durable and treat failure as a logged non-fatal event.
 */

const { sendRaw } = require("../emailService");
const { COMPANY_INFO } = require("../../config/premiumIslandHomesContract");

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Documents are described to the customer in their own language. */
function documentLabel(signature, target) {
  if (target?.label) return target.label;
  return signature.documentType === "CHANGE_ORDER"
    ? `Change Order ${signature.documentNumber}`
    : `Home Improvement Agreement #${signature.documentNumber}`;
}

const isChangeOrder = (signature) => signature.documentType === "CHANGE_ORDER";

/** Shared shell so all three messages look like one company. */
function layout({ heading, bodyLines, ctaLabel, ctaUrl, footerNote }) {
  const paragraphs = bodyLines
    .map((line) => `<p style="margin:0 0 14px;line-height:1.6;color:#374151;">${line}</p>`)
    .join("");

  const cta = ctaUrl
    ? `<p style="margin:26px 0;">
         <a href="${escapeHtml(ctaUrl)}"
            style="background:#0f172a;color:#ffffff;text-decoration:none;padding:14px 26px;
                   border-radius:10px;font-weight:700;display:inline-block;">
           ${escapeHtml(ctaLabel)}
         </a>
       </p>
       <p style="margin:0 0 18px;font-size:12px;color:#6b7280;line-height:1.5;">
         If the button does not work, copy this link into your browser:<br>
         <span style="word-break:break-all;">${escapeHtml(ctaUrl)}</span>
       </p>`
    : "";

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
                      max-width:560px;margin:0 auto;padding:24px;">
    <p style="margin:0 0 4px;font-weight:800;font-size:17px;color:#0f172a;">
      ${escapeHtml(COMPANY_INFO.legalName)}
    </p>
    <p style="margin:0 0 22px;font-size:12px;color:#6b7280;">
      NY Home Improvement License ${escapeHtml(COMPANY_INFO.homeImprovementLicense)}
    </p>
    <h1 style="margin:0 0 16px;font-size:20px;color:#0f172a;">${escapeHtml(heading)}</h1>
    ${paragraphs}
    ${cta}
    ${footerNote ? `<p style="margin:0 0 18px;font-size:12px;color:#6b7280;line-height:1.5;">${footerNote}</p>` : ""}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
    <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.6;">
      Questions? Call ${escapeHtml(COMPANY_INFO.phone)} or reply to this email.<br>
      ${escapeHtml(COMPANY_INFO.legalName)} · ${escapeHtml(COMPANY_INFO.addressLines.join(", "))}
    </p>
  </div>`;
}

function textVersion(lines, ctaLabel, ctaUrl) {
  return [
    COMPANY_INFO.legalName,
    "",
    ...lines.map((line) => line.replace(/<[^>]+>/g, "")),
    ...(ctaUrl ? ["", `${ctaLabel}: ${ctaUrl}`] : []),
    "",
    `Questions? Call ${COMPANY_INFO.phone}.`,
  ].join("\n");
}

/* ------------------------------------------------------------------ */

/**
 * Ask the customer to sign.
 * Used for the first send and, unchanged, for a reminder - a resend must not
 * imply a new or different document.
 */
async function sendSignatureRequest({ signature, target, signingUrl, reminder = false }) {
  const label = documentLabel(signature, target);
  const recipient = (signature.signers || []).find((s) => s.role === "CUSTOMER")?.email;
  if (!recipient) throw new Error("No customer email on the signature request");

  const subject = reminder
    ? `Reminder: signature requested - ${label}`
    : `Signature requested: ${label}`;

  const bodyLines = [
    `Hello${target?.customerName ? ` ${escapeHtml(target.customerName)}` : ""},`,
    reminder
      ? `This is a reminder that <strong>${escapeHtml(label)}</strong> is waiting for your signature.`
      : `<strong>${escapeHtml(label)}</strong> is ready for your review and signature.`,
    ...(target?.propertyAddress
      ? [`Property: ${escapeHtml(target.propertyAddress)}`]
      : []),
    "You can read the full document, download a copy, and sign from your phone, tablet or computer. Nothing needs to be printed and you do not need an account.",
  ];

  const ctaLabel = isChangeOrder(signature) ? "Review & Sign Change Order" : "Review & Sign Agreement";
  const expires = signature.signingToken?.expiresAt
    ? `This link expires on ${new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(new Date(signature.signingToken.expiresAt))}.`
    : "";

  return sendRaw({
    to: recipient,
    subject,
    html: layout({ heading: label, bodyLines, ctaLabel, ctaUrl: signingUrl, footerNote: expires }),
    text: textVersion(bodyLines, ctaLabel, signingUrl),
    logContext: {
      templateKey: reminder ? "native_signature_reminder" : "native_signature_request",
      source: "nativeSigning",
      emailType: "transactional",
    },
  });
}

/**
 * Confirm completion.
 *
 * Sent only after completion is durable. The link is the same signing URL,
 * which now serves the completed document - no S3 URL is ever exposed.
 */
async function sendCompletionEmail({ signature, target, signingUrl, executedPdf = null }) {
  const label = documentLabel(signature, target);
  const recipient = (signature.signers || []).find((s) => s.role === "CUSTOMER")?.email;
  if (!recipient) throw new Error("No customer email on the signature request");

  const bodyLines = [
    `Hello${target?.customerName ? ` ${escapeHtml(target.customerName)}` : ""},`,
    `Thank you. <strong>${escapeHtml(label)}</strong> has been signed and is now complete.`,
    ...(target?.propertyAddress ? [`Property: ${escapeHtml(target.propertyAddress)}`] : []),
    "A copy is attached for your records. You can also open it any time using the link below.",
  ];

  return sendRaw({
    to: recipient,
    subject: isChangeOrder(signature)
      ? `Your signed ${label}`
      : `Your signed Home Improvement Agreement #${signature.documentNumber}`,
    html: layout({
      heading: "Signed and complete",
      bodyLines,
      ctaLabel: "View Signed Document",
      ctaUrl: signingUrl,
      footerNote: "Please keep this document for your records.",
    }),
    text: textVersion(bodyLines, "View Signed Document", signingUrl),
    ...(executedPdf
      ? {
          attachments: [
            {
              filename: executedPdf.fileName || `${signature.documentNumber}-signed.pdf`,
              content: executedPdf.buffer,
              contentType: "application/pdf",
            },
          ],
        }
      : {}),
    logContext: {
      templateKey: "native_signature_completed",
      source: "nativeSigning",
      emailType: "transactional",
    },
  });
}

module.exports = { sendSignatureRequest, sendCompletionEmail, documentLabel };
