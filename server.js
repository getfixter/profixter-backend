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
const { startBookingReminders } = require("./jobs/bookingReminders");
const {
  startBookingReviewRequests,
} = require("./jobs/bookingReviewRequests");
const {
  startOneTimeVisitHoldCleanup,
} = require("./jobs/oneTimeVisitHolds");
const adminCalendar = require("./routes/adminCalendar");
const adminCalendarShadow = require("./routes/adminCalendarShadow");
const {
  ensureCapacityOverrideIndexes,
} = require("./utils/capacityOverrideIndexSafety");
const path = require("path"); // <-- add this line
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = (process.env.S3_PREFIX || "uploads").replace(/^\/+|\/+$/g, "");
const usersRouter = require("./routes/users");
const Lead = require("./models/Lead");
const {
  reconcileActiveStripeSubscriptions,
} = require("./utils/subscriptionManagement");


const app = express();
// Health check
app.get("/", (req, res) => {
  res.json({ status: "Backend OK" });
});


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
methods: "GET,POST,PUT,PATCH,DELETE",
    allowedHeaders: ["Authorization", "Content-Type", "x-ghl-secret"],
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

// ⛔ MUST come BEFORE json body parser
app.use("/api/bookings", (req, res, next) => next());

// ✅ body parser for everything except bookings
app.use(express.json({
  limit: "500mb",
  verify: (req, res, buf) => {
    if (req.originalUrl.includes("/api/stripe/webhook")) {
      req.rawBody = buf;
    }
  }
}));

app.use(express.urlencoded({ extended: true, limit: "500mb" }));


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

    await ensureCapacityOverrideIndexes();
    try {
      await Promise.all([
        require("./models/BookingSlotReservation").init(),
        require("./models/ReservationTimeBucket").init(),
        require("./models/ReservationCapacityBucket").init(),
      ]);
    } catch (error) {
      if (error?.code === 11000) {
        console.error(
          "❌ Reservation unique index could not be created. Run: npm run reservations:audit"
        );
      }
      throw error;
    }
    console.log("✅ Reservation indexes ready");

    const u = await User.findOne();
    console.log(u ? "✅ MongoDB Test Passed" : "ℹ️ No users yet");
  })
  .catch((err) => {
    console.error("❌ MongoDB Error:", err.message);
    process.exit(1);
});



// ✅ 6. API Routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/stripe/checkout", require("./routes/stripe"));
app.use("/api/ghl", require("./routes/ghl"));

app.use("/api/password-reset", require("./routes/passwordReset"));
app.use("/api/subscriptions", require("./routes/subscriptions"));
app.use("/api/bookings", require("./routes/bookings"));
app.use("/api/requests", require("./routes/requests"));
app.use("/api/test", require("./routes/test"));
app.use("/api/feedback", require("./routes/feedback"));
app.use("/api/referrals", require("./routes/referrals"));
app.use("/api", require("./routes/promotionPopup"));
app.use("/api/admin/calendar", adminCalendarShadow);
app.use(
  "/api/admin/calendar",
  require("./routes/adminCustomerAvailabilityPreview")
);
app.use("/api/admin/calendar", adminCalendar);
app.use("/api/admin", require("./routes/adminBookingReservations"));
app.use("/api/admin/projects", require("./routes/projects"));
app.use("/api/admin/estimates", require("./routes/adminEstimates"));
app.use("/api/admin/fixters", require("./routes/fixters"));
app.use("/api/admin/email-logs", require("./routes/adminEmailLogs"));
app.use("/api/admin", require("./routes/adminCampaigns"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/email", require("./routes/email"));
app.use("/api/calendar", require("./routes/calendar"));

app.use("/api/facebook", require("./routes/facebook"));
app.use("/api/track", require("./routes/track"));
app.use("/api/chatbot", require("./routes/chatbot"));
app.use("/api/users", usersRouter);
app.use("/api/google", require("./routes/google"));
app.use("/api/estimates", require("./routes/estimates"));



/* ================= Weekly nudge CRON ================= */
if (process.env.WEEKLY_NUDGE_ENABLED === "true") {
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
            group.map((u) =>
              sendTx("nudge_subscribe", u.email, { name: u.name }, {
                logContext: {
                  userId: u._id,
                  customerName: u.name || "",
                  customerEmail: u.email,
                  recipientName: u.name || "",
                  recipientEmail: u.email,
                  emailType: "marketing",
                  source: "weeklyNudge",
                },
              })
            )
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
if (process.env.CHATBOT_FOLLOWUPS_ENABLED === "true") {
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
            await sendTx("nudge_lead_v1", lead.email, { name: lead.name || "there" }, {
              logContext: {
                customerName: lead.name || "",
                customerEmail: lead.email,
                recipientName: lead.name || "",
                recipientEmail: lead.email,
                emailType: "marketing",
                source: "chatbotFollowups",
              },
            });
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
            await sendTx("nudge_lead_v2", lead.email, { name: lead.name || "there" }, {
              logContext: {
                customerName: lead.name || "",
                customerEmail: lead.email,
                recipientName: lead.name || "",
                recipientEmail: lead.email,
                emailType: "marketing",
                source: "chatbotFollowups",
              },
            });
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


/* ================= Non-subscriber nurture sequence ================= */
if (process.env.NURTURE_ENABLED === "true") {
  const NURTURE_SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

  // Runs hourly at :45. Sends up to 200 eligible users per step per run.
  cron.schedule(
    "45 * * * *",
    async () => {
      try {
        const now = new Date();
        const Subscription = require("./models/Subscription");
        const adminEmail = (process.env.MAIL_ADMIN || "getfixter@gmail.com").toLowerCase();

        // Never send to users registered more than 30 days ago.
        const cutoff30d = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
        // Set NURTURE_START_DATE=YYYY-MM-DD in .env to prevent retroactive sends on first deploy.
        const nurtureStart = process.env.NURTURE_START_DATE
          ? new Date(process.env.NURTURE_START_DATE)
          : null;
        const earliest = nurtureStart && nurtureStart > cutoff30d ? nurtureStart : cutoff30d;

        const steps = [
          { field: "email1SentAt", delayMs: 1 * 3600 * 1000,      key: "nurture_1" }, // 1h
          { field: "email2SentAt", delayMs: 2 * 24 * 3600 * 1000, key: "nurture_2" }, // 2d
          { field: "email3SentAt", delayMs: 5 * 24 * 3600 * 1000, key: "nurture_3" }, // 5d
        ];

        let totalSent = 0;

        for (const { field, delayMs, key } of steps) {
          const eligible = await User.find({
            createdAt: { $gte: earliest, $lte: new Date(now.getTime() - delayMs) },
            [`nurture.${field}`]: null,
            email: { $exists: true, $ne: adminEmail },
          })
            .select("_id name email")
            .limit(200);

          for (const user of eligible) {
            try {
              const hasSub = await Subscription.exists({
                user: user._id,
                status: { $in: ["active", "trialing"] },
              });
              if (hasSub) continue;

              await sendTx(key, user.email, { name: user.name || "there" }, {
                logContext: {
                  userId: user._id,
                  customerName: user.name || "",
                  customerEmail: user.email,
                  recipientName: user.name || "",
                  recipientEmail: user.email,
                  emailType: "marketing",
                  source: "nurtureSequence",
                },
              });
              await User.updateOne(
                { _id: user._id },
                { $set: { [`nurture.${field}`]: now } }
              );
              totalSent++;
              await NURTURE_SLEEP(70); // ~14 emails/sec, within SES limits
            } catch (e) {
              console.warn(`[nurture] ${key} failed for ${user.email}:`, e.message);
              // Do NOT mark sentAt on failure — cron will retry next run
            }
          }
        }

        if (totalSent) console.log(`[nurture] Sent ${totalSent} emails.`);
      } catch (e) {
        console.error("[nurture] Cron failed:", e.message);
      }
    },
    { timezone: "America/New_York" }
  );
}
/* =================================================================== */

/* ================= Nightly Stripe subscription reconciliation ================= */
if (process.env.STRIPE_RECONCILIATION_ENABLED !== "false") {
  cron.schedule(
    "30 6 * * *",
    async () => {
      try {
        await reconcileActiveStripeSubscriptions({
          source: "nightly_reconciliation",
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "subscription_reconciliation_failed",
            scope: "stripe_subscription_reconciliation",
            message: error?.message || "Nightly reconciliation failed",
          })
        );
      }
    },
    { timezone: "UTC" }
  );
}
/* ============================================================================ */

/* ================= Nightly DB-only subscription auto-cancel ================= */
cron.schedule(
  "0 6 * * *", // 6:00 AM UTC = 1-2 AM Eastern (after NY midnight)
  async () => {
    try {
      const Subscription = require("./models/Subscription");
      const now = new Date();
      const expired = await Subscription.find({
        status: { $in: ["active", "trialing"] },
        cancelAtPeriodEnd: true,
        cancellationDate: { $lte: now },
        stripeSubscriptionId: { $in: [null, ""] },
      });

      for (const sub of expired) {
        sub.status = "canceled";
        sub.cancelAtPeriodEnd = false;
        sub.cancellationReason = "scheduled_admin";
        await sub.save();
      }

      if (expired.length) {
        console.log(`Nightly auto-cancel: canceled ${expired.length} DB-only subscriptions.`);
      }
    } catch (e) {
      console.error("Nightly auto-cancel failed:", e.message);
    }
  },
  { timezone: "UTC" }
);
/* ============================================================================ */

// ✅ 8. Global error handler
app.use((err, req, res, next) => {
  console.error("❌ Server Error:", err.stack || err.message);
  res.status(500).json({ message: "Internal Server Error", error: err.message });
});

// ✅ 9. Start server
const PORT = process.env.PORT || 5000;

startOneTimeVisitHoldCleanup();

if (process.env.BOOKING_REVIEW_REQUESTS_ENABLED !== "false") {
  startBookingReviewRequests();
  console.log("Booking review requests enabled");
}

if (process.env.BOOKING_REMINDERS_ENABLED !== "false") {
  startBookingReminders();
  console.log("✅ Booking reminders enabled");
}

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
