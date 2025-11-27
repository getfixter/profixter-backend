require("dotenv").config();
if (!process.env.JWT_RESET_SECRET) {
  console.warn("⚠️  JWT_RESET_SECRET is NOT set – password reset will fail.");
} else {
  console.log("✅ JWT_RESET_SECRET present (len:", String(process.env.JWT_RESET_SECRET).length, ")");
}
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const User = require("./models/User");
const cron = require("node-cron");
const { sendTx } = require("./utils/emailService");
const adminCalendar = require("./routes/adminCalendar");
const path = require("path"); // <-- add this line
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = (process.env.S3_PREFIX || "uploads").replace(/^\/+|\/+$/g, "");
const usersRouter = require("./routes/users");
const Lead = require("./models/Lead");



const app = express();

// Redirect both /uploads/* and /api/uploads/*
app.get(["/uploads/*", "/api/uploads/*"], (req, res) => {
  // req.params[0] is the path after the first wildcard; rebuild safely
  const path = (req.params[0] || "").replace(/^\/+/, "");
  // ensure it begins with prefix
  const key = path.startsWith(`${S3_PREFIX}/`) ? path : `${S3_PREFIX}/${path}`;
  const url = `https://${S3_BUCKET}.s3.amazonaws.com/${key}`;
  return res.redirect(301, url);
});

// ✅ 1. CORS — FIX CORS + allow all headers
app.use(
  cors({
    origin: [
  "http://localhost:3000",
  "http://handyman-frontend-v1.s3-website-us-east-1.amazonaws.com",
  "http://handyman-v2-env.eba-fq3ppgr4.us-east-1.elasticbeanstalk.com",
  "http://profixter.com",
  "https://profixter.com",
  "http://www.profixter.com",
  "https://www.profixter.com",
],

    credentials: true,
    methods: "GET,POST,PUT,DELETE",
    allowedHeaders: ["Authorization", "Content-Type"],
  })
);

// ✅ 2. Cookie parser
app.use(cookieParser());

// ✅ 3. Stripe webhook first — raw body
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json", limit: "2mb" }),
  require("./routes/webhook")
);

// ✅ 4. Body parser for everything else
app.use(express.json({ limit: "50mb" })); // ← bigger limit

app.use("/api/users", usersRouter);

app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ✅ 5. MongoDB Connect
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
  console.error("❌ MONGO_URI missing");
  process.exit(1);
}
mongoose
  .connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    console.log("✅ MongoDB Connected");

    // 🔽 make sure schema indexes (incl. unique lowercased email) are in sync
    await require("./models/User").syncIndexes()
      .then(() => console.log("✅ User indexes in sync"))
      .catch(e => console.warn("⚠️ Could not sync User indexes:", e.message));

    const u = await User.findOne();
    console.log(u ? "✅ MongoDB Test Passed" : "ℹ️ No users yet");
  })
  .catch((err) => {
    console.error("❌ MongoDB Error:", err.message);
    process.exit(1);
  });


// ✅ 6. API Routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/stripe", require("./routes/stripe"));
app.use("/api/password-reset", require("./routes/passwordReset"));
app.use("/api/subscriptions", require("./routes/subscriptions"));
app.use("/api/bookings", require("./routes/bookings"));
app.use("/api/request", require("./routes/requests"));
app.use("/api/test", require("./routes/test"));
app.use("/api/feedback", require("./routes/feedback"));
app.use("/api/referrals", require("./routes/referrals"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/calendar", require("./routes/calendar"));
app.use("/api/admin/calendar", adminCalendar);
app.use("/api/facebook", require("./routes/facebook"));
app.use("/api/track", require("./routes/track"));
app.use("/api/chatbot", require("./routes/chatbot"));



/* ================= Weekly nudge CRON ================= */
if (process.env.WEEKLY_NUDGE_ENABLED !== "false") {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const chunk = (arr, size) =>
    arr.reduce((a, _, i) => (i % size ? a : [...a, arr.slice(i, i + size)]), []);

  // Every Monday 10:00 AM New York time
  cron.schedule(
    "0 10 * * 1",
    async () => {
      try {
        const notSubscribed = await User.find({
          $or: [
            { subscription: null },
            { subscription: "" },
            { subscription: { $exists: false } },
          ],
          email: { $exists: true, $ne: process.env.MAIL_ADMIN || "getfixter@gmail.com" },
        })
          .select("name email")
          .limit(5000);

        for (const group of chunk(notSubscribed, 10)) {
          await Promise.all(
            group.map((u) => sendTx("nudge_subscribe", u.email, { name: u.name }))
          );
          await sleep(400); // ~25 msgs/sec safety
        }

        console.log(`Weekly nudge sent to ${notSubscribed.length} users.`);
      } catch (e) {
        console.error("Weekly nudge failed:", e.message);
      }
    },
    { timezone: "America/New_York" }
  );
}
/* ===================================================== */

/* ================= Chatbot follow-ups CRON (SES templates) ================= */
if (process.env.CHATBOT_FOLLOWUPS_ENABLED !== "false") {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const safeFrom = process.env.MAIL_ADMIN || "getfixter@gmail.com"; // your SES sender

  // Run every hour at minute 12
  cron.schedule(
    "12 * * * *",
    async () => {
      try {
        const now = new Date();
        const hrsAgo = (h) => new Date(now.getTime() - h * 3600 * 1000);

        // --- First follow-up (≈2 hours after contact) ---
        const wave1 = await Lead.find({
          status: "engaged",
          email: { $exists: true, $ne: safeFrom },
          createdAt: { $lte: hrsAgo(2) },
          followup1SentAt: { $exists: false },
          convertedAt: { $exists: false },
        }).select("name email").limit(500);

        for (const lead of wave1) {
          try {
            await sendTx("nudge_lead_v1", lead.email, { name: lead.name || "there" });
            await Lead.updateOne({ _id: lead._id }, { $set: { followup1SentAt: new Date() } });
            await sleep(70); // ~14 emails/sec
          } catch (e) {
            console.warn("FU1 send failed:", e.message);
          }
        }

        // --- Second follow-up (≈48 hours after contact) ---
        const wave2 = await Lead.find({
          status: "engaged",
          email: { $exists: true, $ne: safeFrom },
          createdAt: { $lte: hrsAgo(48) },
          followup1SentAt: { $exists: true },
          followup2SentAt: { $exists: false },
          convertedAt: { $exists: false },
        }).select("name email").limit(500);

        for (const lead of wave2) {
          try {
            await sendTx("nudge_lead_v2", lead.email, { name: lead.name || "there" });
            await Lead.updateOne({ _id: lead._id }, { $set: { followup2SentAt: new Date() } });
            await sleep(70);
          } catch (e) {
            console.warn("FU2 send failed:", e.message);
          }
        }

        if (wave1.length || wave2.length)
          console.log(`📧 Chatbot follow-ups sent: FU1=${wave1.length}, FU2=${wave2.length}`);
      } catch (e) {
        console.error("Chatbot follow-ups failed:", e.message);
      }
    },
    { timezone: "America/New_York" }
  );
}
/* ========================================================================= */


// ✅ 7. Serve static frontend files (Next.js out/ folder)
// For local development: comment out and run frontend separately on localhost:3000
// For AWS production: uncomment and ensure 'out' folder exists
if (process.env.NODE_ENV === "production" || process.env.SERVE_STATIC === "true") {
  app.use(express.static(path.join(__dirname, "out")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "out", "index.html"));
  });
}


// ✅ 8. Global error handler
app.use((err, req, res, next) => {
  console.error("❌ Server Error:", err.stack || err.message);
  res.status(500).json({ message: "Internal Server Error", error: err.message });
});

// ✅ 9. Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
