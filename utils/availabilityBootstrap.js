const CalendarConfig = require("../models/CalendarConfig");
const CompanyAvailabilityTemplate = require("../models/CompanyAvailabilityTemplate");
const TechnicianAvailabilityTemplate = require("../models/TechnicianAvailabilityTemplate");
const AvailabilityOverride = require("../models/AvailabilityOverride");
const User = require("../models/User");
const { dateValidator, timeToMinutes } = require("./availabilityValidation");

function minutesToTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
    minutes % 60
  ).padStart(2, "0")}`;
}

function normalizedStartMinutes(hours) {
  return Array.from(
    new Set(
      (hours || [])
        .map(timeToMinutes)
        .filter((value) => Number.isInteger(value))
    )
  ).sort((left, right) => left - right);
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) [a, b] = [b, a % b];
  return a;
}

function inferLegacySlotMinutes(hours, configuredSlotMinutes = 60) {
  const starts = normalizedStartMinutes(hours);
  const configured = Math.min(
    240,
    Math.max(15, Number(configuredSlotMinutes || 60))
  );
  if (starts.length < 2) return configured;

  const deltas = starts
    .slice(1)
    .map((value, index) => value - starts[index])
    .filter((value) => value > 0);
  if (!deltas.length) return configured;

  const inferred = deltas.reduce(greatestCommonDivisor);
  if (!Number.isFinite(inferred) || inferred < 15 || inferred > 240) {
    return configured;
  }
  return Math.min(configured, inferred);
}

function hoursToIntervals(
  hours,
  slotMinutes,
  capacity,
  visitDurationMinutes = 90
) {
  const starts = normalizedStartMinutes(hours);
  const intervals = [];
  let rangeStart = null;
  let previous = null;

  for (const minute of starts) {
    if (rangeStart === null) {
      rangeStart = minute;
      previous = minute;
      continue;
    }
    if (minute !== previous + slotMinutes) {
      intervals.push({
        startTime: minutesToTime(rangeStart),
        endTime: minutesToTime(previous + visitDurationMinutes),
        capacity,
      });
      rangeStart = minute;
    }
    previous = minute;
  }
  if (rangeStart !== null) {
    intervals.push({
      startTime: minutesToTime(rangeStart),
      endTime: minutesToTime(previous + visitDurationMinutes),
      capacity,
    });
  }
  return intervals;
}

function comparableIntervals(intervals = []) {
  return intervals.map((interval) => ({
    startTime: interval.startTime,
    endTime: interval.endTime,
    capacity:
      interval.capacity === undefined ? null : Number(interval.capacity),
  }));
}

function intervalsEqual(left, right) {
  return (
    JSON.stringify(comparableIntervals(left)) ===
    JSON.stringify(comparableIntervals(right))
  );
}

async function reconcileLegacyIntervalEnds(legacy, template) {
  if (!legacy || !template) return { weeklyDaysUpdated: 0, overridesUpdated: 0 };

  const capacity = Number(template.defaultCapacity ?? 1);
  const defaultHours = legacy.defaultHours || [];
  const defaultStep = inferLegacySlotMinutes(defaultHours, template.slotMinutes);
  const oldDefaultIntervals = hoursToIntervals(
    defaultHours,
    defaultStep,
    capacity,
    defaultStep
  );
  const desiredDefaultIntervals = hoursToIntervals(
    defaultHours,
    defaultStep,
    capacity,
    90
  );
  let weeklyDaysUpdated = 0;

  if (!intervalsEqual(oldDefaultIntervals, desiredDefaultIntervals)) {
    for (const day of template.weeklySchedule || []) {
      if (day.enabled && intervalsEqual(day.intervals, oldDefaultIntervals)) {
        day.intervals = desiredDefaultIntervals;
        weeklyDaysUpdated += 1;
      }
    }
    if (weeklyDaysUpdated) await template.save();
  }

  const legacyOverrides =
    legacy.overrides instanceof Map
      ? Object.fromEntries(legacy.overrides)
      : legacy.overrides || {};
  let overridesUpdated = 0;
  for (const [date, hours] of Object.entries(legacyOverrides)) {
    if (!dateValidator(date) || !Array.isArray(hours) || !hours.length) continue;
    const step = inferLegacySlotMinutes(hours, template.slotMinutes);
    const oldIntervals = hoursToIntervals(hours, step, null, step).map(
      ({ startTime, endTime }) => ({ startTime, endTime })
    );
    const desiredIntervals = hoursToIntervals(hours, step, null, 90).map(
      ({ startTime, endTime }) => ({ startTime, endTime })
    );
    if (intervalsEqual(oldIntervals, desiredIntervals)) continue;

    const result = await AvailabilityOverride.updateOne(
      {
        scopeType: "company",
        technicianId: null,
        date,
        mode: "custom_hours",
        reason: "Imported legacy calendar override",
        intervals: oldIntervals,
      },
      { $set: { intervals: desiredIntervals } }
    );
    overridesUpdated += result.modifiedCount || 0;
  }

  return { weeklyDaysUpdated, overridesUpdated };
}

async function ensureCompanyTemplate() {
  await CompanyAvailabilityTemplate.init();
  let template = await CompanyAvailabilityTemplate.findOne({ active: true });
  const legacy = await CalendarConfig.findOne().lean();

  if (!template) {
    const configuredSlotMinutes = Math.max(
      15,
      Number(legacy?.slotMinutes || 60)
    );
    const legacyOverrides =
      legacy?.overrides instanceof Map
        ? Object.fromEntries(legacy.overrides)
        : legacy?.overrides || {};
    const legacyHourSets = [
      legacy?.defaultHours || [],
      ...Object.values(legacyOverrides).filter(Array.isArray),
    ];
    const slotMinutes = legacyHourSets.reduce(
      (current, hours) => inferLegacySlotMinutes(hours, current),
      configuredSlotMinutes
    );
    const defaultCapacity = Math.max(
      0,
      Number(legacy?.maxConcurrent ?? 1)
    );
    const closedWeekdays = new Set(legacy?.closedWeekdays || [0]);
    const intervals = hoursToIntervals(
      legacy?.defaultHours || [],
      slotMinutes,
      defaultCapacity
    );

    try {
      template = await CompanyAvailabilityTemplate.create({
        name: "Company Schedule",
        timezone: legacy?.timezone || "America/New_York",
        slotMinutes,
        visitDurationMinutes: 90,
        minLeadMinutes:
          Math.max(0, Number(legacy?.minLeadDays ?? 2)) * 1440,
        maxAdvanceDays: 120,
        defaultCapacity,
        weeklySchedule: Array.from({ length: 7 }, (_, weekday) => ({
          weekday,
          enabled: !closedWeekdays.has(weekday),
          intervals: closedWeekdays.has(weekday) ? [] : intervals,
        })),
        active: true,
        version: 1,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      template = await CompanyAvailabilityTemplate.findOne({ active: true });
      if (!template) throw error;
    }
  }

  if (template.visitDurationMinutes !== 90) {
    template.visitDurationMinutes = 90;
    await template.save();
  }

  if (!template.legacyImportCompletedAt) {
    await importLegacyOverrides(legacy, template);
  }
  await reconcileLegacyIntervalEnds(legacy, template);
  return template;
}

async function importLegacyOverrides(legacy, template) {
  await AvailabilityOverride.init();
  if (!legacy) {
    template.legacyImportCompletedAt = new Date();
    await template.save();
    return { imported: 0, skipped: 0 };
  }

  const legacyOverrides =
    legacy.overrides instanceof Map
      ? Object.fromEntries(legacy.overrides)
      : legacy.overrides || {};
  const closedDates = new Set(legacy.holidays || []);
  const dates = new Set([...closedDates, ...Object.keys(legacyOverrides)]);
  let imported = 0;
  let skipped = 0;

  for (const date of dates) {
    if (!dateValidator(date)) {
      skipped += 1;
      continue;
    }
    const hours = Array.isArray(legacyOverrides[date])
      ? legacyOverrides[date]
      : null;
    let closed = closedDates.has(date) || (hours && hours.length === 0);
    const step = inferLegacySlotMinutes(hours || [], template.slotMinutes);
    const intervals = closed
      ? []
      : hoursToIntervals(
          hours || [],
          step,
          template.defaultCapacity
        ).map(({ startTime, endTime }) => ({ startTime, endTime }));
    if (!intervals.length) closed = true;

    try {
      await AvailabilityOverride.updateOne(
        { scopeType: "company", technicianId: null, date },
        {
          $setOnInsert: {
            scopeType: "company",
            technicianId: null,
            date,
            mode: closed ? "closed" : "custom_hours",
            intervals,
            reason: closedDates.has(date)
              ? "Imported legacy holiday"
              : "Imported legacy calendar override",
          },
        },
        { upsert: true }
      );
      imported += 1;
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }

  template.legacyImportCompletedAt = new Date();
  await template.save();
  return { imported, skipped };
}

async function ensureTechnicianTemplate(technicianId) {
  if (!technicianId) return null;
  await TechnicianAvailabilityTemplate.init();
  try {
    return await TechnicianAvailabilityTemplate.findOneAndUpdate(
      { technicianId, active: true },
      {
        $setOnInsert: {
          technicianId,
          inheritCompanyHours: true,
          weeklySchedule: [],
          active: true,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await TechnicianAvailabilityTemplate.findOne({
      technicianId,
      active: true,
    });
    if (!existing) throw error;
    return existing;
  }
}

async function activeTechnicians() {
  return User.find({
    role: "employee",
    isActive: { $ne: false },
    employeePosition: { $in: ["Fixter", "General Fixter"] },
  })
    .select("_id name email")
    .lean();
}

async function ensureActiveTechnicianTemplates() {
  const technicians = await activeTechnicians();
  const results = await Promise.allSettled(
    technicians.map((technician) =>
      ensureTechnicianTemplate(technician._id)
    )
  );
  return {
    technicianCount: technicians.length,
    createdOrReady: results.filter((result) => result.status === "fulfilled")
      .length,
    errors: results
      .map((result, index) =>
        result.status === "rejected"
          ? `${technicians[index].email}: ${result.reason?.message || "template provisioning failed"}`
          : null
      )
      .filter(Boolean),
  };
}

async function getFoundationStatus() {
  const [companyTemplate, technicians, templates] = await Promise.all([
    CompanyAvailabilityTemplate.findOne({ active: true }).lean(),
    activeTechnicians(),
    TechnicianAvailabilityTemplate.find({ active: true })
      .select("technicianId")
      .lean(),
  ]);
  const templateIds = new Set(
    templates.map((template) => String(template.technicianId))
  );
  const missingTechnicians = technicians
    .filter((technician) => !templateIds.has(String(technician._id)))
    .map((technician) => ({
      id: String(technician._id),
      name: technician.name,
      email: technician.email,
    }));
  const warnings = [];
  const errors = [];

  if (!companyTemplate) errors.push("Active company availability template is missing");
  if (companyTemplate && !companyTemplate.legacyImportCompletedAt) {
    warnings.push("Legacy holidays and overrides have not been imported");
  }
  if (missingTechnicians.length) {
    warnings.push(
      `${missingTechnicians.length} active technician template(s) are missing`
    );
  }

  return {
    companyTemplateReady: !!companyTemplate,
    technicianTemplatesReady: missingTechnicians.length === 0,
    importedLegacyOverridesReady:
      !!companyTemplate?.legacyImportCompletedAt,
    activeTechnicianCount: technicians.length,
    activeTechnicianTemplateCount:
      technicians.length - missingTechnicians.length,
    missingTechnicians,
    warnings,
    errors,
  };
}

async function bootstrapAvailabilityFoundation() {
  const errors = [];
  const warnings = [];
  let companyTemplate = null;

  try {
    companyTemplate = await ensureCompanyTemplate();
  } catch (error) {
    errors.push(`Company template: ${error.message}`);
  }

  const technicianResult = await ensureActiveTechnicianTemplates();
  errors.push(...technicianResult.errors);
  const status = await getFoundationStatus();
  warnings.push(...status.warnings);
  errors.push(...status.errors.filter((message) => !errors.includes(message)));

  return {
    ok:
      status.companyTemplateReady &&
      status.technicianTemplatesReady &&
      status.importedLegacyOverridesReady &&
      errors.length === 0,
    companyTemplateId: companyTemplate
      ? String(companyTemplate._id)
      : null,
    technicianTemplatesProcessed: technicianResult.createdOrReady,
    ...status,
    warnings: Array.from(new Set(warnings)),
    errors: Array.from(new Set(errors)),
  };
}

module.exports = {
  bootstrapAvailabilityFoundation,
  ensureActiveTechnicianTemplates,
  ensureCompanyTemplate,
  ensureTechnicianTemplate,
  getFoundationStatus,
  hoursToIntervals,
  inferLegacySlotMinutes,
  reconcileLegacyIntervalEnds,
};
