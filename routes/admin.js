// 📁 backend/routes/admin.js — per-address subscription aware (FINAL)
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const auth = require("../middleware/auth");
const User = require("../models/User");
const Booking = require("../models/Booking");
const Referral = require("../models/Referral");
const Blacklist = require("../models/Blacklist");
const Subscription = require("../models/Subscription");
const CalendarConfig = require("../models/CalendarConfig");
const SlotCounter = require("../models/SlotCounter");

const mail = require("../utils/emailService");
const { sendPromo, TEMPLATES } = require("../utils/emailService");

const ADMIN_EMAIL = process.env.MAIL_ADMIN || "getfixter@gmail.com";

/* ───────────────── helpers ───────────────── */
const ymdInTZ = (d, tz) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hhmmInTZ = (d, tz) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

function segmentQuery(segment) {
  const base = { email: { $exists: true, $ne: ADMIN_EMAIL } };
  switch ((segment || "").toLowerCase()) {
    case "not_subscribed":
      return {
        ...base,
        $or: [
          { subscription: null },
          { subscription: "" },
          { subscription: { $exists: false } },
        ],
      };
    case "basic":
    case "plus":
    case "premium":
    case "elite":
      return { ...base, subscription: segment.toLowerCase() };
    case "all":
    default:
      return base;
  }
}

function personalize(str = "", user = {}) {
  const name = user.name || (user.email || "").split("@")[0];
  const plan =
    (user.subscription || "").charAt(0).toUpperCase() +
    (user.subscription || "").slice(1);
  return String(str)
    .replace(/\{\{\s*name\s*\}\}/gi, name)
    .replace(/\{\{\s*plan\s*\}\}/gi, plan || "—")
    .replace(/\{\{\s*userid\s*\}\}/gi, user.userId || "—")
    .replace(/\{\{\s*email\s*\}\}/gi, user.email || "—");
}

function buildHtml({ useTemplate, subject, body, ctaText, ctaUrl, user }) {
  const personalizedBody = personalize(body, user);
  if (useTemplate) {
    const { html } = TEMPLATES.promo_generic({
      title: subject,
      body: personalizedBody,
      ctaText: ctaText || "View Plans",
      ctaUrl: ctaUrl || "https://profixter.com/subscription",
    });
    return html;
  }
  return personalizedBody;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ✅ Middleware: Allow only admin
const onlyAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.email !== ADMIN_EMAIL) {
      return res.status(403).json({ message: "Access denied. Admins only." });
    }
    next();
  } catch (err) {
    console.error("❌ Admin check failed:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/* ───────────────── per-address plan helper ───────────────── */
async function getAddressPlansForUser(user) {
  const subs = await Subscription.find({
    user: user._id,
    status: { $in: ["active", "trialing"] },
  });

  const byAddressId = new Map();

  // 1) Map address-bound subs
  subs.forEach((s) => {
    if (s.addressId) byAddressId.set(String(s.addressId), s.subscriptionType);
  });

  // 2) Addressless active sub → default address
  const addrless = subs.find((s) => !s.addressId);
  if (addrless && user.defaultAddressId) {
    byAddressId.set(String(user.defaultAddressId), addrless.subscriptionType);
  }

  // 3) Legacy fallback for default address
  if (user.subscription && user.defaultAddressId) {
    const key = String(user.defaultAddressId);
    if (!byAddressId.has(key)) {
      byAddressId.set(key, String(user.subscription).toLowerCase());
    }
  }

  // Build response
  return (user.addresses || []).map((a) => ({
    _id: String(a._id),
    label: a.label,
    line1: a.line1,
    city: a.city,
    state: a.state,
    zip: a.zip,
    county: a.county || "",
    isDefault: String(user.defaultAddressId || "") === String(a._id),
    plan: byAddressId.get(String(a._id)) || null,
  }));
}

// DEBUG: see exactly what Admin will render for one user
router.get("/users/:id/addressesDetailed", auth, onlyAdmin, async (req, res) => {
  const u = await User.findById(req.params.id).lean();
  if (!u) return res.status(404).json({ message: "User not found" });
  const rows = await getAddressPlansForUser(u);
  res.json(rows);
});

/* ───────────────── USERS ───────────────── */

// ✅ GET All Users (includes addressesDetailed with per-address plan)
router.get("/users", auth, onlyAdmin, async (_req, res) => {
  try {
    const users = await User.find().lean();
    const out = [];
    for (const u of users) {
      const addressesDetailed = await getAddressPlansForUser(u);
      out.push({ ...u, addressesDetailed });
    }
    res.json(out);
  } catch (err) {
    console.error("❌ Fetch users error:", err);
    res.status(500).json({ message: "Failed to get users" });
  }
});

// ✅ DELETE User by ID
router.delete("/users/:id", auth, onlyAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ message: "User deleted" });
  } catch (err) {
    console.error("❌ Delete user error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ✅ UPDATE User Info (name, phone, legacy subscription)
router.put("/users/:id", auth, onlyAdmin, async (req, res) => {
  const allowedFields = ["name", "phone", "subscription"];
  const updates = {};
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  try {
    const user = await User.findByIdAndUpdate(req.params.id, updates, {
      new: true,
    });
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ message: "User updated", user });
  } catch (err) {
    console.error("❌ Edit user error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ✅ Legacy: Update single user.subscription (kept for backward compatibility)
router.put("/users/:id/subscription", auth, onlyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { subscription } = req.body;

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: "User not found" });

    user.subscription =
      subscription === "Cancel" ? null : String(subscription || "").toLowerCase();
    await user.save();

    res.json({
      message: "Subscription updated",
      subscription: user.subscription,
    });
  } catch (err) {
    console.error("❌ Admin Subscription Update Error:", err.message);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ✅ NEW: Set/Clear subscription for a specific address
// PUT /api/admin/users/:id/address/:addressId/subscription
router.put(
  "/users/:id/address/:addressId/subscription",
  auth,
  onlyAdmin,
  async (req, res) => {
    try {
      const { id, addressId } = req.params;
      const planRaw = String(req.body.plan || "").toLowerCase(); // basic|plus|premium|elite|cancel
      const addrObjId = new mongoose.Types.ObjectId(addressId);

      const user = await User.findById(id);
      if (!user) return res.status(404).json({ message: "User not found" });

      const addr = user.addresses.id(addressId);
      if (!addr) return res.status(404).json({ message: "Address not found" });

      // Cancel -> mark any active sub for this address canceled
      if (planRaw === "cancel") {
        const active = await Subscription.findOne({
          user: user._id,
          addressId: addrObjId,
          status: { $in: ["active", "trialing"] },
        });
        if (active) {
          active.status = "canceled";
          active.cancellationDate = new Date();
          active.cancellationReason = "admin_panel";
          await active.save();
        }
        // If this is the default address and legacy flag is set, clear it.
        if (
          String(user.defaultAddressId || "") === String(addrObjId) &&
          user.subscription
        ) {
          user.subscription = null;
          await user.save();
        }

        const addressesDetailed = await getAddressPlansForUser(user);
        return res.json({ message: "Address plan canceled", addressesDetailed });
      }

      if (!["basic", "plus", "premium", "elite"].includes(planRaw)) {
        return res.status(400).json({ message: "Invalid plan" });
      }

      // Upsert active subscription for this address
      let sub = await Subscription.findOne({
        user: user._id,
        addressId: addrObjId,
        status: { $in: ["active", "trialing"] },
      });

      const now = new Date();
      if (!sub) {
        sub = new Subscription({
          user: user._id,
          userId: user.userId,
          subscriptionType: planRaw,
          addressId: addrObjId,
          addressSnapshot: {
            line1: addr.line1,
            city: addr.city,
            state: addr.state,
            zip: addr.zip,
            county: addr.county || "",
          },
          startDate: now,
          latestPaymentDate: now,
          nextPaymentDate: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
          status: "active",
          planPrice: null,
          paymentMethod: "admin-panel",
        });
      } else {
        sub.subscriptionType = planRaw;
        sub.latestPaymentDate = now;
        if (!sub.nextPaymentDate) {
          sub.nextPaymentDate = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
        }
        sub.status = "active";
      }
      await sub.save();

      const addressesDetailed = await getAddressPlansForUser(user);
      res.json({ message: "Address plan updated", addressesDetailed });
    } catch (err) {
      console.error("❌ Per-address plan update error:", err.message);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

/* ───────────────── BOOKINGS ───────────────── */

// ✅ GET All Bookings
router.get("/bookings", auth, onlyAdmin, async (_req, res) => {
  try {
    const bookings = await Booking.find().populate("user");
    res.json(bookings);
  } catch (err) {
    console.error("❌ Fetch bookings error:", err);
    res.status(500).json({ message: "Failed to get bookings" });
  }
});

// ✅ UPDATE Booking Status (admin)
// - never hard-delete
// - when transitioning to "Canceled" free SlotCounter capacity
router.put("/bookings/:id/status", auth, onlyAdmin, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ["Pending", "Confirmed", "Completed", "Canceled"];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ message: "Invalid status" });
  }

  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const prev = String(booking.status || "");
    booking.statusHistory = (booking.statusHistory || []).concat({
      status: booking.status,
      changedAt: new Date(),
    });
    booking.status = status;
    await booking.save();

    // Free capacity if newly canceled
    if (prev.toLowerCase() !== "canceled" && status.toLowerCase() === "canceled") {
      try {
        const cfg = await CalendarConfig.findOne().lean();
        const tz = cfg?.timezone || "America/New_York";
        const ymd = ymdInTZ(new Date(booking.date), tz);
        const hh = hhmmInTZ(new Date(booking.date), tz);
        await SlotCounter.updateOne({ ymd, time: hh }, { $inc: { count: -1 } });
      } catch (e) {
        console.log("Slot free (admin cancel) error:", e.message);
      }
    }

    // Optional: notify user
    try {
      const u = (await User.findOne({ userId: booking.userId })) || {};
      const address = [booking.address, booking.city, booking.state, booking.zip]
        .filter(Boolean)
        .join(", ");
      const nyTime = new Date(booking.date).toLocaleString("en-US", {
        timeZone: "America/New_York",
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });

      const key =
        {
          confirmed: "booking_confirmed",
          completed: "booking_completed",
          canceled: "booking_canceled",
        }[(status || "").toLowerCase()];

      if (key && (booking.email || u.email)) {
        await mail.sendTx(
          key,
          booking.email || u.email,
          {
            name: booking.name || u.name || (u.email || "").split("@")[0],
            bookingNumber: booking.bookingNumber,
            date: nyTime,
            service: booking.service,
            address,
          },
          { bccAdmin: false }
        );
      }
    } catch (e) {
      console.log("Mail status-change error:", e.message);
    }

    res.json({ message: "Status updated", booking });
  } catch (err) {
    console.error("❌ Update booking status error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ───────────────── REFERRALS ───────────────── */

// ✅ GET All Referrals
router.get("/referrals", auth, onlyAdmin, async (_req, res) => {
  try {
    const referrals = await Referral.find();
    res.json(referrals);
  } catch (err) {
    console.error("❌ Fetch referrals error:", err);
    res.status(500).json({ message: "Failed to get referrals" });
  }
});

/* ───────────────── SEGMENTS / CAMPAIGNS ───────────────── */

// 🔹 Audience sizes for each segment
router.get("/segments", auth, onlyAdmin, async (_req, res) => {
  try {
    const blocked = await Blacklist.find().select("user email");
    const blockedIds = blocked.map((b) => String(b.user)).filter(Boolean);
    const blockedEmails = blocked.map((b) => b.email).filter(Boolean);

    const base = {
      email: { $exists: true, $ne: ADMIN_EMAIL, $nin: blockedEmails },
      _id: { $nin: blockedIds },
    };

    const counts = {};
    counts.all = await User.countDocuments(base);
    counts.not_subscribed = await User.countDocuments({
      ...base,
      $or: [
        { subscription: null },
        { subscription: "" },
        { subscription: { $exists: false } },
      ],
    });
    for (const p of ["basic", "plus", "premium", "elite"]) {
      counts[p] = await User.countDocuments({
        ...base,
        subscription: p,
      });
    }
    res.json(counts);
  } catch (err) {
    console.error("❌ segments error:", err.message);
    res.status(500).json({ message: "Failed to load segments" });
  }
});

// 🔹 Send a campaign (test or full send)
router.post("/campaigns/send", auth, onlyAdmin, async (req, res) => {
  try {
    const {
      segment = "all",
      subject,
      body = "",
      useTemplate = true,
      ctaText = "",
      ctaUrl = "",
      testOnly = false,
    } = req.body;

    if (!subject || !body) {
      return res
        .status(400)
        .json({ message: "Subject and body are required." });
    }

    let recipients = [];
    if (testOnly) {
      recipients = [
        { email: ADMIN_EMAIL, name: "Admin", userId: "00000000", subscription: "" },
      ];
    } else {
      const blocked = await Blacklist.find().select("user email");
      const blockedIds = blocked.map((b) => b.user).filter(Boolean);
      const blockedEmails = blocked.map((b) => b.email).filter(Boolean);

      recipients = await User.find({
        ...segmentQuery(segment),
        _id: { $nin: blockedIds },
        email: { $nin: blockedEmails },
      })
        .select("name email userId subscription")
        .limit(5000);
    }

    let sent = 0;
    const errors = [];
    const batches = chunk(recipients, 10);
    for (const group of batches) {
      await Promise.all(
        group.map(async (u) => {
          try {
            const html = buildHtml({
              useTemplate,
              subject,
              body,
              ctaText,
              ctaUrl,
              user: u,
            });
            await sendPromo(u.email, { subject, html });
            sent++;
          } catch (e) {
            errors.push({ email: u.email, error: e.message });
          }
        })
      );
      await sleep(300);
    }

    res.json({ segment, total: recipients.length, sent, errors });
  } catch (err) {
    console.error("❌ campaigns/send error:", err.message);
    res
      .status(500)
      .json({ message: "Server error sending campaign", error: err.message });
  }
});

/* ───────────────── BLACKLIST ───────────────── */

// GET /api/admin/blacklist
router.get("/blacklist", auth, onlyAdmin, async (_req, res) => {
  try {
    const rows = await Blacklist.find().populate(
      "user",
      "userId name email phone address city county state zip"
    );
    const out = rows.map((b) => {
      const u = b.user || {};
      return {
        _id: b._id,
        userId: u.userId,
        name: b.name || u.name,
        email: b.email || u.email,
        phone: b.phone || u.phone,
        address: u.address,
        city: u.city,
        county: u.county,
        state: u.state,
        zip: u.zip,
        reason: b.reason || "",
      };
    });
    res.json(out);
  } catch (e) {
    console.error("❌ blacklist GET:", e.message);
    res.status(500).json({ message: "Failed to load blacklist" });
  }
});

// POST /api/admin/blacklist/:id
router.post("/blacklist/:id", auth, onlyAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const exists = await Blacklist.findOne({
      $or: [{ user: user._id }, { email: user.email }],
    });
    if (exists) return res.json({ message: "Already blacklisted", id: exists._id });

    const entry = await Blacklist.create({
      user: user._id,
      userId: user.userId,
      name: user.name,
      email: user.email,
      phone: user.phone,
      address: user.address,
      city: user.city,
      county: user.county,
      state: user.state,
      zip: user.zip,
      reason: req.body.reason || "",
    });

    res.json({ message: "Added to blacklist", id: entry._id });
  } catch (e) {
    console.error("❌ blacklist POST:", e.message);
    res.status(500).json({ message: "Failed to add to blacklist" });
  }
});

// DELETE /api/admin/blacklist/:id
router.delete("/blacklist/:id", auth, onlyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    let removed = await Blacklist.findByIdAndDelete(id);
    if (!removed && /^[0-9a-fA-F]{24}$/.test(id)) {
      removed = await Blacklist.findOneAndDelete({ user: id });
    }
    if (!removed)
      return res.status(404).json({ message: "Blacklist entry not found" });
    res.json({ message: "Removed from blacklist" });
  } catch (e) {
    console.error("❌ blacklist DELETE:", e.message);
    res.status(500).json({ message: "Failed to remove from blacklist" });
  }
});

module.exports = router;
