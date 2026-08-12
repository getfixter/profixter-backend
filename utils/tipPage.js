/**
 * Where the tip page lives.
 *
 * Its own module, with no dependencies, because two very different places need
 * the same answer: the code that builds the link (utils/fixterTips) and the
 * email template that has to decide whether a link it was handed is really
 * ours (utils/customerEmailTemplates). One definition means the check and the
 * value can never drift apart and start rejecting our own links.
 *
 * Derived from CLIENT_URL, which is already the customer site everywhere else,
 * so a QA stack works without another environment variable. TIP_PAGE_URL exists
 * only to point a stack somewhere unusual.
 *
 * Deliberately unrelated to TIP_LINK. That variable still holds the old static
 * Stripe Payment Link and is read by the legacy completion template only; the
 * production cutover replaces it, and nothing here depends on when that happens.
 */

function tipPageUrl() {
  const base =
    process.env.TIP_PAGE_URL ||
    `${String(process.env.CLIENT_URL || "https://www.profixter.com").replace(/\/+$/, "")}/tip`;
  return String(base).replace(/\/+$/, "");
}

/**
 * A tip link we are willing to put in front of a customer.
 *
 * Exact page or exact page with a query string, nothing else. A tip email is a
 * message someone opens with a card in hand, so a link that is not provably our
 * own is replaced with the plain tip page rather than followed.
 */
function safeTipUrl(value) {
  const page = tipPageUrl();
  const url = String(value || "").trim();
  if (!url) return page;
  if (url === page) return url;
  if (url.startsWith(`${page}?`)) return url;
  return page;
}

module.exports = { tipPageUrl, safeTipUrl };
