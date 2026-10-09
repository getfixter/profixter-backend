const { buildCommandCenter } = require("./commandCenter");
const { buildOverview } = require("../analytics/overview");

/**
 * A production self-check of the Command Center, readable from the server log.
 *
 * The dashboard needs an owner login to look at, so after each deploy every
 * instance logs, once, the AGGREGATE numbers it would show: counts, rates and
 * statuses only - never a name, email, phone or address. That lets a deploy
 * be verified against independent sources (the public calendar API, Stripe)
 * without anyone handling credentials or customer data.
 */
function pickKpis(o) {
  const k = o?.kpis || {};
  return {
    activeMembers: k.activeMembers?.value ?? null,
    newMembers30d: k.newMembers?.value ?? null,
    newCustomers30d: k.newCustomers?.value ?? null,
    mrrCents: k.mrr?.cents ?? null,
    revenue30dCents: k.revenue?.totalCents ?? null,
    revenueAvailable: k.revenue?.available ?? null,
    freeVisitsBooked30d: k.freeVisits?.booked ?? null,
    freeVisitConversion: k.conversion?.rate ?? null,
    funnel: o?.funnel || null,
    spend: o?.spend ? { connected: o.spend.connected, status: o.spend.status || null } : null,
  };
}

async function runSelfCheck({ now = new Date() } = {}) {
  const [cc, overview] = await Promise.all([
    buildCommandCenter({ now }).catch((e) => ({ error: e.message })),
    buildOverview({ range: "30d", now }).catch((e) => ({ error: e.message })),
  ]);
  const line = {
    event: "growth_self_check",
    at: now.toISOString(),
    engineEnabled: cc.engineEnabled ?? null,
    capacity: cc.capacity
      ? {
          from: cc.capacity.from,
          to: cc.capacity.to,
          capacity: cc.capacity.capacity,
          booked: cc.capacity.booked,
          utilization: cc.capacity.utilization,
          signal: cc.capacity.signal,
          error: cc.capacity.error || null,
        }
      : null,
    queue: cc.queue ? { pending: cc.queue.pending.length, shadow7d: cc.queue.shadow.length, last7Days: cc.queue.last7Days } : null,
    policies: (cc.policies || []).map((p) => ({ type: p.type, mode: p.mode })),
    waitlist: cc.waitlist ? { waiting: cc.waitlist.waiting } : null,
    visibility: cc.visibility
      ? Object.fromEntries(
          ["reviews", "search", "localRank", "aiVisibility"].map((k) => [
            k,
            cc.visibility[k]?.available
              ? k === "reviews"
                ? { total: cc.visibility.reviews.totalNow, rating: cc.visibility.reviews.rating }
                : "available"
              : cc.visibility[k]?.reason || "unavailable",
          ])
        )
      : null,
    alerts: (cc.alerts || []).map((a) => a.key),
    overview: overview.error ? { error: overview.error } : pickKpis(overview),
    errors: [cc.error, overview.error].filter(Boolean),
  };
  console.log(JSON.stringify(line));
  return line;
}

/** Once, ~4 minutes after boot (after the revenue ledger's first sync window). */
function scheduleSelfCheck() {
  if (process.env.NODE_ENV === "test" || process.env.GROWTH_SELF_CHECK === "false") return;
  setTimeout(() => {
    runSelfCheck().catch((error) => console.warn("growth_self_check failed:", error.message));
  }, 4 * 60 * 1000).unref?.();
}

module.exports = { pickKpis, runSelfCheck, scheduleSelfCheck };
