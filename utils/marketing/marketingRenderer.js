const { API_BASE_URL, BUSINESS, routeUrl } = require("./marketingConfig");
const { audiencesOf, ctaFor } = require("./marketingLibrary");
const { createUnsubscribeToken } = require("../unsubscribeToken");

/**
 * The marketing shell.
 *
 * Richer than an operational notification, quieter than a newsletter. One
 * headline, a few short paragraphs, one call to action, and a footer that
 * carries the things the law and the reader both need: who sent this, where
 * they are, and how to stop receiving it.
 *
 * No remote images, so it survives image blocking. Squared corners, matching
 * the direction the site went. Most of these are read on a phone in a hallway,
 * next to the door that does not close properly.
 */

const COLORS = {
  ink: "#0B1628",
  body: "#3f4a5a",
  muted: "#6b7280",
  line: "#e3e8ef",
  panel: "#f6f8fc",
  accent: "#1d4ed8",
  page: "#eef2f6",
};

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function unsubscribeUrl(email) {
  return `${API_BASE_URL}/api/email/unsubscribe?token=${encodeURIComponent(
    createUnsubscribeToken(email)
  )}`;
}

/**
 * Render one marketing email.
 *
 * `paragraphs` and `bullets` are plain strings and are escaped here, so no
 * template can accidentally introduce markup, and a customer's own name or
 * address can never become HTML.
 */
function renderMarketingEmail(template, { name = "there", email, audience, vars = {} } = {}) {
  if (!email) throw new Error("Marketing email requires a recipient address");
  if (!BUSINESS.addressLine) {
    // A marketing email without a postal address is not lawful to send.
    throw new Error("BUSINESS.addressLine is required for marketing email");
  }

  const context = { name, ...vars };
  const resolve = (value) => (typeof value === "function" ? value(context) : value);

  /*
   * Lines are resolved individually, not just the array as a whole. Templates
   * mix plain strings with per-line functions for the greeting, and resolving
   * only the outer value left those functions to be stringified straight into
   * the email body.
   */
  const resolveList = (value) => (resolve(value) || []).map(resolve).filter(Boolean);

  const headline = resolve(template.headline);
  const paragraphs = resolveList(template.paragraphs);
  const bullets = resolveList(template.bullets);
  /*
   * The same home fix email goes to members, non members and people who
   * cancelled, and they must not all land on the same page. A member books
   * against their membership; everybody else books a single visit.
   */
  const cta = ctaFor(template, audience || audiencesOf(template)[0]);
  const ctaLabel = resolve(cta.label);
  const ctaUrl = routeUrl(cta.route);
  const closing = resolve(template.closing);
  const unsubUrl = unsubscribeUrl(email);
  const subject = resolve(template.subject);
  const preheader = resolve(template.preheader) || "";

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${COLORS.page};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COLORS.page};">
    <tr><td align="center" style="padding:20px 12px;">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0"
             style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${COLORS.line};border-radius:6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">

        <tr><td style="padding:18px 26px;border-bottom:1px solid ${COLORS.line};background:${COLORS.panel};">
          <div style="font-size:19px;font-weight:800;letter-spacing:-0.01em;color:${COLORS.ink};">ProFixter</div>
          <div style="margin-top:3px;font-size:12px;color:${COLORS.muted};">Long Island Home Maintenance</div>
        </td></tr>

        <tr><td style="padding:28px 26px 8px;">
          <h1 style="margin:0 0 16px;font-size:25px;line-height:32px;font-weight:800;letter-spacing:-0.02em;color:${COLORS.ink};">${escapeHtml(headline)}</h1>
          ${paragraphs
            .map(
              (p) =>
                `<p style="margin:0 0 14px;font-size:16px;line-height:25px;color:${COLORS.body};">${escapeHtml(p)}</p>`
            )
            .join("")}
          ${
            bullets.length
              ? `<ul style="margin:0 0 16px;padding-left:20px;">${bullets
                  .map(
                    (b) =>
                      `<li style="margin-bottom:7px;font-size:16px;line-height:24px;color:${COLORS.body};">${escapeHtml(b)}</li>`
                  )
                  .join("")}</ul>`
              : ""
          }
        </td></tr>

        <tr><td style="padding:6px 26px 26px;">
          <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:13px 22px;background:${COLORS.accent};border:1px solid ${COLORS.accent};border-radius:6px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;">${escapeHtml(ctaLabel)}</a>
          ${
            closing
              ? `<p style="margin:18px 0 0;font-size:15px;line-height:23px;color:${COLORS.body};">${escapeHtml(closing)}</p>`
              : ""
          }
        </td></tr>

        <tr><td style="padding:18px 26px;border-top:1px solid ${COLORS.line};background:${COLORS.panel};font-size:12px;line-height:19px;color:${COLORS.muted};">
          <div>${escapeHtml(BUSINESS.name)} &bull; ${escapeHtml(BUSINESS.addressLine)}</div>
          <div style="margin-top:4px;">Questions? Call ${escapeHtml(BUSINESS.phone)}.</div>
          <div style="margin-top:10px;">
            Don't want marketing emails from ProFixter?
            <a href="${escapeHtml(unsubUrl)}" style="color:${COLORS.accent};text-decoration:underline;">Unsubscribe</a>.
            You will still receive booking and account emails.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    headline,
    "",
    ...paragraphs,
    ...(bullets.length ? ["", ...bullets.map((b) => `- ${b}`)] : []),
    "",
    `${ctaLabel}: ${ctaUrl}`,
    closing ? `\n${closing}` : "",
    "",
    "---",
    `${BUSINESS.name} - ${BUSINESS.addressLine}`,
    `Questions? Call ${BUSINESS.phone}.`,
    `Unsubscribe from marketing email: ${unsubUrl}`,
    "You will still receive booking and account emails.",
  ]
    .filter((line) => line !== undefined && line !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { subject, preheader, html, text, unsubscribeUrl: unsubUrl, ctaUrl };
}

module.exports = { escapeHtml, renderMarketingEmail, unsubscribeUrl };
