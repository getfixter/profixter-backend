const FullDayVisitSettings = require("../models/FullDayVisitSettings");

/**
 * The single source of truth for the Full Day product.
 *
 * Mirrors utils/oneTimeVisitSettings: a database singleton whose defaults come
 * from the environment. Nothing in the booking or payment code knows the price
 * or the Stripe identifier; it asks here.
 */

/*
 * The live Stripe Price for the "Full day Fixter" $499.00 product.
 *
 * Held as a default rather than a hardcoded constant so it can be corrected
 * from the environment, or from the settings record, without a code change.
 * That matters because it was supplied by hand: nothing in this repository can
 * verify it against Stripe, so the environment override is the escape hatch if
 * it turns out to be wrong.
 */
const FALLBACK_FULL_DAY_PRICE_ID = "price_1TwpIBBw0RtvSZjMFt9joupF";

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function boundedNumber(value, fallback, min = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, number);
}

function defaultSettings() {
  return {
    enabled:
      String(process.env.FULL_DAY_VISIT_ENABLED || "true").toLowerCase() !==
      "false",
    priceCents: Math.max(0, envNumber("FULL_DAY_VISIT_PRICE_CENTS", 49900)),
    currency: "usd",
    approximateHours: Math.max(
      1,
      envNumber("FULL_DAY_VISIT_APPROX_HOURS", 8)
    ),
    stripePriceId:
      process.env.STRIPE_PRICE_FULL_DAY_VISIT || FALLBACK_FULL_DAY_PRICE_ID,
    holdMinutes: Math.max(30, envNumber("FULL_DAY_VISIT_HOLD_MINUTES", 30)),
    cancellationPhone:
      process.env.FULL_DAY_VISIT_CANCELLATION_PHONE || "631-599-1363",
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
    approximateHours: boundedNumber(
      record.approximateHours,
      defaults.approximateHours,
      1
    ),
    stripePriceId: record.stripePriceId || defaults.stripePriceId,
    holdMinutes: boundedNumber(record.holdMinutes, defaults.holdMinutes, 30),
    cancellationPhone: record.cancellationPhone || defaults.cancellationPhone,
  };
}

async function getFullDayVisitSettings() {
  const record = await FullDayVisitSettings.findOne({ key: "default" }).lean();
  return normalizeSettings(record);
}

async function upsertFullDayVisitSettings(patch) {
  const record = await FullDayVisitSettings.findOneAndUpdate(
    { key: "default" },
    { $set: { ...patch, key: "default" } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  return normalizeSettings(record);
}

/** What the customer frontend is allowed to see. No Stripe identifiers. */
function publicFullDayVisitSettings(settings) {
  return {
    enabled: settings.enabled,
    priceCents: settings.priceCents,
    currency: settings.currency,
    approximateHours: settings.approximateHours,
    holdMinutes: settings.holdMinutes,
    cancellationPhone: settings.cancellationPhone,
  };
}

module.exports = {
  FALLBACK_FULL_DAY_PRICE_ID,
  defaultSettings,
  normalizeSettings,
  getFullDayVisitSettings,
  upsertFullDayVisitSettings,
  publicFullDayVisitSettings,
};
