/**
 * Every kind of action the growth system may take, and how far it is trusted.
 *
 * Nothing can be executed through utils/growth/actionEngine unless it is
 * defined here, so this file is the complete list of what the system can do on
 * its own. Adding a capability means adding a definition, and its risk tier and
 * ceiling are reviewed with it.
 *
 * THE TRUST LADDER
 *
 *   off         not even recorded
 *   shadow      recorded as "would have done this", never executed - how a new
 *               automation proves its targeting before it touches anyone
 *   supervised  each instance waits for the owner's approval
 *   autonomous  runs on its own, inside the definition's limits
 *
 * `defaultMode` is where a type starts. `maxMode` is the highest rung it may
 * ever reach, by promotion or by the owner: a high-risk type is capped at
 * supervised in code, so no button and no streak of successes can make it run
 * unattended. `promoteAfter` is the run of consecutive verified successes that
 * moves a supervised type to autonomous by itself (null = only the owner can).
 * Any failure drops an autonomous type back to supervised.
 */

const MODES = ["off", "shadow", "supervised", "autonomous"];
const RISK_TIERS = ["low", "medium", "high"];

const definitions = new Map();

/*
 * PERMANENTLY PROHIBITED: any action on advertising platforms.
 *
 * Profixter's Meta (Facebook/Instagram) advertising is managed by an external
 * agency, and the owner's rule is absolute: the growth system reads ad data and
 * never changes anything in an ad account - no campaigns, budgets, targeting,
 * creatives, bids or account settings, at any trust level, ever. Enforced here,
 * at registration, so no future action type can exist to be proposed,
 * approved or promoted. Conversion measurement (Pixel and Conversions API in
 * utils/metaCapi.js) is not an action and is unaffected.
 * scripts/test_meta_read_only.js holds the whole codebase to this.
 */
const PROHIBITED_ACTION_PATTERNS = [
  /meta/i,
  /facebook/i,
  /instagram/i,
  /(^|_)(fb|ig|ig_|meta)(_|$)/i,
  /boost|promote_?post|sponsor/i,
  /ad_?set/i,
  /ad_?account/i,
  /(^|_)ads?(_|$)/i,
  /google_?ads/i,
  /campaign_?(budget|bid)/i,
];
const PROHIBITED_FIELDS = /meta|facebook|instagram|ad set|ad account|advertis/i;

function assertNotAdvertising(def) {
  const text = `${def.type} ${def.label} ${def.description}`;
  if (PROHIBITED_ACTION_PATTERNS.some((re) => re.test(def.type)) || PROHIBITED_FIELDS.test(text)) {
    throw new Error(
      `Growth action "${def.type}" touches advertising. Ad platforms are read-only for the growth system, permanently (the agency manages them).`
    );
  }
}

function rank(mode) {
  const index = MODES.indexOf(mode);
  if (index < 0) throw new Error(`Unknown growth mode: ${mode}`);
  return index;
}

/** The lower of two modes. */
function clampMode(mode, ceiling) {
  return rank(mode) <= rank(ceiling) ? mode : ceiling;
}

function defineAction(def) {
  const required = ["type", "label", "description", "riskTier", "defaultMode", "maxMode", "execute"];
  for (const key of required) {
    if (def[key] === undefined || def[key] === null) {
      throw new Error(`Growth action definition is missing ${key}`);
    }
  }
  if (!RISK_TIERS.includes(def.riskTier)) throw new Error(`Bad risk tier for ${def.type}`);
  rank(def.defaultMode);
  rank(def.maxMode);
  if (rank(def.defaultMode) > rank(def.maxMode)) {
    throw new Error(`${def.type}: defaultMode is above maxMode`);
  }
  // High-risk actions are never unattended, whatever a definition asks for.
  if (def.riskTier === "high" && rank(def.maxMode) > rank("supervised")) {
    throw new Error(`${def.type}: a high-risk action cannot have maxMode above supervised`);
  }
  assertNotAdvertising(def);
  if (definitions.has(def.type)) throw new Error(`Growth action ${def.type} is defined twice`);

  definitions.set(
    def.type,
    Object.freeze({
      promoteAfter: null,
      limits: {},
      approvalTtlMs: 3 * 24 * 60 * 60 * 1000,
      verifyAfterMs: 10 * 60 * 1000,
      maxAttempts: 3,
      validate: (payload) => payload,
      describe: () => def.label,
      subjectOf: () => ({ entityType: null, entityId: null }),
      verify: null,
      rollback: null,
      ...def,
    })
  );
  return definitions.get(def.type);
}

function getDefinition(type) {
  return definitions.get(type) || null;
}

function listDefinitions() {
  return [...definitions.values()];
}

/** Test helper: forget definitions registered by a test. */
function _unregister(type) {
  definitions.delete(type);
}

module.exports = {
  MODES,
  PROHIBITED_ACTION_PATTERNS,
  assertNotAdvertising,
  RISK_TIERS,
  clampMode,
  defineAction,
  getDefinition,
  listDefinitions,
  rank,
  _unregister,
};
