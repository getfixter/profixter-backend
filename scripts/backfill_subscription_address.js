require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");
const Subscription = require("../models/Subscription");

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log("✅ Connected to MongoDB");

    const subs = await Subscription.find({ $or: [{ addressId: null }, { addressId: { $exists: false } }] });
    let updated = 0;

    for (const s of subs) {
      const user = await User.findById(s.user);
      if (!user) continue;
      if (!user.defaultAddressId) continue;
      const subdoc = user.addresses.id(user.defaultAddressId);
      if (!subdoc) continue;

      s.addressId = subdoc._id;
      s.addressSnapshot = {
        line1: subdoc.line1, city: subdoc.city, state: subdoc.state, zip: subdoc.zip, county: subdoc.county || ""
      };
      await s.save();
      updated++;
      console.log(`→ Linked sub ${s._id} to address ${subdoc._id} for ${user.email}`);
    }

    console.log(`✅ Done. Subscriptions updated: ${updated}`);
    process.exit(0);
  } catch (e) {
    console.error("❌ Migration error:", e);
    process.exit(1);
  }
})();
