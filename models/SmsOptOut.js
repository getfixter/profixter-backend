const mongoose = require("mongoose");

/**
 * SMS consent state, keyed by phone number rather than by user.
 *
 * WHY NOT A FIELD ON USER
 * A STOP arrives from a phone number and nothing else. There may be no account
 * behind it, there may be two (a customer and a Fixter can share a number under
 * the {email, role} index on User), and the number may have been recycled to
 * somebody who never had an account. A carrier opt-out applies to the handset,
 * so the handset is what we record it against.
 *
 * User-level preferences still exist on User.smsPreferences: those are choices
 * a person makes about their account. This is the compliance layer, and it wins
 * over both. Mirrors EmailSuppression, which is keyed by address for the same
 * reason.
 *
 * TWO SCOPES, ON PURPOSE
 * STOP is a total opt-out and blocks everything including service messages,
 * because that is what the carrier and Twilio will enforce regardless of what
 * we think. "marketing" is our own narrower suppression, for someone who wants
 * their appointment reminders but not our offers.
 */
const SmsOptOutSchema = new mongoose.Schema(
  {
    /** E.164, always. Normalised by the caller before it reaches here. */
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    scope: {
      type: String,
      enum: ["all", "marketing"],
      required: true,
      default: "all",
      index: true,
    },
    /**
     * Where the opt-out came from. "carrier_keyword" is a STOP we received,
     * "twilio_error" is Twilio telling us it refused a send to a number it
     * already had on its own suppression list (error 21610), which is how our
     * state stays synchronised with theirs even when the STOP never reached us.
     */
    source: {
      type: String,
      enum: ["carrier_keyword", "twilio_error", "admin", "customer_preference", "import"],
      required: true,
      default: "carrier_keyword",
      index: true,
    },
    /** The literal keyword received, when there was one. Audit only. */
    keyword: { type: String, default: "" },
    reason: { type: String, default: "" },
    optedOutAt: { type: Date, default: Date.now, required: true },
    /**
     * Set when the person sends START/UNSTOP. The row is kept rather than
     * deleted so the history of a number that opted out and back in survives,
     * which is the record you want when somebody disputes having consented.
     */
    optedInAt: { type: Date, default: null },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  },
  { timestamps: true }
);

/**
 * Whether this row currently blocks sending.
 *
 * A row with optedInAt later than optedOutAt is a resolved opt-out and blocks
 * nothing. Comparing the two timestamps rather than deleting the row means a
 * STOP that arrives after a START is still honoured in the right order.
 */
SmsOptOutSchema.methods.isActive = function isActive() {
  if (!this.optedInAt) return true;
  return new Date(this.optedInAt).getTime() < new Date(this.optedOutAt).getTime();
};

module.exports = mongoose.model("SmsOptOut", SmsOptOutSchema);
