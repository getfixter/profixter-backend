/**
 * The contracting legal entity, in one place.
 *
 * Renovation agreements, change orders, invoices and the signing ceremony are
 * issued by Premium Island Homes Inc. (owner decision Q-8, 2026-11-12: keep the
 * existing entity). The identity itself still lives in
 * premiumIslandHomesContract.js, because the agreement terms are written
 * around it and versioned with it; this module is the stable import for
 * everything else, so a future change of entity is one edit with one review.
 *
 * Nothing here alters an issued document: signed agreements, executed change
 * orders and sent invoices keep the snapshot and PDF they were issued with.
 */

const {
  COMPANY_INFO,
  CONTRACT_TERMS_SECTIONS,
  CONTRACT_TERMS_VERSION,
} = require("./premiumIslandHomesContract");

const LEGAL_ENTITY = COMPANY_INFO;

/**
 * The workmanship warranty the agreement terms actually grant.
 *
 * Read from the terms text rather than restated, so the project's warranty end
 * date can never promise more (or less) than the signed terms say. If the
 * terms stop defining a warranty in this form, `months` becomes null and no
 * warranty date is derived at all - nothing is invented.
 */
function resolveWorkmanshipWarranty(sections = CONTRACT_TERMS_SECTIONS) {
  const section = (sections || []).find((item) => /workmanship warranty/i.test(item?.title || ""));
  const body = String(section?.body || "");
  const match = body.match(/warrants its workmanship for (one|two|three|\d+) years? from substantial completion/i);
  if (!match) return { months: null, startsAt: null, termsVersion: CONTRACT_TERMS_VERSION, sectionTitle: "" };
  const words = { one: 1, two: 2, three: 3 };
  const years = words[match[1].toLowerCase()] || Number(match[1]);
  return {
    months: Number.isFinite(years) && years > 0 ? years * 12 : null,
    startsAt: "substantial_completion",
    termsVersion: CONTRACT_TERMS_VERSION,
    sectionTitle: section.title,
  };
}

const WORKMANSHIP_WARRANTY = Object.freeze(resolveWorkmanshipWarranty());

/** The warranty end for a substantial-completion date, or null when undefined. */
function warrantyEndsAt(substantialCompletionAt, warranty = WORKMANSHIP_WARRANTY) {
  if (!substantialCompletionAt || !warranty?.months) return null;
  const start = new Date(substantialCompletionAt);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + warranty.months);
  return end;
}

module.exports = {
  LEGAL_ENTITY,
  WORKMANSHIP_WARRANTY,
  resolveWorkmanshipWarranty,
  warrantyEndsAt,
};
