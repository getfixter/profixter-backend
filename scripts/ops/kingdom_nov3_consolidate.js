/**
 * One-time Kingdom clean-up, owner brief 2026-11-03 ("consolidate duplicated
 * decisions and retire obsolete tasks without losing their audit history").
 *
 *   node scripts/ops/kingdom_nov3_consolidate.js            dry run: prints what it would do
 *   node scripts/ops/kingdom_nov3_consolidate.js --apply    does it
 *   ... --apply --license-live                              also closes the license problem
 *   ... --apply --rollback-google-posts                     also deletes the two Google posts that promise labor
 *                                                           (only after the live site is checked)
 *
 * Nothing is deleted from the database. Every change goes through the path
 * the system already audits: the action engine's rollback (Google posts the
 * Kingdom published), a finding's status with the evidence in statusNote,
 * resolveDecision (the owner's confirm), the inbox's setWaiting, and
 * assignTask / cancelTask. Records whose item closes are then settled by the
 * board itself (settleDecisions), exactly as when the owner decides in Admin.
 *
 * WHY each step: see the EVIDENCE strings - they are what the records say.
 */
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");
const LICENSE_LIVE = process.argv.includes("--license-live");
const GBP = process.argv.includes("--rollback-google-posts"); // deletes the two posts on the live Google listing
const BY = "Owner (brief 2026-11-03, applied by Claude)";

const FREE_VISIT_NOW =
  "Since 2026-10-30 the Free Visit is a free visit to walk through the homeowner's to-do list and help them choose the right Profixter service; the booking page says repairs and labor are not included.";

const PLAN = {
  // Google posts the Kingdom published that promise 90 minutes of free work
  rollbackGbp: [
    { id: "6ae01b3b3a0fa9084cd5fb37", why: `"a real working visit of up to 90 minutes" - ${FREE_VISIT_NOW}` },
    { id: "6ae89edee290d8223476649f", why: `"a real working visit of up to 90 minutes spent on your list" - ${FREE_VISIT_NOW}` },
  ],
  retirePlaybooks: [
    { key: "registered-never-booked-v1", why: `Its wording promises "a real working visit ... up to 90 minutes working on the jobs on your list". ${FREE_VISIT_NOW} The send-time copy check now refuses it; Marcus rewrites the replacement (registered-never-booked-v2).` },
  ],
  // risks/anomalies, closed with the evidence that settles them
  resolveProblems: [
    { id: "6ad0ceab18f8815f28a24bd1", evidence: "Checked the stored copy of every email sent (EmailLog html): all 6 registered-never-booked-v1 emails (4 on 10-27, 2 on 10-31) carried exactly https://www.profixter.com/book/free plus the unsubscribe link. Marcus and Arthur now see each playbook's buttonLink in list_email_playbooks." },
    { id: "6ae897d42d704d9a31f163c6", evidence: "Same check as 6ad0ceab: all 6 sent emails' button opened https://www.profixter.com/book/free. Duplicate of 6ad0ceab." },
    { id: "6ae343bd95958397ff9edd7c", evidence: "Fixed in code (2026-11-03): a one-step request on a person's own email or phone keeps them out of the never-booked audience and Track A; a completed guest visit joins the one account that proved its phone or email; follow-up email links carry utm_campaign so a request is credited (last30ByCampaign, playbook results). Live data: 4 one-step requests ever, none from an account that was still in the never-booked audience." },
    { id: "6ae897d42d704d9a31f163c4", evidence: "The jump was staff-recorded phone consent (Admin, 2026-10-31), not customers opting in. No marketing text goes out on it (marketingSmsBasis: needs_confirmation). Marcus's counts now read it the same way: optedInToMarketingTexts counts only qualifying consent, and marketingTextsAwaitingCustomerConfirmation the rest." },
    ...(LICENSE_LIVE
      ? [{ id: "6accd05818f8815f289837ae", evidence: "Live site checked 2026-11-03 after the frontend deploy: footer, homepage trust strip, membership, kitchen, remodeling and landing pages name HI-71484 as a Suffolk County license; no page calls it a New York State license or a Nassau license (test_seo_foundation now refuses a bare 'Licensed HI-71484' and 'NY Licensed')." }]
      : []),
  ],
  // drafts that must not be published as written
  closeDrafts: [
    ...(LICENSE_LIVE ? [{ id: "6ad0d60c18f8815f28a24ebf", status: "superseded", why: "Applied by the developer on 2026-11-03: every page now says Suffolk County license HI-71484 (see the license problem 6accd058)." }] : []),
    { id: "6ae1e80595958397ff9de385", status: "superseded", why: "Already live: since 2026-10-30 the account page shows a Free Visit card only while the server says the free visit is still available, and never to members (AccountOverview)." },
    { id: "6aca58a718f8815f2896796e", status: "dismissed", why: `The live /locations/lindenhurst page was rewritten on 2026-10-30 with the current Free Visit and the Suffolk-only license. This draft promises "a real working visit of up to 90 minutes" - ${FREE_VISIT_NOW}` },
    { id: "6accd03618f8815f289837a4", status: "dismissed", why: `The live /locations/west-babylon page was rewritten on 2026-10-30 with the current Free Visit. This draft promises 90 minutes of work - ${FREE_VISIT_NOW}` },
    { id: "6acccfed18f8815f28983783", status: "dismissed", why: `The after-visit follow-up runs automatically now (lifecycle emails on days 2, 6, 14 and 30 after a completed visit), so a hand-sent copy would double-contact people. Its "[jobs done on the visit]" line no longer fits a visit with no labor - ${FREE_VISIT_NOW}` },
  ],
  // one owner-only record instead of three separate ones
  mergeOwnerSteps: {
    records: ["6ad2159f18f8815f28a38dd0", "6ae0964035a17eb32aba3ba2", "6ae48aba95958397ff9f9753"],
    notes: ["6ad0d62e18f8815f28a24fb1", "6adf565a35a17eb32ab94cca", "6ae34afe95958397ff9ee16f"],
    subject: "Three free listing fixes only you can make (about 30 minutes, all free)",
    simple:
      "Boss, three free listings need your login - nobody else can do these. 1) Google Business Profile: set the Website and Booking buttons to https://www.profixter.com/book/free?utm_source=google&utm_medium=organic&utm_campaign=gbp_button . 2) Nextdoor (nextdoor.com/pages/mrfixter): rename the page from \"Premium Island Homes / Mr. Fixter\" to Profixter and link it to https://www.profixter.com/book/free?utm_source=nextdoor&utm_medium=organic&utm_campaign=nextdoor_page . 3) Yelp: claim the free business page and set its website to https://www.profixter.com/book/free?utm_source=yelp&utm_medium=organic&utm_campaign=yelp_page . Say no to every paid upgrade. Each link is tagged, so the bookings it brings show up by name.",
  },
  // records about the retired sign-up step
  closeObsolete: [{ record: "6adf44ab35a17eb32ab941d6", why: "About the old sign-up step, which no longer exists (one-step booking since 2026-10-23/26)." }],
  // the owner's own task that a newer task replaced (decision #14)
  confirmArchiveRequest: "6ae88d1fe290d82234765342",
  // posts that promise labor: back to Leonidas with the current Free Visit, the owner's decisions wait on it
  leonidas: {
    cancelTask: "6ae73b8fe290d8223475787c",
    drafts: ["6ae0aeaf35a17eb32aba43d1", "6ae0aec935a17eb32aba43da", "6ae0aec935a17eb32aba43db"],
    records: ["6ae1e7a595958397ff9de366", "6ae1e7a595958397ff9de367", "6ae1e7a595958397ff9de368"],
    instruction:
      "Revise your 3 waiting posts (Lindenhurst Facebook 6ae0aeaf35a17eb32aba43d1, West Babylon & Babylon Facebook 6ae0aec935a17eb32aba43da, Instagram carousel 6ae0aec935a17eb32aba43db) and save each under its own id. Since 2026-10-30 the Free Visit is a free visit to walk through the homeowner's to-do list and help them choose the right service - NO labor: remove every 'real working visit', 'up to 90 minutes' and 'gets to work on your list'. Remove every clock-change reference and give a posting day this week. Keep 'one free visit per customer, for new customers', the one-step booking and the tagged /book/free links.",
    why: "All three promise 90 minutes of free work, which the booking page now says is not included; two also mention the Nov 1 clock change.",
  },
  marcus: {
    instruction:
      "Revise the draft playbook registered-never-booked-v2 (same key, still a draft for the owner). Since 2026-10-30 the Free Visit is a free visit to walk through the homeowner's to-do list and help them choose the right Profixter service - NO labor: remove 'a real working visit of up to 90 minutes' and any promise of work. Keep the bookFree button, 'one free visit per customer, for new customers' and the one-step booking. registered-never-booked-v1 was retired today because it promised labor. Report the new version and today's audience.",
    why: "v1 and v2 both promise 90 minutes of free work; the never-booked audience currently has no approved email.",
  },
};

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const AgentFinding = require("../../models/AgentFinding");
  const EmailPlaybook = require("../../models/EmailPlaybook");
  const GrowthAction = require("../../models/GrowthAction");
  const { CouncilDecision, CouncilTask } = require("../../models/Council");
  const log = (what, detail) => console.log(`${APPLY ? "DID " : "WOULD"} ${what}${detail ? ` - ${detail}` : ""}`);
  const at = new Date();
  require("../../utils/growth/actions"); // registers the action types (rollback needs their definitions)
  await require("../../utils/secrets").loadParameterSecrets(); // the Google posting token, as the server loads it

  for (const g of GBP ? PLAN.rollbackGbp : []) {
    const a = await GrowthAction.findById(g.id).lean();
    if (!a || a.status !== "succeeded") {
      log(`skip GBP ${g.id}`, `status ${a?.status}`);
      continue;
    }
    log(`roll back Google post "${a.payload.title}"`, g.why.slice(0, 80));
    if (APPLY) {
      const done = await require("../../utils/growth/actionEngine").rollback(g.id, { kind: "owner", name: BY });
      await GrowthAction.updateOne({ _id: g.id }, { $set: { "rollback.reason": g.why } });
      console.log("   ", JSON.stringify(done.rollback?.result || {}));
    }
  }

  for (const p of PLAN.retirePlaybooks) {
    const pb = await EmailPlaybook.findOne({ key: p.key }).lean();
    if (!pb || pb.status === "retired") {
      log(`skip playbook ${p.key}`, pb?.status);
      continue;
    }
    log(`retire playbook ${p.key} (was ${pb.status} v${pb.version})`);
    if (APPLY) await EmailPlaybook.updateOne({ _id: pb._id }, { $set: { status: "retired", statusNote: `Retired by ${BY} on ${at.toISOString().slice(0, 10)}: ${p.why}`.slice(0, 600) } });
  }

  for (const p of PLAN.resolveProblems) {
    const f = await AgentFinding.findOne({ _id: p.id, status: { $in: ["open", "acknowledged"] } }).lean();
    if (!f) {
      log(`skip problem ${p.id}`, "not open");
      continue;
    }
    log(`resolve problem "${f.title}"`);
    if (APPLY) await AgentFinding.updateOne({ _id: f._id }, { $set: { status: "resolved", statusBy: BY, statusNote: `Checked ${at.toISOString().slice(0, 10)}: ${p.evidence}`.slice(0, 1000) } });
  }

  for (const d of PLAN.closeDrafts) {
    const f = await AgentFinding.findOne({ _id: d.id, status: "open" }).lean();
    if (!f) {
      log(`skip draft ${d.id}`, "not open");
      continue;
    }
    log(`${d.status} draft "${f.title}"`);
    if (APPLY) await AgentFinding.updateOne({ _id: f._id }, { $set: { status: d.status, statusBy: BY, statusNote: d.why.slice(0, 1000) } });
  }

  {
    const m = PLAN.mergeOwnerSteps;
    const open = await CouncilDecision.find({ _id: { $in: m.records }, status: "open" }).lean();
    log(`merge ${open.length} owner-only listing records into one note`);
    if (APPLY && open.length) {
      const keep = await CouncilDecision.findOneAndUpdate(
        { dedupeKey: "owner-steps:free-listings", status: "open" },
        {
          $set: { category: "info", subject: m.subject, simple: m.simple, detail: `Merged from ${open.map((d) => d._id).join(", ")} on ${at.toISOString().slice(0, 10)}. The Oct 27 Google post did not say "per home"; it was rolled back on 2026-11-03 for promising labor.`, recommendation: { choice: "acknowledge", reason: "Free, owner login only. Tagged links make each one measurable." }, inbox: "needs_you" },
          $setOnInsert: { dedupeKey: "owner-steps:free-listings", status: "open", inboxHistory: [{ at, to: "needs_you", by: BY, note: "Three owner-only listing records merged into one" }] },
        },
        { upsert: true, new: true }
      ).lean();
      for (const d of open) {
        await CouncilDecision.updateOne({ _id: d._id, status: "open" }, { $set: { status: "superseded", resolution: { choice: "merged", by: BY, at, note: `Merged into ${keep._id}` } } });
      }
      await AgentFinding.updateMany({ _id: { $in: m.notes }, status: { $in: ["open", "acknowledged"] } }, { $set: { status: "superseded", statusBy: BY, statusNote: `Merged into the owner's single listing note (council record ${keep._id}).` } });
    }
  }

  for (const o of PLAN.closeObsolete) {
    const d = await CouncilDecision.findOne({ _id: o.record, status: "open" }).lean();
    if (!d) {
      log(`skip record ${o.record}`, "not open");
      continue;
    }
    log(`close record "${d.subject}"`, o.why);
    if (APPLY) {
      await CouncilDecision.updateOne({ _id: d._id, status: "open" }, { $set: { status: "resolved", resolution: { choice: "handled", by: BY, at, note: o.why } } });
      for (const r of d.refs || []) if (r.kind === "note") await AgentFinding.updateOne({ _id: r.id, status: { $in: ["open", "acknowledged"] } }, { $set: { status: "superseded", statusBy: BY, statusNote: o.why } });
    }
  }

  {
    const d = await CouncilDecision.findOne({ _id: PLAN.confirmArchiveRequest, status: "open" }).lean();
    log(d ? `confirm archive request "${d.subject}"` : "skip archive request (not open)");
    if (APPLY && d) await require("../../utils/council/arthur").resolveDecision({ id: String(d._id), choice: "confirm", by: BY, note: "Duplicate of Marcus's newer task; kept in history, restorable." });
  }

  const tasks = require("../../utils/council/tasks");
  const inbox = require("../../utils/council/inbox");
  {
    const L = PLAN.leonidas;
    const old = await CouncilTask.findOne({ _id: L.cancelTask, status: { $in: ["received", "assigned", "in_progress"] } }).lean();
    log(old ? "replace Leonidas's clock-change task with one that also removes the labor promise" : "skip Leonidas's old task (not open)");
    let task = null;
    if (APPLY) {
      if (old) await tasks.cancelTask({ taskId: L.cancelTask, by: BY, asOwner: true, note: "Replaced: the posts also promise labor the Free Visit no longer includes." });
      task = (await tasks.assignTask({ agent: "outreach", instruction: L.instruction, why: L.why, origin: "owner", ownerName: BY })).task;
      for (const id of L.records) {
        const d = await CouncilDecision.findOne({ _id: id, status: "open" }).lean();
        if (d) await inbox.setWaiting(id, { kind: "knight", reason: "Leonidas is removing the labor promise (and the clock wording) from this post.", taskId: String(task._id), by: BY });
      }
    }
  }
  {
    const M = PLAN.marcus;
    log("ask Marcus to rewrite the never-booked email without the labor promise");
    if (APPLY) await tasks.assignTask({ agent: "conversion", instruction: M.instruction, why: M.why, origin: "owner", ownerName: BY });
  }

  if (APPLY) {
    const { decisionBoard } = require("../../utils/council/board");
    const board = await decisionBoard({ now: new Date() });
    console.log("board now:", JSON.stringify(board.counts));
    for (const s of board.sections.slice(0, 2)) for (const it of s.items) console.log(`  #${it.number} [${s.key}] ${it.type} - ${it.subject}`);
  }
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
