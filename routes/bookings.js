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

const auth = require("../middleware/auth");
const { ensureNotBlacklisted } = require("../middleware/blacklist");
const mail = require("../utils/emailService");
const { putPublicObject } = require("../utils/s3");

const BOOKINGS_ROUTE_VERSION = "v5.1-capacity-gated";
console.log("Loaded routes/bookings.js", BOOKINGS_ROUTE_VERSION);

router.get("/__version", (_req, res) => res.json({ v: BOOKINGS_ROUTE_VERSION }));

/* ---------- Upload config ---------- */
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = (process.env.S3_PREFIX || "uploads").replace(/\/+$/, "");
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024, files: 10 } });

const safeName = (name) =>
  name.normalize("NFKD").replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_").slice(0, 120);

/* ---------- TZ helpers ---------- */
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hhmmInTZ = (d, tz) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

/* ---------- GET /api/bookings (all user bookings) ---------- */
router.get("/", auth, async (req, res) => {
  try {
    const bookings = await Booking.find({ user: req.user.id })
      .sort({ date: 1 }) // сортувати за датою (найстаріші перші)
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
    if (!addressId) return res.status(400).json({ message: "Missing addressId" });

    const now = new Date();
    const next = await Booking.findOne({
      user: req.user.id,
      addressId,
      date: { $gte: now },
      status: {
        $nin: [
          "Canceled", "Cancelled", "Completed", "Complete", "Done", "Failed", "No-Show", "Noshow"
        ],
      },
    }).sort({ date: 1 });

    if (!next) return res.json({ future: null });

    return res.json({
      future: { _id: String(next._id), date: next.date, status: next.status },
    });
  } catch (e) {
    console.error("GET /bookings/next error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

/* ---------- CANCEL/DELETE handler (shared) ---------- */
async function cancelOrDelete(req, res) {
  try {
    const { id } = req.params;
    if (!id || !mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid booking id" });
    }

    const booking = await Booking.findOne({ _id: id, user: req.user.id });
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const status = String(booking.status || "").toLowerCase();
    const deletable = new Set(["pending", "complete", "completed"]);

    // decrement slot counter (best effort) for both delete or cancel
    try {
      const cfg = await CalendarConfig.findOne().lean();
      const tz = cfg?.timezone || "America/New_York";
      const ymd = ymdInTZ(new Date(booking.date), tz);
      const hh  = hhmmInTZ(new Date(booking.date), tz);
      await SlotCounter.updateOne({ ymd, time: hh }, { $inc: { count: -1 } });
    } catch (e) {
      console.log("slot decrement (cancel/delete) error:", e.message);
    }

    if (deletable.has(status)) {
      await Booking.deleteOne({ _id: booking._id });
      return res.json({ ok: true, action: "deleted", message: "Booking deleted." });
    }

    booking.statusHistory = (booking.statusHistory || []).concat({ status: booking.status, date: new Date() });
    booking.status = "Canceled";
    await booking.save();

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
router.post("/", auth, ensureNotBlacklisted, upload.array("images", 10), async (req, res) => {
  res.set("X-Bookings-Route", BOOKINGS_ROUTE_VERSION);
  let counterStamped = null; // track slot we incremented, for rollback
  try {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(401).json({ message: "User not found or session expired." });

    const { service, date, note } = req.body;
    const addressId = req.body.addressId;

    if (!service || !date || !note)
      return res.status(400).json({ message: "Missing required fields." });

    if (!addressId || !mongoose.isValidObjectId(addressId))
      return res.status(400).json({ message: "Please choose an address for this booking." });

    const bookingDate = new Date(date);
    if (Number.isNaN(bookingDate.getTime()))
      return res.status(400).json({ message: "Invalid date." });

    // pick subdocument address safely
    const subdoc = me.addresses?.id?.(addressId);
    if (!subdoc) return res.status(400).json({ message: "Address not found on your account." });

    // one future booking at a time PER ADDRESS (multi-address allowed)
    const existing = await Booking.findOne({
      user: req.user.id,
      addressId: subdoc._id,
      date: { $gte: new Date() },
      status: { $nin: ["Canceled", "Cancelled", "Completed"] },
    });
    if (existing) {
      return res.status(400).json({
        message: "This address already has an active booking. Cancel it first to book another."
      });
    }

    /* ---- Subscription gate (legacy-safe) ---- */
    let activeSub = await Subscription.findOne({
      user: me._id,
      addressId: subdoc._id,
      status: { $in: ["active", "trialing"] },
    });

    // fallback: allow old addrless sub if it's the default address
    if (!activeSub) {
      const addrless = await Subscription.findOne({
        user: me._id,
        addressId: { $in: [null, undefined] },
        status: { $in: ["active", "trialing"] },
      });
      if (addrless && me.defaultAddressId && String(me.defaultAddressId) === String(subdoc._id)) {
        activeSub = addrless;
      }
    }

    // legacy user fields fallback
    if (!activeSub) {
      const plan = String(me.subscription || "").toLowerCase();
      const notNone = !!plan && plan !== "none";
      const notExpired = !me.subscriptionExpiry || new Date(me.subscriptionExpiry).getTime() >= Date.now();
      if (notNone && notExpired && me.defaultAddressId && String(me.defaultAddressId) === String(subdoc._id)) {
        activeSub = { subscriptionType: plan, status: "active" }; // synthetic
      }
    }

    if (!activeSub) {
      return res.status(403).json({
        message: "This address does not have an active subscription. Purchase a subscription for this address to book a visit.",
      });
    }

    /* ---- ATOMIC CAPACITY GATE (handyman count) ---- */
    const cfg = await CalendarConfig.findOne().lean();
    const tz = cfg?.timezone || "America/New_York";
    const capacity = Math.max(1, Number(cfg?.maxConcurrent ?? 1)); // ADMIN sets to # of handymen
    const ymd = ymdInTZ(bookingDate, tz);
    const hh  = hhmmInTZ(bookingDate, tz);

    // Upsert atomically: allow only if count < capacity
    const gate = await SlotCounter.findOneAndUpdate(
  { ymd, time: hh, $or: [{ count: { $lt: capacity } }, { count: { $exists: false } }] },
  {
    // increment ONLY; do not also set 'count' in $setOnInsert (avoids conflict)
    $inc: { count: 1 },
    $setOnInsert: { ymd, time: hh }
  },
  { upsert: true, new: true, setDefaultsOnInsert: true }
);


    if (!gate || gate.count > capacity) {
      return res.status(409).json({ message: "This time is fully booked. Please choose another time." });
    }
    counterStamped = { ymd, hh };

    /* ---- Build booking ---- */
    const bookingNumber = Math.floor(10000000 + Math.random() * 90000000).toString();

    // uploads with image optimization (HEIC/HEIF/PNG/BMP → JPG)
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

        // Convert HEIC/HEIF/PNG/BMP/TIFF to optimized JPG
        const needsConversion = [".heic", ".heif", ".png", ".bmp", ".tiff", ".tif"].includes(ext) ||
          ["image/heic", "image/heif", "image/png", "image/bmp", "image/tiff"].includes(f.mimetype);

        if (needsConversion) {
          try {
            console.log(`🔄 Converting ${f.originalname} to optimized JPG...`);
            finalBuffer = await sharp(f.buffer)
              .rotate() // auto-rotate based on EXIF
              .resize(2048, 2048, { fit: "inside", withoutEnlargement: true }) // max 2048px
              .jpeg({ quality: 85, mozjpeg: true })
              .toBuffer();
            finalExt = ".jpg";
            finalContentType = "image/jpeg";
            console.log(`✅ Converted ${f.originalname} to JPG (${(finalBuffer.length / 1024).toFixed(1)}KB)`);
          } catch (convErr) {
            console.error(`❌ Image conversion failed for ${f.originalname}:`, convErr.message);
            // Fallback to original if conversion fails
          }
        } else if ([".jpg", ".jpeg"].includes(ext)) {
          // Optimize existing JPGs
          try {
            finalBuffer = await sharp(f.buffer)
              .rotate()
              .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
              .jpeg({ quality: 85, mozjpeg: true })
              .toBuffer();
            console.log(`✅ Optimized ${f.originalname} (${(finalBuffer.length / 1024).toFixed(1)}KB)`);
          } catch (optErr) {
            console.warn(`⚠️ JPG optimization failed for ${f.originalname}, using original`);
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
      for (const f of req.files || []) images.push(`local://${safeName(f.originalname)}`);
    }

    // persist
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

      subscription: activeSub.subscriptionType,
      note,
      images,
      status: "Pending",
    });

    await booking.save();

    // emails (best effort)
    try {
      const addressLine = [subdoc.line1, subdoc.city, subdoc.state, subdoc.zip].filter(Boolean).join(", ");
      const nyTime = new Date(booking.date).toLocaleString("en-US", {
        timeZone: tz,
        weekday: "long", year: "numeric", month: "long", day: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: true,
      });

      await mail.sendTx(
        "booking_created",
        me.email,
        {
          name: me.name || me.email.split("@")[0],
          bookingNumber: booking.bookingNumber,
          date: nyTime,
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
    } catch (e) {
      console.log("Mail booking_created error:", e.message);
    }

    const nycTime = bookingDate.toLocaleTimeString("en-US", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false
    });

    res.json({
      message: "Booking confirmed",
      booking: { bookingNumber, service, date: bookingDate.toISOString(), time: nycTime },
    });
  } catch (error) {
    console.error("❌ Booking Error:", error.stack || error.message);

    // rollback counter if we incremented
    try {
      if (counterStamped) {
        await SlotCounter.updateOne({ ymd: counterStamped.ymd, time: counterStamped.hh }, { $inc: { count: -1 } });
      }
    } catch (_) {}

    const msg = (error && (error.message || "")).toString();
    if (error?.name === "ValidationError" || /validation failed/i.test(msg)) {
      const first = (error.errors && Object.values(error.errors)[0]?.message) || msg;
      return res.status(400).json({ message: first });
    }
    return res.status(500).json({ message: "Booking failed", error: msg });
  }
});

module.exports = router;
