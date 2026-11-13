const mongoose = require("mongoose");

/*
 * A blocked customer.
 *
 * A block applies to the PERSON: the account id, the email (lowercased) and
 * the phone (phoneDigits, ten US digits). Never to an address - a household or
 * a new owner at the same house is somebody else. utils/customerBlock.js is
 * the one reader that decides "is this person blocked?".
 *
 * LIFTING KEEPS HISTORY. Unblocking used to delete the entry, so nobody could
 * see later that a person had ever been blocked, or why. Now an unblock stamps
 * liftedAt / liftedBy / liftReason and the entry stays.
 *
 * Every find on this model ignores lifted entries unless the query opts in with
 * .setOptions({ includeLifted: true }). That keeps every existing reader
 * (campaign audiences, the project customer picker, the SMS confirm link)
 * meaning exactly what it meant before - "currently blocked" - without each of
 * them having to know about lifting.
 */
const BlacklistSchema = new mongoose.Schema(
  {
    user:   { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    userId: { type: String },
    name:   { type: String },
    email:  { type: String, index: true, lowercase: true, trim: true },
    phone:  { type: String },
    /* Ten US digits of `phone`, for matching any way a number is written. */
    phoneDigits: { type: String, default: "", index: true },
    address:{ type: String },
    city:   { type: String },
    county: { type: String },
    state:  { type: String },
    zip:    { type: String },
    reason: { type: String },
    createdAt: { type: Date, default: Date.now },
    blockedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    blockedByName: { type: String, default: "" },

    liftedAt: { type: Date, default: null, index: true },
    liftedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    liftedByName: { type: String, default: "" },
    liftReason: { type: String, default: "" },
  },
  { versionKey: false }
);

function digitsOf(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

BlacklistSchema.pre("validate", function stampPhoneDigits(next) {
  this.phoneDigits = digitsOf(this.phone);
  next();
});

function activeOnly() {
  if (this.getOptions().includeLifted) return;
  const filter = this.getFilter();
  if (Object.prototype.hasOwnProperty.call(filter, "liftedAt")) return;
  this.where({ liftedAt: null });
}

for (const op of ["find", "findOne", "countDocuments", "findOneAndUpdate", "findOneAndDelete", "updateOne", "updateMany", "deleteOne", "deleteMany"]) {
  BlacklistSchema.pre(op, activeOnly);
}

module.exports = mongoose.model("Blacklist", BlacklistSchema);
module.exports.blacklistPhoneDigits = digitsOf;
