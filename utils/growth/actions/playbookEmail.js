const mongoose = require("mongoose");
const User = require("../../../models/User");
const EmailPlaybook = require("../../../models/EmailPlaybook");
const GrowthAction = require("../../../models/GrowthAction");
const MarketingSend = require("../../../models/MarketingSend");
const { sendRaw } = require("../../emailService");
const { renderMarketingEmail } = require("../../marketing/marketingRenderer");
const { isMarketableAccount, isUnsubscribed } = require("../../marketing/marketingEligibility");
const { checkCopy } = require("../../agents/copyRules");
const { segmentDef } = require("../segments");
const { ACQUISITION_SEGMENTS, hasMembership } = require("../acquisitionScope");
const { defineAction } = require("../actionRegistry");

/**
 * One approved playbook email to one customer in the playbook's segment.
 *
 * Email only - marketing SMS consent covers almost nobody, and email follows
 * the opt-out model with a one-click unsubscribe. Every send re-checks, at
 * the moment it runs:
 *   - the playbook is still approved, at the version the owner approved
 *   - the wording still passes the copy rules (no discounts, prices, claims)
 *   - the person is a marketable account and not unsubscribed
 *   - the person is STILL in the segment (they may have booked or joined)
 *   - no other marketing or playbook email reached them in the last 7 days,
 *     and no more than 3 follow-ups in 90 days
 *   - they have never received this playbook (idempotency key per person)
 *
 * AUTONOMOUS (owner, 2026-10-27): no per-email approval. The owner's gate is
 * the PLAYBOOK - its wording is approved once, and a send happens only at the
 * exact version approved. Two failures in 7 days still suspend it.
 * (Before 2026-10-27 it started supervised: the first 5 sends each waited.)
 */
const TYPE = "playbook_email";
const QUIET_DAYS = 7;
// reasonable frequency (owner, 2026-10-12): at most this many Kingdom follow-up emails per person per window
const MAX_PER_WINDOW = 3;
const WINDOW_DAYS = 90;
/*
 * PACING (owner, 2026-10-27: never the whole audience as a batch). At most
 * PER_DAY sends in any 24 hours - checked when a send is queued AND again at
 * the moment it goes - at most PER_RUN queued per hourly run, and only in the
 * daytime, New York time.
 */
const PER_DAY = 12;
const PER_RUN = 3;
const SEND_HOURS = { start: 9, end: 18 };
const TIMEZONE = "America/New_York";
const HOUR = 60 * 60 * 1000;

function nyHour(now) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, hour: "numeric", hour12: false }).format(now)) % 24;
}
const inSendHours = (now) => {
  const h = nyHour(now);
  return h >= SEND_HOURS.start && h < SEND_HOURS.end;
};
/** The next whole hour inside the send hours (checked hour by hour; DST-proof). */
function nextSendHour(now) {
  let t = new Date(Math.ceil(now.getTime() / HOUR) * HOUR + 5 * 60 * 1000);
  for (let i = 0; i < 48 && !inSendHours(t); i += 1) t = new Date(t.getTime() + HOUR);
  return t;
}

async function sentInLast24h(now, excludeId = null) {
  return GrowthAction.countDocuments({ type: TYPE, status: "succeeded", executedAt: { $gte: new Date(now.getTime() - 24 * HOUR) }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) });
}

function validate(p = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(p.userId || ""))) throw new Error("playbook_email needs a userId");
  const playbookKey = String(p.playbookKey || "");
  if (!/^[a-z0-9_-]{3,60}$/.test(playbookKey)) throw new Error("playbook_email needs a playbookKey");
  return { userId: String(p.userId), playbookKey, version: Number(p.version) || null };
}

/*
 * Where each acquisition audience's button may go. Someone who never booked is
 * sent to the free visit itself (/book/free - the one-step request), not the
 * general /book page. Someone who already had their free visit is never offered
 * it again: it is one per customer.
 */
const ROUTES_BY_SEGMENT = {
  registered_never_booked: ["bookFree", "membership", "plans", "services"],
  free_visit_undecided: ["membership", "plans", "bookOneTime", "services"],
};

/**
 * The route KEY the button really uses. A path ("/book/free") is read as the
 * key it belongs to, and older drafts that said "book" to never-booked
 * prospects meant the free visit.
 */
function ctaRouteOf(pb) {
  const { ROUTES } = require("../../marketing/marketingConfig");
  let route = String(pb.ctaRoute || "");
  if (route.startsWith("/")) route = Object.keys(ROUTES).find((k) => ROUTES[k] === route) || route;
  if (route === "book" && pb.segment === "registered_never_booked") return "bookFree";
  return route;
}

/** Why a playbook's button cannot go where it says (null = fine). */
function ctaRouteProblem(segment, route) {
  const allowed = ROUTES_BY_SEGMENT[segment];
  if (!allowed || allowed.includes(route)) return null;
  if (route === "bookFree") return "These customers already had their free visit (one per customer) - send them to membership, plans, bookOneTime or services.";
  return `The button for "${segment}" must go to one of: ${allowed.join(", ")}.`;
}

function templateOf(pb) {
  return {
    id: `playbook_${pb.key}`,
    audience: ["non_member", "member", "former_member"],
    subject: pb.subject,
    preheader: pb.preheader,
    headline: pb.headline,
    paragraphs: [({ name }) => `Hi ${name},`, ...pb.paragraphs],
    ctaLabel: pb.ctaLabel,
    ctaRoute: ctaRouteOf(pb),
    closing: pb.closing,
  };
}

function playbookText(pb) {
  return [pb.subject, pb.preheader, pb.headline, ...(pb.paragraphs || []), pb.ctaLabel, pb.closing].join("\n");
}

/** Any marketing email (lifecycle or playbook) in the last 7 days. */
async function emailedThisWeek(user, actionId, now) {
  const since = new Date(now.getTime() - QUIET_DAYS * 24 * 60 * 60 * 1000);
  const [marketing, playbook] = await Promise.all([
    MarketingSend.exists({ user: user._id, status: "sent", sentAt: { $gte: since } }),
    GrowthAction.exists({ _id: { $ne: actionId }, type: TYPE, "subject.entityId": String(user._id), status: "succeeded", executedAt: { $gte: since } }),
  ]);
  return Boolean(marketing || playbook);
}

/** 3 follow-ups in 90 days already. */
async function followUpCapReached(user, actionId, now) {
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const inWindow = await GrowthAction.countDocuments({ _id: { $ne: actionId }, type: TYPE, "subject.entityId": String(user._id), status: "succeeded", executedAt: { $gte: windowStart } });
  return inWindow >= MAX_PER_WINDOW;
}

async function recentlyEmailed(user, actionId, now) {
  return (await emailedThisWeek(user, actionId, now)) || (await followUpCapReached(user, actionId, now));
}

/*
 * NO DOUBLE FOLLOW-UP. The lifecycle marketing system (utils/marketing) runs
 * its own scripted emails for a non-member in the weeks after their free
 * visit - the same people and the same purpose as "free_visit_undecided".
 * While that sequence is running (and the lifecycle system is on for
 * non-members), Marcus stays out; he picks up after it ends. The shared
 * weekly floor (recentlyEmailed here, lastMarketingAt there) covers the rest.
 */
async function lifecycleSequenceActive(user, now) {
  const { marketingEnabled, audienceEnabled } = require("../../marketing/marketingConfig");
  if (!marketingEnabled() || !audienceEnabled("non_member")) return false;
  const { buildProfile, inPostFreeVisitSequence } = require("../../marketing/marketingEligibility");
  return inPostFreeVisitSequence(await buildProfile(user, now));
}

async function execute(payload, { action, now }) {
  const pb = await EmailPlaybook.findOne({ key: payload.playbookKey }).lean();
  if (!pb || pb.status !== "approved") return { outcome: "skip", reason: "playbook_not_approved" };
  if (pb.approvedVersion !== pb.version) return { outcome: "skip", reason: "playbook_changed_since_approval" };
  if (checkCopy(playbookText(pb)).length) return { outcome: "skip", reason: "copy_rules_failed" };
  // acquisition follow-ups only: never to an audience of people who already bought a membership
  if (!ACQUISITION_SEGMENTS.includes(pb.segment)) return { outcome: "skip", reason: "outside_acquisition_scope" };

  const user = await User.findById(payload.userId).select(
    "_id userId email name firstName role isActive employeePosition excludeFromMarketing createdAt"
  );
  if (!user) return { outcome: "skip", reason: "user_not_found" };
  if (!isMarketableAccount(user)) return { outcome: "skip", reason: "not_marketable" };
  if (await isUnsubscribed(user.email)) return { outcome: "skip", reason: "unsubscribed" };
  // re-checked at the moment of sending: a membership ends the follow-ups, immediately
  if (await hasMembership(user._id)) return { outcome: "skip", reason: "membership_purchased" };
  const seg = segmentDef(pb.segment);
  if (!seg || !(await seg.includes(user, { now }))) return { outcome: "skip", reason: "no_longer_in_segment" };
  if (await followUpCapReached(user, action._id, now)) return { outcome: "skip", reason: "follow_up_cap_reached" };
  // temporary reasons WAIT rather than skip, so the person is not lost for this playbook
  if (await emailedThisWeek(user, action._id, now)) return { outcome: "defer", until: new Date(now.getTime() + 24 * HOUR) };
  if (await lifecycleSequenceActive(user, now)) return { outcome: "defer", until: new Date(now.getTime() + 3 * 24 * HOUR) };
  if (!inSendHours(now)) return { outcome: "defer", until: nextSendHour(now) };
  if ((await sentInLast24h(now, action._id)) >= PER_DAY) return { outcome: "defer", until: new Date(now.getTime() + HOUR) };
  // never a button to a page that does not exist, or the free visit to someone who already had it
  if (ctaRouteProblem(pb.segment, ctaRouteOf(pb))) return { outcome: "skip", reason: "button_link_not_allowed" };

  const rendered = renderMarketingEmail(templateOf(pb), {
    name: String(user.firstName || user.name || "there").split(" ")[0],
    email: user.email,
  });
  const info = await sendRaw({
    to: user.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: {
      "List-Unsubscribe": `<${rendered.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    logContext: {
      templateKey: `playbook:${pb.key}`,
      emailType: "marketing",
      source: "growth_engine",
      userId: user.userId || String(user._id),
      recipientName: user.firstName || user.name || "",
    },
  });
  const [local, domain] = String(user.email).split("@");
  return {
    outcome: "done",
    result: { to: `${local.slice(0, 2)}***@${domain}`, messageId: String(info?.messageId || "") || null, playbook: pb.key, version: pb.version },
  };
}

defineAction({
  type: TYPE,
  label: "Approved follow-up email",
  description:
    "One email from an owner-approved playbook to one customer in its segment. Email only, marketing rules, unsubscribe honoured, at most one per person per playbook, nothing within 7 days of another marketing email, at most 3 follow-ups per person in 90 days.",
  riskTier: "medium",
  // owner, 2026-10-27: Marcus operates independently; approval is of the playbook wording, not each email
  defaultMode: "autonomous",
  maxMode: "autonomous",
  promoteAfter: null,
  limits: { perDay: PER_DAY },
  // over the limit: not stored, proposed again later - never parked in the owner's approvals
  overLimit: "later",
  approvalTtlMs: 3 * 24 * 60 * 60 * 1000,
  verifyAfterMs: 5 * 60 * 1000,
  maxAttempts: 2,
  validate,
  describe: (p) => `Send the "${p.playbookKey}" follow-up email to one customer`,
  subjectOf: (p) => ({ entityType: "user", entityId: p.userId }),
  execute,
  verify: async (a) => (a.result?.messageId ? { passed: true, detail: "accepted by the mail provider" } : { passed: false, detail: "no message id" }),
});

/**
 * Hourly: queue a few sends from the approved playbooks - PER_RUN at most,
 * never past the daily limit, in the daytime only - and only to people who
 * would pass the checks right now. Someone not ready yet (emailed this week,
 * still in the lifecycle sequence, unsubscribed) is simply not queued, so
 * they can be queued on a later run; nothing is used up on them.
 */
async function proposePlaybookEmails({ propose, now = new Date() } = {}) {
  if (!inSendHours(now)) return { proposed: 0, reason: "outside_send_hours" };
  const { usedToday } = require("../actionEngine");
  let room = Math.min(PER_RUN, PER_DAY - (await usedToday(TYPE, now)));
  if (room <= 0) return { proposed: 0, reason: "daily_limit" };
  const playbooks = await EmailPlaybook.find({ status: "approved" }).lean();
  let proposed = 0;
  for (const pb of playbooks) {
    if (room <= 0) break;
    if (pb.approvedVersion !== pb.version) continue;
    if (!ACQUISITION_SEGMENTS.includes(pb.segment)) continue;
    const seg = segmentDef(pb.segment);
    if (!seg) continue;
    const ids = await seg.members({ now, limit: 50 });
    for (const userId of ids) {
      if (room <= 0) break;
      if (await GrowthAction.exists({ idempotencyKey: `${TYPE}:${pb.key}:${userId}` })) continue;
      if (!(await readyNow(userId, now))) continue;
      const { created } = await propose(
        TYPE,
        { userId, playbookKey: pb.key, version: pb.version },
        {
          idempotencyKey: `${TYPE}:${pb.key}:${userId}`,
          rationale: `In segment "${pb.segment}". Playbook purpose: ${pb.purpose || "-"}`.slice(0, 500),
          proposedBy: { kind: "system", name: `Playbook: ${pb.name}` },
          now,
        }
      );
      if (created) {
        proposed += 1;
        room -= 1;
      }
    }
  }
  return { proposed };
}

/** The cheap per-person checks, before anything is queued. */
async function readyNow(userId, now) {
  const user = await User.findById(userId).select("_id userId email name firstName role isActive employeePosition excludeFromMarketing createdAt");
  if (!user || !isMarketableAccount(user)) return false;
  if (await isUnsubscribed(user.email)) return false;
  if (await hasMembership(user._id)) return false;
  if (await recentlyEmailed(user, null, now)) return false;
  if (await lifecycleSequenceActive(user, now)) return false;
  return true;
}

module.exports = { PER_DAY, PER_RUN, ROUTES_BY_SEGMENT, SEND_HOURS, TYPE, ctaRouteOf, inSendHours, nextSendHour, ctaRouteProblem, execute, lifecycleSequenceActive, playbookText, proposePlaybookEmails, templateOf, validate };
