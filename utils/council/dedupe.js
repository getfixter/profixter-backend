const { CouncilDecision } = require("../../models/Council");

/**
 * ONE RECORD PER TOPIC, IN CODE.
 *
 * King Arthur files records for the owner with a dedupe key he makes up, and
 * the same topic came back under a new key ("gbp-posting-failed",
 * "gbp:suspended", ...) as a second, third decision. The key is still used,
 * but a record whose subject says the same thing as one already open is now
 * the same record: filing updates it, and duplicates already open are merged
 * into the oldest (closed as "merged", kept in history - nothing is deleted).
 *
 * Only Arthur's own topic records are compared. Records tied to an approval
 * item (refs), guidance proposals, archive requests and the refocus review
 * have their own one-per-item keys and are left alone.
 */
const STOP = new Set(
  "the a an and or of to for in on at by with from is are be was were it its this that these those our your my we you he she they his her their about into over not no new now still again more some any all".split(" ")
);
const SIMILAR = 0.6;

function words(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => w.replace(/(ing|ed|es|s)$/, ""))
  );
}

function similarity(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

const sameKind = (a, b) => (a === "info") === (b === "info");

/** Arthur's open topic records (not tied to an item, not a proposal). */
async function openTopicRecords() {
  return CouncilDecision.find({
    status: "open",
    dedupeKey: /^arthur:/,
    "refs.0": { $exists: false },
    "payload.type": { $exists: false },
  })
    .sort({ createdAt: 1 })
    .lean();
}

/** The open record that already covers this subject, if any. */
async function sameTopic({ subject, category, agent = null }) {
  const open = await openTopicRecords();
  return open.find((d) => sameKind(d.category, category) && (d.agent || null) === (agent || null) && similarity(d.subject, subject) >= SIMILAR) || null;
}

/** Merge open duplicates into the oldest record of each topic. Idempotent. */
async function mergeOpenDuplicates({ now = new Date() } = {}) {
  const open = await openTopicRecords();
  const kept = [];
  let merged = 0;
  for (const d of open) {
    const keep = kept.find((k) => sameKind(k.category, d.category) && (k.agent || null) === (d.agent || null) && similarity(k.subject, d.subject) >= SIMILAR);
    if (!keep) {
      kept.push(d);
      continue;
    }
    const r = await CouncilDecision.updateOne(
      { _id: d._id, status: "open" },
      {
        $set: { status: "superseded", resolution: { choice: "merged", by: "system", at: now, note: `Same topic as record ${keep._id} ("${String(keep.subject).slice(0, 120)}"), which stays open.` } },
        $push: { inboxHistory: { at: now, to: "merged", by: "system", note: `Merged into ${keep._id}` } },
      }
    );
    merged += r.modifiedCount;
  }
  if (merged) console.log(JSON.stringify({ event: "council_duplicates_merged", merged }));
  return { merged };
}

module.exports = { SIMILAR, mergeOpenDuplicates, sameTopic, similarity };
