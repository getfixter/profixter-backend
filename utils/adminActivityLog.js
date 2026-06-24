const AdminActivityLog = require("../models/AdminActivityLog");

function getIpAddress(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return forwarded[0] || req.ip || req.socket?.remoteAddress || "";
}

function actorFromRequest(req) {
  const actor = req.accessUser || req.authUser || {};
  return {
    actorUserId: req.user?.id || actor._id || null,
    actorName: actor.name || actor.email || "Admin",
    actorRole: req.accessRole || actor.role || "admin",
  };
}

async function createAdminActivityLog(req, payload) {
  const actor = actorFromRequest(req);
  return AdminActivityLog.create({
    action: payload.action,
    entityType: payload.entityType,
    entityId: String(payload.entityId || ""),
    entityName: String(payload.entityName || ""),
    actorUserId: actor.actorUserId,
    actorName: actor.actorName,
    actorRole: actor.actorRole,
    details: payload.details || {},
    ipAddress: getIpAddress(req),
  });
}

async function markAdminActivityLog(log, patch) {
  if (!log?._id) return null;
  return AdminActivityLog.findByIdAndUpdate(
    log._id,
    {
      $set: {
        ...(patch.action ? { action: patch.action } : {}),
        ...(patch.details ? { details: patch.details } : {}),
      },
    },
    { new: true }
  );
}

module.exports = {
  createAdminActivityLog,
  markAdminActivityLog,
};
