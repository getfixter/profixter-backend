// 📁 backend/routes/freeVisitRequests.js
/*
 * The homepage free visit, asked for in one step and without an account.
 *
 * Cold traffic from Meta ads lands on the homepage, describes the job, picks a
 * day and time, and types a name, mobile and email. One press of "Book my free
 * visit" sends all of it here. Nothing else is asked: no address, no password,
 * no /signup.
 *
 * WHAT THIS IS. In one transaction: a Request (serviceType
 * "free_visit_request", status "pending_confirmation") in the Leads list, and
 * a Booking "Pending Confirmation" whose slot the reservation engine holds -
 * the same rules, buckets and conflict checks as every other visit, so the time
 * is gone for everyone else at once. The owner calls, adds the address, and
 * confirms it in Admin (utils/freeVisit/guestVisit). The one-free-visit-per-
 * person rule is checked under a lock inside that transaction
 * (utils/freeVisit/eligibility). The account can come later; nothing here
 * waits on it.
 *
 * After the Request is saved, and never before:
 *   - the owner gets an email and a text with everything needed to call back;
 *   - the customer gets the confirmation email and text;
 *   - Meta gets the server half of the Lead, with the event id the browser sent,
 *     so the browser's fbq Lead and this one collapse into one conversion.
 * None of those can fail the request. The lead is the thing worth keeping.
 */
const express = require("express");
const multer = require("multer");
const moment = require("moment-timezone");

const Request = require("../models/Request");
const User = require("../models/User");
const mail = require("../utils/emailService");
const metaCapi = require("../utils/metaCapi");
const { deletePublicObjects, putPublicObject } = require("../utils/s3");
const { reserveGuestFreeVisit } = require("../utils/freeVisit/guestVisit");
const { CUSTOMER_MESSAGES } = require("../utils/freeVisit/eligibility");
const { libraryLabel, readLibraryReference } = require("../utils/bookingLibrary");
const { MAX_PHOTO_BYTES, MAX_PHOTOS, ensureSanitized, sanitizeUploadedPhotos } = require("../utils/imageSanitizer");
const { normalizePhoneE164 } = require("../utils/identity");
const { rateLimit, consume } = require("../utils/rateLimit");
const { sendAdminEventNotification, formatSubmittedAt } = require("../utils/adminLeadNotification");
const { sendTransactionalSms } = require("../utils/sms/smsService");
const { customerDayAvailability } = require("../utils/customerCalendarService");
const { reservationEngineEnabled } = require("../utils/slotReservationService");

const router = express.Router();

const TIMEZONE = "America/New_York";
const SITE = (process.env.CLIENT_URL || "https://www.profixter.com").replace(/\/+$/, "");
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = (process.env.S3_PREFIX || "uploads").replace(/\/+$/, "");
const MAX_DAYS_AHEAD = 150;

/*
 * The consent line, word for word as the booker shows it. The browser sends
 * back the text it displayed, and the request is refused unless it matches, so
 * the stored evidence is always the sentence the person actually saw.
 */
const CONTACT_CONSENT_TEXT =
  "By booking, you agree to be contacted by call or text about your visit. Msg & data rates may apply.";

/* The URL parameters worth keeping: UTMs, click ids, and Meta's ad ids. */
const URL_PARAM_KEYS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "gbraid", "wbraid", "campaign_id", "adset_id", "ad_id",
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS },
});

/*
 * Loose on purpose: phones share carrier NAT. Ten an hour from one address is
 * far more than a household needs and far less than a script wants.
 */
const ipLimit = rateLimit({
  limit: 10,
  windowMs: 60 * 60 * 1000,
  keyResolver: (req) => `free_visit_ip:${String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim()}`,
  message: "Too many requests just now. Please call or text 631-599-1363.",
});

function clean(value, max = 200) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function parseJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function pickUrlParams(raw) {
  const out = {};
  for (const key of URL_PARAM_KEYS) {
    const value = clean(raw?.[key], 300);
    if (value) out[key] = value;
  }
  return out;
}

/* Only short scalar values from the stored first touch; never an object dump. */
function pickFirstTouch(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {}).slice(0, 40)) {
    if (["string", "number", "boolean"].includes(typeof value)) out[clean(key, 40)] = typeof value === "string" ? clean(value, 300) : value;
  }
  return out;
}

function formatPhone(e164) {
  const d = String(e164 || "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(e164 || "");
}

function sourceLabel(attribution = {}) {
  const url = attribution.url || {};
  const first = attribution.firstTouch || {};
  const src = url.utm_source || first.utmSource || "";
  const medium = url.utm_medium || first.utmMedium || "";
  if (src || medium) return [src, medium].filter(Boolean).join(" / ");
  if (url.fbclid || first.fbclid) return "Meta (fbclid)";
  if (url.gclid || first.gclid) return "Google Ads (gclid)";
  return "";
}

const safeName = (name) =>
  String(name || "photo").normalize("NFKD").replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_").slice(0, 80);

async function uploadPhotos(files, requestId) {
  if (!files.length) return { urls: [], keys: [] };
  if (!S3_BUCKET) return { urls: files.map((f) => `local://${safeName(f.originalname)}`), keys: [] };
  const urls = [];
  const keys = [];
  for (const [i, file] of files.entries()) {
    const ready = await ensureSanitized(file);
    // No customer filename in the key: it is a public URL (see the photo-bucket follow-up).
    const key = `${S3_PREFIX}/free-visit-requests/${requestId}/${Date.now()}-${i + 1}${ready.ext}`;
    urls.push(await putPublicObject({ Bucket: S3_BUCKET, Key: key, Body: ready.buffer, ContentType: ready.contentType }));
    keys.push(key);
  }
  return { urls, keys };
}

/* A soft check: the slot is not held, but asking for a closed one is refused. */
async function slotIsOffered(date, time) {
  if (!reservationEngineEnabled()) return true;
  try {
    const day = await customerDayAvailability({ date });
    return Array.isArray(day?.slots) && day.slots.includes(time);
  } catch (error) {
    // The calendar being unreadable must not cost us the lead; the owner confirms by phone.
    console.warn("free_visit_request slot check failed:", error.message);
    return true;
  }
}

async function existingAccountNote(email, phone) {
  try {
    const digits = String(phone).replace(/\D/g, "").slice(-10);
    const user = await User.findOne({
      $or: [{ email }, { phone: { $in: [phone, digits, `1${digits}`, formatPhone(phone)] } }],
    }).select("_id userId email").lean();
    return user ? `Yes - an account already uses this ${user.email === email ? "email" : "phone"} (${user.userId || user._id})` : "No";
  } catch {
    return "Unknown";
  }
}

async function notifyOwner(request, { when, existingAccount, booking = null }) {
  const attribution = request.attribution || {};
  const url = attribution.url || {};
  const photos = request.images || [];
  const sections = [
    {
      title: "Call them to confirm",
      fields: [
        ["Name", request.name],
        ["Mobile", formatPhone(request.phone)],
        ["Email", request.email],
        ["Requested", when],
      ],
    },
    {
      title: "The job",
      fields: [
        ["Description", request.message],
        ["Photos", photos.length ? photos.join("\n") : "None"],
        ...(request.libraryReference ? [["Example chosen", libraryLabel(request.libraryReference) || request.libraryReference]] : []),
      ],
    },
    {
      title: "Where they came from",
      fields: [
        ["Source", sourceLabel(attribution) || "Direct / unknown"],
        ...URL_PARAM_KEYS.filter((k) => url[k]).map((k) => [k, url[k]]),
        ["Page", request.contactConsent?.pageUrl || request.sourcePage || "/"],
      ],
    },
    ...(booking?.freeVisitReview?.required
      ? [
          {
            title: "Verify before confirming",
            fields: [
              ["Possible repeat", (booking.freeVisitReview.reasons || []).join(", ").replace(/_/g, " ")],
              [
                "Matches",
                (booking.freeVisitReview.matches || [])
                  .map((m) => `${m.bookingNumber ? `#${m.bookingNumber}` : m.source} (${m.status}; same ${m.matchedOn.join(" + ")})`)
                  .join("\n"),
              ],
            ],
          },
        ]
      : []),
    {
      title: "Record",
      fields: [
        ["Status", booking ? "Pending confirmation - the slot is reserved on the calendar until you confirm or decline" : "Pending confirmation - no slot is held"],
        ...(booking ? [["Booking", `#${booking.bookingNumber}`]] : []),
        ["Existing account", existingAccount],
        ["Submitted", formatSubmittedAt(request.createdAt)],
        ["Consent shown", request.contactConsent?.text || ""],
        ["Lead id", String(request._id)],
      ],
    },
  ];

  const results = await Promise.allSettled([
    sendAdminEventNotification({
      subject: `New free visit request: ${request.name} - ${when}`,
      heading: "New free visit request",
      sections,
      templateKey: "admin_free_visit_request",
      replyToEmail: request.email,
      name: request.name,
      email: request.email,
      source: "free_visit_request",
    }),
    sendTransactionalSms({
      notificationType: "OWNER_LEAD_ALERT",
      dedupeKey: `owner_lead_alert:${request._id}`,
      phone: process.env.OWNER_ALERT_PHONE || "",
      vars: {
        name: request.name,
        phone: formatPhone(request.phone),
        when,
        job: request.message,
        photos: photos.length,
        source: sourceLabel(attribution),
      },
      source: "free_visit_request",
    }),
  ]);
  return results;
}

async function notifyCustomer(request, { when }) {
  const firstName = clean(request.name, 60).split(" ")[0];
  const line = `Got it! A Profixter team member will call you shortly to confirm your free visit on ${when}.`;
  const setupUrl = `${SITE}/signup`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff;color:#0B1628;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55;">
<div style="max-width:520px;margin:0 auto;">
<p style="margin:0 0 16px;">Hi ${mailEscape(firstName)},</p>
<p style="margin:0 0 16px;font-weight:700;">${mailEscape(line)}</p>
<p style="margin:0 0 6px;color:#5b6577;">What you asked for:</p>
<p style="margin:0 0 20px;padding:12px 14px;background:#F6F8FC;border-radius:10px;">${mailEscape(request.message)}</p>
<p style="margin:0 0 20px;color:#5b6577;">Your free visit is 90 minutes of real work, at no charge. Questions before we call? Call or text 631-599-1363.</p>
<p style="margin:0 0 8px;color:#5b6577;">Optional, whenever you like: set up your Profixter account to see and manage your visits.</p>
<p style="margin:0 0 24px;"><a href="${setupUrl}" style="display:inline-block;padding:12px 18px;background:#306EEC;color:#ffffff;border-radius:10px;text-decoration:none;font-weight:700;">Set up your account</a></p>
<p style="margin:0;color:#94A3B8;font-size:13px;">Profixter · Long Island, NY</p>
</div></body></html>`;
  const text = `Hi ${firstName},\n\n${line}\n\nWhat you asked for:\n${request.message}\n\nYour free visit is 90 minutes of real work, at no charge. Questions before we call? Call or text 631-599-1363.\n\nOptional, whenever you like: set up your Profixter account to see and manage your visits: ${setupUrl}\n\nProfixter`;

  return Promise.allSettled([
    mail.sendRaw({
      to: request.email,
      subject: "Got it - we'll call to confirm your free visit",
      html,
      text,
      logContext: {
        templateKey: "free_visit_request_received",
        recipientEmail: request.email,
        customerName: request.name,
        customerEmail: request.email,
        source: "free_visit_request",
        emailType: "transactional",
      },
    }),
    sendTransactionalSms({
      notificationType: "FREE_VISIT_REQUEST_RECEIVED",
      dedupeKey: `free_visit_request_received:${request._id}`,
      phone: request.phone,
      vars: { when },
      requestConsent: {
        text: request.contactConsent?.text,
        at: request.contactConsent?.at,
        phone: request.phone,
      },
      source: "free_visit_request",
    }),
  ]);
}

function mailEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function logOutcomes(requestId, label, results) {
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`free_visit_request ${label}[${i}] failed`, { requestId: String(requestId), message: r.reason?.message });
    } else if (r.value && r.value.ok === false) {
      console.warn(`free_visit_request ${label}[${i}] not sent`, { requestId: String(requestId), status: r.value.status, reason: r.value.reason });
    }
  });
}

router.post("/", ipLimit, upload.array("images", MAX_PHOTOS), sanitizeUploadedPhotos, async (req, res) => {
  try {
    const body = req.body || {};
    const name = clean(body.name, 120);
    const email = clean(body.email, 200).toLowerCase();
    const phone = normalizePhoneE164(body.phone);
    const note = String(body.note || "").trim().slice(0, 1200);
    const date = clean(body.requestedDate, 10);
    const time = clean(body.requestedTime, 5);
    const eventId = clean(body.eventId, 100);
    const files = req.files || [];

    /* The form is a convenience; these are the rules. */
    if (name.length < 2 || !/\s/.test(name)) {
      return res.status(400).json({ code: "INVALID_NAME", field: "name", message: "Please enter your first and last name." });
    }
    if (!phone) {
      return res.status(400).json({ code: "INVALID_PHONE", field: "phone", message: "Please enter a valid 10-digit US mobile number." });
    }
    if (!validEmail(email)) {
      return res.status(400).json({ code: "INVALID_EMAIL", field: "email", message: "Please enter a valid email address." });
    }
    if (note.split(/\s+/).filter(Boolean).length < 3) {
      return res.status(400).json({ code: "NOTE_REQUIRED", field: "note", message: "Tell us in a few words what needs doing." });
    }
    if (clean(body.consentText, 300) !== CONTACT_CONSENT_TEXT) {
      return res.status(400).json({ code: "CONSENT_MISMATCH", message: "Please reload the page and try again." });
    }
    const library = readLibraryReference(body);
    if (!library.ok) return res.status(library.status).json({ code: library.code, message: library.message });

    const slot = moment.tz(`${date} ${time}`, "YYYY-MM-DD HH:mm", true, TIMEZONE);
    const today = moment.tz(TIMEZONE).startOf("day");
    if (!slot.isValid() || slot.isBefore(moment()) || slot.isAfter(today.clone().add(MAX_DAYS_AHEAD, "days"))) {
      return res.status(400).json({ code: "DATE_UNAVAILABLE", field: "date", message: "Please pick another day." });
    }
    /* The same press again (a retry, a double tap): the same answer, nothing new. */
    const dedupeKey = eventId ? `free_visit:${eventId}` : `free_visit:${phone}:${date}:${time}:${Math.floor(Date.now() / 600000)}`;
    if (await Request.exists({ dedupeKey })) {
      return res.status(200).json({ success: true, duplicate: true, when: slot.format("dddd, MMMM D [at] h:mm A"), eventId });
    }

    if (!(await slotIsOffered(date, time))) {
      return res.status(409).json({ code: "SLOT_UNAVAILABLE", message: "That time was just taken. Pick another - everything else is saved." });
    }

    /* Three requests a day from one number is a person changing their mind; more is not. */
    const perPhone = consume({ key: `free_visit_phone:${phone}`, limit: 3, windowMs: 24 * 60 * 60 * 1000 });
    if (!perPhone.allowed) {
      return res.status(429).json({ code: "TOO_MANY", message: "We already have your request. We'll call you shortly - or call or text 631-599-1363." });
    }

    const when = slot.format("dddd, MMMM D [at] h:mm A");
    const urlParams = pickUrlParams(parseJson(body.urlParams));
    const firstTouch = pickFirstTouch(parseJson(body.attribution));
    const pageUrl = clean(body.pageUrl, 500);

    const request = new Request({
      name,
      email,
      phone,
      message: note,
      serviceType: "free_visit_request",
      sourcePage: clean(body.sourcePage, 200) || "/",
      status: "pending_confirmation",
      requestedDate: date,
      requestedTime: time,
      requestedAt: slot.toDate(),
      libraryReference: library.key,
      attribution: { url: urlParams, firstTouch },
      contactConsent: {
        text: CONTACT_CONSENT_TEXT,
        at: new Date(),
        ip: String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim(),
        userAgent: clean(req.headers["user-agent"], 300),
        pageUrl,
      },
      metaEventId: eventId,
      // One press, one lead: a double tap or a retry of the same press carries the same event id.
      dedupeKey,
    });

    let uploadedKeys = [];
    try {
      const uploaded = await uploadPhotos(files, request._id);
      request.images = uploaded.urls;
      uploadedKeys = uploaded.keys;
    } catch (uploadErr) {
      // Keep the lead; the owner can ask for the photo on the call.
      console.error("free_visit_request photo upload failed; saving without photos", { message: uploadErr.message });
      request.images = [];
    }

    /*
     * The lead, the visit and its reserved slot: all three, or none.
     * The lifetime free-visit rule is re-checked inside, under the lock.
     */
    let booking = null;
    try {
      if (!reservationEngineEnabled()) {
        // Only where the reservation engine is off (never production): the
        // lead alone, as before requests reserved slots.
        await request.save();
      } else ({ booking } = await reserveGuestFreeVisit({
        request,
        slotStart: slot.toDate(),
        bookingData: {
          name,
          phone,
          email,
          note,
          images: request.images,
          libraryReference: library.key,
          guestContactConsent: {
            text: request.contactConsent.text,
            at: request.contactConsent.at,
            ip: request.contactConsent.ip,
          },
        },
      }));
    } catch (reserveErr) {
      if (uploadedKeys.length) {
        deletePublicObjects({ Bucket: S3_BUCKET, Keys: uploadedKeys }).catch(() => {});
      }
      // A concurrent copy of this same press won the race: it is one request.
      if (await Request.exists({ dedupeKey })) {
        return res.status(200).json({ success: true, duplicate: true, when, eventId });
      }
      if (reserveErr?.code === "FREE_VISIT_USED" || reserveErr?.code === "FREE_VISIT_ACTIVE") {
        return res.status(403).json({ code: reserveErr.code, message: CUSTOMER_MESSAGES[reserveErr.code] });
      }
      if (["SLOT_UNAVAILABLE", "SLOT_CONFLICT", "TECHNICIAN_UNAVAILABLE"].includes(reserveErr?.code)) {
        return res.status(409).json({ code: "SLOT_UNAVAILABLE", message: "That time was just taken. Pick another - everything else is saved." });
      }
      if (reserveErr?.code === "TRANSACTIONS_UNAVAILABLE") {
        return res.status(503).json({ code: "TRANSACTIONS_UNAVAILABLE", message: "Booking is temporarily unavailable. Please try again, or call or text 631-599-1363." });
      }
      throw reserveErr;
    }

    console.log("✅ Free visit request saved:", {
      id: String(request._id),
      booking: booking?.bookingNumber || "(no reservation engine)",
      date,
      time,
      review: booking?.freeVisitReview?.required ? booking.freeVisitReview.reasons : [],
      source: sourceLabel(request.attribution),
    });

    /* The server half of the Lead. Same event id as the browser's fbq call. */
    const [firstName, ...rest] = name.split(" ");
    metaCapi.sendDetached({
      eventName: "Lead",
      eventId: eventId || undefined,
      eventSourceUrl: pageUrl || undefined,
      customData: {
        content_name: "free_first_visit",
        status: "free_visit_requested",
        lead_type: "free_visit_request",
      },
      user: { email, phone, firstName, lastName: rest.join(" "), name },
      externalId: String(request._id),
      fbp: clean(body.fbp, 200) || undefined,
      fbc: clean(body.fbc, 300) || undefined,
      fbclid: urlParams.fbclid || firstTouch.fbclid,
      fbclidAt: typeof firstTouch.fbclidAt === "number" ? firstTouch.fbclidAt : undefined,
      req,
    });

    /* Notifications after the answer is decided, and never able to change it. */
    const existingAccount = await existingAccountNote(email, phone);
    Promise.resolve()
      .then(async () => {
        logOutcomes(request._id, "owner", await notifyOwner(request, { when, existingAccount, booking }));
        logOutcomes(request._id, "customer", await notifyCustomer(request, { when }));
      })
      .catch((error) => console.error("free_visit_request notifications threw", { message: error.message }));

    return res.status(201).json({ success: true, requestId: String(request._id), when, eventId });
  } catch (error) {
    console.error("❌ free_visit_request failed:", error.message);
    return res.status(500).json({ success: false, message: "We couldn't send that just now. Please try again, or call or text 631-599-1363." });
  }
});

module.exports = router;
module.exports.CONTACT_CONSENT_TEXT = CONTACT_CONSENT_TEXT;
