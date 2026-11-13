const mongoose = require("mongoose");

/**
 * "A charge is being started for this customer": held for the few
 * milliseconds between the repeat check and writing the AdditionalCharge, so
 * two presses on two screens at the same moment are taken one after the other
 * (the second then sees the first and asks "Charge it again?").
 *
 * One document per customer (or per guest booking), keyed by _id. Each holder
 * has its own random token, so two requests in the same server process never
 * both hold it. Expired holds are simply taken over; old documents are
 * removed by the TTL index.
 */
const ExtraChargeLockSchema = new mongoose.Schema(
  {
    _id: { type: String },
    owner: { type: String, required: true },
    until: { type: Date, required: true },
  },
  { versionKey: false }
);
ExtraChargeLockSchema.index({ until: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.models.ExtraChargeLock || mongoose.model("ExtraChargeLock", ExtraChargeLockSchema, "extra_charge_locks");
