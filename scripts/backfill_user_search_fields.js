const mongoose = require("mongoose");
require("dotenv").config();

const User = require("../models/User");

function sanitizeValidationError(error) {
  if (!error) return "Unknown error";
  if (error.name === "ValidationError" && error.errors) {
    return Object.values(error.errors)
      .map((entry) => entry.message)
      .filter(Boolean)
      .slice(0, 4)
      .join("; ");
  }
  return String(error.message || error).slice(0, 500);
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGO_URI/MONGODB_URI is required");
  }

  const write = process.argv.includes("--write");
  await mongoose.connect(uri, { autoIndex: false });

  let scanned = 0;
  let requiringUpdates = 0;
  let updated = 0;
  let skipped = 0;
  let malformed = 0;
  const malformedSamples = [];
  const cursor = User.find({ role: "customer", isActive: true })
    .sort({ _id: 1 })
    .cursor();

  for await (const user of cursor) {
    scanned += 1;
    const before = JSON.stringify(user.search || {});
    try {
      user.markModified("search");
      await user.validate();
      const after = JSON.stringify(user.search || {});
      if (before === after) {
        skipped += 1;
        continue;
      }

      requiringUpdates += 1;
      if (write) {
        await user.save();
        updated += 1;
      }
    } catch (error) {
      malformed += 1;
      if (malformedSamples.length < 10) {
        malformedSamples.push({
          userId: String(user._id || ""),
          reason: sanitizeValidationError(error),
        });
      }
    }
  }

  await mongoose.disconnect();
  console.log(
    JSON.stringify(
      {
        mode: write ? "write" : "dry-run",
        totalUsersScanned: scanned,
        usersRequiringUpdates: requiringUpdates,
        usersSkipped: skipped,
        malformedRecords: malformed,
        ...(write ? { usersUpdated: updated } : {}),
        malformedSamples,
      },
      null,
      2
    )
  );
}

main().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch (_disconnectError) {
    // Ignore cleanup errors.
  }
  process.exit(1);
});
