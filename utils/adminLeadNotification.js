const {
  FROM,
  REPLY_TO,
  sendRaw,
} = require("./emailService");

function clean(value, fallback = "-") {
  const result = String(value || "").trim();
  return result || fallback;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    String(value || "").trim().toLowerCase()
  );
}

function resolveLeadReplyTo(customerEmail, fallback = REPLY_TO) {
  return validEmail(customerEmail)
    ? String(customerEmail).trim().toLowerCase()
    : fallback;
}

function getLeadRecipients(env = process.env) {
  const candidates = [
    env.MAIL_ADMIN,
    env.LEADS_EMAIL,
  ]
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(validEmail);

  if (!candidates.length) {
    candidates.push("getfixter@gmail.com");
  }

  return [...new Set(candidates)];
}

function formatSubmittedAt(value = new Date()) {
  const date = new Date(value);
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderAdminLeadEmail(input) {
  const leadType = clean(input.leadType || input.service);
  const name = clean(input.name);
  const submittedAt = formatSubmittedAt(input.submittedAt);
  const fields = [
    ["Lead type", leadType],
    ["Name", name],
    ["Phone", clean(input.phone)],
    ["Email", clean(input.email)],
    ["Address", clean(input.address)],
    ["Project type / service", clean(input.service)],
    ["Description / message", clean(input.message || input.notes)],
    ["Preferred contact", clean(input.contactPref)],
    ["Timeline", clean(input.timeline)],
    ["Budget", clean(input.budgetRange)],
    ["Submitted", submittedAt],
    ["Source page", clean(input.sourcePage)],
    ["Mongo lead ID", clean(input.leadId)],
  ];
  const subject = `New Profixter Lead: ${leadType} - ${name}`;
  const text = fields.map(([label, value]) => `${label}: ${value}`).join("\n");
  const htmlRows = fields
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;vertical-align:top;font-weight:700;">${escapeHtml(label)}</td><td style="padding:4px 0;vertical-align:top;white-space:pre-wrap;">${escapeHtml(value)}</td></tr>`
    )
    .join("");

  return {
    subject,
    text,
    html: `<!doctype html><html><body style="margin:0;padding:20px;background:#ffffff;color:#111827;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;"><h1 style="margin:0 0 16px;font-size:18px;">New Profixter Lead</h1><table role="presentation" cellspacing="0" cellpadding="0" border="0">${htmlRows}</table></body></html>`,
  };
}

async function sendAdminLeadNotification(input, options = {}) {
  const recipients = getLeadRecipients(options.env);
  const rendered = renderAdminLeadEmail(input);
  const replyTo = resolveLeadReplyTo(input.email);

  return sendRaw({
    to: recipients.join(", "),
    from: FROM,
    replyTo,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    attachments: options.attachments,
    bccAdmin: false,
  });
}

module.exports = {
  formatSubmittedAt,
  getLeadRecipients,
  renderAdminLeadEmail,
  resolveLeadReplyTo,
  sendAdminLeadNotification,
  validEmail,
};
