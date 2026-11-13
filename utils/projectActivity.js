/**
 * Activity logging for project documents (agreements, change orders,
 * invoices, payments, leads).
 *
 * The AdminActivityLog entry is the owner's after-the-fact record of who did
 * what. It must never be the reason a real action fails, so a logging error is
 * reported to the console and swallowed: the document's own audit history
 * (written in the same save as the change) remains the authoritative trail.
 */

const { createAdminActivityLog } = require("./adminActivityLog");

async function logProjectActivity(req, { action, entityType, entityId, entityName = "", before, after, reason, details = {} }) {
  try {
    return await createAdminActivityLog(req, {
      action,
      entityType,
      entityId,
      entityName,
      details: {
        ...details,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(reason ? { reason: String(reason).slice(0, 1000) } : {}),
      },
    });
  } catch (error) {
    console.error(`activity log failed (${action}):`, error?.message);
    return null;
  }
}

module.exports = { logProjectActivity };
