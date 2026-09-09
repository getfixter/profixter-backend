const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const GiftMembership = require("../models/GiftMembership");
const { giftAccessState } = require("../utils/gifts/giftAccess");
const { configSnapshot } = require("../utils/gifts/giftConfig");
const { formatTermDate } = require("../utils/gifts/giftPricing");
const { issueInvitation } = require("../utils/gifts/giftService");
const { sendGiftInvitation } = require("../utils/gifts/giftEmails");

/**
 * Admin visibility for gift memberships.
 *
 * Shaped like routes/adminSms and routes/adminEmailLogs — same permission,
 * same pagination envelope, same filter style — so it behaves like the screens
 * beside it. A list and a detail view, plus the two operations that genuinely
 * need a human: re-issuing an invitation, and cancelling a gift.
 *
 * Deliberately NOT here: any way to create a gift. Gifts come from confirmed
 * payments, which is what makes the record mean something.
 */

const onlyAdmin = requirePermission(PERMISSIONS.ADMIN);

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Everything an admin needs about one gift, in one shape. */
function present(gift, now = new Date()) {
  const state = giftAccessState(gift, now);
  return {
    id: gift._id,
    giftNumber: gift.giftNumber,

    purchaser: {
      id: gift.purchaser,
      name: gift.purchaserSnapshot?.name || "",
      email: gift.purchaserSnapshot?.email || "",
    },
    recipient: {
      id: gift.recipient,
      name: `${gift.recipientFirstName || ""} ${gift.recipientLastName || ""}`.trim(),
      email: gift.recipientEmail,
      claimed: Boolean(gift.recipient),
    },
    property: {
      addressId: gift.addressId,
      snapshot: gift.addressSnapshot,
      confirmed: Boolean(gift.addressId),
    },

    plan: gift.plan,
    durationMonths: gift.durationMonths,

    status: gift.status,
    /* The temporal state, computed from the dates rather than read from a
     * field a worker maintains — so this screen is right even when the
     * lifecycle sweep is behind. */
    state: state.state,
    active: state.active,

    purchasedAt: gift.purchasedAt,
    invitedAt: gift.invitedAt,
    claimedAt: gift.claimedAt,
    startAt: gift.startAt,
    endAt: gift.endAt,
    activeThrough: gift.endAt ? formatTermDate(gift.endAt) : "",

    payment: {
      amountSubtotalCents: gift.amountSubtotalCents,
      discountCents: gift.discountCents,
      amountPaidCents: gift.amountPaidCents,
      currency: gift.currency,
      promotionCodeId: gift.promotionCodeId || "",
      couponId: gift.couponId || "",
      stripeCheckoutSessionId: gift.stripeCheckoutSessionId,
      stripePaymentIntentId: gift.stripePaymentIntentId,
      stripeChargeId: gift.stripeChargeId,
    },
    refund: {
      status: gift.refundStatus,
      amountRefundedCents: gift.amountRefundedCents,
      lastRefundAt: gift.lastRefundAt,
      refunds: gift.refunds || [],
    },

    invitation: {
      version: gift.claimTokenVersion,
      issuedAt: gift.claimTokenIssuedAt,
      expiresAt: gift.claimTokenExpiresAt,
      reissuedCount: gift.claimTokenReissuedCount,
      /*
       * The link expiring does NOT mean the gift is gone. The two are separate
       * on purpose: a stale credential is a security matter, the money is not.
       * Surfaced as its own flag so the screen can say "link expired, gift
       * intact, re-issue" rather than implying anything was lost.
       */
      linkExpired: Boolean(
        gift.claimTokenExpiresAt && new Date(gift.claimTokenExpiresAt) < now && !gift.recipient
      ),
      reissuable: !gift.recipient && gift.status !== "cancelled",
    },

    cancelledAt: gift.cancelledAt,
    cancelledReason: gift.cancelledReason,
    createdAt: gift.createdAt,
  };
}

/** Feature state, for the admin screen header. */
router.get("/config", auth, ...onlyAdmin, async (_req, res) => {
  try {
    const [total, unclaimed, claimed] = await Promise.all([
      GiftMembership.countDocuments({}),
      GiftMembership.countDocuments({ status: { $in: ["purchased", "invited"] } }),
      GiftMembership.countDocuments({ status: "claimed" }),
    ]);
    return res.json({ config: configSnapshot(), counts: { total, unclaimed, claimed } });
  } catch (error) {
    console.error("GET /admin/gifts/config failed:", error);
    return res.status(500).json({ message: "Failed to load gift configuration" });
  }
});

router.get("/", auth, ...onlyAdmin, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    const query = {};

    for (const field of ["status", "plan", "refundStatus"]) {
      if (req.query[field]) query[field] = String(req.query[field]).trim();
    }
    if (req.query.recipientEmail) {
      query.recipientEmail = String(req.query.recipientEmail).trim().toLowerCase();
    }
    if (req.query.purchaser && mongoose.Types.ObjectId.isValid(String(req.query.purchaser))) {
      query.purchaser = new mongoose.Types.ObjectId(String(req.query.purchaser));
    }

    const search = String(req.query.search || "").trim();
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      query.$or = [
        { giftNumber: regex },
        { recipientEmail: regex },
        { recipientFirstName: regex },
        { recipientLastName: regex },
        { "purchaserSnapshot.name": regex },
        { "purchaserSnapshot.email": regex },
      ];
    }

    const [items, total] = await Promise.all([
      GiftMembership.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      GiftMembership.countDocuments(query),
    ]);

    const now = new Date();
    return res.json({
      items: items.map((gift) => present(gift, now)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error("GET /admin/gifts failed:", error);
    return res.status(500).json({ message: "Failed to load gifts" });
  }
});

router.get("/:id", auth, ...onlyAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid gift id" });
    }
    const gift = await GiftMembership.findById(req.params.id).lean();
    if (!gift) return res.status(404).json({ message: "Gift not found" });
    return res.json({ item: present(gift) });
  } catch (error) {
    console.error("GET /admin/gifts/:id failed:", error);
    return res.status(500).json({ message: "Failed to load gift" });
  }
});

/**
 * Send a fresh invitation.
 *
 * The answer to an expired or lost link, and the reason a link expiring never
 * has to cost anybody their gift. Issuing a new one increments the version and
 * replaces the stored hash, so every previously issued link stops working —
 * which is also what makes this the right response to a link that leaked.
 */
router.post("/:id/reissue-invitation", auth, ...onlyAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid gift id" });
    }
    const gift = await GiftMembership.findById(req.params.id);
    if (!gift) return res.status(404).json({ message: "Gift not found" });

    if (gift.recipient) {
      return res.status(409).json({
        code: "ALREADY_CLAIMED",
        message: "This gift has already been claimed, so there is nothing to re-send.",
      });
    }
    if (gift.status === "cancelled") {
      return res.status(409).json({ code: "CANCELLED", message: "This gift has been cancelled." });
    }

    const invitation = await issueInvitation(gift, { reissue: true });
    await sendGiftInvitation(gift, invitation);

    console.log(
      JSON.stringify({
        event: "gift_invitation_reissued",
        giftNumber: gift.giftNumber,
        version: invitation.version,
        by: req.user?.id || "",
      })
    );

    const updated = await GiftMembership.findById(gift._id).lean();
    return res.json({
      message: `A fresh invitation has been sent to ${gift.recipientEmail}.`,
      item: present(updated),
    });
  } catch (error) {
    console.error("POST /admin/gifts/:id/reissue-invitation failed:", error);
    return res.status(500).json({ message: "Failed to re-send the invitation" });
  }
});

/**
 * Cancel a gift.
 *
 * The controlled counterpart to a refund. Refund webhooks record money and
 * deliberately do not touch entitlement, because a refund can be partial, a
 * duplicate correction, or a chargeback we intend to contest — so ending
 * somebody's membership is a decision a person makes, here, with the refund
 * figures in front of them.
 */
router.post("/:id/cancel", auth, ...onlyAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid gift id" });
    }
    const gift = await GiftMembership.findById(req.params.id);
    if (!gift) return res.status(404).json({ message: "Gift not found" });
    if (gift.status === "cancelled") {
      return res.status(409).json({ code: "ALREADY_CANCELLED", message: "Already cancelled." });
    }

    const reason = String(req.body?.reason || "").slice(0, 300);

    await GiftMembership.updateOne(
      { _id: gift._id },
      {
        $set: {
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledReason: reason,
          cancelledByUserId: req.user?.id || null,
          // Any outstanding invitation dies with the gift.
          claimTokenHash: "",
        },
      }
    );

    console.log(
      JSON.stringify({
        event: "gift_cancelled",
        giftNumber: gift.giftNumber,
        wasClaimed: Boolean(gift.recipient),
        by: req.user?.id || "",
        reason,
      })
    );

    const updated = await GiftMembership.findById(gift._id).lean();
    return res.json({ message: "Gift cancelled.", item: present(updated) });
  } catch (error) {
    console.error("POST /admin/gifts/:id/cancel failed:", error);
    return res.status(500).json({ message: "Failed to cancel the gift" });
  }
});

module.exports = router;
module.exports.present = present;
