/**
 * The GoHighLevel API, READ-ONLY.
 *
 * Reads: one contact, and a contact search (the postal-mail audience in
 * utils/outreach/audience.js). The conversation poller that searched and read
 * conversations was removed on 2026-11-12.
 * Writes: none. Sending replies, tagging and notes were removed on 2026-11-12
 * when the GoHighLevel reply agent was retired (owner decision Q-6). Nothing
 * in this file can send a message or change a contact.
 *
 * Credentials: GHL_API_TOKEN (a Private Integration token with only the
 * conversations / conversations-message / contacts scopes) from the secret
 * store, and GHL_LOCATION_ID. Never logged.
 */
const BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";

function config(env = process.env) {
  const token = env.GHL_API_TOKEN || "";
  const locationId = env.GHL_LOCATION_ID || "C4ISs8oCGLSEJkP2hCOt";
  return { token, locationId, configured: Boolean(token) };
}

class GhlError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function call(method, path, { query, body, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const { token } = config(env);
  if (!token) throw new GhlError("GHL_API_TOKEN is not configured", 0);
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetchImpl(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: VERSION,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = String(json?.message || json?.error || `HTTP ${res.status}`).split(token).join("[token]");
    throw new GhlError(`GoHighLevel ${method} ${path}: ${msg}`.slice(0, 300), res.status);
  }
  return json;
}

const ghl = {
  config,
  getContact: (contactId, { env, fetchImpl } = {}) => call("GET", `/contacts/${encodeURIComponent(contactId)}`, { env, fetchImpl }),
  /** Read-only contact search (one page). Used to build the postal-mail audience. */
  searchContacts: ({ filters = [], pageLimit = 100, searchAfter, env, fetchImpl } = {}) =>
    call("POST", "/contacts/search", {
      body: { locationId: config(env).locationId, pageLimit, filters, ...(searchAfter ? { searchAfter } : {}) },
      env,
      fetchImpl,
    }),
  /**
   * Read-only conversation history for Communications' import
   * (utils/comms/imports.js). Oldest-active first, so a checkpoint on the last
   * sort value resumes exactly where an interrupted import stopped.
   */
  searchConversations: ({ startAfterDate, limit = 50, env, fetchImpl } = {}) =>
    call("GET", "/conversations/search", {
      query: { locationId: config(env).locationId, limit, sort: "asc", sortBy: "last_message_date", ...(startAfterDate ? { startAfterDate } : {}) },
      env,
      fetchImpl,
    }),
  getMessages: (conversationId, { lastMessageId, limit = 100, type, env, fetchImpl } = {}) =>
    call("GET", `/conversations/${encodeURIComponent(conversationId)}/messages`, { query: { limit, lastMessageId, type }, env, fetchImpl }),
};

module.exports = { BASE, GhlError, ghl };
