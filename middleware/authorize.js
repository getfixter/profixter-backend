const User = require("../models/User");

const PERMISSIONS = Object.freeze({
  ADMIN: "admin.all",
  BOOKINGS_READ: "bookings.read",
  BOOKINGS_WRITE: "bookings.write",
  BOOKINGS_ASSIGN: "bookings.assign",
  MEMBERS_READ: "members.read",
  SCHEDULE_READ: "schedule.read",
  SCHEDULE_WRITE: "schedule.write",
});

const ADMIN_EMAIL = String(
  process.env.MAIL_ADMIN || "getfixter@gmail.com"
).toLowerCase();

function effectiveRole(user) {
  if (String(user?.email || "").toLowerCase() === ADMIN_EMAIL) return "admin";
  return user?.role || "customer";
}

function permissionsForUser(user) {
  const role = effectiveRole(user);
  if (role === "admin") return Object.values(PERMISSIONS);
  if (role !== "employee") return [];
  if (user.employeePosition === "General Fixter") {
    return [
      PERMISSIONS.BOOKINGS_READ,
      PERMISSIONS.BOOKINGS_WRITE,
      PERMISSIONS.BOOKINGS_ASSIGN,
      PERMISSIONS.MEMBERS_READ,
      PERMISSIONS.SCHEDULE_READ,
      PERMISSIONS.SCHEDULE_WRITE,
    ];
  }
  if (user.employeePosition === "Fixter") {
    return [PERMISSIONS.BOOKINGS_READ, PERMISSIONS.BOOKINGS_WRITE];
  }
  return [];
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

function accessProfile(user) {
  return {
    role: effectiveRole(user),
    employeePosition: user.employeePosition || null,
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
};
