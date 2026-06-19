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
const { dateValidator } = require("../utils/availabilityValidation");

router.use(auth, ...requirePermission(PERMISSIONS.SCHEDULE_READ));
const scheduleWrite = requirePermission(PERMISSIONS.SCHEDULE_WRITE);

function asyncRoute(handler) {
  return (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
}

function actorId(req) {
  return req.accessUser?._id || req.user?.id || null;
}

function cleanSchedule(value) {
  if (!Array.isArray(value)) return [];
  return value.map((day) => ({
    weekday: Number(day.weekday),
    enabled: day.enabled !== false,
    intervals: Array.isArray(day.intervals)
      ? day.intervals.map((interval) => ({
          startTime: String(interval.startTime || ""),
          endTime: String(interval.endTime || ""),
          ...(interval.capacity === null ||
          interval.capacity === undefined ||
          interval.capacity === ""
            ? {}
            : { capacity: Number(interval.capacity) }),
        }))
      : [],
  }));
}

function scopeFromBody(body) {
  const scopeType = String(body.scopeType || "company").toLowerCase();
  if (!["company", "technician"].includes(scopeType)) {
    const error = new Error("scopeType must be company or technician");
    error.statusCode = 400;
    throw error;
  }
  const technicianId =
    scopeType === "technician" ? String(body.technicianId || "") : null;
  if (scopeType === "technician" && !technicianId) {
    const error = new Error("technicianId is required for technician scope");
    error.statusCode = 400;
    throw error;
  }
  return { scopeType, technicianId };
}

async function requireTechnician(technicianId) {
  const technician = await User.findOne({
    _id: technicianId,
    role: "employee",
    employeePosition: { $in: ["Fixter", "General Fixter"] },
    isActive: { $ne: false },
  }).select("_id name email employeePosition");
  if (!technician) {
    const error = new Error("Active technician not found");
    error.statusCode = 404;
    throw error;
  }
  return technician;
}

async function findCapacityOverride(key) {
  const matches = await CapacityOverride.find(key).sort({
    updatedAt: -1,
    createdAt: -1,
    _id: -1,
  });
  if (matches.length > 1) {
    await CapacityOverride.deleteMany({
      _id: { $in: matches.slice(1).map((entry) => entry._id) },
    });
  }
  return matches[0] || null;
}

function writeError(res, error, fallback) {
  if (error?.code === 11000) {
    return res.status(409).json({
      message: "This calendar setting was changed by another request. Refresh and retry.",
    });
  }
  if (error?.name === "ValidationError" || error?.statusCode === 400) {
    return res.status(400).json({ message: error.message });
  }
  return res
    .status(error?.statusCode || 500)
    .json({ message: error?.message || fallback });
}

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

router.put(
  "/company-template",
  ...scheduleWrite,
  asyncRoute(async (req, res) => {
    try {
      const template = await CompanyAvailabilityTemplate.findOne({
        active: true,
      });
      if (!template) {
        return res.status(503).json({
          code: "SHADOW_FOUNDATION_NOT_READY",
          message:
            "Company availability template is missing. An Admin must run foundation bootstrap.",
        });
      }

      const allowed = req.body || {};
      if (allowed.timezone !== undefined) {
        try {
          new Intl.DateTimeFormat("en-US", {
            timeZone: String(allowed.timezone),
          }).format();
          template.timezone = String(allowed.timezone);
        } catch {
          return res.status(400).json({ message: "timezone is invalid" });
        }
      }
      if (allowed.slotMinutes !== undefined) {
        template.slotMinutes = Number(allowed.slotMinutes);
      }
      if (allowed.minLeadMinutes !== undefined) {
        template.minLeadMinutes = Number(allowed.minLeadMinutes);
      }
      if (allowed.maxAdvanceDays !== undefined) {
        template.maxAdvanceDays = Number(allowed.maxAdvanceDays);
      }
      if (allowed.defaultCapacity !== undefined) {
        template.defaultCapacity = Number(allowed.defaultCapacity);
      }
      if (allowed.weeklySchedule !== undefined) {
        template.weeklySchedule = cleanSchedule(allowed.weeklySchedule);
      }
      template.updatedBy = actorId(req);
      template.version += 1;
      await template.save();
      return res.json({ template });
    } catch (error) {
      return writeError(res, error, "Failed to update company template");
    }
  })
);

router.put(
  "/technicians/:id/template",
  ...scheduleWrite,
  asyncRoute(async (req, res) => {
    try {
      await requireTechnician(req.params.id);
      const template = await TechnicianAvailabilityTemplate.findOne({
        technicianId: req.params.id,
        active: true,
      });
      if (!template) {
        return res.status(409).json({
          code: "TECHNICIAN_TEMPLATE_MISSING",
          message:
            "Technician template is missing. An Admin must initialize the calendar foundation.",
        });
      }
      if (req.body.inheritCompanyHours !== undefined) {
        template.inheritCompanyHours = !!req.body.inheritCompanyHours;
      }
      if (req.body.weeklySchedule !== undefined) {
        template.weeklySchedule = cleanSchedule(req.body.weeklySchedule).map(
          (day) => ({
            ...day,
            intervals: day.intervals.map(({ startTime, endTime }) => ({
              startTime,
              endTime,
            })),
          })
        );
      }
      template.updatedBy = actorId(req);
      await template.save();
      return res.json({ template });
    } catch (error) {
      return writeError(res, error, "Failed to update technician template");
    }
  })
);

router.put(
  "/overrides/day",
  ...scheduleWrite,
  asyncRoute(async (req, res) => {
    try {
      const { scopeType, technicianId } = scopeFromBody(req.body || {});
      const date = String(req.body.date || "");
      if (!dateValidator(date)) {
        return res.status(400).json({ message: "date must be YYYY-MM-DD" });
      }
      if (technicianId) await requireTechnician(technicianId);
      let override = await AvailabilityOverride.findOne({
        scopeType,
        technicianId,
        date,
      });
      if (!override) {
        override = new AvailabilityOverride({ scopeType, technicianId, date });
      }
      override.mode = String(req.body.mode || "");
      override.intervals = Array.isArray(req.body.intervals)
        ? req.body.intervals.map((interval) => ({
            startTime: String(interval.startTime || ""),
            endTime: String(interval.endTime || ""),
          }))
        : [];
      override.reason = String(req.body.reason || "");
      override.notes = String(req.body.notes || "");
      override.updatedBy = actorId(req);
      await override.save();
      return res.json({ override });
    } catch (error) {
      return writeError(res, error, "Failed to save day override");
    }
  })
);

router.delete(
  "/overrides/day",
  ...scheduleWrite,
  asyncRoute(async (req, res) => {
    try {
      const { scopeType, technicianId } = scopeFromBody(req.query || {});
      const date = String(req.query.date || "");
      if (!dateValidator(date)) {
        return res.status(400).json({ message: "date must be YYYY-MM-DD" });
      }
      await AvailabilityOverride.deleteOne({
        scopeType,
        technicianId,
        date,
      });
      return res.json({ restored: true });
    } catch (error) {
      return writeError(res, error, "Failed to restore day");
    }
  })
);

router.post(
  "/capacity-overrides/slot-action",
  ...scheduleWrite,
  asyncRoute(async (req, res) => {
    try {
      const { scopeType, technicianId } = scopeFromBody(req.body || {});
      const date = String(req.body.date || "");
      const startTime = String(req.body.startTime || "");
      const endTime = String(req.body.endTime || "");
      const action = String(req.body.action || "");
      if (!dateValidator(date)) {
        return res.status(400).json({ message: "date must be YYYY-MM-DD" });
      }
      if (technicianId) await requireTechnician(technicianId);
      if (!["close", "open", "add_spot", "remove_spot", "restore"].includes(action)) {
        return res.status(400).json({ message: "Invalid slot action" });
      }
      const key = { scopeType, technicianId, date, startTime, endTime };
      let override = await findCapacityOverride(key);

      if (action === "open" || action === "restore") {
        await CapacityOverride.deleteMany(key);
        return res.json({ override: null, restored: true });
      }
      if (!override) override = new CapacityOverride(key);
      if (action === "close") {
        override.mode = "set_capacity";
        override.value = 0;
      } else if (action === "add_spot") {
        if (override.mode === "block_spots" && override.value > 0) {
          override.value -= 1;
          if (override.value === 0) {
            await CapacityOverride.deleteMany(key);
            return res.json({ override: null, restored: true });
          }
        } else if (override.mode === "set_capacity") {
          override.value += 1;
        } else {
          override.mode = "adjust_capacity";
          override.value = Number(override.value || 0) + 1;
        }
      } else if (action === "remove_spot") {
        if (override.mode === "adjust_capacity" && override.value > 0) {
          override.value -= 1;
          if (override.value === 0) {
            await CapacityOverride.deleteMany(key);
            return res.json({ override: null, restored: true });
          }
        } else if (override.mode === "set_capacity") {
          override.value = Math.max(0, override.value - 1);
        } else {
          override.mode = "block_spots";
          override.value = Number(override.value || 0) + 1;
        }
      }
      override.reason = String(req.body.reason || "");
      override.updatedBy = actorId(req);
      await override.save();
      return res.json({ override });
    } catch (error) {
      return writeError(res, error, "Failed to update slot capacity");
    }
  })
);

router.post(
  "/time-off",
  ...scheduleWrite,
  asyncRoute(async (req, res) => {
    try {
      await requireTechnician(req.body.technicianId);
      const companyTemplate = await CompanyAvailabilityTemplate.findOne({
        active: true,
      })
        .select("timezone")
        .lean();
      const timezone = companyTemplate?.timezone || "America/New_York";
      const allDayDate = String(req.body.date || "");
      const useAllDayDate = req.body.allDay !== false && dateValidator(allDayDate);
      const entry = new TechnicianTimeOff({
        technicianId: req.body.technicianId,
        type: req.body.type,
        startAt: useAllDayDate
          ? moment.tz(allDayDate, "YYYY-MM-DD", timezone).startOf("day").toDate()
          : req.body.startAt,
        endAt: useAllDayDate
          ? moment
              .tz(allDayDate, "YYYY-MM-DD", timezone)
              .add(1, "day")
              .startOf("day")
              .toDate()
          : req.body.endAt,
        allDay: req.body.allDay !== false,
        reason: String(req.body.reason || ""),
        status: "approved",
        createdBy: actorId(req),
      });
      await entry.save();
      return res.status(201).json({ timeOff: entry });
    } catch (error) {
      return writeError(res, error, "Failed to create time off");
    }
  })
);

router.put(
  "/time-off/:id",
  ...scheduleWrite,
  asyncRoute(async (req, res) => {
    try {
      const entry = await TechnicianTimeOff.findById(req.params.id);
      if (!entry) return res.status(404).json({ message: "Time off not found" });
      if (req.body.technicianId !== undefined) {
        await requireTechnician(req.body.technicianId);
        entry.technicianId = req.body.technicianId;
      }
      for (const field of ["type", "startAt", "endAt", "allDay", "reason"]) {
        if (req.body[field] !== undefined) entry[field] = req.body[field];
      }
      entry.status = "approved";
      await entry.save();
      return res.json({ timeOff: entry });
    } catch (error) {
      return writeError(res, error, "Failed to update time off");
    }
  })
);

router.delete(
  "/time-off/:id",
  ...scheduleWrite,
  asyncRoute(async (req, res) => {
    const entry = await TechnicianTimeOff.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: "Time off not found" });
    entry.status = "canceled";
    await entry.save();
    return res.json({ canceled: true });
  })
);

router.put(
  "/notes/:date",
  ...scheduleWrite,
  asyncRoute(async (req, res) => {
    try {
      if (!dateValidator(req.params.date)) {
        return res.status(400).json({ message: "date must be YYYY-MM-DD" });
      }
      const noteText = String(req.body.note || "").trim();
      if (!noteText) {
        await CalendarDayNote.deleteOne({ date: req.params.date });
        return res.json({ note: null });
      }
      let note = await CalendarDayNote.findOne({ date: req.params.date });
      if (!note) {
        note = new CalendarDayNote({
          date: req.params.date,
          createdBy: actorId(req),
        });
      }
      note.note = noteText;
      note.updatedBy = actorId(req);
      await note.save();
      return res.json({ note });
    } catch (error) {
      return writeError(res, error, "Failed to save day note");
    }
  })
);

router.delete(
  "/notes/:date",
  ...scheduleWrite,
  asyncRoute(async (req, res) => {
    if (!dateValidator(req.params.date)) {
      return res.status(400).json({ message: "date must be YYYY-MM-DD" });
    }
    await CalendarDayNote.deleteOne({ date: req.params.date });
    return res.json({ deleted: true });
  })
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
  const query = {
    status:
      String(req.query.includeCanceled || "") === "true"
        ? { $in: ["approved", "canceled"] }
        : "approved",
  };
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
