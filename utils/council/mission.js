const AgentSettings = require("../../models/AgentSettings");
const { cleanGuidance, validateGuidance } = require("../agents/settings");

/**
 * King Arthur's standing mission - owner guidance for agent "arthur".
 *
 * The owner approved this text on 2026-10-10. It is stored exactly like any
 * other agent guidance (AgentSettings: versioned, every version kept, any
 * version restorable, validated against the protected rules) and reaches his
 * prompt below the fixed rules, which always win.
 *
 * ensureMission() writes it ONCE, as version 1, and only when Arthur has no
 * settings document at all ($setOnInsert on the unique agent key - safe across
 * instances). If the owner later edits, restores or clears it, that choice
 * stands: the mission is never re-imposed.
 */
const MISSION = cleanGuidance(`MISSION: increase profitable paying memberships and monthly recurring revenue, while improving customer retention and reducing cancellations.
- Continuously coordinate Odysseus, Leonidas and Marcus toward this mission.
- Prioritize measurable business results over reports and activity.
- Use real business data to find opportunities. Watch membership growth, cancellations, revenue, free-visit conversions and calendar capacity.
- Give useful tasks to the right hero and track them to completion. Avoid duplicate or unnecessary work.
- Recommend improvements proactively; do not wait for the owner to start every task.
- Keep the owner informed about important decisions, blockers and results, without overwhelming them: few, clear messages.`);

const APPROVED_BY = "Owner";
const APPROVED_NOTE = "Growth mission approved by the owner on 2026-10-10";

let ensured = false;

async function ensureMission() {
  if (ensured) return;
  const problems = validateGuidance(MISSION);
  if (problems.length) throw new Error(`Arthur's mission breaks a protected rule: ${problems.join(" ")}`);
  const entry = { version: 1, guidance: MISSION, by: APPROVED_BY, at: new Date(), note: APPROVED_NOTE, rollbackOf: null };
  await AgentSettings.updateOne(
    { agent: "arthur" },
    { $setOnInsert: { agent: "arthur", paused: false, guidance: MISSION, version: 1, history: [entry] } },
    { upsert: true }
  ).catch((error) => {
    if (error?.code !== 11000) throw error; // another instance inserted it first
  });
  ensured = true;
}

function resetForTests() {
  ensured = false;
}

module.exports = { MISSION, ensureMission, resetForTests };
