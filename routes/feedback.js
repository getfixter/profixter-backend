const express = require("express");
const nodemailer = require("nodemailer");
const multer = require("multer");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

router.post("/", upload.array("files", 3), async (req, res) => {
  const { message } = req.body;
  
  const attachments = req.files.map((file) => ({
    filename: file.originalname,
    content: file.buffer,
  }));

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER,
      subject: "New Feedback from Handyman Website",
      text: message,
      attachments,
    });

    res.status(200).json({ message: "Feedback sent!" });
  } catch (err) {
    console.error("❌ Email Error:", err.message);
    res.status(500).json({ error: "Failed to send email" });
  }
});

module.exports = router;
