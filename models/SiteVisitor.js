const mongoose = require("mongoose");

/**
 * One anonymous browser, recorded the first time it lands on the site.
 *
 * This is the top of the Overview funnel ("Visitors") and the visitor count
 * per acquisition source. It holds no personal data: a random browser id, the
 * landing page, the referrer host and the marketing tags in the URL. The IP
 * and user agent are not stored.
 *
 * Insert-only ($setOnInsert): the first touch is never rewritten. `user` is
 * filled in when that browser registers, which links an anonymous visit to an
 * account without ever copying account data in here.
 */
const siteVisitorSchema = new mongoose.Schema(
  {
    visitorId: { type: String, required: true, unique: true },
    firstSeenAt: { type: Date, required: true },
    landingPath: { type: String, default: null },
    referrerHost: { type: String, default: null },
    utmSource: { type: String, default: null },
    utmMedium: { type: String, default: null },
    utmCampaign: { type: String, default: null },
    utmContent: { type: String, default: null },
    utmTerm: { type: String, default: null },
    campaignId: { type: String, default: null },
    adsetId: { type: String, default: null },
    adId: { type: String, default: null },
    refSource: { type: String, default: null },
    hasFbclid: { type: Boolean, default: false },
    hasGclid: { type: Boolean, default: false },
    /* classifySource() at insert, so counting by source is a plain group-by. */
    source: { type: String, default: "direct", index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: false }
);

siteVisitorSchema.index({ firstSeenAt: 1 });

module.exports = mongoose.model("SiteVisitor", siteVisitorSchema);
