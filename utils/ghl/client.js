/**
 * The GoHighLevel API, narrowed to what the Conversation agent needs.
 *
 * Reads: search conversations, read messages, read one contact.
 * Writes: send ONE reply into an existing conversation, add a tag, add a note.
 * Deliberately absent: bulk sends, workflow enrollment, campaign creation,
 * contact import/deletion, DND changes, calendar or appointment endpoints -
 * the agents never book, never mass-message, never manage the list.
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
  /** Conversations whose last message is inbound, newest first. */
  searchInbound: ({ startAfterDate, limit = 50, env, fetchImpl } = {}) =>
    call("GET", "/conversations/search", {
      query: { locationId: config(env).locationId, lastMessageDirection: "inbound", sort: "desc", sortBy: "last_message_date", limit, startAfterDate },
      env,
      fetchImpl,
    }),
  getMessages: (conversationId, { limit = 20, env, fetchImpl } = {}) =>
    call("GET", `/conversations/${encodeURIComponent(conversationId)}/messages`, { query: { limit }, env, fetchImpl }),
  getContact: (contactId, { env, fetchImpl } = {}) => call("GET", `/contacts/${encodeURIComponent(contactId)}`, { env, fetchImpl }),
  /** Read-only contact search (one page). Used to build the postal-mail audience. */
  searchContacts: ({ filters = [], pageLimit = 100, searchAfter, env, fetchImpl } = {}) =>
    call("POST", "/contacts/search", {
      body: { locationId: config(env).locationId, pageLimit, filters, ...(searchAfter ? { searchAfter } : {}) },
      env,
      fetchImpl,
    }),
  /** One reply in an existing conversation. type: "SMS" | "Email". */
  sendReply: ({ type, contactId, message, subject, html, replyMessageId, env, fetchImpl }) =>
    call("POST", "/conversations/messages", {
      body: {
        type,
        contactId,
        ...(type === "SMS" ? { message } : { subject: subject || "Re: Profixter", html: html || message, message, ...(replyMessageId ? { replyMessageId } : {}) }),
      },
      env,
      fetchImpl,
    }),
  addTag: (contactId, tag, { env, fetchImpl } = {}) =>
    call("POST", `/contacts/${encodeURIComponent(contactId)}/tags`, { body: { tags: [tag] }, env, fetchImpl }),
  addNote: (contactId, body, { env, fetchImpl } = {}) =>
    call("POST", `/contacts/${encodeURIComponent(contactId)}/notes`, { body: { body: String(body).slice(0, 4000) }, env, fetchImpl }),
};

module.exports = { BASE, GhlError, ghl };
