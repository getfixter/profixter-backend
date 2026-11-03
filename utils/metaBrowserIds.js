/*
 * The Meta browser ids (_fbp, _fbc) and the page URL a checkout started on,
 * as the browser sends them in a request body (2026-11-03).
 *
 * www.profixter.com and api.profixter.com are different origins, so the
 * cookies never reach the API; checkouts therefore stamped empty fbp/fbc on
 * every Stripe session and the server conversion lost its click. The browser
 * now sends them. They are only identifiers for Meta matching, so anything
 * that does not look like one is dropped rather than trusted.
 */
const FBP = /^fb\.\d\.\d{10,16}\.\d{1,24}$/;
const FBC = /^fb\.\d\.\d{10,16}\.[\w-]{1,500}$/;
const SITE = /^https:\/\/(www\.)?profixter\.com(\/|$)/;

const pick = (value, pattern) => {
  const v = typeof value === "string" ? value.trim() : "";
  return v && pattern.test(v) ? v : "";
};

/** { fbp, fbc, sourceUrl } from a request body; each "" when absent or malformed. */
function browserIdsFrom(body = {}) {
  return {
    fbp: pick(body?.fbp, FBP),
    fbc: pick(body?.fbc, FBC),
    sourceUrl: pick(body?.sourceUrl, SITE).slice(0, 500),
  };
}

/** The same, as Stripe session metadata keys the webhook reads (empty ones left out). */
function checkoutMetadataFrom(body = {}) {
  const { fbp, fbc, sourceUrl } = browserIdsFrom(body);
  return { ...(fbp ? { fbp } : {}), ...(fbc ? { fbc } : {}), ...(sourceUrl ? { source_url: sourceUrl } : {}) };
}

module.exports = { browserIdsFrom, checkoutMetadataFrom };
