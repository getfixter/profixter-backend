const User = require("../models/User");
const { findActiveBlockForUser, refuseBlocked } = require("../utils/customerBlock");

/*
 * Refuse a signed-in customer whom Admin has blocked.
 *
 * Reads the Blacklist collection (by account id, email and phone, through
 * utils/customerBlock). It used to read user.blacklisted / user.isBlacklisted,
 * which the User schema has never had and Admin never set, so it could not
 * trigger and a "Blocked" customer could still book. The response is the same
 * generic refusal every entry point gives.
 */
async function ensureNotBlacklisted(req, res, next) {
  try {
    const user = await User.findById(req.user?.id).select("email phone").lean();
    if (!user) return res.status(401).json({ message: "User not found/auth invalid" });

    const entry = await findActiveBlockForUser(user);
    if (entry) return refuseBlocked(res, `${req.baseUrl || ""}${req.path || ""}`, entry);

    return next();
  } catch (e) {
    return next(e);
  }
}

module.exports = { ensureNotBlacklisted };
