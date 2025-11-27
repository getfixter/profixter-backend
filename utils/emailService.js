// utils/emailService.js
// -----------------------------------------------------------------------------
// Transactional + marketing email service for Profixter / Mr. Fixter
// Uses AWS SES SMTP via Nodemailer.
// -----------------------------------------------------------------------------

const nodemailer = require("nodemailer");

/* ========================== BRAND / CONTACT ========================== */

const FROM      = process.env.MAIL_FROM      || 'Mr. Fixter <my@profixter.com>';
const REPLY_TO  = process.env.MAIL_REPLY_TO  || 'getfixter@gmail.com';
const ADMIN     = process.env.MAIL_ADMIN     || 'getfixter@gmail.com';

const MARKETING_FROM = process.env.MARKETING_FROM || FROM;

/** Public logo (PNG, transparent). Replace via env if you ever move it. */
const LOGO_URL =
  process.env.BRAND_LOGO_URL ||
  'https://profixter-assets.s3.us-east-1.amazonaws.com/mrfixter-logoBlackText.png';

/** Primary brand colors */
const BRAND = {
  primary:  '#6f48eb',  // buttons, CTAs
  dark:     '#111827',
  gray900:  '#111827',
  gray700:  '#374151',
  gray100:  '#f8fafc',
  border:   '#e5e7eb',
  green:    '#16a34a',
  sky:      '#0ea5e9',
  blue:     '#2563eb',
};

/* =========================== ROUTES / LINKS =========================== */

const URLS = {
  tip:        process.env.TIP_LINK        || 'https://buy.stripe.com/eVq8wO3W98O03NL3AS',
  plans:      process.env.PLANS_URL       || 'https://profixter.com/subscription',
  schedule:   process.env.SCHEDULE_URL    || 'https://profixter.com/schedule',
  review:     process.env.REVIEW_URL      || 'https://maps.app.goo.gl/65L1i4GGsd1nMWEi7',
  site:       process.env.SITE_URL        || 'https://profixter.com',
  supportTel: process.env.SUPPORT_TEL_URL || 'tel:+16315991363',
  supportSMS: process.env.SUPPORT_SMS_URL || 'sms:+16315991363?body=Hi%20Profixter%2C%20I%27m%20a%20member%20and%20have%20a%20question.',
};

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

/** NYC time formatting: "Tue, Oct 15 at 2:30 PM" */
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
    return iso;
  }
};

/** Turn HTML into a readable plaintext fallback */
const toText = (html = "") =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(h\d)>/gi, " $1: ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/ul>|<\/ol>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

/** Reusable CTA button */
const btn = (href, label, style = "primary") => {
  const bg =
    style === "dark" ? BRAND.dark :
    style === "green" ? BRAND.green :
    style === "blue" ? BRAND.blue :
    style === "sky" ? BRAND.sky :
    BRAND.primary;

  return `
    <a href="${href}"
       style="background:${bg};color:#fff;padding:12px 18px;border-radius:10px;
              text-decoration:none;display:inline-block;font-weight:600;">
      ${label}
    </a>`;
};

/** Tertiary link row (e.g., actions side-by-side) */
const linkRow = (links = []) => `
  <div style="margin-top:10px; display:flex; gap:12px; flex-wrap:wrap;">
    ${links.map(l => `<a href="${l.href}" style="color:#0b5cab;text-decoration:none;font-weight:600;">${l.text}</a>`).join("")}
  </div>
`;

/** Email chrome (logo header + content + clean footer) */
const frame = (content) => `
  <div style="
    font-family: Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial, sans-serif;
    max-width:600px; margin:0 auto; border:1px solid ${BRAND.border}; border-radius:12px; overflow:hidden;">
    <div style="background:${BRAND.gray100}; padding:18px; text-align:center;">
      <img src="${LOGO_URL}" alt="Profixter" style="height:56px; line-height:56px; display:inline-block;" />
    </div>

    <div style="padding:22px; font-size:16px; line-height:1.6; color:${BRAND.gray900};">
      ${content}
    </div>

    <div style="background:${BRAND.gray100}; padding:14px; text-align:center; font-size:13px; color:#6b7280;">
      Need help? <a href="mailto:${REPLY_TO}" style="color:#0b5cab;text-decoration:none;">${REPLY_TO}</a> ·
      © ${new Date().getFullYear()} Profixter
    </div>
  </div>
`;

/* ============================ TEMPLATES ============================ */

const TEMPLATES = {
  /* --------- Security / account --------- */

  password_otp: ({ name = "there", otp }) => ({
    subject: "🔐 Your Fixter password reset code",
    html: frame(`
      <h2 style="margin:0 0 10px">Hi ${name},</h2>
      <p>Use the code below to reset your password. It expires in <strong>5 minutes</strong>.</p>
      <div style="font-size:32px; letter-spacing:4px; font-weight:800; background:#f3f4f6;
                  padding:14px 18px; border-radius:10px; display:inline-block; margin:10px 0;">
        ${otp}
      </div>
      <p>If you didn’t request this, you can safely ignore this email.</p>
    `),
  }),

  password_changed: ({ name = "there" }) => ({
    subject: "✅ Your password was updated",
    html: frame(`
      <h2 style="margin:0 0 8px">All set, ${name}.</h2>
      <p>This confirms your account password was changed. If this wasn’t you, reply to this email immediately.</p>
    `),
  }),

  /* --------- Welcome / onboarding --------- */

  welcome: ({ name = "there", userId }) => ({
    subject: `Welcome to Mr. Fixter, ${name}!`,
    html: frame(`
      <h2 style="margin:0 0 8px">Welcome, ${name}!</h2>
      <p>You're part of Long Island’s first <strong>personal handyman service</strong>.</p>
      <p>Your member ID: <strong>${userId || "-"}</strong></p>

      <p style="margin:14px 0 0;">
        To book visits you’ll choose a plan first. We recommend <strong>Premium</strong> — best value per visit and faster turnarounds.
      </p>
      <ul style="margin:10px 0 0 18px; padding:0;">
        <li>Priority response</li>
        <li>Flexible booking</li>
        <li>Great value for busy homeowners</li>
      </ul>

      <p style="margin:18px 0 0;">${btn(URLS.plans, "See plans & subscribe")}</p>

      <p style="margin-top:14px; font-size:14px; color:${BRAND.gray700};">
        Earn <strong>$20</strong> when a friend joins (referrals), and ask about our <strong>special price</strong> for <strong>2+ addresses</strong>.
      </p>
    `),
  }),

  subscription_started: ({ name = "there", plan }) => ({
    subject: `You're all set, ${name}!`,
    html: frame(`
      <h2 style="margin:0 0 8px">Welcome aboard, ${name}!</h2>
      <p>Your subscription: <strong>${plan || "-"}</strong></p>
      <p>You now have your <strong>personal Fixter</strong> on call. Let’s get your first visit on the calendar:</p>
      <p style="margin:14px 0 0;">${btn(URLS.schedule, "Schedule a visit")}</p>
      <p style="margin-top:14px; font-size:14px; color:${BRAND.gray700};">
        Refer a friend and earn <strong>$20</strong>. Managing more than one property? Ask about our <strong>multi-address discount</strong>.
      </p>
    `),
  }),

  /* --------- Bookings --------- */

  booking_created: ({ name = "there", bookingNumber, date, service, address }) => ({
    subject: `Booking received — #${bookingNumber || ""}`,
    html: frame(`
      <h2 style="margin:0 0 8px">Thanks, ${name} — we got your booking.</h2>
      <ul style="margin:0 0 12px 18px; padding:0;">
        <li><strong>Service:</strong> ${service || "-"}</li>
        <li><strong>Date:</strong> ${date ? formatNYCTime(date) : "-"}</li>
        <li><strong>Address:</strong> ${address || "-"}</li>
        <li><strong>Booking #:</strong> ${bookingNumber || "-"}</li>
      </ul>
      <p>We’ll confirm shortly.</p>
      <p style="margin-top:8px; font-size:14px; color:${BRAND.gray700};">
        Please make sure you have all materials before your Fixter arrives.
        Questions? Text <strong>631-599-1363</strong> (Fixter Taras).
      </p>
    `),
  }),

  booking_confirmed: ({ name = "there", bookingNumber, date, service, address }) => ({
    subject: `Booking confirmed — #${bookingNumber || ""}`,
    html: frame(`
      <h2 style="margin:0 0 8px">Confirmed ✅</h2>
      <ul style="margin:0 0 12px 18px; padding:0;">
        <li><strong>Service:</strong> ${service || "-"}</li>
        <li><strong>Date:</strong> ${date ? formatNYCTime(date) : "-"}</li>
        <li><strong>Address:</strong> ${address || "-"}</li>
        <li><strong>Booking #:</strong> ${bookingNumber || "-"}</li>
      </ul>
      <p>Your Fixter is <strong>Taras</strong>. Get your materials ready and please make sure pets are comfy.</p>
    `),
  }),

  booking_completed: ({ name = "there", bookingNumber, email }) => {
    const tipHref = URLS.tip
      ? `${URLS.tip}${email ? `?prefilled_email=${encodeURIComponent(email)}` : ""}`
      : null;

    return {
      subject: `All done 🎉 — booking #${bookingNumber || ""}`,
      html: frame(`
        <h2 style="margin:0 0 8px">Booking completed 🎉</h2>
        <p style="margin:10px 0 12px">Thanks for choosing <strong>Profixter</strong>, ${name}. We hope you loved the service!</p>

        ${tipHref ? `
          <div style="margin:16px 0; text-align:center;">
            ${btn(tipHref, "Say thanks — leave a tip & comment", "sky")}
          </div>
          <p style="margin:6px 0 14px; font-size:13px; color:${BRAND.gray700}; text-align:center;">
            Tips are optional. Pick <strong>$10</strong>, <strong>$20</strong>, <strong>$40</strong>, or enter a custom amount.
          </p>
        ` : ""}

        <div style="margin:10px 0; text-align:center;">
          ${btn(URLS.review, "★ Leave a Google review", "green")}
        </div>

        <hr style="border:none;border-top:1px solid ${BRAND.border};margin:18px 0;" />

        <p style="margin:0; font-size:14px; color:${BRAND.gray700};">
          Refer a friend and earn <strong>$20</strong> when they join. Have <strong>2+ addresses</strong>? Ask about our multi-address discount.
        </p>
        <p style="margin:8px 0 0; font-size:14px; color:${BRAND.gray700};">
          <strong>Premium</strong> members get priority support and our best value per visit.
        </p>
      `),
    };
  },

  booking_canceled: ({ name = "there", bookingNumber }) => ({
    subject: `Booking canceled — #${bookingNumber || ""}`,
    html: frame(`
      <h2 style="margin:0 0 8px">Your booking was canceled</h2>
      <p>Need another time? You can reschedule anytime.</p>
      <p style="margin-top:10px;">${btn(URLS.schedule, "Reschedule a visit")}</p>
    `),
  }),

  /* --------- NEW: Reminders for CONFIRMED bookings --------- */

  booking_reminder_24h: ({ name = "there", bookingNumber, date, service, address }) => ({
    subject: "Heads up for tomorrow — your Fixter visit",
    html: frame(`
      <h2 style="margin:0 0 8px">Hi ${name}, just a quick reminder.</h2>
      <p>Your Fixter visit is <strong>${formatNYCTime(date)}</strong>.</p>
      <ul style="margin:8px 0 12px 18px; padding:0;">
        <li><strong>Service:</strong> ${service || "-"}</li>
        <li><strong>Address:</strong> ${address || "-"}</li>
        <li><strong>Booking #:</strong> ${bookingNumber || "-"}</li>
      </ul>

      <p style="margin:12px 0;">Need a different time? ${btn(URLS.schedule, "Reschedule your visit")}</p>

      <p style="margin-top:14px; font-size:14px; color:${BRAND.gray700};">
        Thanks for trusting us with your home. If a friend or neighbor could use a personal handyman,
        please share our info—your word helps us keep improving for you.
      </p>
    `),
  }),

  booking_reminder_60m: ({ name = "there", date }) => ({
    subject: "We’re on the way — see you soon",
    html: frame(`
      <h2 style="margin:0 0 8px">See you soon, ${name}!</h2>
      <p>Your Fixter is scheduled <strong>${formatNYCTime(date)}</strong> and is on the way.</p>

      <div style="margin:12px 0 10px; padding:12px; background:${BRAND.gray100}; border-radius:10px;">
        <div style="font-weight:700; margin-bottom:6px;">Helpful before we arrive:</div>
        <ul style="margin:0 0 0 18px; padding:0;">
          <li>Clear the work area if you can</li>
          <li>Keep pets comfy and safe</li>
          <li>Have any materials ready (if needed)</li>
        </ul>
      </div>

      ${linkRow([
        { text: "Text or Call 631-599-1363", href: URLS.supportSMS },
        { text: "Reschedule", href: URLS.schedule }
      ])}

      <p style="margin-top:14px; font-size:14px; color:${BRAND.gray700};">
        We respect your time and home—thanks for the same in return. Your trust means a lot.
        Sharing our service with friends helps us grow and keeps improving your experience.
      </p>
    `),
  }),

  /* --------- Password reset via link --------- */

  password_reset: ({ name = "there", link }) => ({
    subject: `Reset your password`,
    html: frame(`
      <h2 style="margin:0 0 8px">Reset your password</h2>
      <p>Click the button below to set a new password. The link expires in 30 minutes.</p>
      <p style="margin-top:16px;">${btn(link, "Reset password")}</p>
      <p style="margin-top:12px; font-size:13px; color:${BRAND.gray700};">
        If the button doesn't work, paste this link into your browser:<br>
        <a href="${link}" style="color:#0b5cab; word-break:break-all;">${link}</a>
      </p>
    `),
  }),

  /* --------- Nudge for not-subscribed --------- */

  nudge_subscribe: ({ name = "there" }) => ({
    subject: "Make home care easy — pick your Fixter plan",
    html: frame(`
      <h2 style="margin:0 0 8px">Hey ${name}, ready to try your Fixter?</h2>
      <p>Choose a plan to unlock easy, reliable, personal handyman help. We recommend <strong>Premium</strong> for the best value and quicker turnarounds.</p>
      <p style="margin:14px 0 0;">${btn(URLS.plans, "See plans & subscribe")}</p>
      <p style="margin-top:14px; font-size:14px; color:${BRAND.gray700};">
        Earn <strong>$20</strong> when a friend joins, and ask about our <strong>2+ address</strong> discount.
      </p>
    `),
  }),

  /* --------- Generic promo --------- */

  promo_generic: ({ title = "Special offer", body = "", ctaText = "Learn more", ctaUrl = URLS.site }) => ({
    subject: title,
    html: frame(`
      <h2 style="margin:0 0 8px">${title}</h2>
      <p>${body}</p>
      <p style="margin-top:16px;">${btn(ctaUrl, ctaText, "dark")}</p>
    `),
  }),
};

/* ============= Send wrappers ============= */

const BCC_ADMIN = new Set(["welcome", "subscription_started", "booking_created"]);

async function sendRaw({ to, subject, html, bccAdmin = false, from = FROM, replyTo = REPLY_TO, headers = {} }) {
  const text = toText(html);
  const mail = {
    from,
    to,
    subject,
    html,
    text,
    replyTo,
    headers: { "X-Entity-Ref-ID": Date.now().toString(), ...headers },
  };
  if (bccAdmin && ADMIN) mail.bcc = ADMIN;

  const info = await transporter.sendMail(mail);
  if (process.env.NODE_ENV !== "production") {
    console.log("Mail sent:", info.messageId, "to", to);
  }
  return info;
}

async function sendTx(key, to, vars = {}, opts = {}) {
  const t = TEMPLATES[key];
  if (!t) throw new Error(`Unknown template: ${key}`);
  const { subject, html } = t(vars);
  const bccAdmin = opts.bccAdmin ?? BCC_ADMIN.has(key);
  return sendRaw({ to, subject, html, bccAdmin });
}

async function sendPromo(to, { subject, html, headers = {} }) {
  return sendRaw({ to, subject, html, headers, from: MARKETING_FROM, bccAdmin: false });
}

module.exports = { sendTx, sendPromo, TEMPLATES, formatNYCTime };
