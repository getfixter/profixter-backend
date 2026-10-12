const Subscription = require("../../models/Subscription");
const GiftMembership = require("../../models/GiftMembership");

/**
 * THE KINGDOM IS A NEW-CUSTOMER ACQUISITION SYSTEM (owner's rule, 2026-10-12).
 *
 *   find new homeowners -> registration -> FIRST FREE VISIT -> membership -> DONE
 *
 * Once someone has a membership (bought, or a claimed gift), the Kingdom's
 * work for that customer is finished: no acquisition follow-ups, no
 * individual analysis, no outreach - including after the membership ends.
 * Their bookings, visits, scheduling, payments, billing, cancellations and
 * membership management belong to the owner's operational systems, which run
 * on their own and are not touched here.
 *
 * Still prospects: people who registered but never booked, and people who had
 * their free visit but never bought a membership.
 *
 * Every rule that enforces this reads from this file:
 *   hasMembership()      send-time re-check before any acquisition message
 *   ACQUISITION_SEGMENTS the only audiences follow-ups may target
 *   outOfScope()         refuses tasks, focus, findings and records about
 *                        existing members' operations; archives old ones
 */
const ACQUISITION_SEGMENTS = ["free_visit_undecided", "registered_never_booked"];
const NEVER_STARTED = ["incomplete", "incomplete_expired"];

/** Has this person ever had a membership (a paid one that started, or a claimed gift)? */
async function hasMembership(userId) {
  if (!userId) return false;
  const [paid, gift] = await Promise.all([
    Subscription.exists({ user: userId, status: { $nin: NEVER_STARTED } }),
    GiftMembership.exists({ recipient: userId, status: { $in: ["claimed", "cancelled"] } }),
  ]);
  return Boolean(paid || gift);
}

/*
 * Existing-member operations. Together with refocus.BUSINESS_RE (revenue,
 * billing, cancellations, retention, payments, capacity, scheduling).
 */
const MEMBER_OPS_RE =
  /\b((?:existing|current|active|our) members?|members?'? (?:bookings?|visits?|appointments?|jobs?|accounts?|schedul\w*|calendar|payments?|plans?|renewals?|requests?)|bookings? (?:by|from|for) members?|membership (?:management|renewals?|upgrades?|downgrades?|changes?|pauses?|billing|payments?|status|support)|(?:upgrad|downgrad|renew|paus)\w* (?:a |their |the |his |her )?memberships?|refunds?|chargebacks?|(?:completed|finished|past) (?:jobs?|work orders?)|routine bookings?|(?:deleted|removed|cancell?ed) bookings?|bookings?\b[^.\n]{0,30}\b(?:deleted|removed)|win[- ]?back|former members?|past members?|ex-members?|lapsed members?)\b/i;

function outOfScope(text) {
  const { BUSINESS_RE } = require("../council/refocus");
  const t = String(text || "");
  return BUSINESS_RE.test(t) || MEMBER_OPS_RE.test(t);
}

const SCOPE_WHY =
  "Outside the acquisition mission: existing members, their bookings, visits, scheduling, payments, billing, cancellations and membership management are the owner's, not the Kingdom's. The Kingdom's work for a customer ends when they buy a membership.";

module.exports = { ACQUISITION_SEGMENTS, MEMBER_OPS_RE, SCOPE_WHY, hasMembership, outOfScope };
