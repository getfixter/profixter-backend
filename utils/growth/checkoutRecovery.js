require("./actions");
const { propose } = require("./actionEngine");

/**
 * checkout.session.expired for a MEMBERSHIP checkout -> a recovery proposal.
 *
 * Only proposes. Whether, when and how the email goes out is the action
 * engine's decision (shadow, supervised or autonomous), and the action
 * re-checks everything at run time. The idempotency key is the session id, so
 * Stripe redelivering the event can never produce a second email.
 *
 * Never throws into the webhook: a recovery email is worth nothing next to
 * acknowledging Stripe's event.
 */
async function proposeCheckoutRecovery(session, findUser) {
  try {
    if (!session || session.mode !== "subscription") return null;
    if (session.status && session.status !== "expired") return null;

    const user = await findUser(session);
    if (!user) return null;

    const metadata = session.metadata || {};
    const { action, created } = await propose(
      "checkout_recovery_email",
      {
        userId: String(user._id),
        stripeSessionId: session.id,
        plan: metadata.plan,
        billingCycle: metadata.billingCycle,
        sessionCreatedAt: session.created ? new Date(session.created * 1000) : null,
      },
      {
        idempotencyKey: `checkout_recovery:${session.id}`,
        rationale: "Membership checkout expired after 24 hours without payment.",
        proposedBy: { kind: "system", name: "Stripe checkout expiry" },
      }
    );
    return created ? action : null;
  } catch (error) {
    console.warn("Checkout recovery proposal failed:", error.message);
    return null;
  }
}

module.exports = { proposeCheckoutRecovery };
