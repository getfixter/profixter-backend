/**
 * THE KINGDOM IS 100% ORGANIC MARKETING (owner's permanent rule, 2026-10-12).
 *
 * Paid marketing is PROHIBITED - not "needs approval": no agent may purchase,
 * propose or start paid promotions or advertisements, sponsorships, paid or
 * premium directory listings, sponsored articles or placements, influencer
 * payments, boosted posts, pay-per-click / pay-per-lead, or bought leads,
 * followers, likes or reviews. The AI budget ($5/day) pays for the agents'
 * own operating cost only, never for marketing.
 *
 * Meta advertising stays with the outside agency (actionRegistry already
 * refuses any advertising action at any trust level).
 *
 * Enforced in code wherever an agent's words become work or reach the owner:
 * protected guidance rules (so tasks, team focus, owner guidance and the
 * mission), findings, drafts, Arthur's records and every published post.
 */
const PAID_RE =
  /\b(paid (?:ads?|advertis\w*|promotions?|placements?|listings?|posts?|campaigns?|partnerships?|sponsorships?|media|search|social|articles?|reviews?|leads?|features?)|sponsor(?:ed|ships?|ing)?|advertorials?|boost(?:ed|ing)? (?:a |the |our |this |that )?posts?|promoted (?:posts?|pins?|listings?|tweets?)|influencer (?:payments?|campaigns?|marketing|partnerships?|fees?|deals?)|pay(?:ing)? (?:an? |the )?influencers?|premium (?:listings?|placements?|profiles?|tiers?|packages?)|featured (?:listing|placement)s? (?:fee|cost|price)|enhanced (?:listings?|profiles?)|pay[- ]per[- ](?:click|lead|call)|cost[- ]per[- ](?:click|lead)|ppc|local services ads?|(?:buy|buying|purchase|purchasing|pay for|paying for) (?:ads?|advertising|leads?|placements?|listings?|followers|reviews?|likes|exposure|visibility|traffic|a feature|an? article)|(?:ad|advertising|marketing|media) (?:spend|budget)s?)\b/i;

const PAID_WHY =
  "Prohibited: the Kingdom is 100% organic marketing. No paid promotion, advertising, sponsorship, paid or premium listing, sponsored article, influencer payment, boosted post or any other paid marketing - not even as a proposal. Use free organic opportunities only.";

function isPaid(text) {
  return PAID_RE.test(String(text || ""));
}

/** Throws (for tools) when any of the texts proposes paid marketing. */
function refusePaid(...texts) {
  if (isPaid(texts.join(" "))) throw new Error(`${PAID_WHY} Rewrite it as a free, organic action or drop it.`);
}

module.exports = { PAID_RE, PAID_WHY, isPaid, refusePaid };
