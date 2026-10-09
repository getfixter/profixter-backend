const mongoose = require("mongoose");
const moment = require("moment-timezone");
const User = require("../../../models/User");
const Booking = require("../../../models/Booking");
const SmsMessage = require("../../../models/SmsMessage");
const { sendMarketingSms } = require("../../sms/smsService");
const { QUIET_HOURS, TIMEZONE } = require("../../sms/smsConfig");
const { resolveAudience } = require("../../marketing/marketingEligibility");
const { defineAction } = require("../actionRegistry");

/**
 * One text, a few days after a completed free first visit, to a non-member
 * who opted in to marketing texts.
 *
 * Free visit -> member is the step where the business is decided, and until
 * now it had email only (the post-free-visit track in utils/marketing). The
 * POST_FREE_VISIT_THANKS template and its marketing classification have
 * existed since the A2P work; nothing ever triggered it. This is the trigger.
 *
 * CONSENT. sendMarketingSms enforces it, not this file: marketingEnabled ===
 * true, no opt-out, no carrier block, the marketing send window. Nobody with
 * service consent only, and no bare phone number, can receive this.
 *
 * STARTS IN SHADOW. A new kind of customer text first proves its targeting by
 * recording who it WOULD have texted, in the Command Center, while sending
 * nothing. The owner moves it to "needs approval", and five clean approved
 * runs later it runs on its own (max 10 a day).
 */

const TYPE = "post_free_visit_sms";
const NOTIFICATION_TYPE = "POST_FREE_VISIT_THANKS";
const DAYS_AFTER = { min: 2, max: 5 };
const DELIVERED = new Set(["sent", "delivered", "queued", "accepted"]);
const FAILED = new Set(["failed", "undelivered"]);

function validate(payload = {}) {
  for (const key of ["userId", "bookingId"]) {
    if (!mongoose.Types.ObjectId.isValid(String(payload[key] || ""))) {
      throw new Error(`post_free_visit_sms needs ${key}`);
    }
  }
  return {
    userId: String(payload.userId),
    bookingId: String(payload.bookingId),
    completedAt: payload.completedAt ? new Date(payload.completedAt) : null,
  };
}

/** The next moment inside the marketing window, or null if we are in it. */
function nextWindowStart(now) {
  const local = moment.tz(now, TIMEZONE);
  const { startHour, endHour } = QUIET_HOURS.marketing;
  if (local.hour() >= startHour && local.hour() < endHour) return null;
  const start = local.clone().startOf("day").hour(startHour).minute(5);
  return (local.hour() >= endHour ? start.add(1, "day") : start).toDate();
}

async function execute(payload, { now }) {
  const wait = nextWindowStart(now);
  if (wait) return { outcome: "defer", until: wait };

  const user = await User.findById(payload.userId).select(
    "_id userId name phone role employeePosition excludeFromMarketing isActive smsPreferences"
  );
  if (!user) return { outcome: "skip", reason: "user_not_found" };
  if (user.excludeFromMarketing === true || user.employeePosition || String(user.role || "customer") !== "customer") {
    return { outcome: "skip", reason: "not_marketable" };
  }
  if (user.smsPreferences?.marketingEnabled !== true) return { outcome: "skip", reason: "no_marketing_sms_consent" };
  const { audience } = await resolveAudience(user, now);
  if (audience === "member") return { outcome: "skip", reason: "already_member" };

  const sent = await sendMarketingSms({
    notificationType: NOTIFICATION_TYPE,
    dedupeKey: `${TYPE}:${payload.bookingId}`,
    user,
    source: "growth_engine",
    now,
  });

  if (sent.status === "simulated") return { outcome: "skip", reason: "sms_sending_disabled" };
  if (sent.status === "duplicate") return { outcome: "skip", reason: "already_sent" };
  if (sent.status === "suppressed") return { outcome: "skip", reason: `suppressed:${sent.reason}` };
  if (!sent.id) throw new Error(`SMS not queued: ${sent.status || "unknown"}`);
  return { outcome: "done", result: { smsMessageId: String(sent.id), status: sent.status || null } };
}

async function verify(action) {
  const id = action.result?.smsMessageId;
  if (!id) return { passed: false, detail: "no SMS record" };
  const row = await SmsMessage.findById(id).select("status").lean();
  const status = String(row?.status || "");
  if (DELIVERED.has(status)) return { passed: true, detail: `SMS ${status}` };
  if (FAILED.has(status)) return { passed: false, detail: `SMS ${status}` };
  return { passed: null, detail: `SMS ${status || "missing"}` };
}

defineAction({
  type: TYPE,
  label: "Text after the free visit",
  description:
    "One marketing text, 2-5 days after a completed free first visit, to non-members who opted in to marketing texts. Consent, opt-outs and the 11am-6pm window are enforced by the SMS system.",
  riskTier: "medium",
  defaultMode: "shadow",
  maxMode: "autonomous",
  promoteAfter: 5,
  limits: { perDay: 10 },
  approvalTtlMs: 2 * 24 * 60 * 60 * 1000,
  verifyAfterMs: 30 * 60 * 1000,
  maxAttempts: 2,
  validate,
  describe: () => "Text a customer whose free visit was completed this week",
  subjectOf: (p) => ({ entityType: "booking", entityId: p.bookingId }),
  execute,
  verify,
});

/**
 * Find candidates and propose. Cheap pre-filter only - everything is
 * re-checked when the action runs - so the queue is not full of people who
 * could never receive it.
 */
async function proposePostFreeVisitTexts({ propose, now = new Date() } = {}) {
  const from = new Date(now.getTime() - DAYS_AFTER.max * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() - DAYS_AFTER.min * 24 * 60 * 60 * 1000);
  const bookings = await Booking.find({
    isFreeFirstVisit: true,
    completedAt: { $gte: from, $lte: to },
  })
    .select("_id user completedAt")
    .limit(200)
    .lean();

  let proposed = 0;
  for (const b of bookings) {
    if (!b.user) continue;
    const user = await User.findById(b.user).select("smsPreferences role").lean();
    if (user?.smsPreferences?.marketingEnabled !== true) continue;
    const { created } = await propose(
      TYPE,
      { userId: String(b.user), bookingId: String(b._id), completedAt: b.completedAt },
      {
        idempotencyKey: `${TYPE}:${b._id}`,
        rationale: "Free first visit completed; not a member yet; opted in to marketing texts.",
        proposedBy: { kind: "system", name: "Free-visit follow-up" },
        now,
      }
    );
    if (created) proposed += 1;
  }
  return { proposed };
}

module.exports = { TYPE, nextWindowStart, proposePostFreeVisitTexts, validate, execute, verify };
