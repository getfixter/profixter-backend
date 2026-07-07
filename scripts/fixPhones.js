const mongoose = require("mongoose");
const User = require("../models/User");
const { normalizePhoneE164 } = require("../utils/identity");
require("dotenv").config();

function normalizeUSPhone(phone) {
  return normalizePhoneE164(phone) || "";
}

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const users = await User.find({});
  let updated = 0;
  let invalid = 0;

  for (const user of users) {
    const oldPhone = user.phone || "";
    const normalized = normalizeUSPhone(oldPhone);

    if (!normalized) {
      if (oldPhone) {
        console.log(`Invalid phone for user ${user.email}: ${oldPhone}`);
        invalid++;
      }
      continue;
    }

    if (oldPhone !== normalized) {
      user.phone = normalized;
      await user.save();
      updated++;
      console.log(`Updated ${user.email}: ${oldPhone} -> ${normalized}`);
    }
  }

  console.log({ updated, invalid });
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
