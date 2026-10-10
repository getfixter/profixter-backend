/**
 * Business rules for anything an agent drafts that a customer could read.
 *
 * Checked in code, not just asked for in a prompt: a draft that breaks one is
 * refused with the reasons, so the agent rewrites it. The rules come from
 * decisions the owner has already made (memory notes: membership is a pace,
 * Suffolk-only license, free visit is real labor, no discounts without
 * approval).
 */

const RULES = [
  { re: /\bunlimited\b/i, why: 'Never "unlimited" - membership is a pace, not unlimited service.' },
  { re: /\b\d+\s+visits?\s+(per|a|each)\s+month\b/i, why: 'Never "N visits per month" for standard visits - membership is a pace.' },
  { re: /\bvisit credits?\b|\bactive (booking|appointment)s?\b/i, why: '"visit credits" / "active booking" are internal words, never customer copy.' },
  { re: /\bno monthly visit limit\b/i, why: '"no monthly visit limit" reads as unlimited and contradicts the Terms.' },
  { re: /\b(ny|new york) state licen[cs]ed\b|\blicen[cs]ed in nassau\b/i, why: "The license (HI-71484) is Suffolk County only." },
  { re: /\bfree (first )?(visit|inspection)\b[^.]{0,40}\b(inspection|estimate|assessment|quote)\b|\bfree (inspection|estimate|assessment)\b/i, why: "The free first visit is real labor, never an inspection or estimate." },
  { re: /\b(first|only)\b[^.]{0,30}\bhandyman membership\b/i, why: 'Never claim to be the first or only handyman membership on Long Island.' },
  { re: /\bhouseholds?\b/i, why: 'Say "customers", not "households".' },
  { re: /\b\d+\s?%\s?off\b|\bdiscount|\bcoupon|\bpromo(tion)? code|\bon sale\b|\bfree month\b|\bspecial offer\b/i, why: "No discounts or offers: pricing and promotions are owner decisions." },
  { re: /\$\s?\d/, why: "No prices in agent copy: prices change and must come from the live catalogue." },
  { re: /\b(reviews? say|customers say|rated #?1|best in|award)/i, why: "No claimed reviews, ratings or awards in drafted copy." },
  { re: /\b(sms|text message|we'?ll text)\b/i, why: "Email playbooks must not promise texts (marketing SMS consent is separate)." },
];

/** Returns a list of reasons the text breaks the rules (empty = OK). */
function checkCopy(text) {
  const t = String(text || "");
  return RULES.filter((r) => r.re.test(t)).map((r) => r.why);
}

module.exports = { RULES, checkCopy };
