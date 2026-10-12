/**
 * READ-ONLY Kingdom health from the production log (owner-approved access).
 *
 *   node scripts/ops/kingdom_log_health.js
 *
 * Asks Elastic Beanstalk for a fresh log bundle (the same "Request logs"
 * button as the console), reads web.stdout.log IN MEMORY, and prints only the
 * Kingdom's own events with a fixed whitelist of fields - agent, status,
 * counts, errors. No summaries, no request logs, nothing about customers.
 * The downloaded bundle is deleted. Nothing in production is changed.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");

const ENV = "Handyman-v2-env";
const REGION = "us-east-1";
const aws = (...args) => execFileSync("aws", [...args, "--region", REGION, "--output", "json"], { encoding: "utf8" });

/* Only these events, only these fields. */
const KEEP = {
  agent_jobs_started: [],
  agent_run: ["agent", "trigger", "status", "turns", "costCents", "tools", "toolErrors", "actions", "error"],
  agent_run_crashed: ["agent", "error"],
  council_review: ["reason", "status", "skipped"],
  council_review_crashed: ["error"],
  council_health: null, // counts only, by construction (utils/council/health.js) - kept whole
  marketing_report_check: ["firstFreeVisits30", "sourcesTotal30", "adds_up", "funnelFirstFreeVisits", "ratesShown", "newMembershipPurchases30", "countedThrough", "trend", "noFirstTouchRecord30"],
  kingdom_scope_archived: ["tasks", "notes", "records", "playbooks"],
  ghl_social_check: ["tokenLoaded", "auth", "accounts", "googleBusinessProfile", "postableByKingdom", "actionEngine", "enabledTypes", "error"],
  growth_action_suspended: ["type", "failures7d"],
  attention_audit: ["needsYou", "inDecisions", "beingWorkedOn", "arthurReviewing"],
  council_health_failed: ["error"],
  arthur_mission_updated: ["version", "note"],
};

function pick(event, row) {
  const fields = KEEP[event];
  if (fields === null) return row;
  const out = {};
  for (const f of fields) if (row[f] !== undefined) out[f] = row[f];
  if (Array.isArray(out.toolErrors)) out.toolErrors = out.toolErrors.map((e) => String(e).slice(0, 120));
  if (out.error) out.error = String(out.error).slice(0, 200);
  return out;
}

function download(url, file) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`download ${res.statusCode}`));
        res.pipe(fs.createWriteStream(file)).on("finish", resolve).on("error", reject);
      })
      .on("error", reject);
  });
}

async function main() {
  const asked = Date.now();
  aws("elasticbeanstalk", "request-environment-info", "--environment-name", ENV, "--info-type", "bundle");
  let info = [];
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 6000));
    info = JSON.parse(aws("elasticbeanstalk", "retrieve-environment-info", "--environment-name", ENV, "--info-type", "bundle")).EnvironmentInfo || [];
    if (info.length && info.every((x) => new Date(x.SampleTimestamp).getTime() >= asked - 60000)) break;
  }
  if (!info.length) throw new Error("No log bundle came back from Elastic Beanstalk.");

  const seen = new Set();
  const rows = [];
  for (const inst of info) {
    const zip = path.join(os.tmpdir(), `kingdom-logs-${inst.Ec2InstanceId}-${Date.now()}.zip`);
    try {
      await download(inst.Message, zip);
      const text = execFileSync("unzip", ["-p", zip, "var/log/web.stdout.log"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
      for (const line of text.split("\n")) {
        const at = line.indexOf('{"event":"');
        if (at < 0) continue;
        let row;
        try {
          row = JSON.parse(line.slice(at));
        } catch {
          continue;
        }
        if (!(row.event in KEEP)) continue;
        const stamp = (line.slice(0, at).match(/^\w{3}\s+\d+\s+[\d:]+/) || [line.slice(0, 15)])[0];
        const key = `${stamp}|${JSON.stringify(row).length}|${row.event}`; // bundles can repeat a log
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ when: stamp, instance: inst.Ec2InstanceId, event: row.event, ...pick(row.event, row) });
      }
    } finally {
      fs.rmSync(zip, { force: true });
    }
  }
  const first = rows[0]?.when || "(no Kingdom events)";
  console.log(`Kingdom events in the current production log: ${rows.length} (log starts at the instance's boot; first event ${first})\n`);
  for (const r of rows) console.log(JSON.stringify(r));
}

main().catch((error) => {
  console.error(`kingdom_log_health: ${error.message}`);
  process.exit(1);
});
