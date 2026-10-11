const mongoose = require("mongoose");
const AgentFinding = require("../../models/AgentFinding");
const AgentMemory = require("../../models/AgentMemory");
const AgentRun = require("../../models/AgentRun");
const { buildVisibilitySummary } = require("../visibility/summary");
const { propose } = require("../growth/actionEngine");
const { getDefinition } = require("../growth/actionRegistry");

/**
 * The tools a growth agent may call, and nothing else.
 *
 * MARKETING DATA ONLY (Oct 2026): the owner runs the business; the agents
 * market it. There is no tool for revenue, MRR, Stripe, billing, prices,
 * subscription statistics, cancellation analysis, ad spend or calendar
 * operations - those tools were removed, not hidden. The business data an
 * agent gets comes from marketingData.js, built field by field.
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

/**
 * POSTCARDS AND MAIL ARE THE OWNER'S PROJECT, NEVER AN AGENT'S. No agent tool
 * plans, sizes or exports mail; and no agent may record a finding, a draft or
 * a notebook note about it either - so a postcard idea can neither reach the
 * owner nor survive in a notebook to be recommended again.
 */
const POSTAL_RE = /\b(post[ -]?cards?|postal|direct[- ]mail|mailers?|mail(?:ing)?[ _-](?:list|wave|campaign|drop|piece)s?|eddm|every door)\b/i;
function refusePostal(...texts) {
  if (texts.some((t) => POSTAL_RE.test(String(t || "")))) {
    throw new Error("Postcards and mail are the owner's own project, not an agent's. Leave them out entirely - do not record, draft or note them.");
  }
}

function clip(value, max) {
  return String(value ?? "").slice(0, max);
}

/* ------------------------------------------------------------------ */
/* Read tools                                                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Definitions                                                         */
/* ------------------------------------------------------------------ */

const TOOL_DEFS = {
  get_visibility_details: {
    description:
      "Local visibility details: Google review count/rating trend, Search Console clicks and queries by family with rising local queries, Google Maps local-pack rank per keyword and town with top competitors, and how often AI assistants name or cite Profixter. Each part says if it is not connected yet.",
    input_schema: obj({}),
    run: async () => buildVisibilitySummary(),
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
      return rows.map((r) => ({ at: r.startedAt, status: r.status, summary: clip(require("./claims").correctedRun(r).summary, 1500), costCents: r.costCents }));
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
      if (content !== null) refusePostal(k, content);
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
      refusePostal(input.title, input.detail, input.expected_impact, input.plain, input.owner_question, input.dedupe_key);
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


Object.assign(TOOL_DEFS, {
  save_content_draft: {
    description:
      "Save a publish-ready draft (town page, service page, guide, FAQ entry, Google Business Profile post, website conversion copy, or follow-up message wording) for review. Nothing is published or sent by this tool. Only write what is true about Profixter; follow the business rules exactly; no invented reviews, statistics or claims.",
    input_schema: obj({
      page_type: str("Kind of draft", {
        enum: ["town_page", "service_page", "guide", "faq", "gbp_post", "website_copy", "message_copy", "instagram_post", "facebook_post", "community_post", "directory_listing"],
      }),
      target: str("Target URL path or query, e.g. '/locations/levittown' or 'handyman membership cost'"),
      title: str("Page title (under 70 characters)"),
      why: str("The evidence: the queries, ranks, waitlist ZIPs or gaps this addresses"),
      body_markdown: str("The full draft in markdown"),
      dedupe_key: str("Stable key, e.g. 'draft:/locations/levittown'"),
      plain: plainField(),
    }),
    run: async (input, ctx) => {
      if (ctx.findingsThisRun >= MAX_FINDINGS_PER_RUN) throw new Error(`At most ${MAX_FINDINGS_PER_RUN} findings per run.`);
      refusePostal(input.title, input.why, input.body_markdown, input.plain, input.target);
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
      segment: str("Who receives it", { enum: ["free_visit_undecided", "registered_never_booked", "former_member_recent"] }),
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
      "THE MARKETING RESULT: new first free-visit bookings (last 7 and 30 days vs the previous periods), website visitors and registrations, all of them by first-touch source (Google, Instagram, Facebook, direct, referral...), the booking funnel (booking page -> booker started -> slot chosen -> sign-up -> first free visit), and the towns customers live in. No financial data.",
    input_schema: obj({}),
    run: async () => require("./marketingData").marketingResults(),
  },
  get_reengagement_audiences: {
    description:
      "For follow-up planning: how many people are in each follow-up audience (had the free visit but did not join; registered but never booked; past members), and how many of them may lawfully receive marketing email, opted in to marketing texts, or opted out. Counts only - no names, contact details, plans or amounts.",
    input_schema: obj({}),
    run: async () => require("./marketingData").reengagementAudiences(),
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

Object.assign(TOOL_DEFS, {
  report_to_arthur: {
    description:
      "Report on a task King Arthur gave you in this shift (listed in your instructions with its task_id). Call once per task: 'completed' with what you found or did, with the evidence; or 'blocked' with why (a fixed rule forbids it, or you lack the data or a tool). Arthur checks the report; you cannot mark your own work verified.",
    input_schema: obj({
      task_id: str("The task_id from the TASKS FROM KING ARTHUR list"),
      status: str("Outcome", { enum: ["completed", "blocked"] }),
      summary: str("What you found or did, with numbers and where they came from - or exactly why it is blocked"),
    }),
    run: async ({ task_id, status, summary }, ctx) =>
      require("../council/tasks").reportTask({ taskId: task_id, agent: ctx.agent, runId: ctx.runId, status, summary }),
  },
});

/** The Anthropic tool list for a set of tool names, in a stable order (cache-friendly). */
const WEB_SEARCH = { type: "web_search_20260209", name: "web_search", max_uses: 4 };

function toolsFor(names) {
  return names.map((name) => {
    if (name === "web_search") return { ...WEB_SEARCH };
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

module.exports = { POSTAL_RE, TOOL_DEFS, WEB_SEARCH, runTool, toolsFor };
