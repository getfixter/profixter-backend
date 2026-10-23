const mongoose = require("mongoose");

/*
 * One document that every free-visit claim writes inside its transaction.
 *
 * The lifetime rule ("one free visit per person, across guest requests and
 * accounts") is a read-then-write: look for history, then create the visit.
 * Two claims for the same person arriving together would both read "nothing
 * yet". Writing this single document in each claim's transaction makes the
 * second one hit a write conflict; MongoDB's withTransaction retries it, the
 * retry reads a snapshot that now contains the first claim, and refuses.
 *
 * Free visits are a handful a day, so serialising all of them costs nothing.
 */
const FreeVisitLockSchema = new mongoose.Schema(
  {
    _id: { type: String },
    seq: { type: Number, default: 0 },
    lastAt: { type: Date, default: null },
  },
  { versionKey: false }
);

module.exports = mongoose.model("FreeVisitLock", FreeVisitLockSchema);
