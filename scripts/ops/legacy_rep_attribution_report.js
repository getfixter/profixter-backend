/*
 * READ-ONLY reconciliation report for the retired cold-call commission
 * records (RepAttribution). It changes nothing: no record is updated,
 * recalculated, voided or paid, and nothing is copied into the new ledger.
 *
 *   MONGO_URI=... node scripts/ops/legacy_rep_attribution_report.js [--out <dir>]
 *
 * Writes <dir>/legacy-rep-attribution-summary.json and
 * <dir>/legacy-rep-attribution-rows.csv (default: ./legacy-report-<date>).
 * Customer contact data is reduced to the last 4 digits of the phone and a
 * yes/no for email; the rows file is still owner-only.
 *
 * Each row is flagged with the reasons it would be wrong under the current rules:
 *   annual_at_50pct      an annual sale credited 50% of the annual price (should be one month's regular price)
 *   catalog_not_paid     the amount was computed from the catalog price, not what was paid (always true for this code)
 *   email_match_possible the record has an email, so a later signup/purchase may have been matched by email alone
 *   paid_then_overwritten a "paid" record whose amount was recomputed after commissionPaidAt
 *   unknown_rep          the rep is "Unknown Rep" or empty
 *   no_user_ref          the rep is a free-text name/GHL id, not a Profixter account
 */
const fs = require("fs");
const path = require("path");

const MONTHLY = { basic: 149, plus: 249, premium: 349, elite: 499 };

function analyze(rows) {
  const out = [];
  const summary = {
    total: rows.length,
    byStatus: {},
    byCommissionStatus: {},
    withCommission: 0,
    commissionTotal: 0,
    paidCount: 0,
    paidTotal: 0,
    flags: {},
    expectedUnderCurrentRules: 0,
    note: "Read-only. Nothing was changed, recalculated or paid. The new ledger does not import these amounts.",
  };
  for (const r of rows) {
    summary.byStatus[r.status || "none"] = (summary.byStatus[r.status || "none"] || 0) + 1;
    summary.byCommissionStatus[r.commissionStatus || "none"] = (summary.byCommissionStatus[r.commissionStatus || "none"] || 0) + 1;
    const amount = Number(r.commissionAmount || 0);
    if (amount > 0) {
      summary.withCommission += 1;
      summary.commissionTotal += amount;
    }
    if (r.commissionStatus === "paid") {
      summary.paidCount += 1;
      summary.paidTotal += amount;
    }
    const flags = [];
    const plan = String(r.subscriptionPlan || "").toLowerCase();
    if (r.subscriptionBillingCycle === "annual" && amount > 0) flags.push("annual_at_50pct");
    if (amount > 0) flags.push("catalog_not_paid");
    if (r.emailNormalized) flags.push("email_match_possible");
    if (r.commissionStatus === "paid" && r.commissionPaidAt && r.lastSyncedAt && new Date(r.lastSyncedAt) > new Date(r.commissionPaidAt)) flags.push("paid_then_overwritten");
    if (!r.repName || r.repName === "Unknown Rep") flags.push("unknown_rep");
    flags.push("no_user_ref");
    for (const f of flags) summary.flags[f] = (summary.flags[f] || 0) + 1;
    let expected = null;
    if (r.status === "subscribed" && MONTHLY[plan]) expected = r.subscriptionBillingCycle === "annual" ? MONTHLY[plan] : null;
    if (expected) summary.expectedUnderCurrentRules += expected;
    out.push({
      id: String(r._id),
      rep: r.repName || "",
      status: r.status || "",
      plan,
      cycle: r.subscriptionBillingCycle || "",
      value: Number(r.subscriptionValue || 0),
      commissionAmount: amount,
      commissionStatus: r.commissionStatus || "",
      commissionPaidAt: r.commissionPaidAt ? new Date(r.commissionPaidAt).toISOString() : "",
      matchedUser: r.matchedUserId ? String(r.matchedUserId) : "",
      phoneLast4: String(r.phoneNormalized || "").slice(-4),
      hasEmail: r.emailNormalized ? "yes" : "no",
      assignedAt: r.assignedAt ? new Date(r.assignedAt).toISOString() : "",
      subscribedAt: r.subscribedAt ? new Date(r.subscribedAt).toISOString() : "",
      annualExpectedUnderCurrentRule: expected ?? "",
      flags: flags.join(" "),
    });
  }
  summary.commissionTotal = Math.round(summary.commissionTotal * 100) / 100;
  summary.paidTotal = Math.round(summary.paidTotal * 100) / 100;
  return { summary, rows: out };
}

function toCsv(rows) {
  if (!rows.length) return "id\n";
  const keys = Object.keys(rows[0]);
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => cell(r[k])).join(","))].join("\n") + "\n";
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is required (read-only use).");
  const outIdx = process.argv.indexOf("--out");
  const dir = outIdx > 0 ? process.argv[outIdx + 1] : `legacy-report-${new Date().toISOString().slice(0, 10)}`;
  // The raw driver: no models, so no index builds or writes of any kind.
  const { MongoClient } = require(require.resolve("mongodb", { paths: [require.resolve("mongoose")] }));
  const client = new MongoClient(uri, { readPreference: "secondaryPreferred" });
  await client.connect();
  try {
    const rows = await client.db().collection("repattributions").find({}).toArray();
    const { summary, rows: out } = analyze(rows);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "legacy-rep-attribution-summary.json"), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(dir, "legacy-rep-attribution-rows.csv"), toCsv(out));
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Wrote ${dir}`);
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { analyze, toCsv };
