const EmailPlaybook = require("../../models/EmailPlaybook");

/**
 * Corrections to playbook DRAFTS that no one can approve as written.
 *
 * A revision is saved the way Marcus's own revisions are (version + 1, still
 * a draft), so it reaches the owner as ONE approval item and nothing sends
 * until they approve that exact version. The wording it replaces is written
 * to the log first, so the earlier version is never lost. Idempotent: it
 * applies only to the exact version it was written against.
 *
 * 2026-10-27, registered-never-booked-v1 (draft v1, written 2026-10-12):
 *   - said "one per home" - the rule is ONE PER CUSTOMER (copy rules refuse it)
 *   - described the old booking ("tell us what you'd like done, and confirm")
 *     - booking is now one step: a time, name, mobile and email
 */
const NEVER_BOOKED_V2 = {
  subject: "Your free first visit with Profixter is ready to book",
  preheader: "A real working visit of up to 90 minutes at your home. Booking takes about a minute.",
  headline: "Pick a time for your free first visit",
  paragraphs: [
    "You created a Profixter account a little while ago but haven't picked a time for your first visit yet. No pressure at all. I just wanted to make sure you know how it works.",
    "Your first visit is a real working visit, not a sales call: one of our handymen comes to your home and spends up to 90 minutes working on the jobs on your list. It's free for new customers, one per customer.",
    "Booking takes about a minute: choose a day and time on our website, add your name, mobile and email, and send. We'll confirm your visit with you.",
    "If you like how it goes, membership keeps a handyman coming back at a steady pace, so small jobs get done before they pile up. You can decide after the visit.",
  ],
  ctaLabel: "Choose a time for my free visit",
  ctaRoute: "bookFree",
  closing: "Thanks for thinking of us. We'd be glad to help around your home.",
};

const REVISIONS = [
  {
    key: "registered-never-booked-v1",
    fromVersion: 1,
    note: "Revised 2026-10-27: one free visit per customer (not per home); the one-step booking. Waits for the owner's approval.",
    fields: NEVER_BOOKED_V2,
  },
  /*
   * 2026-10-27, the owner's final wording of the booking paragraph (v2 -> v3).
   * The FINAL version: it waits for the owner's one-time approval.
   */
  {
    key: "registered-never-booked-v1",
    fromVersion: 2,
    note: "Final wording from the owner (2026-10-27): the booking paragraph. Waits for the owner's one-time approval.",
    fields: {
      ...NEVER_BOOKED_V2,
      paragraphs: [
        NEVER_BOOKED_V2.paragraphs[0],
        NEVER_BOOKED_V2.paragraphs[1],
        "Booking is simple: choose an available day and time on our website and submit your request. We'll confirm your visit with you.",
        NEVER_BOOKED_V2.paragraphs[3],
      ],
    },
  },
];

async function applyPlaybookRevisions() {
  const applied = [];
  for (const r of REVISIONS) {
    const pb = await EmailPlaybook.findOne({ key: r.key });
    if (!pb || pb.status !== "draft" || pb.version !== r.fromVersion) continue;
    console.log(
      JSON.stringify({
        event: "playbook_revised_previous",
        key: pb.key,
        version: pb.version,
        subject: pb.subject,
        preheader: pb.preheader,
        headline: pb.headline,
        paragraphs: pb.paragraphs,
        ctaLabel: pb.ctaLabel,
        ctaRoute: pb.ctaRoute,
        closing: pb.closing,
      })
    );
    Object.assign(pb, r.fields, { status: "draft", version: pb.version + 1, statusNote: r.note });
    await pb.save();
    applied.push({ key: pb.key, version: pb.version });
    console.log(JSON.stringify({ event: "playbook_revised", key: pb.key, version: pb.version, status: "draft" }));
  }
  return applied;
}

module.exports = { REVISIONS, applyPlaybookRevisions };
