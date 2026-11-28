/**
 * Repair missing tip records: Stripe tips that have no Profixter Tip.
 *
 * DRY RUN BY DEFAULT. Prints every category the reconciliation finds and, for
 * each missing tip, the exact record that would be written (amount, payment
 * date, customer, visit, Fixter and what the credit rests on). Nothing is
 * written unless --apply is given.
 *
 *   node scripts/repair_missing_tips.js                       dry run, whole ledger
 *   node scripts/repair_missing_tips.js --pi=pi_a,pi_b        dry run, these payments only
 *   node scripts/repair_missing_tips.js --pi=pi_a,pi_b --apply
 *
 * SCOPE AND SAFETY
 * - Only the website ledger's lifetime: never before TIP_LEDGER_STARTED_AT
 *   (2026-08-12 18:00 UTC). Older old-link tips were never website records.
 * - Writes Tip rows only, through the same recorder the Stripe webhook uses
 *   (utils/tipRecording), so a rerun, a webhook retry and the hourly job can
 *   never produce a second Tip for one payment (unique PaymentIntent index).
 * - Never writes to Stripe (list and retrieve only), never emails or texts
 *   anyone, never triggers a payout.
 * - With --apply, refunds behind Stripe are brought level and amount
 *   differences / disputes are flagged for review, by the existing rules.
 *
 * Needs MONGO_URI and STRIPE_SECRET_KEY in the environment.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const args = process.argv.slice(2);
const flag = (name) => args.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
const value = (name) => (flag(name) || "").split("=").slice(1).join("=");

async function main() {
  const apply = !!flag("apply");
  const only = value("pi") ? new Set(value("pi").split(",").map((v) => v.trim()).filter(Boolean)) : null;
  const since = value("since") ? new Date(value("since")) : undefined;
  const until = value("until") ? new Date(value("until")) : new Date();
  if (apply && !only) {
    throw new Error("--apply needs --pi=<ids from the dry run>, so a repair writes exactly what was reviewed.");
  }

  await mongoose.connect(process.env.MONGO_URI);
  const Tip = require("../models/Tip");
  await Tip.init();
  const { reconcileTips, summarize } = require("../utils/tipReconcile");

  const result = await reconcileTips({ since, until, apply, only, recordedBy: "repair", plan: !apply });
  const duplicates = await Tip.aggregate([{ $group: { _id: "$stripePaymentIntentId", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]);

  console.log(JSON.stringify({ mode: apply ? "APPLY" : "DRY RUN", ...summarize(result), duplicateTipRows: duplicates.length }, null, 1));
  for (const row of result.missing) {
    console.log(JSON.stringify({ missing: row.paymentIntentId, paidAt: row.paidAt, amountCents: row.amountCents, source: row.source, plan: row.plan || undefined }));
  }
  for (const row of result.recorded) console.log(JSON.stringify({ recorded: row.paymentIntentId, tipId: row.tipId, attributed: row.attributed }));
  for (const key of ["amountMismatch", "refundBehind", "disputed", "unexplained", "pending"]) {
    for (const row of result[key]) console.log(JSON.stringify({ [key]: row }));
  }
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("repair failed:", String(error?.message || error).replace(/mongodb(\+srv)?:\/\/[^\s]+/g, "[uri]"));
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
