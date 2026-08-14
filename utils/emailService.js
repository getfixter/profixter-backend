// utils/emailService.js
// -----------------------------------------------------------------------------
// Transactional + marketing email service for Profixter
// Uses AWS SES SMTP via Nodemailer.
// -----------------------------------------------------------------------------

const nodemailer = require("nodemailer");
const mongoose = require("mongoose");
const EmailLog = require("../models/EmailLog");
const {
  createCustomerEmailTemplates,
} = require("./customerEmailTemplates");
const { PUBLIC_CONTACT_EMAIL } = require("./publicContact");
const { adminLink, renderOperationalEmail } = require("./operationalEmail");
const adminSubjects = require("./adminSubjects");
let marked;
try {
  ({ marked } = require("marked"));
} catch (e) {
  console.warn("⚠️ 'marked' not installed. Markdown rendering disabled.");
  marked = null;
}

/* ========================== BRAND / CONTACT ========================== */
const FROM = process.env.MAIL_FROM || "Profixter <no-reply@profixter.com>";
const REPLY_TO = process.env.MAIL_REPLY_TO || PUBLIC_CONTACT_EMAIL;
const ADMIN = process.env.MAIL_ADMIN || "getfixter@gmail.com";

const MARKETING_FROM = process.env.MARKETING_FROM || FROM;

/** Primary brand colors */
const BRAND = {
  primary: "#6f48eb",
  dark: "#111827",
  gray900: "#111827",
  gray700: "#374151",
  gray100: "#f8fafc",
  border: "#e5e7eb",
  green: "#16a34a",
  sky: "#0ea5e9",
  blue: "#2563eb",
};

/* =========================== ROUTES / LINKS =========================== */

const URLS = {
  tip: process.env.TIP_LINK || "https://www.profixter.com/tip",
  plans: process.env.PLANS_URL || "https://profixter.com",
  schedule: process.env.SCHEDULE_URL || "https://profixter.com",
  review: process.env.REVIEW_URL || "https://www.profixter.com/review",
  site: process.env.SITE_URL || "https://profixter.com",
  supportTel: process.env.SUPPORT_TEL_URL || "tel:+16315991363",
  supportSMS:
    process.env.SUPPORT_SMS_URL ||
    "sms:+16315991363?body=Hi%20Profixter%2C%20I%27m%20a%20member%20and%20have%20a%20question.",
};

const hasSupportSMS = true;
const hasSupportTel = !!URLS.supportTel;

/* ============================== SMTP ============================== */

const transporter = nodemailer.createTransport({
  host: process.env.AWS_SES_SMTP_HOST || "email-smtp.us-east-1.amazonaws.com",
  port: Number(process.env.AWS_SES_SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.AWS_SES_SMTP_USER,
    pass: process.env.AWS_SES_SMTP_PASS,
  },
});

/* ============================ HELPERS ============================= */
function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function mdToHtml(markdown = "") {
  const safe = escapeHtml(markdown);

  if (!marked) {
    return `<pre style="white-space:pre-wrap;margin:0;">${safe}</pre>`;
  }

  return marked.parse(safe);
}

const formatNYCTime = (iso) => {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    const day = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(d);
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
    return `${day} at ${time}`;
  } catch {
    return String(iso);
  }
};

const toText = (html = "") =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/h\d>/gi, "\n\n")
    .replace(/<h\d[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/ul>|<\/ol>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

const btn = (href, label, style = "primary") => {
  const bg =
    style === "dark"
      ? BRAND.dark
      : style === "green"
      ? BRAND.green
      : style === "blue"
      ? BRAND.blue
      : style === "sky"
      ? BRAND.sky
      : BRAND.primary;

  return `
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;">
    <tr>
      <td style="border-radius:10px;background:${bg};">
        <a href="${href}"
           style="
             display:inline-block;
             padding:13px 24px;
             border-radius:10px;
             background:${bg};
             color:#ffffff;
             text-decoration:none;
             font-size:15px;
             font-weight:700;
             letter-spacing:0.2px;
           ">
          ${label}
        </a>
      </td>
    </tr>
  </table>`;
};

const linkRow = (links = []) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;">
    <tr>
      ${links
        .map(
          (l) => `
        <td valign="top" style="padding-right:14px; padding-bottom:6px;">
          <a href="${l.href}" style="color:#0b5cab;text-decoration:none;font-weight:600;">${l.text}</a>
        </td>
      `
        )
        .join("")}
    </tr>
  </table>
`;

/*
 * The shared customer frame.
 *
 * The wordmark is text rather than an image. This header used to load the old
 * Mr. Fixter logo from S3, which put a retired mark on every email still using
 * this frame, including the paid one-time visit and Full Day confirmations a
 * customer receives after paying. It also meant the brand vanished entirely in
 * the many clients that block remote images. Text fixes both, and matches the
 * header the newer customer templates already use.
 *
 * This note lives out here on purpose: an HTML comment inside the literal
 * would ship inside every email we send.
 */
const frame = (content, opts = {}) => {
  const preheader = (opts.preheader || "").trim();

  return `
  <div style="background:#ffffff;padding:0;margin:0;">
    ${
      preheader
        ? `
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
        ${preheader}
      </div>
    `
        : ""
    }

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;">
      <tr>
        <td align="center" style="padding:20px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" style="max-width:640px;width:100%;border:1px solid ${BRAND.border};border-radius:16px;overflow:hidden;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">

            <tr>
              <td style="background:${BRAND.gray100};padding:20px 20px 16px;text-align:center;border-bottom:1px solid ${BRAND.border};">
                <div style="font-size:22px;font-weight:800;line-height:28px;color:${BRAND.gray900};letter-spacing:-0.01em;">Profixter</div>
                <div style="margin-top:6px;font-size:12px;color:#6b7280;letter-spacing:0.2px;">
                  Long Island Home Maintenance
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:28px 28px 22px;font-size:16px;line-height:1.7;color:${BRAND.gray900};">
                ${content}
              </td>
            </tr>

            <tr>
              <td style="background:${BRAND.gray100};padding:14px 16px;text-align:center;font-size:13px;color:#6b7280;border-top:1px solid ${BRAND.border};">
                <div style="margin-bottom:8px;">
                  Need help?
                  <a href="mailto:${REPLY_TO}" style="color:#0b5cab;text-decoration:none;font-weight:700;">Email us</a>
                  ${
                    hasSupportSMS
                      ? ` · <a href="${URLS.supportSMS}" style="color:#0b5cab;text-decoration:none;font-weight:700;">Text us</a>`
                      : ""
                  }
                  ${
                    hasSupportTel
                      ? ` · <a href="${URLS.supportTel}" style="color:#0b5cab;text-decoration:none;font-weight:700;">Call us</a>`
                      : ""
                  }
                </div>
                <div style="font-size:12px;color:#9ca3af;">
                  © ${new Date().getFullYear()} Profixter • You received this because you registered on Profixter.com
                </div>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </div>
  `;
};

/* ============================ TEMPLATES ============================ */

const TEMPLATES = {
  password_otp: ({ name = "there", otp }) => ({
    subject: "Your Profixter verification code",
    html: frame(`
      <h2 style="font-size:22px;font-weight:800;margin:0 0 10px">Hi ${name},</h2>
      <p>Use the code below to reset your password. It expires in <strong>5 minutes</strong>.</p>
      <div style="font-size:32px; letter-spacing:4px; font-weight:800; background:#f3f4f6;
                  padding:14px 18px; border-radius:10px; display:inline-block; margin:10px 0;">
        ${otp}
      </div>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `, { preheader: "Use this code to reset your password. Expires in 5 minutes." }),
  }),

  password_changed: ({ name = "there" }) => ({
    subject: "✅ Your password was updated",
    html: frame(`
      <h2 style="font-size:22px;font-weight:800;margin:0 0 8px">All set, ${name}.</h2>
      <p>This confirms your account password was changed. If this wasn't you, reply to this email immediately.</p>
    `, { preheader: "Your Profixter password has been updated." }),
  }),

  welcome: ({ name = "there", userId }) => ({
    subject: `Welcome to Profixter, ${name} — you're in`,
    html: frame(`
    <h2 style="font-size:22px;font-weight:800;margin:0 0 8px">Welcome, ${name}! 🤍</h2>

    <p style="margin:0 0 12px">
      We're genuinely happy you're here.
      <br />
      Profixter was created for homeowners who want things <strong>done right</strong>,
      without stress, guessing, or chasing contractors.
    </p>

    <p style="margin:0 0 12px">
      You're now part of Long Island's <strong>personal house maintenance service</strong> —
      one visit, one solved task.
    </p>

    <div style="margin:14px 0; padding:12px; background:${BRAND.gray100}; border-radius:10px;">
      <div style="font-weight:700; margin-bottom:4px;">Your Member ID</div>
      <div style="font-size:20px; letter-spacing:1px;"><strong>${userId || "-"}</strong></div>
    </div>

    <p style="margin:14px 0 8px"><strong>How Profixter works (simple & fair):</strong></p>
    <ul style="margin:0 0 14px 18px; padding:0;">
      <li><strong>We guarantee one task will be solved</strong> per visit.</li>
      <li>Each visit lasts up to <strong>90 minutes</strong>.</li>
      <li><strong>30-minute arrival window</strong> — because your time matters.</li>
      <li>Prepare the area & materials (if needed) for best results.</li>
    </ul>

    <p style="margin:0 0 12px">
      To start booking visits, you'll need a subscription.
      Most homeowners choose <strong>Premium</strong> — it offers the best value per visit
      and faster scheduling.
    </p>

    <div style="margin:16px 0; text-align:center;">
      ${btn(URLS.plans, "Choose your plan & get started")}
    </div>

    <hr style="border:none;border-top:1px solid ${BRAND.border};margin:18px 0;" />

    <p style="margin:0; font-size:14px; color:${BRAND.gray700};">
      We respect every customer, every family, and every home.
      Our goal is simple: make house maintenance easy, predictable, and stress-free.
    </p>

    <p style="margin:10px 0 0; font-size:14px; color:${BRAND.gray700};">
      Have more than one address? Ask us about <strong>special pricing for 2+ homes</strong>.
      And yes — sharing Profixter with friends & family is always appreciated 🤍
    </p>

    <p style="margin-top:10px; font-size:14px; color:${BRAND.gray700};">
      Welcome to smarter home care.
      <br />
      — The Profixter Team 🛠️
    </p>
  `, { preheader: "We handle the home. You handle life." }),
  }),

  subscription_started: ({ name = "there", plan, billingCycle, address }) => ({
    subject: `You're subscribed — ${plan || "your"} plan is active`,
    html: frame(`
    <h2 style="font-size:22px;font-weight:800;margin:0 0 8px">You're officially subscribed, ${name}! 🎉</h2>

    <p style="margin:0 0 12px">
      Thank you for trusting <strong>Profixter</strong> with your home.
      We're excited to take care of things for you.
    </p>

    <div style="margin:14px 0; padding:14px; background:${BRAND.gray100}; border-radius:10px; border:1px solid ${BRAND.border};">
      <div style="font-weight:700; margin-bottom:8px;">Your subscription</div>
      <table cellpadding="0" cellspacing="0" border="0" style="font-size:15px; line-height:1.9;">
        <tr><td><strong>Plan:</strong>&nbsp;${plan || "-"}</td></tr>
        <tr><td><strong>Billing:</strong>&nbsp;${billingCycle === "annual" ? "Annual" : "Monthly"}</td></tr>
        ${address ? `<tr><td><strong>Address:</strong>&nbsp;${escapeHtml(address)}</td></tr>` : ""}
      </table>
    </div>

    <div style="margin:12px 0 14px; padding:12px; background:${BRAND.gray100}; border-radius:10px;">
      <div style="font-weight:700; margin-bottom:6px;">What this means for you:</div>
      <ul style="margin:0 0 0 18px; padding:0;">
        <li><strong>One guaranteed task solved</strong> per visit</li>
        <li>Up to <strong>90 minutes</strong> per visit</li>
        <li><strong>30-minute arrival window</strong> (we respect your time)</li>
        <li>A dedicated pro who treats your home like their own</li>
      </ul>
    </div>

    <p style="margin:0 0 12px">
      You now have your <strong>personal Profixter pro</strong> on call.
      No more guessing who to call, no more explaining the same issue five times.
    </p>

    <div style="margin:16px 0; text-align:center;">
      ${btn(URLS.schedule, "Schedule your first visit")}
    </div>

    <p style="margin:6px 0 0; text-align:center; font-size:14px; color:${BRAND.gray700};">
      <a href="${URLS.site}/account?tab=plan" style="color:#0b5cab;text-decoration:none;">View your account</a>
    </p>

    <hr style="border:none;border-top:1px solid ${BRAND.border};margin:18px 0;" />

    <p style="margin:0; font-size:14px; color:${BRAND.gray700};">
      Managing more than one property? We offer <strong>special pricing for multiple addresses</strong>.
      Just let us know — we'll take care of it.
    </p>

    <p style="margin-top:10px; font-size:14px; color:${BRAND.gray700};">
      — The Profixter Team 🤍
    </p>
  `, { preheader: `Your ${plan || ""} membership is active and ready.` }),
  }),

  booking_created: ({ name = "there", bookingNumber, date, service, address }) => ({
    subject: `Booking received — #${bookingNumber || ""}`,
    html: frame(`
      <h2 style="font-size:22px;font-weight:800;margin:0 0 8px">Thanks, ${name} — we got your booking.</h2>

      <div style="margin:14px 0; padding:14px 16px; background:${BRAND.gray100}; border-radius:10px; border:1px solid ${BRAND.border};">
        <table cellpadding="0" cellspacing="0" border="0" style="font-size:15px; line-height:2.0;">
          <tr><td><strong>Booking #:</strong>&nbsp;${bookingNumber || "-"}</td></tr>
          <tr><td><strong>Service:</strong>&nbsp;${service || "-"}</td></tr>
          <tr><td><strong>Date:</strong>&nbsp;${date ? formatNYCTime(date) : "-"}</td></tr>
          ${address ? `<tr><td><strong>Address:</strong>&nbsp;${escapeHtml(address)}</td></tr>` : ""}
        </table>
      </div>

      <p>We'll confirm shortly.</p>
      <p style="margin-top:8px; font-size:14px; color:${BRAND.gray700};">
        Please make sure you have all materials before your pro arrives.
        Questions? Reply to this email${
          hasSupportSMS
            ? ` or <a href="${URLS.supportSMS}" style="color:#0b5cab;text-decoration:none;font-weight:600;">text us</a>`
            : ""
        }.
      </p>
    `, { preheader: "We received your request and will confirm shortly." }),
  }),

  one_time_visit_payment_received: ({
    name = "there",
    bookingNumber,
    date,
    service,
    selectedTask,
    address,
    price,
    durationMinutes,
  }) => ({
    subject: `Payment received - One-Time Visit #${bookingNumber || ""}`,
    html: frame(`
      <h2 style="font-size:22px;font-weight:800;margin:0 0 8px">Thanks, ${name} - your One-Time Visit request is paid.</h2>

      <p style="margin:0 0 12px">
        We received your ${price || "$99"} payment for a ${durationMinutes || 90}-minute One-Time Visit. Your request is now waiting for admin review and final approval.
      </p>

      <div style="margin:14px 0; padding:14px 16px; background:${BRAND.gray100}; border-radius:10px; border:1px solid ${BRAND.border};">
        <table cellpadding="0" cellspacing="0" border="0" style="font-size:15px; line-height:2.0;">
          <tr><td><strong>Booking #:</strong>&nbsp;${bookingNumber || "-"}</td></tr>
          <tr><td><strong>Visit:</strong>&nbsp;${service || "One-Time Handyman Visit"}</td></tr>
          <tr><td><strong>Task:</strong>&nbsp;${selectedTask || "-"}</td></tr>
          <tr><td><strong>Requested time:</strong>&nbsp;${date ? formatNYCTime(date) : "-"}</td></tr>
          ${address ? `<tr><td><strong>Address:</strong>&nbsp;${escapeHtml(address)}</td></tr>` : ""}
        </table>
      </div>

      <p style="margin:0 0 12px">
        We will review the details and confirm the appointment. If anything needs to change, please call
        <a href="${URLS.supportTel}" style="color:#0b5cab;text-decoration:none;font-weight:700;">631-599-1363</a>.
      </p>
      <p style="margin:0 0 12px; font-size:14px; color:${BRAND.gray700};">
        One-Time Visits are for small handyman jobs. Profixter does not offer appliance repair.
        Larger work should start with a Project Estimate.
      </p>
    `, { preheader: "Your paid One-Time Visit request is waiting for final approval." }),
    text: [
      `Thanks, ${name} - your One-Time Visit request is paid.`,
      "",
      `We received your ${price || "$99"} payment for a ${durationMinutes || 90}-minute One-Time Visit. Your request is waiting for admin review and final approval.`,
      "",
      `Booking #: ${bookingNumber || "-"}`,
      `Visit: ${service || "One-Time Handyman Visit"}`,
      `Task: ${selectedTask || "-"}`,
      `Requested time: ${date ? formatNYCTime(date) : "-"}`,
      address ? `Address: ${address}` : "",
      "",
      "If anything needs to change, call 631-599-1363. Cancellation and reschedule requests require admin approval.",
      "One-Time Visits are for small handyman jobs. Profixter does not offer appliance repair. Larger work should start with a Project Estimate.",
    ]
      .filter(Boolean)
      .join("\n"),
  }),

  /*
   * Full Day, both ways of getting one. Two templates rather than one with a
   * branch inside it, because the two say genuinely different things: one
   * confirms a benefit was used, the other confirms money was taken, and the
   * sentence a customer needs to read first is not the same in each case.
   */
  full_day_visit_booked: ({
    name = "there",
    bookingNumber,
    date,
    address,
    startTime,
    endTime,
    approximateHours,
    included,
    price,
    periodEnd,
  }) => ({
    subject: `Full Day Fixter booked - #${bookingNumber || ""}`,
    html: frame(`
      <h2 style="font-size:22px;font-weight:800;margin:0 0 8px">Thanks, ${name} - your Full Day Fixter is booked.</h2>

      <p style="margin:0 0 12px">
        ${
          included
            ? "This is the Full Day included with your Elite membership, so there is nothing to pay."
            : `We received your ${price || "$499"} payment for a Full Day Fixter.`
        }
        One Fixter is yours for approximately ${approximateHours || 8} hours to work through your list.
      </p>

      <div style="margin:14px 0; padding:14px 16px; background:${BRAND.gray100}; border-radius:10px; border:1px solid ${BRAND.border};">
        <table cellpadding="0" cellspacing="0" border="0" style="font-size:15px; line-height:2.0;">
          <tr><td><strong>Booking #:</strong>&nbsp;${bookingNumber || "-"}</td></tr>
          <tr><td><strong>Visit:</strong>&nbsp;Full Day Fixter</td></tr>
          <tr><td><strong>Date:</strong>&nbsp;${date ? formatNYCTime(date) : "-"}</td></tr>
          ${startTime && endTime ? `<tr><td><strong>Hours:</strong>&nbsp;${startTime} to ${endTime}</td></tr>` : ""}
          ${address ? `<tr><td><strong>Address:</strong>&nbsp;${escapeHtml(address)}</td></tr>` : ""}
        </table>
      </div>

      <p style="margin:0 0 12px">
        Have your list and any materials ready so the day starts moving straight away.
        Full Days are for multiple small jobs. Larger work should start with a Project Estimate.
      </p>
      ${
        included && periodEnd
          ? `<p style="margin:0 0 12px; font-size:14px; color:${BRAND.gray700};">Your next included Full Day becomes available on ${formatNYCTime(periodEnd)}.</p>`
          : ""
      }
      <p style="margin:0 0 12px">
        If anything needs to change, please call
        <a href="${URLS.supportTel}" style="color:#0b5cab;text-decoration:none;font-weight:700;">631-599-1363</a>.
      </p>
    `, { preheader: "One Fixter, your whole list, one day." }),
    text: [
      `Thanks, ${name} - your Full Day Fixter is booked.`,
      "",
      included
        ? "This is the Full Day included with your Elite membership, so there is nothing to pay."
        : `We received your ${price || "$499"} payment for a Full Day Fixter.`,
      `One Fixter is yours for approximately ${approximateHours || 8} hours.`,
      "",
      `Booking #: ${bookingNumber || "-"}`,
      `Date: ${date ? formatNYCTime(date) : "-"}`,
      startTime && endTime ? `Hours: ${startTime} to ${endTime}` : "",
      address ? `Address: ${address}` : "",
      "",
      included && periodEnd
        ? `Your next included Full Day becomes available on ${formatNYCTime(periodEnd)}.`
        : "",
      "If anything needs to change, call 631-599-1363.",
    ]
      .filter(Boolean)
      .join("\n"),
  }),

  /*
   * Booked, not paid. Those are two different events and they keep two
   * different subjects: collapsing them would hide whether money has arrived.
   */
  admin_full_day_booked: ({
    name, phone, address, userId, bookingNumber, date, startTime, endTime, fixter, paymentSummary, note,
  }) =>
    renderOperationalEmail({
      subject: adminSubjects.booking("Full Day Booked", { name, date, withTime: false }),
      event: "Full Day booked",
      who: name || "Customer",
      highlight: date ? formatNYCTime(date) : "",
      rows: [
        ["Hours", startTime && endTime ? `${startTime} to ${endTime}` : ""],
        ["Fixter", fixter || "Not yet assigned"],
        ["Address", address || ""],
        ["Phone", phone || ""],
        ["Payment", paymentSummary || ""],
      ],
      note: note || "",
      action: { label: "View Booking", url: adminLink.bookings() },
      footer: `Member ID ${userId || "-"}${bookingNumber ? ` - booking #${bookingNumber}` : ""}`,
    }),

  booking_confirmed: ({ name = "there", bookingNumber, date, service, address }) => ({
    subject: `Booking confirmed — #${bookingNumber || ""}`,
    html: frame(`
    <h2 style="font-size:22px;font-weight:800;margin:0 0 8px">Confirmed ✅</h2>

    <ul style="margin:0 0 12px 18px; padding:0;">
      <li><strong>Service:</strong> ${service || "-"}</li>
      <li><strong>Date:</strong> ${date ? formatNYCTime(date) : "-"}</li>
      <li><strong>Address:</strong> ${address || "-"}</li>
      <li><strong>Booking #:</strong> ${bookingNumber || "-"}</li>
    </ul>

    <div style="margin:14px 0; padding:12px; background:${BRAND.gray100}; border-radius:10px;">
      <div style="font-weight:800; margin-bottom:6px;">What to expect</div>
      <ul style="margin:0 0 0 18px; padding:0;">
        <li><strong>We guarantee</strong> at least <strong>one task</strong> will be solved during your visit.</li>
        <li>Each visit is up to <strong>90 minutes</strong>.</li>
        <li>Arrival window is <strong>30 minutes</strong>.</li>
        <li>Please prepare the working area and have materials ready (if needed) for the best quality of service.</li>
      </ul>
    </div>

    <p style="margin:0 0 12px;">
      We respect every customer, their family, and their home — and we truly appreciate your trust.
    </p>

    <hr style="border:none;border-top:1px solid ${BRAND.border};margin:18px 0;" />

    <p style="margin:0 0 10px;">
      If you enjoy our service, we would really appreciate it if you could
      <strong>share Profixter with your friends and family</strong>.
      Your recommendation helps us grow and keep improving.
    </p>

    <div style="margin:14px 0; text-align:center;">
      ${btn(URLS.review, "Leave a Google Review", "green")}
    </div>

    <p style="margin-top:14px; font-size:15px;">
      Thank you for being one of our favorite customers.
      Now you can prepare a Margarita and enjoy your House Maintenance Service 💛🏡
    </p>
  `, { preheader: "Your visit is locked in — here's what to expect." }),
  }),

  booking_completed: ({ name = "there", bookingNumber, email, tipUrl }) => {
    // tipUrl is the attributed link built for this booking. Without one this
    // falls back to the bare tip page, which still takes a tip; it just lands
    // in the admin's unassigned list instead of on a Fixter's ledger.
    const tipHref =
      tipUrl ||
      (URLS.tip
        ? `${URLS.tip}${email ? `?prefilled_email=${encodeURIComponent(email)}` : ""}`
        : null);

    return {
      subject: `All done 🎉 — booking #${bookingNumber || ""}`,
      html: frame(`
      <h2 style="font-size:22px;font-weight:800;margin:0 0 8px">All done 🎉</h2>

      <p style="margin:10px 0 12px">
        Thank you, <strong>${name}</strong> — we truly appreciate you choosing <strong>Profixter</strong>.
        We hope your home feels a little more comfortable today.
      </p>

      <div style="margin:14px 0; padding:12px; background:${BRAND.gray100}; border-radius:10px;">
        <div style="font-weight:800; margin-bottom:6px;">Tiny joke (very serious)</div>
        <div style="color:${BRAND.gray700}; font-size:14px;">
          Your home is now officially <strong>slightly more perfect</strong>. We checked. ✅
        </div>
      </div>

      <p style="margin:0 0 12px; color:${BRAND.gray700};">
        If anything needs a quick follow-up later, just schedule another visit — we've got you.
      </p>

      <div style="margin:14px 0; text-align:center;">
        ${btn(URLS.review, "★ Leave a Google review", "green")}
      </div>

      <div style="margin:14px 0; text-align:center;">
        ${btn(URLS.schedule, "Book another visit", "blue")}
      </div>

      ${
        tipHref
          ? `
        <p style="margin:4px 0 14px; font-size:14px; color:${BRAND.gray700}; text-align:center;">
          Enjoyed the visit? <a href="${tipHref}" style="color:#0b5cab;text-decoration:none;font-weight:600;">Leave a tip</a> — $10, $20, or any amount.
        </p>
      `
          : ""
      }

      <hr style="border:none;border-top:1px solid ${BRAND.border};margin:18px 0;" />

      <p style="margin:0; font-size:14px; color:${BRAND.gray700};">
        We respect your home, your family, and your time — and we're grateful you let us help.
        If you were happy with the visit, sharing Profixter with a friend or neighbor means a lot.
      </p>

      <p style="margin:10px 0 0; font-size:14px; color:${BRAND.gray700};">
        See you next time 👋🏡
      </p>
    `, { preheader: "Thanks for trusting us with your home." }),
    };
  },

  booking_canceled: ({ name = "there", bookingNumber, address }) => ({
    subject: `Your booking was canceled — #${bookingNumber || ""}`,
    html: frame(`
    <h2 style="font-size:22px;font-weight:800;margin:0 0 8px">Your booking was canceled</h2>

    <p style="margin:10px 0 12px">
     Hi ${name}, booking <strong>#${bookingNumber || "—"}</strong>${address ? ` at <strong>${escapeHtml(address)}</strong>` : ""} has been canceled.
     <br />
     This may happen if you changed plans — or if we had to adjust the schedule due to timing or weather.
    </p>

    <p style="margin:0 0 12px; color:${BRAND.gray700};">
      Our goal is always to keep things simple and respectful of everyone's time.
    </p>

    <p style="margin:0 0 14px; color:${BRAND.gray700};">
      If you'd like to schedule another visit, you can do it anytime — whenever it works best for you.
    </p>

    <div style="margin:14px 0; text-align:center;">
      ${btn(URLS.schedule, "Schedule a new visit", "blue")}
    </div>

    <p style="margin-top:14px; font-size:14px; color:${BRAND.gray700};">
      If you have any questions or need assistance, just reply to this email — we're always happy to help.
    </p>

    <p style="margin-top:10px; font-size:14px; color:${BRAND.gray700};">
      Thank you for choosing Profixter 🤍
    </p>
  `, { preheader: "Your booking has been canceled. We can reschedule anytime." }),
  }),

  /*
   * An ordinary booking event. The date is in the subject so this normally does
   * not need opening at all, which is the whole reason the subject carries it.
   */
  admin_booking_canceled: ({ name, phone, address, userId, bookingNumber, date, service }) =>
    renderOperationalEmail({
      subject: adminSubjects.booking("Booking Canceled", { name, date, withTime: false }),
      event: "Booking canceled",
      who: name || "Customer",
      highlight: date ? formatNYCTime(date) : "",
      rows: [
        ["Service", service || ""],
        ["Address", address || ""],
        ["Phone", phone || ""],
      ],
      action: { label: "View Booking", url: adminLink.bookings() },
      footer: `Member ID ${userId || "-"}${bookingNumber ? ` - booking #${bookingNumber}` : ""}`,
    }),

  booking_reminder_24h: ({
    name = "there",
    bookingNumber,
    date,
    service,
    address,
  }) => ({
    subject: "Heads up for tomorrow — your Profixter visit",
    html: frame(
      `
      <h2 style="font-size:22px;font-weight:800;margin:0 0 8px">Hi ${name}, just a quick reminder.</h2>
      <p>Your Profixter visit is <strong>${formatNYCTime(date)}</strong>.</p>

      <ul style="margin:8px 0 12px 18px; padding:0;">
        <li><strong>Service:</strong> ${service || "-"}</li>
        <li><strong>Address:</strong> ${address || "-"}</li>
        <li><strong>Booking #:</strong> ${bookingNumber || "-"}</li>
      </ul>

      <p style="margin:12px 0 8px;">Need a different time?</p>
      <div style="margin:12px 0; text-align:center;">
        ${btn(URLS.schedule, "Reschedule your visit")}
      </div>

      <p style="margin-top:14px; font-size:14px; color:${BRAND.gray700};">
        Thanks for trusting us with your home. If a friend or neighbor could use a dedicated home maintenance team,
        please share Profixter — your word helps us keep improving for you.
      </p>
    `,
      { preheader: "Reminder: your Profixter visit is tomorrow." }
    ),
  }),

  booking_reminder_60m: ({ name = "there", date }) => ({
    subject: "We're on the way — see you soon",
    html: frame(
      `
      <h2 style="font-size:22px;font-weight:800;margin:0 0 8px">See you soon, ${name}!</h2>
      <p>Your Profixter tech is scheduled <strong>${formatNYCTime(date)}</strong> and is on the way.</p>

      <div style="margin:12px 0 10px; padding:12px; background:${BRAND.gray100}; border-radius:10px;">
        <div style="font-weight:700; margin-bottom:6px;">Helpful before we arrive:</div>
        <ul style="margin:0 0 0 18px; padding:0;">
          <li>Clear the work area if you can</li>
          <li>Keep pets comfy and safe</li>
          <li>Have any materials ready (if needed)</li>
        </ul>
      </div>

      <div style="margin:14px 0; text-align:center;">
        ${btn(URLS.schedule, "Reschedule")}
      </div>

      <p style="margin:8px 0 0; font-size:14px; color:${BRAND.gray700}; text-align:center;">
        Need to reach us?
        ${hasSupportSMS ? `<a href="${URLS.supportSMS}" style="color:#0b5cab;text-decoration:none;font-weight:600;">Text us</a>` : ""}
        ${hasSupportSMS && hasSupportTel ? " · " : ""}
        ${hasSupportTel ? `<a href="${URLS.supportTel}" style="color:#0b5cab;text-decoration:none;font-weight:600;">Call us</a>` : ""}
      </p>

      <p style="margin-top:14px; font-size:14px; color:${BRAND.gray700};">
        We respect your time and home — thanks for the same in return. Your trust means a lot.
        Sharing our service with friends helps us grow and keeps improving your experience.
      </p>
    `,
      { preheader: "Reminder: your Profixter visit is coming up soon." }
    ),
  }),


  nudge_subscribe: ({ name = "there" }) => ({
    subject: "Make home care easy — choose your Profixter plan",
    html: frame(`
      <h2 style="font-size:22px;font-weight:800;margin:0 0 8px">Hey ${name}, ready to start with Profixter?</h2>
      <p>Choose a plan to unlock easy, reliable, personal handyman help. We recommend <strong>Premium</strong> for the best value and quicker turnarounds.</p>
      <p style="margin:14px 0 0;">${btn(URLS.plans, "See plans & subscribe")}</p>
      <p style="margin-top:14px; font-size:14px; color:${BRAND.gray700};">
        Earn <strong>$20</strong> when a friend joins, and ask about our <strong>2+ address</strong> discount.
      </p>
    `, { preheader: "Choose a plan to start booking home maintenance visits." }),
  }),



  // ── Estimate Builder lead notification (admin only) ──────────────────────

  subscription_canceled: ({ name = "there", plan, address, canceledDate }) => ({
    subject: "Your Profixter membership has ended",
    html: frame(`
    <h2 style="font-size:22px;font-weight:800;margin:0 0 8px">Your membership has ended</h2>

    <p style="margin:0 0 12px">
      Hi ${name}, your Profixter membership is no longer active.
    </p>

    <div style="margin:14px 0; padding:14px; background:${BRAND.gray100}; border-radius:10px; border:1px solid ${BRAND.border};">
      <table cellpadding="0" cellspacing="0" border="0" style="font-size:15px; line-height:1.9;">
        ${plan ? `<tr><td><strong>Plan:</strong>&nbsp;${escapeHtml(plan)}</td></tr>` : ""}
        ${address ? `<tr><td><strong>Address:</strong>&nbsp;${escapeHtml(address)}</td></tr>` : ""}
        ${canceledDate ? `<tr><td><strong>Ended:</strong>&nbsp;${escapeHtml(canceledDate)}</td></tr>` : ""}
      </table>
    </div>

    <p style="margin:0 0 14px; color:${BRAND.gray700};">
      Your membership is no longer active. You can restart anytime — your account history and addresses are saved.
    </p>

    <div style="margin:16px 0; text-align:center;">
      ${btn(URLS.plans, "View plans", "dark")}
    </div>

    <p style="margin-top:14px; font-size:14px; color:${BRAND.gray700};">
      Thank you for being a Profixter member. We hope to see you again.
      <br />
      — The Profixter Team
    </p>
  `, { preheader: "Your membership is no longer active, but you can restart anytime." }),
  }),

  payment_failed: ({ name = "there", plan, amount, billingDate }) => ({
    subject: "Payment issue — update your Profixter billing",
    html: frame(`
    <h2 style="font-size:22px;font-weight:800;margin:0 0 8px">We couldn't process your payment</h2>

    <p style="margin:0 0 12px">
      Hi ${name}, we had trouble processing your Profixter membership payment.
    </p>

    <div style="margin:14px 0; padding:14px; background:${BRAND.gray100}; border-radius:10px; border:1px solid ${BRAND.border};">
      <table cellpadding="0" cellspacing="0" border="0" style="font-size:15px; line-height:1.9;">
        ${plan ? `<tr><td><strong>Plan:</strong>&nbsp;${escapeHtml(plan)}</td></tr>` : ""}
        ${amount ? `<tr><td><strong>Amount due:</strong>&nbsp;${escapeHtml(amount)}</td></tr>` : ""}
        ${billingDate ? `<tr><td><strong>Billing date:</strong>&nbsp;${escapeHtml(billingDate)}</td></tr>` : ""}
      </table>
    </div>

    <p style="margin:0 0 12px">
      Please update your payment method to keep your membership active.
      If this isn't resolved, your access may be interrupted.
    </p>

    <div style="margin:16px 0; text-align:center;">
      ${btn(`${URLS.site}/account?tab=plan`, "Update payment method")}
    </div>

    <p style="margin-top:14px; font-size:14px; color:${BRAND.gray700};">
      If you have any questions, reply to this email or text us — we're happy to help.
      <br />
      — The Profixter Team
    </p>
  `, { preheader: "We couldn't process your membership payment. Please update your card." }),
  }),

  /**
   * "A customer left you a tip."
   *
   * Goes to the employee's own User.email. There is no address in this file and
   * none in the caller: the Fixter is looked up from the tip, which is the same
   * record the money is credited to, so the person who is told is by
   * construction the person who was paid.
   */
  /*
   * A Fixter email. Short and warm, and free of Stripe internals on purpose:
   * the amount and who sent it is the whole message.
   */
  fixter_tip_received: ({
    name = "there",
    amount,
    tipperName,
    bookingNumber,
  }) =>
    renderOperationalEmail({
      subject: `You received a ${amount || "tip"}`,
      event: `You received a ${amount || "tip"}`,
      who: tipperName ? `From ${tipperName}` : "",
      highlight: "",
      rows: [["Booking", bookingNumber ? `#${bookingNumber}` : ""]],
      note: `Nice work, ${name}.`,
      footer: "Your running tip total is on the Tips tab of your Profixter workspace.",
    }),

  nurture_1: ({ name = "there" }) => ({
    subject: `Ready when you are, ${name}`,
    html: frame(`
    <h2 style="font-size:22px;font-weight:800;margin:0 0 8px">You're all set, ${name}.</h2>

    <p style="margin:0 0 12px">
      Your Profixter account is ready. The next step is choosing a plan so you can start booking visits.
    </p>

    <p style="margin:0 0 12px">
      Here's how it works: pick a plan, book a visit, and we'll send a skilled pro to your door.
      Each visit focuses on one clear task — up to 90 minutes. Best for planned home maintenance and small repairs.
    </p>

    <p style="margin:0 0 14px; color:${BRAND.gray700};">
      Most homeowners start with Basic, then upgrade once they see how smooth the process is.
    </p>

    <div style="margin:16px 0; text-align:center;">
      ${btn(URLS.plans, "See plans & get started")}
    </div>
  `, { preheader: "Your Profixter account is set up. Here's what to do next." }),
  }),

  nurture_2: ({ name = "there" }) => ({
    subject: "What a Profixter visit actually looks like",
    html: frame(`
    <h2 style="font-size:22px;font-weight:800;margin:0 0 8px">Here's what a visit looks like.</h2>

    <p style="margin:0 0 12px">
      Each Profixter visit focuses on one clear task — up to 90 minutes, with a 30-minute arrival window.
    </p>

    <p style="margin:0 0 12px">
      It's designed for planned home maintenance and small repairs: fixing a leaky faucet, patching drywall,
      mounting a TV, caulking, door adjustments, and similar work.
    </p>

    <p style="margin:0 0 14px; color:${BRAND.gray700};">
      If the task fits the visit scope, we'll handle it. If it's larger or more complex,
      we'll let you know upfront before starting — no surprises.
    </p>

    <div style="margin:16px 0; text-align:center;">
      ${btn(URLS.plans, "Choose your plan")}
    </div>
  `, { preheader: "One task, one visit, up to 90 minutes — here's what to expect." }),
  }),

  nurture_3: ({ name = "there" }) => ({
    subject: "Last email from us — your account stays saved",
    html: frame(`
    <h2 style="font-size:22px;font-weight:800;margin:0 0 8px">This is our last email about plans.</h2>

    <p style="margin:0 0 12px">
      We know your inbox is busy. If Profixter isn't right for you right now, that's completely fine.
    </p>

    <p style="margin:0 0 12px; color:${BRAND.gray700};">
      Your account stays saved — your addresses, your history, everything.
      Whenever something comes up around the house, you can subscribe and book a visit in minutes.
    </p>

    <p style="margin:0 0 14px; color:${BRAND.gray700};">
      If now works, here's where to start.
    </p>

    <div style="margin:16px 0; text-align:center;">
      ${btn(URLS.plans, "View plans", "dark")}
    </div>
  `, { preheader: "No pressure. But if you ever need home help, we're here." }),
  }),
};

Object.assign(
  TEMPLATES,
  createCustomerEmailTemplates({
    escapeHtml,
    formatNYCTime,
    urls: URLS,
  })
);

/* ============= Send wrappers ============= */

const BCC_ADMIN = new Set(["welcome", "subscription_started", "booking_created"]);

const EMAIL_LOG_TRUNCATE = 2000;

function truncateLogValue(value, max = EMAIL_LOG_TRUNCATE) {
  if (value === undefined || value === null) return "";
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 0);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function normalizeEmailValue(value) {
  return String(value || "").trim().toLowerCase();
}

function maybeObjectId(value) {
  if (!value) return null;
  const text = String(value);
  return mongoose.Types.ObjectId.isValid(text) ? text : null;
}

function providerResponse(info) {
  if (!info) return "";
  return truncateLogValue({
    response: info.response || "",
    accepted: info.accepted || [],
    rejected: info.rejected || [],
    envelope: info.envelope || null,
  });
}

function buildEmailLogPayload({
  status,
  to,
  subject,
  info,
  error,
  logContext = {},
}) {
  const now = new Date();
  const recipientEmail = normalizeEmailValue(
    logContext.recipientEmail || to
  );
  return {
    templateKey: String(logContext.templateKey || "").trim(),
    subject: String(subject || "").trim(),
    recipientEmail,
    recipientName: String(logContext.recipientName || "").trim(),
    customerEmail: normalizeEmailValue(
      logContext.customerEmail || logContext.recipientEmail || to
    ),
    customerName: String(logContext.customerName || "").trim(),
    userId: logContext.userId || null,
    bookingId: maybeObjectId(logContext.bookingId),
    bookingNumber: String(logContext.bookingNumber || "").trim(),
    campaignId: maybeObjectId(logContext.campaignId),
    campaignNumber: String(logContext.campaignNumber || "").trim(),
    source: String(logContext.source || "").trim(),
    emailType: String(logContext.emailType || "").trim(),
    status,
    sentAt: status === "sent" ? now : null,
    failedAt: status === "failed" ? now : null,
    provider: String(logContext.provider || "nodemailer").trim(),
    providerMessageId: String(info?.messageId || "").trim(),
    providerResponse: status === "sent" ? providerResponse(info) : "",
    errorMessage: error ? truncateLogValue(error?.message || error) : "",
    errorCode: String(error?.code || "").trim(),
    responseCode: String(error?.responseCode || "").trim(),
  };
}

async function safeCreateEmailLog(payload) {
  try {
    await EmailLog.create(payload);
  } catch (logError) {
    console.warn("EmailLog write failed", {
      message: logError?.message || "",
      templateKey: payload?.templateKey || "",
      recipientEmail: payload?.recipientEmail || "",
      status: payload?.status || "",
    });
  }
}

async function sendRaw({
  to,
  subject,
  html,
  text,
  bccAdmin = false,
  from = FROM,
  replyTo = REPLY_TO,
  headers = {},
  attachments,
  logContext = {},
}) {
  const cleanTo = String(to || "").trim().toLowerCase();

  if (!cleanTo) {
    throw new Error(`Missing "to" email for subject "${subject}"`);
  }

  const plainText = text || toText(html);
  const mail = {
    from,
    to: cleanTo,
    subject,
    html,
    text: plainText,
    replyTo,
    headers: { "X-Entity-Ref-ID": Date.now().toString(), ...headers },
  };
  if (attachments?.length) mail.attachments = attachments;

  if (bccAdmin && ADMIN) mail.bcc = ADMIN;

  console.log("📨 Email send attempt", {
    to: cleanTo,
    subject,
    from,
    hasBcc: !!mail.bcc,
  });

  try {
    const info = await transporter.sendMail(mail);

    void safeCreateEmailLog(
      buildEmailLogPayload({
        status: "sent",
        to: cleanTo,
        subject,
        info,
        logContext,
      })
    );

    if (process.env.NODE_ENV !== "production") {
      console.log("Mail sent:", info.messageId, "to", cleanTo);
    }

    return info;
  } catch (err) {
    console.error("❌ Email send failed", {
      to: cleanTo,
      subject,
      message: err?.message || "",
      stack: err?.stack || "",
      code: err?.code || "",
      response: err?.response || "",
      responseCode: err?.responseCode || "",
      command: err?.command || "",
    });
    void safeCreateEmailLog(
      buildEmailLogPayload({
        status: "failed",
        to: cleanTo,
        subject,
        error: err,
        logContext,
      })
    );
    throw err;
  }
}

async function sendTx(key, to, vars = {}, opts = {}) {
  const t = TEMPLATES[key];
  if (!t) throw new Error(`Unknown template: ${key}`);
  const { subject, html, text } = t(vars);
  const bccAdmin = opts.bccAdmin ?? BCC_ADMIN.has(key);
  return sendRaw({
    to,
    subject,
    html,
    text,
    bccAdmin,
    logContext: {
      templateKey: key,
      source: "sendTx",
      ...opts.logContext,
    },
  });
}

async function sendPromo(to, { subject, html, text, headers = {}, logContext = {} }) {
  return sendRaw({
    to,
    subject,
    html,
    text,
    headers,
    from: MARKETING_FROM,
    bccAdmin: false,
    logContext: {
      templateKey: "promo",
      source: "sendPromo",
      emailType: "marketing",
      ...logContext,
    },
  });
}

async function sendPromoMarkdown(
  to,
  { subject, markdown, preheader = "", headers = {}, logContext = {} }
) {
  const contentHtml = mdToHtml(markdown);
  const html = frame(contentHtml, { preheader });

  return sendRaw({
    to,
    subject,
    html,
    headers,
    from: MARKETING_FROM,
    bccAdmin: false,
    logContext: {
      templateKey: "promo_markdown",
      source: "sendPromoMarkdown",
      emailType: "marketing",
      ...logContext,
    },
  });
}

module.exports = {
  sendRaw,
  sendTx,
  sendPromo,
  sendPromoMarkdown,
  TEMPLATES,
  formatNYCTime,
  transporter,
  FROM,
  REPLY_TO,
  ADMIN,
};
