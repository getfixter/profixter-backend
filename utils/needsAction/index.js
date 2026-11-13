/**
 * Needs action: one list of what somebody should look at, built from
 * collectors. Works without AI (owner decision Q-7).
 *
 * Every file in ./collectors exports
 *   { key, order, permission, collect: async ({ accessUser, now, limit, req }) => ({ count, items }) }
 * with items shaped { id, kind, title, subtitle, reason, severity: "attention"|"problem", href, at }.
 *
 * The directory is scanned, so a track adding collectors/members.js or
 * collectors/projects.js needs no change here. A collector the caller lacks
 * permission for is skipped; one that fails is reported as failed without
 * hiding the others; items are deduplicated by kind + id.
 */
const fs = require("fs");
const path = require("path");
const { effectiveRole, permissionsForUser } = require("../../middleware/authorize");

const COLLECTOR_DIR = path.join(__dirname, "collectors");
const DEFAULT_LIMIT = 25;

function loadCollectors(dir = COLLECTOR_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".js"))
    .sort()
    .map((file) => require(path.join(dir, file)))
    .filter((c) => c && typeof c.collect === "function" && c.key)
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

/** A request-shaped access object for an account, as the auth middleware builds it. */
function accessFor(user) {
  return { accessUser: user, accessRole: effectiveRole(user), permissions: permissionsForUser(user) };
}

function allowed(access, permission) {
  if (!permission) return true;
  return access.accessRole === "admin" || access.permissions.includes(permission);
}

async function collectNeedsAction({ accessUser, now = new Date(), limit = DEFAULT_LIMIT, collectors = loadCollectors() } = {}) {
  const access = accessFor(accessUser);
  const sections = [];
  const seen = new Set();
  const items = [];
  for (const collector of collectors) {
    if (!allowed(access, collector.permission)) continue;
    try {
      const result = await collector.collect({ accessUser, now, limit, req: access });
      const own = [];
      for (const item of result?.items || []) {
        const id = `${item.kind}:${item.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        own.push(item);
        items.push({ ...item, section: collector.key });
      }
      sections.push({ key: collector.key, count: Number(result?.count) || 0, items: own });
    } catch (error) {
      console.error(`needs-action collector ${collector.key} failed:`, error.message);
      sections.push({ key: collector.key, count: null, items: [], error: { code: "COLLECTOR_FAILED", message: "This section could not be loaded." } });
    }
  }
  const rank = { problem: 0, attention: 1 };
  items.sort((a, b) => (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2) || new Date(a.at || 0) - new Date(b.at || 0));
  return {
    generatedAt: now.toISOString(),
    total: sections.reduce((sum, s) => sum + (Number(s.count) || 0), 0),
    sections,
    items,
  };
}

module.exports = { accessFor, collectNeedsAction, loadCollectors };
