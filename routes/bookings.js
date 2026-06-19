// routes/bookings.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const mongoose = require("mongoose");

const Booking = require("../models/Booking");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
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
const { putPublicObject } = require("../utils/s3");
const {
  subscriptionGrantsAccess,
  verifySubscriptionAccess,
} = require("../utils/subscriptionManagement");

const BOOKINGS_ROUTE_VERSION = "v5.1-capacity-gated";
console.log("Loaded routes/bookings.js", BOOKINGS_ROUTE_VERSION);

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

    let hasAnyBookings = false;

    if (!hasSubscription && !access.staleSubscription) {
      const anyBooking = await Booking.exists({ user: me._id });
      hasAnyBookings = !!anyBooking;

      freeFirstVisitAvailable = !hasAnyBookings;

      if (freeFirstVisitAvailable) {
        plan = "free";
        bookingLimit = 1;
      } else {
        plan = "";
        bookingLimit = 0;
      }
    }

    const ACTIVE_EXCLUDE = [
      "Canceled",
      "Cancelled",
      "Completed",
      "Complete",
      "Done",
      "Failed",
      "No-Show",
      "Noshow",
    ];

    const now = new Date();
    const activeCount = await Booking.countDocuments({
      user: req.user.id,
      addressId: subdoc._id,
      date: { $gte: now },
      status: { $nin: ACTIVE_EXCLUDE },
    });

    const next = await Booking.findOne({
      user: req.user.id,
      addressId: subdoc._id,
      date: { $gte: now },
      status: { $nin: ACTIVE_EXCLUDE },
    }).sort({ date: 1 });

    return res.json({
      plan,
      hasSubscription,
      freeFirstVisitAvailable,
      bookingLimit,
      activeCount,
      hasAnyBookings,
      subscriptionAccessBlocked: access.staleSubscription,
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

/* ---------- CANCEL/DELETE handler (shared) ---------- */
async function cancelOrDelete(req, res) {
  try {
    const { id } = req.params;
    if (!id || !mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid booking id" });
    }

    const booking = await Booking.findOne({ _id: id, user: req.user.id });
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    const before = bookingSnapshot(booking);

    const status = String(booking.status || "").toLowerCase();
    const deletable = new Set(["pending", "complete", "completed"]);

    try {
      const cfg = await CalendarConfig.findOne().lean();
      const tz = cfg?.timezone || "America/New_York";
      const ymd = ymdInTZ(new Date(booking.date), tz);
      const hh = hhmmInTZ(new Date(booking.date), tz);
      await SlotCounter.updateOne({ ymd, time: hh }, { $inc: { count: -1 } });
    } catch (e) {
      console.log("slot decrement (cancel/delete) error:", e.message);
    }

    if (deletable.has(status)) {
      await Booking.deleteOne({ _id: booking._id });
      return res.json({ ok: true, action: "deleted", message: "Booking deleted." });
    }

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
      req,
    });

    // GHL SMS automation hooks
    try {
      const me = await User.findById(req.user.id).lean();

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
      const me = await User.findById(req.user.id).lean();
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
          { bccAdmin: false }
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
        { bccAdmin: false }
      );
    } catch (e) {
      console.log("Mail booking_canceled/admin_booking_canceled error:", e.message);
    }

    return res.json({ ok: true, action: "canceled", message: "Booking canceled." });
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

    try {
      const me = await User.findById(req.user.id);
      if (!me) {
        return res.status(401).json({ message: "User not found or session expired." });
      }

      const { service, date, note } = req.body;
      const addressId = req.body.addressId;

      if (!service || !date || !note) {
        return res.status(400).json({ message: "Missing required fields." });
      }

      if (!addressId || !mongoose.isValidObjectId(addressId)) {
        return res
          .status(400)
          .json({ message: "Please choose an address for this booking." });
      }

      const bookingDate = new Date(date);
      if (Number.isNaN(bookingDate.getTime())) {
        return res.status(400).json({ message: "Invalid date." });
      }

      const subdoc = me.addresses?.id?.(addressId);
      if (!subdoc) {
        return res.status(400).json({ message: "Address not found on your account." });
      }

      const ACTIVE_EXCLUDE = [
        "Canceled",
        "Cancelled",
        "Completed",
        "Complete",
        "Done",
        "Failed",
        "No-Show",
        "Noshow",
      ];

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
        const alreadyUsedFree = await Booking.exists({
          user: me._id,
          addressId: subdoc._id,
          isFreeFirstVisit: true,
        });

        if (alreadyUsedFree) {
          return res.status(403).json({
            message:
              "You already used your free first visit for this address. Please purchase a subscription to book again.",
          });
        }

        usingFreeFirstVisit = true;
        plan = "free";
        bookingLimit = 1;

        if (String(service) !== "Labor Only") {
          return res.status(400).json({
            message:
              'Free first visit is available for "Labor Only" only. Please select "Labor Only" or purchase a plan.',
          });
        }
      }

      const activeCount = await Booking.countDocuments({
        user: req.user.id,
        addressId: subdoc._id,
        date: { $gte: new Date() },
        status: { $nin: ACTIVE_EXCLUDE },
      });

      if (bookingLimit > 0 && activeCount >= bookingLimit) {
        return res.status(400).json({
          message:
            bookingLimit === 1
              ? "This address allows 1 active booking at a time. Please complete/cancel the active booking for this address to schedule another."
              : "This address allows 2 active bookings at a time. Please complete/cancel an active booking for this address to schedule another.",
        });
      }

      const cfg = await CalendarConfig.findOne().lean();
      const tz = cfg?.timezone || "America/New_York";
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
          message: "This time is fully booked. Please choose another time.",
        });
      }
      counterStamped = { ymd, time: hh };

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
          images.push(url);
        }
      } else {
        for (const f of req.files || []) {
          images.push(`local://${safeName(f.originalname)}`);
        }
      }

      const booking = new Booking({
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
        isFreeFirstVisit: usingFreeFirstVisit,
        freeFirstVisitClaimedAt: usingFreeFirstVisit ? new Date() : null,
        note,
        images,
        status: "Pending",
      });

      await booking.save();
      await logBookingCreated({
        booking,
        actorName: "System",
      });

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
          { bccAdmin: false }
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

      try {
        if (counterStamped) {
          await SlotCounter.updateOne(
            { ymd: counterStamped.ymd, time: counterStamped.time },
            { $inc: { count: -1 } }
          );
        }
      } catch (_) {}

      const msg = (error && (error.message || "")).toString();
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
