const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const EmailLog = require("../models/EmailLog");
const { bodySearchInput } = require("../utils/searchInput");

const sectionAccess = requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE);

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asDate(value, endOfDay = false) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}

async function listEmailLogs(req, res, input) {
  try {
    const page = Math.max(1, Number(input.page || 1));
    const limit = Math.min(100, Math.max(1, Number(input.limit || 25)));
    const query = {};

    for (const field of ["templateKey", "bookingNumber", "status", "emailType"]) {
      if (input[field]) {
        query[field] = String(input[field]).trim();
      }
    }
    for (const field of ["customerEmail", "recipientEmail"]) {
      if (input[field]) {
        query[field] = String(input[field]).trim().toLowerCase();
      }
    }

    const dateFrom = asDate(input.dateFrom);
    const dateTo = asDate(input.dateTo, true);
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = dateFrom;
      if (dateTo) query.createdAt.$lte = dateTo;
    }

    const search = String(input.search || "").trim();
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      query.$or = [
        { templateKey: regex },
        { subject: regex },
        { recipientEmail: regex },
        { recipientName: regex },
        { customerEmail: regex },
        { customerName: regex },
        { bookingNumber: regex },
        { campaignNumber: regex },
        { errorMessage: regex },
      ];
    }

    const [items, total] = await Promise.all([
      EmailLog.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      EmailLog.countDocuments(query),
    ]);

    return res.json({
      items,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error("Email log list failed:", error);
    return res.status(500).json({ message: "Failed to load email logs" });
  }
}

router.get("/", auth, ...sectionAccess, (req, res) => listEmailLogs(req, res, req.query || {}));
// POST /api/admin/email-logs/search: the same filters in a JSON body, so free text stays out of URLs.
router.post("/search", auth, ...sectionAccess, (req, res) => listEmailLogs(req, res, bodySearchInput(req.body)));

router.get("/:id", auth, ...sectionAccess, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid email log id" });
    }
    const item = await EmailLog.findById(req.params.id).lean();
    if (!item) return res.status(404).json({ message: "Email log not found" });
    return res.json({ item });
  } catch (error) {
    console.error("Email log detail failed:", error);
    return res.status(500).json({ message: "Failed to load email log" });
  }
});

module.exports = router;
