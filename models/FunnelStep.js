const mongoose = require("mongoose");

/**
 * The booking funnel, counted per day, step and first-touch source.
 *
 * Steps (fired by the site): booking_page_view, booker_started, slot_selected,
 * signup_view. The booking itself and the account are already recorded by
 * the backend, so they are not duplicated here. A browser counts once per
 * step per New York day (FunnelStepSeen, which expires after 3 days), so a
 * reload does not inflate the funnel. No personal data: a random browser id
 * is used only for that de-duplication and is not kept in the daily counts.
 */
/*
 * booking_page_view  the free-visit booker was shown
 * booker_started     the visitor first typed into / tapped the booker
 * slot_selected      a day and time were chosen
 * signup_view        the sign-up screen was shown (signed-out booker, before Nov 3)
 * request_submitted  the server accepted a free-visit request   (from 2026-11-17)
 * request_failed     a submit was refused or never reached us    (from 2026-11-17)
 */
const STEPS = ["booking_page_view", "booker_started", "slot_selected", "signup_view", "request_submitted", "request_failed"];

const funnelStepSchema = new mongoose.Schema(
  {
    date: { type: String, required: true }, // YYYY-MM-DD, America/New_York
    step: { type: String, enum: STEPS, required: true },
    source: { type: String, default: "direct" },
    count: { type: Number, default: 0 },
  },
  { timestamps: false }
);
funnelStepSchema.index({ date: 1, step: 1, source: 1 }, { unique: true });

const funnelStepSeenSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // visitorId|step|date
  expiresAt: { type: Date, required: true },
});
funnelStepSeenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const FunnelStep = mongoose.models.FunnelStep || mongoose.model("FunnelStep", funnelStepSchema);
const FunnelStepSeen = mongoose.models.FunnelStepSeen || mongoose.model("FunnelStepSeen", funnelStepSeenSchema);

module.exports = { FunnelStep, FunnelStepSeen, STEPS };
