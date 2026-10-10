const express = require("express");
const auth = require("../middleware/auth");
const { requirePermission, PERMISSIONS } = require("../middleware/authorize");
const GrowthAction = require("../models/GrowthAction");
require("../utils/growth/actions");
const engine = require("../utils/growth/actionEngine");
const { buildCommandCenter } = require("../utils/growth/commandCenter");

/**
 * Growth Command Center API.
 *
 * Reading is the Overview permission: whoever may see the business numbers may
 * see what the growth system is doing. Deciding is the owner's alone - approving
 * an action sends something to a customer or spends money, and changing a
 * policy decides what will run unattended from then on - so those routes need
 * the owner key, which no employee section grants.
 */
const router = express.Router();

router.use(auth);
router.use((req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
});

const canRead = requirePermission(PERMISSIONS.ANALYTICS_READ);
const ownerOnly = requirePermission(PERMISSIONS.ADMIN);

function ownerActor(req) {
  const user = req.accessUser || {};
  return { kind: "owner", name: user.name || user.email || "Owner", userId: user._id || null };
}

function fail(res, error, fallback) {
  const status = error?.status || 500;
  if (status >= 500) console.error(fallback, error);
  return res.status(status).json({ message: status >= 500 ? fallback : error.message });
}

router.get("/summary", canRead, async (req, res) => {
  try {
    res.json(await buildCommandCenter());
  } catch (error) {
    fail(res, error, "The Command Center is temporarily unavailable.");
  }
});

router.get("/actions", canRead, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status && GrowthAction.STATUSES.includes(String(req.query.status))) {
      filter.status = String(req.query.status);
    }
    if (req.query.type) filter.type = String(req.query.type).slice(0, 80);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await GrowthAction.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ actions: rows.map(({ payload, ...rest }) => rest) });
  } catch (error) {
    fail(res, error, "Could not load actions.");
  }
});

router.post("/actions/:id/approve", ownerOnly, async (req, res) => {
  try {
    res.json({ action: await engine.approve(req.params.id, ownerActor(req), req.body?.note || "") });
  } catch (error) {
    fail(res, error, "Could not approve that action.");
  }
});

router.post("/actions/:id/reject", ownerOnly, async (req, res) => {
  try {
    res.json({ action: await engine.reject(req.params.id, ownerActor(req), req.body?.note || "") });
  } catch (error) {
    fail(res, error, "Could not reject that action.");
  }
});

router.post("/actions/:id/rollback", ownerOnly, async (req, res) => {
  try {
    res.json({ action: await engine.rollback(req.params.id, ownerActor(req)) });
  } catch (error) {
    fail(res, error, "Could not roll back that action.");
  }
});

router.put("/policies/:type", ownerOnly, async (req, res) => {
  try {
    const mode = String(req.body?.mode || "");
    res.json({ policy: await engine.setPolicyMode(req.params.type, mode, ownerActor(req), req.body?.note || "") });
  } catch (error) {
    if (/Unknown growth mode/.test(error?.message || "")) error.status = 400;
    fail(res, error, "Could not change that policy.");
  }
});

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

const AgentRun = require("../models/AgentRun");
const AgentFinding = require("../models/AgentFinding");
const { AGENTS } = require("../utils/agents/definitions");
const { agentsEnabled, dailyBudgetCents, monthlyBudgetCents, runAgent, spentThisMonthCents, spentTodayCents } = require("../utils/agents/runtime");
const { nextRunFor } = require("../utils/agents/schedule");
const { secretsStatus } = require("../utils/secrets");

router.get("/agents", canRead, async (req, res) => {
  try {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [runs, monthCost, openCounts, monthTotal, todayTotal, lastOk] = await Promise.all([
      AgentRun.find({}).sort({ startedAt: -1 }).limit(60).lean(),
      AgentRun.aggregate([{ $match: { startedAt: { $gte: monthStart } } }, { $group: { _id: "$agent", cents: { $sum: "$costCents" }, runs: { $sum: 1 } } }]),
      AgentFinding.aggregate([{ $match: { status: "open" } }, { $group: { _id: "$agent", n: { $sum: 1 } } }]),
      spentThisMonthCents(),
      spentTodayCents(),
      AgentRun.aggregate([{ $match: { status: "succeeded" } }, { $group: { _id: "$agent", at: { $max: "$finishedAt" } } }]),
    ]);
    const lastSuccess = Object.fromEntries(lastOk.map((r) => [r._id, r.at]));
    const secrets = secretsStatus();
    const cost = Object.fromEntries(monthCost.map((r) => [r._id, r]));
    const open = Object.fromEntries(openCounts.map((r) => [r._id, r.n]));
    res.json({
      enabled: agentsEnabled(),
      keyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      dailyBudgetCents: dailyBudgetCents(),
      monthlyBudgetCents: monthlyBudgetCents(),
      spentTodayCents: Math.round(todayTotal * 100) / 100,
      spentThisMonthCents: Math.round(monthTotal * 100) / 100,
      costNote: "Metered from the token usage the Claude API reports on each call, at published prices.",
      secrets: { loaded: secrets.loaded, lastLoadAt: secrets.lastLoadAt, error: secrets.lastError },
      agents: Object.values(AGENTS).map((a) => ({
        name: a.name,
        label: a.label,
        schedule: (a.schedules || []).map((x) => x.label).join("; "),
        nextRunAt: nextRunFor(a)?.at || null,
        lastSuccessAt: lastSuccess[a.name] || null,
        budgetCents: a.budgetCents,
        allowedActions: a.allowedActions,
        monthCostCents: Math.round((cost[a.name]?.cents || 0) * 100) / 100,
        monthRuns: cost[a.name]?.runs || 0,
        openFindings: open[a.name] || 0,
        runs: runs
          .filter((r) => r.agent === a.name)
          .slice(0, 8)
          .map((r) => ({
            id: String(r._id),
            startedAt: r.startedAt,
            status: r.status,
            skipReason: r.skipReason,
            costCents: r.costCents,
            turns: r.turns,
            tools: r.toolCalls?.length || 0,
            findings: r.findings?.length || 0,
            actions: r.actions?.length || 0,
            summary: r.summary,
            error: r.error,
          })),
      })),
    });
  } catch (error) {
    fail(res, error, "Could not load agents.");
  }
});

router.get("/findings", canRead, async (req, res) => {
  try {
    const filter = {};
    if (["open", "acknowledged", "resolved", "dismissed", "superseded"].includes(String(req.query.status))) filter.status = String(req.query.status);
    if (req.query.kind) filter.kind = String(req.query.kind).slice(0, 40);
    const rows = await AgentFinding.find(filter).sort({ updatedAt: -1 }).limit(Math.min(Number(req.query.limit) || 50, 200)).lean();
    res.json({ findings: rows.map(({ __v, ...f }) => ({ ...f, id: String(f._id) })) });
  } catch (error) {
    fail(res, error, "Could not load findings.");
  }
});

router.post("/findings/:id/status", ownerOnly, async (req, res) => {
  try {
    const status = String(req.body?.status || "");
    if (!["acknowledged", "dismissed", "resolved", "open"].includes(status)) return res.status(400).json({ message: "Bad status" });
    const actor = ownerActor(req);
    const f = await AgentFinding.findByIdAndUpdate(
      req.params.id,
      { $set: { status, statusNote: String(req.body?.note || "").slice(0, 500), statusBy: actor.name } },
      { new: true }
    ).lean();
    if (!f) return res.status(404).json({ message: "Not found" });
    res.json({ finding: { ...f, id: String(f._id) } });
  } catch (error) {
    fail(res, error, "Could not update that finding.");
  }
});

/** Run an agent now. Returns at once; the run appears in GET /agents when done. */
router.post("/agents/:name/run", ownerOnly, async (req, res) => {
  const def = AGENTS[req.params.name];
  if (!def) return res.status(404).json({ message: "Unknown agent" });
  if (!agentsEnabled()) return res.status(409).json({ message: "Agents are switched off (AGENTS_ENABLED / ANTHROPIC_API_KEY)." });
  const mode = req.body?.mode === "weekly" ? "weekly" : "daily";
  runAgent(def, { trigger: "manual", mode }).catch((error) => console.error("Manual agent run failed:", error.message));
  res.status(202).json({ started: true });
});

module.exports = router;
