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
const { startMarketingEmails } = require("./jobs/marketingEmails");
const {
  startBookingReviewRequests,
} = require("./jobs/bookingReviewRequests");
const {
  startOneTimeVisitHoldCleanup,
} = require("./jobs/oneTimeVisitHolds");
const { startSmsJobs } = require("./jobs/smsJobs");
const { startOverrideRefresh } = require("./utils/communications/templateOverrides");
const { startGiftLifecycle } = require("./jobs/giftLifecycle");
const { startLoyaltyReminders } = require("./jobs/loyaltyReminders");
const { startGrowthJobs } = require("./jobs/growthActions");
const { startVisibilityJobs } = require("./jobs/visibility");
const { startAgentJobs } = require("./jobs/agents");
const { startRecentWorkPublisher } = require("./jobs/recentWorkPublisher");
const adminCalendar = require("./routes/adminCalendar");
const adminCalendarShadow = require("./routes/adminCalendarShadow");
const {
  ensureCapacityOverrideIndexes,
} = require("./utils/capacityOverrideIndexSafety");
const {
  ensureVisitEntitlementIndexesOnce,
} = require("./utils/visitEntitlementIndexSafety");
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
/**
 * Additional allowed origins, comma separated.
 *
 * Exists so an isolated QA stack on a non-default port can call this API.
 * Production leaves it unset, so the allowlist below is unchanged there - this
 * widens nothing by default and never uses a wildcard.
 */
const EXTRA_CORS_ORIGINS = String(process.env.EXTRA_CORS_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: [
  ...EXTRA_CORS_ORIGINS,
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
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "x-ghl-secret",
    ],
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

function isJsonBodyParseError(err) {
  return (
    err?.type === "entity.parse.failed" ||
    (err instanceof SyntaxError &&
      err.status === 400 &&
      Object.prototype.hasOwnProperty.call(err, "body"))
  );
}


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
    await ensureVisitEntitlementIndexesOnce();
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

    // The unique index on the PaymentIntent is what stops one tip payment
    // becoming two Tip records, so it is built before traffic rather than
    // whenever Mongoose gets round to it.
    await require("./models/Tip").init();
    console.log("✅ Tip indexes ready");

    // The membership lead dedupe is a unique index, so repeated taps can only
    // become one lead once it exists.
    await require("./models/Request").syncIndexes();
    console.log("✅ Request indexes ready");

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
// Public gallery read needs no token; the submission route inside it does.
app.use("/api/recent-work", require("./routes/recentWork"));
app.use("/api/membership-map", require("./routes/membershipMap"));
app.use("/api/service-area", require("./routes/serviceArea"));
app.use("/api/test", require("./routes/test"));
app.use("/api/feedback", require("./routes/feedback"));
app.use("/api/referrals", require("./routes/referrals"));
app.use("/api", require("./routes/promotionPopup"));
app.use("/api/admin/overview", require("./routes/adminOverview"));
app.use("/api/admin/growth", require("./routes/adminGrowth"));
app.use("/api/admin/calendar", adminCalendarShadow);
app.use(
  "/api/admin/calendar",
  require("./routes/adminCustomerAvailabilityPreview")
);
app.use("/api/admin/calendar", adminCalendar);
app.use("/api/admin", require("./routes/adminBookingReservations"));
app.use("/api/admin/projects", require("./routes/projects"));
app.use("/api/admin/estimates", require("./routes/adminEstimates"));
app.use("/api/admin/contracts", require("./routes/adminContracts"));
app.use("/api/admin/change-orders", require("./routes/adminChangeOrders"));
app.use("/api/admin/signatures", require("./routes/adminSignatures"));
app.use("/api/admin/invoices", require("./routes/adminInvoices"));
app.use("/api/admin/fixters", require("./routes/fixters"));
app.use("/api/admin/tips", require("./routes/adminTips"));
app.use("/api/admin/email-logs", require("./routes/adminEmailLogs"));
// Before the catch-all admin router, exactly as email-logs is.
app.use("/api/admin/sms", require("./routes/adminSms"));
// Template control and unified email+SMS history. Admin-only on both sides:
// message bodies carry customer names, appointment times and claim links.
app.use("/api/admin/communications", require("./routes/adminCommunications"));
app.use("/api/admin/recent-work", require("./routes/adminRecentWork"));
app.use("/api/admin/gifts", require("./routes/adminGifts"));
// Booth display. Admin: review, hide, restore. Public: view-only kiosk feed
// with opaque ids and images re-served from here, never S3 URLs.
app.use("/api/admin/event-display", require("./routes/adminEventDisplay"));
app.use("/api/event-display", require("./routes/eventDisplay"));
app.use("/api/admin", require("./routes/adminCampaigns"));
app.use("/api/admin/marketing", require("./routes/adminMarketing"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/email", require("./routes/email"));
app.use("/api/calendar", require("./routes/calendar"));

app.use("/api/facebook", require("./routes/facebook"));
app.use("/api/track", require("./routes/track"));
app.use("/api/chatbot", require("./routes/chatbot"));
app.use("/api/users", usersRouter);
app.use("/api/google", require("./routes/google"));
app.use("/api/estimates", require("./routes/estimates"));
// Public by necessity: the e-signature provider calls this. It authenticates
// itself with the client-id header the provider echoes, and rejects anything
// that does not match.
app.use("/api/esign/webhook", require("./routes/esignWebhook"));
// Public by necessity: the customer signs here with only an opaque token.
// No account, no login, no code sent to a phone - the token is the credential,
// and every substantive value is read server-side.
app.use("/api/sign", require("./routes/publicSigning"));
// Public by necessity: someone leaving a tip after a visit has no reason to
// hold an account. The token in the request only says which booking the link
// came from; the Fixter, the customer and the amount are all resolved server
// side, and a request without usable context still takes the money.
app.use("/api/tips", require("./routes/tips"));
// Every route inside answers 404 while GIFTS_ENABLED is not "true", so
// mounting the feature and releasing it stay two separate decisions.
app.use("/api/gifts", require("./routes/gifts"));
// Public by necessity: Twilio calls these to report delivery and to
// forward STOP/START/HELP. Every request is verified against
// X-Twilio-Signature before any field of it is trusted, because an
// unauthenticated forged STOP would silence a customer, and a forged
// START would un-silence somebody who genuinely opted out.
app.use("/api/sms/webhook", require("./routes/smsWebhook"));

// The same reasoning for voice. 631-888-6340 appears in every appointment
// reminder, so people ring it; without an answer Twilio returns a carrier
// error and the customer concludes nobody is home. This answers, points at the
// office line, and hangs up. It never rings a person, never records and never
// takes a message - see routes/voiceWebhook for the full list of what it
// deliberately does not do.
app.use("/api/voice/webhook", require("./routes/voiceWebhook"));



/* ================= Retired legacy email crons =================
 * The weekly nudge, chatbot follow-ups and non-subscriber nurture crons were
 * removed (2026-10). All three were off in production. None took a lock, so
 * every EB instance would have sent; none checked EmailSuppression or
 * excludeFromMarketing; and the chatbot follow-ups named templates that do not
 * exist. The lifecycle engine in utils/marketing (jobs/marketingEmails.js)
 * covers the same audiences with claims, caps and suppression. Setting the old
 * flags now only produces this warning.
 */
for (const flag of ["WEEKLY_NUDGE_ENABLED", "CHATBOT_FOLLOWUPS_ENABLED", "NURTURE_ENABLED"]) {
  if (process.env[flag] === "true") {
    console.warn(`[legacy-crons] ${flag}=true is ignored: this cron was retired in favour of jobs/marketingEmails.js`);
  }
}
/* ============================================================== */

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
app.use((err, req, res, next) => {
  const status = Number(err?.statusCode || err?.status || 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;

  console.error("Server Error:", {
    method: req.method,
    path: req.originalUrl,
    statusCode: safeStatus,
    type: err?.type || null,
    message: err?.message || String(err),
    stack: err?.stack || null,
  });

  if (isJsonBodyParseError(err)) {
    return res.status(400).json({
      message: "Invalid JSON request body",
      error: err.message,
    });
  }

  return res.status(safeStatus).json({
    message: safeStatus === 500 ? "Internal Server Error" : err.message,
    error: err.message,
  });
});

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

/*
 * Marketing runs on the opposite default to everything above: opt IN, not opt
 * out. The cron registers either way and does nothing until
 * ENABLE_MARKETING_EMAILS is true, so deploying the code and turning marketing
 * on stay two separate decisions.
 */
startRecentWorkPublisher();

startMarketingEmails();

/*
 * The SMS sweeps: provider retries, and marketing campaigns.
 *
 * Registered unconditionally and gated internally, on the same reasoning as
 * marketing above: deploying the code and switching the channel on are two
 * separate decisions. With SMS_ENABLED unset, both sweeps run, evaluate and
 * record, and no message leaves the system.
 *
 * Note what is NOT here. Booking reminders are not started by this; they
 * continue to come from startBookingReminders above, which now sends the
 * text alongside the email it already sent. A second reminder scheduler is
 * exactly how a customer would end up with two of everything.
 */
startSmsJobs();

/*
 * Loyalty Benefits reminders.
 *
 * Registered unconditionally and gated internally on LOYALTY_ENABLED, like
 * marketing and SMS above. It sends email and nothing else — no benefit is
 * granted, expired or revoked here, because expiry is a date comparison made
 * wherever the question is asked. A missed run costs a reminder, never a
 * benefit.
 */
startLoyaltyReminders();

/*
 * The growth engine: executes approved growth actions, verifies them and
 * expires stale approvals. Registered unconditionally; with
 * GROWTH_ACTIONS_ENABLED unset every proposal is recorded in shadow and
 * nothing executes. See utils/growth/actionEngine.
 */
startGrowthJobs();

/* Visibility collectors for the Command Center (reviews daily; Search Console, local rank and AI answers only when configured). See jobs/visibility. */
startVisibilityJobs();

/* The three growth agents. Inert until AGENTS_ENABLED=true and ANTHROPIC_API_KEY are set; see utils/agents. */
startAgentJobs();

/*
 * Keep admin-edited message wording warm in memory.
 *
 * renderSms is synchronous and is called from templates, triggers and the retry
 * sweep, so it cannot await a database read. This loads the overrides once at
 * boot and refreshes them on a timer; an instance that makes an edit refreshes
 * itself immediately. With no overrides saved, every message renders from its
 * tested code default exactly as before.
 */
startOverrideRefresh();

/*
 * The gift lifecycle sweep: reminder emails and bookkeeping.
 *
 * It does NOT grant or revoke access. Whether a gift works is computed from
 * its own dates every time it is asked, so a delayed or missed run cannot
 * lock a customer out of a gift they hold. Registered unconditionally and
 * gated internally on GIFTS_ENABLED.
 */
startGiftLifecycle();

/*
 * The Admin Overview's copy of Stripe charges (models/RevenueCharge). The
 * first run after a deploy backfills it once in the background; then every
 * five minutes it reads only new charges and refunds. The Overview reads the
 * copy, so opening it never waits on a year of Stripe pages.
 */
require("./utils/analytics/stripeRevenue").startRevenueLedgerSync();
/* Meta ad spend for CAC/ROAS. No-op unless META_ADS_SYNC_ENABLED and META_ADS_ACCOUNT_ID are set. */
require("./utils/analytics/metaAdSpend").startMetaAdSpendSync();
/* Read-only: which events the live Meta campaigns optimise for (logged as meta_campaign_audit). */
require("./utils/analytics/metaCampaignAudit").startMetaCampaignAudit();
/* Logs the Command Center aggregates once after boot (growth_self_check) - no personal data. */
require("./utils/growth/selfCheck").scheduleSelfCheck();

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // E-signature provisioning: confirm Adobe connectivity and make sure our
  // webhook is registered and ACTIVE. Deliberately started only once we are
  // listening, because Adobe verifies the webhook URL by calling it back
  // during registration - registering before we can answer would fail.
  // Best-effort and non-blocking; it logs no tokens or secrets.
  require("./utils/esign/webhookProvisioner")
    .runStartupProvisioning()
    .catch((error) => console.error("esign: startup provisioning error:", error?.message));
});
