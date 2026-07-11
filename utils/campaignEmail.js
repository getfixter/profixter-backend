const { createUnsubscribeToken } = require("./unsubscribeToken");
const { personalize, personalizeUrl } = require("./campaignMergeTags");
const { PUBLIC_CONTACT_EMAIL } = require("./publicContact");

const API_URL = String(process.env.PUBLIC_API_URL || process.env.API_URL || "").replace(/\/+$/, "");
const REPLY_TO = process.env.MAIL_REPLY_TO || PUBLIC_CONTACT_EMAIL;
const LOGO_URL =
  process.env.BRAND_LOGO_URL ||
  "https://profixter-assets.s3.us-east-1.amazonaws.com/mrfixter-logoBlackText.png";

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function bodyHtml(body, recipient) {
  return escapeHtml(personalize(body, recipient))
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 16px;">${paragraph.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function unsubscribeUrl(email) {
  if (!API_URL || !email) return "";
  return `${API_URL}/api/email/unsubscribe?token=${encodeURIComponent(
    createUnsubscribeToken(email)
  )}`;
}

function renderCampaignEmail({
  subject,
  body,
  ctaText,
  ctaUrl,
  recipient,
  metadata = null,
}) {
  const personalizedSubject = personalize(subject, recipient);
  const personalizedCtaText = personalize(ctaText, recipient);
  const personalizedCtaUrl = personalizeUrl(ctaUrl, recipient);
  const safeSubject = escapeHtml(personalizedSubject);
  const safeCtaUrl = /^https?:\/\/[^\s]+$/i.test(personalizedCtaUrl)
    ? personalizedCtaUrl
    : "";
  const safeCtaText = escapeHtml(personalizedCtaText || "Learn more");
  const unsubscribe = metadata ? "" : unsubscribeUrl(recipient.email);
  const metadataRows = metadata
    ? Object.entries(metadata)
        .filter(([label]) => label !== "notice")
        .map(
          ([label, value]) =>
            `<tr><td style="padding:4px 10px 4px 0;color:#64748b;">${escapeHtml(
              label
            )}</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(value)}</td></tr>`
        )
        .join("")
    : "";

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f4f6f8;color:#172033;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${safeSubject}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f4f6f8;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;">
<tr><td align="center" style="padding:24px;border-bottom:1px solid #e5e7eb;">
<img src="${escapeHtml(LOGO_URL)}" width="170" alt="Profixter" style="display:block;width:170px;max-width:70%;height:auto;border:0;">
</td></tr>
${metadata ? `<tr><td style="padding:18px 24px;background:#fff7ed;border-bottom:1px solid #fed7aa;font:14px/1.5 Arial,sans-serif;">
<div style="font-weight:700;color:#9a3412;margin-bottom:8px;">${escapeHtml(metadata.notice)}</div>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="font:13px/1.45 Arial,sans-serif;color:#172033;">${metadataRows}</table>
</td></tr>` : ""}
<tr><td style="padding:32px 28px 24px;font:16px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#172033;">
<h1 style="margin:0 0 18px;font-size:28px;line-height:1.2;letter-spacing:-0.4px;color:#111827;">${safeSubject}</h1>
${bodyHtml(body, recipient)}
${safeCtaUrl ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0 8px;"><tr><td bgcolor="#111827" style="border-radius:10px;"><a href="${escapeHtml(safeCtaUrl)}" style="display:inline-block;padding:13px 22px;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;">${safeCtaText}</a></td></tr></table>` : ""}
</td></tr>
<tr><td align="center" style="padding:20px 24px;background:#f8fafc;border-top:1px solid #e5e7eb;font:12px/1.55 Arial,sans-serif;color:#64748b;">
<div>Profixter · Long Island, New York</div>
<div style="margin-top:5px;">Questions? <a href="mailto:${escapeHtml(REPLY_TO)}" style="color:#334155;">${escapeHtml(REPLY_TO)}</a></div>
${unsubscribe ? `<div style="margin-top:10px;">You received this because you created a Profixter account. <a href="${escapeHtml(unsubscribe)}" style="color:#64748b;">Unsubscribe</a></div>` : ""}
<div style="margin-top:8px;">© ${new Date().getFullYear()} Profixter</div>
</td></tr>
</table></td></tr></table></body></html>`;

  const textMetadata = metadata
    ? `${metadata.notice}\n${Object.entries(metadata)
        .filter(([key]) => key !== "notice")
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n")}\n\n`
    : "";
  const text = `${textMetadata}${personalizedSubject}\n\n${personalize(
    body,
    recipient
  )}${safeCtaUrl ? `\n\n${personalizedCtaText || "Learn more"}: ${safeCtaUrl}` : ""}${
    unsubscribe ? `\n\nUnsubscribe: ${unsubscribe}` : ""
  }\n\nProfixter · Long Island, New York\n${REPLY_TO}`;

  return {
    subject: personalizedSubject,
    html,
    text,
    unsubscribeUrl: unsubscribe,
  };
}

module.exports = { renderCampaignEmail };
