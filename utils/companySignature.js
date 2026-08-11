/**
 * The authorized Premium Island Homes signature image.
 *
 * Applied to every agreement before the customer ever sees it, so the customer
 * signs a document that is already countersigned and there is no second signing
 * ceremony to wait for.
 *
 * SECURITY
 * The asset lives in the same private S3 space as the documents themselves and
 * is fetched server-side at generation time. It is never served by any route,
 * never given a public or signed URL, and never reaches the browser as an
 * image - it only ever exists inside a generated PDF. There is deliberately no
 * endpoint that returns it.
 *
 * If no asset is configured, agreements are still produced: the company block
 * shows the printed name and title with an empty signature rule, exactly as
 * before. Nothing is invented.
 */

const { getObjectBuffer } = require("./s3");

/** Cached in memory: it is small, immutable, and read on every generation. */
let cache = { key: "", buffer: null, fetchedAt: 0 };

const CACHE_TTL_MS = 10 * 60 * 1000;

function configuredKey() {
  return String(process.env.COMPANY_SIGNATURE_S3_KEY || "").trim();
}

function isConfigured() {
  return Boolean(configuredKey());
}

/** Exposed for tests. */
function _resetCache() {
  cache = { key: "", buffer: null, fetchedAt: 0 };
}

/**
 * The signature image, or null when none is configured or it cannot be read.
 * Never throws: a missing signature asset must not stop an agreement being
 * generated.
 */
async function getCompanySignatureImage() {
  const key = configuredKey();
  if (!key) return null;

  if (cache.buffer && cache.key === key && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.buffer;
  }

  try {
    const buffer = await getObjectBuffer({ Key: key });
    if (!buffer || !buffer.length) return null;
    cache = { key, buffer, fetchedAt: Date.now() };
    return buffer;
  } catch (error) {
    console.error("companySignature: could not read the signature asset:", error?.message);
    return null;
  }
}

module.exports = {
  isConfigured,
  getCompanySignatureImage,
  configuredKey,
  _resetCache,
};
