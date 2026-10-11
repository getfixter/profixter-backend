const AgentFinding = require("../../models/AgentFinding");
const AgentMemory = require("../../models/AgentMemory");
const { POSTAL_RE } = require("./tools");

/**
 * Retire what the agents recorded about postcards and mail BEFORE the mail
 * tools were removed (Oct 2026). Without this, the old notes kept the idea
 * alive: Leonidas's notebook still ranked postcards "our best shot", and King
 * Arthur, reading it, concluded the mail tool was still there.
 *
 * - open agent findings and drafts about postcards/mail -> "superseded",
 *   with the reason (kept for history, never shown as open again)
 * - notebook notes: the lines about postcards/mail are removed; a note left
 *   empty is deleted. Other lines (the rest of a channel scorecard) stay.
 *
 * Touches agent records only - never the owner's own mail data (Outreach
 * models), never customer data. Idempotent: run at every start, it changes
 * nothing once clean. New postal records cannot appear (tools.refusePostal).
 */
const NOTE = "Postcards and mail are the owner's own project, not an agent's - closed automatically when the mail tools were removed.";

function mentionsPostal(f) {
  return [f.title, f.detail, f.plain, f.ownerQuestion, f.body, f.expectedImpact, typeof f.evidence === "string" ? f.evidence : ""].some((t) => POSTAL_RE.test(String(t || "")));
}

async function retirePostalRecords() {
  const open = await AgentFinding.find({ status: "open" }).select("title detail plain ownerQuestion body expectedImpact evidence").lean();
  const findingIds = open.filter(mentionsPostal).map((f) => f._id);
  if (findingIds.length) {
    await AgentFinding.updateMany({ _id: { $in: findingIds }, status: "open" }, { $set: { status: "superseded", statusBy: "system", statusNote: NOTE } });
  }
  let notesEdited = 0;
  let notesDeleted = 0;
  for (const m of await AgentMemory.find({}).lean()) {
    if (!POSTAL_RE.test(m.content || "") && !POSTAL_RE.test(m.key || "")) continue;
    const kept = POSTAL_RE.test(m.key || "")
      ? ""
      : String(m.content)
          .split("\n")
          .filter((line) => !POSTAL_RE.test(line))
          .join("\n")
          .trim();
    if (!kept) {
      await AgentMemory.deleteOne({ _id: m._id });
      notesDeleted += 1;
    } else {
      await AgentMemory.updateOne({ _id: m._id }, { $set: { content: kept } });
      notesEdited += 1;
    }
  }
  const result = { findings: findingIds.length, notesEdited, notesDeleted };
  if (findingIds.length || notesEdited || notesDeleted) console.log(JSON.stringify({ event: "postal_records_retired", ...result }));
  return result;
}

module.exports = { retirePostalRecords };
