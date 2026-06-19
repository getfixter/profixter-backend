const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const User = require("../models/User");
const Project = require("../models/Project");
const Estimate = require("../models/Estimate");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");

const router = express.Router();
const ADMIN_EMAIL = String(process.env.MAIL_ADMIN || "getfixter@gmail.com").toLowerCase();
const ESTIMATE_STATUSES = Estimate.ESTIMATE_STATUSES;

async function onlyAdmin(req, res, next) {
  try {
    const user = await User.findById(req.user.id).select("email").lean();
    if (!user || String(user.email || "").toLowerCase() !== ADMIN_EMAIL) {
      return res.status(403).json({ message: "Access denied. Admins only." });
    }
    return next();
  } catch (error) {
    console.error("Estimate admin authorization failed:", error);
    return res.status(500).json({ message: "Server error" });
  }
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseNonNegativeNumber(value, field, errors) {
  if (value === "" || value === null || value === undefined) return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    errors.push(`${field} must be a non-negative number`);
    return 0;
  }
  return roundMoney(number);
}

function parseExpirationDate(value, errors) {
  if (value === "" || value === null || value === undefined) return null;
  const normalized = cleanString(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? new Date(`${normalized}T12:00:00.000Z`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) {
    errors.push("Expiration date is invalid");
    return null;
  }
  return date;
}

function validateEstimateInput(body) {
  body = body && typeof body === "object" ? body : {};
  const errors = [];
  const projectId = cleanString(body.projectId);
  const status = cleanString(body.status) || "Draft";
  const title = cleanString(body.title);
  const description = cleanString(body.description);
  const notes = cleanString(body.notes);
  const tax = parseNonNegativeNumber(body.tax, "tax", errors);
  const discount = parseNonNegativeNumber(body.discount, "discount", errors);
  const expirationDate = parseExpirationDate(body.expirationDate, errors);

  if (!mongoose.isValidObjectId(projectId)) errors.push("Valid projectId is required");
  if (!ESTIMATE_STATUSES.includes(status)) errors.push("Invalid estimate status");
  if (!title) errors.push("Title is required");
  if (title.length > 200) errors.push("Title cannot exceed 200 characters");
  if (description.length > 5000) errors.push("Description cannot exceed 5000 characters");
  if (notes.length > 10000) errors.push("Notes cannot exceed 10000 characters");

  const sourceItems = Array.isArray(body.lineItems) ? body.lineItems : [];
  if (sourceItems.length === 0) errors.push("At least one line item is required");
  if (sourceItems.length > 200) errors.push("An estimate cannot exceed 200 line items");

  const lineItems = sourceItems.slice(0, 200).map((item, index) => {
    const itemDescription = cleanString(item?.description);
    const quantity = parseNonNegativeNumber(
      item?.quantity,
      `lineItems[${index}].quantity`,
      errors
    );
    const unitPrice = parseNonNegativeNumber(
      item?.unitPrice,
      `lineItems[${index}].unitPrice`,
      errors
    );

    if (!itemDescription) {
      errors.push(`lineItems[${index}].description is required`);
    }
    if (itemDescription.length > 500) {
      errors.push(`lineItems[${index}].description cannot exceed 500 characters`);
    }

    return {
      description: itemDescription,
      quantity,
      unitPrice,
      total: roundMoney(quantity * unitPrice),
    };
  });

  const subtotal = roundMoney(
    lineItems.reduce((sum, item) => sum + item.total, 0)
  );
  if (discount > roundMoney(subtotal + tax)) {
    errors.push("Discount cannot exceed subtotal plus tax");
  }
  const total = roundMoney(subtotal + tax - discount);

  return {
    errors,
    estimate: {
      projectId,
      status,
      title,
      description,
      lineItems,
      subtotal,
      tax,
      discount,
      total,
      notes,
      expirationDate,
    },
  };
}

function handleWriteError(error, res, fallbackMessage) {
  console.error(fallbackMessage, error);
  if (error?.name === "ValidationError") {
    return res.status(400).json({ message: error.message });
  }
  if (error?.code === 11000) {
    return res.status(409).json({ message: "Estimate number already exists" });
  }
  return res.status(500).json({ message: fallbackMessage });
}

router.use(auth, ...requirePermission(PERMISSIONS.ADMIN));

router.get("/", async (req, res) => {
  try {
    const query = {};
    const projectId = cleanString(req.query.projectId);
    const status = cleanString(req.query.status);

    if (projectId) {
      if (!mongoose.isValidObjectId(projectId)) {
        return res.status(400).json({ message: "Invalid project ID" });
      }
      query.projectId = projectId;
    }
    if (status) {
      if (!ESTIMATE_STATUSES.includes(status)) {
        return res.status(400).json({ message: "Invalid estimate status" });
      }
      query.status = status;
    }

    const estimates = await Estimate.find(query)
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ estimates });
  } catch (error) {
    console.error("GET /admin/estimates failed:", error);
    return res.status(500).json({ message: "Failed to load estimates" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid estimate ID" });
    }
    const estimate = await Estimate.findById(req.params.id).lean();
    if (!estimate) return res.status(404).json({ message: "Estimate not found" });
    return res.json({ estimate });
  } catch (error) {
    console.error("GET /admin/estimates/:id failed:", error);
    return res.status(500).json({ message: "Failed to load estimate" });
  }
});

router.post("/", async (req, res) => {
  try {
    const { errors, estimate: input } = validateEstimateInput(req.body);
    if (errors.length) return res.status(400).json({ message: errors[0], errors });

    const projectExists = await Project.exists({ _id: input.projectId });
    if (!projectExists) return res.status(404).json({ message: "Project not found" });

    const estimate = await Estimate.create({
      ...input,
      createdBy: req.user.id,
    });
    return res.status(201).json({ estimate });
  } catch (error) {
    return handleWriteError(error, res, "Failed to create estimate");
  }
});

router.put("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid estimate ID" });
    }

    const existing = await Estimate.findById(req.params.id).lean();
    if (!existing) return res.status(404).json({ message: "Estimate not found" });

    const requestBody =
      req.body && typeof req.body === "object" ? req.body : {};
    if (
      Object.prototype.hasOwnProperty.call(requestBody, "projectId") &&
      String(requestBody.projectId) !== String(existing.projectId)
    ) {
      return res.status(400).json({
        message: "projectId cannot be changed after estimate creation",
      });
    }
    const hasExpirationDate = Object.prototype.hasOwnProperty.call(
      requestBody,
      "expirationDate"
    );
    const merged = {
      projectId: existing.projectId,
      status: requestBody.status ?? existing.status,
      title: requestBody.title ?? existing.title,
      description: requestBody.description ?? existing.description,
      lineItems: requestBody.lineItems ?? existing.lineItems,
      tax: requestBody.tax ?? existing.tax,
      discount: requestBody.discount ?? existing.discount,
      notes: requestBody.notes ?? existing.notes,
      expirationDate: hasExpirationDate
        ? requestBody.expirationDate
        : existing.expirationDate,
    };
    const { errors, estimate: input } = validateEstimateInput(merged);
    if (errors.length) return res.status(400).json({ message: errors[0], errors });

    const projectExists = await Project.exists({ _id: input.projectId });
    if (!projectExists) return res.status(404).json({ message: "Project not found" });

    const estimate = await Estimate.findByIdAndUpdate(
      req.params.id,
      { $set: input },
      { new: true, runValidators: true }
    );
    return res.json({ estimate });
  } catch (error) {
    return handleWriteError(error, res, "Failed to update estimate");
  }
});

router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid estimate ID" });
    }
    const estimate = await Estimate.findByIdAndDelete(req.params.id);
    if (!estimate) return res.status(404).json({ message: "Estimate not found" });
    return res.json({ message: "Estimate deleted" });
  } catch (error) {
    console.error("DELETE /admin/estimates/:id failed:", error);
    return res.status(500).json({ message: "Failed to delete estimate" });
  }
});

module.exports = router;
