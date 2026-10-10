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

/** The owner-facing fields every agent output carries (everyday English). */
const PLAIN_HELP =
  "For the owner, who is not technical: 2-4 short sentences in everyday English, as you would say it to your boss ('I found...', 'Can I...?'). Say what you found or want to do, what happens, and why it matters for Profixter. No jargon, abbreviations, metric or tool names, numbers only where they help.";
const plainField = () => str(PLAIN_HELP);
const ownerQuestionField = () => nstr("The one question the owner must answer, in everyday words (e.g. 'Can I change the title of the bathroom repair page?'), or null if nothing is needed");

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
  get_conversion_details: {
    description:
      "Profixter's own funnel in aggregates: registrations and how many booked a free visit or joined; free visit -> member conversion with time-to-join and the not-yet-converted by age; retention (active, scheduled to cancel, past due, cancellations and their most common reasons, tenure); the consent-reachable audience; what the automations proposed or did; lifecycle emails sent; the out-of-area waitlist.",
    input_schema: obj({}),
    run: async () => require("./conversionData").conversionDetails(),
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
  get_action_history: {
    description:
      "What the growth system actually did or was told not to do in the last 60 days: every automation and agent proposal with its outcome (ran, skipped and why, failed, approved, declined by the owner, expired, watch-only). Use it to judge results and never re-propose what was declined.",
    input_schema: obj({}),
    run: async () => {
      const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      const GrowthAction = require("../../models/GrowthAction");
      const rows = await GrowthAction.find({ createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(80).lean();
      return rows.map((a) => ({
        type: a.type,
        status: a.status,
        summary: a.summary,
        proposedBy: a.proposedBy?.name || a.proposedBy?.kind,
        createdAt: a.createdAt,
        decision: a.decidedAt ? { by: a.decidedBy?.kind, note: clip(a.decisionNote, 200) } : null,
        outcome: a.result?.reason || (a.status === "succeeded" ? "done" : null),
        verification: a.verification?.status || null,
        error: a.lastError ? clip(a.lastError, 200) : null,
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
      plain: plainField(),
      owner_question: ownerQuestionField(),
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
            plain: clip(input.plain, 900),
            ownerQuestion: clip(input.owner_question || "", 300),
            plainBy: input.plain ? "agent" : "",
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
      plain: plainField(),
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
      if (action?._id) {
        ctx.actionIds.push(action._id);
        if (input.plain) await require("../../models/GrowthAction").updateOne({ _id: action._id }, { $set: { plain: clip(input.plain, 900) } });
      }
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
      "Save a publish-ready draft (town page, service page, guide, FAQ entry, Google Business Profile post, website conversion copy, or follow-up message wording) for review. Nothing is published or sent by this tool. Only write what is true about Profixter; follow the business rules exactly; no invented reviews, statistics or claims.",
    input_schema: obj({
      page_type: str("Kind of draft", { enum: ["town_page", "service_page", "guide", "faq", "gbp_post", "website_copy", "message_copy"] }),
      target: str("Target URL path or query, e.g. '/locations/levittown' or 'handyman membership cost'"),
      title: str("Page title (under 70 characters)"),
      why: str("The evidence: the queries, ranks, waitlist ZIPs or gaps this addresses"),
      body_markdown: str("The full draft in markdown"),
      dedupe_key: str("Stable key, e.g. 'draft:/locations/levittown'"),
      plain: plainField(),
    }),
    run: async (input, ctx) => {
      if (ctx.findingsThisRun >= MAX_FINDINGS_PER_RUN) throw new Error(`At most ${MAX_FINDINGS_PER_RUN} findings per run.`);
      const draftProblems = require("./copyRules").checkCopy(`${input.title}
${input.body_markdown}`);
      if (draftProblems.length) throw new Error(`Rewrite needed: ${draftProblems.join(" ")}`);
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
            plain: clip(input.plain, 900),
            plainBy: input.plain ? "agent" : "",
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

/* ------------------------------------------------------------------ */
/* Email playbooks (drafted by agents, approved only by the owner)      */
/* ------------------------------------------------------------------ */

Object.assign(TOOL_DEFS, {
  list_email_playbooks: {
    description:
      "The email playbooks that exist (draft, approved, retired), with their segment, status, and how their sends went (proposed / sent / skipped and why / joined afterwards). Check this before drafting so you improve or replace instead of duplicating.",
    input_schema: obj({}),
    run: async () => {
      const EmailPlaybook = require("../../models/EmailPlaybook");
      const GrowthAction = require("../../models/GrowthAction");
      const rows = await EmailPlaybook.find({}).sort({ updatedAt: -1 }).limit(30).lean();
      const stats = await GrowthAction.aggregate([
        { $match: { type: "playbook_email" } },
        { $group: { _id: { key: "$payload.playbookKey", status: "$status", reason: "$result.reason" }, n: { $sum: 1 } } },
      ]);
      return rows.map((p) => ({
        key: p.key,
        name: p.name,
        segment: p.segment,
        status: p.status,
        version: p.version,
        approvedVersion: p.approvedVersion,
        statusNote: p.statusNote,
        subject: p.subject,
        purpose: p.purpose,
        measure: p.measure,
        sends: stats.filter((s) => s._id.key === p.key).map((s) => ({ status: s._id.status, reason: s._id.reason || null, count: s.n })),
      }));
    },
  },
  save_email_playbook: {
    description:
      "Draft (or revise) a follow-up EMAIL for one predefined segment. It is saved as a draft for the owner to approve; you cannot approve or send it. Once approved, the growth engine sends it one person at a time under marketing rules (unsubscribe, frequency cap, one per person). Revising an approved playbook sends it back to draft. Copy rules are enforced: no discounts, offers, prices, 'unlimited', visits-per-month, inspection/estimate wording, claimed reviews, or SMS promises. Write like a helpful local business owner: short, specific, honest, one clear next step.",
    input_schema: obj({
      key: str("Stable slug, lowercase, e.g. 'free-visit-undecided-v1'"),
      name: str("Short name the owner will see"),
      segment: str("Who receives it", { enum: ["free_visit_undecided", "registered_never_booked", "cancellation_scheduled", "former_member_recent"] }),
      purpose: str("What this email should achieve and why, with the evidence"),
      measure: str("How success will be measured, e.g. 'members joining within 14 days of the email'"),
      subject: str("Subject line, under 70 characters"),
      preheader: str("Preview text, under 100 characters"),
      headline: str("Headline inside the email"),
      paragraphs: { type: "array", items: { type: "string" }, description: "2-4 short paragraphs (the greeting 'Hi <name>,' is added automatically)" },
      cta_label: str("Button text"),
      cta_route: str("Where the button goes", { enum: ["membership", "plans", "book", "bookOneTime", "account", "services"] }),
      closing: str("One closing line"),
    }),
    run: async (input, ctx) => {
      const EmailPlaybook = require("../../models/EmailPlaybook");
      const { checkCopy } = require("./copyRules");
      const key = String(input.key || "").toLowerCase().trim();
      if (!/^[a-z0-9_-]{3,60}$/.test(key)) throw new Error("key must be 3-60 chars: a-z, 0-9, - or _");
      const fields = {
        name: clip(input.name, 80),
        segment: input.segment,
        purpose: clip(input.purpose, 800),
        measure: clip(input.measure, 300),
        subject: clip(input.subject, 90),
        preheader: clip(input.preheader, 140),
        headline: clip(input.headline, 120),
        paragraphs: (input.paragraphs || []).slice(0, 5).map((p) => clip(p, 700)),
        ctaLabel: clip(input.cta_label, 40),
        ctaRoute: input.cta_route,
        closing: clip(input.closing, 300),
      };
      const problems = checkCopy([fields.subject, fields.preheader, fields.headline, ...fields.paragraphs, fields.ctaLabel, fields.closing].join("\n"));
      if (problems.length) throw new Error(`Rewrite needed: ${problems.join(" ")}`);
      const existing = await EmailPlaybook.findOne({ key });
      if (existing && existing.status === "retired") throw new Error("That playbook was retired by the owner; use a new key and say what changed.");
      if (existing) {
        Object.assign(existing, fields, { status: "draft", version: existing.version + 1, statusNote: `revised by ${ctx.agentLabel}` });
        await existing.save();
        console.log(JSON.stringify({ event: "agent_playbook_draft", agent: ctx.agent, key, version: existing.version, ...fields }));
        return { key, status: "draft", version: existing.version, note: "Revised; waits for the owner's approval again." };
      }
      await EmailPlaybook.create({ key, ...fields, status: "draft", createdBy: ctx.agentLabel });
      console.log(JSON.stringify({ event: "agent_playbook_draft", agent: ctx.agent, key, version: 1, ...fields }));
      return { key, status: "draft", version: 1, note: "Saved as a draft for the owner to approve." };
    },
  },
});

/* ------------------------------------------------------------------ */
/* Organic acquisition: pages, queries, the primary metric             */
/* ------------------------------------------------------------------ */

function ymdDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

Object.assign(TOOL_DEFS, {
  get_acquisition: {
    description:
      "THE PRIMARY METRIC: new first free-visit bookings (last 7 and 30 days vs the previous periods), visitors and registrations, bookings by first-touch source, the booking funnel (booking page views -> booker started -> slot picked -> signup viewed -> first free visit), and cost per first free visit when ad spend is connected.",
    input_schema: obj({}),
    run: async () => require("../growth/commandCenter").acquisitionView(),
  },
  get_pages_search_performance: {
    description:
      "Every page we optimize, with Search Console clicks, impressions, CTR and average position for the last 28 days vs the 28 before, its top queries, and whether its search wording was changed (and when). Use it to pick pages where a better title/description could win clicks - and to leave pages that already perform alone.",
    input_schema: obj({}),
    run: async () => {
      const { getDefaultStore } = require("../visibility/store");
      const { ALLOWED_PATH, SITE } = require("../seo/pageData");
      const SeoOverride = require("../../models/SeoOverride");
      const store = getDefaultStore();
      const agg = async (key, from, to) => store.findSnapshots({ source: "search_console", key, from, to });
      const [cur, prev, pq, overrides] = await Promise.all([
        agg("pages", ymdDaysAgo(28), ymdDaysAgo(0)),
        agg("pages", ymdDaysAgo(56), ymdDaysAgo(29)),
        agg("page_queries", ymdDaysAgo(28), ymdDaysAgo(0)),
        SeoOverride.find({}).select("path history updatedAt active").lean(),
      ]);
      if (!cur.length) return { available: false, reason: "No Search Console page data yet (connection pending or just connected)." };
      const sum = (docs) => {
        const m = new Map();
        for (const d of docs) for (const r of d.metrics?.rows || []) {
          const path = String(r.page || "").replace(SITE, "").replace(/\/$/, "") || "/";
          if (!ALLOWED_PATH.test(path)) continue;
          const x = m.get(path) || { clicks: 0, impressions: 0, pw: 0 };
          x.clicks += Number(r.clicks || 0);
          x.impressions += Number(r.impressions || 0);
          x.pw += Number(r.position || 0) * Number(r.impressions || 0);
          m.set(path, x);
        }
        return m;
      };
      const c = sum(cur);
      const p = sum(prev);
      const queries = new Map();
      for (const d of pq) for (const r of d.metrics?.rows || []) {
        const path = String(r.page || "").replace(SITE, "").replace(/\/$/, "") || "/";
        const k = `${path}\u0000${r.query}`;
        const x = queries.get(k) || { path, query: r.query, clicks: 0, impressions: 0, pw: 0 };
        x.clicks += Number(r.clicks || 0);
        x.impressions += Number(r.impressions || 0);
        x.pw += Number(r.position || 0) * Number(r.impressions || 0);
        queries.set(k, x);
      }
      const byPath = new Map(overrides.map((o) => [o.path, o]));
      const fmt = (x) => (x ? { clicks: x.clicks, impressions: x.impressions, ctr: x.impressions ? Math.round((x.clicks / x.impressions) * 1000) / 10 : null, position: x.impressions ? Math.round((x.pw / x.impressions) * 10) / 10 : null } : null);
      return {
        windowDays: 28,
        pages: [...c.keys()]
          .map((path) => ({
            path,
            last28: fmt(c.get(path)),
            prev28: fmt(p.get(path)),
            topQueries: [...queries.values()]
              .filter((q) => q.path === path)
              .sort((a, b) => b.impressions - a.impressions)
              .slice(0, 8)
              .map((q) => ({ query: q.query, impressions: q.impressions, clicks: q.clicks, position: q.impressions ? Math.round((q.pw / q.impressions) * 10) / 10 : null })),
            lastChanged: byPath.get(path)?.history?.slice(-1)[0]?.at || null,
          }))
          .sort((a, b) => (b.last28?.impressions || 0) - (a.last28?.impressions || 0))
          .slice(0, 40),
      };
    },
  },
  get_page_seo: {
    description: "What one page serves live right now (title, meta description, H1, indexable) and its search-wording change history (each version, why, and by which action).",
    input_schema: obj({ path: str("Page path, e.g. /services/tv-mounting") }),
    run: async ({ path }) => {
      const { livePage } = require("../seo/pageData");
      const SeoOverride = require("../../models/SeoOverride");
      const [live, o] = await Promise.all([livePage(path), SeoOverride.findOne({ path }).lean()]);
      return {
        live,
        override: o ? { active: o.active, fields: o.fields, history: (o.history || []).slice(-6).map((h) => ({ at: h.at, fields: h.fields, by: h.by, reason: h.reason })) } : null,
      };
    },
  },
});

/* ------------------------------------------------------------------ */
/* Conversations (inbound SMS/email replies)                           */
/* ------------------------------------------------------------------ */

Object.assign(TOOL_DEFS, {
  get_conversations: {
    description:
      "Inbound homeowner conversations (replies by text or email) handled by the reply responder: counts by status and intent for the last N days, how many replies were proposed, approved, sent, escalated or blocked, and the most recent escalations and proposed replies (first name, town, intent, summary, the proposed text). Use it to judge whether replies are accurate, on-policy and leading people to book on the website.",
    input_schema: obj({ days: { type: ["integer", "null"], description: "Look-back window in days (default 30, max 90)" } }),
    run: async (input) => {
      const ConversationThread = require("../../models/ConversationThread");
      const GrowthAction = require("../../models/GrowthAction");
      const days = Math.min(90, Math.max(1, Number(input.days) || 30));
      const since = new Date(Date.now() - days * 864e5);
      const [byStatus, byIntent, recent, actions] = await Promise.all([
        ConversationThread.aggregate([{ $match: { lastInboundAt: { $gte: since } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
        ConversationThread.aggregate([{ $match: { lastInboundAt: { $gte: since } } }, { $group: { _id: "$intent", n: { $sum: 1 } } }]),
        ConversationThread.find({ lastInboundAt: { $gte: since }, status: { $in: ["escalated", "reply_proposed"] } }).sort({ lastInboundAt: -1 }).limit(12).lean(),
        GrowthAction.aggregate([{ $match: { type: "conversation_reply", createdAt: { $gte: since } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
      ]);
      return {
        enabled: process.env.CONVERSATIONS_ENABLED === "true",
        byStatus: Object.fromEntries(byStatus.map((r) => [r._id || "unknown", r.n])),
        byIntent: Object.fromEntries(byIntent.map((r) => [r._id || "unknown", r.n])),
        replyActions: Object.fromEntries(actions.map((r) => [r._id || "unknown", r.n])),
        recent: recent.map((t) => ({
          status: t.status,
          firstName: t.firstName,
          town: t.town,
          channel: t.channel,
          intent: t.intent,
          summary: t.summary,
          escalationReason: t.escalationReason,
          lastInbound: String([...(t.messages || [])].reverse().find((m) => m.direction === "inbound")?.body || "").slice(0, 300),
        })),
      };
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
