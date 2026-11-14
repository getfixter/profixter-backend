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
const { SECTIONS, SECTIONS_VERSION, cleanSections, isFieldPosition, isSealedPosition, registryForEditor } = require("../utils/adminAccess");
const { revokeAllForUser } = require("../utils/auth/sessions");
const { ensureTechnicianTemplate } = require("../utils/availabilityBootstrap");
const {
  createAdminActivityLog,
  markAdminActivityLog,
} = require("../utils/adminActivityLog");

/*
 * Staff accounts: Fixters and every other employee. Owner only (whoever can
 * manage staff can grant themselves anything, so this is never a section).
 *
 * An employee has a free-text title (display only), optional field work
 * (Fixter / General Fixter: the job access those positions always had) and the
 * Admin sections the owner switched on. See utils/adminAccess.js.
 */
const router = express.Router();
/* Field work (Fixter / General Fixter) or the sealed office role Telemarketer. */
const POSITIONS = ["Fixter", "General Fixter", "Telemarketer"];

/* A Telemarketer's access is fixed: never any Admin sections (see utils/adminAccess.js). */
const sectionsFor = (position, sections) => (isSealedPosition(position) ? [] : cleanSections(sections));
async function salesRecordsOf(userId) {
  const { LeadAssignment, CommissionEntry, SalesCreditRequest } = require("../models/Sales");
  const [open, entries, requests] = await Promise.all([
    LeadAssignment.countDocuments({ employee: userId, endedAt: null }),
    CommissionEntry.countDocuments({ employee: userId }),
    SalesCreditRequest.countDocuments({ employee: userId }),
  ]);
  return { openLeads: open, ledgerEntries: entries, creditRequests: requests, any: open + entries + requests > 0 };
}
const TITLE_MAX = 80;

const sectionLabel = new Map(SECTIONS.map((s) => [s.id, s.label]));
const labels = (ids) => ids.map((id) => sectionLabel.get(id) || id);

/* "" (or null) means no field work: an office, marketing or sales employee. */
function readPosition(value) {
  const v = clean(value);
  if (!v || v === "none") return { ok: true, value: null };
  return POSITIONS.includes(v) ? { ok: true, value: v } : { ok: false };
}

function readTitle(value, position) {
  const title = clean(value).slice(0, TITLE_MAX);
  // A Fixter created before titles existed reads as their position.
  return title || (position ? position : "");
}
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
    name: user.name || "",
    firstName: user.firstName || "",
    lastName: user.lastName || "",
    email: user.email,
    phone: user.phone || "",
    role: user.role,
    employeePosition: user.employeePosition || null,
    employeeTitle: user.employeeTitle || user.employeePosition || "",
    adminSections: cleanSections(user.adminSections),
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

/* What the access editor shows: sections with plain-language labels, grouped. */
router.get("/access-registry", (_req, res) => {
  return res.json(registryForEditor());
});

router.post("/", async (req, res) => {
  try {
    const firstName = clean(req.body.firstName);
    const lastName = clean(req.body.lastName);
    const email = clean(req.body.email).toLowerCase();
    const phone = normalizePhone(req.body.phone);
    const position = readPosition(req.body.employeePosition);
    if (!position.ok) return res.status(400).json({ message: "Invalid field work option" });
    const employeePosition = position.value;
    const employeeTitle = readTitle(req.body.employeeTitle, employeePosition);
    const adminSections = sectionsFor(employeePosition, req.body.adminSections);

    if (!firstName || !lastName || !email) {
      return res.status(400).json({ message: "First name, last name and email are required" });
    }
    // Field workers get job texts, so they need a phone; for office staff it is optional.
    if (phone === null || (isFieldPosition(employeePosition) && !phone)) {
      return res.status(400).json({ message: isFieldPosition(employeePosition) ? "A valid phone is required for a Fixter" : "Phone number is not valid" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Invalid email" });
    }
    /*
     * The duplicate-email exception, and the only one in the system.
     *
     * This route is admin-only (see router.use above), so the check is scoped
     * to employee accounts rather than removed: one person may hold a customer
     * account and one Fixter account on the same email, and no more than that.
     * Public registration still refuses any address that exists at all, so this
     * cannot be reached from outside the admin tools.
     */
    if (await User.exists({ email, role: "employee" })) {
      return res.status(409).json({
        message: "This email already has a Fixter account.",
      });
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
      employeeTitle,
      adminSections,
      adminSectionsVersion: SECTIONS_VERSION,
      isActive: true,
      mustChangePassword: true,
      employeeAvailabilityStatus: "Available",
      addresses: [],
      defaultAddressId: null,
      subscription: null,
    });
    await createAdminActivityLog(req, {
      action: "Employee Created",
      entityType: "employee",
      entityId: user._id,
      entityName: user.name,
      details: { title: employeeTitle, fieldWork: employeePosition || "None", sections: labels(adminSections) },
    }).catch((e) => console.warn("Employee audit log failed:", e.message));
    // Only field workers have a working calendar.
    if (!isFieldPosition(employeePosition)) {
      return res.status(201).json({ fixter: fixterDTO(user), templateReady: true });
    }
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
    const position = readPosition(req.body.employeePosition);
    if (!firstName || !lastName || !position.ok || phone === null || (isFieldPosition(position.value) && !phone)) {
      return res.status(400).json({ message: "Valid name and field work are required, and a phone for a Fixter" });
    }
    const employeePosition = position.value;
    if (user.employeePosition === "Telemarketer" && employeePosition !== "Telemarketer") {
      const recs = await salesRecordsOf(user._id);
      if (recs.openLeads) return res.status(409).json({ message: `Reassign this telemarketer's ${recs.openLeads} open lead(s) in Sales desk before changing their role.` });
    }
    const employeeTitle = readTitle(req.body.employeeTitle, employeePosition);
    // Sections are only changed when sent, so an older client editing a name cannot wipe them.
    const adminSections = sectionsFor(employeePosition, req.body.adminSections === undefined ? user.adminSections : req.body.adminSections);

    const before = {
      title: user.employeeTitle || user.employeePosition || "",
      fieldWork: user.employeePosition || null,
      sections: cleanSections(user.adminSections),
    };

    user.firstName = firstName;
    user.lastName = lastName;
    user.name = `${firstName} ${lastName}`;
    user.phone = phone;
    user.employeePosition = employeePosition;
    user.employeeTitle = employeeTitle;
    user.adminSections = adminSections;
    user.adminSectionsVersion = SECTIONS_VERSION;
    if (!isFieldPosition(employeePosition)) user.isDefaultFixter = false;
    await user.save();
    if (isFieldPosition(employeePosition) && !isFieldPosition(before.fieldWork)) {
      await ensureTechnicianTemplate(user._id).catch((e) => console.error("Template provisioning failed:", e.message));
    }

    /* The changes that matter for who can see what, each in the activity log. */
    const log = (action, details) =>
      createAdminActivityLog(req, { action, entityType: "employee", entityId: user._id, entityName: user.name, details }).catch((e) =>
        console.warn("Employee audit log failed:", e.message)
      );
    const sameSections = before.sections.join(",") === adminSections.join(",");
    if (!sameSections) {
      await log("Employee Permissions Changed", {
        before: labels(before.sections),
        after: labels(adminSections),
        added: labels(adminSections.filter((s) => !before.sections.includes(s))),
        removed: labels(before.sections.filter((s) => !adminSections.includes(s))),
      });
    }
    if (before.title !== employeeTitle) await log("Employee Title Changed", { before: before.title, after: employeeTitle });
    if ((before.fieldWork || null) !== (employeePosition || null)) {
      await log("Employee Field Work Changed", { before: before.fieldWork || "None", after: employeePosition || "None" });
    }
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

    const wasActive = user.isActive !== false;
    if (req.body.isActive && !isFieldPosition(user.employeePosition)) {
      // Office staff have no working calendar to prepare.
      user.isActive = true;
      if (user.employeeAvailabilityStatus === "Inactive") user.employeeAvailabilityStatus = "Available";
    } else if (req.body.isActive) {
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
    /*
     * Offboarding a Telemarketer: every session ends now (not only on the next
     * request), their records and earned money stay, and their open leads are
     * listed for the owner to reassign (choosing who keeps credit).
     */
    let sales = null;
    if (!user.isActive && wasActive && user.employeePosition === "Telemarketer") {
      await revokeAllForUser(user._id, "employee_disabled").catch((e) => console.error("Session revoke on disable failed:", e.message));
      sales = await salesRecordsOf(user._id);
    }
    if (wasActive !== user.isActive) {
      await createAdminActivityLog(req, {
        action: user.isActive ? "Employee Enabled" : "Employee Disabled",
        entityType: "employee",
        entityId: user._id,
        entityName: user.name,
        details: { title: user.employeeTitle || user.employeePosition || "" },
      }).catch((e) => console.warn("Employee audit log failed:", e.message));
    }
    /*
     * J-21: disabling does not touch their jobs, but the owner is told how many
     * upcoming jobs still name this person, so they can reassign them in one
     * step (POST /:id/reassign-future-jobs).
     */
    const futureAssignedJobs = user.isActive ? 0 : (await futureJobsFor(user._id)).length;
    return res.json({
      fixter: fixterDTO(user),
      templateReady: true,
      futureAssignedJobs,
      ...(sales ? { sales: { openLeads: sales.openLeads, sessionsRevoked: true } } : {}),
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
    if (isDefault && !isFieldPosition(user.employeePosition)) {
      return res.status(400).json({ message: "Only a Fixter can be the default for new jobs" });
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

/* Upcoming, not-closed jobs still assigned to this employee. */
async function futureJobsFor(fixterId) {
  const rows = await Booking.find({ assignedFixterId: fixterId, date: { $gte: new Date() } })
    .select("_id bookingNumber date status name assignedFixterName")
    .sort({ date: 1 })
    .lean();
  return rows.filter(bookingBlocksFixterDeletion);
}

router.get("/:id/future-jobs", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Fixter not found" });
    const jobs = await futureJobsFor(req.params.id);
    return res.json({
      count: jobs.length,
      jobs: jobs.map((b) => ({ id: String(b._id), bookingNumber: b.bookingNumber, date: b.date, status: b.status, customerName: b.name || "" })),
    });
  } catch (error) {
    console.error("Load future jobs failed:", error);
    return res.status(500).json({ message: "Failed to load the jobs" });
  }
});

/*
 * Move every upcoming job of one employee to another (or to the best free
 * Fixter per job with toFixterId "auto") through the reservation engine, so
 * availability and double-booking rules are the usual ones. A job that cannot
 * move is reported, never forced. Confirmed customers get the usual "your
 * Fixter is now ..." text where texting is allowed. Owner only (router guard).
 */
router.post("/:id/reassign-future-jobs", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: "Fixter not found" });
    const toFixterId = String(req.body?.toFixterId || "");
    if (toFixterId !== "auto" && !mongoose.isValidObjectId(toFixterId)) {
      return res.status(400).json({ code: "TARGET_REQUIRED", message: "Choose who takes the jobs (a Fixter, or auto)." });
    }
    if (toFixterId === req.params.id) {
      return res.status(400).json({ code: "SAME_FIXTER", message: "Choose a different Fixter." });
    }
    const { findEligibleTechnicians, moveReservationForBooking, reservationEngineEnabled } = require("../utils/slotReservationService");
    const { resolveAssignmentFields } = require("../utils/jobs/assignment");
    const { notifyAssignment } = require("../utils/jobs/jobNotifications");
    const { IdempotencyError, readIdempotencyKey, runIdempotent } = require("../utils/adminIdempotency");
    /*
     * Optional idempotencyKey (JSON body; the Idempotency-Key header is a
     * fallback). A replay returns the first answer with replayed:true and
     * moves and notifies nothing. Without a key it behaves as before.
     */
    const rawKey = req.body?.idempotencyKey || req.get?.("Idempotency-Key") || "";
    let key = null;
    try {
      key = rawKey ? readIdempotencyKey(rawKey) : null;
    } catch (error) {
      return res.status(error.statusCode || 400).json({ code: error.code, message: error.message });
    }
    const reassign = async () => {
    const jobs = await futureJobsFor(req.params.id);
    const moved = [];
    const failed = [];
    for (const job of jobs) {
      try {
        let target = toFixterId;
        if (target === "auto") {
          const options = await findEligibleTechnicians({ slotStart: job.date, excludeBookingId: job._id });
          target = options.available.find((t) => String(t.id) !== req.params.id)?.id || null;
          if (!target) throw Object.assign(new Error("No other Fixter is free at this time"), { code: "SLOT_UNAVAILABLE" });
        }
        if (reservationEngineEnabled()) {
          await moveReservationForBooking({ bookingId: job._id, technicianId: target, slotStart: job.date, actorUser: req.accessUser || null, createdByType: "admin", assignmentSource: "admin" });
        } else {
          await Booking.updateOne({ _id: job._id }, { $set: await resolveAssignmentFields(target) });
        }
        const after = await Booking.findById(job._id);
        const notice = await notifyAssignment(after, { previousFixterId: req.params.id, source: "adminFixterReassign" });
        moved.push({ id: String(job._id), bookingNumber: job.bookingNumber, date: job.date, toFixterName: after.assignedFixterName || "", notification: notice });
      } catch (error) {
        failed.push({ id: String(job._id), bookingNumber: job.bookingNumber, date: job.date, code: error?.code || "MOVE_FAILED", message: error?.message || "Could not move this job" });
      }
    }
    await createAdminActivityLog(req, {
      action: "Fixter Jobs Reassigned",
      entityType: "employee",
      entityId: req.params.id,
      entityName: jobs[0]?.assignedFixterName || "",
      details: { toFixterId, moved: moved.length, failed: failed.length, bookingNumbers: moved.map((m) => m.bookingNumber) },
    }).catch(() => {});
    return { httpStatus: 200, body: { total: jobs.length, moved, failed } };
    };
    if (!key) {
      const result = await reassign();
      return res.status(result.httpStatus).json(result.body);
    }
    try {
      const result = await runIdempotent({ req, action: "fixter.reassign_future_jobs", key, entityId: req.params.id }, reassign);
      return res.status(result.httpStatus).json({ ...result.body, replayed: result.replayed });
    } catch (error) {
      if (error instanceof IdempotencyError) return res.status(error.statusCode).json({ code: error.code, message: error.message });
      throw error;
    }
  } catch (error) {
    console.error("Reassign future jobs failed:", error);
    return res.status(500).json({ message: "Failed to reassign the jobs" });
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
    // Sales history (earnings, statements, credit decisions) must outlive the account: disable instead.
    if ((await salesRecordsOf(user._id)).any) {
      return res.status(409).json({ message: "This employee has sales records and earnings history. Disable the account instead of deleting it." });
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

    const audit = await createAdminActivityLog(req, {
      action: "Fixter Delete Started",
      entityType: "Fixter",
      entityId: user._id,
      entityName: user.name || user.email,
      details: {
        name: user.name,
        email: user.email,
        phone: user.phone,
        employeePosition: user.employeePosition,
      },
    });

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
    await markAdminActivityLog(audit, {
      action: "Fixter Deleted",
      details: {
        name: user.name,
        email: user.email,
        phone: user.phone,
        employeePosition: user.employeePosition,
        deletedAt: new Date().toISOString(),
      },
    });
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
