const mongoose = require("mongoose");

/**
 * Ad spend, one row per platform / ad account / day / level / entity, mirrored
 * from the ad platform by a background sync (utils/analytics/metaAdSpend.js).
 * The Admin Overview reads this collection, never the platform, on a request.
 *
 * - date: YYYY-MM-DD as the platform reports it, i.e. in the AD ACCOUNT's
 *   time zone (Profixter's Meta account is set to America/New_York, the same
 *   day boundary as the Overview; the sync records the account's time zone in
 *   its status so a mismatch is visible).
 * - level "ad": entityId is the ad id, with its campaign and ad set alongside.
 *   level "platform": the whole account's day split by Meta's
 *   publisher_platform (facebook, instagram, audience_network, messenger...);
 *   entityId is that platform name.
 * - spendCents: integer minor units of `currency`, converted from the
 *   platform's decimal string without floating point.
 *
 * The natural key is unique, so re-reading a day (Meta restates recent days)
 * updates the row in place.
 */
const adSpendDailySchema = new mongoose.Schema(
  {
    platform: { type: String, required: true, enum: ["meta"] },
    accountId: { type: String, required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    level: { type: String, required: true, enum: ["ad", "platform"] },
    entityId: { type: String, required: true },

    campaignId: { type: String, default: null },
    campaignName: { type: String, default: null },
    adsetId: { type: String, default: null },
    adsetName: { type: String, default: null },
    adId: { type: String, default: null },
    adName: { type: String, default: null },
    publisherPlatform: { type: String, default: null },

    spendCents: { type: Number, required: true, default: 0 },
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    reach: { type: Number, default: 0 },
    /* A few platform-reported actions (link_click, landing_page_view, lead, complete_registration...). */
    actions: { type: mongoose.Schema.Types.Mixed, default: {} },
    currency: { type: String, default: null },
    fetchedAt: { type: Date, required: true },
  },
  { timestamps: true, minimize: false }
);

adSpendDailySchema.index({ platform: 1, accountId: 1, date: 1, level: 1, entityId: 1 }, { unique: true, name: "ad_spend_natural_key" });
adSpendDailySchema.index({ platform: 1, level: 1, date: 1 });

module.exports = mongoose.models.AdSpendDaily || mongoose.model("AdSpendDaily", adSpendDailySchema);
