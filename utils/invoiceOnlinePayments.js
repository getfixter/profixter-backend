/**
 * Online payment collection for ProFixter invoices.
 *
 * ProFixter owns the invoice. Stripe collects the money. This module is the
 * only place the two meet, so the rules about which system is authoritative
 * live in exactly one file.
 *
 * WHAT STRIPE IS TOLD TO COLLECT
 * A Stripe invoice is finalized for the ProFixter outstanding balance at the
 * moment of sending, and that figure is stored as `amountDueCents`. Everything
 * downstream compares against it: if the ProFixter balance later stops matching
 * it - because the invoice was edited, or a cheque was recorded - the Stripe
 * destination is stale and must be voided rather than left collecting the wrong
 * amount. That is the whole of the synchronisation rule.
 *
 * ONE COLLECTIBLE DESTINATION
 * Send, resend and retry all pass through ensureCollectible(), which reuses the
 * stored Stripe invoice when it is still open and still for the right amount.
 * Repeated clicking cannot produce a second thing to pay.
 *
 * MONEY IS NEVER INVENTED OR DISCARDED
 * Recording a payment re-reads the invoice, recomputes the outstanding balance
 * in integer cents, and applies at most that. Stripe collecting more than we
 * still expect is a real event that must not corrupt the invoice, so the
 * surplus is recorded as unapplied and surfaced to the admin instead of being
 * appended blindly - the invoice's own validation rejects payments exceeding
 * the total, and a webhook that trips it would retry forever.
 */

const { stripe, hasStripeSecretKey } = require("./subscriptionManagement");
const { paidOnInvoice } = require("./projectFinancials");

/** Stripe invoice states that can still take money. */
const COLLECTIBLE_STRIPE_STATUSES = Object.freeze(["draft", "open"]);

/** ProFixter statuses that must never have a live payment destination. */
const UNCOLLECTIBLE_INVOICE_STATUSES = Object.freeze(["Voided", "Superseded"]);

class OnlinePaymentError extends Error {
  constructor(message, code = "online_payment_failed") {
    super(message);
    this.name = "OnlinePaymentError";
    this.code = code;
  }
}

/**
 * Whether online payment is switched on at all.
 *
 * An environment with no Stripe key is not a failure, it is a deployment
 * without this feature: invoices still send, simply without a Pay button.
 * That keeps existing behaviour intact wherever Stripe is not configured.
 */
function onlinePaymentsEnabled() {
  return hasStripeSecretKey();
}

function toCents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * What this invoice still expects to be paid, computed from its own records.
 *
 * Deliberately derived here rather than trusting `remainingBalanceCents`, so a
 * stale denormalised figure can never authorise a charge.
 */
function outstandingCents(invoice) {
  const total = Math.max(toCents(invoice?.invoiceTotalCents), 0);
  const paid = paidOnInvoice(invoice);
  return Math.max(total - paid, 0);
}

function isCollectible(invoice) {
  if (!invoice) return false;
  if (invoice.isArchived) return false;
  if (UNCOLLECTIBLE_INVOICE_STATUSES.includes(String(invoice.status || ""))) return false;
  return outstandingCents(invoice) > 0;
}

/** True when the stored Stripe invoice still matches what we now expect. */
function destinationIsCurrent(invoice) {
  const link = invoice?.onlinePayment;
  if (!link?.stripeInvoiceId) return false;
  if (!COLLECTIBLE_STRIPE_STATUSES.includes(String(link.stripeStatus || ""))) return false;
  if (toCents(link.amountDueCents) !== outstandingCents(invoice)) return false;
  // A Stripe page promising a different due date than the invoice is telling
  // the customer something we did not say, so it counts as stale too.
  const expectedDue = dueDateUnix(invoice);
  if (expectedDue && Number(link.dueDateUnix || 0) !== expectedDue) return false;
  return true;
}

/**
 * The Stripe due date for a ProFixter invoice, as a Unix timestamp.
 *
 * ProFixter owns the due date. Letting Stripe compute its own with
 * days_until_due produced a hosted page saying September 11 for an invoice due
 * August 12, which is the customer being told the wrong thing by our own
 * payment page.
 *
 * The conversion is the delicate part. A date-only due date is stored at noon
 * UTC (see parseDate in invoiceValidation), and the PDF renders it in
 * America/New_York. So the calendar day is read back in New York, then pinned
 * to noon UTC on that day: midday is far enough from both midnight boundaries
 * that the same calendar date is displayed whether Stripe renders in UTC or in
 * any US timezone. Anchoring to midnight would shift the date by one day for
 * half the world.
 */
function dueDateUnix(invoice, timeZone = "America/New_York") {
  const due = invoice?.dates?.dueDate;
  if (!due) return null;
  const date = new Date(due);
  if (Number.isNaN(date.getTime())) return null;

  // en-CA formats as YYYY-MM-DD, which parses back without ambiguity.
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .split("-")
    .map(Number);

  return Math.floor(Date.UTC(year, month - 1, day, 12, 0, 0) / 1000);
}

/**
 * Reuse the customer's existing Stripe Customer where there is one.
 *
 * Members already have a Stripe Customer from their subscription, and attaching
 * invoices to it keeps a person's payment history in one place. Invoices can
 * also belong to a manual customer with no account at all, so an email-only
 * customer is created as a fallback rather than failing.
 */
async function resolveStripeCustomerId(invoice, { User } = {}) {
  if (invoice.onlinePayment?.stripeCustomerId) return invoice.onlinePayment.stripeCustomerId;

  const email = String(invoice.customerSnapshot?.email || "").trim().toLowerCase();
  if (!email) {
    throw new OnlinePaymentError(
      "This invoice has no customer email, so it cannot be paid online.",
      "missing_customer_email"
    );
  }

  if (invoice.customerId && User) {
    const account = await User.findById(invoice.customerId).select("stripeCustomerId").lean();
    if (account?.stripeCustomerId) return account.stripeCustomerId;
  }

  const created = await stripe.customers.create(
    {
      email,
      name: invoice.customerSnapshot?.fullName || undefined,
      metadata: {
        profixterProjectId: String(invoice.projectId || ""),
        source: "profixter_invoice",
      },
    },
    // Stable per invoice: a retried send cannot create a second customer.
    { idempotencyKey: `pfx-inv-cust-${invoice._id}` }
  );
  return created.id;
}

function invoiceMetadata(invoice) {
  // Identifiers only. No customer names, addresses or contact details.
  return {
    profixterInvoiceId: String(invoice._id),
    profixterInvoiceNumber: String(invoice.invoiceNumber || ""),
    profixterProjectId: String(invoice.projectId || ""),
    source: "profixter_invoice",
  };
}

/** Void the Stripe destination, tolerating a Stripe invoice that is already gone. */
async function voidDestination(invoice, reason = "") {
  const link = invoice.onlinePayment;
  if (!link?.stripeInvoiceId) return false;

  const wasCollectible = COLLECTIBLE_STRIPE_STATUSES.includes(String(link.stripeStatus || ""));
  if (wasCollectible) {
    try {
      const current = await stripe.invoices.retrieve(link.stripeInvoiceId);
      if (current.status === "draft") {
        await stripe.invoices.del(link.stripeInvoiceId);
      } else if (current.status === "open") {
        await stripe.invoices.voidInvoice(link.stripeInvoiceId);
      }
    } catch (error) {
      // A destination we cannot reach must not block voiding the invoice
      // locally, but the reason is kept so the admin can see it.
      invoice.onlinePayment.lastError = String(error?.message || "").slice(0, 500);
    }
  }

  invoice.onlinePayment.stripeStatus = "void";
  invoice.onlinePayment.hostedInvoiceUrl = "";
  invoice.onlinePayment.voidedAt = new Date();
  invoice.onlinePayment.lastSyncedAt = new Date();
  invoice.markModified("onlinePayment");
  if (typeof invoice.addEvent === "function") {
    invoice.addEvent("Online payment destination voided", null, { reason });
  }
  return true;
}

/**
 * Make sure this invoice has exactly one live destination for the right amount.
 *
 * Returns the hosted URL. Throws rather than returning a half-provisioned state,
 * because the caller's next step is emailing a Pay button and a broken one is
 * worse than no email.
 */
async function ensureCollectible(invoice, { User } = {}) {
  if (!hasStripeSecretKey()) {
    throw new OnlinePaymentError("Stripe is not configured.", "stripe_not_configured");
  }
  if (!isCollectible(invoice)) {
    throw new OnlinePaymentError(
      "This invoice has nothing left to collect, so no payment link was created.",
      "not_collectible"
    );
  }

  if (destinationIsCurrent(invoice) && invoice.onlinePayment.hostedInvoiceUrl) {
    return invoice.onlinePayment.hostedInvoiceUrl;
  }

  // Anything stale is retired before a replacement exists, so there is never
  // more than one payable destination for this invoice.
  if (invoice.onlinePayment?.stripeInvoiceId) {
    await voidDestination(invoice, "Amount changed before sending");
  }

  const amountDue = outstandingCents(invoice);
  const dueUnix = dueDateUnix(invoice);
  const customerId = await resolveStripeCustomerId(invoice, { User });
  const metadata = invoiceMetadata(invoice);
  // Distinguishes one collectible attempt from the next for the same invoice,
  // so a retry reuses objects but a genuine reissue does not collide.
  const attemptKey = `pfx-inv-${invoice._id}-${amountDue}-${dueUnix || 0}-${Number(invoice.version || 1)}`;

  try {
    const draft = await stripe.invoices.create(
      {
        customer: customerId,
        collection_method: "send_invoice",
        // The ProFixter due date, never a Stripe-computed one.
        ...(dueUnix ? { due_date: dueUnix } : { days_until_due: 30 }),
        auto_advance: false,
        currency: "usd",
        description: `ProFixter Invoice #${invoice.invoiceNumber}`,
        metadata,
      },
      { idempotencyKey: `${attemptKey}-inv` }
    );

    await stripe.invoiceItems.create(
      {
        customer: customerId,
        invoice: draft.id,
        amount: amountDue,
        currency: "usd",
        description: `Invoice #${invoice.invoiceNumber}`,
        metadata,
      },
      { idempotencyKey: `${attemptKey}-item` }
    );

    const finalized = await stripe.invoices.finalizeInvoice(
      draft.id,
      { auto_advance: false },
      { idempotencyKey: `${attemptKey}-final` }
    );

    if (!finalized.hosted_invoice_url) {
      throw new OnlinePaymentError(
        "Stripe did not return a payment page for this invoice.",
        "missing_hosted_url"
      );
    }

    invoice.onlinePayment = {
      provider: "stripe",
      stripeInvoiceId: finalized.id,
      stripeCustomerId: customerId,
      hostedInvoiceUrl: finalized.hosted_invoice_url,
      stripeStatus: finalized.status,
      amountDueCents: amountDue,
      dueDateUnix: dueUnix || 0,
      finalizedAt: new Date(),
      voidedAt: null,
      lastSyncedAt: new Date(),
      lastError: "",
      unappliedCents: invoice.onlinePayment?.unappliedCents || 0,
    };
    invoice.markModified("onlinePayment");
    if (typeof invoice.addEvent === "function") {
      invoice.addEvent("Online payment enabled", null, { amountDueCents: amountDue });
    }
    return finalized.hosted_invoice_url;
  } catch (error) {
    const message = String(error?.message || "Stripe could not create the payment page");
    invoice.onlinePayment = {
      ...(invoice.onlinePayment?.toObject?.() || invoice.onlinePayment || {}),
      lastError: message.slice(0, 500),
      lastSyncedAt: new Date(),
    };
    invoice.markModified("onlinePayment");
    throw error instanceof OnlinePaymentError
      ? error
      : new OnlinePaymentError(message, "stripe_error");
  }
}

/**
 * Retire the destination when the invoice stops being collectible for its
 * current amount. Called on void, on edits after sending, and after an offline
 * payment changes the balance.
 */
async function invalidateIfStale(invoice, reason) {
  const link = invoice?.onlinePayment;
  if (!link?.stripeInvoiceId) return false;
  if (!COLLECTIBLE_STRIPE_STATUSES.includes(String(link.stripeStatus || ""))) return false;
  if (destinationIsCurrent(invoice) && isCollectible(invoice)) return false;
  return voidDestination(invoice, reason);
}

/**
 * The PaymentIntent behind a Stripe invoice, or null when there is not one.
 *
 * Returns null rather than inventing an identifier. That distinction is the
 * whole safety property here: `invoice.paid` also fires when an invoice is
 * marked paid out of band inside Stripe, where no money moved through Stripe at
 * all. Manufacturing an id from the invoice id would make that indistinguishable
 * from a real card payment and record revenue that was never collected online.
 */
function extractPaymentIntentId(stripeInvoice) {
  const direct = stripeInvoice?.payment_intent;
  if (typeof direct === "string" && direct) return direct;
  if (direct?.id) return direct.id;

  const payment = stripeInvoice?.payments?.data?.[0]?.payment;
  if (typeof payment?.payment_intent === "string" && payment.payment_intent) {
    return payment.payment_intent;
  }
  if (payment?.payment_intent?.id) return payment.payment_intent.id;

  return null;
}

/**
 * Did money actually move through Stripe for this invoice?
 *
 * `paid_out_of_band` is Stripe's own marker for an invoice settled elsewhere and
 * recorded manually in the Dashboard. Combined with the absence of a
 * PaymentIntent, it tells us this is a bookkeeping entry, not a payment we may
 * record as collected online.
 */
function classifyInvoicePayment(stripeInvoice) {
  if (stripeInvoice?.paid_out_of_band === true) {
    return { online: false, reason: "paid_out_of_band" };
  }
  const paymentIntentId = extractPaymentIntentId(stripeInvoice);
  if (!paymentIntentId) {
    return { online: false, reason: "no_payment_intent" };
  }
  return { online: true, paymentIntentId };
}

/**
 * Record that Stripe considers this invoice settled without money having been
 * collected online. No payment record is created: ProFixter must never show a
 * customer online payment that did not occur. The admin is told, and records the
 * real payment through the normal manual path if it belongs on the invoice.
 */
function flagOutOfBandSettlement(invoice, { reason, amountCents, stripeInvoiceId }) {
  invoice.onlinePayment.stripeStatus = "paid";
  invoice.onlinePayment.hostedInvoiceUrl = "";
  invoice.onlinePayment.lastSyncedAt = new Date();
  invoice.onlinePayment.lastError =
    reason === "paid_out_of_band"
      ? "Marked paid in Stripe without an online payment. Record the actual payment on this invoice if it was received."
      : "Stripe reported this invoice paid but returned no payment to verify. Reconcile before treating it as collected.";
  invoice.markModified("onlinePayment");
  if (typeof invoice.addEvent === "function") {
    invoice.addEvent("Online payment needs review", null, {
      reason,
      stripeInvoiceId: stripeInvoiceId || "",
      stripeAmountPaidCents: Math.max(toCents(amountCents), 0),
      note: "No ProFixter payment was recorded because no online payment was verified.",
    });
  }
  return { applied: false, reason };
}

/**
 * How the customer actually paid, resolved from the PaymentIntent.
 *
 * WHY NOT READ IT OFF THE INVOICE
 * `invoice.payments[].payment.type` looks like the answer and is not: it names
 * the kind of object the payment points at ("payment_intent"), not the payment
 * method. Feeding that to methodFromStripe returns "Other", which is why every
 * card payment was being filed as Other on the invoice. The PaymentIntent's
 * latest charge carries payment_method_details.type, which is the real thing.
 *
 * Never throws and never blocks. A failure here degrades to "Other", exactly
 * the behaviour before this existed - the payment amount, the balance and the
 * idempotency key are all decided elsewhere and none of them depend on this.
 */
async function resolvePaymentMethodType(paymentIntentId) {
  const id = String(paymentIntentId || "").trim();
  if (!id) return "";

  try {
    const intent = await stripe.paymentIntents.retrieve(id, {
      expand: ["latest_charge"],
    });

    const charge = intent?.latest_charge;
    const type =
      charge && typeof charge === "object"
        ? charge?.payment_method_details?.type
        : "";
    if (type) return String(type);

    // No charge to read yet. A single allowed method is still unambiguous.
    const allowed = Array.isArray(intent?.payment_method_types)
      ? intent.payment_method_types
      : [];
    if (allowed.length === 1) return String(allowed[0]);
  } catch (error) {
    console.warn(
      "Unable to resolve the Stripe payment method type:",
      error?.message || error
    );
  }

  return "";
}

/** Stripe payment method type mapped onto the existing ProFixter methods. */
function methodFromStripe(type) {
  if (type === "us_bank_account" || type === "ach_debit" || type === "ach_credit_transfer") {
    return "ACH / Bank Transfer";
  }
  if (type === "card") return "Credit Card";
  return "Other";
}

/**
 * Record money Stripe collected against this invoice.
 *
 * Idempotent on the PaymentIntent, which is stable across webhook retries and
 * across the different events that can announce one payment.
 *
 * Applies at most the outstanding balance. Anything Stripe collected beyond
 * that is recorded as unapplied rather than appended, because appending it
 * would push total payments past the invoice total and the model rejects that -
 * the save would fail and Stripe would retry the webhook indefinitely.
 *
 * @returns {{applied:boolean, reason?:string, appliedCents?:number, unappliedCents?:number}}
 */
function recordStripePayment(invoice, { paymentIntentId, stripeInvoiceId, eventId, amountCents, paidAt, paymentMethodType }) {
  const collected = Math.max(toCents(amountCents), 0);
  if (collected <= 0) return { applied: false, reason: "zero_amount" };

  const already = (invoice.payments || []).some(
    (payment) =>
      payment.provider === "stripe" &&
      paymentIntentId &&
      payment.stripePaymentIntentId === paymentIntentId
  );
  if (already) return { applied: false, reason: "duplicate" };

  const outstanding = outstandingCents(invoice);
  if (outstanding <= 0) {
    invoice.onlinePayment.unappliedCents = toCents(invoice.onlinePayment?.unappliedCents) + collected;
    invoice.onlinePayment.lastSyncedAt = new Date();
    invoice.markModified("onlinePayment");
    if (typeof invoice.addEvent === "function") {
      invoice.addEvent("Online payment needs review", null, {
        reason: "Invoice already settled when this payment arrived",
        collectedCents: collected,
      });
    }
    return { applied: false, reason: "nothing_outstanding", unappliedCents: collected };
  }

  const appliedCents = Math.min(collected, outstanding);
  const surplus = collected - appliedCents;

  invoice.payments.push({
    amountCents: appliedCents,
    paymentDate: paidAt || new Date(),
    method: methodFromStripe(paymentMethodType),
    reference: paymentIntentId || stripeInvoiceId || "",
    note: surplus > 0
      ? `Paid online. Stripe collected ${collected} cents; ${surplus} cents could not be applied because the balance had already been reduced.`
      : "Paid online via Stripe.",
    provider: "stripe",
    stripePaymentIntentId: paymentIntentId || "",
    stripeInvoiceId: stripeInvoiceId || "",
    stripeEventId: eventId || "",
    providerAmountCents: collected,
  });

  invoice.onlinePayment.lastSyncedAt = new Date();
  if (surplus > 0) {
    invoice.onlinePayment.unappliedCents = toCents(invoice.onlinePayment?.unappliedCents) + surplus;
    if (typeof invoice.addEvent === "function") {
      invoice.addEvent("Online payment needs review", null, {
        reason: "Stripe collected more than was outstanding",
        collectedCents: collected,
        appliedCents,
        unappliedCents: surplus,
      });
    }
  } else if (typeof invoice.addEvent === "function") {
    invoice.addEvent("Online payment received", null, { amountCents: appliedCents });
  }
  invoice.markModified("onlinePayment");

  return { applied: true, appliedCents, unappliedCents: surplus };
}

/**
 * Re-derive local state from Stripe.
 *
 * Financial state must not depend on one webhook arriving exactly once, so this
 * can be run at any time to repair an invoice whose event was lost or processed
 * during a deploy. It is idempotent by way of recordStripePayment.
 */
async function reconcileInvoice(invoice) {
  const link = invoice?.onlinePayment;
  if (!link?.stripeInvoiceId) return { reconciled: false, reason: "no_destination" };

  const remote = await stripe.invoices.retrieve(link.stripeInvoiceId, {
    expand: ["payments.data.payment.payment_intent"],
  });

  invoice.onlinePayment.stripeStatus = remote.status || link.stripeStatus;
  invoice.onlinePayment.hostedInvoiceUrl =
    remote.status === "open" ? remote.hosted_invoice_url || "" : "";
  invoice.onlinePayment.lastSyncedAt = new Date();
  invoice.markModified("onlinePayment");

  const amountPaid = toCents(remote.amount_paid);
  if (amountPaid <= 0) return { reconciled: true, applied: false };

  const classification = classifyInvoicePayment(remote);
  if (!classification.online) {
    // Settled in Stripe without an online payment. Surface it; never record it
    // as money collected from the customer online.
    return {
      reconciled: true,
      ...flagOutOfBandSettlement(invoice, {
        reason: classification.reason,
        amountCents: amountPaid,
        stripeInvoiceId: remote.id,
      }),
    };
  }

  const result = recordStripePayment(invoice, {
    paymentIntentId: classification.paymentIntentId,
    stripeInvoiceId: remote.id,
    eventId: "reconciliation",
    amountCents: amountPaid,
    paidAt: remote.status_transitions?.paid_at
      ? new Date(remote.status_transitions.paid_at * 1000)
      : new Date(),
    paymentMethodType: await resolvePaymentMethodType(classification.paymentIntentId),
  });
  return { reconciled: true, ...result };
}

module.exports = {
  OnlinePaymentError,
  dueDateUnix,
  extractPaymentIntentId,
  classifyInvoicePayment,
  flagOutOfBandSettlement,
  onlinePaymentsEnabled,
  COLLECTIBLE_STRIPE_STATUSES,
  outstandingCents,
  isCollectible,
  destinationIsCurrent,
  ensureCollectible,
  invalidateIfStale,
  voidDestination,
  recordStripePayment,
  reconcileInvoice,
  methodFromStripe,
  resolvePaymentMethodType,
  invoiceMetadata,
};
