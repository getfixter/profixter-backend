const mongoose = require("mongoose");

/**
 * The consent history: one row per thing that happened, never edited.
 *
 * The preference fields on User (smsPreferences, emailPreferences) and the
 * SmsOptOut / EmailSuppression rows are the CURRENT state, and they are what
 * every send decision reads. They can only say how things stand now. This is
 * the record of how they got there: who agreed to what, on which screen, under
 * which exact wording, from which phone or email, and when they took it back.
 *
 * APPEND-ONLY, IN CODE. Updates and deletes are refused by the hooks below, so
 * a later script cannot quietly rewrite what a customer agreed to. A correction
 * is a new row that says so.
 *
 * It decides nothing. No eligibility check reads it; it exists to answer
 * "why is this customer opted in, and can we prove it".
 */
const ConsentEventSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    channel: { type: String, enum: ["sms", "email"], required: true },
    purpose: { type: String, enum: ["marketing", "service", "all"], required: true },
    /*
     * granted / withdrawn: the customer's own choice on a form or setting.
     * stop / start: a keyword from the handset (start lifts the block only).
     * unsubscribed / resubscribed: the email suppression list.
     * reset: consent withdrawn by us because the destination changed.
     */
    action: { type: String, enum: ["granted", "withdrawn", "stop", "start", "unsubscribed", "resubscribed", "reset"], required: true },
    source: { type: String, required: true },
    /* The wording the customer saw, and its version - only for a choice they made. */
    consentVersion: { type: String, default: "" },
    consentText: { type: String, default: "" },
    /* The destination the event is about, as it was at the time. */
    phone: { type: String, default: "" },
    email: { type: String, default: "" },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    detail: { type: String, default: "" },
    at: { type: Date, required: true, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ConsentEventSchema.index({ user: 1, channel: 1, at: -1 });
ConsentEventSchema.index({ phone: 1, at: -1 });
ConsentEventSchema.index({ email: 1, at: -1 });

function refuse() {
  throw new Error("ConsentEvent is append-only: record a new event instead of changing one");
}
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete", "findOneAndReplace"]) {
  ConsentEventSchema.pre(op, refuse);
}
ConsentEventSchema.pre("save", function onlyNew(next) {
  if (!this.isNew) return next(new Error("ConsentEvent is append-only: record a new event instead of changing one"));
  return next();
});

module.exports = mongoose.models.ConsentEvent || mongoose.model("ConsentEvent", ConsentEventSchema);
