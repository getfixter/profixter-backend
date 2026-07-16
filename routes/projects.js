const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const User = require("../models/User");
const Project = require("../models/Project");
const Estimate = require("../models/Estimate");
const Contract = require("../models/Contract");
const Blacklist = require("../models/Blacklist");
const Subscription = require("../models/Subscription");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const {
  createAdminActivityLog,
  markAdminActivityLog,
} = require("../utils/adminActivityLog");
const {
  buildCustomerFallbackSearchQuery,
  buildCustomerSearchQuery,
  buildUserSearchFields,
  buildCustomerSnapshot,
  buildPropertySnapshot,
  cleanString,
  isProjectSelectableCustomer,
  isSearchFieldsCurrent,
  normalizeCursor,
  normalizeLimit,
  normalizeOptionalObjectId,
  projectSelectableCustomerEligibilityQuery,
  scoreProjectCustomerSearchMatch,
  serializeCustomerForProjectSelector,
} = require("../utils/projectCustomerSelection");

const router = express.Router();
const ADMIN_EMAIL = String(process.env.MAIL_ADMIN || "getfixter@gmail.com").toLowerCase();
const PROJECT_TYPES = Project.PROJECT_TYPES;
const PROJECT_STATUSES = Project.PROJECT_STATUSES;

function activeProjectFilter(filter = {}) {
  return { ...filter, isDeleted: { $ne: true } };
}

function isDeletedProject(project) {
  return project?.isDeleted === true;
}

function sendDeletedProjectResponse(res, project) {
  return res.status(410).json({
    message: "Project has been deleted and is available only through an authorized recovery or audit path.",
    isDeleted: true,
    deletedAt: project.deletedAt || null,
  });
}

async function projectDeletionSummary(projectId) {
  const [estimateCount, contracts] = await Promise.all([
    Estimate.countDocuments({ projectId }),
    Contract.find({ projectId })
      .select("_id status generatedPdf signedPdf")
      .lean(),
  ]);

  const generatedPdfCount = contracts.filter((contract) => !!contract.generatedPdf?.key).length;
  const signedPdfCount = contracts.filter((contract) => !!contract.signedPdf?.key).length;
  const contractCount = contracts.length;
  const storedDocumentCount = generatedPdfCount + signedPdfCount;
  const hasRelatedRecords = contractCount > 0 || estimateCount > 0 || storedDocumentCount > 0;

  return {
    contractCount,
    estimateCount,
    generatedPdfCount,
    signedPdfCount,
    storedDocumentCount,
    hasRelatedRecords,
    requiresDeleteConfirmation: hasRelatedRecords,
  };
}

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

  const bodyCustomerSnapshot = buildCustomerSnapshot({
    ...(body.customerSnapshot || {}),
    customerName: body.customerSnapshot?.fullName ?? body.customerName,
    email: body.customerSnapshot?.email ?? body.email,
    phone: body.customerSnapshot?.phone ?? body.phone,
  });
  const bodyPropertySnapshot = buildPropertySnapshot({
    ...(body.propertySnapshot || {}),
    address: body.propertySnapshot?.formattedAddress ?? body.address,
  });
  const flatCustomerName = body.customerName ?? bodyCustomerSnapshot.fullName;
  const flatEmail = body.email ?? bodyCustomerSnapshot.email;
  const flatPhone = body.phone ?? bodyCustomerSnapshot.phone;
  const flatAddress = body.address ?? bodyPropertySnapshot.formattedAddress;

  const stringFields = ["customerName", "phone", "email", "address", "notes"];
  for (const field of stringFields) {
    const shouldSetFromSnapshot =
      (field === "customerName" || field === "phone" || field === "email")
        ? !!body.customerSnapshot
        : field === "address"
          ? !!body.propertySnapshot
          : false;
    if (!partial || body[field] !== undefined || shouldSetFromSnapshot) {
      const source = {
        customerName: flatCustomerName,
        phone: flatPhone,
        email: flatEmail,
        address: flatAddress,
        notes: body.notes,
      };
      update[field] = cleanString(source[field], field === "notes" ? 10000 : 500);
    }
  }

  if (!partial || body.customerId !== undefined) {
    update.customerId = normalizeOptionalObjectId(body.customerId, "customerId", errors);
    if (!update.customerId) update.addressId = null;
  }
  if (!partial || body.addressId !== undefined) {
    update.addressId = normalizeOptionalObjectId(body.addressId, "addressId", errors);
  }

  if (!partial || body.customerSnapshot !== undefined || update.customerName !== undefined) {
    update.customerSnapshot = buildCustomerSnapshot({
      fullName: update.customerName ?? bodyCustomerSnapshot.fullName,
      email: update.email ?? bodyCustomerSnapshot.email,
      phone: update.phone ?? bodyCustomerSnapshot.phone,
    });
  }

  if (!partial || body.propertySnapshot !== undefined || update.address !== undefined) {
    update.propertySnapshot = buildPropertySnapshot({
      ...bodyPropertySnapshot,
      formattedAddress: update.address ?? bodyPropertySnapshot.formattedAddress,
    });
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

async function findSubscriptionsForUser(userId) {
  return Subscription.find({ user: userId })
    .select(
      "_id user addressId subscriptionType status accessStatus cancelAtPeriodEnd cancellationDate currentPeriodEnd nextPaymentDate createdAt updatedAt"
    )
    .sort({ currentPeriodEnd: -1, nextPaymentDate: -1, createdAt: -1, updatedAt: -1 })
    .lean();
}

async function validateProjectCustomerLink(update, errors) {
  if (!update.customerId) {
    if (update.customerId === null) update.addressId = null;
    return null;
  }

  const user = await User.findById(update.customerId)
    .select("userId name firstName lastName email phone role employeePosition isActive address city state zip county addresses defaultAddressId status isDeleted deleted deletedAt accountDeleted accountDeletedAt removedAt isBlocked blocked")
    .lean();

  if (!user || !isProjectSelectableCustomer(user) || (await isProjectCustomerBlocked(user))) {
    errors.push("Selected customer was not found");
    return null;
  }

  if (update.addressId) {
    const ownsAddress = (user.addresses || []).some(
      (address) => String(address._id || "") === String(update.addressId)
    );
    if (!ownsAddress) errors.push("Selected property does not belong to the selected customer");
  }

  return user;
}

async function serializeProjectCustomer(user, options = {}) {
  const subscriptions = await findSubscriptionsForUser(user._id);
  return serializeCustomerForProjectSelector(user, subscriptions, options);
}

const PROJECT_CUSTOMER_SELECT =
  "userId name firstName lastName email phone role employeePosition isActive status isDeleted deleted deletedAt accountDeleted accountDeletedAt removedAt isBlocked blocked address city state zip county addresses defaultAddressId search createdAt updatedAt";

async function blacklistEntriesForUsers(users = []) {
  const ids = users.map((user) => user?._id).filter(Boolean);
  const emails = users
    .map((user) => cleanString(user?.email, 254).toLowerCase())
    .filter(Boolean);
  const userIds = users.map((user) => cleanString(user?.userId, 80)).filter(Boolean);
  if (!ids.length && !emails.length && !userIds.length) return [];
  return Blacklist.find({
    $or: [
      ...(ids.length ? [{ user: { $in: ids } }] : []),
      ...(emails.length ? [{ email: { $in: emails } }] : []),
      ...(userIds.length ? [{ userId: { $in: userIds } }] : []),
    ],
  })
    .select("user userId email")
    .lean();
}

async function blockedProjectCustomerIds(users = []) {
  const entries = await blacklistEntriesForUsers(users);
  const blocked = new Set();
  for (const entry of entries) {
    if (entry.user) blocked.add(String(entry.user));
    const email = cleanString(entry.email, 254).toLowerCase();
    const userId = cleanString(entry.userId, 80);
    for (const user of users) {
      if (email && cleanString(user.email, 254).toLowerCase() === email) blocked.add(String(user._id));
      if (userId && cleanString(user.userId, 80) === userId) blocked.add(String(user._id));
    }
  }
  return blocked;
}

async function isProjectCustomerBlocked(user) {
  const blocked = await blockedProjectCustomerIds([user]);
  return blocked.has(String(user?._id || ""));
}

function mergeAndRankProjectCustomers(users, q) {
  const unique = new Map();
  for (const user of users) {
    if (!user || !isProjectSelectableCustomer(user)) continue;
    const key = String(user._id || "");
    if (!key || unique.has(key)) continue;
    unique.set(key, user);
  }
  return Array.from(unique.values()).sort((left, right) => {
    const leftScore = scoreProjectCustomerSearchMatch(left, q);
    const rightScore = scoreProjectCustomerSearchMatch(right, q);
    if (leftScore !== rightScore) return leftScore - rightScore;
    return `${left.name || ""} ${left.email || ""}`.localeCompare(`${right.name || ""} ${right.email || ""}`);
  });
}

async function repairReturnedCustomerSearchFields(users = []) {
  await Promise.all(
    users
      .filter((user) => !isSearchFieldsCurrent(user))
      .map((user) =>
        User.updateOne(
          { _id: user._id },
          { $set: { search: buildUserSearchFields(user) } }
        )
      )
  );
}

router.use(auth, ...requirePermission(PERMISSIONS.ADMIN));

router.get("/meta", (_req, res) => {
  return res.json({ projectTypes: PROJECT_TYPES, statuses: PROJECT_STATUSES });
});

router.get("/", async (req, res) => {
  try {
    const query = activeProjectFilter();
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

router.get("/customer-search", async (req, res) => {
  try {
    const q = cleanString(req.query.q, 120);
    const limit = normalizeLimit(req.query.limit, 12);
    const cursor = normalizeCursor(req.query.cursor);
    const query = buildCustomerSearchQuery(q);

    if (!query) {
      return res.json({
        customers: [],
        nextCursor: null,
        limit,
        message: "Enter at least 2 characters to search customers.",
      });
    }

    const fetchLimit = Math.min(cursor + limit + 1, 250);
    const indexedUsers = await User.find(query)
      .select(PROJECT_CUSTOMER_SELECT)
      .sort({ name: 1, email: 1, createdAt: -1 })
      .limit(fetchLimit)
      .lean();

    let fallbackUsers = [];
    if (indexedUsers.length < fetchLimit) {
      const fallbackQuery = buildCustomerFallbackSearchQuery(
        q,
        indexedUsers.map((user) => user._id)
      );
      if (fallbackQuery) {
        fallbackUsers = await User.find(fallbackQuery)
          .select(PROJECT_CUSTOMER_SELECT)
          .sort({ updatedAt: -1, createdAt: -1 })
          .limit(Math.min(fetchLimit, 100))
          .maxTimeMS(1500)
          .lean();
      }
    }

    const ranked = mergeAndRankProjectCustomers([...indexedUsers, ...fallbackUsers], q);
    const blocked = await blockedProjectCustomerIds(ranked);
    const selectable = ranked.filter((user) => !blocked.has(String(user._id)));
    const page = selectable.slice(cursor, cursor + limit);
    await repairReturnedCustomerSearchFields(page);

    const customers = [];
    for (const user of page) {
      customers.push(await serializeProjectCustomer(user, { query: q }));
    }

    return res.json({
      customers,
      nextCursor: selectable.length > cursor + limit ? String(cursor + limit) : null,
      limit,
    });
  } catch (error) {
    console.error("GET /admin/projects/customer-search failed:", error);
    return res.status(500).json({ message: "Failed to search customers" });
  }
});

router.get("/customer/:customerId", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.customerId)) {
      return res.status(400).json({ message: "Invalid customer ID" });
    }
    const user = await User.findOne({
      _id: req.params.customerId,
      ...projectSelectableCustomerEligibilityQuery(),
    })
      .select(PROJECT_CUSTOMER_SELECT)
      .lean();
    if (!user || !isProjectSelectableCustomer(user) || (await isProjectCustomerBlocked(user))) {
      return res.status(404).json({ message: "Customer not found" });
    }

    await repairReturnedCustomerSearchFields([user]);

    return res.json({
      customer: await serializeProjectCustomer(user, {
        selectedAddressId: req.query.addressId || null,
      }),
    });
  } catch (error) {
    console.error("GET /admin/projects/customer/:customerId failed:", error);
    return res.status(500).json({ message: "Failed to load customer" });
  }
});

router.get("/:projectId/estimates", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.projectId)) {
      return res.status(400).json({ message: "Invalid project ID" });
    }
    const project = await Project.findById(req.params.projectId).select("_id isDeleted deletedAt").lean();
    if (!project) return res.status(404).json({ message: "Project not found" });
    if (isDeletedProject(project)) return sendDeletedProjectResponse(res, project);

    const estimates = await Estimate.find({ projectId: req.params.projectId })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ estimates });
  } catch (error) {
    console.error("GET /admin/projects/:projectId/estimates failed:", error);
    return res.status(500).json({ message: "Failed to load project estimates" });
  }
});

router.get("/:id/deletion-summary", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid project ID" });
    }
    const project = await Project.findById(req.params.id)
      .select("_id projectNumber isDeleted deletedAt")
      .lean();
    if (!project) return res.status(404).json({ message: "Project not found" });
    return res.json({
      project: {
        _id: project._id,
        projectNumber: project.projectNumber,
        isDeleted: project.isDeleted === true,
        deletedAt: project.deletedAt || null,
      },
      deletionSummary: await projectDeletionSummary(req.params.id),
    });
  } catch (error) {
    console.error("GET /admin/projects/:id/deletion-summary failed:", error);
    return res.status(500).json({ message: "Failed to load project deletion summary" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid project ID" });
    }
    const project = await Project.findById(req.params.id).lean();
    if (!project) return res.status(404).json({ message: "Project not found" });
    if (isDeletedProject(project)) return sendDeletedProjectResponse(res, project);
    return res.json({ project });
  } catch (error) {
    console.error("GET /admin/projects/:id failed:", error);
    return res.status(500).json({ message: "Failed to load project" });
  }
});

router.post("/", async (req, res) => {
  try {
    const { errors, update } = validateProjectInput(req.body);
    await validateProjectCustomerLink(update, errors);
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
    const existing = await Project.findById(req.params.id).select("_id isDeleted deletedAt").lean();
    if (!existing) return res.status(404).json({ message: "Project not found" });
    if (isDeletedProject(existing)) return sendDeletedProjectResponse(res, existing);

    const { errors, update } = validateProjectInput(req.body, { partial: true });
    await validateProjectCustomerLink(update, errors);
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

router.post("/:id/restore", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid project ID" });
    }
    const project = await Project.findById(req.params.id).lean();
    if (!project) return res.status(404).json({ message: "Project not found" });

    if (!isDeletedProject(project)) {
      return res.json({
        message: "Project is already active",
        project,
        restored: false,
      });
    }

    const audit = await createAdminActivityLog(req, {
      action: "Project Restore Started",
      entityType: "Project",
      entityId: project._id,
      entityName: project.projectNumber,
      details: {
        projectNumber: project.projectNumber,
        customer: project.customerName,
        deletedAt: project.deletedAt,
      },
    });

    const restored = await Project.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          isDeleted: false,
          deletedAt: null,
          deletedBy: null,
          deleteReason: "",
        },
      },
      { new: true, runValidators: true }
    ).lean();
    if (!restored) return res.status(404).json({ message: "Project not found" });

    await markAdminActivityLog(audit, {
      action: "Project Restored",
      details: {
        projectNumber: restored.projectNumber,
        customer: restored.customerName,
        restoredAt: new Date().toISOString(),
      },
    });

    return res.json({ message: "Project restored", project: restored, restored: true });
  } catch (error) {
    console.error("POST /admin/projects/:id/restore failed:", error);
    return res.status(500).json({ message: "Failed to restore project" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid project ID" });
    }
    const project = await Project.findById(req.params.id).lean();
    if (!project) return res.status(404).json({ message: "Project not found" });
    const relatedRecords = await projectDeletionSummary(req.params.id);

    if (isDeletedProject(project)) {
      return res.json({
        message: "Project already deleted. Contracts and saved records remain preserved.",
        project,
        deletion: {
          isDeleted: true,
          deletedAt: project.deletedAt || null,
          deletedBy: project.deletedBy || null,
          relatedRecords,
        },
      });
    }

    if (
      relatedRecords.requiresDeleteConfirmation &&
      String(req.body?.confirmation || "").trim() !== "DELETE"
    ) {
      return res.status(400).json({
        message: "Type DELETE to confirm deletion while preserving contracts, estimates, files, and history.",
      });
    }

    const audit = await createAdminActivityLog(req, {
      action: "Project Delete Started",
      entityType: "Project",
      entityId: project._id,
      entityName: project.projectNumber,
      details: {
        projectNumber: project.projectNumber,
        customer: project.customerName,
        customerEmail: project.email,
        projectType: project.projectType,
        projectStatus: project.status,
        relatedRecords,
      },
    });

    const deletedAt = new Date();
    const deleted = await Project.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          isDeleted: true,
          deletedAt,
          deletedBy: req.user.id,
          deleteReason: cleanString(req.body?.deleteReason, 1000),
        },
      },
      { new: true, runValidators: true }
    ).lean();
    if (!deleted) return res.status(404).json({ message: "Project not found" });

    await markAdminActivityLog(audit, {
      action: "Project Deleted",
      details: {
        projectNumber: project.projectNumber,
        customer: project.customerName,
        customerEmail: project.email,
        projectType: project.projectType,
        projectStatus: project.status,
        deletedAt: deletedAt.toISOString(),
        preservedRecords: relatedRecords,
      },
    });

    return res.json({
      message: "Project deleted. Contracts and saved records were preserved.",
      project: deleted,
      deletion: {
        isDeleted: true,
        deletedAt,
        deletedBy: req.user.id,
        relatedRecords,
      },
    });
  } catch (error) {
    console.error("DELETE /admin/projects/:id failed:", error);
    return res.status(500).json({ message: "Failed to delete project" });
  }
});

module.exports = router;
