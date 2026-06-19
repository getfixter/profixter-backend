const express = require("express");
const moment = require("moment-timezone");
const router = express.Router();

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
const TechnicianAvailabilityTemplate = require("../models/TechnicianAvailabilityTemplate");
const AvailabilityOverride = require("../models/AvailabilityOverride");
const CapacityOverride = require("../models/CapacityOverride");
const TechnicianTimeOff = require("../models/TechnicianTimeOff");
const CalendarDayNote = require("../models/CalendarDayNote");
const User = require("../models/User");
const {
  bootstrapAvailabilityFoundation,
  getFoundationStatus,
} = require("../utils/availabilityBootstrap");
const {
  calculateDayAvailability,
  calculateMonthSummary,
} = require("../utils/availabilityService");

router.use(auth, ...requirePermission(PERMISSIONS.SCHEDULE_READ));

router.post(
  "/foundation/bootstrap",
  ...requirePermission(PERMISSIONS.ADMIN),
  async (_req, res) => {
    try {
      const result = await bootstrapAvailabilityFoundation();
      return res.status(result.ok ? 200 : 503).json({
        shadowMode: true,
        ...result,
      });
    } catch (error) {
      console.error("Shadow foundation bootstrap failed:", error);
      return res.status(500).json({
        shadowMode: true,
        ok: false,
        message: "Shadow foundation bootstrap failed",
        errors: [error.message || "Unknown bootstrap error"],
      });
    }
  }
);

router.get("/summary", async (req, res) => {
  try {
    const month =
      String(req.query.month || "").trim() ||
      moment().tz("America/New_York").format("YYYY-MM");
    return res.json(
      await calculateMonthSummary({
        month,
        scope: String(req.query.scope || "company").toLowerCase(),
        technicianId: req.query.technicianId
          ? String(req.query.technicianId)
          : null,
      })
    );
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ message: error.message || "Failed to load calendar summary" });
  }
});

router.get("/day", async (req, res) => {
  try {
    return res.json(
      await calculateDayAvailability({
        date: String(req.query.date || "").trim(),
        scope: String(req.query.scope || "company").toLowerCase(),
        technicianId: req.query.technicianId
          ? String(req.query.technicianId)
          : null,
      })
    );
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ message: error.message || "Failed to load calendar day" });
  }
});

router.get("/company-template", async (_req, res) => {
  const template = await CompanyAvailabilityTemplate.findOne({
    active: true,
  }).lean();
  if (!template) {
    return res.status(503).json({
      code: "SHADOW_FOUNDATION_NOT_READY",
      message:
        "Company availability template is missing. An Admin must run foundation bootstrap.",
    });
  }
  return res.json({ template });
});

router.get("/technicians", async (_req, res) => {
  const technicians = await User.find({
    role: "employee",
    employeePosition: { $in: ["Fixter", "General Fixter"] },
  })
    .select(
      "name firstName lastName email employeePosition employeeAvailabilityStatus isActive"
    )
    .sort({ isActive: -1, name: 1 })
    .lean();
  const templates = await TechnicianAvailabilityTemplate.find({
    technicianId: { $in: technicians.map((technician) => technician._id) },
    active: true,
  }).lean();
  const templateByTechnician = new Map(
    templates.map((template) => [
      String(template.technicianId),
      template,
    ])
  );
  return res.json({
    technicians: technicians.map((technician) => ({
      id: String(technician._id),
      name: technician.name,
      firstName: technician.firstName || "",
      lastName: technician.lastName || "",
      email: technician.email,
      position: technician.employeePosition,
      isActive: technician.isActive !== false,
      visibilityStatus:
        technician.employeeAvailabilityStatus || "Available",
      template: templateByTechnician.get(String(technician._id)) || null,
    })),
  });
});

router.get("/technicians/:id/template", async (req, res) => {
  const technician = await User.findOne({
    _id: req.params.id,
    role: "employee",
    employeePosition: { $in: ["Fixter", "General Fixter"] },
  })
    .select("name email employeePosition employeeAvailabilityStatus isActive")
    .lean();
  if (!technician) {
    return res.status(404).json({ message: "Technician not found" });
  }
  const template = await TechnicianAvailabilityTemplate.findOne({
    technicianId: technician._id,
    active: true,
  }).lean();
  return res.json({
    technician,
    template,
    templateReady: !!template,
    warning:
      technician.isActive && !template
        ? "Active technician is missing an availability template"
        : null,
  });
});

router.get("/overrides", async (req, res) => {
  const query = buildDateScopedQuery(req.query);
  const overrides = await AvailabilityOverride.find(query)
    .sort({ date: 1, scopeType: 1 })
    .lean();
  return res.json({ overrides });
});

router.get("/capacity-overrides", async (req, res) => {
  const query = buildDateScopedQuery(req.query);
  const overrides = await CapacityOverride.find(query)
    .sort({ date: 1, startTime: 1 })
    .lean();
  return res.json({ overrides });
});

router.get("/time-off", async (req, res) => {
  const query = {};
  if (req.query.technicianId) query.technicianId = req.query.technicianId;
  if (req.query.to) {
    query.startAt = { $lt: new Date(`${req.query.to}T23:59:59.999Z`) };
  }
  if (req.query.from) {
    query.endAt = { $gt: new Date(`${req.query.from}T00:00:00.000Z`) };
  }
  const timeOff = await TechnicianTimeOff.find(query)
    .populate("technicianId", "name email employeePosition")
    .sort({ startAt: 1 })
    .lean();
  return res.json({ timeOff });
});

router.get("/notes", async (req, res) => {
  const query = {};
  if (req.query.from || req.query.to) {
    query.date = {};
    if (req.query.from) query.date.$gte = String(req.query.from);
    if (req.query.to) query.date.$lte = String(req.query.to);
  }
  return res.json({
    notes: await CalendarDayNote.find(query).sort({ date: 1 }).lean(),
  });
});

router.get("/foundation-status", async (_req, res) => {
  const [status, counts] = await Promise.all([
    getFoundationStatus(),
    Promise.all([
      CompanyAvailabilityTemplate.countDocuments({ active: true }),
      TechnicianAvailabilityTemplate.countDocuments({ active: true }),
      AvailabilityOverride.countDocuments(),
      CapacityOverride.countDocuments(),
      TechnicianTimeOff.countDocuments(),
      CalendarDayNote.countDocuments(),
    ]),
  ]);
  return res.json({
    shadowMode: true,
    ...status,
    collections: {
      activeCompanyTemplates: counts[0],
      activeTechnicianTemplates: counts[1],
      availabilityOverrides: counts[2],
      capacityOverrides: counts[3],
      timeOff: counts[4],
      dayNotes: counts[5],
    },
  });
});

function buildDateScopedQuery(params) {
  const query = {};
  if (params.scope) query.scopeType = String(params.scope);
  if (params.technicianId) query.technicianId = params.technicianId;
  if (params.from || params.to) {
    query.date = {};
    if (params.from) query.date.$gte = String(params.from);
    if (params.to) query.date.$lte = String(params.to);
  }
  return query;
}

module.exports = router;
