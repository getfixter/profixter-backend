const express = require("express");
const auth = require("../middleware/auth");
const { requirePermission, hasPermission, PERMISSIONS } = require("../middleware/authorize");
const { buildOverview, buildList, buildMap, clearOverviewCache, AGENCY_FEES_KEY } = require("../utils/analytics/overview");
const { adSpendStatus, syncMetaAdSpend } = require("../utils/analytics/metaAdSpend");
const { createAdminActivityLog } = require("../utils/adminActivityLog");

/**
 * Admin Overview: the business numbers, their drill-down lists and the
 * customer map.
 *
 * Gated by permission, not by role: the owner can give an employee Overview
 * (ANALYTICS_READ) and, separately, the Customer Map (ANALYTICS_MAP) without
 * giving them anything else. Every response is per-request private data:
 * never cached by a browser or a proxy.
 */
const router = express.Router();

router.use(auth, requirePermission(PERMISSIONS.ANALYTICS_READ));
router.use((req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
});

const params = (q) => ({
  range: String(q.range || "30d"),
  from: q.from ? String(q.from) : undefined,
  to: q.to ? String(q.to) : undefined,
});

router.get("/", async (req, res) => {
  try {
    res.json(await buildOverview(params(req.query)));
  } catch (error) {
    console.error("Overview failed:", error);
    res.status(500).json({ message: "Overview is temporarily unavailable." });
  }
});

router.get("/list", async (req, res) => {
  try {
    const list = await buildList({
      ...params(req.query),
      metric: String(req.query.metric || ""),
      param: req.query.param ? String(req.query.param).slice(0, 200) : undefined,
    });
    /*
     * Overview access is not customer access. The drill-down shows who (a name
     * and a town) but a customer's email only goes to someone who may also
     * open their record in All Users.
     */
    if (hasPermission(req, PERMISSIONS.CUSTOMERS_MANAGE)) return res.json(list);
    return res.json({ ...list, rows: (list.rows || []).map(({ email, ...row }) => row) });
  } catch (error) {
    console.error("Overview list failed:", error);
    res.status(500).json({ message: "This list is temporarily unavailable." });
  }
});

/*
 * Meta ad spend sync: its configuration and last runs (never the token), and
 * a "sync now" that respects the same cross-instance lease as the schedule.
 * The sync answers within a few seconds normally; a first 90-day backfill may
 * take longer, so after 20s the request returns 202 and the run carries on.
 */
router.get("/ad-spend/status", async (req, res) => {
  try {
    res.json(await adSpendStatus());
  } catch (error) {
    console.error("Ad spend status failed:", error.message);
    res.status(500).json({ message: "Ad spend status is temporarily unavailable." });
  }
});

router.post("/ad-spend/sync", async (req, res) => {
  try {
    await createAdminActivityLog(req, {
      action: "Meta Ad Spend Sync Requested",
      entityType: "analytics",
      entityId: "meta-ad-spend",
      entityName: "Meta ad spend",
      details: {},
    }).catch((error) => console.warn("Ad spend sync log failed:", error.message));
    const run = syncMetaAdSpend();
    const timedOut = Symbol("timeout");
    let timer;
    const result = await Promise.race([run, new Promise((resolve) => (timer = setTimeout(() => resolve(timedOut), 20000)))]);
    clearTimeout(timer);
    if (result === timedOut) return res.status(202).json({ running: true, status: await adSpendStatus() });
    if (result?.skipped) return res.status(202).json({ running: true, skipped: "another instance is syncing", status: await adSpendStatus() });
    clearOverviewCache();
    return res.json({ running: false, status: await adSpendStatus() });
  } catch (error) {
    console.error("Ad spend sync failed:", error.message);
    res.status(500).json({ message: "Ad spend sync is temporarily unavailable." });
  }
});

/* Customer locations are their own permission: analytics access alone is not enough. */
/*
 * The agency's monthly fee, so the Overview can show an all-in acquisition
 * cost next to Meta's spend. Read by anyone who can see the Overview; set
 * only by the owner. One value per calendar month (YYYY-MM), in cents; null
 * removes it. Kept in AnalyticsState "agency-fees" as { months: { "2026-10":
 * { cents, note, setAt, setBy } } }.
 */
router.get("/agency-fees", async (req, res) => {
  try {
    const AnalyticsState = require("../models/AnalyticsState");
    const doc = await AnalyticsState.findOne({ key: AGENCY_FEES_KEY }).lean();
    const months = doc?.value?.months || {};
    res.json({ months: Object.fromEntries(Object.entries(months).map(([m, v]) => [m, { cents: v.cents, note: v.note || "", setAt: v.setAt || null }])) });
  } catch (error) {
    console.error("Agency fees read failed:", error.message);
    res.status(500).json({ message: "Agency fees are temporarily unavailable." });
  }
});

router.put("/agency-fees/:month", requirePermission(PERMISSIONS.ADMIN), async (req, res) => {
  try {
    const month = String(req.params.month || "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ message: "Month must be YYYY-MM." });
    const raw = req.body?.cents;
    const clear = raw === null;
    const cents = Number(raw);
    if (!clear && (!Number.isInteger(cents) || cents < 0 || cents > 10000000)) {
      return res.status(400).json({ message: "The fee must be a whole number of cents between 0 and $100,000." });
    }
    const note = String(req.body?.note || "").trim().slice(0, 200);
    const AnalyticsState = require("../models/AnalyticsState");
    const update = clear
      ? { $unset: { [`value.months.${month}`]: "" } }
      : { $set: { [`value.months.${month}`]: { cents, note, setAt: new Date(), setBy: String(req.user?._id || "") } } };
    await AnalyticsState.updateOne({ key: AGENCY_FEES_KEY }, update, { upsert: true });
    await createAdminActivityLog(req, {
      action: clear ? "Agency Fee Removed" : "Agency Fee Set",
      entityType: "analytics",
      entityId: `agency-fee-${month}`,
      entityName: `Agency fee ${month}`,
      details: clear ? { month } : { month, cents, note },
    }).catch((error) => console.warn("Agency fee log failed:", error.message));
    clearOverviewCache();
    res.json({ month, cents: clear ? null : cents, note: clear ? "" : note });
  } catch (error) {
    console.error("Agency fee write failed:", error.message);
    res.status(500).json({ message: "The agency fee could not be saved." });
  }
});

router.get("/map", requirePermission(PERMISSIONS.ANALYTICS_MAP), async (req, res) => {
  try {
    res.json(await buildMap());
  } catch (error) {
    console.error("Overview map failed:", error);
    res.status(500).json({ message: "The customer map is temporarily unavailable." });
  }
});

module.exports = router;
