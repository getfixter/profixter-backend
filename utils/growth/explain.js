/**
 * Two levels for everything the Growth office shows the owner.
 *
 *   simple   - what a robot says to its boss, in everyday English: what it did,
 *              what happened, why it matters, and the question, if any.
 *   chatgpt  - a self-contained, structured brief the owner can paste into
 *              ChatGPT (or any assistant without access to our systems):
 *              business context, the exact situation, evidence, before/after,
 *              risks, reversibility, what approving does, the decision asked.
 *
 * Built ONLY from records we hold. A missing fact is said to be missing.
 * Nothing secret or personal leaves through a copy: no credentials, no
 * customer names, emails, phone numbers or street addresses (redact()).
 */
const { AGENTS } = require("../agents/definitions");
const { SEGMENT_DEFS } = require("./segments");

const SITE = "https://www.profixter.com";

const ROBOT_NAMES = { visibility: "Odysseus", outreach: "Leonidas", conversion: "Marcus Aurelius", conversation: "Marcus Aurelius", growth_intelligence: "the weekly report", arthur: "King Arthur" };
const ROBOT_ROLES = {
  Odysseus: "the explorer of the council - our search agent (Google, Maps, AI search)",
  Leonidas: "the vanguard of the council - our new-channels agent",
  "Marcus Aurelius": "the messenger of the council - our conversations & website agent (also drafts replies to homeowners who write in)",
  "King Arthur": "my AI manager - he coordinates the three specialists and recommends, but cannot approve anything",
};

/* ------------------------------------------------------------------ */
/* Safety                                                              */
/* ------------------------------------------------------------------ */

const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{10,}|pit-[A-Za-z0-9-]{10,}|EAA[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+|[A-Fa-f0-9]{32,})\b/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const STREET_RE = /\b\d{1,6}\s+(?:[A-Z][a-z]+\s){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Ln|Lane|Dr|Drive|Ct|Court|Pl|Place|Blvd|Way|Blvd|Terrace|Ter|Hwy|Highway|Pkwy|Parkway)\b\.?/g;

/** Remove anything sensitive from text that leaves the system through a copy. */
function redact(text, { names = [] } = {}) {
  let t = String(text ?? "");
  t = t.replace(SECRET_RE, "[removed]").replace(EMAIL_RE, "[email removed]").replace(PHONE_RE, "[phone removed]").replace(STREET_RE, "[address removed]");
  for (const n of names.filter((x) => x && x.length > 1)) t = t.replace(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[homeowner]");
  return t;
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                       */
/* ------------------------------------------------------------------ */

const CONTEXT = `## Background (for ChatGPT)
I own Profixter (${SITE}), a handyman membership company serving homeowners in Nassau and Suffolk counties on Long Island, New York. A small team of AI agents (built on Anthropic's Claude) helps us get NEW homeowners to book their FIRST FREE VISIT on our website - that is our number-one goal. I am not technical.

Fixed business rules the agents must follow (they cannot change these):
- AI never books visits. Homeowners book themselves on profixter.com.
- The free first visit is up to 90 minutes of real handyman work, one per home - not an inspection or an estimate.
- AI never offers discounts, deals or price changes, and never changes services, plans, memberships, booking rules or the service area.
- Meta (Facebook/Instagram) ads are run by an outside agency; the AI can only read ad data.
- No postcards or mail by AI. No texting or emailing purchased or imported contact lists.
- Text/email replies are business-only, and anyone who asks to stop is never contacted again.
- Anything customer-facing or risky waits for my approval; the system only lets an action type run on its own after several approved, verified successes, and sends it back to "needs approval" after any failure.`;

function askBlock(kind) {
  if (kind === "approval") {
    return `## What I need from you
Please explain this to me in simple words, check the risks, and recommend what I should do: approve it, decline it, or ask for changes (and which changes). Do NOT assume I will approve it - evaluate it critically. If something important is missing for a good decision, tell me what to ask the agent.`;
  }
  if (kind === "teach") {
    return `## What I need from you
Help me write short, clear guidance for this AI agent (3-6 lines, under 1,500 characters). It can steer focus, priorities and tone. It cannot change the fixed rules above - suggest nothing about prices, discounts, booking visits, ads or mail. Point out anything in my current guidance that is unclear or risky.`;
  }
  return `## What I need from you
Please explain this to me in simple words, check the risks, and recommend what I should do next (if anything). Point out anything that looks wrong, unclear or missing.`;
}

function iso(d) {
  return d ? new Date(d).toISOString() : "unknown";
}

function nyTime(d) {
  if (!d) return "unknown";
  return `${new Date(d).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })} (New York)`;
}

function lines(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
}

function brief(title, sections, kind = "info") {
  const body = sections
    .filter((s) => s && s.body && String(s.body).trim())
    .map((s) => `## ${s.heading}\n${String(s.body).trim()}`)
    .join("\n\n");
  return redact(`# ${title}\n\n${CONTEXT}\n\n${body}\n\n${askBlock(kind)}\n`);
}

function firstSentences(text, n = 2) {
  const parts = String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  return parts.slice(0, n).join(" ");
}

const FIELD_WORDS = { metaTitle: "the title Google shows", metaDescription: "the short description Google shows", h1: "the main heading on the page", intro: "the first paragraph on the page" };

function pageName(path) {
  const p = String(path || "");
  const slug = p.split("/").filter(Boolean).pop() || "home";
  const words = slug.replace(/-/g, " ");
  if (p.startsWith("/locations/")) return `${words.replace(/\b\w/g, (c) => c.toUpperCase())} town page`;
  if (p.startsWith("/services/")) return `${words} page`;
  return `${words} page`;
}

/* ------------------------------------------------------------------ */
/* Live page "before" values (cached, time-boxed)                       */
/* ------------------------------------------------------------------ */

const pageCache = new Map();
async function currentPage(path) {
  if (process.env.NODE_ENV === "test") return null; // tests never reach the live site
  const hit = pageCache.get(path);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  let value = null;
  try {
    const { livePage } = require("../seo/pageData");
    value = await Promise.race([livePage(path), new Promise((r) => setTimeout(() => r(null), 3500))]);
  } catch {
    value = null;
  }
  pageCache.set(path, { at: Date.now(), value });
  return value;
}

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

const ACTION_FACTS = {
  seo_page_update: {
    what: "Change the title and/or description Google shows for one page of profixter.com (stored as an override; the page itself and our offers do not change).",
    reversible: "Yes - one tap restores the exact previous wording. Google may take days to show either version.",
    ifApproved: "The new wording goes live on the page within minutes; the system checks the live page, tells search engines, and measures clicks again after 28 days.",
  },
  seo_content_update: {
    what: "Change the main heading and/or first paragraph customers read on one page of profixter.com.",
    reversible: "Yes - one tap restores the previous text.",
    ifApproved: "The new text goes live within minutes; the system checks the live page and measures the effect after 28 days.",
  },
  conversation_reply: {
    what: "Send ONE reply (text or email, through our GoHighLevel CRM) to a homeowner who wrote to us first.",
    reversible: "No - a sent message cannot be unsent.",
    ifApproved: "The reply is sent between 8am and 9pm New York time, only if the homeowner has not written again or opted out in the meantime, and only if they are not already a Profixter customer.",
  },
  playbook_email: {
    what: "Send an already-approved follow-up email to one person in its audience.",
    reversible: "No - a sent email cannot be unsent.",
    ifApproved: "One email is sent, with an unsubscribe link, respecting marketing consent and frequency limits.",
  },
  checkout_recovery_email: {
    what: "Send one reminder email to someone who started a membership checkout and did not finish.",
    reversible: "No - a sent email cannot be unsent.",
    ifApproved: "One email is sent linking to the plans page; nobody already subscribed receives it.",
  },
  post_free_visit_sms: {
    what: "Send one thank-you text after a completed free visit to someone who agreed to marketing texts.",
    reversible: "No - a sent text cannot be unsent.",
    ifApproved: "One text is sent in the allowed hours, only with marketing-text consent.",
  },
};

async function explainAction(a, { robotName, thread } = {}) {
  const facts = ACTION_FACTS[a.type] || { what: a.summary, reversible: "Unknown - ask before approving.", ifApproved: "The growth engine runs it once." };
  const agentName = robotName || a.proposedBy?.name || "the growth engine";
  const p = a.payload || {};
  let say;
  let ask;
  const details = [];
  const sections = [];

  if (/^seo_/.test(a.type)) {
    const page = await currentPage(p.path);
    const changes = p.changes || {};
    const what = Object.keys(changes).map((k) => FIELD_WORDS[k] || k);
    say =
      a.plain ||
      `Boss, I found a way to help more homeowners find Profixter on Google. I want to improve ${what.join(" and ")} for our ${pageName(p.path)}. This won't change our services or prices, and I can undo it anytime.`;
    ask = `Can I update the ${pageName(p.path)}?`;
    const ba = Object.entries(changes)
      .map(([k, v]) => {
        const before = page ? (k === "metaTitle" ? page.title : k === "metaDescription" ? page.metaDescription : k === "h1" ? page.h1 : null) : null;
        return `### ${FIELD_WORDS[k] || k} (${k})\n- Before: ${before ? `"${before}"` : k === "intro" ? "(current paragraph not captured)" : "(the current live value could not be read right now)"}\n- After: "${v}"`;
      })
      .join("\n");
    details.push(...Object.entries(changes).map(([k, v]) => `${FIELD_WORDS[k] || k}: "${v}"`));
    sections.push({ heading: "Exact change (before → after)", body: `Page: ${SITE}${p.path}\n${ba}` });
    sections.push({ heading: "Search terms it targets", body: (p.targetQueries || []).map((q) => `- ${q}`).join("\n") || "(none given)" });
    sections.push({ heading: "The agent's evidence", body: [p.reason, a.rationale].filter(Boolean).join("\n\n") || "(none given)" });
  } else if (a.type === "conversation_reply") {
    const town = thread?.town || "Long Island";
    const names = [thread?.firstName].filter(Boolean);
    const lastIn = [...(thread?.messages || [])].reverse().find((m) => m.direction === "inbound");
    say =
      a.plain ||
      `Boss, a homeowner in ${town} wrote to us. I'd like to send them the reply below. It explains our free first visit and links to our booking page - I won't book anything for them.`;
    ask = "Can I send this reply?";
    details.push(`Their message: "${redact(lastIn?.body || "(not available)", { names })}"`, `My reply: "${redact(p.reply || "", { names })}"`);
    sections.push({
      heading: "The conversation (personal details removed)",
      body: (thread?.messages || [])
        .slice(-6)
        .map((m) => `- ${m.direction === "inbound" ? "Homeowner" : m.by === "agent" ? "Our AI" : "Us"} (${nyTime(m.at)}): ${redact(m.body, { names })}`)
        .join("\n") || "(conversation not available)",
    });
    sections.push({ heading: "Proposed reply (exact text)", body: redact(p.reply || "", { names }) });
    sections.push({ heading: "Why the agent proposes it", body: redact(a.rationale || "", { names }) });
  } else {
    say = a.plain || `Boss, I'd like to do this: ${firstSentences(a.summary, 1)}`;
    ask = "Can I go ahead?";
    sections.push({ heading: "Proposal", body: `${a.summary}\n\n${a.rationale || ""}` });
  }

  const chatgpt = brief(
    `Approval request from my AI agent ${agentName}`,
    [
      {
        heading: "The request",
        body: lines({
          Agent: `${agentName}${ROBOT_ROLES[agentName] ? ` - ${ROBOT_ROLES[agentName]}` : ""}`,
          "Task ID": String(a._id),
          "Action type": a.type,
          "Proposed at": nyTime(a.createdAt),
          "Risk level (system's rating)": a.riskTier,
          "Current state": a.status === "awaiting_approval" ? "Waiting for my approval - nothing has happened yet" : a.status,
          "What it does": facts.what,
          "What happens if I approve": facts.ifApproved,
          "What happens if I decline": "Nothing happens. The agent may propose it again later only if the data changes.",
          "Reversible?": facts.reversible,
          "Cost": "No extra cost beyond the normal AI budget.",
        }),
      },
      ...sections,
      { heading: "The question for me", body: ask },
      { heading: "My choices", body: "- Approve (\"Yes, do it\")\n- Decline (\"Not now\")" },
    ],
    "approval"
  );
  return { simple: { say: redact(say), ask, details }, chatgpt };
}

function explainPlaybook(p) {
  const seg = SEGMENT_DEFS[p.segment];
  const who = seg?.label ? seg.label.charAt(0).toLowerCase() + seg.label.slice(1) : p.segment;
  const say = `Boss, I wrote a follow-up email for people who ${who.replace(/^had /, "had ").replace(/^registered/, "signed up")}. If you approve the wording, it can be sent to that group one person at a time - only to people who agreed to get our emails, and never with a discount.`;
  const ask = "Can I use this email?";
  const chatgpt = brief(
    "My AI agent Marcus Aurelius wrote a follow-up email and wants approval of the wording",
    [
      {
        heading: "The request",
        body: lines({
          Agent: "Marcus Aurelius - Conversations & website conversion agent",
          "Task ID": `playbook ${p.key} (version ${p.version || 1})`,
          "Written at": nyTime(p.updatedAt),
          Audience: seg?.label || p.segment,
          "Current state": "Draft - nothing is sent until I approve the wording",
          "What happens if I approve": "The growth engine may send it to people in that audience, one at a time, with an unsubscribe link, marketing consent required, at most one per person, with quiet days between emails. Sending itself is also controlled by the engine's trust level (it may still ask me first).",
          "What happens if I retire it": "It is never sent.",
          "Reversible?": "I can retire it at any time; emails already sent cannot be unsent.",
          "Purpose (agent)": p.purpose,
          "How success is measured (agent)": p.measure,
        }),
      },
      {
        heading: "The email (exact text)",
        body: `Subject: ${p.subject}\nPreview line: ${p.preheader || "(none)"}\nHeadline: ${p.headline}\n\n${(p.paragraphs || []).join("\n\n")}\n\nButton: ${p.ctaLabel} → ${SITE}${p.ctaRoute}\n${p.closing || ""}`,
      },
      { heading: "The question for me", body: ask },
      { heading: "My choices", body: "- Approve the wording (\"Yes, use it\")\n- Retire it (\"Not now\")" },
    ],
    "approval"
  );
  return { simple: { say, ask, details: [`Subject: "${p.subject}"`] }, chatgpt };
}

const DRAFT_WORDS = { town_page: "a new town page", service_page: "a service page", guide: "a helpful guide", faq: "a question-and-answer", gbp_post: "a Google Business Profile post", website_copy: "new wording for the website", message_copy: "message wording" };

function explainDraft(f) {
  const type = String(f.title || "").split(":")[0];
  const robot = ROBOT_NAMES[f.agent] || f.agent;
  const say = f.plain || `Boss, I wrote ${DRAFT_WORDS[type] || "a draft"}${f.target ? ` for ${f.target}` : ""}. Nothing is published - if you like it, you can use it.`;
  const ask = "Do you want to use this draft?";
  const chatgpt = brief(
    `My AI agent ${robot} wrote a draft for my review`,
    [
      {
        heading: "The draft",
        body: lines({
          Agent: robot,
          "Task ID": String(f._id),
          "Written at": nyTime(f.updatedAt),
          Kind: DRAFT_WORDS[type] || type,
          Target: f.target,
          "Current state": "Draft only - nothing is published automatically; I would publish it myself",
          "Why the agent wrote it": f.detail,
        }),
      },
      { heading: "Full text", body: f.body || "(empty)" },
      { heading: "The question for me", body: "Is this draft accurate, useful and safe to publish? What should I change first?" },
    ],
    "approval"
  );
  return { simple: { say: redact(say), ask }, chatgpt };
}

/* ------------------------------------------------------------------ */
/* Notes, shifts, mistakes                                             */
/* ------------------------------------------------------------------ */

const KIND_WORDS = { opportunity: "an opportunity", risk: "a risk", anomaly: "something unusual", insight: "something I learned", experiment: "an idea to test", creative_brief: "an idea" };

function explainFinding(f) {
  const robot = ROBOT_NAMES[f.agent] || f.agent;
  const say = f.plain || `Boss, I noticed ${KIND_WORDS[f.kind] || "something"}: ${String(f.title || "").replace(/\.$/, "")}.`;
  const chatgpt = brief(
    `A note from my AI agent ${robot}: ${f.title}`,
    [
      {
        heading: "The note",
        body: lines({
          Agent: `${robot}${ROBOT_ROLES[robot] ? ` - ${ROBOT_ROLES[robot]}` : ""}`,
          "Note ID": String(f._id),
          Kind: f.kind,
          "Importance (agent's rating)": f.severity,
          "First written": nyTime(f.createdAt),
          "Last updated": nyTime(f.updatedAt),
          "Times the agent has raised it": f.seenCount,
          Status: f.status,
        }),
      },
      { heading: "What the agent found", body: f.detail },
      { heading: "Evidence (the agent's numbers)", body: f.evidence },
      { heading: "Expected effect (agent's estimate)", body: f.expectedImpact },
      { heading: "The agent's question for me", body: f.ownerQuestion || "(none - it is information)" },
      { heading: "My choices", body: "- Got it (keep it as acknowledged)\n- Dismiss (not useful)" },
    ],
    f.ownerQuestion ? "approval" : "info"
  );
  return { simple: { say: redact(say), ask: f.ownerQuestion || null, pendingSimple: !f.plain }, chatgpt };
}

const SKIP_WORDS = {
  paused_by_owner: "you had paused me",
  agents_disabled: "the AI team was switched off",
  no_api_key: "the AI connection wasn't set up",
  already_running: "I was already working",
};

function explainRun(r, { robotName } = {}) {
  const robot = robotName || ROBOT_NAMES[r.agent] || r.agent;
  let say;
  if (r.status === "skipped") {
    const why = SKIP_WORDS[r.skipReason] || (/budget/.test(r.skipReason || "") ? "we reached the AI spending limit" : r.skipReason || "of a setting");
    say = `I skipped this shift because ${why}.`;
  } else if (r.status === "failed") {
    say = /transient|overloaded|529|429|connection/i.test(r.error || "")
      ? "This shift didn't finish - the AI service was busy. I try again automatically once."
      : "This shift didn't finish because something went wrong. A person may need to look at it.";
  } else if (r.status === "running") {
    say = "I'm working on this shift right now.";
  } else if (r.status === "budget_stopped") {
    say = "I stopped this shift early because it reached its spending limit.";
  } else {
    say = r.plainSummary || firstSentences(r.summary, 2) || "I finished my shift.";
  }
  const chatgpt = brief(
    `Work report from my AI agent ${robot}`,
    [
      {
        heading: "The shift",
        body: lines({
          Agent: `${robot}${ROBOT_ROLES[robot] ? ` - ${ROBOT_ROLES[robot]}` : ""}`,
          "Run ID": String(r._id),
          Started: nyTime(r.startedAt),
          Finished: r.finishedAt ? nyTime(r.finishedAt) : undefined,
          Trigger: r.trigger === "event" ? "a homeowner message" : r.trigger,
          Status: r.status,
          "Skip reason": r.skipReason,
          "AI cost": r.costCents != null ? `$${(r.costCents / 100).toFixed(2)}` : undefined,
          "Notes recorded": r.findings?.length,
          "Actions proposed": r.actions?.length,
          Error: r.error,
        }),
      },
      { heading: "Summary for the owner (agent's words)", body: r.plainSummary },
      { heading: "Full technical summary (agent's words)", body: r.summary || "(no summary)" },
    ]
  );
  return { simple: { say: redact(say), pendingSimple: r.status === "succeeded" && !r.plainSummary && Boolean(r.summary) }, chatgpt };
}

function explainMistake(m, { robotName } = {}) {
  const say = /declined/i.test(m.what)
    ? "You said no to one of my ideas. I'll remember that and not push it again unless the numbers change."
    : /rolled back/i.test(m.what)
    ? "A change I made was undone. The old version is back."
    : /refused/i.test(m.what)
    ? "I tried to do something I'm not allowed to do, and the system stopped me. That's the safety rules working."
    : /busy|transient|529|429|overloaded/i.test(m.detail || "")
    ? "One of my shifts didn't finish because the AI service was busy. I retry automatically."
    : "Something went wrong in one of my shifts.";
  const chatgpt = brief(`A problem reported by my AI agent ${robotName || "agent"}`, [
    { heading: "What happened", body: lines({ Agent: robotName, When: nyTime(m.at), Event: m.what, Details: m.detail }) },
  ]);
  return { simple: { say }, chatgpt };
}

/* ------------------------------------------------------------------ */
/* Robot, teaching, business results                                   */
/* ------------------------------------------------------------------ */

const STATUS_SAY = {
  working: "Right now I'm working on my shift.",
  needs_you: "I have something waiting for your answer.",
  error: "My last shift didn't go well - I need a person to look.",
  paused: "You paused me, so I'm resting until you wake me up.",
  off: "The AI team is switched off, so I'm sleeping.",
  waiting: "I'm waiting for my next shift.",
};

function explainRobot(detail) {
  const r = detail.robot;
  const s = detail.state;
  const intro = {
    visibility: "I'm Odysseus, your explorer. I help homeowners find Profixter on Google and other search sites, so more of them book a free first visit.",
    outreach: "I'm Leonidas, your vanguard. I look for new, honest ways to reach homeowners on Long Island - and I test them small before anything costs real money.",
    conversation: "I'm Marcus Aurelius, your messenger. I help homeowners who write to us or visit our website get to booking their free first visit - they always book it themselves.",
  }[r.key];
  const next = s.nextRunAt ? ` My next shift is ${new Date(s.nextRunAt).toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}.` : "";
  const waiting = s.waiting ? ` ${s.waiting === 1 ? "One thing is" : `${s.waiting} things are`} waiting for you.` : "";
  const say = `Hi Boss! ${intro} ${STATUS_SAY[s.status] || ""}${waiting}${s.status === "waiting" || s.status === "needs_you" ? next : ""}`;
  const lastRun = detail.runs.find((x) => x.status !== "skipped");
  const chatgpt = brief(`Status of my AI agent ${r.name}`, [
    {
      heading: "The agent",
      body: lines({ Name: r.name, Role: r.role, Mission: r.mission, "Status now": `${s.status} - ${s.statusText}`, Schedule: detail.schedule.join("; ") || "none", "Waiting for me": s.waiting, "AI cost this month": `$${(s.monthCostCents / 100).toFixed(2)}` }),
    },
    { heading: "What it does", body: r.does.map((d) => `- ${d}`).join("\n") },
    { heading: "What it can never do", body: r.cannot.map((d) => `- ${d}`).join("\n") },
    { heading: "What is switched on", body: detail.capabilities.map((c) => `- ${c.label}: ${c.state} (${c.note})`).join("\n") },
    { heading: "Its last finished shift", body: lastRun ? `${nyTime(lastRun.at)} - ${lastRun.status}\n${lastRun.summary || ""}` : "None yet." },
    { heading: "Open notes", body: detail.findings.map((f) => `- [${f.severity}] ${f.title}`).join("\n") || "None." },
    { heading: "Recent problems", body: detail.mistakes.map((m) => `- ${nyTime(m.at)}: ${m.what}${m.detail ? ` - ${m.detail}` : ""}`).join("\n") || "None." },
  ]);
  return { simple: { say }, chatgpt };
}

function explainTeach(detail) {
  const r = detail.robot;
  const t = detail.teach;
  const chatgpt = brief(
    `Help me teach my AI agent ${r.name}`,
    [
      { heading: "The agent", body: lines({ Name: r.name, Role: r.role, Mission: r.mission }) },
      { heading: "What it does", body: r.does.map((d) => `- ${d}`).join("\n") },
      { heading: "What it can never do (fixed)", body: r.cannot.map((d) => `- ${d}`).join("\n") },
      {
        heading: "How guidance works",
        body: "My guidance is added to the agent's instructions on its next shift, BELOW its fixed rules; when they conflict, the fixed rules win. It does not retrain the AI. The system refuses guidance that tries to change prices or offers, book visits, touch ads or mail, contact purchased lists, or override rules. Limit: 1,500 characters.",
      },
      { heading: `My current guidance (version ${t.version})`, body: t.guidance || "(none yet)" },
      { heading: "What the agent has learned (its own notes)", body: detail.learned.map((m) => `- ${m.key}: ${m.content}`).join("\n") || "(nothing yet)" },
      { heading: "Recent mistakes and outcomes", body: detail.mistakes.map((m) => `- ${m.what}${m.detail ? ` - ${m.detail}` : ""}`).join("\n") || "(none)" },
    ],
    "teach"
  );
  return { simple: { say: `Hi Boss! You can tell me what to focus on - which towns, what matters most, how to sound. I'll read it before my next shift. My safety rules always come first.` }, chatgpt };
}

function explainResults(office) {
  const k = office.kpis || {};
  const f = k.firstFreeVisits;
  const parts = [];
  if (f && f.last7 != null) {
    const diff = f.prev7 != null ? f.last7 - f.prev7 : null;
    parts.push(
      `This week, ${f.last7 === 1 ? "1 homeowner" : `${f.last7} homeowners`} booked their first free visit${diff == null ? "" : diff === 0 ? " - the same as last week" : diff > 0 ? ` - ${diff} more than last week` : ` - ${-diff} fewer than last week`}.`
    );
  } else parts.push("I can't see this week's bookings right now.");
  if (f && f.last30 != null) parts.push(`In the last 30 days: ${f.last30}${f.prev30 != null ? ` (the 30 days before: ${f.prev30})` : ""}.`);
  const fn = k.funnel30;
  if (fn && fn.booking_page_view) parts.push(`${fn.booking_page_view} people looked at our booking page this month, and ${fn.firstFreeVisits ?? "some"} booked.`);
  parts.push(office.approvals?.total ? `${office.approvals.total} ${office.approvals.total === 1 ? "thing is" : "things are"} waiting for your answer.` : "Nothing is waiting for your answer.");
  const say = parts.join(" ");
  const chatgpt = brief("How my business is doing - new customer bookings", [
    {
      heading: "Main goal: new first free-visit bookings",
      body: f
        ? lines({ "Last 7 days": f.last7, "Previous 7 days": f.prev7, "Last 30 days": f.last30, "Previous 30 days": f.prev30, Definition: "a home's first-ever free visit, counted when booked" })
        : "Not available right now.",
    },
    {
      heading: "Booking funnel, last 30 days",
      body: fn
        ? `${lines({ "Saw the booking form": fn.booking_page_view, "Started filling it": fn.booker_started, "Picked a time": fn.slot_selected, "Went to sign up": fn.signup_view, "Booked a first free visit": fn.firstFreeVisits })}\n(Funnel steps are counted since ${fn.trackingSince}, once per browser per day; months before that are not comparable.)`
        : "Not available.",
    },
    {
      heading: "Website and search, last 30 days",
      body: lines({
        "Website visitors": k.visitors30,
        "Account sign-ups": k.registrations30,
        "Google clicks": k.search ? `${k.search.clicks} (${k.search.windowDays} days; ${k.search.impressions} times shown in Google${k.search.clicksChangePct != null ? `; ${k.search.clicksChangePct}% vs previous period` : ""})` : `not available (${k.searchReason || "not connected"})`,
        "First free visits by source": (k.bySource30 || []).filter((s) => s.freeVisits).map((s) => `${s.label} ${s.freeVisits}`).join(", ") || "none recorded",
      }),
    },
    {
      heading: "Conversations (homeowners who wrote to us), last 30 days",
      body: lines({ Total: k.conversations30?.total, "About our services": k.conversations30?.qualified, "AI replies": office.conversationsEnabled ? "on (each reply needs approval until trusted)" : "off" }),
    },
    {
      heading: "AI team costs",
      body: lines({
        Today: `$${(office.costs.todayCents / 100).toFixed(2)} of $${(office.costs.dailyCapCents / 100).toFixed(2)} daily limit`,
        "This month": `$${(office.costs.monthCents / 100).toFixed(2)} of $${(office.costs.monthlyCapCents / 100).toFixed(2)} monthly limit`,
      }),
    },
    {
      heading: "The AI team right now",
      body: (office.robots || []).map((r) => `- ${r.name} (${r.role}): ${r.statusText}`).join("\n"),
    },
    { heading: "Waiting for my decision", body: `${office.approvals?.total || 0} approvals, ${office.approvals?.notes || 0} open notes` },
    { heading: "Latest weekly report", body: office.report ? `${office.report.headline} (${nyTime(office.report.at)})` : "None yet." },
  ]);
  return { simple: { say }, chatgpt };
}

module.exports = {
  ACTION_FACTS,
  CONTEXT,
  nyTime,
  ROBOT_NAMES,
  explainAction,
  explainDraft,
  explainFinding,
  explainMistake,
  explainPlaybook,
  explainResults,
  explainRobot,
  explainRun,
  explainTeach,
  redact,
};
