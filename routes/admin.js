// 📁 backend/routes/admin.js — per-address subscription aware (FINAL, DB-only)
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const User = require("../models/User");
const Booking = require("../models/Booking");
const Referral = require("../models/Referral");
const Blacklist = require("../models/Blacklist");
const Subscription = require("../models/Subscription");
const CalendarConfig = require("../models/CalendarConfig");
const SlotCounter = require("../models/SlotCounter");
const BookingHistory = require("../models/BookingHistory");
const {
  snapshot: bookingSnapshot,
  logBookingChanges,
} = require("../utils/bookingHistory");
const {
  evaluate24HourReminder,
  evaluate60MinuteReminder,
} = require("../utils/bookingReminderPolicy");
const {
  cancelBookingWithReservation,
  findEligibleTechnicians,
  moveReservationForBooking,
  reservationEngineEnabled,
  transitionBookingWithReservation,
} = require("../utils/slotReservationService");

const mail = require("../utils/emailService");
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
  resolveStripePriceId,
  classifyPlanChange,
  resolveStripeSubscriptionForRecord,
  getStripeSubscriptionItemForRecord,
  applyStripeSubscriptionUpgrade,
  scheduleStripeSubscriptionDowngrade,
  upsertSubscriptionFromStripe,
  clearStripeSubscriptionSchedule,
  subscriptionGrantsAccess,
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

// ✅ Middleware: Allow only admin
const legacyOnlyAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.email !== ADMIN_EMAIL) {
      return res.status(403).json({ message: "Access denied. Admins only." });
    }
    next();
  } catch (err) {
    console.error("❌ Admin check failed:", err);
    res.status(err?.statusCode || 500).json({ message: err.message || "Server error" });
  }
};

/* ───────────────── per-address plan helper ───────────────── */
const onlyAdmin = requirePermission(PERMISSIONS.ADMIN);
const bookingsWrite = requirePermission(PERMISSIONS.BOOKINGS_WRITE);
const bookingsAssign = requirePermission(PERMISSIONS.BOOKINGS_ASSIGN);
void legacyOnlyAdmin;

async function getAddressPlansForUser(user) {
  const candidates = await Subscription.find({
    user: user._id,
    status: { $in: ["active", "trialing"] },
  });
  const subs = candidates.filter((subscription) =>
    subscriptionGrantsAccess(subscription)
  );

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
    const users = await User.find({ role: { $ne: "employee" } })
      .select("-password")
      .sort({ createdAt: -1 })
      .lean();
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

router.get(
  "/members",
  auth,
  ...requirePermission(PERMISSIONS.MEMBERS_READ),
  async (_req, res) => {
    try {
      const users = await User.find({ role: { $ne: "employee" } })
        .select("userId name email phone addresses defaultAddressId createdAt")
        .sort({ createdAt: -1 })
        .lean();
      const out = [];
      for (const user of users) {
        out.push({
          _id: String(user._id),
          userId: user.userId,
          name: user.name,
          email: user.email,
          phone: user.phone || "",
          createdAt: user.createdAt,
          addressesDetailed: await getAddressPlansForUser(user),
        });
      }
      return res.json(out);
    } catch (error) {
      console.error("Fetch members failed:", error);
      return res.status(500).json({ message: "Failed to get members" });
    }
  }
);

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
    }).select("-password");

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
        const priceResolution = await resolveStripePriceId({
          plan: targetPlan,
          billingCycle: targetCycle,
        });
        const nextPriceId = priceResolution.priceId;
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
router.get("/bookings", auth, ...requirePermission(PERMISSIONS.BOOKINGS_READ), async (req, res) => {
  try {
    const query =
      String(req.query.assigned || "").toLowerCase() === "me"
        ? { assignedFixterId: req.accessUser._id }
        : {};
    const bookings = await Booking.find(query).populate(
      "user",
      "userId name email phone subscription"
    );
    res.json(bookings);
  } catch (err) {
    console.error("❌ Fetch bookings error:", err);
    res.status(500).json({ message: "Failed to get bookings" });
  }
});

router.get("/bookings/reminders/debug", auth, ...onlyAdmin, async (_req, res) => {
  try {
    const now = new Date();
    const bookings = await Booking.find({
      status: /^confirmed$/i,
      date: { $gte: now },
    })
      .sort({ date: 1 })
      .limit(20)
      .select(
        "_id bookingNumber status date email reminder24hQueuedAt reminder24hSentAt reminder24hSkippedAt reminder24hSkipReason reminder60mQueuedAt reminder60mSentAt"
      )
      .lean();

    return res.json({
      serverTime: now.toISOString(),
      newYorkTime: now.toLocaleString("en-US", {
        timeZone: "America/New_York",
        dateStyle: "full",
        timeStyle: "long",
      }),
      bookings: bookings.map((booking) => {
        const reminder24h = evaluate24HourReminder(booking, now);
        const reminder60m = evaluate60MinuteReminder(booking, now);
        const bookingStartMs = new Date(booking.date).getTime();
        const hoursUntilAppointment = Number.isFinite(bookingStartMs)
          ? Number(
              ((bookingStartMs - now.getTime()) / (60 * 60 * 1000)).toFixed(2)
            )
          : null;
        return {
          bookingId: String(booking._id),
          bookingNumber: booking.bookingNumber,
          status: booking.status,
          startDateTime: booking.date,
          hoursUntilAppointment,
          reminder24hQueuedAt: booking.reminder24hQueuedAt || null,
          reminder24hSentAt: booking.reminder24hSentAt || null,
          reminder24hSkippedAt: booking.reminder24hSkippedAt || null,
          reminder24hSkipReason: booking.reminder24hSkipReason || "",
          reminder24hEligible: reminder24h.eligible,
          reminder24hReason: reminder24h.reason,
          reminder60mQueuedAt: booking.reminder60mQueuedAt || null,
          reminder60mSentAt: booking.reminder60mSentAt || null,
          reminder60mEligible: reminder60m.eligible,
          reminder60mReason: reminder60m.reason,
        };
      }),
    });
  } catch (error) {
    console.error("Reminder diagnostics failed:", error);
    return res.status(500).json({ message: "Failed to load reminder diagnostics" });
  }
});

async function resolveAssignment(assignedFixterId) {
  if (assignedFixterId === "" || assignedFixterId === null) {
    return {
      assignedFixterId: null,
      assignedFixterName: "",
      assignedFixterEmail: "",
      assignedFixterPosition: "",
    };
  }
  const fixter = await User.findOne({
    _id: assignedFixterId,
    role: "employee",
    isActive: true,
    employeePosition: { $in: ["Fixter", "General Fixter"] },
  }).lean();
  if (!fixter) {
    const error = new Error("Assigned employee is invalid or inactive");
    error.statusCode = 400;
    throw error;
  }
  return {
    assignedFixterId: fixter._id,
    assignedFixterName: fixter.name,
    assignedFixterEmail: fixter.email,
    assignedFixterPosition: fixter.employeePosition,
  };
}

router.get("/booking-assignees", auth, ...bookingsAssign, async (_req, res) => {
  const fixters = await User.find({
    role: "employee",
    isActive: true,
    employeePosition: { $in: ["Fixter", "General Fixter"] },
  })
    .select("name email employeePosition isDefaultFixter")
    .sort({ isDefaultFixter: -1, name: 1 })
    .lean();
  return res.json({
    fixters: fixters.map((fixter) => ({
      id: String(fixter._id),
      name: fixter.name,
      email: fixter.email,
      employeePosition: fixter.employeePosition,
      isDefaultFixter: !!fixter.isDefaultFixter,
    })),
  });
});

router.get(
  "/bookings/:bookingId/history",
  auth,
  ...requirePermission(PERMISSIONS.BOOKINGS_READ),
  async (req, res) => {
    try {
      const booking = await Booking.findById(req.params.bookingId)
        .select("_id assignedFixterId")
        .lean();
      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }
      const history = await BookingHistory.find({ bookingId: booking._id })
        .sort({ createdAt: -1 })
        .lean();
      return res.json({ history });
    } catch (error) {
      console.error("Load booking history failed:", error);
      return res.status(500).json({ message: "Failed to load booking history" });
    }
  }
);

// ✅ UPDATE Booking Status (admin)
router.put("/bookings/:id/status", auth, ...bookingsWrite, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ["Pending", "Confirmed", "Completed", "Canceled"];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ message: "Invalid status" });
  }

  try {
    let booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    const before = bookingSnapshot(booking);
    const useReservationEngine = reservationEngineEnabled();
    const assignmentRequested = Object.prototype.hasOwnProperty.call(
      req.body,
      "assignedFixterId"
    );
    if (assignmentRequested) {
      if (req.accessRole !== "admin" && !req.permissions.includes(PERMISSIONS.BOOKINGS_ASSIGN)) {
        return res.status(403).json({ message: "Assignment access denied" });
      }
      if (useReservationEngine) {
        if (!req.body.assignedFixterId) {
          return res.status(400).json({
            code: "TECHNICIAN_REQUIRED",
            message: "A reserved booking cannot be unassigned",
          });
        }
        await moveReservationForBooking({
          bookingId: booking._id,
          technicianId: req.body.assignedFixterId,
          slotStart: booking.date,
          actorUser: req.accessUser,
          createdByType: "admin",
          assignmentSource:
            req.accessRole === "admin" ? "admin" : "general_fixter",
        });
        booking = await Booking.findById(booking._id);
      } else {
        Object.assign(booking, await resolveAssignment(req.body.assignedFixterId));
      }
    }
    if (
      useReservationEngine &&
      status.toLowerCase() === "confirmed" &&
      !booking.slotReservationId &&
      !assignmentRequested
    ) {
      const options = await findEligibleTechnicians({
        slotStart: booking.date,
      });
      if (!options.recommended?.id) {
        return res.status(409).json({
          code: "SLOT_UNAVAILABLE",
          message: "No eligible technician is available for this booking",
        });
      }
      await moveReservationForBooking({
        bookingId: booking._id,
        technicianId: options.recommended.id,
        slotStart: booking.date,
        actorUser: req.accessUser,
        createdByType: "admin",
        assignmentSource: "automatic",
      });
      booking = await Booking.findById(booking._id);
    }

    const prev = String(booking.status || "");

    if (
      useReservationEngine &&
      status.toLowerCase() === "canceled"
    ) {
      const result = await cancelBookingWithReservation({
        bookingId: booking._id,
        actorUser: req.accessUser,
        createdByType: "admin",
        reason: "Canceled by Admin",
      });
      booking = result.booking;
    } else if (
      useReservationEngine &&
      status.toLowerCase() === "completed" &&
      prev.toLowerCase() !== "completed"
    ) {
      const result = await transitionBookingWithReservation({
        bookingId: booking._id,
        actorUser: req.accessUser,
        createdByType: "admin",
        reason: "Booking completed",
        status: "Completed",
        clearAssignment: false,
      });
      booking = result.booking;
    } else {
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
        booking.reminder24hSkippedAt = undefined;
        booking.reminder24hSkipReason = "";
        booking.reminder60mQueuedAt = undefined;
        booking.reminder60mSentAt = undefined;
      }

      await booking.save();
      await logBookingChanges({
        bookingId: booking._id,
        before,
        after: bookingSnapshot(booking),
        req,
      });
    }

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
    if (
      !useReservationEngine &&
      prev.toLowerCase() !== "canceled" &&
      status.toLowerCase() === "canceled"
    ) {
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
    res.status(err?.statusCode || 500).json({ message: err.message || "Server error" });
  }
});

// ✅ NEW: Update booking note/date (admin)
// PUT /api/admin/bookings/:id
router.put("/bookings/:id", auth, ...bookingsWrite, async (req, res) => {
  try {
    const { id } = req.params;
    const { note, date } = req.body || {};

    let booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    const before = bookingSnapshot(booking);
    const useReservationEngine = reservationEngineEnabled();
    const assignmentRequested = Object.prototype.hasOwnProperty.call(
      req.body || {},
      "assignedFixterId"
    );
    let parsedDate = null;

    if (note !== undefined) booking.note = String(note);

    if (date !== undefined) {
      const d = new Date(String(date));
      if (isNaN(d.getTime())) {
        return res.status(400).json({ message: "Invalid date" });
      }
      parsedDate = d;
      if (!useReservationEngine) booking.date = d;
      booking.reminder24hQueuedAt = undefined;
      booking.reminder24hSentAt = undefined;
      booking.reminder24hSkippedAt = undefined;
      booking.reminder24hSkipReason = "";
      booking.reminder60mQueuedAt = undefined;
      booking.reminder60mSentAt = undefined;
    }
    if (assignmentRequested) {
      if (req.accessRole !== "admin" && !req.permissions.includes(PERMISSIONS.BOOKINGS_ASSIGN)) {
        return res.status(403).json({ message: "Assignment access denied" });
      }
      if (!useReservationEngine) {
        Object.assign(booking, await resolveAssignment(req.body.assignedFixterId));
      }
    }
    if (useReservationEngine && (parsedDate || assignmentRequested)) {
      let technicianId =
        req.body.assignedFixterId || booking.assignedFixterId || null;
      if (!technicianId) {
        const options = await findEligibleTechnicians({
          slotStart: parsedDate || booking.date,
        });
        technicianId = options.recommended?.id;
      }
      if (!technicianId) {
        return res.status(409).json({
          code: "SLOT_UNAVAILABLE",
          message: "No eligible technician is available for this time",
        });
      }
      await moveReservationForBooking({
        bookingId: booking._id,
        technicianId,
        slotStart: parsedDate || booking.date,
        actorUser: req.accessUser,
        createdByType: "admin",
        assignmentSource:
          req.accessRole === "admin" ? "admin" : "general_fixter",
      });
      booking = await Booking.findById(booking._id);
      if (note !== undefined) booking.note = String(note);
      if (parsedDate) {
        booking.reminder24hQueuedAt = undefined;
        booking.reminder24hSentAt = undefined;
        booking.reminder24hSkippedAt = undefined;
        booking.reminder24hSkipReason = "";
        booking.reminder60mQueuedAt = undefined;
        booking.reminder60mSentAt = undefined;
      }
    }

    await booking.save();
    await logBookingChanges({
      bookingId: booking._id,
      before,
      after: bookingSnapshot(booking),
      req,
    });

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

