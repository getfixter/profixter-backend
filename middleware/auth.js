// middleware/auth.js
const jwt = require("jsonwebtoken");
const User = require("../models/User");

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
      .select("email role employeePosition isActive mustChangePassword")
      .lean();
    if (!user) return res.status(401).json({ message: "User not found" });
    if (user.role === "employee" && user.isActive === false) {
      return res.status(403).json({ message: "Employee account is inactive" });
    }
    req.authUser = user;

    next();
  } catch (e) {
    return res.status(401).json({ message: "Token invalid" });
  }
};
