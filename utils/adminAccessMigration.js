const User = require("../models/User");
const { SECTIONS_VERSION } = require("./adminAccess");

/**
 * Brings employees saved under an older SECTIONS_VERSION up to date, once.
 *
 * Version 2 split Growth from Overview: both used to be one permission, so
 * whoever had Overview could also open Growth. Each such employee gets the
 * Growth section added and keeps exactly the access they had. Everyone is
 * then stamped with the current version, and every save in the employee
 * editor stamps it too, so a later "Growth off" from the owner is never undone.
 *
 * Idempotent and safe on several instances at once: it only touches records
 * without the current version, and $addToSet cannot add Growth twice.
 */
async function migrateAdminSections() {
  const stale = { role: "employee", adminSectionsVersion: { $ne: SECTIONS_VERSION } };
  const growth = await User.updateMany(
    { ...stale, adminSections: "overview" },
    { $addToSet: { adminSections: "growth" }, $set: { adminSectionsVersion: SECTIONS_VERSION } }
  );
  const rest = await User.updateMany(stale, { $set: { adminSectionsVersion: SECTIONS_VERSION } });
  const result = { growthAdded: growth.modifiedCount ?? growth.nModified ?? 0, stamped: rest.modifiedCount ?? rest.nModified ?? 0 };
  console.log(`admin_sections_migration ${JSON.stringify(result)}`);
  return result;
}

module.exports = { migrateAdminSections };
