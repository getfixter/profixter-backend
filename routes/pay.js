const express = require("express");

const Booking = require("../models/Booking");
const AdminPaymentLink = require("../models/AdminPaymentLink");
const { stripe } = require("../utils/subscriptionManagement");
const { CLIENT_URL, CheckoutRefusal, openMembershipCheckout } = require("../utils/membershipCheckout");
const { findLinkByToken, linkIsLive } = require("../utils/admin/paymentLinks");
const { hitAll } = require("../utils/auth/authRateLimit");
const { clientIp } = require("../utils/auth/clientIp");

/**
 * profixter.com/pay/<token> - the customer's side of an Admin payment link.
 *
 * Public by design (the customer may have no account, or not be signed in);
 * the unguessable token is the authority, and it can only ever open a Stripe
 * page for the one thing it was made for. Opening Stripe is a POST, pressed by
 * the customer: link previews in a messaging app fetch the page, never this.
 *
 * Every open asks again whether paying is still right. A membership link for
 * a home that has bought a membership since is closed rather than opened, so
 * a link can never be the second charge on a home.
 */
const router = express.Router();

const FRIENDLY = {
  ADDRESS_ALREADY_SUBSCRIBED: "This home already has an active membership, so there is nothing to pay.",
  MEMBERSHIP_PAYMENT_RECOVERY_REQUIRED: "This home's membership just needs its payment updated. Please call us and we'll help.",
  CHECKOUT_ALREADY_OPENING: "Your secure checkout is already opening. Please wait a moment.",
};

async function limited(req) {
  const ip = require("crypto").createHash("sha256").update(clientIp(req)).digest("hex").slice(0, 32);
  const result = await hitAll([{ key: `pay:ip:${ip}`, limit: 60, windowMs: 15 * 60 * 1000 }]);
  return !result.allowed;
}

async function describe(link) {
  let status = link.status;
  if (status === "open" && !linkIsLive(link)) status = "expired";
  if (link.booking && status === "open") {
    const booking = await Booking.findById(link.booking).select("paymentState status").lean();
    if (!booking) status = "canceled";
    else if (booking.paymentState === "paid") status = "paid";
    else if (["expired", "failed"].includes(booking.paymentState) || /cancel/i.test(String(booking.status || ""))) status = "expired";
  }
  return { status, kind: link.kind, itemLabel: link.itemLabel, expiresAt: link.expiresAt };
}

router.get("/:token", async (req, res) => {
  try {
    if (await limited(req)) return res.status(429).json({ message: "Too many requests. Please wait a few minutes." });
    const link = await findLinkByToken(req.params.token);
    if (!link) return res.status(404).json({ status: "not_found", message: "This payment link isn't valid." });
    return res.json(await describe(link));
  } catch (error) {
    console.error("GET /api/pay/:token error:", error);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

router.post("/:token/checkout", async (req, res) => {
  try {
    if (await limited(req)) return res.status(429).json({ message: "Too many requests. Please wait a few minutes." });
    const token = String(req.params.token || "");
    const link = await findLinkByToken(token);
    if (!link) return res.status(404).json({ status: "not_found", message: "This payment link isn't valid." });
    const state = await describe(link);
    if (state.status !== "open") return res.status(410).json({ ...state, message: state.status === "paid" ? "This has already been paid. Thank you!" : "This payment link has expired. Please call us for a new one." });

    let url = "";
    if (link.kind === "membership") {
      const remaining = Math.floor((new Date(link.expiresAt).getTime() - Date.now()) / 1000);
      const expiresAt = Math.floor(Date.now() / 1000) + Math.max(31 * 60, Math.min(24 * 60 * 60 - 60, remaining));
      try {
        const { session } = await openMembershipCheckout({
          userId: link.user,
          plan: link.plan,
          billingCycle: link.billingCycle,
          addressId: String(link.addressId),
          successUrl: `${CLIENT_URL}/pay/${token}?paid=1`,
          cancelUrl: `${CLIENT_URL}/pay/${token}`,
          metadata: { adminInitiated: "link", adminPaymentLinkId: String(link._id) },
          expiresAt,
        });
        url = session.url;
        link.lastSessionId = session.id;
      } catch (error) {
        if (!(error instanceof CheckoutRefusal)) throw error;
        if (error.body?.code === "ADDRESS_ALREADY_SUBSCRIBED") {
          await AdminPaymentLink.updateOne({ _id: link._id }, { $set: { status: "canceled" } });
        }
        return res.status(error.status).json({ status: "unavailable", code: error.body?.code || "", message: FRIENDLY[error.body?.code] || error.body?.message || "This payment can't be opened right now." });
      }
    } else {
      const session = link.lastSessionId ? await stripe.checkout.sessions.retrieve(link.lastSessionId) : null;
      if (!session || session.status !== "open" || !session.url) {
        return res.status(410).json({ status: session?.status === "complete" ? "paid" : "expired", message: session?.status === "complete" ? "This has already been paid. Thank you!" : "This payment link has expired. Please call us for a new one." });
      }
      url = session.url;
    }

    link.openedCount = Number(link.openedCount || 0) + 1;
    link.lastOpenedAt = new Date();
    await link.save();
    return res.json({ url });
  } catch (error) {
    console.error("POST /api/pay/:token/checkout error:", error);
    return res.status(500).json({ message: "Secure checkout could not be opened. Please try again." });
  }
});

module.exports = router;
