/**
 * Guest checkout for paid visits: a One-Time Handyman Visit or a Full Day,
 * booked and paid with no account (2026-11-17, booking experience brief).
 *
 * WHY. Visitors chose a job and a time, then left at the sign-up wall. Paying
 * does not need an account; managing the visit later does, and that is
 * offered after the payment, not before it.
 *
 * WHAT IS THE SAME AS THE SIGNED-IN CHECKOUT (routes/bookings.js)
 *  - The product's own price, Stripe Price and enabled switch; the hold length,
 *    which is also the Stripe page's expiry; the reservation engine's held
 *    slot that only the webhook promotes; one checkout per press
 *    (clientRequestId); the owner's approval: a paid visit waits in "Pending"
 *    exactly like a member's paid visit. Nothing is confirmed here.
 *  - The task is required in a few words and is never used to refuse a job.
 *  - The webhook (routes/webhook.js) is the only thing that turns a payment
 *    into a booked visit, for guests through the same no-account path Admin's
 *    phone bookings use, with the booking's own contact fields.
 *
 * WHAT A GUEST ADDS
 *  - Name, mobile and email, checked like the guest Free Visit's; the
 *    address, checked against Nassau / Suffolk by ZIP; the consent line the
 *    page showed, stored on this booking only (texts about this visit).
 *  - A person Admin blocked (email or phone) is refused, as everywhere.
 *
 * WHO OWNS IT. Nobody, until somebody proves the contact: signing in (or
 * creating an account) with a VERIFIED phone or email links it
 * (utils/freeVisit/guestLink), with the same refusals as a guest Free Visit -
 * never on an unproved contact, never when the email belongs to another
 * account or a shared phone is proved by someone else. An existing account
 * with the same email is NOT attached here and is not revealed to the page.
 *
 * Reservation engine only (production runs it). Without it the endpoints
 * answer 503 GUEST_CHECKOUT_UNAVAILABLE and the page offers sign-in instead.
 */
const express = require("express");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const multer = require("multer");
const Booking = require("../models/Booking");
const VisitEntitlement = require("../models/VisitEntitlement");
const { clientIp } = require("../utils/auth/clientIp");
const { rateLimit, consume } = require("../utils/rateLimit");
const { normalizePhoneE164 } = require("../utils/identity");
const { findActiveBlock, refuseBlocked } = require("../utils/customerBlock");
const { isZipInServiceArea, countyForZip } = require("../utils/serviceArea");
const { buildSignupAddress } = require("../utils/addressVerification");
const { MAX_PHOTO_BYTES, MAX_PHOTOS, photoUpload, sanitizeUploadedPhotos } = require("../utils/imageSanitizer");
const { hasStripeSecretKey, stripe } = require("../utils/subscriptionManagement");
const { getOneTimeVisitSettings, validateOneTimeTask } = require("../utils/oneTimeVisitSettings");
const { getFullDayVisitSettings } = require("../utils/fullDayVisitSettings");
const {
  FULL_DAY_PRODUCT_KIND,
  FULL_DAY_SERVICE,
  assertFullDayBookable,
  createFullDayBooking,
  releaseFullDayCapacity,
} = require("../utils/fullDayVisitService");
const {
  cancelBookingWithReservation,
  consumeSignInHold,
  createBookingWithReservation,
  reservationEngineEnabled,
} = require("../utils/slotReservationService");
const { readLibraryReference } = require("../utils/bookingLibrary");
const { checkoutMetadataFrom } = require("../utils/metaBrowserIds");
const { deletePublicObjects } = require("../utils/s3");

const router = express.Router();
const TZ = "America/New_York";
const CLIENT_URL = String(process.env.CLIENT_URL || "https://www.profixter.com").replace(/\/+$/, "");
const SESSION_ID = /^cs_(live|test)_[A-Za-z0-9]{6,200}$/;

/*
 * The consent line next to the pay button, word for word (FrontEnd
 * lib/guest-checkout.ts GUEST_CHECKOUT_CONSENT_TEXT). The browser sends back
 * the text it displayed; the request is refused unless it matches, so the
 * stored evidence is always the sentence the person saw.
 */
const GUEST_CHECKOUT_CONSENT_TEXT =
  "By booking, you agree that ProFixter may call or text you about this visit. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out or HELP for help.";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PHOTOS } });

/* Ten checkouts an hour from one network is plenty for a household and little for a script. */
const ipLimit = rateLimit({
  limit: 10,
  windowMs: 60 * 60 * 1000,
  keyResolver: (req) => `guest_checkout_ip:${clientIp(req)}`,
  message: "Too many requests just now. Please call or text 631-599-1363.",
});
const statusLimit = rateLimit({ limit: 120, windowMs: 10 * 60 * 1000, keyResolver: (req) => `guest_status_ip:${clientIp(req)}` });

function clean(value, max = 200) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
const readClientKey = (value) => (/^[A-Za-z0-9_-]{8,64}$/.test(String(value || "")) ? String(value) : "");
const words = (text) => String(text || "").trim().split(/\s+/).filter(Boolean).length;

class GuestError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.statusCode = status;
    this.code = code;
    this.field = field || undefined;
  }
}

/*
 * The guest's details, or a GuestError naming the field to fix. Same rules as
 * the guest Free Visit (routes/freeVisitRequests.js), so one person's details
 * pass or fail the same way on both.
 */
async function readGuest(body) {
  const name = clean(body.name, 120);
  const email = clean(body.email, 200).toLowerCase();
  const phone = normalizePhoneE164(body.phone);
  if (name.length < 2 || !/\s/.test(name)) throw new GuestError(400, "INVALID_NAME", "Please enter your first and last name.", "name");
  if (!phone) throw new GuestError(400, "INVALID_PHONE", "Please enter a valid 10-digit US mobile number.", "phone");
  if (!validEmail(email)) throw new GuestError(400, "INVALID_EMAIL", "Please enter a valid email address.", "email");
  const built = buildSignupAddress({ line1: body.line1, unit: body.unit, city: body.city, state: body.state || "NY", zip: body.zip, lat: body.lat, lng: body.lng });
  if (!built.ok) throw new GuestError(400, "INVALID_ADDRESS", "Please enter your full service address.", "address");
  if (!isZipInServiceArea(built.address.zip)) {
    throw new GuestError(400, "OUT_OF_SERVICE_AREA", "We serve Nassau and Suffolk counties on Long Island. That address is outside our area for now.", "address");
  }
  const address = { ...built.address, county: countyForZip(built.address.zip) || built.address.county || "" };
  if (clean(body.consentText, 300) !== GUEST_CHECKOUT_CONSENT_TEXT) {
    throw new GuestError(400, "CONSENT_MISMATCH", "Please reload the page and try again.");
  }
  return { name, email, phone, address };
}

function guestBookingFields({ guest, req, note, images, library, clientKey, holdExpiresAt }) {
  return {
    user: null,
    userId: "",
    name: guest.name,
    phone: guest.phone,
    email: guest.email,
    addressId: null,
    address: guest.address.line1 || "",
    unit: guest.address.unit || "",
    city: guest.address.city || "",
    state: guest.address.state || "NY",
    zip: guest.address.zip || "",
    county: guest.address.county || "",
    accessType: "one_time",
    paymentState: "pending",
    paymentStatus: "Pending",
    entitlementId: null,
    paymentHoldExpiresAt: holdExpiresAt,
    isFreeFirstVisit: false,
    note,
    images,
    libraryReference: library.key,
    // The owner reviews every paid visit, exactly as for a signed-in customer.
    status: "Pending",
    guestCheckout: true,
    guestContactConsent: { text: GUEST_CHECKOUT_CONSENT_TEXT, at: new Date(), ip: clean(clientIp(req), 60) },
    ...(clientKey ? { checkoutClientKey: clientKey } : {}),
  };
}

/* One press, one checkout: the same clientRequestId while its Stripe page is open gets that page back. */
async function reuseOpenCheckout(clientKey) {
  if (!clientKey) return null;
  const earlier = await Booking.findOne({ guestCheckout: true, checkoutClientKey: clientKey, status: { $nin: ["Canceled", "Cancelled"] } })
    .sort({ createdAt: -1 })
    .lean();
  if (!earlier) return null;
  if (earlier.paymentState === "paid") return { alreadyPaid: true, bookingId: String(earlier._id), sessionId: earlier.checkoutSessionId || null };
  if (earlier.paymentState !== "pending" || !earlier.checkoutSessionId) return null;
  const session = await stripe.checkout.sessions.retrieve(earlier.checkoutSessionId).catch(() => null);
  if (session?.status === "open" && session.url) return { url: session.url, bookingId: String(earlier._id), holdExpiresAt: earlier.paymentHoldExpiresAt, reused: true };
  if (session?.status === "complete") return { alreadyPaid: true, bookingId: String(earlier._id), sessionId: earlier.checkoutSessionId };
  return null;
}

async function openCheckout({ booking, guest, priceId, productKind, holdExpiresAt, cancelUrl, req }) {
  const metadata = {
    productKind,
    bookingId: String(booking._id),
    entitlementId: "",
    userMongoId: "",
    userId: "",
    addressId: "",
    guestCheckout: "true",
  };
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: String(booking._id),
    metadata: { ...metadata, ...checkoutMetadataFrom(req.body) },
    payment_intent_data: { metadata },
    customer_email: guest.email,
    success_url: `${CLIENT_URL}/book/confirmation?booking_id=${booking._id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl,
    expires_at: Math.floor(holdExpiresAt.getTime() / 1000),
  });
  if (!session?.url) throw new Error("Stripe checkout did not return a redirect URL");
  await Booking.updateOne({ _id: booking._id }, { $set: { checkoutSessionId: session.id } });
  return session;
}

async function releaseFailed(booking, kind) {
  if (!booking?._id) return;
  try {
    if (kind === "full_day") await releaseFullDayCapacity(booking);
    else await cancelBookingWithReservation({ bookingId: booking._id, actorUser: null, createdByType: "system", reason: "Guest checkout setup failed" });
  } catch (error) {
    console.error("guest checkout release failed:", error.message);
  }
  await Booking.updateOne({ _id: booking._id }, { $set: { status: "Canceled", paymentState: "failed", paymentStatus: "Failed" } }).catch(() => {});
}

function sendError(res, error, fallbackCode) {
  if (error instanceof GuestError) return res.status(error.statusCode).json({ code: error.code, message: error.message, field: error.field });
  if (["SLOT_UNAVAILABLE", "SLOT_CONFLICT", "TECHNICIAN_UNAVAILABLE"].includes(error?.code)) {
    return res.status(409).json({ code: "SLOT_UNAVAILABLE", message: "That time was just taken. Pick another - everything else is saved." });
  }
  if (["FULL_DAY_UNAVAILABLE"].includes(error?.code)) {
    return res.status(409).json({ code: "FULL_DAY_UNAVAILABLE", message: "That day is no longer available. Please choose another date." });
  }
  console.error(`guest checkout failed (${fallbackCode}):`, error?.stack || error?.message);
  return res.status(error?.statusCode && error.statusCode < 500 ? error.statusCode : 500).json({
    code: error?.code || fallbackCode,
    message: error?.statusCode && error.statusCode < 500 ? error.message : "We couldn't start the secure checkout. Please try again, or call or text 631-599-1363.",
  });
}

/* Photos stored before anything is held; a storage failure names the photos, so the page can offer to go on without them. */
async function storePhotos(uploadBookingImages, args) {
  try {
    return await uploadBookingImages(args);
  } catch (error) {
    console.error("guest checkout photo upload failed:", error.message);
    throw new GuestError(502, "PHOTO_UPLOAD_FAILED", "We couldn't save your photos just now. Try again, or continue without photos - nothing else is lost.", "photos");
  }
}

async function commonPreflight(req, res) {
  if (!reservationEngineEnabled()) throw new GuestError(503, "GUEST_CHECKOUT_UNAVAILABLE", "Please sign in to book this visit.");
  if (!hasStripeSecretKey()) throw new GuestError(503, "STRIPE_NOT_CONFIGURED", "Secure checkout is temporarily unavailable. Please try again shortly.");
  const guest = await readGuest(req.body || {});
  const block = await findActiveBlock({ email: guest.email, phone: guest.phone });
  if (block) {
    refuseBlocked(res, "guest_checkout", block);
    return null;
  }
  /* A person trying a few times is fine; dozens of checkouts from one number is not. */
  const perPhone = consume({ key: `guest_checkout_phone:${guest.phone}`, limit: 8, windowMs: 24 * 60 * 60 * 1000 });
  if (!perPhone.allowed) throw new GuestError(429, "TOO_MANY", "We already have your booking attempts today. Please call or text 631-599-1363.");
  const library = readLibraryReference(req.body || {});
  if (!library.ok) throw new GuestError(library.status, library.code, library.message);
  return { guest, library };
}

/* ---------- POST /api/bookings/guest/one-time/checkout ---------- */
router.post("/one-time/checkout", ipLimit, photoUpload(upload), sanitizeUploadedPhotos, async (req, res) => {
  let booking = null;
  const uploaded = [];
  try {
    const clientKey = readClientKey(req.body?.clientRequestId);
    const reused = await reuseOpenCheckout(clientKey);
    if (reused) return res.json(reused);

    const pre = await commonPreflight(req, res);
    if (!pre) return undefined;
    const settings = await getOneTimeVisitSettings();
    if (!settings.enabled) throw new GuestError(503, "ONE_TIME_VISIT_DISABLED", "One-Time Handyman Visit booking is temporarily unavailable.");
    if (!settings.stripePriceId) throw new GuestError(503, "ONE_TIME_PRICE_NOT_CONFIGURED", "One-Time Handyman Visit checkout is not configured yet.");

    const note = String(req.body?.note || "").trim().slice(0, 1200);
    if (words(note) < 3) throw new GuestError(400, "TASK_REQUIRED", "Tell us in a few words what needs doing.", "task");
    const scope = validateOneTimeTask(settings, req.body?.selectedTask, note);
    if (!scope.ok) throw new GuestError(400, scope.code, scope.message, "task");

    const date = clean(req.body?.requestedDate, 10);
    const time = clean(req.body?.requestedTime, 5);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time) ? moment.tz(`${date} ${time}`, "YYYY-MM-DD HH:mm", true, TZ) : null;
    if (!start?.isValid() || start.isBefore(moment())) throw new GuestError(409, "SLOT_UNAVAILABLE", "That time has passed. Pick another - everything else is saved.", "when");

    const holdExpiresAt = new Date(Date.now() + settings.holdMinutes * 60 * 1000);
    const bookingNumber = Math.floor(10000000 + Math.random() * 90000000).toString();
    const { uploadBookingImages } = require("./bookings");
    const photos = await storePhotos(uploadBookingImages, { files: req.files || [], bookingDate: start.toDate(), bookingNumber });
    uploaded.push(...photos.uploadedS3Keys);

    const bookingData = {
      bookingNumber,
      date: start.toDate(),
      service: "One-Time Handyman Visit",
      selectedTask: scope.selectedTask,
      subscription: "One-Time Visit",
      bookingType: "one_time_handyman_visit",
      ...guestBookingFields({ guest: pre.guest, req, note, images: photos.images, library: pre.library, clientKey, holdExpiresAt }),
    };
    await consumeSignInHold(req.body?.holdToken, start.toDate()).catch(() => null);
    ({ booking } = await createBookingWithReservation({
      bookingData,
      slotStart: start.toDate(),
      createdByType: "customer",
      actorUser: null,
      assignmentSource: "automatic",
      reservationStatus: "held",
      holdExpiresAt,
    }));
    const session = await openCheckout({
      booking,
      guest: pre.guest,
      priceId: settings.stripePriceId,
      productKind: "one_time_handyman_visit",
      holdExpiresAt,
      cancelUrl: `${CLIENT_URL}/book/handyman?canceled=1&booking_id=${booking._id}`,
      req,
    });
    return res.json({ url: session.url, bookingId: String(booking._id), holdExpiresAt });
  } catch (error) {
    await releaseFailed(booking, "one_time");
    if (uploaded.length) await deletePublicObjects({ Bucket: process.env.S3_BUCKET, Keys: uploaded }).catch(() => {});
    return sendError(res, error, "GUEST_ONE_TIME_CHECKOUT_FAILED");
  }
});

/* ---------- POST /api/bookings/guest/full-day/checkout ---------- */
router.post("/full-day/checkout", ipLimit, photoUpload(upload), sanitizeUploadedPhotos, async (req, res) => {
  let booking = null;
  const uploaded = [];
  try {
    const clientKey = readClientKey(req.body?.clientRequestId);
    const reused = await reuseOpenCheckout(clientKey);
    if (reused) return res.json(reused);

    const pre = await commonPreflight(req, res);
    if (!pre) return undefined;
    const settings = await getFullDayVisitSettings();
    if (!settings.enabled) throw new GuestError(503, "FULL_DAY_DISABLED", "Full Day Fixter booking is temporarily unavailable.");
    if (!settings.stripePriceId) throw new GuestError(503, "FULL_DAY_PRICE_NOT_CONFIGURED", "Full Day checkout is not configured yet.");

    const note = String(req.body?.note || "").trim().slice(0, 1200);
    if (words(note) < 3) throw new GuestError(400, "TASK_REQUIRED", "Tell us what you would like done, in at least a few words.", "note");
    const date = clean(req.body?.date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new GuestError(400, "DATE_REQUIRED", "Please choose a date.", "date");
    await assertFullDayBookable({ date });

    const holdExpiresAt = new Date(Date.now() + settings.holdMinutes * 60 * 1000);
    const bookingNumber = Math.floor(10000000 + Math.random() * 90000000).toString();
    const { uploadBookingImages } = require("./bookings");
    const photos = await storePhotos(uploadBookingImages, { files: req.files || [], bookingDate: new Date(`${date}T12:00:00Z`), bookingNumber });
    uploaded.push(...photos.uploadedS3Keys);

    ({ booking } = await createFullDayBooking({
      date,
      actorUser: null,
      createdByType: "customer",
      reservationStatus: "held",
      holdExpiresAt,
      bookingData: {
        bookingNumber,
        service: FULL_DAY_SERVICE,
        selectedTask: FULL_DAY_SERVICE,
        subscription: "Full Day Fixter",
        bookingType: "full_day_visit",
        ...guestBookingFields({ guest: pre.guest, req, note, images: photos.images, library: pre.library, clientKey, holdExpiresAt }),
      },
    }));
    const session = await openCheckout({
      booking,
      guest: pre.guest,
      priceId: settings.stripePriceId,
      productKind: FULL_DAY_PRODUCT_KIND,
      holdExpiresAt,
      cancelUrl: `${CLIENT_URL}/book?visit=full-day&canceled=true&booking_id=${booking._id}`,
      req,
    });
    return res.json({ url: session.url, bookingId: String(booking._id), holdExpiresAt });
  } catch (error) {
    await releaseFailed(booking, "full_day");
    if (uploaded.length) await deletePublicObjects({ Bucket: process.env.S3_BUCKET, Keys: uploaded }).catch(() => {});
    return sendError(res, error, "GUEST_FULL_DAY_CHECKOUT_FAILED");
  }
});

/*
 * Back from Stripe with "cancel": let the held time go now rather than at the
 * hold's end. Proved by the press's own clientRequestId, which only that
 * browser has; the expiry webhook does the releasing, as for a signed-in one.
 */
router.post("/abandon", ipLimit, async (req, res) => {
  try {
    const bookingId = String(req.body?.bookingId || "");
    const clientKey = readClientKey(req.body?.clientRequestId);
    if (!mongoose.isValidObjectId(bookingId) || !clientKey) return res.status(400).json({ message: "Invalid request" });
    const booking = await Booking.findOne({ _id: bookingId, guestCheckout: true, checkoutClientKey: clientKey }).lean();
    if (!booking) return res.status(404).json({ message: "Not found" });
    if (booking.paymentState !== "pending") return res.json({ released: false, paymentState: booking.paymentState });
    if (booking.checkoutSessionId) {
      const session = await stripe.checkout.sessions.retrieve(booking.checkoutSessionId).catch(() => null);
      if (session?.status === "open") await stripe.checkout.sessions.expire(booking.checkoutSessionId);
    }
    return res.json({ released: true });
  } catch (error) {
    console.error("guest abandon failed:", error.message);
    return res.status(500).json({ message: "Could not release the time." });
  }
});

/*
 * Where a paid visit stands, for the page Stripe returns to - signed in or not.
 * Found by the Stripe session id, which only the payer's browser was handed.
 * Nothing personal comes back: the kind, the day and time, the booking number
 * and one status:
 *   awaiting_payment   the Stripe page is still open
 *   payment_processing Stripe says paid, our webhook has not recorded it yet
 *   pending_approval   paid; the owner reviews it (every paid visit)
 *   confirmed          approved
 *   not_completed      expired, canceled or failed before payment
 *   canceled           paid, then canceled (refund handled by the owner)
 */
router.get("/status", statusLimit, async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const sessionId = String(req.query.session_id || "");
    if (!SESSION_ID.test(sessionId)) return res.status(400).json({ message: "Invalid session" });
    let booking = await Booking.findOne({ checkoutSessionId: sessionId }).lean();
    if (!booking) {
      const entitlement = await VisitEntitlement.findOne({ stripeCheckoutSessionId: sessionId }).select("bookingId").lean();
      if (entitlement?.bookingId) booking = await Booking.findById(entitlement.bookingId).lean();
    }
    if (!booking) return res.status(404).json({ message: "Not found" });
    const kind = booking.bookingType === "full_day_visit" ? "full_day" : booking.bookingType === "one_time_handyman_visit" ? "one_time" : "other";
    const canceled = /^cancel+ed$/i.test(String(booking.status || "")) || booking.paymentState === "failed";
    let status;
    if (booking.paymentState === "paid" || booking.paymentState === "refunded") {
      status = canceled ? "canceled" : /^confirmed$/i.test(String(booking.status || "")) ? "confirmed" : "pending_approval";
    } else if (canceled) status = "not_completed";
    else {
      const session = await stripe.checkout.sessions.retrieve(sessionId).catch(() => null);
      if (session?.status === "complete") status = "payment_processing";
      else if (session?.status === "expired") status = "not_completed";
      else status = "awaiting_payment";
    }
    const start = moment.tz(booking.date, TZ);
    return res.json({
      kind,
      status,
      bookingNumber: booking.bookingNumber,
      date: start.format("YYYY-MM-DD"),
      time: kind === "full_day" ? null : start.format("HH:mm"),
      guest: !booking.user,
    });
  } catch (error) {
    console.error("checkout status failed:", error.message);
    return res.status(500).json({ message: "Status unavailable" });
  }
});

module.exports = router;
module.exports.GUEST_CHECKOUT_CONSENT_TEXT = GUEST_CHECKOUT_CONSENT_TEXT;
