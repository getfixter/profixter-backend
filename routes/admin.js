// 📁 backend/routes/admin.js — per-address subscription aware (FINAL, DB-only)
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
const Request = require("../models/Request");
const {
  createOrUpdateContact,
  updateContactFields,
  formatBookingDateTime,
  addTag,
  removeTag,
} = require("../utils/ghlContact");
const {
  stripe,
  normalizePlanType,
  getPriceId,
  classifyPlanChange,
  resolveStripeSubscriptionForRecord,
  getStripeSubscriptionItemForRecord,
  applyStripeSubscriptionUpgrade,
  scheduleStripeSubscriptionDowngrade,
  upsertSubscriptionFromStripe,
  clearStripeSubscriptionSchedule,
} = require("../utils/subscriptionManagement");

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
  const cancellationByAddressId = new Map();

  // 1) Map address-bound subs
  subs.forEach((s) => {
    if (s.addressId) {
      byAddressId.set(String(s.addressId), s.subscriptionType);
      if (s.cancellationDate) {
        cancellationByAddressId.set(
          String(s.addressId),
          s.cancellationDate.toISOString().split("T")[0]
        );
      }
    }
  });

  // 2) Addressless active sub → default address
  const addrless = subs.find((s) => !s.addressId);
  if (addrless && user.defaultAddressId) {
    byAddressId.set(String(user.defaultAddressId), addrless.subscriptionType);
    if (addrless.cancellationDate) {
      cancellationByAddressId.set(
        String(user.defaultAddressId),
        addrless.cancellationDate.toISOString().split("T")[0]
      );
    }
  }

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
    scheduledCancellationDate: cancellationByAddressId.get(String(a._id)) || null,
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

// ✅ GET All Users (NEWEST FIRST) + includes addressesDetailed with per-address plan
router.get("/users", auth, onlyAdmin, async (_req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).lean();
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
    res.status(err?.statusCode || 500).json({ message: "Server error", error: err.message });
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
      const planRaw = String(req.body.plan || "").toLowerCase();
      const addrObjId = new mongoose.Types.ObjectId(addressId);

      const user = await User.findById(id);
      if (!user) return res.status(404).json({ message: "User not found" });

      const addr = user.addresses.id(addressId);
      if (!addr) return res.status(404).json({ message: "Address not found" });

      const respond = async (message) => {
        const uLean = await User.findById(user._id).lean();
        const addressesDetailed = await getAddressPlansForUser(uLean);
        return res.json({ message, addressesDetailed });
      };

      const activeSub = await Subscription.findOne({
        user: user._id,
        addressId: addrObjId,
        status: { $in: ["active", "trialing"] },
      }).sort({ updatedAt: -1 });

      const stripeSubscription = activeSub
        ? await resolveStripeSubscriptionForRecord({ subscription: activeSub, user })
        : null;

      const shouldRequireStripeSync = !!(
        activeSub &&
        (activeSub.stripeSubscriptionId ||
          activeSub.stripeCustomerId ||
          activeSub.stripeSubscriptionItemId ||
          activeSub.stripePriceId ||
          user.stripeCustomerId)
      );

      // 1) CANCEL
      if (planRaw === "cancel") {
        if (stripeSubscription && activeSub) {
          const activeStripeSubscription = await clearStripeSubscriptionSchedule(stripeSubscription);
          const cancellationTarget = activeStripeSubscription || stripeSubscription;
          const canceledStripeSubscription = await stripe.subscriptions.update(
            cancellationTarget.id,
            {
              cancel_at_period_end: true,
              metadata: {
                ...(cancellationTarget.metadata || {}),
                addressId: String(addrObjId),
                userId: String(user.userId || user._id),
                localSubscriptionId: String(activeSub._id),
              },
              expand: ["items.data.price", "schedule"],
            }
          );

          await upsertSubscriptionFromStripe({
            stripeSubscription: canceledStripeSubscription,
            user,
            addressIdHint: String(addrObjId),
          });

          return respond("Address cancellation scheduled in Stripe");
        }

        if (shouldRequireStripeSync) {
          return res.status(409).json({
            message:
              "This subscription could not be safely linked to Stripe. Admin DB-only cancellation was blocked.",
          });
        }

        await Subscription.updateMany(
          {
            user: user._id,
            addressId: addrObjId,
            status: { $in: ["active", "trialing"] },
          },
          {
            $set: {
              status: "canceled",
              cancellationDate: new Date(),
              cancellationReason: "admin_panel",
            },
          }
        );

        if (
          String(user.defaultAddressId || "") === String(addrObjId) &&
          user.subscription
        ) {
          await User.collection.updateOne({ _id: user._id }, { $set: { subscription: null } });
        }

        try {
          const stillHasAnyActiveSubscription = await Subscription.findOne({
            user: user._id,
            status: { $in: ["active", "trialing"] },
          }).lean();

          if (!stillHasAnyActiveSubscription) {
            const contactId = await createOrUpdateContact({
              name: user.name,
              email: user.email,
              phone: user.phone,
            });

            if (contactId) {
              await removeTag(contactId, "subscription_purchased");
            }
          }
        } catch (e) {
          console.log("GHL subscription cancel automation error:", e.message);
        }

        return respond("Address plan canceled");
      }

      // 2) VALIDATE PLAN
      if (!["basic", "plus", "premium", "elite"].includes(planRaw)) {
        return res.status(400).json({ message: "Invalid plan" });
      }

      if (stripeSubscription && activeSub) {
        if (activeSub.cancelAtPeriodEnd) {
          return res.status(409).json({
            message:
              "Cancellation is already scheduled for this subscription. Admin plan changes are blocked until that is removed.",
          });
        }

        const targetPlan = normalizePlanType(planRaw);
        const targetCycle = activeSub.billingCycle || "monthly";
        const nextPriceId = getPriceId(targetPlan, targetCycle);
        const item = getStripeSubscriptionItemForRecord({
          subscription: activeSub,
          stripeSubscription,
        });

        if (!targetPlan || !nextPriceId || !item?.id) {
          return res.status(409).json({
            message: "Unable to map this Stripe subscription for an admin plan change.",
          });
        }

        const changeType = classifyPlanChange({
          currentPlan: activeSub.subscriptionType,
          currentBillingCycle: activeSub.billingCycle,
          targetPlan,
          targetBillingCycle: targetCycle,
        });

        let updatedStripeSubscription;
        if (changeType === "upgrade") {
          updatedStripeSubscription = await applyStripeSubscriptionUpgrade({
            stripeSubscription,
            subscription: activeSub,
            user,
            addressId: String(addrObjId),
            nextPriceId,
          });
        } else {
          updatedStripeSubscription = await scheduleStripeSubscriptionDowngrade({
            stripeSubscription,
            subscription: activeSub,
            user,
            addressId: String(addrObjId),
            nextPriceId,
          });
        }

        await upsertSubscriptionFromStripe({
          stripeSubscription: updatedStripeSubscription,
          user,
          addressIdHint: String(addrObjId),
        });

        return respond(
          changeType === "upgrade"
            ? "Address plan updated in Stripe"
            : "Address downgrade scheduled in Stripe"
        );
      }

      if (shouldRequireStripeSync) {
        return res.status(409).json({
          message:
            "This subscription could not be safely linked to Stripe. Admin DB-only plan update was blocked.",
        });
      }

      // 3) UPSERT active subscription
      let sub = activeSub;

      const now = new Date();
      const next = new Date(now);
      next.setMonth(now.getMonth() + 1);

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
          nextPaymentDate: next,
          status: "active",
          planPrice: null,
          paymentMethod: "admin-panel",
        });
      } else {
        sub.subscriptionType = planRaw;
        sub.status = "active";
        sub.latestPaymentDate = now;
        sub.nextPaymentDate = sub.nextPaymentDate || next;
      }

      await sub.save();

      if (String(user.defaultAddressId || "") === String(addrObjId)) {
        await User.collection.updateOne(
          { _id: user._id },
          { $set: { subscription: planRaw, subscriptionStart: now } }
        );
      }

      try {
        const contactId = await createOrUpdateContact({
          name: user.name,
          email: user.email,
          phone: user.phone,
        });

        if (contactId) {
          await addTag(contactId, "subscription_purchased");
        }
      } catch (e) {
        console.log("GHL subscription add automation error:", e.message);
      }

      return respond("Address plan updated");
    } catch (err) {
      console.error("❌ Per-address plan update error:", err.message);
      res.status(err?.statusCode || 500).json({ message: "Server error", error: err.message });
    }
  }
);

// ✅ NEW: Schedule or clear a specific cancellation date for an address subscription
// PUT /api/admin/users/:id/address/:addressId/cancellation-date
router.put(
  "/users/:id/address/:addressId/cancellation-date",
  auth,
  onlyAdmin,
  async (req, res) => {
    try {
      const { id, addressId } = req.params;
      const { cancelOnDate } = req.body; // "YYYY-MM-DD" or null to clear
      const addrObjId = new mongoose.Types.ObjectId(addressId);

      const user = await User.findById(id);
      if (!user) return res.status(404).json({ message: "User not found" });

      const addr = user.addresses.id(addressId);
      if (!addr) return res.status(404).json({ message: "Address not found" });

      const activeSub = await Subscription.findOne({
        user: user._id,
        addressId: addrObjId,
        status: { $in: ["active", "trialing"] },
      }).sort({ updatedAt: -1 });

      if (!activeSub) {
        return res.status(404).json({ message: "No active subscription for this address" });
      }

      const respond = async (message) => {
        const uLean = await User.findById(user._id).lean();
        const addressesDetailed = await getAddressPlansForUser(uLean);
        return res.json({ message, addressesDetailed });
      };

      const stripeSubscription = activeSub.stripeSubscriptionId
        ? await resolveStripeSubscriptionForRecord({ subscription: activeSub, user })
        : null;

      // CLEAR cancellation date
      if (!cancelOnDate) {
        if (stripeSubscription) {
          const clearedSub = await stripe.subscriptions.update(stripeSubscription.id, {
            cancel_at: "",
            cancel_at_period_end: false,
            expand: ["items.data.price", "schedule"],
          });
          await upsertSubscriptionFromStripe({
            stripeSubscription: clearedSub,
            user,
            addressIdHint: String(addrObjId),
          });
        } else {
          activeSub.cancellationDate = null;
          activeSub.cancelAtPeriodEnd = false;
          await activeSub.save();
        }
        return respond("Cancellation date cleared");
      }

      // SET cancellation date — convert YYYY-MM-DD to end-of-day UTC timestamp
      // Use 05:00 UTC of D+1 which equals midnight/1am Eastern (covers both EST and EDT)
      const [year, month, day] = String(cancelOnDate).split("-").map(Number);
      if (!year || !month || !day) {
        return res.status(400).json({ message: "Invalid cancelOnDate format, expected YYYY-MM-DD" });
      }
      const cancelAtDate = new Date(Date.UTC(year, month - 1, day + 1, 5, 0, 0));
      const cancelAtTimestamp = Math.floor(cancelAtDate.getTime() / 1000);

      if (stripeSubscription) {
        const updatedSub = await stripe.subscriptions.update(stripeSubscription.id, {
          cancel_at: cancelAtTimestamp,
          cancel_at_period_end: false,
          expand: ["items.data.price", "schedule"],
        });
        await upsertSubscriptionFromStripe({
          stripeSubscription: updatedSub,
          user,
          addressIdHint: String(addrObjId),
        });
      } else {
        activeSub.cancellationDate = cancelAtDate;
        activeSub.cancelAtPeriodEnd = true;
        await activeSub.save();
      }

      return respond("Cancellation date set");
    } catch (err) {
      console.error("❌ Per-address cancellation-date update error:", err.message);
      res.status(err?.statusCode || 500).json({ message: "Server error", error: err.message });
    }
  }
);

// ✅ ONE-TIME: remove subscription_purchased from users with NO active subscription
// POST /api/admin/ghl/subscription-tags/cleanup
router.post("/ghl/subscription-tags/cleanup", auth, onlyAdmin, async (_req, res) => {
  try {
    const users = await User.find({
      phone: { $exists: true, $ne: "" },
    }).select("_id name email phone userId subscription");

    let scanned = 0;
    let noPhone = 0;
    let noContact = 0;
    let removed = 0;
    const errors = [];

    for (const user of users) {
      scanned++;

      if (!user.phone) {
        noPhone++;
        continue;
      }

      const activeSub = await Subscription.findOne({
        user: user._id,
        status: { $in: ["active", "trialing"] },
      }).lean();

      if (activeSub) {
        continue;
      }

      try {
        const contactId = await createOrUpdateContact({
          name: user.name,
          email: user.email,
          phone: user.phone,
        });

        if (!contactId) {
          noContact++;
          continue;
        }

        const ok = await removeTag(contactId, "subscription_purchased");
        if (ok) removed++;
      } catch (e) {
        errors.push({
          userId: user.userId || "",
          email: user.email || "",
          phone: user.phone || "",
          error: e.message,
        });
      }
    }

    return res.json({
      message: "GHL subscription tag cleanup finished",
      scanned,
      removed,
      noPhone,
      noContact,
      errors,
    });
  } catch (err) {
    console.error("❌ GHL subscription tag cleanup error:", err.message);
    return res.status(500).json({
      message: "Server error",
      error: err.message,
    });
  }
});

// ✅ ONE-TIME: sync all DB users into GHL contacts
router.post("/ghl/sync-all-users", auth, onlyAdmin, async (_req, res) => {
  try {
    const users = await User.find({}).select("_id userId name email phone");

    let scanned = 0;
    let skippedNoPhone = 0;
    let synced = 0;
    const errors = [];

    for (const user of users) {
      scanned++;

      if (!user.phone || !String(user.phone).trim()) {
        skippedNoPhone++;
        continue;
      }

      try {
        const contactId = await createOrUpdateContact({
          name: user.name,
          email: user.email,
          phone: user.phone,
        });

        if (contactId) {
          synced++;
        } else {
          errors.push({
            userId: user.userId || "",
            email: user.email || "",
            phone: user.phone || "",
            error: "No contactId returned from GHL",
          });
        }
      } catch (e) {
        errors.push({
          userId: user.userId || "",
          email: user.email || "",
          phone: user.phone || "",
          error: e.message,
        });
      }
    }

    return res.json({
      message: "GHL full sync finished",
      scanned,
      synced,
      skippedNoPhone,
      errors,
    });
  } catch (err) {
    console.error("❌ GHL full sync error:", err.message);
    return res.status(500).json({
      message: "Server error",
      error: err.message,
    });
  }
});
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
      date: new Date(),
    });

    booking.status = status;

    if (
      prev.toLowerCase() !== "confirmed" &&
      String(status).toLowerCase() === "confirmed"
    ) {
      booking.reminder24hQueuedAt = undefined;
      booking.reminder24hSentAt = undefined;
      booking.reminder60mQueuedAt = undefined;
      booking.reminder60mSentAt = undefined;
    }

    await booking.save();

    // GHL SMS automation hooks
    try {
      const normalizedStatus = String(status || "").toLowerCase();
      const u = await User.findOne({ userId: booking.userId });

      const contactId = await createOrUpdateContact({
        name: booking.name || u?.name,
        email: booking.email || u?.email,
        phone: booking.phone || u?.phone,
      });

      if (normalizedStatus === "confirmed") {
        const pretty = formatBookingDateTime(booking.date);

        await updateContactFields(contactId, [
          {
            key: "booking_datetime_pretty",
            value: pretty,
          },
        ]);

        await addTag(contactId, "booking_confirmed");
      }

      if (normalizedStatus === "completed") {
        const pretty = formatBookingDateTime(booking.date);

        await updateContactFields(contactId, [
          {
            key: "booking_datetime_pretty",
            value: pretty,
          },
        ]);

        await addTag(contactId, "booking_completed");
      }

      if (normalizedStatus === "canceled") {
        const pretty = formatBookingDateTime(booking.date);

        await updateContactFields(contactId, [
          {
            key: "booking_datetime_pretty",
            value: pretty,
          },
        ]);

        await addTag(contactId, "booking_cancelled");
      }
    } catch (e) {
      console.log("GHL booking status automation error:", e.message);
    }

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
            date: booking.date,
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

// ✅ NEW: Update booking note/date (admin)
// PUT /api/admin/bookings/:id
router.put("/bookings/:id", auth, onlyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { note, date } = req.body || {};

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    if (note !== undefined) booking.note = String(note);

    if (date !== undefined) {
      const d = new Date(String(date));
      if (isNaN(d.getTime())) {
        return res.status(400).json({ message: "Invalid date" });
      }
      booking.date = d;
      booking.reminder24hQueuedAt = undefined;
      booking.reminder24hSentAt = undefined;
      booking.reminder60mQueuedAt = undefined;
      booking.reminder60mSentAt = undefined;
    }

    await booking.save();

    return res.json({ message: "Booking updated", booking });
  } catch (err) {
    console.error("❌ Admin booking update error:", err.message);
    res.status(err?.statusCode || 500).json({ message: "Server error", error: err.message });
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
      return res.status(400).json({ message: "Subject and body are required." });
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

    if (!removed) {
      return res.status(404).json({ message: "Blacklist entry not found" });
    }

    res.json({ message: "Removed from blacklist" });
  } catch (e) {
    console.error("❌ blacklist DELETE:", e.message);
    res.status(500).json({ message: "Failed to remove from blacklist" });
  }
});

/* ───────────────── REQUESTS / LEADS ───────────────── */

// GET /api/admin/requests
router.get("/requests", auth, onlyAdmin, async (_req, res) => {
  try {
    const requests = await Request.find({})
      .sort({ createdAt: -1 })
      .lean();

    res.json(requests);
  } catch (err) {
    console.error("❌ Failed to fetch requests:", err.message);
    res.status(500).json({ message: "Failed to fetch requests" });
  }
});

// PUT /api/admin/requests/:id/status
router.put("/requests/:id/status", auth, onlyAdmin, async (req, res) => {
  try {
    const { status } = req.body;

    if (!["new", "contacted", "won", "lost"].includes(String(status))) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const request = await Request.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true }
    );

    if (!request) {
      return res.status(404).json({ message: "Request not found" });
    }

    res.json({ request });
  } catch (err) {
    console.error("❌ Failed to update request status:", err.message);
    res.status(500).json({ message: "Failed to update request status" });
  }
});

module.exports = router;

