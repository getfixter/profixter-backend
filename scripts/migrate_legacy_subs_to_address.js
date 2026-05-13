// 📁 backend/scripts/migrate_legacy_subs_to_address.js
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");
const Subscription = require("../models/Subscription");

(async () => {
  try {
    const MONGO =
      process.env.MONGO_URI ||
      process.env.MONGODB_URI ||
      "mongodb://127.0.0.1:27017/handyman";

    await mongoose.connect(MONGO);
    console.log("✅ Connected to MongoDB");

    const users = await User.find({
      subscription: { $nin: [null, "", undefined, "none"] },
      defaultAddressId: { $ne: null },
    });

    let created = 0,
      skipped = 0;

    for (const u of users) {
      const addrId = String(u.defaultAddressId || "");
      const addr = (u.addresses || []).find((a) => String(a._id) === addrId);
      if (!addr) {
        skipped++;
        continue;
      }

      const exists = await Subscription.findOne({
        user: u._id,
        addressId: u.defaultAddressId,
        status: { $in: ["active", "trialing"] },
      });
      if (exists) {
        skipped++;
        continue;
      }

      const plan = String(u.subscription).toLowerCase();
      const now = new Date();
      const start = u.subscriptionStart || now;

      await Subscription.create({
        user: u._id,
        userId: u.userId,
        subscriptionType: plan,
        addressId: u.defaultAddressId,
        addressSnapshot: {
          line1: addr.line1,
          city: addr.city,
          state: addr.state,
          zip: addr.zip,
          county: addr.county || "",
        },
        startDate: start,
        latestPaymentDate: start,
        nextPaymentDate:
          u.subscriptionExpiry ||
          new Date(now.getTime() + 30 * 24 * 3600 * 1000),
        status: "active",
        planPrice: null,
        paymentMethod: "legacy-migrated",
      });

      created++;
    }

    console.log(`✅ Done. Created: ${created}, Skipped: ${skipped}`);
    process.exit(0);
  } catch (e) {
    console.error("❌ Migration error:", e);
    process.exit(1);
  }
})();
