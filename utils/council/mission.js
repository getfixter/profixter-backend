const AgentSettings = require("../../models/AgentSettings");
const { cleanGuidance, getSettings, saveGuidance, validateGuidance } = require("../agents/settings");

/**
 * King Arthur's standing mission - owner guidance for agent "arthur".
 *
 * Stored like any agent guidance (AgentSettings: every version kept, any
 * version restorable, validated against the protected rules) and placed in
 * his prompt below the fixed rules, which always win.
 *
 * History:
 *   2026-10-10  the growth mission (memberships, MRR, retention) - MISSION_V1
 *   2026-10-11  the owner refocused the Kingdom on organic marketing and
 *               customer acquisition: "I run Profixter. The Kingdom markets
 *               Profixter." - MISSION
 *
 * ensureMission():
 *   - no settings at all  -> the marketing mission, version 1
 *   - still the original V1 (version 1, untouched) -> the marketing mission as
 *                            version 2 (the growth mission stays in the history, restorable)
 *   - anything else (the owner edited, restored or cleared it) -> untouched
 */
const MISSION_V1 = cleanGuidance(`MISSION: increase profitable paying memberships and monthly recurring revenue, while improving customer retention and reducing cancellations.
- Continuously coordinate Odysseus, Leonidas and Marcus toward this mission.
- Prioritize measurable business results over reports and activity.
- Use real business data to find opportunities. Watch membership growth, cancellations, revenue, free-visit conversions and calendar capacity.
- Give useful tasks to the right hero and track them to completion. Avoid duplicate or unnecessary work.
- Recommend improvements proactively; do not wait for the owner to start every task.
- Keep the owner informed about important decisions, blockers and results, without overwhelming them: few, clear messages.`);

const MISSION = cleanGuidance(`MISSION: bring more local homeowners to Profixter through organic marketing - more visibility on Google and AI search, a growing social media presence, community reach, and good follow-ups - so more of them book their first free visit.
- The owner runs Profixter; the Kingdom markets it. Stay out of revenue, billing, memberships, cancellations, scheduling and operations.
- Odysseus: Google Business Profile, Google Search, local SEO, AI search, service-area pages, Yelp and other directories.
- Leonidas: organic Instagram and Facebook posts, local social content, community visibility, other legitimate free places to promote Profixter.
- Marcus: consent-compliant follow-ups for free visits that did not join, registrations that never booked, and past members.
- Be proactive: research opportunities, find visibility weaknesses, prepare ready-to-use content, and bring the owner actionable recommendations without waiting to be asked.
- Measure by useful content published, local search visibility, organic reach, qualified traffic and first free-visit bookings - not by activity or reports.
- Keep the owner informed with few, clear messages.`);

const APPROVED_BY = "Owner";
const NOTE_V1 = "Growth mission approved by the owner on 2026-10-10";
const NOTE = "Marketing-only mission approved by the owner on 2026-10-11 (replaces the growth mission)";

let ensured = false;

async function ensureMission() {
  if (ensured) return;
  const problems = validateGuidance(MISSION);
  if (problems.length) throw new Error(`Arthur's mission breaks a protected rule: ${problems.join(" ")}`);
  const entry = { version: 1, guidance: MISSION, by: APPROVED_BY, at: new Date(), note: NOTE, rollbackOf: null };
  await AgentSettings.updateOne(
    { agent: "arthur" },
    { $setOnInsert: { agent: "arthur", paused: false, guidance: MISSION, version: 1, history: [entry] } },
    { upsert: true }
  ).catch((error) => {
    if (error?.code !== 11000) throw error; // another instance inserted it first
  });
  const current = await getSettings("arthur");
  // only the ORIGINAL version 1: a growth mission the owner restored later (a higher version) is their choice
  if ((current.version || 0) === 1 && cleanGuidance(current.guidance) === MISSION_V1) {
    const { settings } = await saveGuidance("arthur", MISSION, { by: APPROVED_BY, note: NOTE });
    console.log(JSON.stringify({ event: "arthur_mission_updated", version: settings.version, note: NOTE }));
  }
  ensured = true;
}

function resetForTests() {
  ensured = false;
}

module.exports = { MISSION, MISSION_V1, NOTE_V1, ensureMission, resetForTests };
