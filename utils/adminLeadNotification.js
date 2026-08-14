const {
  FROM,
  REPLY_TO,
  sendRaw,
} = require("./emailService");
const { adminLink, renderOperationalEmail } = require("./operationalEmail");
const adminSubjects = require("./adminSubjects");

const NOT_AVAILABLE = "Not Available";

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

function normalizeFieldValue(value, fallback = "Not available") {
  if (value instanceof Date) return formatSubmittedAt(value);
  const result = String(value ?? "").trim();
  return result || fallback;
}

function normalizeFields(fields = []) {
  return fields
    .filter((field) => Array.isArray(field) && field.length >= 2)
    .map(([label, value]) => [
      normalizeFieldValue(label, "Field"),
      normalizeFieldValue(value),
    ]);
}

function normalizeSectionFields(fields = []) {
  return fields
    .filter((field) => Array.isArray(field) && field.length >= 2)
    .map(([label, value]) => [
      normalizeFieldValue(label, "Field"),
      normalizeFieldValue(value, NOT_AVAILABLE),
    ]);
}

function normalizeSections(sections = []) {
  return sections
    .filter((section) => section && typeof section === "object")
    .map((section) => ({
      title: normalizeFieldValue(section.title, "DETAILS").toUpperCase(),
      fields: normalizeSectionFields(section.fields),
    }))
    .filter((section) => section.fields.length);
}

function renderAdminEventSectionsEmail({
  subject,
  heading = subject,
  sections = [],
}) {
  const cleanSubject = normalizeFieldValue(subject, "NEW LEAD");
  const cleanHeading = normalizeFieldValue(heading, cleanSubject);
  const normalizedSections = normalizeSections(sections);

  const text = normalizedSections
    .map((section) => {
      const rows = section.fields
        .map(([label, value]) => `${label}: ${value}`)
        .join("\n");
      return [
        "----------------------------------------",
        section.title,
        "----------------------------------------",
        "",
        rows,
      ].join("\n");
    })
    .join("\n\n");

  const htmlSections = normalizedSections
    .map((section) => {
      const rows = section.fields
        .map(
          ([label, value]) =>
            `<tr><td style="padding:5px 16px 5px 0;vertical-align:top;font-weight:700;color:#111827;width:220px;">${escapeHtml(label)}</td><td style="padding:5px 0;vertical-align:top;white-space:pre-wrap;color:#111827;">${escapeHtml(value)}</td></tr>`
        )
        .join("");
      return `<section style="margin:0 0 24px;"><h2 style="margin:0 0 8px;padding:0 0 8px;border-bottom:1px solid #d1d5db;font-size:13px;line-height:18px;letter-spacing:.08em;color:#374151;">${escapeHtml(section.title)}</h2><table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;">${rows}</table></section>`;
    })
    .join("");

  return {
    subject: cleanSubject,
    text: `${cleanHeading}\n\n${text}`,
    html: `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff;color:#111827;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;"><h1 style="margin:0 0 22px;font-size:22px;line-height:28px;">${escapeHtml(cleanHeading)}</h1>${htmlSections}</body></html>`,
  };
}

/**
 * One operational email, rendered through the shared shell.
 *
 * Callers pass the few things that matter and, where one exists, a link into
 * Admin. The old renderer took an arbitrary list of label/value pairs and
 * printed every one of them, which is how these emails became object dumps: it
 * was easier to add a field than to decide whether it earned its place. This
 * keeps the same input shape so nothing had to be rewritten at once, but the
 * shell now gives the event, the person and the important value their own
 * weight instead of burying them in row seventeen.
 */
function renderAdminEventEmail({
  subject,
  heading = subject,
  fields = [],
  who = "",
  highlight = "",
  note = "",
  action = null,
  footer = "",
}) {
  const cleanSubject = normalizeFieldValue(subject, "NEW LEAD");
  return renderOperationalEmail({
    subject: cleanSubject,
    event: normalizeFieldValue(heading, cleanSubject),
    who,
    highlight,
    rows: normalizeFields(fields),
    note,
    action,
    footer,
  });
}

function isCommunityRequest(input = {}) {
  const haystack = [
    input.notificationType,
    input.leadType,
    input.service,
    input.sourcePage,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes("community") || haystack.includes("partnership");
}

function isOneTimeRequest(input = {}) {
  const haystack = [
    input.notificationType,
    input.leadType,
    input.service,
    input.sourcePage,
  ]
    .join(" ")
    .toLowerCase();
  return (
    haystack.includes("one-time") ||
    haystack.includes("one time") ||
    haystack.includes("on-demand") ||
    haystack.includes("on demand")
  );
}

function isProjectLead(input = {}) {
  const haystack = [
    input.notificationType,
    input.leadType,
    input.service,
    input.sourcePage,
  ]
    .join(" ")
    .toLowerCase();
  return [
    "estimate",
    "project",
    "renovation",
    "remodel",
    "roofing",
    "siding",
    "kitchen",
    "bathroom",
    "contractor",
    "home improvement",
    "new home",
    "full home",
  ].some((keyword) => haystack.includes(keyword));
}

function leadSubjectFor(input = {}) {
  const name = clean(input.name);
  return adminSubjects.isRegistration(input)
    ? adminSubjects.registration(name)
    : adminSubjects.lead(adminSubjects.leadKindFor(input), name);
}

/**
 * A registration or a real lead, rendered through the operational shell.
 *
 * The split is the point. Somebody creating an account and somebody asking to
 * be phoned about a kitchen were producing the same shape of email with the
 * same word "Lead" in the subject, and the registrations vastly outnumber the
 * leads, so the word stopped meaning anything. They are now different subjects
 * with different urgency and different bodies: a registration carries who and
 * where, a lead carries what they asked for and how to reach them.
 *
 * The Mongo lead id, the source page and the submitted timestamp are gone from
 * the body. All three are on the record in Admin, which the button opens.
 */
function renderAdminLeadEmail(input) {
  const name = clean(input.name);
  const registration = adminSubjects.isRegistration(input);

  if (registration) {
    return renderOperationalEmail({
      subject: input.subject || adminSubjects.registration(name),
      event: "New registration",
      who: name,
      rows: [
        ["Phone", clean(input.phone, "")],
        ["Email", clean(input.email, "")],
        ["Address", clean(input.address, "")],
      ],
      action: { label: "View Customer", url: adminLink.lead() },
      footer: "Account created. No action needed.",
    });
  }

  const kind = adminSubjects.leadKindFor(input);
  return renderOperationalEmail({
    subject: input.subject || adminSubjects.lead(kind, name),
    event: kind.charAt(0) + kind.slice(1).toLowerCase(),
    who: name,
    // The number leads, because the only useful response to a lead is a call.
    highlight: clean(input.phone, ""),
    rows: [
      ["Email", clean(input.email, "")],
      ["Wants", clean(input.leadType || input.service, "")],
      ["Address", clean(input.address, "")],
      ["Timeline", clean(input.timeline, "")],
      ["Budget", clean(input.budgetRange, "")],
    ],
    note: clean(input.message || input.notes, ""),
    action: { label: "View Lead", url: adminLink.lead() },
  });
}

async function sendAdminEventNotification(input, options = {}) {
  const recipients = getLeadRecipients(options.env);
  const rendered = Array.isArray(input.sections) && input.sections.length
    ? renderAdminEventSectionsEmail(input)
    : renderAdminEventEmail(input);
  const replyTo = resolveLeadReplyTo(
    input.replyToEmail || input.customerEmail || input.email
  );

  return sendRaw({
    to: recipients.join(", "),
    from: FROM,
    replyTo,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    attachments: options.attachments,
    bccAdmin: false,
    logContext: {
      templateKey: input.templateKey || "admin_event_notification",
      recipientEmail: recipients.join(", "),
      customerName: input.customerName || input.name || "",
      customerEmail: input.customerEmail || input.email || "",
      source: input.source || input.sourcePage || "adminEventNotification",
      emailType: "admin",
      ...options.logContext,
    },
  });
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
    logContext: {
      templateKey: "admin_lead_notification",
      recipientEmail: recipients.join(", "),
      customerName: input.name || "",
      customerEmail: input.email || "",
      source: input.sourcePage || "adminLeadNotification",
      emailType: "admin",
      ...options.logContext,
    },
  });
}

module.exports = {
  formatSubmittedAt,
  getLeadRecipients,
  renderAdminEventEmail,
  renderAdminEventSectionsEmail,
  renderAdminLeadEmail,
  resolveLeadReplyTo,
  sendAdminEventNotification,
  sendAdminLeadNotification,
  validEmail,
};
