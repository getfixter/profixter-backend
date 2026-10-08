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
    /* Meta ids and names, each in its own field (an id is never stored as a name). */
    campaignId: { type: String, default: null },
    campaignName: { type: String, default: null },
    adsetId: { type: String, default: null },
    adsetName: { type: String, default: null },
    adId: { type: String, default: null },
    adName: { type: String, default: null },
    /* Our acquisition ?source= (event, qr, referral) - never an internal button's ?source=. */
    refSource: { type: String, default: null },
    /* ?ref= on a referral-program link. */
    refCode: { type: String, default: null },
    hasFbclid: { type: Boolean, default: false },
    /* gclid, or Google's app click ids gbraid / wbraid. */
    hasGclid: { type: Boolean, default: false },
    /*
     * classifySource() at insert, for reference. The Overview re-classifies
     * every row when it counts, so a rule change applies to old rows too.
     */
    source: { type: String, default: "direct", index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: false }
);

siteVisitorSchema.index({ firstSeenAt: 1 });

module.exports = mongoose.model("SiteVisitor", siteVisitorSchema);
