// middleware/auth.js
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const temporaryPassword = require("../utils/auth/temporaryPassword");

const PASSWORD_CHANGE_PATHS = new Set(["/api/auth/me", "/api/auth/change-password"]);
const TEMP_EXPIRED_MESSAGE =
  "Your temporary password has expired. Use \"Forgot password\" or sign in with a code, or call us for a new one.";

module.exports = async function (req, res, next) {
  try {
    // Accept either "Authorization: Bearer <token>" or "x-auth-token"
    const bearer = req.header("Authorization");
    const token =
      (bearer && bearer.replace(/^Bearer\s+/i, "")) ||
      req.header("x-auth-token");

    if (!token) return res.status(401).json({ message: "No token" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ⚠️ Keep it consistent: downstream expects req.user.id (Mongo _id from token)
    req.user = { id: decoded.id };

    const user = await User.findById(decoded.id)
      .select("name email role employeePosition employeeTitle adminSections isActive mustChangePassword tokenVersion temporaryPassword")
      .lean();
    if (!user) return res.status(401).json({ message: "User not found" });
    // Ended by a password reset since this token was issued.
    if (Number(decoded.tv || 0) !== Number(user.tokenVersion || 0)) {
      return res.status(401).json({ message: "Session ended. Please sign in again." });
    }
    if (user.role === "employee" && user.isActive === false) {
      return res.status(403).json({ message: "Employee account is inactive" });
    }
    /*
     * A session opened with an Admin-issued temporary password can do one
     * thing: replace it. Enforced here, not only in the app, so no screen or
     * script can use the account before the customer has a password of their
     * own. Accounts without a temporary password are untouched by this.
     */
    if (temporaryPassword.isIssued(user) && user.mustChangePassword) {
      if (temporaryPassword.isExpired(user)) {
        return res.status(401).json({ message: TEMP_EXPIRED_MESSAGE, code: "TEMP_PASSWORD_EXPIRED" });
      }
      const path = String(req.originalUrl || "").split("?")[0];
      if (!PASSWORD_CHANGE_PATHS.has(path)) {
        return res.status(403).json({ message: "Please create a new password to continue.", code: "PASSWORD_CHANGE_REQUIRED" });
      }
    }
    req.authUser = user;

    next();
  } catch (e) {
    return res.status(401).json({ message: "Token invalid" });
  }
};
