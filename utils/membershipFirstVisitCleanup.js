/*
 * Cleaning up membership first-visit drafts nobody paid for (2026-11-03).
 *
 * Book a Handyman saves the visit and its photos (MembershipFirstVisitDraft)
 * before the Stripe page opens. Most are paid and booked; some are not - the
 * checkout never opened (a taken time, a refused plan, a closed tab) or the
 * page lapsed without the expiry webhook reaching us. This removes what those
 * left behind, on the existing hold-cleanup schedule (jobs/oneTimeVisitHolds.js).
 *
 * RETENTION
 *   - A draft that never reached Stripe (status "draft", no checkout page) is
 *     abandoned DRAFT_ABANDON_AFTER (24 hours) after it was last touched, and
 *     its photos are deleted.
 *   - A draft whose Stripe page is still "open" here after CHECKOUT_RECHECK_AFTER
 *     (2 hours; our pages expire after 31 minutes) is checked WITH STRIPE:
 *       complete/paid -> handed to fulfillment as paid (never deleted);
 *       expired       -> abandoned, photos deleted;
 *       still open, or Stripe unreachable -> left alone, checked next time.
 *   - Abandoned and expired drafts keep their record (job, home, time) for
 *     RECORD_RETENTION (30 days) after their photos are gone, then the record
 *     is deleted. A payment that somehow still arrives in that time is booked
 *     from the record (markFirstVisitPaid accepts it).
 *
 * NEVER TOUCHED: paid, fulfilling, booked, needs_admin and rebooked drafts,
 * any Booking, Subscription or User, and any photo a Booking refers to.
 *
 * SAFE TO RUN TWICE, OR AT ONCE: every state change is one conditional update
 * (a payment confirmed meanwhile wins - the update finds the draft no longer
 * in the state it expected and does nothing), photos are deleted only after
 * the draft is safely abandoned, a failed deletion is recorded and retried on
 * the next run, and a draft being worked on is claimed for a few minutes.
 */
const Draft = require("../models/MembershipFirstVisitDraft");
const Booking = require("../models/Booking");

const HOUR = 60 * 60 * 1000;
const DRAFT_ABANDON_AFTER_MS = 24 * HOUR;
const CHECKOUT_RECHECK_AFTER_MS = 2 * HOUR;
const RECORD_RETENTION_MS = 30 * 24 * HOUR;
const CLAIM_MS = 10 * 60 * 1000;
const BATCH = 50;

function log(level, event, fields = {}) {
  const line = JSON.stringify({ event, scope: "first_visit_cleanup", ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
const message = (error) => String(error?.message || error).slice(0, 200);

/* One worker per draft at a time; a claim older than CLAIM_MS (a crashed run) can be taken over. */
async function claim(filter, now) {
  return Draft.findOneAndUpdate(
    { ...filter, $or: [{ cleanupClaimedAt: null }, { cleanupClaimedAt: { $lt: new Date(now.getTime() - CLAIM_MS) } }] },
    { $set: { cleanupClaimedAt: now } },
    { new: true }
  );
}
const unclaim = (id) => Draft.updateOne({ _id: id }, { $set: { cleanupClaimedAt: null } });

/**
 * Delete a no-longer-needed draft's photos: only an abandoned or expired
 * draft's, never one a Booking refers to. Records success or the failure (to
 * retry). Safe to call repeatedly. Returns true once its photos are gone.
 */
async function deleteDraftPhotos(draftId, { deleteObjects = null } = {}) {
  const draft = await Draft.findById(draftId).lean();
  if (!draft || !["abandoned", "expired"].includes(draft.status)) return false;
  if (draft.photosDeletedAt) return true;
  const keys = (draft.s3Keys || []).filter(Boolean);
  const used = new Set();
  try {
    if (keys.length) {
      // A photo a booking uses (one made from this draft, say) stays.
      if ((draft.images || []).length) {
        const users = await Booking.find({ images: { $in: draft.images } }).select("images").lean();
        for (const b of users) for (const url of b.images || []) used.add(url);
      }
      const removable = keys.filter((key, i) => !used.has(draft.images?.[i]) && ![...used].some((url) => String(url).endsWith(key)));
      if (removable.length) {
        const remove =
          deleteObjects ||
          ((input) => {
            // Loaded here: utils/s3 refuses to load without S3_BUCKET.
            const { deletePublicObjects } = require("./s3");
            return deletePublicObjects(input);
          });
        if (!process.env.S3_BUCKET && !deleteObjects) throw new Error("S3_BUCKET is not set");
        await remove({ Bucket: process.env.S3_BUCKET, Keys: removable });
      }
    }
    // The record forgets deleted photos, so a late payment books without pointing at files that are gone.
    const keptImages = (draft.images || []).filter((url) => used.has(url));
    const keptKeys = keys.filter((key) => [...used].some((url) => String(url).endsWith(key)));
    await Draft.updateOne({ _id: draft._id }, { $set: { photosDeletedAt: new Date(), cleanupError: "", images: keptImages, s3Keys: keptKeys } });
    log("info", "first_visit_draft_photos_deleted", { draftId: String(draft._id), photos: keys.length });
    return true;
  } catch (error) {
    await Draft.updateOne({ _id: draft._id }, { $set: { cleanupError: message(error) }, $inc: { cleanupAttempts: 1 } });
    log("error", "first_visit_draft_photo_delete_failed", { draftId: String(draft._id), error: message(error) });
    return false;
  }
}

/** Never reached Stripe: give it up, then its photos. */
async function abandonUnsentDraft(now, options) {
  const draft = await claim({ status: "draft", checkoutSessionId: null, updatedAt: { $lt: new Date(now.getTime() - DRAFT_ABANDON_AFTER_MS) } }, now);
  if (!draft) return null;
  // Conditional: a checkout that opened for it meanwhile (status/checkoutSessionId changed) wins.
  const abandoned = await Draft.findOneAndUpdate(
    { _id: draft._id, status: "draft", checkoutSessionId: null },
    { $set: { status: "abandoned", abandonedAt: now, cleanupClaimedAt: null } },
    { new: true }
  );
  if (!abandoned) {
    await unclaim(draft._id);
    return { id: draft._id, outcome: "kept" };
  }
  await deleteDraftPhotos(abandoned._id, options);
  return { id: draft._id, outcome: "abandoned" };
}

/** Its Stripe page should be long gone: ask Stripe before touching anything. */
async function recheckOpenCheckout(now, { retrieveSession, ...options }) {
  const draft = await claim({ status: "checkout_open", updatedAt: { $lt: new Date(now.getTime() - CHECKOUT_RECHECK_AFTER_MS) } }, now);
  if (!draft) return null;
  let session;
  try {
    session = await retrieveSession(draft.checkoutSessionId);
  } catch (error) {
    // Not knowing is never a reason to delete: try again on the next run.
    await Draft.updateOne({ _id: draft._id }, { $set: { cleanupError: message(error), cleanupClaimedAt: null }, $inc: { cleanupAttempts: 1 } });
    return { id: draft._id, outcome: "stripe_unreachable" };
  }
  const paid = session?.status === "complete" && ["paid", "no_payment_required"].includes(String(session?.payment_status || ""));
  if (paid) {
    // The payment notice never reached us: book it (the fulfillment sweep picks "paid" drafts up).
    await Draft.updateOne(
      { _id: draft._id, status: "checkout_open" },
      { $set: { status: "paid", paidAt: now, cleanupClaimedAt: null } }
    );
    log("info", "first_visit_draft_reconciled_paid", { draftId: String(draft._id) });
    return { id: draft._id, outcome: "reconciled_paid" };
  }
  if (session?.status !== "expired") {
    await unclaim(draft._id);
    return { id: draft._id, outcome: "still_open" };
  }
  const abandoned = await Draft.findOneAndUpdate(
    { _id: draft._id, status: "checkout_open" },
    { $set: { status: "abandoned", abandonedAt: now, cleanupClaimedAt: null } },
    { new: true }
  );
  if (!abandoned) {
    await unclaim(draft._id);
    return { id: draft._id, outcome: "kept" };
  }
  await deleteDraftPhotos(abandoned._id, options);
  return { id: draft._id, outcome: "abandoned" };
}

/**
 * One pass. `retrieveSession(id)` asks Stripe for a checkout session (the
 * Stripe client by default); `deleteObjects` replaces the S3 delete (tests).
 */
async function cleanupFirstVisitDrafts({ now = new Date(), retrieveSession = null, deleteObjects = null } = {}) {
  const retrieve =
    retrieveSession ||
    ((id) => {
      const { stripe } = require("./subscriptionManagement");
      return stripe.checkout.sessions.retrieve(id);
    });
  const tally = { abandoned: 0, reconciledPaid: 0, photoRetries: 0, recordsDeleted: 0, kept: 0, errors: 0 };
  const count = (r) => {
    if (!r) return;
    if (r.outcome === "abandoned") tally.abandoned += 1;
    else if (r.outcome === "reconciled_paid") tally.reconciledPaid += 1;
    else if (r.outcome === "stripe_unreachable") tally.errors += 1;
    else tally.kept += 1;
  };

  for (let i = 0; i < BATCH; i++) {
    const r = await abandonUnsentDraft(now, { deleteObjects });
    if (!r) break;
    count(r);
  }
  for (let i = 0; i < BATCH; i++) {
    const r = await recheckOpenCheckout(now, { retrieveSession: retrieve, deleteObjects });
    if (!r) break;
    count(r);
    if (r.outcome !== "abandoned" && r.outcome !== "reconciled_paid") break; // the rest are not due either; next run
  }

  // Photos a previous run could not delete (or an expired page's): try again.
  const pending = await Draft.find({ status: { $in: ["abandoned", "expired"] }, photosDeletedAt: null }).select("_id").limit(BATCH).lean();
  for (const d of pending) {
    if (await deleteDraftPhotos(d._id, { deleteObjects })) tally.photoRetries += 1;
    else tally.errors += 1;
  }

  // Records past retention, photos gone.
  const old = new Date(now.getTime() - RECORD_RETENTION_MS);
  const removed = await Draft.deleteMany({
    status: { $in: ["abandoned", "expired"] },
    photosDeletedAt: { $ne: null, $lt: old },
  });
  tally.recordsDeleted = removed.deletedCount || 0;

  if (tally.abandoned || tally.reconciledPaid || tally.recordsDeleted || tally.errors) log("info", "first_visit_cleanup_pass", tally);
  return tally;
}

module.exports = {
  DRAFT_ABANDON_AFTER_MS,
  CHECKOUT_RECHECK_AFTER_MS,
  RECORD_RETENTION_MS,
  cleanupFirstVisitDrafts,
  deleteDraftPhotos,
};
