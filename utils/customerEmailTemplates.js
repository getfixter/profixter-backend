function createCustomerEmailTemplates({
  escapeHtml,
  formatNYCTime,
  urls,
}) {
  const SUPPORT_EMAIL = "hello@profixter.com";
  const TIP_URL = "https://www.profixter.com/tip";
  const REVIEW_URL = "https://www.profixter.com/review";
  const ACCOUNT_URL = "https://www.profixter.com/account";

  const safe = (value, fallback = "") =>
    escapeHtml(String(value || fallback).trim());

  const button = (href, label) => `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0 8px;">
      <tr>
        <td bgcolor="#1d4ed8" style="border-radius:8px;">
          <a href="${escapeHtml(href)}"
             style="display:inline-block;padding:13px 20px;border:1px solid #1d4ed8;border-radius:8px;background:#1d4ed8;color:#ffffff;font-family:Arial,'Helvetica Neue',sans-serif;font-size:15px;font-weight:700;line-height:20px;text-decoration:none;">
            ${escapeHtml(label)}
          </a>
        </td>
      </tr>
    </table>`;

  const detailCard = (rows) => `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
           style="margin:20px 0;border:1px solid #dbe2ea;border-radius:10px;background:#f8fafc;">
      ${rows
        .filter((row) => row.value)
        .map(
          (row) => `
            <tr>
              <td style="padding:10px 14px;color:#64748b;font-size:13px;line-height:18px;width:34%;vertical-align:top;">${escapeHtml(row.label)}</td>
              <td style="padding:10px 14px;color:#172033;font-size:14px;font-weight:600;line-height:20px;vertical-align:top;">${escapeHtml(row.value)}</td>
            </tr>`
        )
        .join("")}
    </table>`;

  const frame = (content, { preheader = "" } = {}) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Profixter</title>
  <style>
    body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
    table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
    table { border-collapse:collapse !important; }
    img { border:0; height:auto; line-height:100%; outline:none; text-decoration:none; }
    @media only screen and (max-width:620px) {
      .email-shell { width:100% !important; border-radius:0 !important; }
      .email-pad { padding:24px 20px !important; }
      .email-header { padding:20px !important; }
      .email-footer { padding:18px 20px !important; }
    }
    @media (prefers-color-scheme: dark) {
      body, .email-bg { background:#111827 !important; }
      .email-shell, .email-body { background:#1f2937 !important; }
      .email-body, .email-body h1, .email-body h2, .email-body p, .email-body li { color:#f8fafc !important; }
      .email-header, .email-footer { background:#111827 !important; }
      .email-muted { color:#cbd5e1 !important; }
    }
  </style>
</head>
<body class="email-bg" style="margin:0;padding:0;background:#eef2f6;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">
    ${escapeHtml(preheader)}
  </div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="email-bg" style="width:100%;background:#eef2f6;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" class="email-shell"
               style="width:100%;max-width:600px;border:1px solid #dbe2ea;border-radius:12px;background:#ffffff;overflow:hidden;">
          <tr>
            <td class="email-header" style="padding:22px 28px;border-bottom:1px solid #dbe2ea;background:#f8fafc;">
              <div style="font-family:Arial,'Helvetica Neue',sans-serif;font-size:22px;font-weight:800;line-height:28px;color:#172033;">Profixter</div>
              <div class="email-muted" style="margin-top:3px;font-family:Arial,'Helvetica Neue',sans-serif;font-size:12px;line-height:18px;color:#64748b;">
                Based in Babylon &bull; Serving Nassau &amp; Suffolk Counties
              </div>
            </td>
          </tr>
          <tr>
            <td class="email-body email-pad" style="padding:30px 28px;background:#ffffff;color:#172033;font-family:Arial,'Helvetica Neue',sans-serif;font-size:16px;line-height:25px;">
              ${content}
            </td>
          </tr>
          <tr>
            <td class="email-footer" style="padding:18px 28px;border-top:1px solid #dbe2ea;background:#f8fafc;color:#64748b;font-family:Arial,'Helvetica Neue',sans-serif;font-size:12px;line-height:19px;">
              <div>Questions? Reply to this email or contact <a href="mailto:${SUPPORT_EMAIL}" style="color:#1d4ed8;text-decoration:underline;">${SUPPORT_EMAIL}</a>.</div>
              <div style="margin-top:8px;">Profixter &bull; Babylon, New York &bull; Serving Nassau &amp; Suffolk Counties</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const email = ({ subject, preheader, content, text }) => ({
    subject,
    html: frame(content, { preheader }),
    text,
  });

  const greeting = (name) => `Hi ${safe(name, "there")},`;
  const textDetails = (rows) =>
    rows
      .filter((row) => row.value)
      .map((row) => `${row.label}: ${row.value}`)
      .join("\n");

  return {
    password_otp: ({ name = "there", otp }) =>
      email({
        subject: "Your Profixter verification code",
        preheader: "Use this code to reset your Profixter password.",
        content: `
          <h1 style="margin:0 0 16px;font-size:24px;line-height:31px;">Password verification code</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0 0 16px;">Use this code to reset your password. It expires in five minutes.</p>
          <div style="display:inline-block;margin:4px 0 18px;padding:12px 16px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;color:#172033;font-size:30px;font-weight:700;letter-spacing:5px;">${safe(otp)}</div>
          <p class="email-muted" style="margin:0;color:#64748b;font-size:14px;">If you did not request this, you can ignore this email.</p>`,
        text: `${greeting(name)}\n\nYour Profixter verification code is ${otp}. It expires in five minutes.\n\nIf you did not request this, you can ignore this email.\n\n${SUPPORT_EMAIL}`,
      }),

    password_changed: ({ name = "there" }) =>
      email({
        subject: "Your Profixter password was updated",
        preheader: "Your account password has been changed.",
        content: `
          <h1 style="margin:0 0 16px;font-size:24px;line-height:31px;">Password updated</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0;">This confirms that your Profixter password was changed. If you did not make this change, contact us at <a href="mailto:${SUPPORT_EMAIL}" style="color:#1d4ed8;">${SUPPORT_EMAIL}</a>.</p>`,
        text: `${greeting(name)}\n\nYour Profixter password was changed. If you did not make this change, contact ${SUPPORT_EMAIL}.`,
      }),

    welcome: ({ name = "there", userId }) =>
      email({
        subject: "Welcome to Profixter",
        preheader: "Your Profixter account is ready.",
        content: `
          <h1 style="margin:0 0 16px;font-size:26px;line-height:33px;">Welcome to Profixter</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0 0 16px;">Your account is ready. Profixter provides scheduled home maintenance and small-repair visits for homeowners across Nassau and Suffolk Counties.</p>
          ${userId ? detailCard([{ label: "Member ID", value: String(userId) }]) : ""}
          <p style="margin:0 0 10px;font-weight:700;">How visits work</p>
          <ul style="margin:0 0 18px;padding-left:20px;">
            <li style="margin-bottom:7px;">Choose one clear task for each visit.</li>
            <li style="margin-bottom:7px;">Visits include up to 90 minutes of labor.</li>
            <li>Have the work area and any required materials ready.</li>
          </ul>
          ${button(urls.plans, "View membership options")}
          <p class="email-muted" style="margin:18px 0 0;color:#64748b;font-size:14px;">If you have a question before getting started, reply to this email. We are happy to help.</p>`,
        text: `${greeting(name)}\n\nWelcome to Profixter. Your account is ready.${userId ? `\nMember ID: ${userId}` : ""}\n\nEach visit focuses on one clear task and includes up to 90 minutes of labor.\n\nView membership options: ${urls.plans}\n\n${SUPPORT_EMAIL}`,
      }),

    subscription_started: ({ name = "there", plan, billingCycle, address }) => {
      const rows = [
        { label: "Plan", value: plan || "" },
        {
          label: "Billing",
          value: billingCycle === "annual" ? "Annual" : "Monthly",
        },
        { label: "Service address", value: address || "" },
      ];
      return email({
        subject: "Your Profixter membership is active",
        preheader: "Your membership is active and ready to use.",
        content: `
          <h1 style="margin:0 0 16px;font-size:26px;line-height:33px;">Your membership is active</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0 0 16px;">Thank you for choosing Profixter. Your membership is active, and you can now schedule a visit for your home.</p>
          ${detailCard(rows)}
          ${button(urls.schedule, "Schedule a visit")}
          <p class="email-muted" style="margin:18px 0 0;color:#64748b;font-size:14px;">You can review your membership and billing details from your Profixter account.</p>`,
        text: `${greeting(name)}\n\nYour Profixter membership is active.\n\n${textDetails(rows)}\n\nSchedule a visit: ${urls.schedule}\nAccount: ${ACCOUNT_URL}\n\n${SUPPORT_EMAIL}`,
      });
    },

    booking_created: ({ name = "there", bookingNumber, date, service, address }) => {
      const rows = [
        { label: "Booking", value: bookingNumber ? `#${bookingNumber}` : "" },
        { label: "Service", value: service || "" },
        { label: "Requested time", value: date ? formatNYCTime(date) : "" },
        { label: "Address", value: address || "" },
      ];
      return email({
        subject: `We received your Profixter booking${bookingNumber ? ` #${bookingNumber}` : ""}`,
        preheader: "Your booking request has been received.",
        content: `
          <h1 style="margin:0 0 16px;font-size:26px;line-height:33px;">Booking received</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0 0 16px;">We received your booking request. We will send another email when the appointment is confirmed.</p>
          ${detailCard(rows)}
          <p class="email-muted" style="margin:0;color:#64748b;font-size:14px;">Please keep the work area accessible and have any required materials available before the visit.</p>`,
        text: `${greeting(name)}\n\nWe received your Profixter booking request. We will email you again when it is confirmed.\n\n${textDetails(rows)}\n\n${SUPPORT_EMAIL}`,
      });
    },

    booking_confirmed: ({ name = "there", bookingNumber, date, service, address }) => {
      const rows = [
        { label: "Booking", value: bookingNumber ? `#${bookingNumber}` : "" },
        { label: "Service", value: service || "" },
        { label: "Date and time", value: date ? formatNYCTime(date) : "" },
        { label: "Address", value: address || "" },
      ];
      return email({
        subject: `Your Profixter booking is confirmed${bookingNumber ? ` — #${bookingNumber}` : ""}`,
        preheader: "Your Profixter appointment is confirmed.",
        content: `
          <h1 style="margin:0 0 16px;font-size:26px;line-height:33px;">Your appointment is confirmed</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0 0 16px;">Your appointment is on the schedule. We will send a reminder before the visit.</p>
          ${detailCard(rows)}
          <p style="margin:0 0 10px;font-weight:700;">Before we arrive</p>
          <ul style="margin:0;padding-left:20px;">
            <li style="margin-bottom:7px;">Clear the immediate work area when possible.</li>
            <li style="margin-bottom:7px;">Have fixtures or materials on site if the task requires them.</li>
            <li>Reply to this email if the scope or access details change.</li>
          </ul>`,
        text: `${greeting(name)}\n\nYour Profixter appointment is confirmed.\n\n${textDetails(rows)}\n\nPlease have the work area and any required materials ready.\n\n${SUPPORT_EMAIL}`,
      });
    },

    booking_completed: ({ name = "there", bookingNumber }) =>
      email({
        subject: `Your Profixter appointment is complete${bookingNumber ? ` — #${bookingNumber}` : ""}`,
        preheader: "Your Profixter appointment has been marked complete.",
        content: `
          <h1 style="margin:0 0 16px;font-size:26px;line-height:33px;">Appointment complete</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0 0 16px;">Thank you for inviting Profixter into your home. Booking ${bookingNumber ? `<strong>#${safe(bookingNumber)}</strong>` : ""} has been marked complete.</p>
          <p style="margin:0 0 16px;">If notes or photos were added to your appointment, they may be available with your booking information.</p>
          <p style="margin:0;">If you would like to thank your Fixter, leaving a tip is always optional.</p>
          ${button(TIP_URL, "Leave an optional tip")}`,
        text: `${greeting(name)}\n\nYour Profixter appointment${bookingNumber ? ` #${bookingNumber}` : ""} is complete. Thank you for choosing us.\n\nIf notes or photos were added, they may be available with your booking information.\n\nOptional tip: ${TIP_URL}\n\n${SUPPORT_EMAIL}`,
      }),

    booking_review_request: ({ name = "there", bookingNumber }) =>
      email({
        subject: "How did we do?",
        preheader: "We would appreciate your honest feedback.",
        content: `
          <h1 style="margin:0 0 16px;font-size:26px;line-height:33px;">How did we do?</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0 0 16px;">Thank you again for choosing Profixter${bookingNumber ? ` for booking <strong>#${safe(bookingNumber)}</strong>` : ""}.</p>
          <p style="margin:0;">If you have a moment, we would appreciate an honest review. Your feedback helps us improve and helps local homeowners find dependable home service.</p>
          ${button(REVIEW_URL, "Share your feedback")}`,
        text: `${greeting(name)}\n\nThank you again for choosing Profixter${bookingNumber ? ` for booking #${bookingNumber}` : ""}. We would appreciate your honest feedback.\n\nReviews help us improve and help local homeowners find dependable service.\n\nShare your feedback: ${REVIEW_URL}\n\n${SUPPORT_EMAIL}`,
      }),

    booking_canceled: ({ name = "there", bookingNumber, address }) => {
      const rows = [
        { label: "Booking", value: bookingNumber ? `#${bookingNumber}` : "" },
        { label: "Address", value: address || "" },
      ];
      return email({
        subject: `Your Profixter booking was canceled${bookingNumber ? ` — #${bookingNumber}` : ""}`,
        preheader: "Your booking has been canceled.",
        content: `
          <h1 style="margin:0 0 16px;font-size:26px;line-height:33px;">Booking canceled</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0 0 16px;">This confirms that your Profixter booking has been canceled.</p>
          ${detailCard(rows)}
          <p style="margin:0;">If you still need help, you can schedule another visit when the timing works for you.</p>
          ${button(urls.schedule, "Schedule another visit")}`,
        text: `${greeting(name)}\n\nYour Profixter booking has been canceled.\n\n${textDetails(rows)}\n\nSchedule another visit: ${urls.schedule}\n\n${SUPPORT_EMAIL}`,
      });
    },

    booking_reminder_24h: ({
      name = "there",
      bookingNumber,
      date,
      service,
      address,
    }) => {
      const rows = [
        { label: "Booking", value: bookingNumber ? `#${bookingNumber}` : "" },
        { label: "Service", value: service || "" },
        { label: "Date and time", value: date ? formatNYCTime(date) : "" },
        { label: "Address", value: address || "" },
      ];
      return email({
        subject: "Reminder: your Profixter appointment is tomorrow",
        preheader: "A reminder about your upcoming Profixter appointment.",
        content: `
          <h1 style="margin:0 0 16px;font-size:26px;line-height:33px;">Appointment reminder</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0 0 16px;">This is a reminder that your Profixter appointment is coming up tomorrow.</p>
          ${detailCard(rows)}
          <p style="margin:0;">Please have the work area accessible and any required materials ready.</p>
          ${button(urls.schedule, "Manage your appointment")}`,
        text: `${greeting(name)}\n\nThis is a reminder that your Profixter appointment is tomorrow.\n\n${textDetails(rows)}\n\nManage your appointment: ${urls.schedule}\n\n${SUPPORT_EMAIL}`,
      });
    },

    booking_reminder_60m: ({ name = "there", date }) =>
      email({
        subject: "Your Profixter appointment is coming up",
        preheader: "Your Profixter appointment begins soon.",
        content: `
          <h1 style="margin:0 0 16px;font-size:26px;line-height:33px;">We will see you soon</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0 0 16px;">Your Profixter appointment is scheduled for <strong>${safe(date ? formatNYCTime(date) : "")}</strong>.</p>
          <p style="margin:0 0 10px;font-weight:700;">A quick checklist</p>
          <ul style="margin:0 0 18px;padding-left:20px;">
            <li style="margin-bottom:7px;">Clear the immediate work area if possible.</li>
            <li style="margin-bottom:7px;">Keep pets safely away from the work area.</li>
            <li>Have any required fixtures or materials ready.</li>
          </ul>
          ${button(urls.schedule, "Manage your appointment")}`,
        text: `${greeting(name)}\n\nYour Profixter appointment is scheduled for ${date ? formatNYCTime(date) : "soon"}.\n\nPlease clear the work area, keep pets safe, and have any required materials ready.\n\nManage your appointment: ${urls.schedule}\n\n${SUPPORT_EMAIL}`,
      }),

    subscription_cancellation_scheduled: ({
      name = "there",
      plan,
      address,
      accessEndDate,
    }) => {
      const rows = [
        { label: "Plan", value: plan || "" },
        { label: "Address", value: address || "" },
        { label: "Access ends", value: accessEndDate || "" },
      ];
      return email({
        subject: "Your Profixter cancellation is scheduled",
        preheader: "Your membership remains active until the listed end date.",
        content: `
          <h1 style="margin:0 0 16px;font-size:26px;line-height:33px;">Cancellation scheduled</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0 0 16px;">We scheduled your membership cancellation as requested. Your access remains active until the end date shown below.</p>
          ${detailCard(rows)}
          <p style="margin:0;">You can review your membership details or reactivate before the end date from your account.</p>
          ${button(`${ACCOUNT_URL}?tab=plan`, "View membership details")}`,
        text: `${greeting(name)}\n\nYour Profixter membership cancellation is scheduled. Your access remains active until the listed end date.\n\n${textDetails(rows)}\n\nView membership details: ${ACCOUNT_URL}?tab=plan\n\n${SUPPORT_EMAIL}`,
      });
    },

    subscription_canceled: ({ name = "there", plan, address, canceledDate }) => {
      const rows = [
        { label: "Plan", value: plan || "" },
        { label: "Address", value: address || "" },
        { label: "Ended", value: canceledDate || "" },
      ];
      return email({
        subject: "Your Profixter membership has ended",
        preheader: "Your Profixter membership is no longer active.",
        content: `
          <h1 style="margin:0 0 16px;font-size:26px;line-height:33px;">Membership ended</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0 0 16px;">Your Profixter membership is no longer active.</p>
          ${detailCard(rows)}
          <p style="margin:0;">Your account, addresses, and booking history remain available if you decide to return.</p>
          ${button(urls.plans, "View membership options")}`,
        text: `${greeting(name)}\n\nYour Profixter membership has ended.\n\n${textDetails(rows)}\n\nYour account and history remain available.\n\nMembership options: ${urls.plans}\n\n${SUPPORT_EMAIL}`,
      });
    },

    payment_failed: ({ name = "there", plan, amount, billingDate }) => {
      const rows = [
        { label: "Plan", value: plan || "" },
        { label: "Amount", value: amount || "" },
        { label: "Billing date", value: billingDate || "" },
      ];
      return email({
        subject: "Action needed: update your Profixter payment method",
        preheader: "We could not process your membership payment.",
        content: `
          <h1 style="margin:0 0 16px;font-size:26px;line-height:33px;">Payment method needs attention</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0 0 16px;">We could not process your Profixter membership payment. Please review your payment method to avoid an interruption in service.</p>
          ${detailCard(rows)}
          ${button(`${ACCOUNT_URL}?tab=plan`, "Review billing details")}
          <p class="email-muted" style="margin:18px 0 0;color:#64748b;font-size:14px;">If you recently updated your payment method, no further action may be needed.</p>`,
        text: `${greeting(name)}\n\nWe could not process your Profixter membership payment. Please review your payment method to avoid an interruption in service.\n\n${textDetails(rows)}\n\nReview billing details: ${ACCOUNT_URL}?tab=plan\n\n${SUPPORT_EMAIL}`,
      });
    },

    nudge_subscribe: ({ name = "there" }) =>
      email({
        subject: "Your Profixter account is ready when you need it",
        preheader: "A simple overview of Profixter membership options.",
        content: `
          <h1 style="margin:0 0 16px;font-size:26px;line-height:33px;">Home maintenance when you need it</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0 0 16px;">Your Profixter account is ready. A membership lets you schedule planned home-maintenance and small-repair visits with a local team.</p>
          <p style="margin:0;">You can compare the available options whenever the timing is right for your home.</p>
          ${button(urls.plans, "View membership options")}`,
        text: `${greeting(name)}\n\nYour Profixter account is ready. A membership lets you schedule planned home-maintenance and small-repair visits.\n\nView membership options: ${urls.plans}\n\n${SUPPORT_EMAIL}`,
      }),

    nurture_1: ({ name = "there" }) =>
      email({
        subject: "Getting started with Profixter",
        preheader: "Here is how a Profixter membership works.",
        content: `
          <h1 style="margin:0 0 16px;font-size:26px;line-height:33px;">Getting started</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0 0 16px;">Your account is set up. When you are ready, choose a membership and schedule a visit for one clear home-maintenance or small-repair task.</p>
          <p style="margin:0;">Each visit includes up to 90 minutes of labor. You choose the date, describe the task, and add photos so the team can prepare.</p>
          ${button(urls.plans, "Explore membership options")}`,
        text: `${greeting(name)}\n\nYour Profixter account is set up. Choose a membership when you are ready to schedule home-maintenance or small-repair visits.\n\nEach visit includes up to 90 minutes of labor.\n\nExplore membership options: ${urls.plans}\n\n${SUPPORT_EMAIL}`,
      }),

    nurture_2: ({ name = "there" }) =>
      email({
        subject: "What to expect from a Profixter visit",
        preheader: "One clear task and up to 90 minutes of labor.",
        content: `
          <h1 style="margin:0 0 16px;font-size:26px;line-height:33px;">What to expect from a visit</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0 0 16px;">A Profixter visit focuses on one clear task and includes up to 90 minutes of labor.</p>
          <p style="margin:0;">Typical visits include fixture replacement, minor plumbing repairs, drywall patches, mounting, caulking, door adjustments, and similar planned work. If a task is outside the visit scope, the team will explain that before work begins.</p>
          ${button(urls.plans, "View membership options")}`,
        text: `${greeting(name)}\n\nA Profixter visit focuses on one clear task and includes up to 90 minutes of labor.\n\nTypical visits cover planned maintenance and small repairs. If a task is outside the visit scope, we will explain that before work begins.\n\nView membership options: ${urls.plans}\n\n${SUPPORT_EMAIL}`,
      }),

    nurture_3: ({ name = "there" }) =>
      email({
        subject: "Your Profixter account will remain available",
        preheader: "Your account will be here whenever you need home help.",
        content: `
          <h1 style="margin:0 0 16px;font-size:26px;line-height:33px;">Your account will remain available</h1>
          <p style="margin:0 0 16px;">${greeting(name)}</p>
          <p style="margin:0 0 16px;">This is the last message in our getting-started series.</p>
          <p style="margin:0;">Your account and saved address will remain available. If a home-maintenance task comes up later, you can review membership options and schedule a visit then.</p>
          ${button(urls.plans, "View membership options")}`,
        text: `${greeting(name)}\n\nThis is the last message in our getting-started series. Your Profixter account and saved address will remain available.\n\nView membership options: ${urls.plans}\n\n${SUPPORT_EMAIL}`,
      }),
  };
}

module.exports = { createCustomerEmailTemplates };
