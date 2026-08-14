/**
 * The shell for operational email: what an Admin or a Fixter receives.
 *
 * These are notifications, not reports. Somebody glancing at a phone has about
 * five seconds to learn what happened, who it involves, the one number or time
 * that matters, and whether they need to act. Everything else belongs in the
 * dashboard, which is where it already is.
 *
 * That is why this is a different shell from the customer one rather than a
 * variant of it. A customer email is trying to reassure; this is trying to be
 * read in a notification shade and dismissed. Compact header, one event title,
 * the important value large, a short key/value list, one action, and stop.
 *
 * Deliberately: squared corners rather than pills, no emoji as structure, no
 * remote images, and nothing that needs CSS support to make sense.
 */

const ADMIN_BASE_URL =
  process.env.ADMIN_BASE_URL ||
  process.env.PUBLIC_SITE_BASE_URL ||
  "https://www.profixter.com";

const COLORS = {
  ink: "#111827",
  muted: "#6b7280",
  line: "#e5e7eb",
  panel: "#f8fafc",
  accent: "#1d4ed8",
  page: "#f1f5f9",
};

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Only same-site links become buttons.
 *
 * These emails carry deep links into Admin, and a link built from a value that
 * came from somewhere else is how a notification turns into a phishing vector.
 */
function safeActionUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/[\r\n]/.test(value)) return "";
  // "//host" and "/\host" are protocol-relative URLs, not paths on our site.
  // Appending them to the base produces a link that is at best malformed and
  // at worst points somewhere else entirely.
  if (value.startsWith("//") || value.startsWith("/\\")) return "";
  if (value.startsWith("/")) return `${ADMIN_BASE_URL.replace(/\/+$/, "")}${value}`;
  return /^https:\/\//i.test(value) ? value : "";
}

/** Rows with no value are dropped rather than rendered as a dash. */
function usableRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => (Array.isArray(row) ? { label: row[0], value: row[1] } : row))
    .filter((row) => row && String(row.value ?? "").trim() !== "");
}

function renderOperationalEmail({
  subject,
  event,
  who = "",
  highlight = "",
  rows = [],
  note = "",
  action = null,
  footer = "",
}) {
  const clean = usableRows(rows);
  const actionUrl = safeActionUrl(action?.url);

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${COLORS.page};">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COLORS.page};">
    <tr><td align="center" style="padding:16px 12px;">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0"
             style="width:100%;max-width:560px;background:#ffffff;border:1px solid ${COLORS.line};border-radius:4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
        <tr><td style="padding:10px 18px;border-bottom:1px solid ${COLORS.line};background:${COLORS.panel};
                       font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${COLORS.muted};">
          Profixter
        </td></tr>
        <tr><td style="padding:18px 18px 4px;">
          <div style="font-size:19px;font-weight:700;line-height:26px;color:${COLORS.ink};">${escapeHtml(event)}</div>
          ${who ? `<div style="margin-top:4px;font-size:15px;line-height:22px;color:${COLORS.ink};">${escapeHtml(who)}</div>` : ""}
          ${highlight ? `<div style="margin-top:10px;font-size:24px;font-weight:700;line-height:30px;color:${COLORS.ink};">${escapeHtml(highlight)}</div>` : ""}
        </td></tr>
        ${
          clean.length
            ? `<tr><td style="padding:12px 18px 0;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="font-size:14px;line-height:20px;">
            ${clean
              .map(
                (row) => `<tr>
              <td style="padding:3px 12px 3px 0;color:${COLORS.muted};white-space:nowrap;vertical-align:top;">${escapeHtml(row.label)}</td>
              <td style="padding:3px 0;color:${COLORS.ink};vertical-align:top;">${escapeHtml(row.value)}</td>
            </tr>`
              )
              .join("")}
          </table>
        </td></tr>`
            : ""
        }
        ${note ? `<tr><td style="padding:12px 18px 0;font-size:14px;line-height:20px;color:${COLORS.ink};white-space:pre-wrap;">${escapeHtml(note)}</td></tr>` : ""}
        ${
          actionUrl
            ? `<tr><td style="padding:16px 18px 4px;">
          <a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:10px 16px;background:${COLORS.accent};border:1px solid ${COLORS.accent};border-radius:4px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">${escapeHtml(action.label || "Open in Admin")}</a>
        </td></tr>`
            : ""
        }
        <tr><td style="padding:16px 18px;font-size:12px;line-height:18px;color:${COLORS.muted};">
          ${escapeHtml(footer || "Full details are in the Profixter dashboard.")}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    event,
    who,
    highlight,
    "",
    ...clean.map((row) => `${row.label}: ${row.value}`),
    note ? `\n${note}` : "",
    actionUrl ? `\n${action.label || "Open in Admin"}: ${actionUrl}` : "",
  ]
    .filter((line) => String(line).trim() !== "" || line === "")
    .join("\n")
    .trim();

  return { subject, html, text };
}

/* Deep links into Admin, in one place so a route rename is one edit. */
const adminLink = {
  booking: (id) => (id ? `/admin?tab=bookings&bookingId=${encodeURIComponent(id)}` : ""),
  customer: (id) => (id ? `/admin?tab=customers&userId=${encodeURIComponent(id)}` : ""),
  invoice: (id) => (id ? `/admin?tab=invoices&invoiceId=${encodeURIComponent(id)}` : ""),
  lead: () => "/admin?tab=leads",
  tips: () => "/admin?tab=tips",
};

module.exports = {
  ADMIN_BASE_URL,
  adminLink,
  escapeHtml,
  renderOperationalEmail,
  safeActionUrl,
  usableRows,
};
