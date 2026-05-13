const mongoose = require("mongoose");
const User = require("../models/User");
require("dotenv").config();

function normalizeUSPhone(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";

  if (digits.length === 10) digits = "1" + digits;

  if (digits.length === 11 && digits.startsWith("1")) {
    return "+" + digits;
  }

  return "";
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