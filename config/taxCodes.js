/**
 * Stripe product tax codes this backend sends explicitly.
 *
 * ADDITIONAL_WORK is the code for "Charge extra" work marked taxable. It is
 * EMPTY on purpose: which Stripe tax code describes Profixter's repair and
 * maintenance labor (and whether NY taxes a given job) is a decision for the
 * owner's accountant, not something to infer. Until it is set, taxable extras
 * are refused with TAX_CODE_NOT_CONFIGURED (utils/extraCharges/tax.js), and
 * capital-improvement / exempt extras still work.
 *
 * Set it here (a code default: the EB environment is at its 4096-character
 * limit) or with STRIPE_TAX_CODE_ADDITIONAL_WORK, which wins when present.
 * Use a code from https://docs.stripe.com/tax/tax-codes, never a guess.
 */
module.exports = Object.freeze({
  ADDITIONAL_WORK: "",
});
