const express = require("express");
const multer = require("multer");
const { transporter, FROM, ADMIN } = require("../utils/emailService");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/", upload.array("files", 3), async (req, res) => {
  const { message } = req.body;

  const attachments = (req.files || []).map((file) => ({
    filename: file.originalname,
    content: file.buffer,
  }));

  try {
    await transporter.sendMail({
      from: FROM,
      to: ADMIN,
      subject: "New Feedback — Profixter",
      text: message || "(no message)",
      attachments,
    });

    res.status(200).json({ message: "Feedback sent!" });
  } catch (err) {
    console.error("❌ Feedback email error:", err.message);
    res.status(500).json({ error: "Failed to send feedback" });
  }
});

module.exports = router;
