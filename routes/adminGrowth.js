const express = require("express");
const auth = require("../middleware/auth");
const { requirePermission, PERMISSIONS } = require("../middleware/authorize");
const GrowthAction = require("../models/GrowthAction");
const AdminActivityLogModel = require("../models/AdminActivityLog");
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

/* ------------------------------------------------------------------ */
/* Email playbooks: agents draft, the owner approves the wording        */
/* ------------------------------------------------------------------ */

const EmailPlaybook = require("../models/EmailPlaybook");
const { templateOf, playbookText } = require("../utils/growth/actions/playbookEmail");
const { checkCopy } = require("../utils/agents/copyRules");
const { SEGMENT_DEFS } = require("../utils/growth/segments");

router.get("/playbooks", canRead, async (req, res) => {
  try {
    const rows = await EmailPlaybook.find({}).sort({ updatedAt: -1 }).limit(50).lean();
    const stats = await GrowthAction.aggregate([
      { $match: { type: "playbook_email" } },
      { $group: { _id: { key: "$payload.playbookKey", status: "$status" }, n: { $sum: 1 } } },
    ]);
    res.json({
      playbooks: rows.map((p) => ({
        ...p,
        id: String(p._id),
        segmentLabel: SEGMENT_DEFS[p.segment]?.label || p.segment,
        copyProblems: checkCopy(playbookText(p)),
        sends: Object.fromEntries(stats.filter((s) => s._id.key === p.key).map((s) => [s._id.status, s.n])),
      })),
    });
  } catch (error) {
    fail(res, error, "Could not load playbooks.");
  }
});

/** The email exactly as a customer would see it, with a sample name. */
router.get("/playbooks/:key/preview", canRead, async (req, res) => {
  try {
    const pb = await EmailPlaybook.findOne({ key: req.params.key }).lean();
    if (!pb) return res.status(404).json({ message: "Not found" });
    const { renderMarketingEmail } = require("../utils/marketing/marketingRenderer");
    const out = renderMarketingEmail(templateOf(pb), { name: "Sam", email: "preview@profixter.com" });
    res.json({ subject: out.subject, html: out.html, text: out.text });
  } catch (error) {
    fail(res, error, "Could not render the preview.");
  }
});

router.post("/playbooks/:key/approve", ownerOnly, async (req, res) => {
  try {
    const pb = await EmailPlaybook.findOne({ key: req.params.key });
    if (!pb) return res.status(404).json({ message: "Not found" });
    if (pb.status === "retired") return res.status(409).json({ message: "This playbook was retired." });
    const problems = checkCopy(playbookText(pb));
    if (problems.length) return res.status(400).json({ message: `Cannot approve: ${problems.join(" ")}` });
    const actor = ownerActor(req);
    pb.status = "approved";
    pb.approvedBy = actor.name;
    pb.approvedAt = new Date();
    pb.approvedVersion = pb.version;
    pb.statusNote = String(req.body?.note || "").slice(0, 300);
    await pb.save();
    await AdminActivityLogModel.create({
      action: "growth_playbook.approved",
      entityType: "email_playbook",
      entityId: pb.key,
      entityName: pb.name,
      actorUserId: actor.userId,
      actorName: actor.name,
      actorRole: "owner",
      details: { version: pb.version, segment: pb.segment },
    });
    res.json({ playbook: pb.toObject() });
  } catch (error) {
    fail(res, error, "Could not approve that playbook.");
  }
});

router.post("/playbooks/:key/retire", ownerOnly, async (req, res) => {
  try {
    const actor = ownerActor(req);
    const pb = await EmailPlaybook.findOneAndUpdate(
      { key: req.params.key },
      { $set: { status: "retired", retiredAt: new Date(), statusNote: String(req.body?.note || "").slice(0, 300) } },
      { new: true }
    ).lean();
    if (!pb) return res.status(404).json({ message: "Not found" });
    await AdminActivityLogModel.create({
      action: "growth_playbook.retired",
      entityType: "email_playbook",
      entityId: pb.key,
      entityName: pb.name,
      actorUserId: actor.userId,
      actorName: actor.name,
      actorRole: "owner",
      details: { version: pb.version },
    });
    res.json({ playbook: pb });
  } catch (error) {
    fail(res, error, "Could not retire that playbook.");
  }
});

/* ------------------------------------------------------------------ */
/* Outreach (postal mail) and conversations                            */
/* ------------------------------------------------------------------ */

const { OutreachRecipient, OutreachWave } = require("../models/Outreach");
const ConversationThread = require("../models/ConversationThread");

router.get("/outreach", canRead, async (req, res) => {
  try {
    const { audienceSummary, waveResults } = require("../utils/outreach/audience");
    const [audience, waves] = await Promise.all([audienceSummary(), OutreachWave.find({}).sort({ createdAt: -1 }).limit(20).lean()]);
    const withResults = [];
    for (const w of waves) withResults.push({ ...w, results: ["exported", "mailed"].includes(w.status) ? await waveResults(w.key) : null });
    res.json({ audience, waves: withResults, costPerPieceCents: Number(process.env.MAIL_COST_PER_PIECE_CENTS) || 95 });
  } catch (error) {
    fail(res, error, "Could not load outreach.");
  }
});

async function waveDecision(req, res, update, allowedFrom, action) {
  const actor = ownerActor(req);
  const w = await OutreachWave.findOneAndUpdate({ key: req.params.key, status: { $in: allowedFrom } }, { $set: update(actor) }, { new: true }).lean();
  if (!w) return res.status(409).json({ message: "That wave is not in a state that allows this." });
  await AdminActivityLogModel.create({ action: `growth_mail_wave.${action}`, entityType: "mail_wave", entityId: w.key, entityName: w.name, actorUserId: actor.userId, actorName: actor.name, actorRole: "owner", details: { size: w.size, estimatedCostCents: w.estimatedCostCents } });
  return res.json({ wave: w });
}

/** Approving a wave approves its SPEND (estimatedCostCents) and its copy. */
router.post("/outreach/waves/:key/approve", ownerOnly, (req, res) =>
  waveDecision(req, res, (a) => ({ status: "approved", approvedBy: a.name, approvedAt: new Date(), statusNote: String(req.body?.note || "").slice(0, 300) }), ["draft"], "approved").catch((e) => fail(res, e, "Could not approve."))
);
router.post("/outreach/waves/:key/cancel", ownerOnly, (req, res) =>
  waveDecision(req, res, () => ({ status: "cancelled", statusNote: String(req.body?.note || "").slice(0, 300) }), ["draft", "approved"], "cancelled").catch((e) => fail(res, e, "Could not cancel."))
);
router.post("/outreach/waves/:key/mailed", ownerOnly, (req, res) =>
  waveDecision(req, res, () => ({ status: "mailed", mailedAt: new Date() }), ["exported"], "mailed").catch((e) => fail(res, e, "Could not update."))
);

/**
 * The mailing file for the print vendor: name, address, and each person's
 * tracked URL (www.profixter.com/m/<wave>-<code>, also used for the QR). Owner
 * only; selects mailable homeowners not mailed in 90 days and marks them.
 */
router.post("/outreach/waves/:key/export", ownerOnly, async (req, res) => {
  try {
    const wave = await OutreachWave.findOne({ key: req.params.key, status: "approved" });
    if (!wave) return res.status(409).json({ message: "Only an approved wave can be exported." });
    const ninety = new Date(Date.now() - 90 * 864e5);
    const people = await OutreachRecipient.find({ eligible: true, zip: { $in: wave.targetZips }, $or: [{ lastMailedAt: null }, { lastMailedAt: { $lt: ninety } }] })
      .sort({ zip: 1 })
      .limit(wave.size)
      .lean();
    const esc = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
    const site = (process.env.MARKETING_SITE_BASE_URL || "https://www.profixter.com").replace(/\/+$/, "");
    const lines = ["first_name,last_name,address1,city,state,zip,personal_url"];
    for (const p of people) lines.push([p.firstName, p.lastName, p.address1, p.city, p.state, p.zip, `${site}/m/${wave.key}-${p.code}`].map(esc).join(","));
    await OutreachRecipient.updateMany({ _id: { $in: people.map((p) => p._id) } }, { $set: { lastMailedAt: new Date() }, $addToSet: { waves: wave.key } });
    wave.status = "exported";
    wave.exportedAt = new Date();
    wave.size = people.length;
    await wave.save();
    const actor = ownerActor(req);
    await AdminActivityLogModel.create({ action: "growth_mail_wave.exported", entityType: "mail_wave", entityId: wave.key, entityName: wave.name, actorUserId: actor.userId, actorName: actor.name, actorRole: "owner", details: { rows: people.length } });
    res.set("Cache-Control", "no-store");
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="profixter-${wave.key}.csv"`);
    res.send(lines.join("\n"));
  } catch (error) {
    fail(res, error, "Could not export that wave.");
  }
});

/** Conversation inbox for the owner: escalations first. */
router.get("/conversations", canRead, async (req, res) => {
  try {
    const rows = await ConversationThread.find({}).sort({ status: 1, lastInboundAt: -1 }).limit(60).lean();
    const order = { escalated: 0, reply_proposed: 1, needs_reply: 2, replied: 3, closed: 4, opted_out: 5 };
    rows.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || new Date(b.lastInboundAt) - new Date(a.lastInboundAt));
    res.json({
      threads: rows.map((t) => ({
        id: String(t._id),
        status: t.status,
        intent: t.intent,
        summary: t.summary,
        channel: t.channel,
        firstName: t.firstName,
        town: t.town,
        escalationReason: t.escalationReason,
        lastInboundAt: t.lastInboundAt,
        messages: (t.messages || []).slice(-6).map((m) => ({ direction: m.direction, by: m.by, body: String(m.body || "").slice(0, 600), at: m.at })),
      })),
      enabled: process.env.CONVERSATIONS_ENABLED === "true",
    });
  } catch (error) {
    fail(res, error, "Could not load conversations.");
  }
});

/* ------------------------------------------------------------------ */
/* The Growth Office (the Admin "game" view)                            */
/* ------------------------------------------------------------------ */

const office = require("../utils/growth/office");
const agentSettings = require("../utils/agents/settings");

router.get("/office", canRead, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await office.buildOffice({ fresh: req.query.fresh === "1" }));
  } catch (error) {
    fail(res, error, "Could not load the office.");
  }
});

router.get("/office/approvals", canRead, async (req, res) => {
  try {
    res.json(await office.approvalsList());
  } catch (error) {
    fail(res, error, "Could not load approvals.");
  }
});

router.get("/office/robots/:key", canRead, async (req, res) => {
  try {
    const detail = await office.robotDetail(String(req.params.key));
    if (!detail) return res.status(404).json({ message: "No such robot." });
    res.json(detail);
  } catch (error) {
    fail(res, error, "Could not load that robot.");
  }
});

function robotOr404(req, res) {
  const robot = office.ROBOTS.find((r) => r.key === String(req.params.key));
  if (!robot) res.status(404).json({ message: "No such robot." });
  return robot;
}

/** Pause or resume all of a robot's automatic work (scheduled shifts, and for Marcus the reply responder). */
router.post("/office/robots/:key/pause", ownerOnly, async (req, res) => {
  try {
    const robot = robotOr404(req, res);
    if (!robot) return;
    const paused = Boolean(req.body?.paused);
    const actor = ownerActor(req);
    for (const agent of robot.agents) await agentSettings.setPaused(agent, paused, actor.name);
    await AdminActivityLogModel.create({
      action: `growth_robot.${paused ? "paused" : "resumed"}`,
      entityType: "growth_robot",
      entityId: robot.key,
      entityName: robot.name,
      actorUserId: actor.userId,
      actorName: actor.name,
      actorRole: "owner",
      details: { agents: robot.agents },
    });
    office.invalidateOffice();
    res.json({ paused });
  } catch (error) {
    fail(res, error, "Could not change that.");
  }
});

/** Save owner guidance for a robot's scheduled agent (validated; versioned). */
router.put("/office/robots/:key/guidance", ownerOnly, async (req, res) => {
  try {
    const robot = robotOr404(req, res);
    if (!robot) return;
    const agent = robot.agents.find((a) => AGENTS[a]);
    const actor = ownerActor(req);
    const { settings, unchanged } = await agentSettings.saveGuidance(agent, req.body?.guidance, { by: actor.name, note: req.body?.note });
    if (!unchanged) {
      await AdminActivityLogModel.create({
        action: "growth_robot.guidance_saved",
        entityType: "growth_robot",
        entityId: robot.key,
        entityName: robot.name,
        actorUserId: actor.userId,
        actorName: actor.name,
        actorRole: "owner",
        details: { agent, version: settings.version, guidance: settings.guidance },
      });
    }
    res.json({ version: settings.version, guidance: settings.guidance, unchanged });
  } catch (error) {
    if (error.problems) return res.status(422).json({ message: "Some of that can't be taught.", problems: error.problems });
    fail(res, error, "Could not save the guidance.");
  }
});

router.post("/office/robots/:key/guidance/rollback", ownerOnly, async (req, res) => {
  try {
    const robot = robotOr404(req, res);
    if (!robot) return;
    const agent = robot.agents.find((a) => AGENTS[a]);
    const actor = ownerActor(req);
    const { settings } = await agentSettings.rollbackGuidance(agent, req.body?.version, { by: actor.name });
    await AdminActivityLogModel.create({
      action: "growth_robot.guidance_restored",
      entityType: "growth_robot",
      entityId: robot.key,
      entityName: robot.name,
      actorUserId: actor.userId,
      actorName: actor.name,
      actorRole: "owner",
      details: { agent, restored: Number(req.body?.version), version: settings.version },
    });
    res.json({ version: settings.version, guidance: settings.guidance });
  } catch (error) {
    if (error.problems) return res.status(422).json({ message: error.problems[0], problems: error.problems });
    fail(res, error, "Could not restore that version.");
  }
});

/* ------------------------------------------------------------------ */
/* The council: the owner <-> King Arthur <-> the specialists           */
/* ------------------------------------------------------------------ */

const { CouncilDecision, CouncilMessage, CouncilTask } = require("../models/Council");
const councilTasks = require("../utils/council/tasks");

function publicDecision(d) {
  return {
    id: String(d._id),
    category: d.category,
    subject: d.subject,
    simple: d.simple,
    detail: d.detail,
    agent: d.agent,
    hero: d.agent ? councilTasks.HERO[d.agent] || d.agent : null,
    recommendation: d.recommendation?.choice ? d.recommendation : null,
    refs: (d.refs || []).map((r) => ({ kind: r.kind, id: r.id })),
    guidance: d.payload?.type === "guidance" ? { agent: d.payload.agent, text: d.payload.guidance, previous: d.payload.previous, baseVersion: d.payload.baseVersion } : null,
    status: d.status,
    resolution: d.resolution?.choice ? d.resolution : null,
    at: d.updatedAt,
    createdAt: d.createdAt,
  };
}

router.get("/office/council", canRead, async (req, res) => {
  try {
    const { settleDecisions } = require("../utils/council/arthur");
    await require("../utils/council/mission").ensureMission();
    await settleDecisions();
    const since = new Date(Date.now() - 14 * 864e5);
    const [messages, openTasks, closedTasks, open, closed, thinking, mission] = await Promise.all([
      CouncilMessage.find({}).sort({ createdAt: -1 }).limit(40).lean(),
      CouncilTask.find({ status: { $in: [...councilTasks.OPEN, "completed"] } }).sort({ createdAt: -1 }).limit(30).lean(),
      CouncilTask.find({ status: { $in: ["verified", "not_verified", "cancelled"] }, updatedAt: { $gte: since } }).sort({ updatedAt: -1 }).limit(15).lean(),
      CouncilDecision.find({ status: "open" }).sort({ updatedAt: -1 }).limit(40).lean(),
      CouncilDecision.find({ status: { $ne: "open" }, updatedAt: { $gte: since } }).sort({ updatedAt: -1 }).limit(20).lean(),
      require("../models/AgentRun").exists({ agent: "arthur", status: "running", startedAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) } }),
      agentSettings.getSettings("arthur"),
    ]);
    res.json({
      enabled: agentsEnabled(),
      thinking: Boolean(thinking),
      messages: messages.reverse().map((m) => ({ id: String(m._id), role: m.role, kind: m.kind, text: m.text, actions: m.actions || [], at: m.createdAt })),
      tasks: [...openTasks, ...closedTasks].map(councilTasks.publicTask),
      decisions: open.map(publicDecision),
      history: closed.map(publicDecision),
      mission: {
        guidance: mission.guidance || "",
        version: mission.version || 0,
        history: (mission.history || []).slice().reverse().map((h) => ({ version: h.version, guidance: h.guidance, by: h.by, at: h.at, note: h.note })),
      },
      counts: {
        decisions: open.filter((d) => ["decision", "uncertain"].includes(d.category)).length,
        info: open.filter((d) => d.category === "info").length,
        tasks: openTasks.length,
      },
    });
  } catch (error) {
    fail(res, error, "Could not load the council.");
  }
});

/** King Arthur's standing mission (his guidance): owner-only, validated, versioned, restorable. */
async function logMission(req, action, details) {
  const actor = ownerActor(req);
  await AdminActivityLogModel.create({ action, entityType: "growth_council", entityId: "arthur", entityName: "King Arthur", actorUserId: actor.userId, actorName: actor.name, actorRole: "owner", details });
}

router.put("/office/council/mission", ownerOnly, async (req, res) => {
  try {
    const actor = ownerActor(req);
    const { settings, unchanged } = await agentSettings.saveGuidance("arthur", req.body?.guidance, { by: actor.name, note: req.body?.note });
    if (!unchanged) await logMission(req, "growth_council.mission_saved", { version: settings.version, guidance: settings.guidance });
    res.json({ version: settings.version, guidance: settings.guidance, unchanged });
  } catch (error) {
    if (error.problems) return res.status(422).json({ message: "Some of that can't be part of the mission.", problems: error.problems });
    fail(res, error, "Could not save the mission.");
  }
});

router.post("/office/council/mission/rollback", ownerOnly, async (req, res) => {
  try {
    const { settings } = await agentSettings.rollbackGuidance("arthur", req.body?.version, { by: ownerActor(req).name });
    await logMission(req, "growth_council.mission_restored", { restored: Number(req.body?.version), version: settings.version });
    res.json({ version: settings.version, guidance: settings.guidance });
  } catch (error) {
    if (error.problems) return res.status(422).json({ message: error.problems[0], problems: error.problems });
    fail(res, error, "Could not restore that version.");
  }
});

/** Talk to King Arthur. Returns at once; his answer appears in GET /office/council. */
router.post("/office/council/chat", ownerOnly, async (req, res) => {
  try {
    const text = String(req.body?.message || "").trim();
    if (!text) return res.status(400).json({ message: "Write a message first." });
    if (text.length > 2000) return res.status(400).json({ message: "Keep a message under 2,000 characters." });
    const AgentRun = require("../models/AgentRun");
    const arthur = require("../utils/council/arthur");
    if (await AgentRun.exists({ agent: "arthur", status: "running", startedAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) } })) {
      return res.status(409).json({ message: "King Arthur is still answering. One moment." });
    }
    const today = await CouncilMessage.countDocuments({ role: "owner", createdAt: { $gte: new Date(Date.now() - 864e5) } });
    if (today >= arthur.MAX_CHATS_PER_DAY) return res.status(429).json({ message: "That's enough council talk for today - King Arthur's daily limit is reached." });
    const actor = ownerActor(req);
    const msg = await CouncilMessage.create({ role: "owner", text, kind: "chat" });
    if (!agentsEnabled()) {
      await CouncilMessage.create({ role: "arthur", kind: "chat", text: "Boss, the AI team is switched off right now, so I can't think this through. Your message is saved." });
    } else {
      arthur.chat({ text, ownerName: actor.name }).catch((error) => {
        console.error("Arthur chat failed:", error.message);
        CouncilMessage.create({ role: "arthur", kind: "chat", text: "Boss, something went wrong on my side and I couldn't answer. Please try again in a few minutes." }).catch(() => {});
      });
    }
    res.status(202).json({ id: String(msg._id) });
  } catch (error) {
    fail(res, error, "Could not send that.");
  }
});

/** The owner's answer to something King Arthur filed. Guidance proposals are saved only here. */
router.post("/office/council/decisions/:id/resolve", ownerOnly, async (req, res) => {
  try {
    const choice = String(req.body?.choice || "");
    if (!["confirm", "reject", "done"].includes(choice)) return res.status(400).json({ message: "Bad choice" });
    if (!require("mongoose").Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: "Not found" });
    const actor = ownerActor(req);
    const { decision: d, saved } = await require("../utils/council/arthur").resolveDecision({ id: req.params.id, choice, by: actor.name, note: req.body?.note });
    const isGuidance = d.payload?.type === "guidance";
    await AdminActivityLogModel.create({
      action: `growth_council.${isGuidance ? `guidance_${choice}` : `decision_${choice}`}`,
      entityType: "growth_council",
      entityId: String(d._id),
      entityName: String(d.subject).slice(0, 120),
      actorUserId: actor.userId,
      actorName: actor.name,
      actorRole: "owner",
      details: { category: d.category, agent: d.agent, saved },
    });
    office.invalidateOffice();
    res.json({ ok: true, saved });
  } catch (error) {
    if (error.problems) return res.status(422).json({ message: error.problems[0], problems: error.problems });
    if (error.status) return res.status(error.status).json({ message: error.message });
    fail(res, error, "Could not save that.");
  }
});

router.post("/office/council/tasks/:id/cancel", ownerOnly, async (req, res) => {
  try {
    const actor = ownerActor(req);
    const t = await councilTasks.cancelTask({ taskId: String(req.params.id), by: actor.name, asOwner: true, note: String(req.body?.note || "Cancelled by the owner") });
    res.json({ task: councilTasks.publicTask(t) });
  } catch (error) {
    res.status(404).json({ message: error.message });
  }
});

router.post("/office/council/tasks/:id/verify", ownerOnly, async (req, res) => {
  try {
    const actor = ownerActor(req);
    const t = await councilTasks.verifyTask({ taskId: String(req.params.id), verdict: String(req.body?.verdict || ""), note: String(req.body?.note || ""), by: actor.name });
    res.json({ task: councilTasks.publicTask(t) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

/** "Copy All for ChatGPT" (scope=pending) and the full status report (scope=full). Deterministic; no AI call. */
router.get("/office/council/report", canRead, async (req, res) => {
  try {
    const { buildReport } = require("../utils/council/report");
    res.json(await buildReport({ scope: req.query.scope === "full" ? "full" : "pending" }));
  } catch (error) {
    fail(res, error, "Could not build the report.");
  }
});

/** Run an agent now. Returns at once; the run appears in GET /agents when done. */
router.post("/agents/:name/run", ownerOnly, async (req, res) => {
  const def = AGENTS[req.params.name];
  if (!def) return res.status(404).json({ message: "Unknown agent" });
  if (!agentsEnabled()) return res.status(409).json({ message: "Agents are switched off (AGENTS_ENABLED / ANTHROPIC_API_KEY)." });
  const allowedModes = (def.schedules || []).map((s) => s.mode);
  const mode = allowedModes.includes(req.body?.mode) ? req.body.mode : allowedModes[0] || null;
  runAgent(def, { trigger: "manual", mode }).catch((error) => console.error("Manual agent run failed:", error.message));
  res.status(202).json({ started: true });
});

module.exports = router;
