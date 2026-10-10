/**
 * Secrets from AWS Systems Manager Parameter Store, read with the server's own
 * IAM identity (the EB instance role) - no key in the environment, the shell,
 * the repo or the logs.
 *
 * The owner creates a SecureString parameter in the AWS console under
 * PARAMETER_STORE_PATH (default /profixter/prod/), named after the variable it
 * provides, e.g. /profixter/prod/ANTHROPIC_API_KEY. Only names on the
 * allow-list below are loaded, so a stray parameter cannot override
 * unrelated configuration.
 *
 * Loaded at boot and re-read every 30 minutes, so adding or rotating a secret
 * takes effect without a deploy or restart. Everything that uses these values
 * reads process.env at call time (agent client, Meta reads, Search Console).
 *
 * A variable already set in the EB environment wins over the parameter, so an
 * emergency override stays possible. Logs say which NAMES loaded, never values.
 */

const ALLOWED = new Set([
  "ANTHROPIC_API_KEY",
  "META_ADS_ACCESS_TOKEN",
  "GSC_SERVICE_ACCOUNT_JSON",
  "DATAFORSEO_LOGIN",
  "DATAFORSEO_PASSWORD",
]);
const REFRESH_MS = 30 * 60 * 1000;

const state = { loaded: [], lastLoadAt: null, lastError: null, fromParameterStore: new Set() };

function basePath(env = process.env) {
  const p = String(env.PARAMETER_STORE_PATH || "/profixter/prod/").trim();
  return p.endsWith("/") ? p : `${p}/`;
}

let clientFactory = (region) => {
  const { SSMClient } = require("@aws-sdk/client-ssm");
  return new SSMClient({ region });
};
function setClientFactory(fn) {
  clientFactory = fn;
}

async function loadParameterSecrets({ env = process.env, now = new Date() } = {}) {
  const { GetParametersByPathCommand } = require("@aws-sdk/client-ssm");
  const client = clientFactory(env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1");
  const path = basePath(env);
  const loaded = [];
  try {
    let NextToken;
    do {
      const out = await client.send(new GetParametersByPathCommand({ Path: path, WithDecryption: true, Recursive: false, NextToken }));
      for (const p of out.Parameters || []) {
        const name = String(p.Name || "").slice(path.length);
        if (!ALLOWED.has(name) || typeof p.Value !== "string" || !p.Value) continue;
        // An explicit EB variable wins, unless we set it ourselves on an earlier load (rotation).
        if (env[name] && !state.fromParameterStore.has(name)) continue;
        env[name] = p.Value;
        state.fromParameterStore.add(name);
        loaded.push(name);
      }
      NextToken = out.NextToken;
    } while (NextToken);
    state.loaded = loaded;
    state.lastLoadAt = now;
    state.lastError = null;
  } catch (error) {
    const code = error?.name || error?.Code || "error";
    state.lastError = code === "AccessDeniedException" ? "access_denied (instance role lacks ssm:GetParametersByPath on the path)" : code;
  }
  console.log(JSON.stringify({ event: "parameter_store_loaded", path, names: state.loaded, error: state.lastError }));
  return { loaded: state.loaded, error: state.lastError };
}

function secretsStatus() {
  return { loaded: [...state.fromParameterStore].sort(), lastLoadAt: state.lastLoadAt, lastError: state.lastError, path: basePath() };
}

/** Load once now (awaitable), then keep refreshing. No-op in tests or when disabled. */
function startParameterSecrets() {
  if (process.env.NODE_ENV === "test" || process.env.PARAMETER_STORE_DISABLED === "true") return Promise.resolve(null);
  const first = loadParameterSecrets().catch(() => null);
  setInterval(() => loadParameterSecrets().catch(() => null), REFRESH_MS).unref?.();
  return first;
}

module.exports = { ALLOWED, loadParameterSecrets, secretsStatus, setClientFactory, startParameterSecrets };
