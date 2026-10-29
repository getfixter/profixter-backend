const mongoose = require("mongoose");

/**
 * One sign-in code we sent, by text or email.
 *
 * THE CODE ITSELF IS NEVER STORED. Only an HMAC of it, keyed with a server
 * secret and bound to the channel and the address it was sent to, so a leaked
 * row is useless and a code sent to one number cannot be replayed for another.
 *
 * Single use and short lived: consumedAt is claimed with a conditional update,
 * so two requests racing the same code produce one sign-in, and the TTL index
 * removes the row a day after it expires.
 */
const AuthChallengeSchema = new mongoose.Schema(
  {
    channel: { type: String, enum: ["sms", "email"], required: true },
    /** E.164 phone or lowercased email. */
    target: { type: String, required: true },
    /* "reset" codes are a separate kind: they can never sign anybody in, and vice versa. */
    purpose: { type: String, enum: ["auth", "attach", "reset"], default: "auth" },
    provider: { type: String, enum: ["local", "twilio_verify"], default: "local" },
    codeHash: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    /** Replaced by a newer code for the same target. */
    supersededAt: { type: Date, default: null },
    ipHash: { type: String, default: "" },
    /*
     * The SMS consent ticks given alongside the number, carried to the moment
     * the account is created. Recorded only for an account that is new.
     */
    consent: {
      transactional: { type: Boolean, default: false },
      marketing: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

AuthChallengeSchema.index({ channel: 1, target: 1, purpose: 1, createdAt: -1 });
AuthChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model("AuthChallenge", AuthChallengeSchema);
