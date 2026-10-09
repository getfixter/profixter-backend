const mongoose = require("mongoose");
const AdSpendDaily = require("../../models/AdSpendDaily");
const AgentFinding = require("../../models/AgentFinding");
const AgentMemory = require("../../models/AgentMemory");
const AgentRun = require("../../models/AgentRun");
const { buildOverview } = require("../analytics/overview");
const { buildCommandCenter } = require("../growth/commandCenter");
const { buildVisibilitySummary } = require("../visibility/summary");
const { latestAudit } = require("../analytics/metaCampaignAudit");
const { propose } = require("../growth/actionEngine");
const { getDefinition } = require("../growth/actionRegistry");

/**
 * The tools a growth agent may call, and nothing else.
 *
 * READ tools return aggregates only. No customer name, email, phone number or
 * street address is ever handed to the model: the Overview is reduced to its
 * numbers, campaign and town names are business data, and the Command Center
 * already omits personal fields. That keeps the agents out of privacy scope
 * entirely and makes their transcripts safe to store.
 *
 * WRITE tools are limited to the agent's own notebook and findings, and to
 * PROPOSING actions from its allow-list - which then go through the growth
 * engine's trust ladder (shadow / supervised / autonomous) exactly like any
 * other automation. No tool sends a message, spends money or changes the site
 * directly.
 *
 * Strict schemas: every property is required (nullable where optional) and
 * additionalProperties is false, so a tool call's input always validates.
 */

const MAX_MEMORY_NOTES = 40;
const MAX_NOTE_CHARS = 1200;
const MAX_FINDINGS_PER_RUN = 12;

function obj(properties) {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const nstr = (description) => ({ type: ["string", "null"], description });

function clip(value, max) {
  return String(value ?? "").slice(0, max);
}

/* ------------------------------------------------------------------ */
/* Read tools                                                          */
/* ------------------------------------------------------------------ */

/** Overview without anything personal: KPIs, funnel, plans, sources, campaigns, towns. */
function overviewForAgents(o) {
  const stripCampaign = (c) => ({
    label: c.label,
    id: c.id,
    visitors: c.visitors,
    registrations: c.registrations,
    freeVisits: c.freeVisits,
    members: c.members,
    revenueCents: c.revenueCents,
    spendCents: c.spendCents ?? null,
    cacCents: c.cacCents ?? null,
    roas: c.roas ?? null,
    adsets: (c.adsets || []).map((s) => ({
      label: s.label,
      registrations: s.registrations,
      members: s.members,
      spendCents: s.spendCents ?? null,
      cacCents: s.cacCents ?? null,
    })),
  });
  return {
    period: o.period ? { label: o.period.label, from: o.period.fromYmd, to: o.period.toYmd, days: o.period.days } : null,
    kpis: o.kpis,
    plans: o.plans,
    funnel: o.funnel,
    sources: (o.sources || []).map(({ key, label, group, visitors, registrations, freeVisits, members, revenueCents, spendCents, cacCents, roas, newPayingCustomers }) => ({
      key, label, group, visitors, registrations, freeVisits, members, revenueCents,
      spendCents: spendCents ?? null, cacCents: cacCents ?? null, roas: roas ?? null, newPayingCustomers: newPayingCustomers ?? null,
    })),
    sourceGroups: o.sourceGroups,
    campaigns: (o.campaigns || []).map(stripCampaign),
    spend: o.spend,
    topAreas: o.topAreas,
    attention: (o.attention || []).map(({ key, count, tone }) => ({ key, count, tone })),
    notes: "First-touch attribution. Visitors counted only since 2026-10-07. No-shows are not recorded.",
  };
}

async function adPerformance({ days = 28, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await AdSpendDaily.aggregate([
    { $match: { platform: "meta", level: "ad", date: { $gte: since } } },
    {
      $group: {
        _id: { campaignId: "$campaignId", adsetId: "$adsetId" },
        campaignName: { $last: "$campaignName" },
        adsetName: { $last: "$adsetName" },
        spendCents: { $sum: "$spendCents" },
        impressions: { $sum: "$impressions" },
        clicks: { $sum: "$clicks" },
        metaLeads: { $sum: { $ifNull: ["$actions.lead", 0] } },
        metaRegistrations: { $sum: { $ifNull: ["$actions.complete_registration", 0] } },
        firstDate: { $min: "$date" },
        lastDate: { $max: "$date" },
      },
    },
    { $sort: { spendCents: -1 } },
    { $limit: 60 },
  ]);
  const audit = await latestAudit();
  return {
    windowDays: days,
    spendRows: rows.map((r) => ({
      campaignId: r._id.campaignId,
      campaign: r.campaignName,
      adsetId: r._id.adsetId,
      adset: r.adsetName,
      spendCents: r.spendCents,
      impressions: r.impressions,
      clicks: r.clicks,
      metaReportedLeads: r.metaLeads,
      metaReportedRegistrations: r.metaRegistrations,
      from: r.firstDate,
      to: r.lastDate,
    })),
    campaignSettings: audit
      ? { ok: audit.ok, reason: audit.reason || null, at: audit.at, accounts: audit.accounts || [], risks: audit.risks || [] }
      : { ok: false, reason: "no_audit_yet" },
    note:
      rows.length === 0
        ? "No spend rows: Meta ad spend is not connected yet (META_ADS_SYNC_ENABLED / ads_read token), so spend-based conclusions are impossible."
        : "Meta-reported leads use Meta's attribution windows; our members/CAC in the Overview use first touch. Expect them to differ.",
  };
}

/* ------------------------------------------------------------------ */
/* Definitions                                                         */
/* ------------------------------------------------------------------ */

const TOOL_DEFS = {
  get_business_overview: {
    description:
      "The business numbers for a date range: members, MRR, revenue (ex tax), new customers, free visits and their conversion to members, the visitor->member funnel, acquisition by first-touch source and Meta campaign (with spend, CAC and ROAS when ad spend is connected), and top towns. Aggregates only.",
    input_schema: obj({ range: str("Date range", { enum: ["7d", "30d", "month", "lastmonth"] }) }),
    run: async ({ range }) => overviewForAgents(await buildOverview({ range })),
  },
  get_growth_status: {
    description:
      "Growth Command Center state: calendar capacity for the next 21 days (utilization and signal), automations and their trust level, the approval queue (counts and summaries), automation outcomes, the out-of-area waitlist by ZIP, deterministic alerts, and the visibility summary.",
    input_schema: obj({}),
    run: async () => {
      const cc = await buildCommandCenter();
      return {
        engineEnabled: cc.engineEnabled,
        capacity: cc.capacity,
        policies: cc.policies,
        queue: { pending: cc.queue.pending.map((a) => ({ type: a.type, summary: a.summary, createdAt: a.createdAt })), last7Days: cc.queue.last7Days },
        outcomes: cc.outcomes,
        waitlist: cc.waitlist,
        alerts: cc.alerts,
      };
    },
  },
  get_visibility_details: {
    description:
      "Local visibility details: Google review count/rating trend, Search Console clicks and queries by family with rising local queries, Google Maps local-pack rank per keyword and town with top competitors, and how often AI assistants name or cite Profixter. Each part says if it is not connected yet.",
    input_schema: obj({}),
    run: async () => buildVisibilitySummary(),
  },
  get_ad_performance: {
    description:
      "Meta ad spend per campaign and ad set (spend, impressions, clicks, Meta-reported leads) for the last N days, plus the live campaign settings (optimization goal and conversion event per active ad set, custom conversions) from the read-only campaign audit.",
    // Clamped in code: strict schemas do not take numeric bounds.
    input_schema: obj({ days: { type: "integer", description: "Window in days, 7 to 90" } }),
    run: async ({ days }) => adPerformance({ days: Math.max(7, Math.min(90, Number(days) || 28)) }),
  },
  list_findings: {
    description:
      "Findings already recorded (by you or the other agents), newest first, so you do not repeat them and can close the ones the data shows are resolved.",
    input_schema: obj({
      scope: str("Whose findings", { enum: ["mine", "all"] }),
      status: str("Which status", { enum: ["open", "any"] }),
    }),
    run: async ({ scope, status }, ctx) => {
      const filter = {};
      if (scope === "mine") filter.agent = ctx.agent;
      if (status === "open") filter.status = "open";
      const rows = await AgentFinding.find(filter).sort({ updatedAt: -1 }).limit(40).lean();
      return rows.map((f) => ({
        id: String(f._id),
        agent: f.agent,
        kind: f.kind,
        severity: f.severity,
        title: f.title,
        detail: clip(f.detail, 600),
        status: f.status,
        statusNote: f.statusNote,
        seenCount: f.seenCount,
        createdAt: f.createdAt,
        lastSeenAt: f.lastSeenAt,
      }));
    },
  },
  get_recent_runs: {
    description: "Summaries of the last runs of an agent (yours by default), to continue where the previous run left off.",
    input_schema: obj({ agent: nstr("Agent name, or null for yourself") }),
    run: async ({ agent }, ctx) => {
      const rows = await AgentRun.find({ agent: agent || ctx.agent, status: { $ne: "running" } })
        .sort({ startedAt: -1 })
        .limit(6)
        .lean();
      return rows.map((r) => ({ at: r.startedAt, status: r.status, summary: clip(r.summary, 1500), costCents: r.costCents }));
    },
  },
  read_memory: {
    description: "Your notebook: the notes you saved in earlier runs (conclusions, baselines, things to re-check).",
    input_schema: obj({}),
    run: async (_input, ctx) => {
      const rows = await AgentMemory.find({ agent: ctx.agent }).sort({ updatedAt: -1 }).lean();
      return rows.map((m) => ({ key: m.key, content: m.content, updatedAt: m.updatedAt }));
    },
  },
  write_memory: {
    description:
      `Save or overwrite one note in your notebook (max ${MAX_NOTE_CHARS} chars, ${MAX_MEMORY_NOTES} notes). Use for conclusions and things to re-check later, not raw data. content=null deletes the note.`,
    input_schema: obj({ key: str("Short stable key, e.g. 'baseline:free-visit-conversion'"), content: nstr("The note, or null to delete") }),
    run: async ({ key, content }, ctx) => {
      const k = clip(key, 80).trim();
      if (!k) throw new Error("key is required");
      if (content === null) {
        await AgentMemory.deleteOne({ agent: ctx.agent, key: k });
        return { deleted: k };
      }
      const exists = await AgentMemory.exists({ agent: ctx.agent, key: k });
      if (!exists && (await AgentMemory.countDocuments({ agent: ctx.agent })) >= MAX_MEMORY_NOTES) {
        throw new Error(`Notebook is full (${MAX_MEMORY_NOTES}). Overwrite or delete an old note first.`);
      }
      await AgentMemory.updateOne(
        { agent: ctx.agent, key: k },
        { $set: { content: clip(content, MAX_NOTE_CHARS) } },
        { upsert: true }
      );
      return { saved: k };
    },
  },
  record_finding: {
    description:
      "Record a conclusion for the owner and the other agents: an opportunity, risk, anomaly, insight, proposed experiment, or creative brief. Recording the same dedupe_key again refreshes it instead of duplicating it. Be specific and quantitative, and say what the evidence is.",
    input_schema: obj({
      kind: str("Kind", { enum: ["opportunity", "risk", "anomaly", "insight", "experiment", "creative_brief"] }),
      severity: str("How much it matters for paying customers", { enum: ["info", "low", "medium", "high"] }),
      title: str("One line, under 100 characters"),
      detail: str("What you found, why it matters, and what should happen next"),
      expected_impact: str("Expected effect on paying customers or CAC, with your uncertainty; never invented precision"),
      evidence: str("The numbers this rests on, as compact text"),
      dedupe_key: str("Stable key for this topic, e.g. 'cac:instagram-vs-facebook'"),
    }),
    run: async (input, ctx) => {
      if (ctx.findingsThisRun >= MAX_FINDINGS_PER_RUN) throw new Error(`At most ${MAX_FINDINGS_PER_RUN} findings per run.`);
      const now = new Date();
      const doc = await AgentFinding.findOneAndUpdate(
        { agent: ctx.agent, dedupeKey: clip(input.dedupe_key, 120) },
        {
          $set: {
            kind: input.kind,
            severity: input.severity,
            title: clip(input.title, 160),
            detail: clip(input.detail, 4000),
            expectedImpact: clip(input.expected_impact, 600),
            evidence: clip(input.evidence, 3000),
            run: ctx.runId,
            lastSeenAt: now,
          },
          $inc: { seenCount: 1 },
          $setOnInsert: { status: "open" },
        },
        { upsert: true, new: true }
      );
      ctx.findingsThisRun += 1;
      ctx.findingIds.push(doc._id);
      return { id: String(doc._id), status: doc.status, seenCount: doc.seenCount };
    },
  },
  close_finding: {
    description: "Close one of YOUR findings when the data shows it is resolved or no longer true.",
    input_schema: obj({
      id: str("Finding id"),
      status: str("New status", { enum: ["resolved", "superseded"] }),
      note: str("Why, with the evidence"),
    }),
    run: async ({ id, status, note }, ctx) => {
      if (!mongoose.Types.ObjectId.isValid(id)) throw new Error("bad id");
      const res = await AgentFinding.updateOne(
        { _id: id, agent: ctx.agent },
        { $set: { status, statusNote: clip(note, 600), statusBy: ctx.agent } }
      );
      if (!res.matchedCount) throw new Error("No finding of yours with that id.");
      return { id, status };
    },
  },
  propose_action: {
    description:
      "Propose an action from your allowed list. It is NOT executed by you: the growth engine applies the owner's trust policy for that action type (watch-only, needs approval, or runs on its own within limits) and records the outcome. payload_json must match the action type's documented payload.",
    input_schema: obj({
      type: str("Action type from your allowed list"),
      payload_json: str("The payload as a JSON object string"),
      rationale: str("Why, with the evidence; this is what the owner reads when approving"),
      idempotency_key: str("Stable key so proposing the same thing twice is harmless, e.g. 'weekly-report:2026-W42'"),
    }),
    run: async (input, ctx) => {
      if (!ctx.allowedActions.includes(input.type)) {
        throw new Error(`Not allowed for ${ctx.agent}. Allowed: ${ctx.allowedActions.join(", ") || "none"}`);
      }
      if (!getDefinition(input.type)) throw new Error(`Unknown action type ${input.type}`);
      let payload;
      try {
        payload = JSON.parse(input.payload_json);
      } catch {
        throw new Error("payload_json is not valid JSON");
      }
      const { action, created, mode } = await propose(input.type, payload, {
        idempotencyKey: `agent:${ctx.agent}:${clip(input.idempotency_key, 160)}`,
        rationale: clip(input.rationale, 2000),
        proposedBy: { kind: "agent", name: ctx.agentLabel },
      });
      if (action?._id) ctx.actionIds.push(action._id);
      return { created, mode, status: action?.status || "off", id: action?._id ? String(action._id) : null };
    },
  },
};

/* ------------------------------------------------------------------ */
/* Owner-facing outputs (internal: they reach the owner, never a customer) */
/* ------------------------------------------------------------------ */

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - yearStart) / 86400000 + 1) / 7)).padStart(2, "0")}`;
}

/** Owner email, unless AGENT_OWNER_EMAILS_ENABLED is "false". Lazy-required so tests can stub it. */
async function emailOwner({ subject, sections, headline }) {
  if (process.env.AGENT_OWNER_EMAILS_ENABLED === "false") return { emailed: false, reason: "owner_emails_disabled" };
  const { sendRaw } = require("../emailService");
  const to = process.env.MAIL_ADMIN || "getfixter@gmail.com";
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;max-width:640px;margin:0 auto;padding:16px">
<h2 style="margin:0 0 12px">${escapeHtml(headline)}</h2>
${sections
  .map(
    (s) => `<h3 style="margin:18px 0 6px;font-size:15px">${escapeHtml(s.heading)}</h3><ul style="margin:0;padding-left:18px">${s.lines
      .map((l) => `<li style="margin:3px 0">${escapeHtml(l)}</li>`)
      .join("")}</ul>`
  )
  .join("")}
<p style="margin-top:20px;font-size:12px;color:#64748b">Written by the Profixter Growth Intelligence agent from your own data. Details and approvals: Admin &rarr; Growth.</p>
</body></html>`;
  const text = `${headline}\n\n${sections.map((s) => `${s.heading}\n${s.lines.map((l) => `- ${l}`).join("\n")}`).join("\n\n")}`;
  await sendRaw({ to, subject, html, text, logContext: { templateKey: "agent:owner_report", emailType: "operational", source: "growth_agents" } });
  return { emailed: true };
}

const sectionSchema = {
  type: "array",
  description: "Sections, each a heading and short lines",
  items: obj({ heading: str("Section heading"), lines: { type: "array", items: { type: "string" }, description: "Short lines, one fact or decision each" } }),
};

Object.assign(TOOL_DEFS, {
  publish_owner_report: {
    description:
      "Publish this week's owner report: saved in the Command Center and emailed to the owner once per ISO week. Keep it readable in 30 seconds: paying customers vs last week, CAC where known, capacity, what the system did, what needs the owner, and the 1-3 most valuable next moves. Calling it again in the same week updates the saved report without a second email.",
    input_schema: obj({
      headline: str("One-sentence verdict, e.g. '3 new members, CAC unknown (spend not connected), calendar 30% booked'"),
      sections: sectionSchema,
    }),
    run: async ({ headline, sections }, ctx) => {
      const week = isoWeek(new Date());
      const key = `report:${week}`;
      const existing = await AgentFinding.findOne({ agent: ctx.agent, dedupeKey: key }).lean();
      const clean = (sections || []).slice(0, 8).map((s) => ({ heading: clip(s.heading, 80), lines: (s.lines || []).slice(0, 8).map((l) => clip(l, 300)) }));
      const doc = await AgentFinding.findOneAndUpdate(
        { agent: ctx.agent, dedupeKey: key },
        {
          $set: { kind: "report", severity: "info", title: clip(headline, 160), body: JSON.stringify(clean), run: ctx.runId, lastSeenAt: new Date() },
          $setOnInsert: { status: "open" },
        },
        { upsert: true, new: true }
      );
      ctx.findingIds.push(doc._id);
      if (existing?.evidence?.emailedAt) return { saved: true, emailed: false, reason: "already_emailed_this_week" };
      const sent = await emailOwner({ subject: `Profixter growth, week ${week}: ${clip(headline, 90)}`, headline, sections: clean });
      if (sent.emailed) await AgentFinding.updateOne({ _id: doc._id }, { $set: { evidence: { emailedAt: new Date() } } });
      return { saved: true, ...sent };
    },
  },
  alert_owner: {
    description:
      "Email the owner immediately about something that cannot wait for the weekly report (e.g. bookings stopped, payments failing, spend running with zero customers). At most 2 per day across all agents; use rarely.",
    input_schema: obj({ subject: str("Short subject"), lines: { type: "array", items: { type: "string" }, description: "What happened, the evidence, and what to do" } }),
    run: async ({ subject, lines }, ctx) => {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recent = await AgentFinding.countDocuments({ kind: "anomaly", "evidence.alertedAt": { $gte: since } });
      if (recent >= 2) throw new Error("Alert limit reached (2 per day). Record a finding instead.");
      const doc = await AgentFinding.create({
        agent: ctx.agent,
        run: ctx.runId,
        kind: "anomaly",
        severity: "high",
        title: clip(subject, 160),
        detail: (lines || []).map((l) => clip(l, 300)).join("\n"),
        evidence: { alertedAt: new Date() },
      });
      ctx.findingIds.push(doc._id);
      return emailOwner({ subject: `Profixter alert: ${clip(subject, 100)}`, headline: clip(subject, 160), sections: [{ heading: "Details", lines: (lines || []).slice(0, 10) }] });
    },
  },
  save_content_draft: {
    description:
      "Save a publish-ready draft of a page (town page, service page, guide, FAQ entry or Google Business Profile post) for the owner or developer to review and publish. Nothing is published by this tool. Only write what is true about Profixter; follow the business rules exactly; no invented reviews, statistics or claims.",
    input_schema: obj({
      page_type: str("Kind of page", { enum: ["town_page", "service_page", "guide", "faq", "gbp_post"] }),
      target: str("Target URL path or query, e.g. '/locations/levittown' or 'handyman membership cost'"),
      title: str("Page title (under 70 characters)"),
      why: str("The evidence: the queries, ranks, waitlist ZIPs or gaps this addresses"),
      body_markdown: str("The full draft in markdown"),
      dedupe_key: str("Stable key, e.g. 'draft:/locations/levittown'"),
    }),
    run: async (input, ctx) => {
      if (ctx.findingsThisRun >= MAX_FINDINGS_PER_RUN) throw new Error(`At most ${MAX_FINDINGS_PER_RUN} findings per run.`);
      const doc = await AgentFinding.findOneAndUpdate(
        { agent: ctx.agent, dedupeKey: clip(input.dedupe_key, 120) },
        {
          $set: {
            kind: "content_draft",
            severity: "medium",
            title: clip(`${input.page_type}: ${input.title}`, 160),
            detail: clip(input.why, 3000),
            target: clip(input.target, 200),
            body: clip(input.body_markdown, 20000),
            run: ctx.runId,
            lastSeenAt: new Date(),
          },
          $inc: { seenCount: 1 },
          $setOnInsert: { status: "open" },
        },
        { upsert: true, new: true }
      );
      ctx.findingsThisRun += 1;
      ctx.findingIds.push(doc._id);
      return { id: String(doc._id), status: doc.status };
    },
  },
});

/** The Anthropic tool list for a set of tool names, in a stable order (cache-friendly). */
function toolsFor(names) {
  return names.map((name) => {
    const def = TOOL_DEFS[name];
    if (!def) throw new Error(`Unknown agent tool ${name}`);
    return { name, description: def.description, input_schema: def.input_schema, strict: true };
  });
}

async function runTool(name, input, ctx) {
  const def = TOOL_DEFS[name];
  if (!def || !ctx.toolNames.includes(name)) throw new Error(`Tool ${name} is not available to this agent`);
  return def.run(input || {}, ctx);
}

module.exports = { TOOL_DEFS, adPerformance, overviewForAgents, runTool, toolsFor };
