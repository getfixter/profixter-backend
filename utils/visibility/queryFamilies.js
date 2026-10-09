/**
 * Search queries sorted into the families the growth plan reasons about.
 *
 *   brand       someone already knows us: "profixter", "pro fixter", "mr fixter"
 *   membership  the recurring model: membership, plan, subscription...
 *   local       a handyman (or a handyman task) PLUS a place: a Long Island
 *               town, "near me", "long island", "nassau", "suffolk"
 *   task        a specific job without a place: "ceiling fan installation"
 *   other       everything else
 *
 * First match wins, in that order. Brand outranks everything because a query
 * naming us is demand we already created, whatever else it says. Membership
 * outranks local because "handyman membership long island" is the product
 * question, and that is the family we most want to watch grow.
 *
 * ONE DELIBERATE WIDENING. "Local" also accepts a task word with a place
 * ("faucet repair lindenhurst"), not only the word handyman. Those queries
 * are local intent in every sense that matters for the local pack, and
 * leaving them in "task" would hide exactly the town-level demand the town
 * pages were written for.
 *
 * Town names come from data/long-island-towns.json (the service-area ZIP
 * comments plus hamlets named on town pages). A town name alone does not make
 * a query local: "babylon" by itself is a Bible search. Matching is on whole
 * words, case-insensitive, after squashing punctuation, so "st. james" and
 * "saint james" both match.
 *
 * These are simple keyword rules, like the AI benchmark's, so they are stable
 * and explainable. Families are computed when summarising, not stored, so a
 * rule change applies to history too.
 */
const TOWN_DATA = require("../../data/long-island-towns.json");

const FAMILIES = ["brand", "membership", "local", "task", "other"];

function normalize(text) {
  return ` ${String(text || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phrase = (words) => new RegExp(`\\s(?:${words.map((w) => escape(normalize(w).trim())).join("|")})\\s`);

const BRAND = phrase(["profixter", "pro fixter", "profixer", "mr fixter", "mrfixter", "mister fixter", "profixter com"]);

const MEMBERSHIP = phrase([
  "membership", "memberships", "member", "members",
  "subscription", "subscriptions", "subscribe",
  "maintenance plan", "maintenance plans", "home maintenance plan",
  "handyman plan", "handyman plans", "monthly plan", "annual plan", "plan", "plans",
  "retainer",
]);

const HANDYMAN = phrase([
  "handyman", "handymen", "handy man", "handy men", "handyman service", "handyman services",
  "home repair", "home repairs", "house repair", "house repairs", "odd jobs", "fix it",
]);

const TASKS = phrase([
  "faucet", "faucets", "toilet", "toilets", "sink", "garbage disposal", "disposal",
  "ceiling fan", "ceiling fans", "light fixture", "light fixtures", "outlet", "outlets", "light switch",
  "drywall", "sheetrock", "patch", "caulk", "caulking", "grout",
  "tv mount", "tv mounting", "mount tv", "tv wall mount", "tv installation",
  "shelf", "shelves", "curtain rod", "curtain rods", "blinds",
  "door", "doors", "door repair", "lock", "deadbolt",
  "furniture assembly", "assemble furniture", "ikea",
  "paint", "painting", "touch up",
  "gutter", "gutters", "deck", "fence", "trim", "molding", "baseboard",
  "weatherstrip", "weatherstripping", "smoke detector", "thermostat",
]);

const GEO_WORDS = ["near me", "nearby", "long island", "li ny", "nassau", "nassau county", "suffolk", "suffolk county"];

function buildTownPattern(towns) {
  const names = new Set();
  for (const t of towns || []) {
    names.add(t.name);
    for (const a of t.aliases || []) names.add(a);
  }
  // Longest first so "west babylon" is preferred over "babylon" in the match text.
  const list = [...names].map((n) => normalize(n).trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  return new RegExp(`\\s(?:${list.map(escape).join("|")})\\s`);
}

const TOWNS = buildTownPattern(TOWN_DATA.towns);
const GEO = phrase(GEO_WORDS);

/** The family of one query, plus the signals behind it (for debugging the rules). */
function classifyQueryDetailed(query) {
  const q = normalize(query);
  const signals = {
    brand: BRAND.test(q),
    membership: MEMBERSHIP.test(q),
    handyman: HANDYMAN.test(q),
    task: TASKS.test(q),
    town: (q.match(TOWNS) || [""])[0].trim() || null,
    geo: GEO.test(q),
  };
  const place = Boolean(signals.town) || signals.geo;
  let family = "other";
  if (signals.brand) family = "brand";
  // "plan" alone is too broad ("floor plan"); require a handyman/maintenance
  // context unless the word itself is unambiguous.
  else if (signals.membership && (signals.handyman || /\s(membership|memberships|subscription|subscriptions|subscribe|retainer|maintenance plans?)\s/.test(q))) family = "membership";
  else if (place && (signals.handyman || signals.task)) family = "local";
  else if (signals.task) family = "task";
  return { family, signals };
}

function classifyQuery(query) {
  return classifyQueryDetailed(query).family;
}

module.exports = { FAMILIES, classifyQuery, classifyQueryDetailed, normalize };
