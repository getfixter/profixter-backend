// middleware/auth.js
const jwt = require("jsonwebtoken");

module.exports = function (req, res, next) {
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

    next();
  } catch (e) {
    return res.status(401).json({ message: "Token invalid" });
  }
};
