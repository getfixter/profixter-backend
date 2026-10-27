const EmailPlaybook = require("../../models/EmailPlaybook");
const GrowthAction = require("../../models/GrowthAction");
const GrowthPolicy = require("../../models/GrowthPolicy");

/**
 * WHAT THE AUTOMATIONS WOULD DO - read-only, no customer data.
 *
 * Every email playbook with its full wording (business copy, not personal
 * data), the link its button really goes to, and whether it passes the copy
 * rules and the button rules today; the trust policy of each automated
 * action; and the last Google Business Profile post with its verification.
 * Logged once per boot so the owner's questions can be answered from the
 * server log without database access. It changes nothing and sends nothing.
 */
async function automationAudit() {
  const { checkCopy } = require("../agents/copyRules");
  const { ctaRouteOf, ctaRouteProblem, playbookText } = require("./actions/playbookEmail");
  const { ACQUISITION_SEGMENTS } = require("./acquisitionScope");
  const { routeUrl } = require("../marketing/marketingConfig");

  const playbooks = (await EmailPlaybook.find({}).sort({ createdAt: 1 }).lean()).map((pb) => {
    const route = ctaRouteOf(pb);
    let link = null;
    try {
      link = routeUrl(route);
    } catch {
      link = null;
    }
    return {
      key: pb.key,
      name: pb.name,
      status: pb.status,
      version: pb.version,
      approvedVersion: pb.approvedVersion ?? null,
      segment: pb.segment,
      inAcquisitionScope: ACQUISITION_SEGMENTS.includes(pb.segment),
      ctaRoute: pb.ctaRoute,
      buttonGoesTo: link,
      copyProblems: checkCopy(playbookText(pb)),
      buttonProblem: ctaRouteProblem(pb.segment, route),
      subject: pb.subject,
      preheader: pb.preheader,
      headline: pb.headline,
      paragraphs: pb.paragraphs,
      ctaLabel: pb.ctaLabel,
      closing: pb.closing,
      purpose: pb.purpose || "",
    };
  });

  const [policies, sends, lastGbp] = await Promise.all([
    GrowthPolicy.find({}).select("type mode setBy consecutiveVerifiedSuccesses").lean(),
    GrowthAction.aggregate([{ $match: { type: "playbook_email" } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    GrowthAction.findOne({ type: "gbp_post", status: { $in: ["succeeded", "failed", "rolled_back"] } }).sort({ executedAt: -1, updatedAt: -1 }).lean(),
  ]);

  return {
    playbooks,
    policies: policies.map((p) => ({ type: p.type, mode: p.mode, setBy: p.setBy?.kind || null, setAt: p.setBy?.at || null, streak: p.consecutiveVerifiedSuccesses ?? null })),
    playbookEmailActions: Object.fromEntries(sends.map((s) => [s._id, s.n])),
    lastGbpPost: lastGbp
      ? {
          status: lastGbp.status,
          executedAt: lastGbp.executedAt || null,
          postId: lastGbp.result?.postId || null,
          scheduledFor: lastGbp.result?.scheduledFor || null,
          verification: lastGbp.verification ? { status: lastGbp.verification.status || null, detail: String(lastGbp.verification.detail || "").slice(0, 300), at: lastGbp.verification.at || lastGbp.verification.checkedAt || null } : null,
          lastError: lastGbp.lastError ? String(lastGbp.lastError).slice(0, 300) : null,
          summary: String(lastGbp.payload?.summary || "").slice(0, 600),
          url: lastGbp.payload?.url || null,
        }
      : null,
    // where the links in every marketing email really point (unsubscribe = API, buttons = site)
    links: {
      unsubscribeBase: `${require("../marketing/marketingConfig").API_BASE_URL}/api/email/unsubscribe`,
      site: require("../marketing/marketingConfig").routeUrl("bookFree").replace(/\/book\/free$/, ""),
    },
    lifecycle: {
      marketingEmails: require("../marketing/marketingConfig").marketingEnabled(),
      audiences: ["non_member", "member", "former_member"].filter((a) => require("../marketing/marketingConfig").audienceEnabled(a)),
    },
  };
}

module.exports = { automationAudit };
