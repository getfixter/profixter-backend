const { PLAN_CATALOG } = require("../subscriptionManagement");

/**
 * Everything the Conversation agent may state as fact - and nothing else.
 *
 * Built from the same sources the website uses: plan prices from
 * PLAN_CATALOG, the One-Time and Full Day prices from their live settings,
 * services and renovations as published on www.profixter.com. Anything not
 * here (warranties, availability, discounts, licensing details, exceptions)
 * is not answered by the agent: it escalates to a person.
 */

const SITE = "https://www.profixter.com";

const HANDYMAN_SERVICES = [
  "TV mounting",
  "Drywall repair",
  "Door repair",
  "Light fixture installation",
  "Furniture assembly",
  "Caulking and sealing",
  "Faucet replacement",
  "Toilet repair",
  "Ceiling fan installation",
  "Garbage disposal replacement",
  "Shelf, mirror and curtain rod installation",
  "Handyman plumbing repairs",
];

const RENOVATIONS = ["Bathroom remodeling", "Kitchen remodeling", "Roofing", "Siding", "Full home renovation", "New home construction"];

/** Where each kind of answer sends people. The agent never writes URLs itself. */
const LINKS = {
  free_visit: "/book/free",
  plans: "/membership/plans",
  one_time: "/book?visit=additional",
  renovation: "/projects#estimate",
  kitchen_bath: "/kitchen-bathroom",
  services: "/services",
};

async function liveFacts() {
  let oneTimeDollars = null;
  let fullDayDollars = null;
  try {
    const { getOneTimeVisitSettings } = require("../oneTimeVisitSettings");
    const s = await getOneTimeVisitSettings();
    oneTimeDollars = Math.round(Number(s?.priceCents || s?.amountCents || 0) / 100) || null;
  } catch {
    oneTimeDollars = null;
  }
  try {
    const { getFullDayVisitSettings } = require("../fullDayVisitSettings");
    const s = await getFullDayVisitSettings();
    fullDayDollars = Math.round(Number(s?.priceCents || s?.amountCents || 0) / 100) || null;
  } catch {
    fullDayDollars = null;
  }
  const plans = Object.entries(PLAN_CATALOG).map(([key, p]) => ({
    plan: key[0].toUpperCase() + key.slice(1),
    monthly: p.monthly.price,
    annual: p.annual.price,
  }));
  return { oneTimeDollars, fullDayDollars, plans };
}

/** The fact sheet as prompt text, plus the set of dollar amounts a reply may contain. */
async function factSheet() {
  const f = await liveFacts();
  const allowedAmounts = new Set([0]);
  if (f.oneTimeDollars) allowedAmounts.add(f.oneTimeDollars);
  if (f.fullDayDollars) allowedAmounts.add(f.fullDayDollars);
  for (const p of f.plans) {
    allowedAmounts.add(p.monthly);
    allowedAmounts.add(p.annual);
  }
  const text = `PROFIXTER FACTS (the only things you may state as fact)
- Profixter is a handyman company serving homeowners in Nassau and Suffolk counties on Long Island, NY, with its own in-house Fixters.
- FREE FIRST VISIT: a real handyman visit, up to 90 minutes of labor on one eligible task, free, one per home, no card needed. The homeowner books it themselves online, choosing a time from the live calendar, at ${SITE}${LINKS.free_visit}. It is real work, never an inspection or an estimate.
- Handyman jobs Profixter does: ${HANDYMAN_SERVICES.join("; ")}.
- One-Time Visit: ${f.oneTimeDollars ? `$${f.oneTimeDollars}` : "a fixed price shown on the website"} for up to 90 minutes, booked online.${f.fullDayDollars ? ` Full Day: $${f.fullDayDollars}.` : ""}
- Membership: ongoing handyman help. Plans: ${f.plans.map((p) => `${p.plan} $${p.monthly}/month`).join(", ")} (annual billing also available). Membership is a pace, not an allowance: Basic lets you have 1 visit booked at a time, Plus/Premium/Elite up to 2 at a time, as often as you need. Never say "unlimited" or "N visits per month".
- Renovations (separate from handyman visits, quoted individually): ${RENOVATIONS.join("; ")}. Homeowners start with a request on the website.
- Office phone: (631) 599-1363.
- Booking always happens on the website by the homeowner. You cannot book, hold, move or cancel visits and you cannot see the calendar.`;
  return { text, allowedAmounts, facts: f };
}

module.exports = { HANDYMAN_SERVICES, LINKS, RENOVATIONS, SITE, factSheet, liveFacts };
