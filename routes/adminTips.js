/**
 * Tips, as the admin and the Fixters see them.
 *
 * WHO SEES WHAT
 * An admin sees every Fixter, every transaction and the unassigned pile. A
 * Fixter sees their own tips and nothing else. That is enforced here by the
 * query, not by the client: the same endpoint answers both, and an employee
 * cannot widen their own scope by asking differently.
 *
 * EVERY FIGURE IS DERIVED
 * Nothing on this route reads a stored total. Pay-period and all-time amounts
 * are summed from Tip records in integer cents on each request (see
 * utils/fixterTips.summarizeTips), so what the payout conversation is based on
 * is always the transactions themselves.
 *
 * PERIODS ARE FRIDAY TO THURSDAY
 * Cheques are written on Friday morning, so a period opens as Friday begins in
 * New York and closes on Thursday night. Admin and Fixter are summarised by the
 * same function, which is what stops the two views disagreeing about a period.
 */

const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const User = require("../models/User");
const Tip = require("../models/Tip");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const { isEligibleFixter, netCents, summarizeTips } = require("../utils/fixterTips");
const { createAdminActivityLog } = require("../utils/adminActivityLog");

const router = express.Router();

/**
 * How many records one request will sum.
 *
 * Tips are low volume, so this is a backstop rather than paging. If it is ever
 * reached the response says so, because a total that quietly omits older tips
 * would look exactly like a correct one.
 */
const TIP_SCAN_LIMIT = 5000;

function clampNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.round(numeric), min), max);
}

function tipDTO(tip) {
  return {
    id: String(tip._id),
    receivedAt: tip.receivedAt,
    amountCents: Number(tip.amountCents || 0),
    refundedCents: Number(tip.refundedCents || 0),
    netCents: netCents(tip),
    currency: tip.currency || "usd",
    status: tip.status,
    refundStatus: tip.refundStatus || "",
    fixterId: tip.fixter ? String(tip.fixter) : "",
    fixterName: tip.fixterNameSnapshot || "",
    fixterPosition: tip.fixterPositionSnapshot || "",
    assignmentStatus: tip.assignmentStatus,
    unassignedReason: tip.unassignedReason || "",
    tipperName: tip.tipperName || "",
    tipperEmail: tip.tipperEmail || "",
    tipperKind: tip.tipperKind || "unknown",
    bookingNumber: tip.bookingNumberSnapshot || "",
    source: tip.source || "direct",
  };
}

function fixterLabel(user) {
  const name =
    String(user.name || "").trim() ||
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.email || "Fixter";
}

router.get("/", auth, ...requirePermission(PERMISSIONS.TIPS_READ), async (req, res) => {
  try {
    const isAdmin = req.accessRole === "admin";
    const periods = clampNumber(req.query.periods ?? req.query.weeks, 8, 1, 26);
    const transactionLimit = clampNumber(req.query.limit, 100, 1, 500);

    const scope = isAdmin ? {} : { fixter: req.accessUser._id };
    const tips = await Tip.find(scope)
      .sort({ receivedAt: -1 })
      .limit(TIP_SCAN_LIMIT)
      .lean();

    const summary = summarizeTips(tips, { periods });
    const byFixterId = new Map(summary.fixters.map((row) => [row.fixterId, row]));

    /*
     * The roster comes from the employee records, not from the tips, so a
     * Fixter who has not been tipped yet still appears with a zero rather than
     * vanishing from the list.
     */
    // `role` is selected because isEligibleFixter reads it below; without it
    // every employee would look ineligible and the assign list would be empty.
    const employees = isAdmin
      ? await User.find({ role: "employee" })
          .select("_id name firstName lastName email role employeePosition isActive")
          .sort({ name: 1 })
          .lean()
      : [req.accessUser];

    const emptyPeriods = Object.fromEntries(summary.periodStarts.map((start) => [start, 0]));
    const fixters = employees.map((employee) => {
      const id = String(employee._id);
      const row = byFixterId.get(id);
      return {
        fixterId: id,
        name: fixterLabel(employee),
        position: employee.employeePosition || "",
        isActive: employee.isActive !== false,
        allTimeCents: row?.allTimeCents || 0,
        currentPeriodCents: row?.currentPeriodCents || 0,
        closingPeriodCents: row?.closingPeriodCents || 0,
        count: row?.count || 0,
        byPeriod: row?.byPeriod || { ...emptyPeriods },
      };
    });

    /*
     * A tip credited to a deleted employee still has to be visible: the money
     * moved, and a ledger that hides rows because a user record went away
     * cannot be reconciled.
     */
    for (const row of summary.fixters) {
      if (fixters.some((entry) => entry.fixterId === row.fixterId)) continue;
      fixters.push({
        fixterId: row.fixterId,
        name: row.name || "Former Fixter",
        position: row.position || "",
        isActive: false,
        allTimeCents: row.allTimeCents,
        currentPeriodCents: row.currentPeriodCents,
        closingPeriodCents: row.closingPeriodCents,
        count: row.count,
        byPeriod: row.byPeriod,
      });
    }

    return res.json({
      scope: isAdmin ? "admin" : "fixter",
      payPeriods: summary.payPeriods,
      currentPeriod: summary.currentPeriod,
      closingPeriod: summary.closingPeriod,
      totals: summary.totals,
      unassignedTotals: isAdmin
        ? summary.unassigned
        : { allTimeCents: 0, currentPeriodCents: 0, closingPeriodCents: 0, count: 0 },
      fixters: fixters.sort((left, right) => right.allTimeCents - left.allTimeCents),
      transactions: tips.slice(0, transactionLimit).map(tipDTO),
      unassigned: isAdmin
        ? tips.filter((tip) => !tip.fixter).map(tipDTO)
        : [],
      assignableFixters: isAdmin
        ? employees
            .filter((employee) => isEligibleFixter(employee))
            .map((employee) => ({
              id: String(employee._id),
              name: fixterLabel(employee),
              position: employee.employeePosition || "",
              isActive: employee.isActive !== false,
            }))
        : [],
      truncated: tips.length >= TIP_SCAN_LIMIT,
    });
  } catch (error) {
    console.error("Failed to load tips:", error);
    return res.status(500).json({ message: "Failed to load tips" });
  }
});

/**
 * Place a tip that arrived without usable context, or correct one that was
 * placed wrongly.
 *
 * Admin only, and recorded in the activity log: moving money between people's
 * ledgers by hand is exactly the kind of action that needs an author.
 */
router.post(
  "/:id/assign",
  auth,
  ...requirePermission(PERMISSIONS.ADMIN),
  async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(404).json({ message: "Tip not found" });
      }
      const tip = await Tip.findById(req.params.id);
      if (!tip) return res.status(404).json({ message: "Tip not found" });

      const rawFixterId = String(req.body?.fixterId || "").trim();
      const previousFixterId = tip.fixter ? String(tip.fixter) : "";

      if (!rawFixterId) {
        tip.fixter = null;
        tip.fixterNameSnapshot = "";
        tip.fixterPositionSnapshot = "";
        tip.assignmentStatus = "unassigned";
        tip.unassignedReason = "Returned to the unassigned list by an admin.";
        tip.assignedAt = new Date();
        tip.assignedBy = req.accessUser._id;
        await tip.save();
      } else {
        if (!mongoose.isValidObjectId(rawFixterId)) {
          return res.status(400).json({ message: "Invalid Fixter" });
        }
        const fixter = await User.findById(rawFixterId)
          .select("_id name firstName lastName role employeePosition isActive")
          .lean();
        if (!isEligibleFixter(fixter)) {
          return res.status(400).json({
            message: "Tips can only be assigned to a Fixter or General Fixter account.",
          });
        }

        tip.fixter = fixter._id;
        tip.fixterNameSnapshot = fixterLabel(fixter);
        tip.fixterPositionSnapshot = fixter.employeePosition || "";
        tip.assignmentStatus = "manually_assigned";
        tip.unassignedReason = "";
        tip.assignedAt = new Date();
        tip.assignedBy = req.accessUser._id;
        await tip.save();
      }

      await createAdminActivityLog(req, {
        action: rawFixterId ? "Tip Assigned" : "Tip Unassigned",
        entityType: "Tip",
        entityId: tip._id,
        entityName: tip.stripePaymentIntentId,
        details: {
          amountCents: tip.amountCents,
          refundedCents: tip.refundedCents,
          previousFixterId,
          newFixterId: tip.fixter ? String(tip.fixter) : "",
          newFixterName: tip.fixterNameSnapshot,
          receivedAt: tip.receivedAt,
        },
      });

      return res.json({ tip: tipDTO(tip.toObject()) });
    } catch (error) {
      console.error("Failed to assign tip:", error);
      return res.status(500).json({ message: "Failed to assign tip" });
    }
  }
);

module.exports = router;
