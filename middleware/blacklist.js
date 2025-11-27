const User = require("../models/User");

async function ensureNotBlacklisted(req, res, next) {
  try {
    const user = await User.findById(req.user?.id).lean();
    if (!user) return res.status(401).json({ message: "User not found/auth invalid" });

    if (user.blacklisted === true || user.isBlacklisted === true) {
      return res.status(403).json({ message: "Your account is temporarily blocked from booking." });
    }

    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { ensureNotBlacklisted };
