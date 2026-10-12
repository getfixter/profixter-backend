/**
 * Google Business Profile posting, through GoHighLevel's Social Planner -
 * the ONLY outward channel the Kingdom may publish to on its own.
 *
 * Narrowed to one account: the Google Business Profile location connected in
 * the Social Planner (platform "google"). The account is looked up live before
 * every post and refused unless it is exactly one active, unexpired Google
 * account - the Facebook Page and Instagram profile connected beside it can
 * never be addressed from here (the owner's rule: no autonomous posts or
 * comments there; Meta advertising belongs to the agency).
 *
 * Reads: the connected accounts, one post's status, the posting user.
 * Writes: create ONE standard post; delete a post this system created (rollback).
 * No contacts, conversations, customers or any ProFixter data go to GoHighLevel.
 *
 * Credentials: GHL_SOCIAL_TOKEN - its own Private Integration token with only
 * socialplanner/account.readonly, socialplanner/post.readonly,
 * socialplanner/post.write and users.readonly - from the secret store
 * (/profixter/prod/GHL_SOCIAL_TOKEN). Deliberately NOT GHL_API_TOKEN, so the
 * legacy value on the server can never stand in for it. Never logged.
 */
const BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";
const DEFAULT_LOCATION = "C4ISs8oCGLSEJkP2hCOt";
const PLATFORM = "google";

function config(env = process.env) {
  const token = env.GHL_SOCIAL_TOKEN || "";
  return { token, locationId: env.GHL_LOCATION_ID || DEFAULT_LOCATION, userId: env.GHL_SOCIAL_USER_ID || "", configured: Boolean(token) };
}

class SocialError extends Error {
  constructor(message, status, permanent = false) {
    super(message);
    this.status = status;
    this.permanent = permanent;
  }
}

let fetchImpl = (...args) => globalThis.fetch(...args);
function setFetchForTests(fn) {
  fetchImpl = fn || ((...args) => globalThis.fetch(...args));
}

async function call(method, path, { query, body, env = process.env } = {}) {
  const { token } = config(env);
  if (!token) throw new SocialError("Google Business Profile posting is not connected (GHL_SOCIAL_TOKEN is not set)", 0, true);
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const res = await fetchImpl(url.toString(), {
    method,
    headers: { Authorization: `Bearer ${token}`, Version: VERSION, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = String(data?.message || data?.error || text || res.statusText).slice(0, 300);
    // 4xx (bad token, missing scope, bad request) will not fix itself on retry
    throw new SocialError(`Social Planner ${method} ${path.split("/").slice(0, 3).join("/")} failed (${res.status}): ${message}`, res.status, res.status >= 400 && res.status < 500 && res.status !== 429);
  }
  return data;
}

/** The single connected Google Business Profile account - or a clear refusal. */
async function googleBusinessAccount({ env = process.env } = {}) {
  const { locationId } = config(env);
  const data = await call("GET", `/social-media-posting/${locationId}/accounts`, { env });
  const all = data?.results?.accounts || data?.accounts || [];
  const google = all.filter((a) => a.platform === PLATFORM && a.active !== false && !a.deleted && !a.isExpired);
  if (google.length !== 1) {
    throw new SocialError(
      google.length ? "More than one Google Business Profile is connected - the owner must say which one." : "No active Google Business Profile is connected in the Social Planner (reconnect it there).",
      0,
      true
    );
  }
  return { id: google[0].id, name: google[0].name || "Google Business Profile", platform: google[0].platform };
}

/**
 * READ-ONLY connection check (no post, no write): does the token load and
 * authenticate, which accounts are connected, and is exactly one Google
 * Business Profile ready? Facebook/Instagram are listed only to show they are
 * connected but never addressable. The token never appears in the result.
 */
async function connectionCheck({ env = process.env } = {}) {
  const { configured, locationId } = config(env);
  const out = { tokenLoaded: configured, locationId, auth: configured ? null : "no_token", accounts: [], googleBusinessProfile: "not_ready", postableByKingdom: [] };
  if (!configured) return out;
  try {
    const data = await call("GET", `/social-media-posting/${locationId}/accounts`, { env });
    const all = data?.results?.accounts || data?.accounts || [];
    out.auth = "ok";
    out.accounts = all.map((a) => ({ platform: a.platform, name: String(a.name || "").slice(0, 60), active: a.active !== false && !a.deleted, expired: Boolean(a.isExpired) }));
    const google = all.filter((a) => a.platform === PLATFORM && a.active !== false && !a.deleted && !a.isExpired);
    out.googleBusinessProfile = google.length === 1 ? "ready" : google.length ? "more_than_one" : "not_connected_or_expired";
    out.postableByKingdom = google.length === 1 ? [PLATFORM] : [];
  } catch (error) {
    out.auth = "error";
    out.error = String(error.message || error).replace(/pit-[\w-]+/gi, "[redacted]").slice(0, 200);
  }
  return out;
}

async function postingUserId({ env = process.env } = {}) {
  const { locationId, userId } = config(env);
  if (userId) return userId;
  const data = await call("GET", "/users/", { query: { locationId }, env });
  const users = data?.users || [];
  const admin = users.find((u) => String(u.roles?.role || u.role || "").toLowerCase() === "admin") || users[0];
  if (!admin?.id) throw new SocialError("No GoHighLevel user found to post as (set GHL_SOCIAL_USER_ID)", 0, true);
  return admin.id;
}

const idOf = (data) => data?.results?.post?._id || data?.results?.post?.id || data?.results?._id || data?.results?.id || data?.post?._id || data?._id || data?.id || null;

/**
 * Create ONE standard Google Business Profile post with a "Book" button.
 * Scheduled a few minutes ahead (the Social Planner publishes it), so the
 * result can be read back and verified.
 */
async function createGbpPost({ summary, title, url, now = new Date(), env = process.env }) {
  const { locationId } = config(env);
  const account = await googleBusinessAccount({ env });
  if (account.platform !== PLATFORM) throw new SocialError("Refused: only the Google Business Profile account may be posted to", 0, true);
  const userId = await postingUserId({ env });
  const scheduleDate = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  const data = await call("POST", `/social-media-posting/${locationId}/posts`, {
    env,
    body: {
      accountIds: [account.id],
      summary,
      type: "post",
      status: "scheduled",
      scheduleDate,
      userId,
      gmbPostDetails: { gmbEventType: "STANDARD", actionType: "book", url, ...(title ? { title } : {}) },
    },
  });
  const postId = idOf(data);
  if (!postId) throw new SocialError("The Social Planner accepted the request but returned no post id", 0, true);
  return { postId, account: account.name, scheduledFor: scheduleDate };
}

/** What the Social Planner says about a post: status, and any public link it reports. */
async function postStatus(postId, { env = process.env } = {}) {
  const { locationId } = config(env);
  const data = await call("GET", `/social-media-posting/${locationId}/posts/${encodeURIComponent(postId)}`, { env });
  const post = data?.results?.post || data?.post || data?.results || {};
  const link = [post.postUrl, post.publishedUrl, post.permalink, post.url, ...(Array.isArray(post.publishedLinks) ? post.publishedLinks : [])].find((v) => typeof v === "string" && /^https?:\/\//.test(v)) || null;
  return { status: String(post.status || "unknown"), link, error: post.error || post.failedReason || null };
}

async function deletePost(postId, { env = process.env } = {}) {
  const { locationId } = config(env);
  await call("DELETE", `/social-media-posting/${locationId}/posts/${encodeURIComponent(postId)}`, { env });
  return { deleted: postId };
}

module.exports = { PLATFORM, SocialError, config, connectionCheck, createGbpPost, deletePost, googleBusinessAccount, postStatus, setFetchForTests };
