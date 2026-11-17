/**
 * Needs action - paid free-visit conversions that did not convert
 * (utils/freeVisit/conversion.js): the customer paid, the visit was left as
 * it was, and the owner must retry or settle it. Also a payment the webhook
 * has not finished converting for more than 15 minutes (the sweep retries
 * every few minutes, so one still "paid" by then is stuck). And a converted
 * visit Admin canceled afterwards, until its payment is settled
 * (utils/freeVisit/paymentResolution.js).
 */
const moment = require("moment-timezone");
const { PERMISSIONS } = require("../../adminAccess");

const STUCK_MS = 15 * 60 * 1000;

module.exports = {
  key: "visit_conversions",
  order: 12,
  permission: PERMISSIONS.BOOKINGS_ASSIGN,
  async collect({ now = new Date(), limit = 25 }) {
    const FreeVisitConversion = require("../../../models/FreeVisitConversion");
    const filter = {
      $or: [
        { status: "needs_attention" },
        { status: { $in: ["paid", "converting"] }, updatedAt: { $lt: new Date(now.getTime() - STUCK_MS) } },
        /* Converted, then canceled by Admin: the payment (and a membership's subscription) wait for a decision. */
        { "afterCancel.at": { $type: "date" }, "afterCancel.resolvedAt": null },
      ],
    };
    const [count, rows] = await Promise.all([
      FreeVisitConversion.countDocuments(filter),
      FreeVisitConversion.find(filter).sort({ updatedAt: 1 }).limit(limit).select("booking bookingNumber status kind plan billingCycle contact attention afterCancel payment updatedAt snapshot").lean(),
    ]);
    const items = rows.map((c) => {
      const canceledAfter = c.status === "converted" && c.afterCancel?.at && !c.afterCancel?.resolvedAt;
      return {
      id: String(c._id),
      kind: canceledAfter ? "conversion_canceled_after_payment" : "conversion_needs_attention",
      title: canceledAfter ? `Paid, then canceled: ${c.contact?.name || "Customer"}` : `Paid, not converted: ${c.contact?.name || "Customer"}`,
      subtitle: [
        c.kind === "one_time" ? "One-Time Visit" : "Membership",
        c.snapshot?.date ? moment.tz(c.snapshot.date, "America/New_York").format("ddd, MMM D, h:mm A") : "",
        c.bookingNumber ? `#${c.bookingNumber}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      reason: canceledAfter
        ? c.kind === "membership"
          ? "The visit was canceled after it was paid. Its membership still bills until it is canceled on the customer's profile; a refund alone does not stop it. Record what you did."
          : "The visit was canceled after it was paid. Canceling did not refund it. Refund it in Stripe or record that it was kept."
        : c.status === "needs_attention"
          ? c.attention?.message || "The visit could not be converted."
          : "The payment arrived but the visit has not been converted yet.",
      severity: "problem",
      href: `/admin/jobs/${c.booking}`,
      at: canceledAfter ? c.afterCancel.at : c.payment?.paidAt || c.updatedAt,
      };
    });
    return { count, items };
  },
};
