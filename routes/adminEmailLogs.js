const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const EmailLog = require("../models/EmailLog");

const onlyAdmin = requirePermission(PERMISSIONS.ADMIN);

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

router.get("/", auth, ...onlyAdmin, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    const query = {};

    for (const field of ["templateKey", "bookingNumber", "status", "emailType"]) {
      if (req.query[field]) {
        query[field] = String(req.query[field]).trim();
      }
    }
    for (const field of ["customerEmail", "recipientEmail"]) {
      if (req.query[field]) {
        query[field] = String(req.query[field]).trim().toLowerCase();
      }
    }

    const dateFrom = asDate(req.query.dateFrom);
    const dateTo = asDate(req.query.dateTo, true);
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = dateFrom;
      if (dateTo) query.createdAt.$lte = dateTo;
    }

    const search = String(req.query.search || "").trim();
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
});

router.get("/:id", auth, ...onlyAdmin, async (req, res) => {
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
