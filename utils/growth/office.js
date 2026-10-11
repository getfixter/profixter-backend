/**
 * The Growth Office: the Admin "game" view of the growth agents.
 *
 * Everything here is REAL state, shaped for three characters and a wall
 * display. A robot is "working" only while an AgentRun is running, "needs you"
 * only when something it produced is waiting for the owner, "sleeping" when
 * paused or switched off, "confused" when its last run failed, and otherwise
 * "waiting" for its next scheduled shift. Nothing is invented: a missing
 * number is null and the UI says so.
 *
 * Robots map onto the agents in utils/agents/definitions.js:
 *   Odysseus        - visibility    (SEO and organic acquisition)
 *   Leonidas        - outreach      (lawful new channels; never mail or Meta)
 *   Marcus - conversion + the live reply responder ("conversation")
 * King Arthur (utils/council) manages the three; he is not a robot here.
 * King Arthur (utils/council) directs the three as the Kingdom's marketing director.
 */
const AgentRun = require("../../models/AgentRun");
const AgentFinding = require("../../models/AgentFinding");
const AgentMemory = require("../../models/AgentMemory");
const GrowthAction = require("../../models/GrowthAction");
const EmailPlaybook = require("../../models/EmailPlaybook");
const ConversationThread = require("../../models/ConversationThread");
const { AGENTS } = require("../agents/definitions");
const { nextRunFor } = require("../agents/schedule");
const { allSettings, getSettings } = require("../agents/settings");
const { agentsEnabled, dailyBudgetCents, monthlyBudgetCents, spentThisMonthCents, spentTodayCents, SHARED_RULES } = require("../agents/runtime");

const explain = require("./explain");
const { correctedRun } = require("../agents/claims");

const RUNNING_STALE_MS = 30 * 60 * 1000;

const ROBOTS = [
  {
    key: "visibility",
    name: "Odysseus",
    role: "Organic search & visibility",
    agents: ["visibility"],
    actionTypes: ["seo_page_update", "seo_content_update"],
    mission: "Make Profixter easy to find for Long Island homeowners on Google, Google Maps, AI assistants, Yelp and other directories - so more of them book a free first visit.",
    does: [
      "Watches Google: which pages and searches bring homeowners, and Maps rankings by town",
      "Proposes better page titles, descriptions and intros (you approve)",
      "Drafts service-area pages, guides, Google Business Profile posts and directory profiles",
      "Researches competitors, directories and what homeowners ask AI assistants",
    ],
    cannot: ["Publish anything on its own", "Change services, prices, plans, booking rules or the service area", "See revenue, billing or membership data", "Touch advertising"],
    personality: "A patient explorer. Always charting where homeowners search.",
  },
  {
    key: "outreach",
    name: "Leonidas",
    role: "Organic social & community",
    agents: ["outreach"],
    actionTypes: [],
    mission: "Grow Profixter's organic presence on Instagram, Facebook and in Long Island communities - with posts and local visibility that bring homeowners to book.",
    does: [
      "Prepares ready-to-publish Instagram and Facebook posts with tracked links",
      "Keeps a content calendar of seasonal, local home tips",
      "Finds local groups, pages, events and partners where Profixter may legitimately appear",
      "Measures visits and bookings from Instagram and Facebook",
    ],
    cannot: [
      "Post or publish - you do",
      "Paid campaigns or boosting - Meta Ads are the agency's",
      "Postcards, mail or cold lists",
      "Contact anyone or spend money",
    ],
    personality: "Disciplined and direct. Holds the line on the rules.",
  },
  {
    key: "conversation",
    name: "Marcus",
    role: "Customer re-engagement",
    agents: ["conversion", "conversation"],
    actionTypes: ["conversation_reply", "playbook_email"],
    mission: "Bring back homeowners who already know Profixter - free visits that did not join, registrations that never booked, past members - with consent-compliant follow-ups.",
    does: [
      "Drafts follow-up email workflows for each audience (you approve the wording)",
      "Works from counts and consent only - never names, contact details or amounts",
      "Respects unsubscribes, opt-outs, frequency caps and cool-downs",
      "Learns from what homeowners ask when they write in",
    ],
    cannot: [
      "Send anything without your approval",
      "Text anyone who did not opt in; GoHighLevel is out of scope",
      "Offer discounts, prices or guarantees",
      "See revenue, billing or subscription data",
    ],
    personality: "Calm and fair. Every message gets a thoughtful answer.",
  },
];

const ROBOT_BY_KEY = Object.fromEntries(ROBOTS.map((r) => [r.key, r]));

function labelsOf(robot) {
  return robot.agents.map((a) => AGENTS[a]?.label).filter(Boolean);
}

function robotOfAction(a) {
  const name = a.proposedBy?.name || "";
  return (
    ROBOTS.find((r) => r.actionTypes.includes(a.type))?.key ||
    ROBOTS.find((r) => labelsOf(r).includes(name))?.key ||
    (/conversation|conversion/i.test(name) ? "conversation" : /visib/i.test(name) ? "visibility" : /outreach/i.test(name) ? "outreach" : null)
  );
}

function robotOfAgent(agent) {
  return ROBOTS.find((r) => r.agents.includes(agent))?.key || null;
}

function shortText(s, n = 220) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function capabilities(robot, flags) {
  const pending = "Waits for your approval";
  if (robot.key === "visibility") {
    return [
      { label: "Search Console data", state: flags.searchConsole ? "on" : "off", note: flags.searchConsole ? "Connected" : "Not receiving data yet" },
      { label: "Page wording changes", state: flags.engine ? "approval" : "off", note: flags.engine ? pending : "Watch-only: proposals are recorded, nothing changes" },
      { label: "New pages", state: "approval", note: "Drafts only - you publish" },
    ];
  }
  if (robot.key === "outreach") {
    return [
      { label: "Social posts & community research", state: "on", note: "Drafts only - you publish" },
      { label: "Paid ads or boosting", state: "never", note: "The agency runs Meta Ads" },
      { label: "Spending or contacting anyone", state: "never", note: "Always your decision" },
      { label: "Postcards / mail", state: "never", note: "Your own project" },
    ];
  }
  return [
    { label: "Live replies to homeowners", state: flags.conversations ? "approval" : "off", note: flags.conversations ? pending : "Off until you approve going live" },
    { label: "Re-engagement workflows", state: "on", note: "Drafts twice a week" },
    { label: "Follow-up emails", state: flags.engine ? "approval" : "off", note: flags.engine ? "You approve the wording" : "Watch-only" },
    { label: "Booking visits", state: "never", note: "Homeowners book on profixter.com" },
  ];
}

async function robotStates({ now = new Date() } = {}) {
  const agentNames = ROBOTS.flatMap((r) => r.agents);
  const [latestRuns, running, attention, settings, monthCost] = await Promise.all([
    AgentRun.aggregate([
      { $match: { agent: { $in: agentNames }, status: { $ne: "skipped" } } },
      { $sort: { startedAt: -1 } },
      { $group: { _id: "$agent", run: { $first: "$$ROOT" } } },
    ]),
    AgentRun.find({ agent: { $in: agentNames }, status: "running", startedAt: { $gte: new Date(now - RUNNING_STALE_MS) } }).lean(),
    require("../council/attention").attentionSummary(),
    allSettings(),
    AgentRun.aggregate([
      { $match: { agent: { $in: agentNames }, startedAt: { $gte: new Date(now.getFullYear(), now.getMonth(), 1) } } },
      { $group: { _id: "$agent", cents: { $sum: "$costCents" } } },
    ]),
  ]);
  const last = Object.fromEntries(latestRuns.map((r) => [r._id, r.run]));
  const cost = Object.fromEntries(monthCost.map((c) => [c._id, c.cents || 0]));
  const on = agentsEnabled();
  const conversationsOn = process.env.CONVERSATIONS_ENABLED === "true";

  return ROBOTS.map((robot) => {
    const runNow = running.find((r) => robot.agents.includes(r.agent));
    const lastRun = robot.agents.map((a) => last[a]).filter(Boolean).sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0] || null;
    // ONE RULE: a knight never shows "?" or "waiting for you". What needs the owner is in King
    // Arthur's Decisions (counted once there); the rest is being worked on or reviewed.
    const mine = attention.byRobot[robot.key] || { decisions: 0, being_worked_on: 0, arthur_reviewing: 0 };
    const waiting = mine.decisions;
    const paused = robot.agents.some((a) => settings[a]?.paused);
    const next = robot.agents
      .map((a) => (AGENTS[a] ? nextRunFor(AGENTS[a], { from: now }) : null))
      .filter(Boolean)
      .sort((a, b) => a.at - b.at)[0];
    let status = "waiting";
    let statusText = next ? `Next shift ${next.label}` : "Waiting";
    if (runNow) {
      status = "working";
      statusText = `Working since ${new Date(runNow.startedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}`;
    } else if (paused) {
      status = "paused";
      statusText = "Paused by you";
    } else if (!on) {
      status = "off";
      statusText = "AI agents are switched off";
    } else if (lastRun && lastRun.status === "failed") {
      status = "error";
      statusText = "Last shift failed";
    }
    return {
      key: robot.key,
      name: robot.name,
      role: robot.role,
      status,
      statusText,
      waiting,
      paused,
      nextRunAt: next?.at || null,
      nextRunLabel: next?.label || null,
      lastRun: lastRun
        ? { at: lastRun.startedAt, status: lastRun.status, summary: shortText(correctedRun(lastRun).summary, 260), costCents: lastRun.costCents || 0, agent: lastRun.agent }
        : null,
      monthCostCents: Math.round(robot.agents.reduce((n, a) => n + (cost[a] || 0), 0) * 100) / 100,
      guidanceVersion: Math.max(0, ...robot.agents.map((a) => settings[a]?.version || 0)),
      liveReplies: robot.key === "conversation" ? conversationsOn : undefined,
      work: { inDecisions: mine.decisions, beingWorkedOn: mine.being_worked_on, arthurReviewing: mine.arthur_reviewing },
    };
  });
}

let cache = { at: 0, value: null };

/** The whole office in one small payload. Cached 45s per instance. */
async function buildOffice({ now = new Date(), fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < 45 * 1000) return cache.value;
  // one moment for every count: waiting items move on, unreviewed/time-sensitive ones join Arthur's inbox
  await require("../council/inbox").sweep({ now }).catch((e) => console.warn("attention sweep failed:", e.message));
  const { acquisitionView } = require("./commandCenter");
  const { buildVisibilitySummary } = require("../visibility/summary");
  const Booking = require("../../models/Booking");
  const since30 = new Date(now - 30 * 864e5);
  const [robots, acquisition, visibility, spentToday, spentMonth, lastFirstVisit, approvalsCount, threads30] = await Promise.all([
    robotStates({ now }),
    acquisitionView({ now }).catch(() => null),
    buildVisibilitySummary().catch(() => null),
    spentTodayCents(now),
    spentThisMonthCents(now),
    Booking.findOne({ isFreeFirstVisit: true }).sort({ createdAt: -1 }).select("createdAt").lean(),
    approvalCounts(),
    ConversationThread.aggregate([{ $match: { lastInboundAt: { $gte: since30 } } }, { $group: { _id: "$intent", n: { $sum: 1 } } }]).catch(() => []),
  ]);
  const search = visibility?.search?.available ? visibility.search : null;
  const qualifiedIntents = ["interested_free_visit", "question", "membership_or_services", "renovation"];
  const value = {
    generatedAt: now,
    agentsEnabled: agentsEnabled(),
    engineEnabled: process.env.GROWTH_ACTIONS_ENABLED === "true",
    conversationsEnabled: process.env.CONVERSATIONS_ENABLED === "true",
    robots,
    kpis: {
      firstFreeVisits: acquisition?.firstFreeVisits || null,
      funnel30: acquisition?.funnel30 || null,
      visitors30: acquisition?.visitors30 ?? null,
      registrations30: acquisition?.registrations30 ?? null,
      bySource30: acquisition?.bySource30 || [],
      search: search ? { windowDays: search.windowDays, clicks: search.current?.clicks ?? null, impressions: search.current?.impressions ?? null, clicksChangePct: search.change?.clicksPct ?? null } : null,
      searchReason: search ? null : visibility?.search?.reason || "not connected",
      conversations30: {
        total: threads30.reduce((n, r) => n + r.n, 0),
        qualified: threads30.filter((r) => qualifiedIntents.includes(r._id)).reduce((n, r) => n + r.n, 0),
      },
    },
    costs: {
      todayCents: Math.round(spentToday * 100) / 100,
      monthCents: Math.round(spentMonth * 100) / 100,
      dailyCapCents: dailyBudgetCents(),
      monthlyCapCents: monthlyBudgetCents(),
    },
    approvals: approvalsCount,
    lastFirstFreeVisitAt: lastFirstVisit?.createdAt || null,
  };
  value.explained = explain.explainResults(value);
  cache = { at: Date.now(), value };
  return value;
}

function invalidateOffice() {
  cache = { at: 0, value: null };
}

async function approvalCounts() {
  const [att, notes] = await Promise.all([
    require("../council/attention").attentionSummary(),
    AgentFinding.countDocuments({ kind: { $in: ["opportunity", "risk", "anomaly", "experiment"] }, status: "open", severity: { $in: ["medium", "high"] } }),
  ]);
  const inDecisions = (kind) => att.items.filter((i) => i.kind === kind && i.place === "decisions").length;
  return {
    // pending items that need the owner - each is ALSO the one entry in Arthur's Decisions (never counted twice)
    actions: inDecisions("action"),
    playbooks: inDecisions("playbook"),
    drafts: inDecisions("draft"),
    total: att.inDecisions,
    notes,
    beingWorkedOn: att.beingWorkedOn,
    arthurReviewing: att.arthurReviewing,
    pending: att.pending,
    // THE one number that may notify: decisions in Arthur's inbox that need the owner now
    needsYou: att.needsYou,
  };
}

/** Everything waiting for the owner, newest first. */
async function approvalsList() {
  const [actions, playbooks, drafts, notes] = await Promise.all([
    GrowthAction.find({ status: "awaiting_approval" }).sort({ createdAt: -1 }).limit(40).lean(),
    EmailPlaybook.find({ status: "draft" }).sort({ updatedAt: -1 }).limit(20).lean(),
    AgentFinding.find({ kind: "content_draft", status: "open" }).sort({ updatedAt: -1 }).limit(20).lean(),
    AgentFinding.find({ kind: { $in: ["opportunity", "risk", "anomaly", "experiment"] }, status: "open", severity: { $in: ["medium", "high"] } })
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean(),
  ]);
  const preview = (a) =>
    a.type === "conversation_reply"
      ? String(a.payload?.reply || "")
      : /^seo_/.test(a.type)
      ? Object.entries(a.payload?.changes || {})
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      : "";
  require("./plainExplainer")
    .explainMissing({ findings: notes, robotName: "agent" })
    .catch(() => {});
  const threadIds = actions.filter((x) => x.type === "conversation_reply" && x.payload?.threadId).map((x) => x.payload.threadId);
  const threads = threadIds.length ? await ConversationThread.find({ _id: { $in: threadIds } }).lean() : [];
  const threadById = Object.fromEntries(threads.map((t) => [String(t._id), t]));
  const nameOf = (key) => ROBOT_BY_KEY[key]?.name;
  const actionItems = await Promise.all(
    actions.map(async (x) => {
      const robot = robotOfAction(x);
      const e = await explain.explainAction(x, { robotName: nameOf(robot), thread: threadById[String(x.payload?.threadId)] });
      const names = [threadById[String(x.payload?.threadId)]?.firstName].filter(Boolean);
      return {
        kind: "action",
        id: String(x._id),
        robot,
        type: x.type,
        title: explain.redact(shortText(x.summary, 160), { names }),
        detail: explain.redact(shortText(x.rationale, 500), { names }),
        preview: explain.redact(shortText(preview(x), 1500), { names }),
        at: x.createdAt,
        risk: x.riskTier,
        simple: e.simple,
        chatgpt: e.chatgpt,
      };
    })
  );
  const places = new Map((await require("../council/attention").placeOf(await require("../council/attention").pendingItems())).map((i) => [`${i.kind}:${i.id}`, i]));
  const tag = (x) => {
    const p = places.get(`${x.kind}:${x.id}`);
    if (!p || p.place === "decisions") return { ...x, place: p?.place || "decisions" };
    return { ...x, place: p.place, waiting: { inbox: p.place === "arthur_reviewing" ? "arthur" : "waiting", reason: p.place === "arthur_reviewing" ? "King Arthur reviews new work before it comes to you" : p.reason, since: null } };
  };
  return {
    items: [
      ...actionItems,
      ...playbooks.map((pb) => {
        const e = explain.explainPlaybook(pb);
        return {
          kind: "playbook",
          id: pb.key,
          robot: "conversation",
          title: `Follow-up email: ${shortText(pb.subject || pb.name || pb.key, 120)}`,
          detail: shortText(pb.purpose || "", 400),
          preview: "",
          at: pb.updatedAt,
          simple: e.simple,
          chatgpt: e.chatgpt,
        };
      }),
      ...drafts.map((f) => {
        const e = explain.explainDraft(f);
        return {
          kind: "draft",
          id: String(f._id),
          robot: robotOfAgent(f.agent),
          title: shortText(f.title, 160),
          detail: shortText(f.detail || "", 600),
          preview: shortText(typeof f.body === "string" ? f.body : "", 1500),
          at: f.updatedAt,
          simple: e.simple,
          chatgpt: e.chatgpt,
        };
      }),
    ]
      .map(tag)
      .sort((x, y) => new Date(y.at) - new Date(x.at)),
    notes: notes.map((f) => {
      const e = explain.explainFinding(f);
      return {
        kind: "note",
        id: String(f._id),
        robot: robotOfAgent(f.agent),
        title: shortText(f.title, 160),
        detail: shortText(f.detail || "", 700),
        severity: f.severity,
        at: f.updatedAt,
        simple: e.simple,
        chatgpt: e.chatgpt,
      };
    }),
  };
}

/** One robot's panel: who it is, what it did, what it learned, its rules and controls. */
async function robotDetail(key, { now = new Date() } = {}) {
  const robot = ROBOT_BY_KEY[key];
  if (!robot) return null;
  const states = await robotStates({ now });
  const state = states.find((s) => s.key === key);
  const scheduled = robot.agents.filter((a) => AGENTS[a]);
  const labels = labelsOf(robot);
  const [runs, openFindings, memory, mistakesActions, settingsList, doneActions] = await Promise.all([
    AgentRun.find({ agent: { $in: robot.agents } }).sort({ startedAt: -1 }).limit(12).lean(),
    AgentFinding.find({ agent: { $in: robot.agents }, status: "open", kind: { $ne: "report" } }).sort({ updatedAt: -1 }).limit(12).lean(),
    AgentMemory.find({ agent: { $in: scheduled } }).sort({ updatedAt: -1 }).limit(30).lean(),
    GrowthAction.find({
      status: { $in: ["failed", "rolled_back", "rejected"] },
      $or: [{ type: { $in: robot.actionTypes } }, { "proposedBy.name": { $in: labels } }],
    })
      .sort({ updatedAt: -1 })
      .limit(8)
      .lean(),
    Promise.all(scheduled.map((a) => getSettings(a))),
    GrowthAction.find({
      status: "succeeded",
      $or: [{ type: { $in: robot.actionTypes } }, { "proposedBy.name": { $in: labels } }],
    })
      .sort({ updatedAt: -1 })
      .limit(6)
      .lean(),
  ]);
  const settings = settingsList[0] || { guidance: "", version: 0, history: [] };
  const toolErrors = runs.flatMap((r) => (r.toolCalls || []).filter((t) => t.ok === false).map((t) => ({ at: r.startedAt, tool: t.name, error: shortText(t.error, 200) }))).slice(0, 6);
  const flags = {
    engine: process.env.GROWTH_ACTIONS_ENABLED === "true",
    conversations: process.env.CONVERSATIONS_ENABLED === "true",
    searchConsole: Boolean((await require("../visibility/summary").buildVisibilitySummary().catch(() => null))?.search?.available),
  };
  require("./plainExplainer")
    .explainMissing({ findings: openFindings, runs, robotName: robot.name, now })
    .catch(() => {});
  const detail = {
    robot: { key: robot.key, name: robot.name, role: robot.role, mission: robot.mission, does: robot.does, cannot: robot.cannot, personality: robot.personality },
    state,
    schedule: scheduled.flatMap((a) => (AGENTS[a].schedules || []).map((s) => s.label)),
    capabilities: capabilities(robot, flags),
    runs: runs.map((r) => ({
      ...(({ simple, chatgpt }) => ({ simple, chatgpt }))(explain.explainRun(r, { robotName: robot.name })),
      id: String(r._id),
      agent: r.agent,
      at: r.startedAt,
      status: r.status,
      trigger: r.trigger,
      skipReason: r.skipReason,
      costCents: r.costCents || 0,
      summary: shortText(correctedRun(r).summary, 900),
      error: shortText(r.error, 300),
      findings: r.findings?.length || 0,
      actions: r.actions?.length || 0,
    })),
    findings: openFindings.map((f) => ({ ...explain.explainFinding(f), id: String(f._id), kind: f.kind, severity: f.severity, title: shortText(f.title, 160), detail: shortText(f.detail, 700), at: f.updatedAt })),
    results: doneActions.map((a) => ({ id: String(a._id), title: shortText(a.summary, 160), at: a.executedAt || a.updatedAt, verification: a.verification?.status || null })),
    learned: memory.map((m) => ({ key: m.key, content: shortText(m.content, 600), at: m.updatedAt })),
    mistakes: [
      ...runs.filter((r) => r.status === "failed").map((r) => ({ at: r.startedAt, what: "A shift failed", detail: shortText(r.error, 240) })),
      ...toolErrors.map((t) => ({ at: t.at, what: `A tool call was refused (${t.tool})`, detail: t.error })),
      ...mistakesActions.map((a) => ({
        at: a.updatedAt,
        what: a.status === "rejected" ? "You declined a proposal" : a.status === "rolled_back" ? "A change was rolled back" : "An action failed",
        detail: shortText(`${a.summary}${a.lastError ? ` - ${a.lastError}` : ""}${a.decisionNote ? ` - "${a.decisionNote}"` : ""}`, 260),
      })),
    ]
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, 10)
      .map((m) => ({ ...m, ...explain.explainMistake(m, { robotName: robot.name }) })),
    teach: {
      teachable: scheduled.length > 0,
      agent: scheduled[0] || null,
      guidance: settings.guidance || "",
      version: settings.version || 0,
      history: (settings.history || []).slice().reverse().map((h) => ({ version: h.version, guidance: h.guidance, by: h.by, at: h.at, note: h.note })),
      fixedRules: [SHARED_RULES, ...scheduled.map((a) => AGENTS[a].instructions)].join("\n\n"),
      note:
        key === "conversation"
          ? "Guidance steers Marcus's twice-weekly review. The live reply rules (never book, facts only, business-only, opt-outs first) are fixed and can't be edited here."
          : "",
    },
  };
  detail.explained = explain.explainRobot(detail);
  detail.teach.explained = explain.explainTeach(detail);
  return detail;
}

module.exports = { ROBOTS, approvalsList, buildOffice, invalidateOffice, robotDetail, robotOfAction, robotStates };
