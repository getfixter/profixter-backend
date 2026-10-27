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
  } catch (error) {
    out.auth = "error";
    out.error = redact(error.message || error);
    return out;
  }
  /*
   * A post also needs the GoHighLevel user it is made as. Checking only the
   * accounts could say "ready" while every real post failed at this step, so
   * the user lookup is part of "ready" now - still read-only.
   */
  try {
    await postingUserId({ env });
    out.postingUser = "ok";
  } catch (error) {
    out.postingUser = "error";
    out.error = redact(error.message || error);
  }
  out.postableByKingdom = out.googleBusinessProfile === "ready" && out.postingUser === "ok" ? [PLATFORM] : [];
  if (out.googleBusinessProfile === "ready" && out.postingUser !== "ok") out.googleBusinessProfile = "no_posting_user";
  return out;
}

function redact(message) {
  return String(message).replace(/pit-[\w-]+/gi, "[redacted]").slice(0, 200);
}

/**
 * The GoHighLevel user posts are made as (required for Google posts).
 * GHL_SOCIAL_USER_ID wins - set it and nothing is looked up. Otherwise the
 * location's users are read and an admin is chosen; any failure says exactly
 * which step broke and how to fix it, and never retries (it will not fix itself).
 */
async function postingUserId({ env = process.env } = {}) {
  const { locationId, userId } = config(env);
  if (userId) return userId;
  let data;
  try {
    data = await call("GET", "/users/", { query: { locationId }, env });
  } catch (error) {
    throw new SocialError(`Could not read the GoHighLevel users to post as (${error.message}). Set GHL_SOCIAL_USER_ID to the posting user's id.`, error.status || 0, true);
  }
  const users = data?.users || [];
  const admin = users.find((u) => String(u.roles?.role || u.role || "").toLowerCase() === "admin") || users[0];
  if (!admin?.id) throw new SocialError("No GoHighLevel user found to post as (set GHL_SOCIAL_USER_ID)", 0, true);
  return admin.id;
}

const idOf = (data) => data?.results?.post?._id || data?.results?.post?.id || data?.results?._id || data?.results?.id || data?.post?._id || data?._id || data?.id || null;

/*
 * The 2026-10-15 post was refused (422): "media must be an array with media
 * objects or an empty array, Schedule Date must be after current date in ISO
 * format". The body had no media field at all, and the date was 5 minutes
 * after the sweep's start time. Now media is always an array (empty: a text
 * post with a Book button), and the date is taken from the clock at the moment
 * of the request, a safe margin ahead, in GoHighLevel's documented UTC form
 * ("2024-01-15T10:00:00Z", no milliseconds).
 */
const SCHEDULE_LEAD_MS = 15 * 60 * 1000;
const MEDIA_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/gif", "video/mp4", "video/mov", "video/webm"];

/** UTC, whole seconds: 2026-10-27T14:05:00Z. Rounded UP to the next minute. */
function scheduleDateFrom(now = new Date(), clock = Date.now) {
  const from = Math.max(now.getTime(), clock());
  const at = Math.ceil((from + SCHEDULE_LEAD_MS) / 60000) * 60000;
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The exact Create Post body, checked against GoHighLevel's schema before it leaves. */
function gbpPostBody({ accountId, userId, summary, title, url, media = [], scheduleDate }) {
  const body = {
    accountIds: [accountId],
    summary,
    media: media.map((m) => ({ url: String(m.url), type: String(m.type) })),
    type: "post",
    status: "scheduled",
    scheduleDate,
    userId,
    gmbPostDetails: { gmbEventType: "STANDARD", actionType: "book", url, ...(title ? { title } : {}) },
  };
  const bad = gbpPostBodyProblems(body);
  if (bad.length) throw new SocialError(`Refused before sending: ${bad.join(" ")}`, 0, true);
  return body;
}

function gbpPostBodyProblems(body, now = Date.now()) {
  const out = [];
  if (!Array.isArray(body.accountIds) || body.accountIds.length !== 1 || !body.accountIds[0]) out.push("Exactly one account id.");
  if (!Array.isArray(body.media)) out.push("media must be an array.");
  else if (body.media.some((m) => !m || typeof m !== "object" || !/^https:\/\//.test(m.url) || !MEDIA_TYPES.includes(m.type))) out.push("Each media item needs an https url and a supported type.");
  if (!String(body.summary || "").trim() && !(body.media || []).length) out.push("Text or media is required.");
  if (String(body.summary || "").length > 1500) out.push("Google allows 1500 characters.");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(body.scheduleDate || ""))) out.push("scheduleDate must be UTC ISO, e.g. 2026-10-27T14:05:00Z.");
  else if (Date.parse(body.scheduleDate) - now < 5 * 60 * 1000) out.push("scheduleDate must be at least 5 minutes in the future.");
  if (body.type !== "post" || body.status !== "scheduled") out.push("A scheduled standard post only.");
  if (!body.userId) out.push("userId is required.");
  if (body.gmbPostDetails?.gmbEventType !== "STANDARD") out.push("gmbEventType STANDARD.");
  return out;
}

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
  const scheduleDate = scheduleDateFrom(now);
  const data = await call("POST", `/social-media-posting/${locationId}/posts`, {
    env,
    body: gbpPostBody({ accountId: account.id, userId, summary, title, url, scheduleDate }),
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

module.exports = { PLATFORM, SocialError, config, connectionCheck, createGbpPost, deletePost, gbpPostBody, gbpPostBodyProblems, googleBusinessAccount, postStatus, scheduleDateFrom, setFetchForTests };
