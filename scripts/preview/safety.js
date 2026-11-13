/**
 * Safety guards for the local Admin preview stack (scripts/preview/start.js).
 *
 * Two layers, both required:
 *
 *   1. assertSafeEnv(env) refuses to start when the environment looks live:
 *      a non-local MongoDB anywhere in env, a Stripe live/restricted key, or any
 *      Twilio, SES SMTP, Anthropic, GoHighLevel, OpenAI, Meta, Google, Adobe or
 *      other provider credential. The preview never needs any of them, so their
 *      presence means someone is pointing the preview at the real world.
 *
 *   2. installNetworkGuard() makes outbound network traffic impossible: every
 *      TCP/TLS socket, every DNS lookup and every global fetch to a host that is
 *      not loopback is refused and logged as "[preview blocked]". This sits under
 *      the module-level fakes, so a fake that is missed still cannot reach a
 *      provider.
 *
 * Nothing here reads or prints a credential value; only variable NAMES are
 * reported.
 */

const net = require("net");
const dns = require("dns");

/** Variables that hold provider credentials. Present and non-empty = refuse. */
const FORBIDDEN_CREDENTIALS = [
  /^TWILIO_/,
  /^AWS_SES_SMTP_(USER|PASS)$/,
  /^SES_/,
  /^ANTHROPIC_/,
  /^CLAUDE_API_KEY$/,
  /^GHL_/,
  /^GOHIGHLEVEL_/,
  /^OPENAI_/,
  /^META_CAPI_TOKEN$/,
  /^META_ADS_ACCESS_TOKEN$/,
  /^FB_ACCESS_TOKEN$/,
  /^GSC_(SERVICE|EXTERNAL)_ACCOUNT_JSON$/,
  /^DATAFORSEO_/,
  /^ADOBE_SIGN_(CLIENT_SECRET|REFRESH_TOKEN|INTEGRATION_KEY)$/,
  /^GOOGLE_PLACES_API_KEY$/,
  /^GOOGLE_MAPS_API_KEY$/,
  /^INDEXNOW_KEY$/,
  /^SENDGRID_/,
  /^MAILGUN_/,
];

/** Generic AWS credentials are scrubbed (not refused): the preview fakes AWS entirely. */
const SCRUBBED_AWS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1", ""]);

function isLocalHost(host) {
  const h = String(host == null ? "localhost" : host).trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (LOCAL_HOSTS.has(h)) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (h.endsWith(".localhost")) return true;
  return false;
}

/** Hosts named in a mongodb:// connection string. */
function mongoHosts(uri) {
  const match = String(uri).match(/^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/i);
  if (!match) return [];
  return match[1].split(",").map((part) => part.replace(/:\d+$/, "").replace(/^\[|\]$/g, ""));
}

/**
 * @returns {{ ok: boolean, problems: string[], scrub: string[] }}
 * problems name the variable and the rule, never the value.
 */
function checkEnv(env = process.env) {
  const problems = [];
  const scrub = [];
  for (const [name, raw] of Object.entries(env)) {
    const value = String(raw == null ? "" : raw).trim();
    if (!value) continue;

    if (/\b(sk|rk)_live_/i.test(value)) {
      problems.push(`${name} holds a Stripe LIVE key (sk_live/rk_live)`);
    }
    if (/mongodb\+srv:\/\//i.test(value)) {
      problems.push(`${name} points at a remote MongoDB (mongodb+srv://)`);
    } else if (/mongodb:\/\//i.test(value)) {
      const remote = mongoHosts(value.slice(value.search(/mongodb:\/\//i))).filter((host) => !isLocalHost(host));
      if (remote.length) problems.push(`${name} points at a non-local MongoDB host`);
    }
    if (FORBIDDEN_CREDENTIALS.some((rule) => rule.test(name))) {
      problems.push(`${name} is a provider credential; the preview must run without it`);
    }
    if (SCRUBBED_AWS.includes(name)) scrub.push(name);
  }
  for (const name of ["MONGO_URI", "MONGODB_URI", "DATABASE_URL"]) {
    const value = String(env[name] || "").trim();
    if (value && !/^mongodb:\/\//i.test(value) && !/^mongodb\+srv:\/\//i.test(value)) {
      problems.push(`${name} is set to something that is not a local mongodb:// URI`);
    }
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)], scrub };
}

class UnsafeEnvironmentError extends Error {
  constructor(problems) {
    super(
      "Refusing to start the preview: the environment looks live.\n  - " +
        problems.join("\n  - ") +
        "\nUnset these in this shell (the preview sets its own fake values) and start again."
    );
    this.name = "UnsafeEnvironmentError";
    this.code = "PREVIEW_UNSAFE_ENV";
    this.problems = problems;
  }
}

function assertSafeEnv(env = process.env) {
  const result = checkEnv(env);
  if (!result.ok) throw new UnsafeEnvironmentError(result.problems);
  return result;
}

/* ------------------------------------------------------------------ */
/* Network guard                                                        */
/* ------------------------------------------------------------------ */

const blocked = [];
let installed = false;

function callerHint() {
  const lines = String(new Error().stack || "").split("\n").slice(2);
  const frame = lines.find(
    (line) => !/node:|internal\/|scripts[\\/]preview[\\/]safety|node_modules[\\/](undici|node-fetch|nodemailer|@smithy|@aws-sdk|stripe|mongodb)/.test(line)
  );
  return frame ? frame.trim().replace(/^at\s+/, "").slice(0, 160) : "";
}

function recordBlocked(via, host, port, log) {
  const entry = { at: new Date().toISOString(), via, host: String(host || ""), port: port == null ? null : Number(port) || port, caller: callerHint() };
  blocked.push(entry);
  if (blocked.length > 500) blocked.shift();
  log(`[preview blocked] outbound ${via} to ${entry.host}${entry.port ? ":" + entry.port : ""}${entry.caller ? "  (" + entry.caller + ")" : ""}`);
  return entry;
}

function blockedError(host, port) {
  const error = new Error(`[preview] outbound network is disabled (${host}${port ? ":" + port : ""})`);
  error.code = "PREVIEW_NETWORK_BLOCKED";
  error.errno = "PREVIEW_NETWORK_BLOCKED";
  return error;
}

/** Host/port of a Socket#connect call, however it was invoked. */
function connectTarget(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // net.connect passes pre-normalized [options, cb]
  if (first && typeof first === "object") {
    if (first.path) return { pipe: true };
    return { host: first.host == null ? "localhost" : first.host, port: first.port };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { pipe: true };
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: first };
}

function installNetworkGuard({ log = console.log } = {}) {
  if (installed) return { blocked };
  installed = true;

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const target = connectTarget(args);
    if (!target.pipe && !isLocalHost(target.host)) {
      recordBlocked("socket", target.host, target.port, log);
      const error = blockedError(target.host, target.port);
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return originalConnect.apply(this, args);
  };

  const originalLookup = dns.lookup;
  dns.lookup = function guardedLookup(hostname, options, callback) {
    if (!isLocalHost(hostname)) {
      const cb = typeof options === "function" ? options : callback;
      recordBlocked("dns", hostname, null, log);
      const error = blockedError(hostname);
      error.code = "ENOTFOUND";
      if (typeof cb === "function") process.nextTick(() => cb(error));
      return {};
    }
    return originalLookup.apply(this, arguments);
  };
  if (dns.promises && dns.promises.lookup) {
    const originalPromiseLookup = dns.promises.lookup;
    dns.promises.lookup = async function guardedPromiseLookup(hostname, ...rest) {
      if (!isLocalHost(hostname)) {
        recordBlocked("dns", hostname, null, log);
        const error = blockedError(hostname);
        error.code = "ENOTFOUND";
        throw error;
      }
      return originalPromiseLookup.call(this, hostname, ...rest);
    };
  }

  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function guardedFetch(input, init) {
      let url;
      try {
        url = new URL(typeof input === "string" ? input : input?.url || String(input));
      } catch {
        return originalFetch(input, init);
      }
      if (!["http:", "https:"].includes(url.protocol) || !isLocalHost(url.hostname)) {
        recordBlocked("fetch", url.hostname, url.port || (url.protocol === "https:" ? 443 : 80), log);
        throw new TypeError("fetch failed", { cause: blockedError(url.hostname, url.port) });
      }
      return originalFetch(input, init);
    };
  }

  return { blocked };
}

function blockedAttempts() {
  return blocked.slice();
}

module.exports = {
  FORBIDDEN_CREDENTIALS,
  SCRUBBED_AWS,
  UnsafeEnvironmentError,
  assertSafeEnv,
  blockedAttempts,
  checkEnv,
  connectTarget,
  installNetworkGuard,
  isLocalHost,
};
