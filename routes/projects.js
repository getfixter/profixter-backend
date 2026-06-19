const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const User = require("../models/User");
const Project = require("../models/Project");
const Estimate = require("../models/Estimate");

const router = express.Router();
const ADMIN_EMAIL = String(process.env.MAIL_ADMIN || "getfixter@gmail.com").toLowerCase();
const PROJECT_TYPES = Project.PROJECT_TYPES;
const PROJECT_STATUSES = Project.PROJECT_STATUSES;

async function onlyAdmin(req, res, next) {
  try {
    const user = await User.findById(req.user.id).select("email").lean();
    if (!user || String(user.email || "").toLowerCase() !== ADMIN_EMAIL) {
      return res.status(403).json({ message: "Access denied. Admins only." });
    }
    return next();
  } catch (error) {
    console.error("Project admin authorization failed:", error);
    return res.status(500).json({ message: "Server error" });
  }
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function parseAmount(value, field, errors) {
  if (value === "" || value === null || value === undefined) return 0;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    errors.push(`${field} must be a non-negative number`);
    return 0;
  }
  return Math.round(amount * 100) / 100;
}

function validateProjectInput(body, { partial = false } = {}) {
  const errors = [];
  const update = {};

  const stringFields = ["customerName", "phone", "email", "address", "notes"];
  for (const field of stringFields) {
    if (!partial || body[field] !== undefined) update[field] = cleanString(body[field]);
  }

  if (!partial || body.status !== undefined) {
    update.status = cleanString(body.status) || "Lead";
    if (!PROJECT_STATUSES.includes(update.status)) errors.push("Invalid project status");
  }

  if (!partial || body.projectType !== undefined) {
    update.projectType = cleanString(body.projectType);
    if (!PROJECT_TYPES.includes(update.projectType)) errors.push("Invalid project type");
  }

  if (!partial || body.estimateAmount !== undefined) {
    update.estimateAmount = parseAmount(body.estimateAmount, "estimateAmount", errors);
  }
  if (!partial || body.depositAmount !== undefined) {
    update.depositAmount = parseAmount(body.depositAmount, "depositAmount", errors);
  }
  if (!partial || body.balanceDue !== undefined) {
    update.balanceDue = parseAmount(body.balanceDue, "balanceDue", errors);
  }

  if (!partial || body.customerName !== undefined) {
    if (!update.customerName) errors.push("Customer name is required");
  }
  if (!partial || body.address !== undefined) {
    if (!update.address) errors.push("Address is required");
  }

  if (update.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(update.email)) {
    errors.push("Email is invalid");
  }

  return { errors, update };
}

router.use(auth, onlyAdmin);

router.get("/meta", (_req, res) => {
  return res.json({ projectTypes: PROJECT_TYPES, statuses: PROJECT_STATUSES });
});

router.get("/", async (req, res) => {
  try {
    const query = {};
    const status = cleanString(req.query.status);
    const projectType = cleanString(req.query.projectType);
    const customer = cleanString(req.query.customer);

    if (status) {
      if (!PROJECT_STATUSES.includes(status)) {
        return res.status(400).json({ message: "Invalid project status" });
      }
      query.status = status;
    }
    if (projectType) {
      if (!PROJECT_TYPES.includes(projectType)) {
        return res.status(400).json({ message: "Invalid project type" });
      }
      query.projectType = projectType;
    }
    if (customer) {
      query.customerName = { $regex: customer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    }

    const projects = await Project.find(query).sort({ createdAt: -1 }).lean();
    return res.json({ projects });
  } catch (error) {
    console.error("GET /admin/projects failed:", error);
    return res.status(500).json({ message: "Failed to load projects" });
  }
});

router.get("/:projectId/estimates", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.projectId)) {
      return res.status(400).json({ message: "Invalid project ID" });
    }
    const projectExists = await Project.exists({ _id: req.params.projectId });
    if (!projectExists) return res.status(404).json({ message: "Project not found" });

    const estimates = await Estimate.find({ projectId: req.params.projectId })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ estimates });
  } catch (error) {
    console.error("GET /admin/projects/:projectId/estimates failed:", error);
    return res.status(500).json({ message: "Failed to load project estimates" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid project ID" });
    }
    const project = await Project.findById(req.params.id).lean();
    if (!project) return res.status(404).json({ message: "Project not found" });
    return res.json({ project });
  } catch (error) {
    console.error("GET /admin/projects/:id failed:", error);
    return res.status(500).json({ message: "Failed to load project" });
  }
});

router.post("/", async (req, res) => {
  try {
    const { errors, update } = validateProjectInput(req.body);
    if (errors.length) return res.status(400).json({ message: errors[0], errors });

    const project = await Project.create(update);
    return res.status(201).json({ project });
  } catch (error) {
    console.error("POST /admin/projects failed:", error);
    if (error?.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }
    return res.status(500).json({ message: "Failed to create project" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid project ID" });
    }

    const { errors, update } = validateProjectInput(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ message: errors[0], errors });
    delete update.projectNumber;

    const project = await Project.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true }
    );
    if (!project) return res.status(404).json({ message: "Project not found" });
    return res.json({ project });
  } catch (error) {
    console.error("PUT /admin/projects/:id failed:", error);
    if (error?.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }
    return res.status(500).json({ message: "Failed to update project" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid project ID" });
    }
    const hasEstimates = await Estimate.exists({ projectId: req.params.id });
    if (hasEstimates) {
      return res.status(409).json({
        message: "Delete this project's estimates before deleting the project",
      });
    }
    const project = await Project.findByIdAndDelete(req.params.id);
    if (!project) return res.status(404).json({ message: "Project not found" });
    return res.json({ message: "Project deleted" });
  } catch (error) {
    console.error("DELETE /admin/projects/:id failed:", error);
    return res.status(500).json({ message: "Failed to delete project" });
  }
});

module.exports = router;
