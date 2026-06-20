const express = require("express");
const multer = require("multer");
const FeedbackSubmission = require("../models/FeedbackSubmission");
const {
  sendAdminLeadNotification,
} = require("../utils/adminLeadNotification");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/", upload.array("files", 3), async (req, res) => {
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
