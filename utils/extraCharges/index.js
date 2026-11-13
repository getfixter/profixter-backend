/**
 * Charge extra: agreed additional work on a booking, charged once.
 *
 *   preview  -> who pays (linkage.js), the card, the tax (tax.js), the total,
 *               and a fingerprint of all of it.
 *   create   -> the owner confirms that exact fingerprint. The AdditionalCharge
 *               record is written FIRST, then Stripe is asked:
 *                 card: an off-session PaymentIntent on the account's own
 *                       Stripe customer and its default card, with a Stripe
 *                       idempotency key made from the record id + attempt;
 *                 link: a booking-specific profixter.com/pay/<token> link that
 *                       opens a Stripe-hosted Checkout for the same record.
 *   reconcile-> every answer from Stripe (the API call, its retry after a
 *               timeout, a webhook, a pull from Stripe) goes through
 *               applyPaymentIntent, which only ever moves the record forward,
 *               atomically, and only for a PaymentIntent that names this
 *               record, this amount and this customer.
 *
 * Nothing here touches the booking, visit entitlements, loyalty or membership
 * billing. Refunds are made in Stripe; charge.refunded keeps the record in step.
 * The receipt is Stripe's (receipt_email on the PaymentIntent): one path, no
 * email of ours.
 */
const crypto = require("crypto");
const mongoose = require("mongoose");
const AdditionalCharge = require("../../models/AdditionalCharge");
const AdminPaymentLink = require("../../models/AdminPaymentLink");
const Booking = require("../../models/Booking");
const { resolveChargeTarget, fullAddressText } = require("./linkage");
const { TaxBlocker, quoteTax, readTreatment } = require("./tax");

const PRODUCT_KIND = "additional_charge";
const MIN_CENTS = 50; // Stripe's minimum charge in USD
const MAX_CENTS = 500000; // $5,000 per extra
const LINK_DAYS = 7;
const SYNC_MIN_MS = 10 * 1000;
const UNKNOWN_RETRY_MS = 23 * 60 * 60 * 1000; // inside Stripe's 24h idempotency window
const CHARGEABLE_STATUSES = new Set(["Confirmed", "Completed"]);
const statusOf = (booking) => require("../jobs/jobStatus").canonicalStatus(booking.status);
const PAID_STATES = ["paid", "partially_refunded", "refunded"];
const OPEN_STATES = ["charging", "processing"];

let client = null;
function setStripeClient(next) {
  client = next;
}
const stripe = () => client || require("../subscriptionManagement").stripe;
const clientUrl = () => require("../membershipCheckout").CLIENT_URL;

class ExtraChargeError extends Error {
  constructor(code, message, statusCode = 400, extra = {}) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

function dashboardUrl(path) {
  const key = String(process.env.STRIPE_SECRET_KEY || "");
  return `${key.startsWith("sk_test_") ? "https://dashboard.stripe.com/test" : "https://dashboard.stripe.com"}/${path}`;
}

const money = (cents) => `$${(Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const idOf = (v) => (v && typeof v === "object" ? String(v.id || "") : String(v || ""));
const sameId = (a, b) => String(a || "") === String(b || "");

function consentStatement(totalCents) {
  return `I confirm the customer agreed to this additional work and to the total of ${money(totalCents)}.`;
}

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

/** "123.45" -> 12345, exactly (no floating point). Also accepts an integer amountCents. */
function readAmountCents(body) {
  if (body.amountCents !== undefined && body.amountCents !== null && body.amountCents !== "") {
    const n = Number(body.amountCents);
    if (!Number.isInteger(n)) throw new ExtraChargeError("INVALID_AMOUNT", "Enter the amount in dollars and cents.");
    return n;
  }
  const raw = String(body.amount ?? "").replace(/[$,\s]/g, "");
  const m = raw.match(/^(\d{1,6})(?:\.(\d{1,2}))?$/);
  if (!m) throw new ExtraChargeError("INVALID_AMOUNT", "Enter the amount in dollars and cents, like 125 or 125.50.");
  return Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
}

function readInput(body = {}) {
  const description = String(body.description || "").replace(/\s+/g, " ").trim();
  if (description.length < 3) throw new ExtraChargeError("DESCRIPTION_REQUIRED", "Describe the additional work.");
  if (description.length > 500) throw new ExtraChargeError("DESCRIPTION_TOO_LONG", "Keep the description under 500 characters.");
  const subtotalCents = readAmountCents(body);
  if (subtotalCents < MIN_CENTS) throw new ExtraChargeError("AMOUNT_TOO_SMALL", "The amount must be at least $0.50.");
  if (subtotalCents > MAX_CENTS) throw new ExtraChargeError("AMOUNT_TOO_LARGE", `One extra can be at most ${money(MAX_CENTS)}. Use a project invoice for larger work.`);
  const taxTreatment = readTreatment(body.taxTreatment);
  const writtenApprovalRef = String(body.writtenApprovalRef || "").replace(/\s+/g, " ").trim().slice(0, 300);
  return { description, subtotalCents, taxTreatment, writtenApprovalRef };
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

function fingerprintOf(bookingId, target, input, tax) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        String(bookingId),
        target.accountUserId,
        target.customerId,
        target.paymentMethodId,
        input.description,
        input.subtotalCents,
        tax ? tax.taxCents : null,
        input.taxTreatment,
      ])
    )
    .digest("hex")
    .slice(0, 32);
}

async function blockedReason(target, booking) {
  const { findActiveBlock } = require("../customerBlock");
  const block = await findActiveBlock({ userId: target.user?._id || null, email: target.contact.email || booking.email, phone: target.contact.phone || booking.phone });
  return block ? { code: "CUSTOMER_BLOCKED", message: "This customer is blocked. Unblock them on their profile before charging." } : null;
}

/** Everything the owner must see before confirming, computed on the server. */
async function buildPreview(booking, input) {
  const target = await resolveChargeTarget(booking, { stripe: stripe() });
  let tax = null;
  let taxError = null;
  try {
    tax = await quoteTax({ stripe: stripe(), subtotalCents: input.subtotalCents, treatment: input.taxTreatment, address: target.serviceAddress, reference: `booking-${booking.bookingNumber || booking._id}` });
  } catch (error) {
    if (!(error instanceof TaxBlocker)) throw error;
    taxError = { code: error.code, message: error.message, taxabilityReason: error.taxabilityReason || "", taxCode: error.taxCode || "" };
  }
  const block = await blockedReason(target, booking);
  const statusBlock = CHARGEABLE_STATUSES.has(String(statusOf(booking) || ""))
    ? null
    : { code: "BOOKING_NOT_CHARGEABLE", message: "Extras can be charged on confirmed or completed visits only." };
  const hard = block || statusBlock || (taxError ? { code: taxError.code, message: taxError.message } : null);
  const direct = hard ? { allowed: false, ...hard } : target.direct;
  const link = hard ? { allowed: false, canSend: false, ...hard } : target.link;
  return {
    target,
    tax,
    preview: {
      booking: { id: String(booking._id), number: String(booking.bookingNumber || ""), date: booking.date || null, service: booking.service || "", status: booking.status || "" },
      customer: { name: target.customerName, guest: target.guest, accountLinked: target.customerLinked, hasEmail: Boolean(target.contact.email), hasPhone: Boolean(target.contact.phone) },
      serviceAddress: { ...target.serviceAddress, full: fullAddressText(target.serviceAddress) },
      card: target.card && target.card.last4 ? { brand: target.card.brand, last4: target.card.last4, expMonth: target.card.expMonth, expYear: target.card.expYear } : null,
      description: input.description,
      subtotalCents: input.subtotalCents,
      taxCents: tax ? tax.taxCents : null,
      totalCents: tax ? input.subtotalCents + tax.taxCents : null,
      tax: tax
        ? { ok: true, treatment: tax.treatment, source: tax.source, ratePercent: tax.ratePercent, taxCode: tax.taxCode, taxabilityReason: tax.taxabilityReason }
        : { ok: false, treatment: input.taxTreatment, ...taxError },
      direct,
      link,
      consentStatement: tax ? consentStatement(input.subtotalCents + tax.taxCents) : "",
      fingerprint: fingerprintOf(booking._id, target, input, tax),
    },
  };
}

async function loadChargeableBooking(bookingId) {
  if (!mongoose.isValidObjectId(bookingId)) throw new ExtraChargeError("INVALID_BOOKING", "Invalid job id", 400);
  const booking = await Booking.findById(bookingId);
  if (!booking) throw new ExtraChargeError("BOOKING_NOT_FOUND", "Job not found", 404);
  return booking;
}

async function preview(bookingId, body) {
  const booking = await loadChargeableBooking(bookingId);
  const input = readInput(body);
  return (await buildPreview(booking, input)).preview;
}

/* ------------------------------------------------------------------ */
/* Records                                                             */
/* ------------------------------------------------------------------ */

function metadataFor(record) {
  return {
    productKind: PRODUCT_KIND,
    additionalChargeId: String(record._id),
    additionalChargeNumber: record.number,
    bookingId: String(record.booking),
    bookingNumber: String(record.bookingNumber || ""),
    userMongoId: record.user ? String(record.user) : "",
    stripeCustomerId: record.stripeCustomerId || "",
    subtotalCents: String(record.subtotalCents),
    taxCents: String(record.taxCents),
    taxTreatment: String(record.tax?.treatment || "").slice(0, 100),
    createdByMongoId: String(record.createdBy || ""),
  };
}

async function nextSeq(bookingId) {
  const last = await AdditionalCharge.findOne({ booking: bookingId }).sort({ seq: -1 }).select("seq").lean();
  return Number(last?.seq || 0) + 1;
}

async function insertRecord(fields) {
  for (let i = 0; i < 6; i += 1) {
    const seq = await nextSeq(fields.booking);
    try {
      return await AdditionalCharge.create({ ...fields, seq, number: `${String(fields.bookingNumber || "X").replace(/^#/, "")}-E${seq}` });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      if (String(error.message).includes("clientKey")) return null; // the same intent, created by a concurrent request
    }
  }
  throw new ExtraChargeError("BUSY", "Too many charges at once on this job. Try again.", 409);
}

async function setStatus(id, from, to, set = {}) {
  return AdditionalCharge.findOneAndUpdate(
    { _id: id, status: Array.isArray(from) ? { $in: from } : from },
    { $set: { status: to, statusChangedAt: new Date(), ...set } },
    { new: true }
  );
}

/** Positional update of one attempt (matched on one field), so concurrent writers never clobber each other. */
async function updateAttempt(id, match, fields) {
  const [[key, value]] = Object.entries(match);
  const set = {};
  for (const [k, v] of Object.entries(fields)) set[`attempts.$.${k}`] = v;
  await AdditionalCharge.updateOne({ _id: id, [`attempts.${key}`]: value }, { $set: set });
}

/* ------------------------------------------------------------------ */
/* Reconciliation: the one place a record changes from Stripe's answer  */
/* ------------------------------------------------------------------ */

async function closeLinksFor(record, status = "canceled") {
  if (!record.paymentLink) return;
  await AdminPaymentLink.updateMany({ additionalCharge: record._id, status: "open" }, { $set: { status } });
}

async function recordTaxTransaction(record) {
  if (!record.tax?.calculationId || record.tax.transactionId) return;
  try {
    const tx = await stripe().tax.transactions.createFromCalculation(
      { calculation: record.tax.calculationId, reference: record.number, metadata: { additionalChargeId: String(record._id) } },
      { idempotencyKey: `pfx-xc-${record._id}-taxtx` }
    );
    await AdditionalCharge.updateOne({ _id: record._id }, { $set: { "tax.transactionId": String(tx.id || ""), "tax.transactionError": "" } });
  } catch (error) {
    const message = String(error?.code || error?.message || error).slice(0, 200);
    await AdditionalCharge.updateOne({ _id: record._id }, { $set: { "tax.transactionError": message } });
    console.error(JSON.stringify({ level: "error", event: "extra_charge_tax_transaction_failed", additionalChargeId: String(record._id), message }));
  }
}

async function chargeDetails(chargeId) {
  if (!chargeId) return {};
  try {
    const charge = await stripe().charges.retrieve(chargeId);
    const card = charge?.payment_method_details?.card || {};
    return {
      receiptUrl: String(charge?.receipt_url || ""),
      card: card.last4 ? { brand: String(card.brand || ""), last4: String(card.last4), expMonth: Number(card.exp_month) || null, expYear: Number(card.exp_year) || null } : null,
      refundedCents: Number(charge?.amount_refunded || 0),
    };
  } catch (error) {
    return {};
  }
}

function failureOf(source) {
  const err = source?.last_payment_error || source || {};
  return {
    code: String(err.code || source?.code || ""),
    declineCode: String(err.decline_code || source?.decline_code || ""),
    message: String(err.message || source?.message || "").slice(0, 300),
  };
}

/**
 * Cancel a card intent that can no longer be completed by us. Returns Stripe's
 * answer: "canceled", "succeeded"/"processing" (too late: it is reconciled
 * instead), or "unknown" when Stripe could not be reached. A cancel that did
 * not happen is remembered on the attempt (cancelPending) and retried by
 * settleCardAttempts before anything else payable is made for the record.
 */
async function cancelIntent(paymentIntentId, recordId = null) {
  if (!paymentIntentId) return "none";
  let status = "unknown";
  try {
    const pi = await stripe().paymentIntents.cancel(paymentIntentId);
    status = String(pi?.status || "unknown");
  } catch (error) {
    try {
      status = String((await stripe().paymentIntents.retrieve(paymentIntentId))?.status || "unknown");
    } catch (inner) {
      status = "unknown";
    }
  }
  if (recordId) await updateAttempt(recordId, { paymentIntentId }, { cancelPending: status !== "canceled" && status !== "succeeded" });
  return status;
}

/**
 * Before any payable thing is made for a record (a link, a Checkout page, a
 * new card attempt), every earlier card intent must be finished: canceled,
 * or - if it succeeded after all (the customer completed a bank check) -
 * applied as the payment. Throws when that cannot be established, so a
 * second way to pay is never created next to a first one that might still
 * succeed.
 */
async function settleCardAttempts(record, depth = 0) {
  const ids = [...new Set(record.attempts.filter((a) => a.kind === "card" && a.paymentIntentId).map((a) => a.paymentIntentId))];
  for (const id of ids) {
    let pi;
    try {
      pi = await stripe().paymentIntents.retrieve(id);
    } catch (error) {
      throw new ExtraChargeError("STRIPE_UNAVAILABLE", "Stripe could not be reached to close the earlier card attempt, so nothing new was made. Try again in a moment.", 503);
    }
    if (pi.status === "canceled") {
      await updateAttempt(record._id, { paymentIntentId: id }, { cancelPending: false });
      continue;
    }
    if (pi.status === "succeeded") {
      await applyPaymentIntent(pi, { source: "settle" });
      throw new ExtraChargeError("ALREADY_PAID", "The earlier card payment for this extra went through after all. It is now Paid; nothing new was made.", 409);
    }
    if (pi.status === "processing") {
      await applyPaymentIntent(pi, { source: "settle" });
      throw new ExtraChargeError("PAYMENT_IN_PROGRESS", "The earlier card payment is still processing at Stripe. Wait for it; nothing new was made.", 409);
    }
    const after = await cancelIntent(id, record._id);
    if (after === "succeeded") {
      await applyPaymentIntent(await stripe().paymentIntents.retrieve(id), { source: "settle" });
      throw new ExtraChargeError("ALREADY_PAID", "The earlier card payment for this extra went through after all. It is now Paid; nothing new was made.", 409);
    }
    if (after !== "canceled") {
      throw new ExtraChargeError("STRIPE_UNAVAILABLE", "The earlier card attempt could not be closed at Stripe, so nothing new was made. Try again in a moment.", 503);
    }
  }
  // An attempt whose request may have reached Stripe without an answer is not settled.
  if (record.attempts.some((a) => a.kind === "card" && !a.paymentIntentId && ["requested", "unknown"].includes(a.status))) {
    const found = await stripe().paymentIntents.search({ query: `metadata['additionalChargeId']:'${record._id}'`, limit: 10 });
    const known = new Set(ids);
    const unseen = (found?.data || []).filter((pi) => !known.has(pi.id) && !pi.metadata?.adminPaymentLinkId);
    if (unseen.length) {
      if (depth > 0) throw new ExtraChargeError("STRIPE_UNAVAILABLE", "An earlier card attempt could not be matched at Stripe, so nothing new was made.", 503);
      for (const pi of unseen) {
        await AdditionalCharge.updateOne(
          { _id: record._id, attempts: { $elemMatch: { kind: "card", paymentIntentId: "" } } },
          { $set: { "attempts.$.paymentIntentId": pi.id } }
        );
      }
      return settleCardAttempts(await AdditionalCharge.findById(record._id), depth + 1);
    }
  }
}

/**
 * Move a record forward from a PaymentIntent Stripe gave us. Idempotent:
 * safe for the same intent any number of times, from any source.
 */
async function applyPaymentIntent(pi, { source = "api" } = {}) {
  const id = String(pi?.metadata?.additionalChargeId || "");
  if (!mongoose.isValidObjectId(id)) return { ignored: true };
  const record = await AdditionalCharge.findById(id);
  if (!record) return { ignored: true };

  // The intent must be this record's: same booking, amount, currency, customer.
  const mismatch =
    !sameId(pi.metadata?.bookingId, record.booking) ||
    Number(pi.amount) !== Number(record.totalCents) ||
    String(pi.currency || "usd") !== record.currency ||
    (record.stripeCustomerId && idOf(pi.customer) && idOf(pi.customer) !== record.stripeCustomerId);
  if (mismatch) {
    console.error(JSON.stringify({ level: "error", event: "extra_charge_intent_mismatch", additionalChargeId: id, paymentIntentId: pi.id, source }));
    return { mismatch: true, record };
  }
  const attemptMatch = record.attempts.find((a) => a.paymentIntentId === pi.id) ? { paymentIntentId: pi.id } : null;
  // Checkout intents carry the link id; the off-session card intents made here never do.
  const isCardAttempt = !pi.metadata?.adminPaymentLinkId;

  if (pi.status === "succeeded") {
    const chargeId = idOf(pi.latest_charge);
    const details = await chargeDetails(chargeId);
    const paid = await setStatus(record._id, ["charging", "processing", "awaiting_payment", "failed", "canceled"], "paid", {
      paymentIntentId: pi.id,
      chargeId,
      paidAt: new Date(Number(pi.created || 0) * 1000 || Date.now()),
      receiptUrl: details.receiptUrl || "",
      ...(details.card ? { card: details.card } : {}),
      failure: { code: "", declineCode: "", message: "" },
      lastStripeSyncAt: new Date(),
    });
    if (attemptMatch) await updateAttempt(record._id, attemptMatch, { status: "succeeded" });
    if (!paid) {
      const fresh = await AdditionalCharge.findById(record._id);
      if (fresh && fresh.paymentIntentId && fresh.paymentIntentId !== pi.id) {
        // A second successful payment for the same extra: never hidden, refund it in Stripe.
        await AdditionalCharge.updateOne(
          { _id: record._id, "extraPayments.paymentIntentId": { $ne: pi.id } },
          { $push: { extraPayments: { paymentIntentId: pi.id, amountCents: Number(pi.amount), at: new Date() } } }
        );
        console.error(JSON.stringify({ level: "error", event: "extra_charge_paid_twice", additionalChargeId: id, paymentIntentId: pi.id }));
      }
      return { record: await AdditionalCharge.findById(record._id), changed: false };
    }
    await AdminPaymentLink.updateMany({ additionalCharge: record._id, status: "open" }, { $set: { status: "paid", paidAt: new Date() } });
    await expireOpenSessions(paid, { except: "" });
    await recordTaxTransaction(paid);
    return { record: await AdditionalCharge.findById(record._id), changed: true };
  }

  if (pi.status === "processing") {
    const r = await setStatus(record._id, ["charging", "awaiting_payment", "failed"], "processing", { paymentIntentId: pi.id, lastStripeSyncAt: new Date() });
    if (attemptMatch) await updateAttempt(record._id, attemptMatch, { status: "processing" });
    return { record: r || record, changed: Boolean(r) };
  }

  // Off-session card attempts never wait for the customer: anything short of success ends them.
  if (isCardAttempt && ["requires_action", "requires_payment_method", "requires_confirmation", "canceled"].includes(pi.status)) {
    if (pi.status !== "canceled") await cancelIntent(pi.id, record._id);
    const failure = pi.status === "requires_action" ? { code: "authentication_required", declineCode: "", message: "The bank wants the customer to approve this payment themselves." } : failureOf(pi);
    const r = await setStatus(record._id, ["charging", "processing"], "failed", { failure, lastStripeSyncAt: new Date() });
    if (attemptMatch) await updateAttempt(record._id, attemptMatch, { status: pi.status === "requires_action" ? "authentication_required" : "failed", errorCode: failure.code, declineCode: failure.declineCode, message: failure.message });
    return { record: r || record, changed: Boolean(r) };
  }

  // A Checkout payment that failed or was abandoned: the customer can try again on the page.
  if (attemptMatch) await updateAttempt(record._id, attemptMatch, { status: pi.status });
  if (pi.status === "canceled" && record.status === "processing" && record.paymentIntentId === pi.id) {
    const r = await setStatus(record._id, "processing", record.paymentLink ? "awaiting_payment" : "failed", { failure: failureOf(pi) });
    return { record: r || record, changed: Boolean(r) };
  }
  return { record, changed: false };
}

/** Expire every Checkout page still open for this record (after it was paid, or before a card attempt). */
async function expireOpenSessions(record, { except = "" } = {}) {
  const sessions = record.attempts.filter((a) => a.kind === "checkout" && a.checkoutSessionId && a.checkoutSessionId !== except && !["expired", "complete", "succeeded"].includes(a.status));
  const outcomes = [];
  for (const a of sessions) {
    try {
      const s = await stripe().checkout.sessions.retrieve(a.checkoutSessionId);
      if (s?.status === "open") {
        await stripe().checkout.sessions.expire(a.checkoutSessionId);
        await updateAttempt(record._id, { checkoutSessionId: a.checkoutSessionId }, { status: "expired" });
        outcomes.push("expired");
      } else if (s?.status === "complete") {
        outcomes.push("complete");
        const piId = idOf(s.payment_intent);
        if (piId) await applyPaymentIntent(await stripe().paymentIntents.retrieve(piId), { source: "expire_check" });
      } else {
        await updateAttempt(record._id, { checkoutSessionId: a.checkoutSessionId }, { status: String(s?.status || "expired") });
      }
    } catch (error) {
      outcomes.push("unknown");
    }
  }
  return outcomes;
}

/**
 * Ask Stripe what really happened to an attempt whose answer we do not have
 * (a timeout, a crash between the request and the save). Re-sending the SAME
 * request with the SAME idempotency key returns the original result, never a
 * second charge; after Stripe's 24h window we search by our metadata.
 */
async function reconcile(record, { force = false } = {}) {
  if (!record) return record;
  if (!force && record.lastStripeSyncAt && Date.now() - new Date(record.lastStripeSyncAt).getTime() < SYNC_MIN_MS) return record;
  await AdditionalCharge.updateOne({ _id: record._id }, { $set: { lastStripeSyncAt: new Date() } });

  if (OPEN_STATES.includes(record.status)) {
    const attempt = [...record.attempts].reverse().find((a) => a.kind === "card");
    if (attempt?.paymentIntentId) {
      const pi = await stripe().paymentIntents.retrieve(attempt.paymentIntentId);
      return (await applyPaymentIntent(pi, { source: "reconcile" })).record;
    }
    if (attempt && Date.now() - new Date(attempt.at).getTime() < UNKNOWN_RETRY_MS) {
      try {
        const pi = await stripe().paymentIntents.create(cardParams(record), { idempotencyKey: attempt.stripeIdempotencyKey });
        await updateAttempt(record._id, { n: attempt.n }, { paymentIntentId: pi.id, status: pi.status });
        return (await applyPaymentIntent(pi, { source: "reconcile_retry" })).record;
      } catch (error) {
        return (await handleCardError(record, attempt, error)) || record;
      }
    }
    const found = await stripe().paymentIntents.search({ query: `metadata['additionalChargeId']:'${record._id}'`, limit: 5 });
    for (const pi of found?.data || []) await applyPaymentIntent(pi, { source: "reconcile_search" });
    return AdditionalCharge.findById(record._id);
  }

  if (record.status === "awaiting_payment" || record.status === "failed") {
    for (const a of record.attempts.filter((x) => x.kind === "checkout" && x.checkoutSessionId)) {
      try {
        const s = await stripe().checkout.sessions.retrieve(a.checkoutSessionId);
        const piId = idOf(s?.payment_intent);
        if (s?.status === "complete" && piId) await applyPaymentIntent(await stripe().paymentIntents.retrieve(piId), { source: "reconcile_checkout" });
        else if (s?.status === "expired") await updateAttempt(record._id, { checkoutSessionId: a.checkoutSessionId }, { status: "expired" });
      } catch (error) {
        /* Stripe unreachable: the record stays as it is */
      }
    }
    return AdditionalCharge.findById(record._id);
  }

  if (PAID_STATES.includes(record.status) && record.chargeId) {
    const details = await chargeDetails(record.chargeId);
    if (typeof details.refundedCents === "number") await applyRefundTotal(record, details.refundedCents);
    if (!record.tax?.transactionId && record.tax?.calculationId) await recordTaxTransaction(record);
    return AdditionalCharge.findById(record._id);
  }
  return record;
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

function cardParams(record) {
  return {
    amount: record.totalCents,
    currency: record.currency,
    customer: record.stripeCustomerId,
    payment_method: record.paymentMethodId,
    off_session: true,
    confirm: true,
    description: `Profixter additional work (${record.number}): ${record.description}`.slice(0, 1000),
    ...(record.receiptEmail ? { receipt_email: record.receiptEmail } : {}),
    metadata: metadataFor(record),
  };
}

async function handleCardError(record, attempt, error) {
  const type = String(error?.type || error?.rawType || "");
  const pi = error?.payment_intent || error?.raw?.payment_intent || null;
  if (pi?.id) await updateAttempt(record._id, { n: attempt.n }, { paymentIntentId: pi.id });
  if (type === "StripeCardError" || type === "card_error") {
    if (pi?.id) await cancelIntent(pi.id, record._id);
    const failure = { code: String(error.code || "card_declined"), declineCode: String(error.decline_code || error.raw?.decline_code || ""), message: String(error.message || "").slice(0, 300) };
    await updateAttempt(record._id, { n: attempt.n }, { status: failure.code === "authentication_required" ? "authentication_required" : "declined", errorCode: failure.code, declineCode: failure.declineCode, message: failure.message });
    return setStatus(record._id, ["charging", "processing"], "failed", { failure });
  }
  if (type === "StripeInvalidRequestError" || type === "invalid_request_error") {
    // Refused before any money moved (bad card attachment, idempotency mismatch...).
    const failure = { code: String(error.code || "invalid_request"), declineCode: "", message: String(error.message || "").slice(0, 300) };
    if (failure.code === "idempotency_key_in_use") return setStatus(record._id, "charging", "processing", {});
    await updateAttempt(record._id, { n: attempt.n }, { status: "refused", errorCode: failure.code, message: failure.message });
    return setStatus(record._id, ["charging", "processing"], "failed", { failure });
  }
  // Timeout, connection reset, Stripe 5xx: the outcome is NOT known. Never shown as failed or paid.
  await updateAttempt(record._id, { n: attempt.n }, { status: "unknown", message: String(error?.message || error).slice(0, 300) });
  return setStatus(record._id, "charging", "processing", {});
}

async function runCardAttempt(record) {
  // Re-check who pays right before Stripe is asked, against what the owner confirmed.
  const booking = await Booking.findById(record.booking);
  const target = booking ? await resolveChargeTarget(booking, { stripe: stripe() }) : null;
  const sameOwner =
    target &&
    target.direct.allowed &&
    sameId(target.user?._id, record.user) &&
    target.customerId === record.stripeCustomerId &&
    target.paymentMethodId === record.paymentMethodId;
  if (!sameOwner) {
    return setStatus(record._id, "charging", "failed", {
      failure: { code: "OWNERSHIP_CHANGED", declineCode: "", message: target?.direct?.message || "Who pays for this visit changed before the charge. Nothing was charged." },
    });
  }

  // Earlier card intents finished, and any Checkout page still open closed, before a new attempt.
  try {
    await settleCardAttempts(record);
  } catch (error) {
    if (!(error instanceof ExtraChargeError)) throw error;
    if (error.code === "ALREADY_PAID" || error.code === "PAYMENT_IN_PROGRESS") return AdditionalCharge.findById(record._id);
    return setStatus(record._id, "charging", "failed", { failure: { code: "EARLIER_ATTEMPT_OPEN", declineCode: "", message: error.message } });
  }
  const outcomes = await expireOpenSessions(record);
  if (outcomes.includes("complete")) return AdditionalCharge.findById(record._id);
  if (outcomes.includes("unknown")) {
    return setStatus(record._id, "charging", record.paymentLink ? "awaiting_payment" : "failed", {
      failure: { code: "LINK_STILL_OPEN", declineCode: "", message: "A payment page for this extra could not be closed, so the card was not charged. Try again in a moment." },
    });
  }
  await closeLinksFor(record);

  const n = record.attempts.length + 1;
  const key = `pfx-xc-${record._id}-a${n}`;
  await AdditionalCharge.updateOne({ _id: record._id }, { $push: { attempts: { n, kind: "card", stripeIdempotencyKey: key, status: "requested", at: new Date() } } });
  const fresh = await AdditionalCharge.findById(record._id);
  const attempt = fresh.attempts.find((a) => a.n === n);
  try {
    const pi = await stripe().paymentIntents.create(cardParams(fresh), { idempotencyKey: key });
    await updateAttempt(record._id, { n }, { paymentIntentId: pi.id, status: pi.status });
    await AdditionalCharge.updateOne({ _id: record._id }, { $set: { paymentIntentId: pi.id } });
    return (await applyPaymentIntent(pi, { source: "api" })).record;
  } catch (error) {
    return handleCardError(fresh, attempt, error);
  }
}

/* ------------------------------------------------------------------ */
/* Payment link                                                        */
/* ------------------------------------------------------------------ */

function linkItemLabel(record) {
  return `additional work on your visit #${String(record.bookingNumber || "").replace(/^#/, "")}: ${record.description}`.slice(0, 200);
}

async function issueLink(record, { send = false, channels = [], admin, contact, user = null, booking = null }) {
  const links = require("../admin/paymentLinks");
  // Every earlier card intent is canceled (or found paid) before a second way to pay exists.
  await settleCardAttempts(record);
  // One live link per extra: older links stop working and their Stripe pages close.
  const outcomes = await expireOpenSessions(record);
  if (outcomes.includes("complete")) throw new ExtraChargeError("ALREADY_PAID", "This extra was just paid. No new link was made.", 409);
  if (outcomes.includes("unknown")) throw new ExtraChargeError("STRIPE_UNAVAILABLE", "An earlier payment page for this extra could not be closed, so no new link was made. Try again in a moment.", 503);
  await closeLinksFor(record);
  const wanted = send ? channels.filter((c) => (c === "email" && contact.email) || (c === "sms" && contact.phone)) : [];
  if (send && wanted.length === 0) throw new ExtraChargeError("NO_CONTACT", "There is no email or mobile number on this visit for that. Copy the link instead.", 409);
  const { link, token, payUrl } = await links.createLink({
    kind: "extra_charge",
    contact: { name: contact.name, email: contact.email, phone: contact.phone, user: record.user ? { _id: record.user } : null, booking: { _id: record.booking, bookingNumber: record.bookingNumber } },
    itemLabel: linkItemLabel(record),
    channels: wanted,
    expiresAt: new Date(Date.now() + LINK_DAYS * 24 * 60 * 60 * 1000),
    admin,
  });
  await AdminPaymentLink.updateOne({ _id: link._id }, { $set: { additionalCharge: record._id } });
  link.additionalCharge = record._id;
  await AdditionalCharge.updateOne({ _id: record._id }, { $set: { paymentLink: link._id } });
  await setStatus(record._id, ["failed", "awaiting_payment", "canceled"], "awaiting_payment", {});
  let delivery = null;
  if (wanted.length) {
    delivery = await links.sendLink({
      link,
      payUrl,
      // The real account and booking, so the existing SMS consent rules decide (guest consent lives on the booking).
      contact: { name: contact.name, user: user || null, booking: booking || { _id: record.booking, bookingNumber: record.bookingNumber } },
    });
  }
  return { link, token, payUrl, delivery };
}

/** The customer pressed Pay on profixter.com/pay/<token>: a fresh Stripe page for the same record. */
async function openCheckoutForLink(link, token) {
  const record = await AdditionalCharge.findById(link.additionalCharge);
  if (!record) throw new ExtraChargeError("LINK_UNAVAILABLE", "This payment link isn't valid anymore.", 410);
  if (PAID_STATES.includes(record.status)) throw new ExtraChargeError("ALREADY_PAID", "This has already been paid. Thank you!", 410, { status: "paid" });
  if (OPEN_STATES.includes(record.status)) throw new ExtraChargeError("PAYMENT_IN_PROGRESS", "A payment for this is already being processed. Please check back in a few minutes.", 409);
  if (record.status !== "awaiting_payment" || !sameId(record.paymentLink, link._id)) throw new ExtraChargeError("LINK_UNAVAILABLE", "This payment link has expired. Please call us for a new one.", 410, { status: "expired" });

  // Still the same booking and the same account it was made for.
  const booking = await Booking.findById(record.booking).select("user userId guestRequestId adminGuest status").lean();
  if (!booking || !sameId(booking.user, record.user)) throw new ExtraChargeError("LINK_UNAVAILABLE", "This payment link has expired. Please call us for a new one.", 410, { status: "expired" });

  // Reuse the page already open for this link, rather than making a second payable one.
  if (link.lastSessionId) {
    try {
      const s = await stripe().checkout.sessions.retrieve(link.lastSessionId);
      if (s?.status === "open" && s.url) return { url: s.url };
      if (s?.status === "complete") {
        const piId = idOf(s.payment_intent);
        if (piId) await applyPaymentIntent(await stripe().paymentIntents.retrieve(piId), { source: "link_open" });
        throw new ExtraChargeError("ALREADY_PAID", "This has already been paid. Thank you!", 410, { status: "paid" });
      }
    } catch (error) {
      if (error instanceof ExtraChargeError) throw error;
      throw new ExtraChargeError("STRIPE_UNAVAILABLE", "Secure checkout could not be opened. Please try again.", 503);
    }
  }
  await settleCardAttempts(record);
  const now = new Date();
  const locked = await AdminPaymentLink.findOneAndUpdate(
    { _id: link._id, status: "open", $or: [{ openingUntil: null }, { openingUntil: { $lt: now } }] },
    { $set: { openingUntil: new Date(now.getTime() + 30 * 1000) } },
    { new: true }
  );
  if (!locked) throw new ExtraChargeError("CHECKOUT_ALREADY_OPENING", "Your secure checkout is already opening. Please wait a moment.", 409);
  try {
    const n = record.attempts.length + 1;
    const line = (amount, name, description) => ({ quantity: 1, price_data: { currency: record.currency, unit_amount: amount, product_data: { name, ...(description ? { description } : {}) } } });
    const lineItems = [line(record.subtotalCents, `Additional work, visit #${String(record.bookingNumber || "").replace(/^#/, "")}`, record.description.slice(0, 500))];
    if (record.taxCents > 0) lineItems.push(line(record.taxCents, `Sales tax${record.tax?.ratePercent ? ` (${Number(record.tax.ratePercent)}%)` : ""}`));
    const expiresAt = Math.floor(Math.min(now.getTime() + 23 * 60 * 60 * 1000, Math.max(new Date(link.expiresAt).getTime(), now.getTime() + 31 * 60 * 1000)) / 1000);
    const metadata = { ...metadataFor(record), adminPaymentLinkId: String(link._id) };
    const session = await stripe().checkout.sessions.create(
      {
        mode: "payment",
        ...(record.stripeCustomerId ? { customer: record.stripeCustomerId } : record.receiptEmail ? { customer_email: record.receiptEmail } : {}),
        line_items: lineItems,
        payment_intent_data: {
          description: `Profixter additional work (${record.number}): ${record.description}`.slice(0, 1000),
          metadata,
          ...(record.receiptEmail ? { receipt_email: record.receiptEmail } : {}),
        },
        metadata,
        client_reference_id: String(record._id),
        success_url: `${clientUrl()}/pay/${token}?paid=1`,
        cancel_url: `${clientUrl()}/pay/${token}`,
        expires_at: expiresAt,
      },
      { idempotencyKey: `pfx-xc-${record._id}-co${n}-${link._id}` }
    );
    await AdditionalCharge.updateOne({ _id: record._id }, { $push: { attempts: { n, kind: "checkout", checkoutSessionId: session.id, status: "open", at: new Date() } } });
    await AdminPaymentLink.updateOne({ _id: link._id }, { $set: { lastSessionId: session.id, openingUntil: null }, $inc: { openedCount: 1 }, $currentDate: { lastOpenedAt: true } });
    return { url: session.url };
  } catch (error) {
    await AdminPaymentLink.updateOne({ _id: link._id }, { $set: { openingUntil: null } });
    throw error;
  }
}

/** What /pay/<token> shows for an extra-charge link. */
async function describeLink(link) {
  const record = link.additionalCharge ? await AdditionalCharge.findById(link.additionalCharge).lean() : null;
  if (!record) return { status: "canceled" };
  if (PAID_STATES.includes(record.status)) return { status: "paid" };
  if (OPEN_STATES.includes(record.status)) return { status: "processing" };
  if (record.status !== "awaiting_payment" || !sameId(record.paymentLink, link._id)) return { status: "expired" };
  return { status: link.status === "open" && new Date(link.expiresAt) > new Date() ? "open" : "expired", amountCents: record.totalCents };
}

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

const isExtraChargeObject = (obj) => obj?.metadata?.productKind === PRODUCT_KIND && mongoose.isValidObjectId(String(obj?.metadata?.additionalChargeId || ""));

async function handleCheckoutSession(session) {
  if (!isExtraChargeObject(session)) return { ignored: true };
  await updateAttempt(session.metadata.additionalChargeId, { checkoutSessionId: session.id }, { status: session.status === "complete" ? "complete" : String(session.status || "") });
  const piId = idOf(session.payment_intent);
  if (session.status === "complete" && piId) return applyPaymentIntent(await stripe().paymentIntents.retrieve(piId), { source: "webhook_checkout" });
  return { changed: false };
}

async function handlePaymentIntentEvent(pi) {
  if (!isExtraChargeObject(pi)) return { ignored: true };
  return applyPaymentIntent(pi, { source: "webhook_pi" });
}

async function applyRefundTotal(record, refundedCents) {
  const total = Number(record.totalCents);
  const refunded = Math.max(0, Math.min(Number(refundedCents || 0), total));
  if (refunded === Number(record.refundedCents || 0) && (refunded === 0 || record.status !== "paid")) return record;
  const status = refunded >= total ? "refunded" : refunded > 0 ? "partially_refunded" : "paid";
  const updated = await AdditionalCharge.findOneAndUpdate(
    { _id: record._id, status: { $in: PAID_STATES }, refundedCents: { $lte: refunded } },
    { $set: { refundedCents: refunded, status, statusChangedAt: new Date() } },
    { new: true }
  );
  if (updated && updated.tax?.transactionId && refunded > Number(record.refundedCents || 0)) {
    const delta = refunded - Number(record.refundedCents || 0);
    try {
      const reversal = await stripe().tax.transactions.createReversal(
        refunded >= total
          ? { mode: "full", original_transaction: updated.tax.transactionId, reference: `${updated.number}-refund-${refunded}` }
          : { mode: "partial", original_transaction: updated.tax.transactionId, reference: `${updated.number}-refund-${refunded}`, flat_amount: -delta },
        { idempotencyKey: `pfx-xc-${updated._id}-rev-${refunded}` }
      );
      await AdditionalCharge.updateOne({ _id: updated._id }, { $push: { "tax.reversals": { refundedCents: refunded, transactionId: String(reversal.id || ""), at: new Date() } } });
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "extra_charge_tax_reversal_failed", additionalChargeId: String(updated._id), message: String(error?.message || error).slice(0, 200) }));
    }
  }
  return updated || record;
}

async function handleChargeRefunded(charge) {
  const piId = idOf(charge?.payment_intent);
  if (!piId && !charge?.id) return { ignored: true };
  const record = await AdditionalCharge.findOne({ $or: [{ paymentIntentId: piId || "__none__" }, { chargeId: charge.id }] });
  if (!record) return { ignored: true };
  if (record.paymentIntentId !== piId) return { ignored: true, reason: "refund_of_extra_payment" };
  return { record: await applyRefundTotal(record, charge.amount_refunded) };
}

/* ------------------------------------------------------------------ */
/* Owner actions                                                       */
/* ------------------------------------------------------------------ */

function actingAdmin(req) {
  const a = req.accessUser || req.authUser || {};
  return { _id: a._id || req.user?.id || null, name: a.name || a.email || "", email: a.email || "" };
}

function assertOwner(req) {
  if (req?.accessRole !== "admin") throw new ExtraChargeError("OWNER_ONLY", "Only the owner can charge extras.", 403);
}

async function create(req, bookingId, body = {}) {
  assertOwner(req);
  const { readIdempotencyKey } = require("../adminIdempotency");
  const clientKey = readIdempotencyKey(body.idempotencyKey);
  const booking = await loadChargeableBooking(bookingId);
  const input = readInput(body);
  const method = body.method === "link" ? "link" : body.method === "card" ? "card" : "";
  if (!method) throw new ExtraChargeError("METHOD_REQUIRED", "Choose Charge card or Payment link.");

  // The same intent again (a double tap, a retry after a timeout): the same record, resolved.
  const existing = await AdditionalCharge.findOne({ booking: booking._id, clientKey });
  if (existing) {
    if (existing.description !== input.description || existing.subtotalCents !== input.subtotalCents) {
      throw new ExtraChargeError("KEY_REUSED", "This request was already used for a different charge.", 409);
    }
    return { record: await reconcile(existing, { force: true }), replayed: true };
  }

  if (body.customerAgreed !== true) {
    throw new ExtraChargeError("CONFIRMATION_REQUIRED", "Confirm that the customer agreed to this work and this total.", 428);
  }
  const { target, tax, preview: p } = await buildPreview(booking, input);
  if (!tax || p.totalCents === null) throw new ExtraChargeError(p.tax.code || "TAX_UNAVAILABLE", p.tax.message || "The tax could not be worked out.", 409, { preview: p });
  if (String(body.previewFingerprint || "") !== p.fingerprint || Number(body.expectedTotalCents) !== p.totalCents) {
    throw new ExtraChargeError("PREVIEW_CHANGED", "Something changed since you reviewed this (the card, the customer or the tax). Review the new details.", 409, { preview: p });
  }
  if (method === "card" && !p.direct.allowed) throw new ExtraChargeError(p.direct.code || "DIRECT_UNAVAILABLE", p.direct.message || "The card cannot be charged.", 409, { preview: p });
  if (method === "link" && !p.link.allowed) throw new ExtraChargeError(p.link.code || "LINK_UNAVAILABLE", p.link.message || "A payment link cannot be made.", 409, { preview: p });

  const admin = actingAdmin(req);
  const now = new Date();
  const record = await insertRecord({
    booking: booking._id,
    bookingNumber: String(booking.bookingNumber || "").replace(/^#/, ""),
    clientKey,
    user: target.user?._id || null,
    accountUserId: target.accountUserId,
    guest: target.guest,
    stripeCustomerId: target.customerLinked ? target.customerId : "",
    customerName: target.customerName,
    serviceAddress: target.serviceAddress,
    receiptEmail: target.contact.email || "",
    description: input.description,
    subtotalCents: input.subtotalCents,
    taxCents: tax.taxCents,
    totalCents: input.subtotalCents + tax.taxCents,
    tax: {
      treatment: tax.treatment,
      source: tax.source,
      calculationId: tax.calculationId,
      calculationExpiresAt: tax.calculationExpiresAt,
      taxCode: tax.taxCode,
      taxabilityReason: tax.taxabilityReason,
      ratePercent: tax.ratePercent,
    },
    consent: {
      statement: p.consentStatement,
      confirmedBy: admin._id,
      confirmedByName: admin.name,
      confirmedAt: now,
      description: input.description,
      totalCents: input.subtotalCents + tax.taxCents,
      writtenApprovalRef: input.writtenApprovalRef,
    },
    method,
    status: method === "card" ? "charging" : "awaiting_payment",
    paymentMethodId: method === "card" ? target.paymentMethodId : "",
    card: method === "card" && target.card ? target.card : {},
    createdBy: admin._id,
    createdByName: admin.name,
  });
  if (!record) {
    const winner = await AdditionalCharge.findOne({ booking: booking._id, clientKey });
    return { record: await reconcile(winner, { force: true }), replayed: true };
  }

  if (method === "card") return { record: await runCardAttempt(record), replayed: false };
  const sent = await issueLink(record, { send: body.send === true, channels: readChannels(body.channels), admin, contact: target.contact, user: target.user, booking });
  return { record: await AdditionalCharge.findById(record._id), payUrl: sent.payUrl, delivery: sent.delivery, replayed: false };
}

function readChannels(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(list.map((v) => String(v).trim()).filter((v) => v === "email" || v === "sms"))];
}

async function loadRecord(bookingId, chargeId) {
  if (!mongoose.isValidObjectId(bookingId) || !mongoose.isValidObjectId(chargeId)) throw new ExtraChargeError("NOT_FOUND", "Charge not found", 404);
  const record = await AdditionalCharge.findOne({ _id: chargeId, booking: bookingId });
  if (!record) throw new ExtraChargeError("NOT_FOUND", "Charge not found", 404);
  return record;
}

/** Try the saved card again, after a decline the customer has fixed. Never automatic. */
async function retryCard(req, bookingId, chargeId, body = {}) {
  assertOwner(req);
  const record = await loadRecord(bookingId, chargeId);
  if (record.status !== "failed" && record.status !== "awaiting_payment") throw new ExtraChargeError("INVALID_STATE", `This charge is ${record.status.replace(/_/g, " ")}; it cannot be charged again.`, 409);
  const booking = await loadChargeableBooking(bookingId);
  const target = await resolveChargeTarget(booking, { stripe: stripe() });
  if (!target.direct.allowed) throw new ExtraChargeError(target.direct.code, target.direct.message, 409);
  if (!sameId(target.user?._id, record.user) || (record.stripeCustomerId && target.customerId !== record.stripeCustomerId)) {
    throw new ExtraChargeError("OWNERSHIP_CHANGED", "Who pays for this visit changed since the charge was made. Make a new charge.", 409);
  }
  if (String(body.expectedCardLast4 || "") !== String(target.card?.last4 || "")) {
    throw new ExtraChargeError("PREVIEW_CHANGED", "The saved card changed. Review it and try again.", 409, { card: target.card });
  }
  const claimed = await setStatus(record._id, record.status, "charging", {
    stripeCustomerId: target.customerId,
    paymentMethodId: target.paymentMethodId,
    card: target.card,
    failure: { code: "", declineCode: "", message: "" },
  });
  if (!claimed) throw new ExtraChargeError("INVALID_STATE", "This charge changed. Refresh it.", 409);
  return runCardAttempt(claimed);
}

async function paymentLink(req, bookingId, chargeId, body = {}) {
  assertOwner(req);
  const record = await loadRecord(bookingId, chargeId);
  if (!["failed", "awaiting_payment"].includes(record.status)) throw new ExtraChargeError("INVALID_STATE", `This charge is ${record.status.replace(/_/g, " ")}; no link is needed.`, 409);
  const booking = await loadChargeableBooking(bookingId);
  const target = await resolveChargeTarget(booking, { stripe: stripe() });
  if (!target.link.allowed) throw new ExtraChargeError(target.link.code, target.link.message, 409);
  if (!sameId(target.user?._id, record.user)) throw new ExtraChargeError("OWNERSHIP_CHANGED", "Who this visit belongs to changed since the charge was made. Make a new charge.", 409);
  const sent = await issueLink(record, { send: body.send === true, channels: readChannels(body.channels), admin: actingAdmin(req), contact: target.contact, user: target.user, booking });
  return { record: await AdditionalCharge.findById(record._id), payUrl: sent.payUrl, delivery: sent.delivery };
}

async function cancelCharge(req, bookingId, chargeId) {
  assertOwner(req);
  const record = await loadRecord(bookingId, chargeId);
  if (!["failed", "awaiting_payment"].includes(record.status)) throw new ExtraChargeError("INVALID_STATE", "Only an unpaid charge can be closed.", 409);
  await settleCardAttempts(record);
  const outcomes = await expireOpenSessions(record);
  if (outcomes.includes("complete")) return AdditionalCharge.findById(record._id);
  if (outcomes.includes("unknown")) throw new ExtraChargeError("STRIPE_UNAVAILABLE", "A payment page could not be closed. Nothing was changed; try again.", 503);
  await closeLinksFor(record);
  return (await setStatus(record._id, ["failed", "awaiting_payment"], "canceled", {})) || AdditionalCharge.findById(record._id);
}

async function listForBooking(bookingId, { sync = true } = {}) {
  const records = await AdditionalCharge.find({ booking: bookingId }).sort({ seq: 1 });
  if (sync) {
    for (const r of records) {
      if (OPEN_STATES.includes(r.status) || r.status === "awaiting_payment" || (PAID_STATES.includes(r.status) && !r.tax?.transactionId && r.tax?.calculationId)) {
        try {
          await reconcile(r);
        } catch (error) {
          /* Stripe unreachable: show what we have */
        }
      }
    }
  }
  return AdditionalCharge.find({ booking: bookingId }).sort({ seq: 1 }).populate("paymentLink", "status expiresAt sentVia delivery createdAt").lean();
}

/* ------------------------------------------------------------------ */
/* Read model                                                          */
/* ------------------------------------------------------------------ */

const STATUS_LABEL = {
  charging: "Processing",
  processing: "Processing",
  awaiting_payment: "Awaiting payment",
  paid: "Paid",
  failed: "Failed",
  partially_refunded: "Partly refunded",
  refunded: "Refunded",
  canceled: "Closed, not paid",
};

const FAILURE_TEXT = {
  authentication_required: "The customer's bank wants them to approve this payment themselves. Send them a payment link.",
  card_declined: "The card was declined.",
  expired_card: "The card has expired.",
  insufficient_funds: "The card was declined: insufficient funds.",
  incorrect_cvc: "The card was declined (security code).",
  processing_error: "The card could not be processed. Nothing was charged.",
  OWNERSHIP_CHANGED: "Who pays for this visit changed before the charge, so nothing was charged.",
  LINK_STILL_OPEN: "A payment page for this extra could not be closed, so the card was not charged.",
};

function failureText(f) {
  if (!f?.code) return "";
  const decline = f.declineCode && FAILURE_TEXT[f.declineCode] ? FAILURE_TEXT[f.declineCode] : "";
  return decline || FAILURE_TEXT[f.code] || f.message || "The payment did not go through. Nothing was charged.";
}

function serialize(r) {
  if (!r) return null;
  const x = typeof r.toObject === "function" ? r.toObject() : r;
  const link = x.paymentLink && typeof x.paymentLink === "object" && x.paymentLink.status ? x.paymentLink : null;
  const canAct = ["failed", "awaiting_payment"].includes(x.status);
  return {
    id: String(x._id),
    number: x.number,
    description: x.description,
    subtotalCents: x.subtotalCents,
    taxCents: x.taxCents,
    totalCents: x.totalCents,
    tax: { treatment: x.tax?.treatment || "", source: x.tax?.source || "", ratePercent: x.tax?.ratePercent || "", taxCode: x.tax?.taxCode || "", recorded: Boolean(x.tax?.transactionId), recordError: x.tax?.transactionError || "" },
    status: x.status,
    statusLabel: STATUS_LABEL[x.status] || x.status,
    method: x.method,
    createdAt: x.createdAt,
    createdByName: x.createdByName || "",
    consent: { statement: x.consent?.statement || "", confirmedByName: x.consent?.confirmedByName || "", confirmedAt: x.consent?.confirmedAt || null, writtenApprovalRef: x.consent?.writtenApprovalRef || "" },
    customerName: x.customerName || "",
    guest: Boolean(x.guest),
    card: x.card?.last4 ? { brand: x.card.brand || "", last4: x.card.last4 } : null,
    paidAt: x.paidAt || null,
    failure: x.failure?.code ? { code: x.failure.code, declineCode: x.failure.declineCode || "", message: failureText(x.failure) } : null,
    refundedCents: Number(x.refundedCents || 0),
    stripeUrl: x.paymentIntentId ? dashboardUrl(`payments/${x.paymentIntentId}`) : "",
    receiptUrl: x.receiptUrl || "",
    extraPayments: (x.extraPayments || []).map((p) => ({ amountCents: p.amountCents, stripeUrl: dashboardUrl(`payments/${p.paymentIntentId}`), at: p.at })),
    link: link ? { status: link.status, expiresAt: link.expiresAt, sentVia: link.sentVia || [], delivery: link.delivery || null } : null,
    actions: canAct ? ["retryCard", "paymentLink", "copyLink", "close"].filter((a) => a !== "retryCard" || Boolean(x.stripeCustomerId)) : [],
  };
}

module.exports = {
  ExtraChargeError,
  MAX_CENTS,
  MIN_CENTS,
  PRODUCT_KIND,
  applyPaymentIntent,
  cancelCharge,
  create,
  describeLink,
  handleChargeRefunded,
  handleCheckoutSession,
  handlePaymentIntentEvent,
  isExtraChargeObject,
  listForBooking,
  openCheckoutForLink,
  paymentLink,
  preview,
  readAmountCents,
  reconcile,
  retryCard,
  serialize,
  setStripeClient,
  settleCardAttempts,
};
