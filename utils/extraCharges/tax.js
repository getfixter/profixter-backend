/**
 * Sales tax on an extra, decided the way invoices already decide it: the owner
 * classifies the work (utils/invoiceValidation TAX_TREATMENTS), nothing is
 * assumed.
 *
 *   "Taxable Repair / Maintenance"       -> Stripe Tax calculates it for the
 *                                           booking's service address (the
 *                                           account's verified Stripe Tax setup).
 *   "Capital Improvement - No Sales Tax"  -> no tax, recorded as the owner's
 *   "Tax Exempt"                            classification.
 *   "Not Determined" (the default)        -> refused: no total can be shown.
 *
 * Taxable work that Stripe returns no tax for (not registered there, product
 * exempt, address it cannot place) is a BLOCKER with Stripe's reason, never a
 * silent $0. The tax code must be named explicitly (config/taxCodes.js or
 * STRIPE_TAX_CODE_ADDITIONAL_WORK): the account default was set up for
 * memberships, and using it for labor would be a guess. Until a code is
 * confirmed, taxable extras are refused with TAX_CODE_NOT_CONFIGURED.
 */
const { TAX_TREATMENTS, TAXABLE_TREATMENT } = require("../invoiceValidation");

const NO_TAX_TREATMENTS = new Set(["Capital Improvement - No Sales Tax", "Tax Exempt"]);

class TaxBlocker extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const REASONS = {
  not_collecting: "Stripe Tax is not collecting tax in this state (no registration), so tax on taxable work cannot be added.",
  not_subject_to_tax: "Stripe says this service is not subject to tax at this address.",
  product_exempt: "Stripe treats this tax code as exempt.",
  product_exempt_holiday: "Stripe treats this as exempt (tax holiday).",
  customer_exempt: "This Stripe customer is marked tax exempt.",
  zero_rated: "Stripe applies a zero rate here.",
  excluded_territory: "Stripe does not tax this territory.",
  jurisdiction_unsupported: "Stripe Tax does not support this jurisdiction.",
};

function taxCodeSetting() {
  return String(process.env.STRIPE_TAX_CODE_ADDITIONAL_WORK || require("../../config/taxCodes").ADDITIONAL_WORK || "").trim();
}

function readTreatment(value) {
  const t = String(value || "").trim();
  return TAX_TREATMENTS.includes(t) ? t : "Not Determined";
}

/**
 * @returns {Promise<{taxCents, treatment, source, calculationId, calculationExpiresAt, taxCode, taxabilityReason, ratePercent}>}
 * @throws TaxBlocker
 */
async function quoteTax({ stripe, subtotalCents, treatment, address, reference }) {
  const t = readTreatment(treatment);
  if (t === "Not Determined") {
    throw new TaxBlocker("TAX_TREATMENT_REQUIRED", "Choose how sales tax applies to this work before charging.");
  }
  if (NO_TAX_TREATMENTS.has(t)) {
    return { taxCents: 0, treatment: t, source: "owner_treatment", calculationId: "", calculationExpiresAt: null, taxCode: "", taxabilityReason: "", ratePercent: "0" };
  }
  if (t !== TAXABLE_TREATMENT) throw new TaxBlocker("TAX_TREATMENT_REQUIRED", "Choose how sales tax applies to this work before charging.");

  if (!address?.line1 || !address?.state || !/^\d{5}/.test(String(address?.zip || ""))) {
    throw new TaxBlocker("TAX_ADDRESS_MISSING", "This visit has no complete service address (street, state and ZIP), so Stripe cannot work out the tax. Add the address to the visit first.");
  }
  const code = taxCodeSetting();
  if (!/^txcd_\d{8}$/.test(code)) {
    throw new TaxBlocker(
      "TAX_CODE_NOT_CONFIGURED",
      "Taxable extras need the Stripe tax code your accountant confirms for this work, and it is not set yet. Nothing was charged. If the work is truly a capital improvement or tax exempt, choose that; otherwise bill it on a project invoice for now."
    );
  }
  let calc;
  try {
    calc = await stripe.tax.calculations.create(
      {
        currency: "usd",
        line_items: [{ amount: subtotalCents, reference: String(reference || "additional_work").slice(0, 200), tax_behavior: "exclusive", tax_code: code }],
        customer_details: {
          address: { line1: address.line1, ...(address.unit ? { line2: address.unit } : {}), city: address.city || undefined, state: address.state, postal_code: String(address.zip).slice(0, 5), country: "US" },
          address_source: "shipping",
        },
        expand: ["line_items"],
      }
    );
  } catch (error) {
    throw new TaxBlocker("TAX_UNAVAILABLE", `Stripe Tax could not calculate the tax (${String(error?.code || error?.message || "error").slice(0, 120)}). Nothing was charged.`);
  }
  const taxCents = Number(calc?.tax_amount_exclusive || 0);
  const breakdown = Array.isArray(calc?.tax_breakdown) ? calc.tax_breakdown : [];
  const reason = String(breakdown.find((b) => b?.taxability_reason)?.taxability_reason || "");
  const rate = String(breakdown.find((b) => Number(b?.amount) > 0)?.tax_rate_details?.percentage_decimal || breakdown[0]?.tax_rate_details?.percentage_decimal || "0");
  const line = calc?.line_items?.data?.[0] || null;
  const usedCode = String(line?.tax_code || code || "");
  if (taxCents <= 0) {
    throw new TaxBlocker(
      "TAX_NOT_COLLECTED",
      `You marked this work taxable, but Stripe Tax returned no tax${reason ? `: ${REASONS[reason] || reason}` : "."} Check the classification or the Stripe Tax setup before charging.`,
      { taxabilityReason: reason, taxCode: usedCode }
    );
  }
  if (Number(calc.amount_total) !== subtotalCents + taxCents) {
    throw new TaxBlocker("TAX_UNAVAILABLE", "Stripe Tax returned a total that does not add up. Nothing was charged.");
  }
  return {
    taxCents,
    treatment: t,
    source: "stripe_tax",
    calculationId: String(calc.id || ""),
    calculationExpiresAt: calc.expires_at ? new Date(Number(calc.expires_at) * 1000) : null,
    taxCode: usedCode,
    taxabilityReason: reason,
    ratePercent: rate,
  };
}

module.exports = { NO_TAX_TREATMENTS, TaxBlocker, quoteTax, readTreatment, taxCodeSetting };
