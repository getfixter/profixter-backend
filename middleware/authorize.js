const User = require("../models/User");
const { PERMISSIONS, cleanSections, permissionsForSections, positionPermissions } = require("../utils/adminAccess");

/*
 * Permissions live in utils/adminAccess.js (the registry). This file turns a
 * user into their permissions on every request and guards routes with them.
 */

const ADMIN_EMAIL = String(
  process.env.MAIL_ADMIN || "getfixter@gmail.com"
).toLowerCase();

function effectiveRole(user) {
  if (String(user?.email || "").toLowerCase() === ADMIN_EMAIL) return "admin";
  return user?.role || "customer";
}

/**
 * The owner: everything, including permissions added later. An employee: their
 * field work plus the sections the owner switched on. A disabled employee, a
 * customer, anyone else: nothing.
 */
function permissionsForUser(user) {
  const role = effectiveRole(user);
  if (role === "admin") return Object.values(PERMISSIONS);
  if (role !== "employee" || user.isActive === false) return [];
  const out = new Set(positionPermissions(user.employeePosition));
  for (const p of permissionsForSections(user.adminSections)) out.add(p);
  // Belt and braces: the owner's key is never in a section, but never let it through.
  out.delete(PERMISSIONS.ADMIN);
  return [...out];
}

async function loadAccessUser(req, res, next) {
  try {
    const user = req.authUser || (await User.findById(req.user.id));
    if (!user) return res.status(401).json({ message: "User not found" });

    const role = effectiveRole(user);
    if (role === "employee" && user.isActive === false) {
      return res.status(403).json({ message: "Employee account is inactive" });
    }

    req.accessUser = user;
    req.accessRole = role;
    req.permissions = permissionsForUser(user);
    return next();
  } catch (error) {
    console.error("Authorization lookup failed:", error);
    return res.status(500).json({ message: "Server error" });
  }
}

function requirePermission(permission) {
  return [
    loadAccessUser,
    (req, res, next) => {
      if (
        req.accessRole === "admin" ||
        req.permissions.includes(permission)
      ) {
        return next();
      }
      return res.status(403).json({ message: "Access denied" });
    },
  ];
}

/** Any one of several permissions (e.g. a timeline readable from Members or All Users). */
function requireAnyPermission(...permissions) {
  return [
    loadAccessUser,
    (req, res, next) => {
      if (req.accessRole === "admin" || permissions.some((p) => req.permissions.includes(p))) return next();
      return res.status(403).json({ message: "Access denied" });
    },
  ];
}

const hasPermission = (req, permission) => req.accessRole === "admin" || (req.permissions || []).includes(permission);

function accessProfile(user) {
  const role = effectiveRole(user);
  return {
    role,
    isOwner: role === "admin",
    employeePosition: user.employeePosition || null,
    employeeTitle: user.employeeTitle || "",
    adminSections: role === "employee" ? cleanSections(user.adminSections) : [],
    isActive: user.isActive !== false,
    mustChangePassword: !!user.mustChangePassword,
    permissions: permissionsForUser(user),
  };
}

module.exports = {
  PERMISSIONS,
  accessProfile,
  effectiveRole,
  permissionsForUser,
  loadAccessUser,
  requirePermission,
  requireAnyPermission,
  hasPermission,
};
