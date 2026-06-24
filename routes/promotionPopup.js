const express = require("express");
const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const PromotionPopup = require("../models/PromotionPopup");
const { createAdminActivityLog } = require("../utils/adminActivityLog");

const router = express.Router();
const onlyAdmin = requirePermission(PERMISSIONS.ADMIN);
const DEFAULTS = {
  singletonKey: "active",
  enabled: false,
  eyebrow: "Profixter update",
  title: "",
  message: "",
  promoCode: "",
  ctaText: "",
  ctaUrl: "",
  secondaryText: "",
  secondaryUrl: "",
  startAt: null,
  endAt: null,
  target: "homepage",
  internalNote: "",
};

function clean(value) {
  return String(value || "").trim();
}

function validActionUrl(value) {
  if (!value) return true;
  if (/^\/(?!\/)/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseDate(value, fieldName) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const error = new Error(`${fieldName} must be a valid date`);
    error.statusCode = 400;
    throw error;
  }
  return date;
}

function validateInput(body = {}) {
  const input = {
    enabled: body.enabled === true,
    eyebrow: clean(body.eyebrow),
    title: clean(body.title),
    message: clean(body.message),
    promoCode: clean(body.promoCode).toUpperCase(),
    ctaText: clean(body.ctaText),
    ctaUrl: clean(body.ctaUrl),
    secondaryText: clean(body.secondaryText),
    secondaryUrl: clean(body.secondaryUrl),
    startAt: parseDate(body.startAt, "Start date"),
    endAt: parseDate(body.endAt, "End date"),
    target: clean(body.target) || "homepage",
    internalNote: clean(body.internalNote),
  };

  if (!["homepage", "all_public"].includes(input.target)) {
    const error = new Error("Invalid popup target");
    error.statusCode = 400;
    throw error;
  }
  if (input.enabled && !input.title) {
    const error = new Error("Title is required when the popup is enabled");
    error.statusCode = 400;
    throw error;
  }
  if (input.enabled && !input.message) {
    const error = new Error("Message is required when the popup is enabled");
    error.statusCode = 400;
    throw error;
  }
  if (input.enabled && (!input.ctaText || !input.ctaUrl)) {
    const error = new Error(
      "CTA text and CTA URL are required when the popup is enabled"
    );
    error.statusCode = 400;
    throw error;
  }
  if (!validActionUrl(input.ctaUrl)) {
    const error = new Error("CTA URL must be an internal path or valid HTTPS URL");
    error.statusCode = 400;
    throw error;
  }
  if (input.secondaryUrl && !input.secondaryText) {
    const error = new Error("Secondary button text is required when a URL is set");
    error.statusCode = 400;
    throw error;
  }
  if (input.secondaryText && !input.secondaryUrl) {
    const error = new Error("Secondary button URL is required when text is set");
    error.statusCode = 400;
    throw error;
  }
  if (!validActionUrl(input.secondaryUrl)) {
    const error = new Error(
      "Secondary URL must be an internal path or valid HTTPS URL"
    );
    error.statusCode = 400;
    throw error;
  }
  if (
    input.startAt &&
    input.endAt &&
    input.endAt.getTime() <= input.startAt.getTime()
  ) {
    const error = new Error("End date must be after start date");
    error.statusCode = 400;
    throw error;
  }

  return input;
}

async function getPopup() {
  return PromotionPopup.findOneAndUpdate(
    { singletonKey: "active" },
    { $setOnInsert: DEFAULTS },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
}

router.get(
  "/admin/promotion-popup",
  auth,
  ...onlyAdmin,
  async (_req, res) => {
    try {
      return res.json({ popup: await getPopup() });
    } catch (error) {
      console.error("Load promotion popup failed:", error);
      return res.status(500).json({ message: "Failed to load promotion popup" });
    }
  }
);

router.put(
  "/admin/promotion-popup",
  auth,
  ...onlyAdmin,
  async (req, res) => {
    try {
      const input = validateInput(req.body);
      const popup = await PromotionPopup.findOneAndUpdate(
        { singletonKey: "active" },
        {
          $set: {
            ...input,
            updatedBy: req.authUser?._id || req.user?.id || null,
          },
          $setOnInsert: { singletonKey: "active" },
        },
        { new: true, upsert: true, runValidators: true }
      );
      await createAdminActivityLog(req, {
        action: "Promotion Popup Updated",
        entityType: "PromotionPopup",
        entityId: popup._id,
        entityName: popup.title || "Promotion Popup",
        details: {
          enabled: popup.enabled,
          title: popup.title,
          target: popup.target,
          startAt: popup.startAt,
          endAt: popup.endAt,
        },
      });
      return res.json({ popup });
    } catch (error) {
      return res
        .status(error.statusCode || 500)
        .json({ message: error.message || "Failed to save promotion popup" });
    }
  }
);

router.get("/promotion-popup/active", async (_req, res) => {
  try {
    const now = new Date();
    const popup = await PromotionPopup.findOne({
      singletonKey: "active",
      enabled: true,
      $and: [
        {
          $or: [
            { startAt: null },
            { startAt: { $exists: false } },
            { startAt: { $lte: now } },
          ],
        },
        {
          $or: [
            { endAt: null },
            { endAt: { $exists: false } },
            { endAt: { $gte: now } },
          ],
        },
      ],
    })
      .select(
        "-_id eyebrow title message promoCode ctaText ctaUrl secondaryText secondaryUrl target"
      )
      .lean();

    return res.json({ popup: popup || null });
  } catch (error) {
    console.error("Load active promotion popup failed:", error);
    return res.status(500).json({ message: "Failed to load active promotion" });
  }
});

module.exports = router;
module.exports.validActionUrl = validActionUrl;
module.exports.validateInput = validateInput;
