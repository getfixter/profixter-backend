/**
 * The growth engine's on/off switches, with no side effects, so read-only
 * code (King Arthur's state, the office) can report what really acts without
 * loading the engine itself.
 *
 * GLOBAL SWITCH: GROWTH_ACTIONS_ENABLED === "true" lets every type act under
 * its trust policy.
 */

function engineEnabled() {
  return process.env.GROWTH_ACTIONS_ENABLED === "true";
}

/*
 * PER-TYPE SWITCH. With the global switch off, a type may still act when the
 * owner has turned on just that type: GROWTH_ACTIONS_ENABLED_TYPES lists them
 * (comma-separated). Only types in SELECTIVELY_ENABLEABLE can be turned on this
 * way:
 *   playbook_email  Marcus's follow-up emails from owner-approved playbooks
 *                   (owner, 2026-10-27) - every send still re-checks approval,
 *                   copy rules, membership, segment, unsubscribe and the caps
 * Texts (post_free_visit_sms, any SMS) and website changes can never be
 * switched on by this list; they need the global switch. gbp_post was on this
 * list until 2026-11-12; Google posting through GoHighLevel is retired and a
 * "gbp_post" left in the environment variable is ignored.
 */
const SELECTIVELY_ENABLEABLE = new Set(["playbook_email"]);

function enabledTypes(env = process.env) {
  return String(env.GROWTH_ACTIONS_ENABLED_TYPES || "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => SELECTIVELY_ENABLEABLE.has(t));
}

function typeEnabled(type, env = process.env) {
  return engineEnabled() || enabledTypes(env).includes(type);
}

module.exports = { SELECTIVELY_ENABLEABLE, enabledTypes, engineEnabled, typeEnabled };
