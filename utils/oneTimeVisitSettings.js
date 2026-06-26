const OneTimeVisitSettings = require("../models/OneTimeVisitSettings");

const DEFAULT_ALLOWED_SERVICES = [
  "Replace faucet",
  "Replace light fixture",
  "Install ceiling fan",
  "Hang TV",
  "Install shelves",
  "Door adjustment",
  "Lock replacement",
  "Caulking",
  "Minor drywall repair",
  "Curtain rods",
  "Cabinet hardware",
  "Toilet repair",
  "Garbage disposal replacement",
  "Smoke detector installation",
];

const DEFAULT_EXCLUDED_SERVICES = [
  "Appliance repair",
  "Painting entire rooms",
  "Full renovations",
  "Roofing",
  "Large electrical work",
  "Plumbing remodels",
  "Multi-day projects",
  "Large projects",
];

const EXCLUDED_PATTERNS = [
  /appliance/i,
  /paint(ing)?\s+(entire|whole|room|rooms)/i,
  /renovation|remodel/i,
  /roof/i,
  /large\s+electrical|panel|rewire/i,
  /plumbing\s+remodel/i,
  /multi[-\s]?day/i,
  /large\s+project/i,
];

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function envList(name, fallback) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const items = raw
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

function cleanList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const items = value.map((item) => String(item || "").trim()).filter(Boolean);
  return items.length ? items : fallback;
}

function boundedNumber(value, fallback, min = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, number);
}

function defaultSettings() {
  return {
    enabled:
      String(process.env.ONE_TIME_VISIT_ENABLED || "true").toLowerCase() !==
      "false",
    priceCents: Math.max(
      0,
      envNumber("ONE_TIME_VISIT_PRICE_CENTS", 9900)
    ),
    currency: "usd",
    durationMinutes: Math.max(
      1,
      envNumber("ONE_TIME_VISIT_DURATION_MINUTES", 90)
    ),
    stripePriceId: process.env.STRIPE_PRICE_ONE_TIME_HANDYMAN_VISIT || "",
    holdMinutes: Math.max(
      30,
      envNumber("ONE_TIME_VISIT_HOLD_MINUTES", 30)
    ),
    cancellationPhone:
      process.env.ONE_TIME_VISIT_CANCELLATION_PHONE || "631-599-1363",
    allowedServices: envList(
      "ONE_TIME_VISIT_ALLOWED_SERVICES",
      DEFAULT_ALLOWED_SERVICES
    ),
    excludedServices: envList(
      "ONE_TIME_VISIT_EXCLUDED_SERVICES",
      DEFAULT_EXCLUDED_SERVICES
    ),
    promoNote: process.env.ONE_TIME_VISIT_PROMO_NOTE || "",
  };
}

function normalizeSettings(record = null) {
  const defaults = defaultSettings();
  if (!record) return defaults;

  return {
    enabled:
      typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    priceCents: boundedNumber(record.priceCents, defaults.priceCents, 0),
    currency: String(record.currency || defaults.currency).toLowerCase(),
    durationMinutes: boundedNumber(
      record.durationMinutes,
      defaults.durationMinutes,
      1
    ),
    stripePriceId: String(record.stripePriceId || defaults.stripePriceId || ""),
    holdMinutes: boundedNumber(record.holdMinutes, defaults.holdMinutes, 30),
    cancellationPhone: String(
      record.cancellationPhone || defaults.cancellationPhone
    ),
    allowedServices: cleanList(record.allowedServices, defaults.allowedServices),
    excludedServices: cleanList(
      record.excludedServices,
      defaults.excludedServices
    ),
    promoNote: String(record.promoNote || defaults.promoNote || ""),
  };
}

async function getOneTimeVisitSettings() {
  const record = await OneTimeVisitSettings.findOne({ key: "default" }).lean();
  return normalizeSettings(record);
}

async function upsertOneTimeVisitSettings(patch) {
  const current = await OneTimeVisitSettings.findOne({ key: "default" }).lean();
  const merged = normalizeSettings({ ...normalizeSettings(current), ...patch });
  const record = await OneTimeVisitSettings.findOneAndUpdate(
    { key: "default" },
    { $set: { ...merged, key: "default" } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  return normalizeSettings(record);
}

function validateOneTimeTask(settings, task, note = "") {
  const selectedTask = String(task || "").trim();
  const allowed = new Set(settings.allowedServices || []);

  if (!allowed.has(selectedTask)) {
    return {
      ok: false,
      message:
        "That task is outside the One-Time Handyman Visit scope. Please request a Project Estimate for larger or excluded work.",
      code: "ONE_TIME_TASK_NOT_ALLOWED",
    };
  }

  const combined = `${selectedTask} ${note || ""}`;
  if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(combined))) {
    return {
      ok: false,
      message:
        "That looks like a larger or excluded project. Please request a Project Estimate instead.",
      code: "ONE_TIME_TASK_EXCLUDED",
    };
  }

  return { ok: true, selectedTask };
}

function publicOneTimeVisitSettings(settings) {
  return {
    enabled: settings.enabled,
    priceCents: settings.priceCents,
    currency: settings.currency,
    durationMinutes: settings.durationMinutes,
    holdMinutes: settings.holdMinutes,
    cancellationPhone: settings.cancellationPhone,
    allowedServices: settings.allowedServices,
    excludedServices: settings.excludedServices,
    promoNote: settings.promoNote,
  };
}

module.exports = {
  DEFAULT_ALLOWED_SERVICES,
  DEFAULT_EXCLUDED_SERVICES,
  getOneTimeVisitSettings,
  normalizeSettings,
  publicOneTimeVisitSettings,
  upsertOneTimeVisitSettings,
  validateOneTimeTask,
};
