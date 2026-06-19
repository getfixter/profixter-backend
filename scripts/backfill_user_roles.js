require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/User");

const WRITE = process.argv.includes("--write");
const ADMIN_EMAIL = String(
  process.env.MAIL_ADMIN || "getfixter@gmail.com"
).toLowerCase();

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await mongoose.connect(process.env.MONGO_URI);

  const users = await User.collection.find({}).toArray();
  let changed = 0;
  for (const user of users) {
    const expectedRole =
      String(user.email || "").toLowerCase() === ADMIN_EMAIL
        ? "admin"
        : user.role || "customer";
    const updates = {};
    if (user.role !== expectedRole) updates.role = expectedRole;
    if (user.isActive === undefined) updates.isActive = true;

    if (Object.keys(updates).length) {
      changed++;
      console.log(JSON.stringify({ userId: String(user._id), email: user.email, updates }));
      if (WRITE) await User.collection.updateOne({ _id: user._id }, { $set: updates });
    }
  }

  console.log(JSON.stringify({ dryRun: !WRITE, scanned: users.length, changed }));
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
