const mongoose = require("mongoose");

/**
 * A configurable marketing SMS campaign.
 *
 * WHY THIS IS A DOCUMENT AND NOT A CONSTANT
 * A hardcoded campaign is a campaign that runs forever. The kitchen and bath
 * promotion is seasonal, the membership push has to be throttled by hand once
 * we see how it lands, and neither should need a deploy to change, pause or
 * retarget. Everything an operator would want to adjust lives here.
 *
 * WHAT IT DELIBERATELY DOES NOT CONTROL
 * Consent, opt-out, quiet hours and the global SMS_ENABLED switch are not
 * fields on this document. A campaign must not be able to configure its way
 * past a compliance rule, so those are enforced in the eligibility engine
 * regardless of what any campaign says.
 */
const SmsCampaignSchema = new mongoose.Schema(
  {
    /** Stable, versioned slug, e.g. "kitchen_bath_spring_2026_v1". */
    campaignId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ["kitchen_bath", "membership", "seasonal", "other"],
      required: true,
      index: true,
    },

    /**
     * Off until switched on, always.
     *
     * A campaign created by an admin must never start sending because it was
     * saved. Creating it and running it are two decisions.
     */
    enabled: { type: Boolean, default: false, index: true },

    /*
     * The audience.
     *
     * Expressed as named predicates rather than a raw Mongo query, because a
     * stored query is an injection surface and because "everyone without an
     * active membership" is a business rule that has to stay correct as the
     * subscription model changes. The runner resolves these against live state.
     */
    audience: {
      membership: {
        type: String,
        enum: ["non_member", "member", "former_member", "any"],
        default: "non_member",
      },
      /** Only people who have ever completed a visit. Warmer, and far safer. */
      requiresCompletedBooking: { type: Boolean, default: false },
      /** Skip anyone who booked in the last N days; 0 disables the rule. */
      excludeBookedWithinDays: { type: Number, default: 0, min: 0 },
      /** Only accounts at least this old, so we never market at a new signup. */
      minAccountAgeDays: { type: Number, default: 30, min: 0 },
    },

    /** Template key in utils/sms/smsTemplates, or literal copy. Not both. */
    templateKey: { type: String, default: "" },
    body: { type: String, default: "" },

    /*
     * Pacing.
     *
     * Conservative defaults on every one of these. The failure mode of a
     * marketing SMS system is not sending too few.
     */
    frequency: {
      /** Days before the same person may receive this campaign again. */
      cooldownDays: { type: Number, default: 180, min: 1 },
      /** Days between ANY two marketing texts to one person. */
      minDaysBetweenAnyMarketing: { type: Number, default: 30, min: 1 },
      /** Hard ceiling on how many cycles one person may ever receive. */
      maxSendsPerPerson: { type: Number, default: 2, min: 1 },
    },
    /** Ceilings per run and per day, so a mistake stays small. */
    limits: {
      maxPerRun: { type: Number, default: 25, min: 0 },
      maxPerDay: { type: Number, default: 100, min: 0 },
    },

    /** New York local hours this campaign may send in. Narrows, never widens. */
    sendWindow: {
      startHour: { type: Number, default: 11, min: 0, max: 23 },
      endHour: { type: Number, default: 18, min: 0, max: 23 },
      /** 0=Sunday. Weekdays and Saturday by default; never a Sunday morning. */
      daysOfWeek: { type: [Number], default: [1, 2, 3, 4, 5, 6] },
    },

    /** Optional calendar bounds, for a genuinely seasonal push. */
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },

    stats: {
      totalClaimed: { type: Number, default: 0 },
      totalSent: { type: Number, default: 0 },
      totalFailed: { type: Number, default: 0 },
      lastRunAt: { type: Date, default: null },
    },

    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

SmsCampaignSchema.index({ enabled: 1, category: 1 }, { name: "sms_campaign_active_idx" });

module.exports = mongoose.model("SmsCampaign", SmsCampaignSchema);
