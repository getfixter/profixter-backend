const mongoose = require("mongoose");
require("dotenv").config();

const User = require("../models/User");
const {
  buildUserSearchFields,
  isProjectSelectableCustomer,
  isSearchFieldsCurrent,
  projectSelectableCustomerEligibilityQuery,
} = require("../utils/projectCustomerSelection");

function sanitizeError(error) {
  return String(error?.message || error || "Unknown error").slice(0, 500);
}

function roleBucket(user = {}) {
  const role = String(user.role ?? "missing").trim().toLowerCase() || "missing";
  return role;
}

function activityBucket(user = {}) {
  if (user.isActive === false) return "isActive:false";
  if (!Object.prototype.hasOwnProperty.call(user, "isActive")) return "isActive:missing";
  if (user.isActive === true) return "isActive:true";
  return "isActive:other";
}

function hasAnySearchField(user = {}) {
  const search = user.search || {};
  return Boolean(
    (Array.isArray(search.names) && search.names.length) ||
      (Array.isArray(search.emails) && search.emails.length) ||
      search.phone ||
      (Array.isArray(search.addresses) && search.addresses.length)
  );
}

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGO_URI/MONGODB_URI is required");
  }

  const write = process.argv.includes("--write");
  await mongoose.connect(uri, { autoIndex: false });

  const report = {
    mode: write ? "write" : "dry-run",
    database: mongoose.connection.name,
    totalUsersScanned: 0,
    totalEligibleUsers: 0,
    usersWithCompleteSearchFields: 0,
    usersWithMissingSearchFields: 0,
    usersWithStaleSearchFields: 0,
    usersRequiringUpdates: 0,
    usersSkipped: 0,
    usersUpdated: 0,
    malformedRecords: 0,
    usersExcludedByRole: 0,
    usersExcludedByActivityState: 0,
    usersExcludedAsInternalOrDeleted: 0,
    excludedRoleCounts: {},
    excludedActivityCounts: {},
    malformedSamples: [],
  };

  const cursor = User.find({}).sort({ _id: 1 }).cursor();

  for await (const user of cursor) {
    report.totalUsersScanned += 1;

    const selectable = isProjectSelectableCustomer(user);
    if (!selectable) {
      const role = roleBucket(user);
      const activity = activityBucket(user);
      if (user.isActive === false) {
        report.usersExcludedByActivityState += 1;
        increment(report.excludedActivityCounts, activity);
      } else if (["admin", "employee", "fixter", "general fixter", "technician", "staff", "system", "service", "internal"].includes(role) || user.employeePosition) {
        report.usersExcludedByRole += 1;
        increment(report.excludedRoleCounts, role || "employeePosition");
      } else {
        report.usersExcludedAsInternalOrDeleted += 1;
      }
      continue;
    }

    report.totalEligibleUsers += 1;

    try {
      const current = isSearchFieldsCurrent(user);
      const hasSearch = hasAnySearchField(user);
      if (current) {
        report.usersWithCompleteSearchFields += 1;
        report.usersSkipped += 1;
        continue;
      }

      if (!hasSearch) report.usersWithMissingSearchFields += 1;
      else report.usersWithStaleSearchFields += 1;
      report.usersRequiringUpdates += 1;

      if (write) {
        await User.updateOne(
          { _id: user._id },
          { $set: { search: buildUserSearchFields(user) } },
          { runValidators: false }
        );
        report.usersUpdated += 1;
      }
    } catch (error) {
      report.malformedRecords += 1;
      if (report.malformedSamples.length < 10) {
        report.malformedSamples.push({
          userId: String(user._id || ""),
          reason: sanitizeError(error),
        });
      }
    }
  }

  const indexedEligibleCount = await User.countDocuments(projectSelectableCustomerEligibilityQuery());
  report.indexedEligibleQueryCount = indexedEligibleCount;

  await mongoose.disconnect();
  console.log(JSON.stringify(report, null, 2));
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
