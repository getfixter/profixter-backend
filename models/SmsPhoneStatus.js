const mongoose = require("mongoose");

/**
 * What we have learned about whether a phone number can actually receive SMS.
 *
 * KEYED BY THE NORMALIZED NUMBER, NOT BY A USER, AND THAT IS THE WHOLE DESIGN.
 *
 * Deliverability is a property of the handset, not of an account. The same
 * number may sit on two User records (a customer and a Fixter can share one
 * under the {email, role} index), on a booking taken over the phone with no
 * account at all, or on an account that later changes it. Recording "this
 * number is dead" against a user would be recording it in the wrong place, and
 * would go stale the moment anything moved.
 *
 * Two requirements fall out of this for free rather than needing code:
 *
 *   - A customer who CHANGES their number gets a different E.164 key, which
 *     has no row, which reads as unknown. Nothing has to detect the change or
 *     reset anything, so nothing can forget to.
 *   - A customer who merely REFORMATS the same number - (631) 599-1363 instead
 *     of 631-599-1363 - normalizes to the same key and keeps its history.
 *
 * DELIBERATELY SEPARATE FROM SmsOptOut, which is the same shape for the same
 * reason. Consent and deliverability are different facts with different
 * lifetimes: a person who opted out has a working phone, and a dead number has
 * expressed no preference. Merging them would make one unreadable through the
 * other.
 */
const SmsPhoneStatusSchema = new mongoose.Schema(
  {
    /** E.164, always. Normalised by the caller before it reaches here. */
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },

    /*
     * unknown        Well-formed, never proven either way. The starting state
     *                for every number, including one that just passed
     *                validation: correct formatting is not evidence that a
     *                number exists or can receive a text.
     * valid          A carrier confirmed delivery to it at least once.
     * undeliverable  A carrier told us, permanently, that this number cannot
     *                receive our messages.
     */
    status: {
      type: String,
      enum: ["unknown", "valid", "undeliverable"],
      required: true,
      default: "unknown",
      index: true,
    },

    /** The last time a carrier confirmed delivery. Evidence for "valid". */
    lastSuccessAt: { type: Date, default: null },

    /*
     * The last failure of ANY kind, including transient ones. Recorded even
     * when the status does not move, because "this number has failed eleven
     * times this week with timeouts" is exactly the pattern an operator needs
     * to see, and it is invisible if only permanent failures are kept.
     */
    lastFailureAt: { type: Date, default: null },
    lastFailureCode: { type: String, default: "" },
    lastFailureReason: { type: String, default: "" },

    /** When the number became undeliverable, and what proved it. */
    undeliverableAt: { type: Date, default: null },
    undeliverableCode: { type: String, default: "" },
    undeliverableReason: { type: String, default: "" },

    /** Running totals, so a flaky number is distinguishable from a dead one. */
    successCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },

    /** Which message last taught us something. Context for the audit only. */
    lastNotificationType: { type: String, default: "" },
  },
  { timestamps: true }
);

/** Admin: "show me every number we have given up on", newest first. */
SmsPhoneStatusSchema.index(
  { status: 1, undeliverableAt: -1 },
  { name: "sms_phone_status_idx" }
);

module.exports = mongoose.model("SmsPhoneStatus", SmsPhoneStatusSchema);
