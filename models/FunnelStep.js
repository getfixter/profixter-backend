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
 *
 * The membership path (from 2026-11-18): a homepage plans link was tapped, the
 * plans page was shown, a plan was chosen. The paid membership itself is the
 * Subscription record, credited to the same first-touch source by the overview.
 * home_plans_click   a plans link on the homepage was tapped
 * plans_view         /membership/plans was shown
 * plan_selected      a plan's Choose button was pressed (new members, any page)
 *
 * The welcome entry on profixter.com (from 2026-11-19). The first tap is the
 * question "does the new entry get people moving"; the paid membership (the
 * Subscription, joined through SiteVisitor.welcome) is "does it work".
 * welcome_shown              the welcome screen was shown to a new visitor
 * welcome_tap_membership     first screen: "A handyman membership"
 * welcome_tap_one_time       first screen: "A one-time visit"
 * welcome_exit_home          left for the current homepage (logo or menu)
 * welcome_nudge_membership   one-time nudge: "Show me membership"
 * welcome_nudge_one_time     one-time nudge: "Continue with one visit"
 * welcome_address_done       the service address was accepted (in the area)
 * welcome_slot_done          a real time was held
 * welcome_job_done           the job screen was finished
 * welcome_contact_done       name, phone and email were given
 * welcome_plans_view         the compact plan comparison was shown
 * welcome_checkout_started   Stripe returned a checkout page (either path)
 */
const STEPS = [
  "booking_page_view",
  "booker_started",
  "slot_selected",
  "signup_view",
  "request_submitted",
  "request_failed",
  "home_plans_click",
  "plans_view",
  "plan_selected",
  "welcome_shown",
  "welcome_tap_membership",
  "welcome_tap_one_time",
  "welcome_exit_home",
  "welcome_nudge_membership",
  "welcome_nudge_one_time",
  "welcome_address_done",
  "welcome_slot_done",
  "welcome_job_done",
  "welcome_contact_done",
  "welcome_plans_view",
  "welcome_checkout_started",
];

/* The steps that stamp the browser's own SiteVisitor.welcome record (first time only). */
const WELCOME_STAMPS = {
  welcome_shown: "shown",
  welcome_tap_membership: "membership",
  welcome_tap_one_time: "one_time",
  welcome_exit_home: "home",
};

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

module.exports = { FunnelStep, FunnelStepSeen, STEPS, WELCOME_STAMPS };
