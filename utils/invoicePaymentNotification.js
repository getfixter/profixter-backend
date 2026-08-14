/**
 * "A customer just paid an invoice online."
 *
 * WHY IT HANGS OFF THE PAYMENT RECORD
 * This is sent only when recordStripePayment reports applied: true, which means
 * one payment row was written to the invoice. That is where the idempotency
 * already lives - the PaymentIntent can only produce one record no matter how
 * many times Stripe redelivers the event - so one payment produces one email
 * with no separate bookkeeping. It also means an invoice marked paid out of
 * band inside Stripe sends nothing, because no money was collected online.
 *
 * WHAT IT SAYS
 * What the owner needs to act on: who paid, against which invoice and project,
 * how much, what is left, and how they paid. No Stripe identifiers - they are
 * on the invoice for anyone who needs them, and they make an email that has to
 * be read at a glance unreadable.
 */

const adminSubjects = require("./adminSubjects");
const { ADMIN, REPLY_TO, FROM, sendRaw } = require("./emailService");
const {
  formatSubmittedAt,
  renderAdminEventEmail,
  resolveLeadReplyTo,
} = require("./adminLeadNotification");
const { outstandingCents } = require("./invoiceOnlinePayments");

function money(cents, currency = "usd") {
  const numeric = Number(cents);
  if (!Number.isFinite(numeric)) return "Not available";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: String(currency || "usd").toUpperCase(),
  }).format(numeric / 100);
}

function projectReference(invoice) {
  const number = String(invoice?.projectSnapshot?.projectNumber || "").trim();
  const workType = String(invoice?.projectSnapshot?.workType || "").trim();
  if (number && workType) return `${number} (${workType})`;
  return number || workType || "Not available";
}

/**
 * The email, as data. Pure so the contents can be asserted on without sending.
 */
function buildInvoicePaymentNotification(invoice, {
  appliedCents,
  unappliedCents = 0,
  method = "",
  paidAt = new Date(),
} = {}) {
  const customerName = String(invoice?.customerSnapshot?.fullName || "").trim();
  const invoiceNumber = String(invoice?.invoiceNumber || "").trim();
  const remaining = outstandingCents(invoice);

  const fields = [
    ["Customer", customerName || "Not available"],
    ["Customer email", String(invoice?.customerSnapshot?.email || "").trim() || "Not available"],
    ["Invoice", invoiceNumber ? `#${invoiceNumber}` : "Not available"],
    ["Project", projectReference(invoice)],
    ["Amount paid", money(appliedCents)],
    ["Remaining balance", money(remaining)],
    ["Invoice status", String(invoice?.status || "").trim() || "Not available"],
    ["Payment method", String(method || "").trim() || "Not available"],
    ["Paid at", formatSubmittedAt(paidAt)],
  ];

  /*
   * Surplus is rare and always a reconciliation task: Stripe collected more
   * than the invoice still owed, usually because a cheque was recorded after
   * the payment page was issued. It is mentioned only when it happened.
   */
  if (Number(unappliedCents) > 0) {
    fields.push([
      "Needs review",
      `${money(unappliedCents)} could not be applied because the balance had already been reduced.`,
    ]);
  }

  return {
    subject: adminSubjects.payment("Invoice Paid", { amount: money(appliedCents), name: customerName }),
    heading: "Invoice paid",
    fields,
  };
}

/**
 * Send it to the owner.
 *
 * The recipient is MAIL_ADMIN through the address emailService already resolves,
 * so there is one definition of where owner mail goes rather than an address
 * written into this file.
 */
async function sendInvoicePaymentNotification(invoice, details = {}) {
  const notification = buildInvoicePaymentNotification(invoice, details);
  const rendered = renderAdminEventEmail(notification);

  return sendRaw({
    to: ADMIN,
    from: FROM,
    replyTo: resolveLeadReplyTo(invoice?.customerSnapshot?.email, REPLY_TO),
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    bccAdmin: false,
    logContext: {
      templateKey: "admin_invoice_paid_online",
      recipientEmail: ADMIN,
      customerName: invoice?.customerSnapshot?.fullName || "",
      customerEmail: invoice?.customerSnapshot?.email || "",
      emailType: "admin",
      source: "stripeWebhookInvoicePaid",
    },
  });
}

module.exports = {
  buildInvoicePaymentNotification,
  sendInvoicePaymentNotification,
};
