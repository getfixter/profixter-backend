/**
 * What the 30% cancellation save offer has actually been worth.
 *
 * READ-ONLY. Opens a connection, counts, prints, disconnects. It writes
 * nothing and calls no external service, so it is safe to point at production.
 *
 *   MONGO_URI=... node scripts/measure_retention_offer.js
 *
 * Exists to answer one question before Loyalty Benefits replaces the offer as
 * the first cancellation screen: how many people has it saved? The answer is
 * reconstructable from Subscription.retentionOffer, which stamps offeredAt when
 * the offer is shown and acceptedAt or declinedAt when the customer chooses.
 *
 * TWO LIMITS, STATED HERE RATHER THAN DISCOVERED LATER:
 *
 *  - "Shown" undercounts. offeredAt is only written when the eligibility route
 *    returns eligible, so anybody who opened the cancel modal while the coupon
 *    env var was unset, or who was already scheduled to cancel, is invisible.
 *  - "Declined" undercounts. declinedAt is written only when the frontend posts
 *    retentionOfferDeclined, so a customer who closed the modal and cancelled
 *    later, or cancelled through the Stripe billing portal, is not counted as a
 *    decline. Cancellations with no decline stamp are reported separately.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Subscription = require("../models/Subscription");

function pct(part, whole) {
  if (!whole) return "n/a";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function money(cents) {
  if (!Number.isFinite(cents)) return "n/a";
  return `$${(cents / 100).toFixed(2)}`;
}

function row(label, value, note = "") {
  console.log(`  ${label.padEnd(46)}${String(value).padStart(10)}  ${note}`);
}

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error("MONGO_URI is required");
  await mongoose.connect(mongoUri);

  const [
    totalSubscriptions,
    offered,
    accepted,
    declined,
    errored,
    canceledEver,
    canceledWithoutOffer,
  ] = await Promise.all([
    Subscription.countDocuments({}),
    Subscription.countDocuments({ "retentionOffer.offeredAt": { $ne: null } }),
    Subscription.countDocuments({ "retentionOffer.acceptedAt": { $ne: null } }),
    Subscription.countDocuments({ "retentionOffer.declinedAt": { $ne: null } }),
    Subscription.countDocuments({ "retentionOffer.lastErrorAt": { $ne: null } }),
    Subscription.countDocuments({
      $or: [{ status: { $in: ["canceled", "expired"] } }, { cancelAtPeriodEnd: true }],
    }),
    Subscription.countDocuments({
      $or: [{ status: { $in: ["canceled", "expired"] } }, { cancelAtPeriodEnd: true }],
      "retentionOffer.offeredAt": null,
    }),
  ]);

  /*
   * Did accepting actually keep them? Accepted-then-cancelled-anyway is the
   * number that decides whether the offer buys a month or a member.
   */
  const acceptedStillActive = await Subscription.countDocuments({
    "retentionOffer.acceptedAt": { $ne: null },
    status: { $in: ["active", "trialing"] },
    cancelAtPeriodEnd: { $ne: true },
  });

  const discountRows = await Subscription.find(
    { "retentionOffer.acceptedAt": { $ne: null } },
    { "retentionOffer.discountAmountCents": 1, subscriptionType: 1, planPrice: 1 }
  ).lean();

  const discountTotal = discountRows.reduce(
    (sum, doc) => sum + (Number(doc.retentionOffer?.discountAmountCents) || 0),
    0
  );

  const byPlan = discountRows.reduce((acc, doc) => {
    const plan = String(doc.subscriptionType || "unknown");
    acc[plan] = (acc[plan] || 0) + 1;
    return acc;
  }, {});

  const decided = accepted + declined;

  console.log("\n30% CANCELLATION SAVE OFFER — lifetime, from Subscription.retentionOffer\n");

  console.log("REACH");
  row("Subscriptions in the database", totalSubscriptions);
  row("Offer shown (offeredAt stamped)", offered, `${pct(offered, totalSubscriptions)} of all`);
  row("Cancelled without ever seeing it", canceledWithoutOffer, "portal, ineligible, or pre-offer");
  console.log("");

  console.log("OUTCOME");
  row("Accepted", accepted, decided ? `${pct(accepted, decided)} of decided` : "");
  row("Declined (continued cancellation)", declined, decided ? `${pct(declined, decided)} of decided` : "");
  row("Shown but no recorded decision", Math.max(offered - decided, 0), "closed the modal");
  row("Stripe coupon apply failed", errored);
  console.log("");

  console.log("DID IT HOLD?");
  row("Accepted and still active today", acceptedStillActive, pct(acceptedStillActive, accepted));
  row("Accepted and since cancelled", Math.max(accepted - acceptedStillActive, 0));
  console.log("");

  console.log("COST");
  row("Total discount given", money(discountTotal));
  row("Average per acceptance", accepted ? money(Math.round(discountTotal / accepted)) : "n/a");
  for (const [plan, count] of Object.entries(byPlan).sort()) {
    row(`  accepted on ${plan}`, count);
  }
  console.log("");

  console.log("CONTEXT");
  row("Total cancellations (ever, incl. scheduled)", canceledEver);
  row("Acceptance rate among those shown", offered ? pct(accepted, offered) : "n/a");
  console.log("\nCaveats: 'shown' and 'declined' both undercount. See the header of this file.\n");

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("measure_retention_offer failed:", error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
