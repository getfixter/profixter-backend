const express = require("express");
const multer = require("multer");
const FeedbackSubmission = require("../models/FeedbackSubmission");
const {
  sendAdminLeadNotification,
} = require("../utils/adminLeadNotification");

const { rateLimit } = require("../utils/rateLimit");
const { clientIp } = require("../utils/auth/clientIp");

const router = express.Router();
/*
 * Attachments are held in memory and e-mailed to the owner, so both their size
 * and how often a stranger can send them are capped: without limits one script
 * could exhaust the server's memory or flood the admin inbox.
 */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 3 } });
const feedbackLimiter = rateLimit({ limit: 10, windowMs: 60 * 60 * 1000, keyResolver: (req) => `feedback:${clientIp(req)}` });

router.post("/", feedbackLimiter, upload.array("files", 3), async (req, res) => {
  const message = String(req.body.message || "").trim();
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const sourcePage = String(req.body.sourcePage || "/feedback").trim();

  const attachments = (req.files || []).map((file) => ({
    filename: file.originalname,
    content: file.buffer,
  }));

  try {
    if (!message) {
      return res.status(400).json({ error: "Feedback message is required" });
    }

    const submission = await FeedbackSubmission.create({
      name,
      email,
      message,
      sourcePage,
      attachments: (req.files || []).map((file) => ({
        filename: file.originalname,
        contentType: file.mimetype,
        size: file.size,
      })),
    });

    try {
      await sendAdminLeadNotification(
        {
          leadId: String(submission._id),
          leadType: "Customer Feedback",
          service: "Feedback",
          name: name || "Website visitor",
          email,
          message,
          sourcePage,
          submittedAt: submission.createdAt,
        },
        { attachments }
      );
    } catch (emailErr) {
      console.error("⚠️ Feedback notification failed; feedback was saved:", {
        feedbackId: submission._id,
        message: emailErr.message,
      });
    }

    return res.status(200).json({ message: "Feedback received!" });
  } catch (err) {
    console.error("❌ Feedback save error:", err.message);
    return res.status(500).json({ error: "Failed to save feedback" });
  }
});

module.exports = router;
