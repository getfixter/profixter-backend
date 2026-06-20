const express = require("express");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const auth = require("../middleware/auth");
const User = require("../models/User");
const Booking = require("../models/Booking");
const TechnicianTimeOff = require("../models/TechnicianTimeOff");
const TechnicianAvailabilityTemplate = require("../models/TechnicianAvailabilityTemplate");
const AvailabilityOverride = require("../models/AvailabilityOverride");
const CapacityOverride = require("../models/CapacityOverride");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const { ensureTechnicianTemplate } = require("../utils/availabilityBootstrap");

const router = express.Router();
const POSITIONS = ["Fixter", "General Fixter"];
const AVAILABILITY_STATUSES = [
  "Available",
  "Busy",
  "Vacation",
  "Sick",
  "Training",
  "Inactive",
];
const adminOnly = requirePermission(PERMISSIONS.ADMIN);

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeBookingStatus(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

const COMPLETED_BOOKING_STATUSES = new Set(["completed", "done"]);
const DELETE_SAFE_BOOKING_STATUSES = new Set([
  "completed",
  "done",
  "cancelled",
  "canceled",
  "failed",
  "no-show",
  "noshow",
]);

function bookingBlocksFixterDeletion(booking) {
  return !DELETE_SAFE_BOOKING_STATUSES.has(
    normalizeBookingStatus(booking?.status)
  );
}

function localDate(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date(value));
}

function fixterDTO(user, reporting = {}) {
  return {
    id: String(user._id),
    firstName: user.firstName || "",
    lastName: user.lastName || "",
    email: user.email,
    phone: user.phone || "",
    role: user.role,
    employeePosition: user.employeePosition,
    isActive: user.isActive !== false,
    mustChangePassword: !!user.mustChangePassword,
    isDefaultFixter: !!user.isDefaultFixter,
    employeeAvailabilityStatus:
      user.employeeAvailabilityStatus || "Available",
    completedBookingsCount: reporting.completedBookingsCount || 0,
    offDaysSummary: reporting.offDaysSummary || {
      upcomingCount: 0,
      pastCount: 0,
      recent: [],
    },
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function reportingByFixter({ bookings, timeOff, now = new Date() }) {
  const today = localDate(now);
  const todayStart = moment
    .tz(today, "YYYY-MM-DD", "America/New_York")
    .startOf("day")
    .toDate();
  const completedCounts = new Map();
  for (const booking of bookings) {
    if (!COMPLETED_BOOKING_STATUSES.has(normalizeBookingStatus(booking.status))) {
      continue;
    }
    const id = String(booking.assignedFixterId);
    completedCounts.set(id, (completedCounts.get(id) || 0) + 1);
  }

  const offDaysByFixter = new Map();
  for (const entry of timeOff) {
    const id = String(entry.technicianId);
    const rows = offDaysByFixter.get(id) || [];
    rows.push(entry);
    offDaysByFixter.set(id, rows);
  }

  return (fixterId) => {
    const rows = (offDaysByFixter.get(String(fixterId)) || []).sort(
      (left, right) =>
        new Date(right.startAt).getTime() - new Date(left.startAt).getTime()
    );
    const upcomingCount = rows.filter(
      (entry) =>
        entry.status === "approved" &&
        new Date(entry.endAt) > todayStart
    ).length;
    const pastCount = rows.filter(
      (entry) => new Date(entry.endAt) <= todayStart
    ).length;
    return {
      completedBookingsCount:
        completedCounts.get(String(fixterId)) || 0,
      offDaysSummary: {
        upcomingCount,
        pastCount,
        recent: rows.slice(0, 5).map((entry) => ({
          date: localDate(entry.startAt),
          endDate: localDate(
            entry.allDay
              ? new Date(new Date(entry.endAt).getTime() - 1)
              : entry.endAt
          ),
          reason: entry.reason || entry.type || "",
          type: entry.type,
          status: entry.status,
        })),
      },
    };
  };
}

async function loadFixtersWithReporting() {
  const rows = await User.find({ role: "employee" }).sort({ createdAt: -1 });
  const ids = rows.map((row) => row._id);
  const [bookings, timeOff] = await Promise.all([
    Booking.find({ assignedFixterId: { $in: ids } })
      .select("assignedFixterId status")
      .lean(),
    TechnicianTimeOff.find({ technicianId: { $in: ids } })
      .select("technicianId type startAt endAt allDay reason status")
      .lean(),
  ]);
  const reportingFor = reportingByFixter({ bookings, timeOff });
  return rows.map((row) => fixterDTO(row, reportingFor(row._id)));
}

async function nextUserId() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const userId = Math.floor(10000000 + Math.random() * 90000000).toString();
    if (!(await User.exists({ userId }))) return userId;
  }
  throw new Error("Unable to generate employee ID");
}

function normalizePhone(value) {
  const digits = clean(value).replace(/\D/g, "");
  if (!digits) return "";
  const normalized = digits.length === 10 ? `1${digits}` : digits;
  return normalized.length === 11 && normalized.startsWith("1")
    ? `+${normalized}`
    : null;
}

router.use(auth, ...adminOnly);

router.get("/", async (_req, res) => {
  return res.json({ fixters: await loadFixtersWithReporting() });
});

router.post("/", async (req, res) => {
  try {
    const firstName = clean(req.body.firstName);
    const lastName = clean(req.body.lastName);
    const email = clean(req.body.email).toLowerCase();
    const phone = normalizePhone(req.body.phone);
    const employeePosition = clean(req.body.employeePosition);

    if (!firstName || !lastName || !email || !phone) {
      return res.status(400).json({ message: "First name, last name, email, and valid phone are required" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Invalid email" });
    }
    if (!POSITIONS.includes(employeePosition)) {
      return res.status(400).json({ message: "Invalid employee position" });
    }
    if (await User.exists({ email })) {
      return res.status(409).json({ message: "Email already belongs to an account" });
    }

    const user = await User.create({
      userId: await nextUserId(),
      name: `${firstName} ${lastName}`,
      firstName,
      lastName,
      email,
      phone,
      password: await bcrypt.hash("11111111", 10),
      role: "employee",
      employeePosition,
      isActive: true,
      mustChangePassword: true,
      employeeAvailabilityStatus: "Available",
      addresses: [],
      defaultAddressId: null,
      subscription: null,
    });
    try {
      await ensureTechnicianTemplate(user._id);
      return res.status(201).json({
        fixter: fixterDTO(user),
        templateReady: true,
      });
    } catch (templateError) {
      console.error("Fixter created but template provisioning failed:", templateError);
      return res.status(201).json({
        fixter: fixterDTO(user),
        templateReady: false,
        warning:
          "Fixter account was created, but the availability template is missing. Run calendar foundation bootstrap.",
      });
    }
  } catch (error) {
    console.error("Create Fixter failed:", error);
    return res.status(500).json({ message: "Failed to create Fixter" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, role: "employee" });
    if (!user) return res.status(404).json({ message: "Fixter not found" });

    const firstName = clean(req.body.firstName);
    const lastName = clean(req.body.lastName);
    const phone = normalizePhone(req.body.phone);
    const employeePosition = clean(req.body.employeePosition);
    if (!firstName || !lastName || !phone || !POSITIONS.includes(employeePosition)) {
      return res.status(400).json({ message: "Valid name, phone, and position are required" });
    }

    user.firstName = firstName;
    user.lastName = lastName;
    user.name = `${firstName} ${lastName}`;
    user.phone = phone;
    user.employeePosition = employeePosition;
    await user.save();
    return res.json({ fixter: fixterDTO(user) });
  } catch (error) {
    console.error("Update Fixter failed:", error);
    return res.status(500).json({ message: "Failed to update Fixter" });
  }
});

router.patch("/:id/status", async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, role: "employee" });
    if (!user) return res.status(404).json({ message: "Fixter not found" });
    if (typeof req.body.isActive !== "boolean") {
      return res.status(400).json({ message: "isActive must be boolean" });
    }

    if (req.body.isActive) {
      try {
        await ensureTechnicianTemplate(user._id);
      } catch (templateError) {
        console.error("Fixter reactivation template provisioning failed:", templateError);
        return res.status(503).json({
          message:
            "Fixter was not reactivated because the availability template could not be prepared.",
          templateReady: false,
        });
      }
      user.isActive = true;
      if (user.employeeAvailabilityStatus === "Inactive") {
        user.employeeAvailabilityStatus = "Available";
      }
    } else {
      user.isActive = false;
      user.isDefaultFixter = false;
      user.employeeAvailabilityStatus = "Inactive";
    }

    await user.save();
    return res.json({
      fixter: fixterDTO(user),
      templateReady: true,
    });
  } catch (error) {
    console.error("Update Fixter active status failed:", error);
    return res.status(500).json({ message: "Failed to update Fixter status" });
  }
});

router.patch("/:id/availability-status", async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, role: "employee" });
  if (!user) return res.status(404).json({ message: "Fixter not found" });
  const status = clean(req.body.employeeAvailabilityStatus);
  if (!AVAILABILITY_STATUSES.includes(status)) {
    return res.status(400).json({ message: "Invalid employee availability status" });
  }
  user.employeeAvailabilityStatus = status;
  await user.save();
  return res.json({ fixter: fixterDTO(user) });
});

router.patch("/:id/default", async (req, res) => {
  try {
    const isDefault = req.body.isDefault === true;
    const user = await User.findOne({ _id: req.params.id, role: "employee" });
    if (!user) return res.status(404).json({ message: "Fixter not found" });
    if (isDefault && user.isActive === false) {
      return res.status(400).json({ message: "Inactive employee cannot be default" });
    }

    await User.updateMany(
      { role: "employee", isDefaultFixter: true },
      { $set: { isDefaultFixter: false } }
    );
    if (isDefault) {
      await User.updateOne(
        { _id: user._id },
        { $set: { isDefaultFixter: true } }
      );
    }
    return res.json({ fixters: await loadFixtersWithReporting() });
  } catch (error) {
    console.error("Set default Fixter failed:", error);
    return res.status(500).json({ message: "Failed to update default Fixter" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Fixter not found" });
    }
    const user = await User.findOne({
      _id: req.params.id,
      role: "employee",
    });
    if (!user) return res.status(404).json({ message: "Fixter not found" });
    if (user.isDefaultFixter) {
      return res.status(409).json({
        message:
          "Remove this fixter as the default fixter before deleting.",
      });
    }

    const futureBookings = await Booking.find({
      assignedFixterId: user._id,
      date: { $gte: new Date() },
    })
      .select("_id date status")
      .lean();
    const activeFutureBookings = futureBookings.filter(
      bookingBlocksFixterDeletion
    );
    if (activeFutureBookings.length) {
      return res.status(409).json({
        message:
          "This fixter has upcoming assigned bookings. Reassign or cancel them before deleting.",
        upcomingBookingCount: activeFutureBookings.length,
      });
    }

    await Promise.all([
      TechnicianAvailabilityTemplate.deleteMany({
        technicianId: user._id,
      }),
      TechnicianTimeOff.deleteMany({ technicianId: user._id }),
      AvailabilityOverride.deleteMany({
        scopeType: "technician",
        technicianId: user._id,
      }),
      CapacityOverride.deleteMany({
        scopeType: "technician",
        technicianId: user._id,
      }),
    ]);
    await User.deleteOne({ _id: user._id, role: "employee" });
    return res.json({ deleted: true, fixterId: String(user._id) });
  } catch (error) {
    console.error("Delete Fixter failed:", error);
    return res.status(500).json({ message: "Failed to delete Fixter" });
  }
});

module.exports = router;

module.exports.normalizeBookingStatus = normalizeBookingStatus;
module.exports.reportingByFixter = reportingByFixter;
module.exports.bookingBlocksFixterDeletion = bookingBlocksFixterDeletion;
