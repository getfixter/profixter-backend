/**
 * Change Order document constants.
 *
 * Kept separate from premiumIslandHomesContract.js so contract terms stay
 * untouched, but the company block is imported from there so both document
 * families always print identical company details.
 */

const { COMPANY_INFO } = require("./premiumIslandHomesContract");

/**
 * Lifecycle. Deliberately limited to states the system can actually observe:
 * "Viewed" is included because Acrobat Sign reports a viewed event, but no
 * status exists here that a provider cannot confirm.
 */
const CHANGE_ORDER_STATUSES = Object.freeze([
  "Draft",
  "Ready to Send",
  "Sent",
  "Viewed",
  "Awaiting Signature",
  "Partially Signed",
  "Executed",
  "Declined",
  "Voided",
]);

const SCHEDULE_IMPACT_TYPES = Object.freeze(["none", "add_days", "reduce_days", "custom"]);

const CHANGE_ORDER_TERMS_VERSION = "PIH-CO-2026-001";

/**
 * Survival clause. Mirrors the language already used in the contract's change
 * order provisions so both documents stay consistent.
 */
const CHANGE_ORDER_SURVIVAL_CLAUSE =
  "Except as expressly modified by this Change Order, all terms, conditions, and provisions of " +
  "the original Agreement referenced above remain unchanged and in full force and effect. This " +
  "Change Order is not valid until signed by both parties.";

const CHANGE_ORDER_AUTHORIZATION_CLAUSE =
  "The undersigned acknowledge and agree to the changes in scope, price, and schedule described " +
  "in this Change Order, and authorize Premium Island Homes Inc. to proceed accordingly.";

module.exports = {
  COMPANY_INFO,
  CHANGE_ORDER_STATUSES,
  CHANGE_ORDER_TERMS_VERSION,
  CHANGE_ORDER_SURVIVAL_CLAUSE,
  CHANGE_ORDER_AUTHORIZATION_CLAUSE,
  SCHEDULE_IMPACT_TYPES,
};
