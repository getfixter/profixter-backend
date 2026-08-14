// routes/bookings.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const mongoose = require("mongoose");
const moment = require("moment-timezone");

const Booking = require("../models/Booking");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const VisitEntitlement = require("../models/VisitEntitlement");
const CalendarConfig = require("../models/CalendarConfig");
const SlotCounter = require("../models/SlotCounter");
const {
  snapshot: bookingSnapshot,
  logBookingChanges,
  logBookingCreated,
} = require("../utils/bookingHistory");

const auth = require("../middleware/auth");
const { ensureNotBlacklisted } = require("../middleware/blacklist");
const mail = require("../utils/emailService");
const { deletePublicObjects, putPublicObject } = require("../utils/s3");
const {
  subscriptionGrantsAccess,
  hasStripeSecretKey,
  resolveUserStripeCustomerId,
  stripe,
  verifySubscriptionAccess,
} = require("../utils/subscriptionManagement");
const {
  cancelBookingWithReservation,
  createBookingWithReservation,
  isTerminalBookingStatus,
  reservationEngineEnabled,
} = require("../utils/slotReservationService");
const {
  suggestNextAvailableSlots,
} = require("../utils/customerCalendarService");
const {
  INTRO_VISIT_STATUS,
  INTRO_VISIT_SERVICE,
  getIntroVisitState,
  claimIntroVisitAtomic,
  attachBookingToClaim,
  releaseIntroVisitClaim,
} = require("../utils/introVisitEligibility");
const {
  isAddressInServiceArea,
  outOfServiceAreaMessage,
} = require("../utils/serviceArea");
const {
  getOneTimeVisitSettings,
  publicOneTimeVisitSettings,
  validateOneTimeTask,
} = require("../utils/oneTimeVisitSettings");
const {
  getFullDayVisitSettings,
  publicFullDayVisitSettings,
} = require("../utils/fullDayVisitSettings");
const {
  FULL_DAY_PRODUCT_KIND,
  FULL_DAY_SERVICE,
  assertFullDayBookable,
  createFullDayBooking,
  fullDayAvailabilityForRange,
  releaseFullDayCapacity,
} = require("../utils/fullDayVisitService");
const {
  consumeIncludedFullDay,
  includedFullDayState,
  restoreIncludedFullDay,
} = require("../utils/fullDayEntitlements");
const {
  uploadAppointmentPhotos,
  storeAppointmentImages,
} = require("../utils/bookingAttachments");
const {
  actorSnapshot,
  appendPublicNote,
  appendContentUpdate,
  canCustomerAddAppointmentDetails,
} = require("../utils/bookingContentUpdates");
const {
  ensureVisitEntitlementIndexesOnce,
} = require("../utils/visitEntitlementIndexSafety");

const BOOKINGS_ROUTE_VERSION = "v5.1-capacity-gated";
console.log("Loaded routes/bookings.js", BOOKINGS_ROUTE_VERSION);
const CLIENT_URL = process.env.CLIENT_URL || "https://www.profixter.com";

router.get("/__version", (_req, res) => res.json({ v: BOOKINGS_ROUTE_VERSION }));

/* ---------- Upload config ---------- */
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = (process.env.S3_PREFIX || "uploads").replace(/\/+$/, "");
const storage = multer.memoryStorage();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB per file
    files: 10, // allow 10 images
  },
});

const {
  createOrUpdateContact,
  updateContactFields,
  formatBookingDateTime,
  addTag,
} = require("../utils/ghlContact");

const safeName = (name) =>
  name
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);

async function uploadBookingImages({ files = [], bookingDate, bookingNumber }) {
  const images = [];
  const uploadedS3Keys = [];
  const yyyy = bookingDate.getFullYear();
  const mm = String(bookingDate.getMonth() + 1).padStart(2, "0");
  const dd = String(bookingDate.getDate()).padStart(2, "0");
  const formattedDate = `${yyyy}-${mm}-${dd}`;

  if (S3_BUCKET) {
    const baseKey = `${S3_PREFIX}/${formattedDate}/booking-${bookingNumber}`;

    for (const f of files || []) {
      const ext = path.extname(f.originalname).toLowerCase();
      const stem = safeName(path.basename(f.originalname, ext));
      let finalBuffer = f.buffer;
      let finalExt = ext;
      let finalContentType = f.mimetype || "application/octet-stream";

      const needsConversion =
        [".heic", ".heif", ".png", ".bmp", ".tiff", ".tif"].includes(ext) ||
        [
          "image/heic",
          "image/heif",
          "image/png",
          "image/bmp",
          "image/tiff",
        ].includes(f.mimetype);

      if (needsConversion) {
        finalBuffer = await sharp(f.buffer)
          .rotate()
          .resize(1600, 1600, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({
            quality: 75,
            chromaSubsampling: "4:2:0",
            mozjpeg: true,
          })
          .toBuffer();
        finalExt = ".jpg";
        finalContentType = "image/jpeg";
      } else if ([".jpg", ".jpeg"].includes(ext)) {
        finalBuffer = await sharp(f.buffer)
          .rotate()
          .resize(1600, 1600, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({
            quality: 75,
            chromaSubsampling: "4:2:0",
            mozjpeg: true,
          })
          .toBuffer();
      }

      const key = `${baseKey}/${Date.now()}-${stem}${finalExt}`;
      const url = await putPublicObject({
        Bucket: S3_BUCKET,
        Key: key,
        Body: finalBuffer,
        ContentType: finalContentType,
      });
      uploadedS3Keys.push(key);
      images.push(url);
    }
  } else {
    for (const f of files || []) {
      images.push(`local://${safeName(f.originalname)}`);
    }
  }

  return { images, uploadedS3Keys };
}

async function releaseLegacySlotCounter(bookingDate, cfg) {
  const tz = cfg?.timezone || "America/New_York";
  const ymd = ymdInTZ(new Date(bookingDate), tz);
  const hh = hhmmInTZ(new Date(bookingDate), tz);
  await SlotCounter.updateOne({ ymd, time: hh }, { $inc: { count: -1 } });
}

/* ---------- TZ helpers ---------- */
const ymdInTZ = (d, tz) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hhmmInTZ = (d, tz) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

async function resolveBookingSubscription(user, address, options = {}) {
  const hasAnyAddressSubs = await Subscription.exists({
    user: user._id,
    addressId: { $nin: [null, undefined] },
  });

  let candidate = await Subscription.findOne({
    user: user._id,
    addressId: address._id,
    status: { $in: ["active", "trialing"] },
  }).sort({ updatedAt: -1 });

  if (!candidate && !hasAnyAddressSubs) {
    const addrless = await Subscription.findOne({
      user: user._id,
      addressId: { $in: [null, undefined] },
      status: { $in: ["active", "trialing"] },
    }).sort({ updatedAt: -1 });

    if (
      addrless &&
      user.defaultAddressId &&
      String(user.defaultAddressId) === String(address._id)
    ) {
      candidate = addrless;
    }
  }

  if (!candidate) {
    return { subscription: null, staleSubscription: false, reason: "not_found" };
  }

  if (!options.verifyStripe || !candidate.stripeSubscriptionId) {
    const grantsAccess = subscriptionGrantsAccess(candidate);
    return {
      subscription: grantsAccess ? candidate : null,
      staleSubscription: !grantsAccess,
      reason: grantsAccess ? "local_access_valid" : "local_access_inactive",
    };
  }

  const verification = await verifySubscriptionAccess(candidate, {
    source: "booking_access",
  });
  return {
    subscription: verification.grantsAccess ? verification.subscription : null,
    staleSubscription: !verification.grantsAccess,
    reason: verification.reason,
  };
}

/* ---------- GET /api/bookings (all user bookings) ---------- */
router.get("/", auth, async (req, res) => {
  try {
    const bookings = await Booking.find({ user: req.user.id })
      .select(
        "-assignedFixterId -assignedFixterName -assignedFixterEmail -assignedFixterPosition -slotReservationId -adminNote -contentUpdates"
      )
      .sort({ date: 1 })
      .lean();

    return res.json(bookings);
  } catch (e) {
    console.error("GET /bookings error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

/* ---------- GET /api/bookings/next?addressId=... ---------- */
router.get("/next", auth, async (req, res) => {
  try {
    const { addressId } = req.query;
    if (!addressId) {
      return res.status(400).json({ message: "Missing addressId" });
    }

    const me = await User.findById(req.user.id);
    if (!me) {
      return res.status(401).json({ message: "User not found or session expired." });
    }

    const subdoc = me.addresses?.id?.(addressId);
    if (!subdoc) {
      return res.status(400).json({ message: "Address not found on your account." });
    }

    const access = await resolveBookingSubscription(me, subdoc, {
      verifyStripe: false,
    });
    const activeSub = access.subscription;

    let plan = String(activeSub?.subscriptionType || "").toLowerCase();
    let hasSubscription = !!activeSub;

    let bookingLimit = plan === "basic" ? 1 : plan ? 2 : 0;
    let freeFirstVisitAvailable = false;
    let introVisitStatus = null;
    let introVisitServiceable = false;

    let hasAnyBookings = false;

    if (!hasSubscription && !access.staleSubscription) {
      const anyBooking = await Booking.exists({ user: me._id });
      hasAnyBookings = !!anyBooking;

      // Eligibility now comes from persistent per-property acquisition state,
      // reconciled against the claimed booking. This matches the rule enforced
      // by POST / below, which the previous `!hasAnyBookings` check did not.
      const introState = await getIntroVisitState({
        user: me,
        address: subdoc,
        Booking,
      });
      introVisitStatus = introState.status;
      introVisitServiceable = isAddressInServiceArea(subdoc);
      // Display must match enforcement in POST / exactly, including the
      // service-area gate, so an eligible-looking CTA is never rejected.
      freeFirstVisitAvailable = introState.isAvailable && introVisitServiceable;

      if (freeFirstVisitAvailable) {
        plan = "free";
        bookingLimit = 1;
      } else {
        plan = "";
        bookingLimit = 0;
      }
    }

    const now = new Date();
    const futureBookings = await Booking.find({
      user: req.user.id,
      addressId: subdoc._id,
      date: { $gte: now },
    })
      .sort({ date: 1 })
      .lean();
    const activeBookings = futureBookings.filter(
      (booking) => !isTerminalBookingStatus(booking.status)
    );
    const activeCount = activeBookings.length;
    const next = activeBookings[0] || null;

    return res.json({
      plan,
      hasSubscription,
      freeFirstVisitAvailable,
      introVisitStatus,
      introVisitServiceable,
      bookingLimit,
      activeCount,
      hasAnyBookings,
      subscriptionAccessBlocked: access.staleSubscription,
      activeBookings: activeBookings.map((booking) => ({
        _id: String(booking._id),
        date: booking.date,
        status: booking.status,
        service: booking.service,
        bookingNumber: booking.bookingNumber,
        addressId: booking.addressId,
      })),
      future: next
        ? {
            _id: String(next._id),
            date: next.date,
            status: next.status,
            service: next.service,
            bookingNumber: next.bookingNumber,
            addressId: next.addressId,
          }
        : null,
    });
  } catch (e) {
    console.error("GET /bookings/next error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

function buildAddressLineFromBooking(b) {
  return [b.address, b.city, b.state, b.zip].filter(Boolean).join(", ");
}

// Customers may only append missing appointment details before the visit window closes.
router.post("/:id/add-details", auth, uploadAppointmentPhotos, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid booking id" });
    }

    const allowedBodyFields = new Set(["note"]);
    const disallowedFields = Object.keys(req.body || {}).filter(
      (key) => !allowedBodyFields.has(key)
    );
    if (disallowedFields.length) {
      return res.status(400).json({
        message: "You can only add new notes or photos.",
      });
    }

    const booking = await Booking.findOne({ _id: id, user: req.user.id });
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const eligibility = canCustomerAddAppointmentDetails(booking);
    if (!eligibility.allowed) {
      return res.status(400).json({ message: eligibility.message });
    }

    const noteText = String(req.body?.note || "").trim();
    const files = req.files || [];
    if (!noteText && !files.length) {
      return res.status(400).json({
        message: "You can only add new notes or photos.",
      });
    }
    if (noteText.length > 5000) {
      return res.status(400).json({ message: "Appointment note is too long." });
    }

    const me = await User.findById(req.user.id).lean();
    const actor = actorSnapshot(me, "customer");
    const before = bookingSnapshot(booking);
    const imageUpload = await storeAppointmentImages({
      files,
      bookingDate: booking.date,
      bookingNumber: booking.bookingNumber,
      source: "customer",
    });

    if (noteText) {
      appendPublicNote(booking, noteText, {
        source: "customer",
        actorName: actor.actorName,
      });
    }
    if (imageUpload.images.length) {
      booking.images = (booking.images || []).concat(imageUpload.images);
    }
    appendContentUpdate(booking, {
      actor,
      source: "customer",
      noteAdded: noteText,
      imagesAdded: imageUpload.images,
    });

    await booking.save();
    await logBookingChanges({
      bookingId: booking._id,
      before,
      after: bookingSnapshot(booking),
      actor,
    });

    const responseBooking = booking.toObject();
    delete responseBooking.adminNote;
    delete responseBooking.contentUpdates;
    delete responseBooking.assignedFixterId;
    delete responseBooking.assignedFixterName;
    delete responseBooking.assignedFixterEmail;
    delete responseBooking.assignedFixterPosition;
    delete responseBooking.slotReservationId;

    return res.json({
      message: "Appointment details added.",
      booking: responseBooking,
    });
  } catch (error) {
    console.error("Customer appointment detail update failed:", error.message);
    return res.status(error?.statusCode || 500).json({
      message: error.message || "Failed to update appointment details.",
    });
  }
});

/* ---------- CANCEL/DELETE handler (shared) ---------- */
async function cancelOrDelete(req, res) {
  try {
    const { id } = req.params;
    if (!id || !mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid booking id" });
    }

    let booking = await Booking.findOne({ _id: id, user: req.user.id });
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    const me = await User.findById(req.user.id).lean();
    const before = bookingSnapshot(booking);
    const useReservationEngine = reservationEngineEnabled();

    const status = String(booking.status || "").toLowerCase();
    const deletable = new Set(["pending", "complete", "completed"]);
    const isFullDay = booking.bookingType === "full_day_visit";

    // Order matters: give the benefit back while the booking still says what it
    // was scheduled for, because two of the three conditions are read off it.
    let fullDayRestore = null;
    if (isFullDay) {
      try {
        fullDayRestore = await restoreIncludedFullDay({ booking });
      } catch (error) {
        console.error("Full Day entitlement restore failed:", error.message);
      }
    }

    if (isFullDay) {
      // A Full Day holds a whole workday, not one slot. Releasing it through the
      // single-slot decrement below would hand back one hour and silently keep
      // the rest of the day off the calendar.
      try {
        await releaseFullDayCapacity(booking);
      } catch (error) {
        console.log("Full Day capacity release error:", error.message);
      }
      if (useReservationEngine) {
        const result = await cancelBookingWithReservation({
          bookingId: booking._id,
          actorUser: me,
          createdByType: "customer",
          reason: "Canceled by customer",
        });
        booking = result.booking;
      }
    } else if (useReservationEngine) {
      const result = await cancelBookingWithReservation({
        bookingId: booking._id,
        actorUser: me,
        createdByType: "customer",
        reason: "Canceled by customer",
      });
      booking = result.booking;
    } else try {
      const cfg = await CalendarConfig.findOne().lean();
      const tz = cfg?.timezone || "America/New_York";
      const ymd = ymdInTZ(new Date(booking.date), tz);
      const hh = hhmmInTZ(new Date(booking.date), tz);
      await SlotCounter.updateOne({ ymd, time: hh }, { $inc: { count: -1 } });
    } catch (e) {
      console.log("slot decrement (cancel/delete) error:", e.message);
    }

    // A Full Day is never deleted. It may have spent a membership benefit or
    // taken $499, and both of those are questions someone will ask later.
    if (!useReservationEngine && !isFullDay && deletable.has(status)) {
      await Booking.deleteOne({ _id: booking._id });
      return res.json({ ok: true, action: "deleted", message: "Booking deleted." });
    }

    if (!useReservationEngine || (isFullDay && booking.status !== "Canceled")) {
      booking.statusHistory = (booking.statusHistory || []).concat({
        status: booking.status,
        date: new Date(),
      });
      booking.status = "Canceled";
      await booking.save();
      await logBookingChanges({
        bookingId: booking._id,
        before,
        after: bookingSnapshot(booking),
        actor: {
          actorUserId: me?._id || null,
          actorName: me?.name || booking.name || "Customer",
          actorEmail: me?.email || booking.email || "",
          actorRole: "customer",
          actorPosition: "",
        },
      });
    }

    // GHL SMS automation hooks
    try {
      const contactId = await createOrUpdateContact({
        name: booking.name || me?.name,
        email: booking.email || me?.email,
        phone: booking.phone || me?.phone,
      });

      const pretty = formatBookingDateTime(booking.date);

      await updateContactFields(contactId, [
        {
          key: "booking_datetime_pretty",
          value: pretty,
        },
      ]);

      await addTag(contactId, "booking_cancelled");
    } catch (e) {
      console.log("GHL booking_cancelled error:", e.message);
    }

    // emails on cancel (best effort)
    try {
      const addressLine = buildAddressLineFromBooking(booking);
      const isoDate = booking?.date ? new Date(booking.date).toISOString() : null;

      if (me?.email) {
        await mail.sendTx(
          "booking_canceled",
          me.email,
          {
            name: me.name || me.email.split("@")[0],
            bookingNumber: booking.bookingNumber,
          },
          {
            bccAdmin: false,
            logContext: {
              bookingId: booking._id,
              bookingNumber: booking.bookingNumber,
              customerName: booking.name || me.name || "",
              customerEmail: booking.email || me.email || "",
              recipientName: me.name || booking.name || "",
              recipientEmail: me.email,
              emailType: "transactional",
              source: "bookingCancel",
            },
          }
        );
      }

      await mail.sendTx(
        "admin_booking_canceled",
        process.env.MAIL_ADMIN || "getfixter@gmail.com",
        {
          name: me?.name || booking.name || "-",
          phone: me?.phone || booking.phone || "-",
          address: addressLine || "-",
          userId: me?.userId || booking.userId || "-",
          bookingNumber: booking.bookingNumber || booking._id,
          service: booking.service || "-",
          date: isoDate,
        },
        {
          bccAdmin: false,
          logContext: {
            templateKey: "admin_booking_canceled",
            bookingId: booking._id,
            bookingNumber: booking.bookingNumber,
            customerName: booking.name || me?.name || "",
            customerEmail: booking.email || me?.email || "",
            recipientEmail: process.env.MAIL_ADMIN || "getfixter@gmail.com",
            emailType: "admin",
            source: "bookingCancel",
          },
        }
      );
    } catch (e) {
      console.log("Mail booking_canceled/admin_booking_canceled error:", e.message);
    }

    return res.json({
      ok: true,
      action: "canceled",
      message: "Booking canceled.",
      ...(isFullDay
        ? {
            // Told plainly so the customer knows whether the day they gave up
            // is back in their account or gone for this period.
            includedFullDayRestored: !!fullDayRestore?.restored,
            includedFullDayRestoreReason: fullDayRestore?.reason || "",
          }
        : {}),
    });
  } catch (e) {
    console.error("cancelOrDelete error:", e);
    res.status(500).json({ message: "Server error" });
  }
}

/* ---------- Cancellation aliases ---------- */
router.delete("/cancel/:id", auth, cancelOrDelete);
router.post("/cancel/:id", auth, cancelOrDelete);
router.delete("/:id", auth, cancelOrDelete);
router.post("/:id/cancel", auth, cancelOrDelete);

/* ---------- GET /api/bookings/one-time/config ---------- */
router.get("/one-time/config", async (_req, res) => {
  try {
    const settings = await getOneTimeVisitSettings();
    return res.json(publicOneTimeVisitSettings(settings));
  } catch (error) {
    console.error("One-time settings load error:", error.message);
    return res.status(500).json({ message: "Unable to load one-time visit settings." });
  }
});

/* ---------- POST /api/bookings/one-time/checkout ---------- */
router.post(
  "/one-time/checkout",
  auth,
  ensureNotBlacklisted,
  upload.array("images", 10),
  async (req, res) => {
    let booking = null;
    let entitlement = null;
    let counterStamped = null;
    const uploadedS3Keys = [];
    let legacyCfg = null;

    try {
      if (!hasStripeSecretKey()) {
        return res.status(503).json({
          message: "Secure checkout is temporarily unavailable. Please try again shortly.",
          code: "STRIPE_NOT_CONFIGURED",
        });
      }

      const oneTimeSettings = await getOneTimeVisitSettings();
      if (!oneTimeSettings.enabled) {
        return res.status(503).json({
          message: "One-Time Handyman Visit booking is temporarily unavailable.",
          code: "ONE_TIME_VISIT_DISABLED",
        });
      }

      const priceId = oneTimeSettings.stripePriceId;
      if (!priceId) {
        return res.status(503).json({
          message: "One-Time Handyman Visit checkout is not configured yet.",
          code: "ONE_TIME_PRICE_NOT_CONFIGURED",
        });
      }

      const me = await User.findById(req.user.id);
      if (!me) {
        return res.status(401).json({ message: "User not found or session expired." });
      }

      const { addressId, selectedTask, note, date, requestedDate, requestedTime } = req.body;
      if (!addressId || !mongoose.isValidObjectId(addressId)) {
        return res.status(400).json({ message: "Please choose an address for this booking." });
      }
      if (!note || String(note).trim().split(/\s+/).filter(Boolean).length < 3) {
        return res.status(400).json({ message: "Describe the task in at least a few words." });
      }
      if (!req.files?.length) {
        return res.status(400).json({ message: "Add at least one photo so our team can prepare." });
      }

      const scope = validateOneTimeTask(oneTimeSettings, selectedTask, note);
      if (!scope.ok) {
        return res.status(400).json({
          message: scope.message,
          code: scope.code,
          redirectTo: "/projects",
        });
      }

      const subdoc = me.addresses?.id?.(addressId);
      if (!subdoc) {
        return res.status(400).json({ message: "Address not found on your account." });
      }

      const useReservationEngine = reservationEngineEnabled();
      const requestedStart =
        useReservationEngine &&
        /^\d{4}-\d{2}-\d{2}$/.test(String(requestedDate || "")) &&
        /^\d{2}:\d{2}$/.test(String(requestedTime || ""))
          ? moment.tz(
              `${requestedDate} ${requestedTime}`,
              "YYYY-MM-DD HH:mm",
              true,
              "America/New_York"
            )
          : null;
      const bookingDate = requestedStart?.isValid()
        ? requestedStart.toDate()
        : new Date(date);
      if (Number.isNaN(bookingDate.getTime())) {
        return res.status(400).json({ message: "Invalid date." });
      }

      const holdExpiresAt = new Date(
        Date.now() + oneTimeSettings.holdMinutes * 60 * 1000
      );
      legacyCfg = useReservationEngine ? null : await CalendarConfig.findOne().lean();
      if (!useReservationEngine) {
        const capacity = Math.max(1, Number(legacyCfg?.maxConcurrent ?? 1));
        const ymd = ymdInTZ(bookingDate, legacyCfg?.timezone || "America/New_York");
        const hh = hhmmInTZ(bookingDate, legacyCfg?.timezone || "America/New_York");
        const gate = await SlotCounter.findOneAndUpdate(
          {
            ymd,
            time: hh,
            $or: [{ count: { $lt: capacity } }, { count: { $exists: false } }],
          },
          {
            $inc: { count: 1 },
            $setOnInsert: { ymd, time: hh },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        if (!gate || gate.count > capacity) {
          return res.status(409).json({
            code: "SLOT_UNAVAILABLE",
            message: "This time is fully booked. Please choose another time.",
          });
        }
        counterStamped = { ymd, time: hh };
      }

      const bookingNumber = Math.floor(10000000 + Math.random() * 90000000).toString();
      const uploadResult = await uploadBookingImages({
        files: req.files || [],
        bookingDate,
        bookingNumber,
      });
      uploadedS3Keys.push(...uploadResult.uploadedS3Keys);

      await ensureVisitEntitlementIndexesOnce();

      entitlement = await VisitEntitlement.create({
        user: me._id,
        userId: me.userId,
        addressId: subdoc._id,
        addressSnapshot: {
          line1: subdoc.line1 || "",
          city: subdoc.city || "",
          state: subdoc.state || "",
          zip: subdoc.zip || "",
          county: subdoc.county || "",
        },
        status: "pending_payment",
        priceCents: oneTimeSettings.priceCents,
        currency: oneTimeSettings.currency,
        durationMinutes: oneTimeSettings.durationMinutes,
        holdExpiresAt,
      });

      const bookingData = {
        bookingNumber,
        date: bookingDate,
        service: "One-Time Handyman Visit",
        selectedTask: scope.selectedTask,
        user: req.user.id,
        userId: me.userId,
        name: me.name,
        phone: me.phone,
        email: me.email,
        addressId: subdoc._id,
        address: subdoc.line1 || "",
        city: subdoc.city || "",
        state: subdoc.state || "",
        zip: subdoc.zip || "",
        county: subdoc.county || "",
        subscription: "One-Time Visit",
        accessType: "one_time",
        bookingType: "one_time_handyman_visit",
        paymentState: "pending",
        paymentStatus: "Pending",
        entitlementId: entitlement._id,
        paymentHoldExpiresAt: holdExpiresAt,
        isFreeFirstVisit: false,
        note: String(note || "").trim(),
        images: uploadResult.images,
        status: "Pending",
      };

      if (useReservationEngine) {
        const result = await createBookingWithReservation({
          bookingData,
          slotStart: bookingDate,
          createdByType: "customer",
          actorUser: me,
          assignmentSource: "automatic",
          reservationStatus: "held",
          holdExpiresAt,
        });
        booking = result.booking;
      } else {
        booking = new Booking(bookingData);
        await booking.save();
        await logBookingCreated({
          booking,
          actor: {
            actorUserId: me?._id || null,
            actorName: me?.name || booking.name || "Customer",
            actorEmail: me?.email || booking.email || "",
            actorRole: "customer",
            actorPosition: "",
          },
        });
      }

      entitlement.bookingId = booking._id;
      await entitlement.save();

      const stripeCustomerId = await resolveUserStripeCustomerId(me);
      const sessionConfig = {
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: String(booking._id),
        metadata: {
          productKind: "one_time_handyman_visit",
          bookingId: String(booking._id),
          entitlementId: String(entitlement._id),
          userMongoId: String(me._id),
          userId: String(me.userId || me._id),
          addressId: String(subdoc._id),
        },
        payment_intent_data: {
          metadata: {
            productKind: "one_time_handyman_visit",
            bookingId: String(booking._id),
            entitlementId: String(entitlement._id),
            userMongoId: String(me._id),
            userId: String(me.userId || me._id),
            addressId: String(subdoc._id),
          },
        },
        success_url: `${CLIENT_URL}/book/confirmation?booking_id=${booking._id}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${CLIENT_URL}/book?canceled=true&booking_id=${booking._id}`,
        expires_at: Math.floor(holdExpiresAt.getTime() / 1000),
      };

      if (stripeCustomerId) {
        sessionConfig.customer = stripeCustomerId;
      } else {
        sessionConfig.customer_email = me.email;
      }

      const checkoutSession = await stripe.checkout.sessions.create(sessionConfig);
      if (!checkoutSession?.url) {
        throw new Error("Stripe checkout did not return a redirect URL");
      }

      entitlement.stripeCheckoutSessionId = checkoutSession.id;
      entitlement.stripeCustomerId = checkoutSession.customer
        ? String(checkoutSession.customer)
        : stripeCustomerId || null;
      await entitlement.save();

      return res.json({
        url: checkoutSession.url,
        bookingId: String(booking._id),
        entitlementId: String(entitlement._id),
        holdExpiresAt,
      });
    } catch (error) {
      console.error("One-time checkout booking error:", error.stack || error.message);
      try {
        if (booking?._id) {
          if (reservationEngineEnabled()) {
            await cancelBookingWithReservation({
              bookingId: booking._id,
              actorUser: req.authUser || null,
              createdByType: "system",
              reason: "One-time checkout setup failed",
            });
          } else {
            booking.status = "Canceled";
            booking.paymentState = "failed";
            await booking.save();
          }
          await Booking.updateOne(
            { _id: booking._id },
            {
              $set: {
                status: "Canceled",
                paymentState: "failed",
                paymentStatus: "Failed",
              },
            }
          );
        }
      } catch (cleanupError) {
        console.error("One-time booking cleanup failed:", cleanupError.message);
      }
      try {
        if (counterStamped) {
          await SlotCounter.updateOne(
            { ymd: counterStamped.ymd, time: counterStamped.time },
            { $inc: { count: -1 } }
          );
        }
      } catch (_) {}
      try {
        if (entitlement?._id) {
          entitlement.status = "payment_failed";
          await entitlement.save();
        }
      } catch (_) {}
      try {
        if (uploadedS3Keys.length) {
          await deletePublicObjects({ Bucket: S3_BUCKET, Keys: uploadedS3Keys });
        }
      } catch (_) {}

      if (
        ["SLOT_UNAVAILABLE", "SLOT_CONFLICT", "TECHNICIAN_UNAVAILABLE"].includes(
          error?.code
        )
      ) {
        return res.status(409).json({
          code: "SLOT_UNAVAILABLE",
          message: "This time is no longer available. Please choose another time.",
        });
      }
      return res.status(error?.statusCode || 500).json({
        message: error.message || "Unable to start one-time checkout.",
        code: error.code || "ONE_TIME_CHECKOUT_FAILED",
      });
    }
  }
);

/* ================================================================== */
/* Full Day Fixter                                                    */
/* ================================================================== */

/** Best effort, like every other booking email here: never fail a booking on mail. */
async function sendFullDayConfirmationEmails({
  booking,
  user,
  settings,
  included,
  periodEnd = null,
}) {
  const addressLine = buildAddressLineFromBooking(booking);
  const timeRange = booking.scheduledStart && booking.scheduledEnd
    ? {
        startTime: moment(booking.scheduledStart).tz("America/New_York").format("h:mm A"),
        endTime: moment(booking.scheduledEnd).tz("America/New_York").format("h:mm A"),
      }
    : { startTime: "", endTime: "" };
  const price = `$${Math.round((settings.priceCents || 49900) / 100)}`;

  try {
    await mail.sendTx(
      "full_day_visit_booked",
      booking.email || user.email,
      {
        name: booking.name || user.name || "there",
        bookingNumber: booking.bookingNumber,
        date: booking.date,
        address: addressLine,
        approximateHours: settings.approximateHours,
        included,
        price,
        periodEnd,
        ...timeRange,
      },
      {
        bccAdmin: false,
        logContext: {
          bookingId: booking._id,
          bookingNumber: booking.bookingNumber,
          customerName: booking.name || user.name || "",
          customerEmail: booking.email || user.email || "",
          recipientEmail: booking.email || user.email || "",
          emailType: included ? "transactional" : "billing",
          source: included ? "fullDayIncluded" : "fullDayPaid",
        },
      }
    );
  } catch (error) {
    console.error("full_day_visit_booked email failed:", error.message);
  }

  try {
    await mail.sendTx(
      "admin_full_day_booked",
      process.env.MAIL_ADMIN || "getfixter@gmail.com",
      {
        name: booking.name || user.name || "-",
        phone: booking.phone || user.phone || "-",
        address: addressLine || "-",
        userId: booking.userId || user.userId || "-",
        bookingNumber: booking.bookingNumber,
        date: booking.date,
        fixter: booking.assignedFixterName || "",
        paymentSummary: included
          ? "Included with Elite membership"
          : `${price} paid`,
        note: booking.note || "",
        ...timeRange,
      },
      {
        bccAdmin: false,
        logContext: {
          templateKey: "admin_full_day_booked",
          bookingId: booking._id,
          bookingNumber: booking.bookingNumber,
          recipientEmail: process.env.MAIL_ADMIN || "getfixter@gmail.com",
          emailType: "admin",
          source: "fullDay",
        },
      }
    );
  } catch (error) {
    console.error("admin_full_day_booked email failed:", error.message);
  }
}

/* ---------- GET /api/bookings/full-day/config ---------- */
router.get("/full-day/config", async (_req, res) => {
  try {
    const settings = await getFullDayVisitSettings();
    return res.json(publicFullDayVisitSettings(settings));
  } catch (error) {
    console.error("Full Day settings load error:", error.message);
    return res
      .status(500)
      .json({ message: "Unable to load Full Day settings." });
  }
});

/* ---------- GET /api/bookings/full-day/availability ---------- */
router.get("/full-day/availability", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || from).trim();
    const availability = await fullDayAvailabilityForRange({ from, to });
    return res.json(availability);
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      code: error?.code || "FULL_DAY_AVAILABILITY_ERROR",
      message: error?.message || "Unable to load Full Day availability.",
    });
  }
});

/* ---------- GET /api/bookings/full-day/eligibility ---------- */
/**
 * What this customer would pay. Elite members get one Full Day per billing
 * period included; everyone else, and an Elite member who has already used
 * theirs, pays. The frontend needs to know which before it shows a price, so
 * this is computed here rather than inferred from the plan name on the client.
 */
router.get("/full-day/eligibility", auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    if (!me) {
      return res.status(401).json({ message: "User not found or session expired." });
    }
    const addressId = req.query.addressId || me.defaultAddressId;
    const subdoc = addressId ? me.addresses?.id?.(addressId) : null;
    if (!subdoc) {
      return res.json({
        includedAvailable: false,
        includedUsed: false,
        periodEnd: null,
        reason: "no_address",
      });
    }
    const state = await includedFullDayState({ user: me, addressId: subdoc._id });
    return res.json({
      addressId: String(subdoc._id),
      includedAvailable: state.entitled && !state.used,
      includedUsed: state.entitled && state.used,
      isElite: state.entitled || state.reason === "no_billing_period",
      periodStart: state.periodStart,
      periodEnd: state.periodEnd,
      reason: state.reason,
    });
  } catch (error) {
    console.error("Full Day eligibility error:", error.message);
    return res.status(500).json({ message: "Unable to check Full Day eligibility." });
  }
});

/* ---------- POST /api/bookings/full-day/book ---------- */
/**
 * The Elite member's included Full Day. No money changes hands, so there is no
 * Stripe hold to hide behind: the entitlement is spent first, and only then is
 * the day taken. Spending first is deliberate. It is the step protected by a
 * unique index, so two taps of the button collide there, where the loser gets a
 * clean refusal, instead of colliding over calendar capacity where the loser
 * would have already burned the benefit.
 */
router.post(
  "/full-day/book",
  auth,
  ensureNotBlacklisted,
  upload.array("images", 10),
  async (req, res) => {
    let entitlement = null;
    let booking = null;
    const uploadedS3Keys = [];

    try {
      const settings = await getFullDayVisitSettings();
      if (!settings.enabled) {
        return res.status(503).json({
          message: "Full Day Fixter booking is temporarily unavailable.",
          code: "FULL_DAY_DISABLED",
        });
      }

      const me = await User.findById(req.user.id);
      if (!me) {
        return res.status(401).json({ message: "User not found or session expired." });
      }

      const { addressId, date, note } = req.body;
      if (!addressId || !mongoose.isValidObjectId(addressId)) {
        return res.status(400).json({ message: "Please choose an address for this booking." });
      }
      const subdoc = me.addresses?.id?.(addressId);
      if (!subdoc) {
        return res.status(400).json({ message: "Address not found on your account." });
      }
      if (!note || String(note).trim().split(/\s+/).filter(Boolean).length < 3) {
        return res.status(400).json({
          message: "Tell us what you would like done, in at least a few words.",
        });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
        return res.status(400).json({ message: "Please choose a date." });
      }

      const state = await includedFullDayState({ user: me, addressId: subdoc._id });
      if (!state.entitled) {
        return res.status(403).json({
          code:
            state.reason === "no_billing_period"
              ? "FULL_DAY_BILLING_PERIOD_UNKNOWN"
              : "FULL_DAY_NOT_INCLUDED",
          message:
            state.reason === "no_billing_period"
              ? "We could not confirm your current billing period. Please contact us and we will book this for you."
              : "A Full Day is included with Elite. Choose the $499 Full Day instead.",
        });
      }
      if (state.used) {
        return res.status(409).json({
          code: "FULL_DAY_BENEFIT_ALREADY_USED",
          message:
            "You have already used your included Full Day for this billing period. You can book another for $499.",
        });
      }

      // Fail before spending anything if the day is already gone.
      await assertFullDayBookable({ date });
      await ensureVisitEntitlementIndexesOnce();

      entitlement = await consumeIncludedFullDay({
        user: me,
        addressId: subdoc._id,
        addressSnapshot: {
          line1: subdoc.line1 || "",
          city: subdoc.city || "",
          state: subdoc.state || "",
          zip: subdoc.zip || "",
          county: subdoc.county || "",
        },
        periodStart: state.periodStart,
        periodEnd: state.periodEnd,
        durationMinutes: settings.approximateHours * 60,
      });

      const bookingNumber = Math.floor(10000000 + Math.random() * 90000000).toString();
      const uploadResult = await uploadBookingImages({
        files: req.files || [],
        bookingDate: new Date(`${date}T12:00:00Z`),
        bookingNumber,
      });
      uploadedS3Keys.push(...uploadResult.uploadedS3Keys);

      const result = await createFullDayBooking({
        date,
        actorUser: me,
        createdByType: "customer",
        bookingData: {
          bookingNumber,
          service: FULL_DAY_SERVICE,
          selectedTask: FULL_DAY_SERVICE,
          user: req.user.id,
          userId: me.userId,
          name: me.name,
          phone: me.phone,
          email: me.email,
          addressId: subdoc._id,
          address: subdoc.line1 || "",
          city: subdoc.city || "",
          state: subdoc.state || "",
          zip: subdoc.zip || "",
          county: subdoc.county || "",
          subscription: "Elite",
          accessType: "membership",
          bookingType: "full_day_visit",
          paymentState: "not_required",
          paymentStatus: "Included with Elite",
          entitlementId: entitlement._id,
          isFreeFirstVisit: false,
          note: String(note || "").trim(),
          images: uploadResult.images,
          status: "Pending",
        },
      });
      booking = result.booking;

      // The day is booked and the benefit is spent. Linking the two is
      // bookkeeping, so a failure here is logged rather than turned into an
      // error that tells the customer their booking did not happen.
      try {
        entitlement.bookingId = booking._id;
        await entitlement.save();
      } catch (linkError) {
        console.error("Full Day entitlement link failed:", linkError.message);
      }

      await sendFullDayConfirmationEmails({
        booking,
        user: me,
        settings,
        included: true,
        periodEnd: state.periodEnd,
      });

      return res.json({
        bookingId: String(booking._id),
        bookingNumber: booking.bookingNumber,
        entitlementId: String(entitlement._id),
        date: booking.date,
        scheduledStart: booking.scheduledStart,
        scheduledEnd: booking.scheduledEnd,
        included: true,
      });
    } catch (error) {
      console.error("Full Day booking error:", error.stack || error.message);
      try {
        if (!booking && entitlement?._id) {
          // The benefit was taken but the day was not. Give it straight back.
          entitlement.status = "canceled";
          entitlement.consumedAt = null;
          await entitlement.save();
        }
      } catch (cleanupError) {
        console.error("Full Day entitlement rollback failed:", cleanupError.message);
      }
      try {
        if (!booking && uploadedS3Keys.length) {
          await deletePublicObjects({ Bucket: S3_BUCKET, Keys: uploadedS3Keys });
        }
      } catch (_) {}
      return res.status(error?.statusCode || 500).json({
        code: error?.code || "FULL_DAY_BOOKING_FAILED",
        message: error?.message || "Unable to book your Full Day.",
      });
    }
  }
);

/* ---------- POST /api/bookings/full-day/checkout ---------- */
/**
 * The paid Full Day. Same shape as the one-time visit checkout: the day is held
 * for the length of the hold, Stripe is given the same deadline through
 * expires_at, and the webhook is what turns a hold into a reservation. Nothing
 * about the payment lives in this route beyond starting it.
 */
router.post(
  "/full-day/checkout",
  auth,
  ensureNotBlacklisted,
  upload.array("images", 10),
  async (req, res) => {
    let booking = null;
    let entitlement = null;
    const uploadedS3Keys = [];

    try {
      if (!hasStripeSecretKey()) {
        return res.status(503).json({
          message: "Secure checkout is temporarily unavailable. Please try again shortly.",
          code: "STRIPE_NOT_CONFIGURED",
        });
      }
      const settings = await getFullDayVisitSettings();
      if (!settings.enabled) {
        return res.status(503).json({
          message: "Full Day Fixter booking is temporarily unavailable.",
          code: "FULL_DAY_DISABLED",
        });
      }
      const priceId = settings.stripePriceId;
      if (!priceId) {
        return res.status(503).json({
          message: "Full Day checkout is not configured yet.",
          code: "FULL_DAY_PRICE_NOT_CONFIGURED",
        });
      }

      const me = await User.findById(req.user.id);
      if (!me) {
        return res.status(401).json({ message: "User not found or session expired." });
      }

      const { addressId, date, note } = req.body;
      if (!addressId || !mongoose.isValidObjectId(addressId)) {
        return res.status(400).json({ message: "Please choose an address for this booking." });
      }
      const subdoc = me.addresses?.id?.(addressId);
      if (!subdoc) {
        return res.status(400).json({ message: "Address not found on your account." });
      }
      if (!note || String(note).trim().split(/\s+/).filter(Boolean).length < 3) {
        return res.status(400).json({
          message: "Tell us what you would like done, in at least a few words.",
        });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
        return res.status(400).json({ message: "Please choose a date." });
      }
      if (!isAddressInServiceArea(subdoc)) {
        return res.status(403).json({
          message: outOfServiceAreaMessage(),
          code: "OUT_OF_SERVICE_AREA",
        });
      }

      await assertFullDayBookable({ date });

      const holdExpiresAt = new Date(Date.now() + settings.holdMinutes * 60 * 1000);
      const bookingNumber = Math.floor(10000000 + Math.random() * 90000000).toString();
      const uploadResult = await uploadBookingImages({
        files: req.files || [],
        bookingDate: new Date(`${date}T12:00:00Z`),
        bookingNumber,
      });
      uploadedS3Keys.push(...uploadResult.uploadedS3Keys);

      await ensureVisitEntitlementIndexesOnce();
      entitlement = await VisitEntitlement.create({
        user: me._id,
        userId: me.userId,
        addressId: subdoc._id,
        addressSnapshot: {
          line1: subdoc.line1 || "",
          city: subdoc.city || "",
          state: subdoc.state || "",
          zip: subdoc.zip || "",
          county: subdoc.county || "",
        },
        kind: "full_day_visit",
        source: "purchase",
        status: "pending_payment",
        priceCents: settings.priceCents,
        currency: settings.currency,
        durationMinutes: settings.approximateHours * 60,
        holdExpiresAt,
      });

      const result = await createFullDayBooking({
        date,
        actorUser: me,
        createdByType: "customer",
        reservationStatus: "held",
        holdExpiresAt,
        bookingData: {
          bookingNumber,
          service: FULL_DAY_SERVICE,
          selectedTask: FULL_DAY_SERVICE,
          user: req.user.id,
          userId: me.userId,
          name: me.name,
          phone: me.phone,
          email: me.email,
          addressId: subdoc._id,
          address: subdoc.line1 || "",
          city: subdoc.city || "",
          state: subdoc.state || "",
          zip: subdoc.zip || "",
          county: subdoc.county || "",
          subscription: "Full Day Fixter",
          accessType: "one_time",
          bookingType: "full_day_visit",
          paymentState: "pending",
          paymentStatus: "Pending",
          entitlementId: entitlement._id,
          paymentHoldExpiresAt: holdExpiresAt,
          isFreeFirstVisit: false,
          note: String(note || "").trim(),
          images: uploadResult.images,
          status: "Pending",
        },
      });
      booking = result.booking;

      entitlement.bookingId = booking._id;
      await entitlement.save();

      const stripeCustomerId = await resolveUserStripeCustomerId(me);
      const metadata = {
        productKind: FULL_DAY_PRODUCT_KIND,
        bookingId: String(booking._id),
        entitlementId: String(entitlement._id),
        userMongoId: String(me._id),
        userId: String(me.userId || me._id),
        addressId: String(subdoc._id),
      };
      const sessionConfig = {
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: String(booking._id),
        metadata,
        payment_intent_data: { metadata },
        success_url: `${CLIENT_URL}/book/confirmation?booking_id=${booking._id}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${CLIENT_URL}/book?visit=full-day&canceled=true&booking_id=${booking._id}`,
        expires_at: Math.floor(holdExpiresAt.getTime() / 1000),
      };
      if (stripeCustomerId) sessionConfig.customer = stripeCustomerId;
      else sessionConfig.customer_email = me.email;

      const checkoutSession = await stripe.checkout.sessions.create(sessionConfig);
      if (!checkoutSession?.url) {
        throw new Error("Stripe checkout did not return a redirect URL");
      }

      entitlement.stripeCheckoutSessionId = checkoutSession.id;
      entitlement.stripeCustomerId = checkoutSession.customer
        ? String(checkoutSession.customer)
        : stripeCustomerId || null;
      await entitlement.save();

      return res.json({
        url: checkoutSession.url,
        bookingId: String(booking._id),
        entitlementId: String(entitlement._id),
        holdExpiresAt,
      });
    } catch (error) {
      console.error("Full Day checkout error:", error.stack || error.message);
      try {
        if (booking?._id) {
          await releaseFullDayCapacity(booking);
          await Booking.updateOne(
            { _id: booking._id },
            {
              $set: {
                status: "Canceled",
                paymentState: "failed",
                paymentStatus: "Failed",
              },
            }
          );
        }
      } catch (cleanupError) {
        console.error("Full Day booking cleanup failed:", cleanupError.message);
      }
      try {
        if (entitlement?._id) {
          entitlement.status = "payment_failed";
          await entitlement.save();
        }
      } catch (_) {}
      try {
        if (uploadedS3Keys.length) {
          await deletePublicObjects({ Bucket: S3_BUCKET, Keys: uploadedS3Keys });
        }
      } catch (_) {}

      if (["FULL_DAY_UNAVAILABLE", "SLOT_UNAVAILABLE", "SLOT_CONFLICT"].includes(error?.code)) {
        return res.status(409).json({
          code: "FULL_DAY_UNAVAILABLE",
          message: "That day is no longer available. Please choose another date.",
        });
      }
      return res.status(error?.statusCode || 500).json({
        code: error?.code || "FULL_DAY_CHECKOUT_FAILED",
        message: error?.message || "Unable to start Full Day checkout.",
      });
    }
  }
);

/* ---------- POST /api/bookings (create) ---------- */
router.post(
  "/",
  auth,
  ensureNotBlacklisted,
  upload.array("images", 10),
  async (req, res) => {
    res.set("X-Bookings-Route", BOOKINGS_ROUTE_VERSION);

    console.log("📸 FILE COUNT RECEIVED:", req.files?.length);
    console.log("📦 PAYLOAD SIZE (bytes):", req.headers["content-length"]);

    let counterStamped = null;
    const uploadedS3Keys = [];
    let bookingCommitted = false;
    // Declared out here so the catch block can release a reserved offer.
    let introVisitClaimed = false;

    try {
      const me = await User.findById(req.user.id);
      if (!me) {
        return res.status(401).json({ message: "User not found or session expired." });
      }

      const { service, date, note, requestedDate, requestedTime } = req.body;
      const addressId = req.body.addressId;

      if (!service || !date || !note) {
        return res.status(400).json({ message: "Missing required fields." });
      }

      if (!addressId || !mongoose.isValidObjectId(addressId)) {
        return res
          .status(400)
          .json({ message: "Please choose an address for this booking." });
      }

      const useReservationEngine = reservationEngineEnabled();
      const requestedStart =
        useReservationEngine &&
        /^\d{4}-\d{2}-\d{2}$/.test(String(requestedDate || "")) &&
        /^\d{2}:\d{2}$/.test(String(requestedTime || ""))
          ? moment.tz(
              `${requestedDate} ${requestedTime}`,
              "YYYY-MM-DD HH:mm",
              true,
              "America/New_York"
            )
          : null;
      const bookingDate = requestedStart?.isValid()
        ? requestedStart.toDate()
        : new Date(date);
      if (Number.isNaN(bookingDate.getTime())) {
        return res.status(400).json({ message: "Invalid date." });
      }

      const subdoc = me.addresses?.id?.(addressId);
      if (!subdoc) {
        return res.status(400).json({ message: "Address not found on your account." });
      }

      const access = await resolveBookingSubscription(me, subdoc, {
        verifyStripe: true,
      });
      const activeSub = access.subscription;

      let usingFreeFirstVisit = false;

      let plan = String(activeSub?.subscriptionType || "").toLowerCase();
      let bookingLimit = plan === "basic" ? 1 : plan ? 2 : 0;

      if (access.staleSubscription) {
        return res.status(403).json({
          message:
            "Your membership could not be verified as active. Please update billing or contact support before booking.",
          code: "SUBSCRIPTION_ACCESS_INACTIVE",
        });
      }

      if (!activeSub) {
        // The introductory offer is only extended to serviceable properties.
        // ZIP is used because the user-entered county string is not trustworthy.
        if (!isAddressInServiceArea(subdoc)) {
          return res.status(403).json({
            message: outOfServiceAreaMessage(),
            code: "OUT_OF_SERVICE_AREA",
          });
        }

        // Persistent per-property state, reconciled against the claimed
        // booking. Survives booking cancellation, deletion and cleanup.
        const introState = await getIntroVisitState({
          user: me,
          address: subdoc,
          Booking,
        });

        if (introState.status === INTRO_VISIT_STATUS.CONSUMED) {
          return res.status(403).json({
            message:
              "You already used your free first visit for this address. Please purchase a subscription to book again.",
            code: "INTRO_VISIT_CONSUMED",
          });
        }

        if (introState.status === INTRO_VISIT_STATUS.CLAIMED) {
          return res.status(403).json({
            message:
              "Your free first visit is already booked for this address. Please complete or cancel it before booking again.",
            code: "INTRO_VISIT_CLAIMED",
          });
        }

        if (String(service) !== INTRO_VISIT_SERVICE) {
          return res.status(400).json({
            message:
              'Free first visit is available for "Labor Only" only. Please select "Labor Only" or purchase a plan.',
          });
        }

        // Job photos are an operational requirement: technicians review them
        // before the visit so they arrive with the right tools and materials.
        // Enforced server-side here so a crafted request cannot skip it.
        // Scoped to the free-visit branch so member validation is untouched.
        if (!req.files?.length) {
          return res.status(400).json({
            message:
              "Add at least one photo so your technician can review the job and arrive prepared.",
            code: "PHOTO_REQUIRED",
          });
        }

        // Reserve the offer BEFORE creating the booking. Only one concurrent
        // request can win this update, which closes the double-claim race.
        const won = await claimIntroVisitAtomic({
          UserModel: User,
          userId: me._id,
          addressId: subdoc._id,
        });

        if (!won) {
          return res.status(403).json({
            message:
              "Your free first visit is already booked for this address. Please complete or cancel it before booking again.",
            code: "INTRO_VISIT_CLAIMED",
          });
        }

        introVisitClaimed = true;
        usingFreeFirstVisit = true;
        plan = "free";
        bookingLimit = 1;
      }

      const futureAddressBookings = await Booking.find({
        user: req.user.id,
        addressId: subdoc._id,
        date: { $gte: new Date() },
      })
        .select("status")
        .lean();
      const activeCount = futureAddressBookings.filter(
        (booking) => !isTerminalBookingStatus(booking.status)
      ).length;

      if (bookingLimit > 0 && activeCount >= bookingLimit) {
        return res.status(400).json({
          message:
            bookingLimit === 1
              ? "This address allows 1 active booking at a time. Please complete/cancel the active booking for this address to schedule another."
              : "This address allows 2 active bookings at a time. Please complete/cancel an active booking for this address to schedule another.",
        });
      }

      const cfg = useReservationEngine
        ? null
        : await CalendarConfig.findOne().lean();
      const tz = cfg?.timezone || "America/New_York";
      if (!useReservationEngine) {
        const capacity = Math.max(1, Number(cfg?.maxConcurrent ?? 1));
        const ymd = ymdInTZ(bookingDate, tz);
        const hh = hhmmInTZ(bookingDate, tz);
        const gate = await SlotCounter.findOneAndUpdate(
          {
            ymd,
            time: hh,
            $or: [{ count: { $lt: capacity } }, { count: { $exists: false } }],
          },
          {
            $inc: { count: 1 },
            $setOnInsert: { ymd, time: hh },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        if (!gate || gate.count > capacity) {
          return res.status(409).json({
            code: "SLOT_UNAVAILABLE",
            message: "This time is fully booked. Please choose another time.",
          });
        }
        counterStamped = { ymd, time: hh };
      }

      const bookingNumber = Math.floor(10000000 + Math.random() * 90000000).toString();

      const images = [];
      const yyyy = bookingDate.getFullYear();
      const mm = String(bookingDate.getMonth() + 1).padStart(2, "0");
      const dd = String(bookingDate.getDate()).padStart(2, "0");
      const formattedDate = `${yyyy}-${mm}-${dd}`;

      if (S3_BUCKET) {
        const baseKey = `${S3_PREFIX}/${formattedDate}/booking-${bookingNumber}`;

        for (const f of req.files || []) {
          const ext = path.extname(f.originalname).toLowerCase();
          const stem = safeName(path.basename(f.originalname, ext));

          let finalBuffer = f.buffer;
          let finalExt = ext;
          let finalContentType = f.mimetype || "application/octet-stream";

          const needsConversion =
            [".heic", ".heif", ".png", ".bmp", ".tiff", ".tif"].includes(ext) ||
            [
              "image/heic",
              "image/heif",
              "image/png",
              "image/bmp",
              "image/tiff",
            ].includes(f.mimetype);

          if (needsConversion) {
            try {
              console.log(`🔄 Converting ${f.originalname} to optimized JPG...`);
              finalBuffer = await sharp(f.buffer)
                .rotate()
                .resize(1600, 1600, {
                  fit: "inside",
                  withoutEnlargement: true,
                })
                .jpeg({
                  quality: 75,
                  chromaSubsampling: "4:2:0",
                  mozjpeg: true,
                })
                .toBuffer();

              finalExt = ".jpg";
              finalContentType = "image/jpeg";
              console.log(
                `✅ Converted ${f.originalname} to JPG (${(
                  finalBuffer.length / 1024
                ).toFixed(1)}KB)`
              );
            } catch (convErr) {
              console.error(
                `❌ Image conversion failed for ${f.originalname}:`,
                convErr.message
              );
            }
          } else if ([".jpg", ".jpeg"].includes(ext)) {
            try {
              finalBuffer = await sharp(f.buffer)
                .rotate()
                .resize(1600, 1600, {
                  fit: "inside",
                  withoutEnlargement: true,
                })
                .jpeg({
                  quality: 75,
                  chromaSubsampling: "4:2:0",
                  mozjpeg: true,
                })
                .toBuffer();
              console.log(
                `✅ Optimized ${f.originalname} (${(
                  finalBuffer.length / 1024
                ).toFixed(1)}KB)`
              );
            } catch (optErr) {
              console.warn(
                `⚠️ JPG optimization failed for ${f.originalname}, using original`
              );
            }
          }

          const key = `${baseKey}/${Date.now()}-${stem}${finalExt}`;
          const url = await putPublicObject({
            Bucket: S3_BUCKET,
            Key: key,
            Body: finalBuffer,
            ContentType: finalContentType,
          });
          uploadedS3Keys.push(key);
          images.push(url);
        }
      } else {
        for (const f of req.files || []) {
          images.push(`local://${safeName(f.originalname)}`);
        }
      }

      const bookingData = {
        bookingNumber,
        date: bookingDate,
        service,
        user: req.user.id,
        userId: me.userId,
        name: me.name,
        phone: me.phone,
        email: me.email,

        addressId: subdoc._id,
        address: subdoc.line1 || "",
        city: subdoc.city || "",
        state: subdoc.state || "",
        zip: subdoc.zip || "",
        county: subdoc.county || "",

        subscription: usingFreeFirstVisit
          ? "Free visit"
          : activeSub.subscriptionType,
        accessType: usingFreeFirstVisit ? "free_first_visit" : "membership",
        bookingType: "membership_visit",
        paymentState: "not_required",
        isFreeFirstVisit: usingFreeFirstVisit,
        freeFirstVisitClaimedAt: usingFreeFirstVisit ? new Date() : null,
        note,
        images,
        status: "Pending",
      };
      let booking;
      if (useReservationEngine) {
        const result = await createBookingWithReservation({
          bookingData,
          slotStart: bookingDate,
          createdByType: "customer",
          actorUser: me,
          assignmentSource: "automatic",
        });
        booking = result.booking;
      } else {
        booking = new Booking(bookingData);
        await booking.save();
        await logBookingCreated({
          booking,
          actor: {
            actorUserId: me?._id || null,
            actorName: me?.name || booking.name || "Customer",
            actorEmail: me?.email || booking.email || "",
            actorRole: "customer",
            actorPosition: "",
          },
        });
      }
      bookingCommitted = true;

      // The offer was already reserved atomically before creation. Link the
      // booking to it so cancellation and completion can reconcile later.
      if (usingFreeFirstVisit) {
        try {
          await attachBookingToClaim({
            UserModel: User,
            userId: me._id,
            addressId: subdoc._id,
            bookingId: booking._id,
          });
        } catch (e) {
          console.error("attachBookingToClaim failed:", e.message);
        }
      }

      // GHL SMS automation hooks
      try {
        const contactId = await createOrUpdateContact({
          name: me.name,
          email: me.email,
          phone: me.phone,
        });

        const pretty = formatBookingDateTime(booking.date);

        await updateContactFields(contactId, [
          {
            key: "booking_datetime_pretty",
            value: pretty,
          },
        ]);

        await addTag(contactId, "booking_created");
      } catch (e) {
        console.log("GHL booking_created error:", e.message);
      }

      // emails (best effort)
      try {
        const addressLine = [subdoc.line1, subdoc.city, subdoc.state, subdoc.zip]
          .filter(Boolean)
          .join(", ");

        const nyTime = new Date(booking.date).toLocaleString("en-US", {
          timeZone: tz,
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });

        await mail.sendTx(
          "booking_created",
          me.email,
          {
            name: me.name || me.email.split("@")[0],
            bookingNumber: booking.bookingNumber,
            date: booking.date,
            service: booking.service,
            address: addressLine,
          },
          {
            bccAdmin: false,
            logContext: {
              bookingId: booking._id,
              bookingNumber: booking.bookingNumber,
              customerName: me.name || booking.name || "",
              customerEmail: me.email || booking.email || "",
              recipientName: me.name || "",
              recipientEmail: me.email,
              emailType: "transactional",
              source: "bookingCreate",
            },
          }
        );

        await mail.sendPromo(process.env.MAIL_ADMIN || "getfixter@gmail.com", {
          subject: `New Booking from ${me.name}`,
          html: `
              <h2>New Booking Created</h2>
              <ul>
                <li><strong>Name:</strong> ${me.name}</li>
                <li><strong>Email:</strong> ${me.email}</li>
                <li><strong>Phone:</strong> ${me.phone || "-"}</li>
                <li><strong>Service:</strong> ${booking.service}</li>
                <li><strong>Date:</strong> ${nyTime}</li>
                <li><strong>Address:</strong> ${addressLine}</li>
                <li><strong>Booking #:</strong> ${booking.bookingNumber}</li>
              </ul>
            `,
          logContext: {
            templateKey: "admin_booking_created",
            bookingId: booking._id,
            bookingNumber: booking.bookingNumber,
            customerName: me.name || booking.name || "",
            customerEmail: me.email || booking.email || "",
            recipientEmail: process.env.MAIL_ADMIN || "getfixter@gmail.com",
            emailType: "admin",
            source: "bookingCreate",
          },
        });
      } catch (mailErr) {
        console.log("Mail booking_created error:", mailErr.message);
      }

      const nycTime = bookingDate.toLocaleTimeString("en-US", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      return res.json({
        message: "Booking created",
        booking: {
          bookingNumber,
          service,
          date: bookingDate.toISOString(),
          time: nycTime,
          status: "Pending",
        },
      });
    } catch (error) {
      console.error("❌ Booking Error:", error.stack || error.message);

      // The introductory offer was reserved before booking creation. If the
      // booking never committed, hand it back so the customer is not left
      // holding a claim they could not use. Never releases a consumed offer.
      try {
        if (introVisitClaimed && !bookingCommitted) {
          await releaseIntroVisitClaim({
            UserModel: User,
            userId: req.user.id,
            addressId: req.body.addressId,
          });
        }
      } catch (releaseError) {
        console.error("releaseIntroVisitClaim failed:", releaseError?.message);
      }

      try {
        if (counterStamped && !bookingCommitted) {
          await SlotCounter.updateOne(
            { ymd: counterStamped.ymd, time: counterStamped.time },
            { $inc: { count: -1 } }
          );
        }
      } catch (_) {}
      try {
        if (uploadedS3Keys.length && !bookingCommitted) {
          await deletePublicObjects({
            Bucket: S3_BUCKET,
            Keys: uploadedS3Keys,
          });
        }
      } catch (cleanupError) {
        console.error(
          "S3 booking upload cleanup failed:",
          cleanupError?.message || cleanupError
        );
      }

      const msg = (error && (error.message || "")).toString();
      if (
        ["SLOT_UNAVAILABLE", "SLOT_CONFLICT", "TECHNICIAN_UNAVAILABLE"].includes(
          error?.code
        )
      ) {
        let suggestions = [];
        try {
          suggestions = await suggestNextAvailableSlots({
            slotStart:
              req.body?.requestedDate && req.body?.requestedTime
                ? moment.tz(
                    `${req.body.requestedDate} ${req.body.requestedTime}`,
                    "YYYY-MM-DD HH:mm",
                    "America/New_York"
                  ).toDate()
                : new Date(req.body?.date),
          });
        } catch (_) {}
        return res.status(409).json({
          code: "SLOT_UNAVAILABLE",
          message: "This time is no longer available. Please choose another time.",
          suggestions,
        });
      }
      if (error?.code === "TRANSACTIONS_UNAVAILABLE") {
        return res.status(503).json({
          code: "TRANSACTIONS_UNAVAILABLE",
          message: "Booking is temporarily unavailable. Please try again later.",
        });
      }
      if (error?.name === "ValidationError" || /validation failed/i.test(msg)) {
        const first =
          (error.errors && Object.values(error.errors)[0]?.message) || msg;
        return res.status(400).json({ message: first });
      }

      return res.status(500).json({ message: "Booking failed", error: msg });
    }
  }
);

module.exports = router;
