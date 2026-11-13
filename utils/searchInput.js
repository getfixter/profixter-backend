/**
 * List filters from a POST body, shaped like a query string.
 *
 * The admin log searches take free text in a POST body so it stays out of
 * URLs and access logs; the old GET routes keep reading req.query. The list
 * code was written for query-string values (always strings), so a body is
 * reduced to the same shape: strings, numbers and booleans become strings,
 * anything else (objects, arrays, null) is dropped. That keeps an operator
 * object such as {"$ne": ""} from reaching a Mongo filter.
 */
function bodySearchInput(body) {
  const out = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return out;
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = String(value);
    else if (typeof value === "boolean") out[key] = String(value);
  }
  return out;
}

module.exports = { bodySearchInput };
