#!/usr/bin/env node
/*
 * Ask production to send one "your membership is active again" email and text
 * to the member behind ONE Stripe subscription, after a repair.
 *
 * This only records the request. The running server's jobs/membershipNotices
 * claims it, re-checks that the membership is genuinely working (our record
 * AND Stripe), and sends through the normal email and SMS systems, once.
 * Running this twice does nothing the second time.
 *
 *   MONGO_URI=... node scripts/ops/request_membership_restored_notice.js sub_XXXX --by "name" [--confirm]
 *
 * Without --confirm it only reports what it would do.
 */
const mongoose = require("mongoose");
const Subscription = require("../../models/Subscription");

(async () => {
  const stripeSubscriptionId = process.argv[2];
  const byIndex = process.argv.indexOf("--by");
  const requestedBy = byIndex > 0 ? process.argv[byIndex + 1] : "";
  const confirm = process.argv.includes("--confirm");
  if (!/^sub_/.test(stripeSubscriptionId || "") || !requestedBy) {
    console.error("usage: request_membership_restored_notice.js sub_XXXX --by <name> [--confirm]");
    process.exit(2);
  }

  await mongoose.connect(process.env.MONGO_URI);
  const record = await Subscription.findOne({ stripeSubscriptionId });
  if (!record) throw new Error(`no record for ${stripeSubscriptionId}`);
  console.log(JSON.stringify({
    record: String(record._id),
    status: record.status,
    accessStatus: record.accessStatus,
    alreadyRequested: record.restorationNotice?.requestedAt || null,
  }));
  if (record.restorationNotice?.requestedAt) {
    console.log("already requested; nothing to do");
  } else if (!confirm) {
    console.log("dry run; pass --confirm to request the notice");
  } else {
    const result = await Subscription.updateOne(
      { _id: record._id, "restorationNotice.requestedAt": null },
      { $set: { "restorationNotice.requestedAt": new Date(), "restorationNotice.requestedBy": requestedBy } }
    );
    console.log(result.modifiedCount ? "requested" : "already requested by someone else");
  }
  await mongoose.disconnect();
})().catch(async (error) => {
  console.error("ERR", error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
