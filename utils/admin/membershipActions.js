/**
 * Admin membership changes that move money or end a membership, made safe.
 *
 * Before this, one tap on the plan dropdown in the customer list charged the
 * card (an upgrade invoices the proration at once), scheduled a cancellation,
 * or - for a home with no active subscription, including a past-due one -
 * wrote a free, open-ended "admin-panel" membership. Nothing asked first,
 * nothing showed the amount, and nothing stopped a double tap.
 *
 * Now:
 *   PLAN CHANGE   preview -> confirm. The preview asks Stripe what it would
 *                 charge now (an invoice preview with the same proration the
 *                 change uses) and returns a short-lived signed token bound to
 *                 that exact state. Confirm re-reads the membership; if
 *                 anything changed it refuses (409 STALE) and nothing happens.
 *                 Confirm carries an idempotency key: a repeat returns the
 *                 first answer and Stripe is called once (each Stripe step
 *                 also carries a key derived from it).
 *   CANCELLATION  period end / a chosen date / clear, with explicit confirm,
 *                 an idempotency key and an audit entry with before and after.
 *   COMPLIMENTARY owner only, reason required, explicit confirm, and refused
 *                 while any membership on the home has not ended (ours or one
 *                 Stripe is still billing). Never a fallback for a failing one.
 *
 * Every mutation writes an AdminActivityLog entry with actor, before and after.
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const User = require("../../models/User");
const Subscription = require("../../models/Subscription");
const CustomerActionReceipt = require("../../models/CustomerActionReceipt");
const { createAdminActivityLog } = require("../adminActivityLog");
const { formatAddressLine } = require("../formatAddress");
const sm = require("../subscriptionManagement");
const { NON_ENDED_STATUSES, cancelAtFor, planSummary } = require("./planStatus");

const PREVIEW_TTL_SECONDS = 10 * 60;
const PREVIEW_PURPOSE = "admin_plan_change_preview";
const ADMIN_EMAIL = () => String(process.env.MAIL_ADMIN || "getfixter@gmail.com").toLowerCase();

class MembershipActionError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const fail = (status, code, message, extra) => {
  throw new MembershipActionError(status, code, message, extra);
};

function previewSecret() {
  const base = process.env.ADMIN_PREVIEW_SECRET || process.env.JWT_SECRET;
  if (!base) throw new Error("JWT_SECRET is not configured");
  return `${base}:${PREVIEW_PURPOSE}`;
}

function isStaffAccount(user) {
  return (
    String(user?.email || "").toLowerCase() === ADMIN_EMAIL() ||
    user?.role === "admin" ||
    user?.role === "employee" ||
    Boolean(user?.employeePosition)
  );
}

function actorOf(req) {
  const a = req?.accessUser || req?.authUser || {};
  return { id: a._id || req?.user?.id || null, name: a.name || a.email || "Admin" };
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
function readIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!KEY_PATTERN.test(key)) {
    fail(400, "IDEMPOTENCY_KEY_REQUIRED", "Send an idempotencyKey (a UUID made once per confirm).");
  }
  return key;
}

/* ------------------------------------------------------------------ state */

async function loadHome({ userId, addressId }) {
  if (!mongoose.isValidObjectId(String(userId || ""))) fail(400, "INVALID_ID", "Invalid customer id.");
  if (!mongoose.isValidObjectId(String(addressId || ""))) fail(400, "INVALID_ID", "Invalid address id.");
  const user = await User.findById(userId);
  if (!user) fail(404, "NOT_FOUND", "Customer not found.");
  if (isStaffAccount(user)) fail(403, "FORBIDDEN_RECORD", "Only customer accounts.");
  const address = user.addresses.id(addressId);
  if (!address) fail(404, "ADDRESS_NOT_FOUND", "Address not found.");
  const live = await Subscription.find({ user: user._id, addressId: address._id, status: { $in: NON_ENDED_STATUSES } });
  const current = sm.selectCurrentSubscription(live);
  return { user, address, current, live };
}

function centsOf(price, fallbackPlan, fallbackCycle) {
  if (price && Number.isFinite(Number(price.unit_amount))) return Number(price.unit_amount);
  return Math.round(sm.getPlanPrice(fallbackPlan, fallbackCycle) * 100);
}

function toIso(value) {
  const date = sm.toDate(value);
  return date ? date.toISOString() : null;
}

/** Everything a confirmed change depends on. If any of it moves, the preview is stale. */
function fingerprintOf({ local, stripeSubscription, itemPriceId, requestedPriceId }) {
  const parts = [
    String(local._id),
    local.updatedAt ? new Date(local.updatedAt).toISOString() : "",
    String(local.status || ""),
    stripeSubscription.id,
    String(stripeSubscription.status || ""),
    String(itemPriceId || ""),
    String(requestedPriceId || ""),
    String(stripeSubscription.cancel_at || ""),
    String(Boolean(stripeSubscription.cancel_at_period_end)),
    String(sm.getStripeScheduleId(stripeSubscription) || ""),
    String(stripeSubscription.current_period_end || ""),
  ];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * Resolve everything a plan change needs, refusing anything that is not a
 * plain Stripe-billed membership in good standing. Used by preview AND confirm,
 * so confirm re-checks every rule against the state at that moment.
 */
async function planChangeState({ userId, addressId, plan, cycle }) {
  const { user, address, current } = await loadHome({ userId, addressId });
  if (!current) {
    fail(409, "NO_MEMBERSHIP", "This home has no membership to change. Sell a membership instead.");
  }
  const status = String(current.status || "").toLowerCase();
  if (!["active", "trialing"].includes(status)) {
    fail(409, "PAYMENT_ISSUE", "This membership has a payment problem. Resolve the payment in Stripe before changing the plan.", { stripeStatus: status });
  }
  if (!current.stripeSubscriptionId) {
    fail(409, "NOT_STRIPE_MANAGED", "This membership is not billed through Stripe, so there is nothing to change at Stripe.");
  }
  if (cancelAtFor(current)) {
    fail(409, "CANCELLATION_SCHEDULED", "A cancellation is scheduled for this membership. Clear it before changing the plan.");
  }
  const targetPlan = sm.normalizePlanType(plan);
  if (!targetPlan) fail(400, "INVALID_PLAN", "Choose basic, plus, premium or elite.");
  const targetCycle = sm.normalizeBillingCycle(cycle || current.billingCycle, current.billingCycle || "monthly");

  let stripeSubscription;
  try {
    stripeSubscription = await sm.resolveStripeSubscriptionForRecord({ subscription: current, user });
  } catch (error) {
    fail(502, "STRIPE_UNAVAILABLE", "Stripe could not be reached. Nothing was changed. Try again.");
  }
  if (!stripeSubscription) {
    fail(409, "STRIPE_LINK_UNCERTAIN", "This membership could not be matched to one Stripe subscription with certainty, so it cannot be changed here.");
  }
  const stripeStatus = sm.normalizeStripeStatus(stripeSubscription.status);
  if (!["active", "trialing"].includes(stripeStatus)) {
    fail(409, "PAYMENT_ISSUE", "Stripe reports a payment problem on this membership. Resolve it in Stripe first.", { stripeStatus });
  }
  if (stripeSubscription.cancel_at || stripeSubscription.cancel_at_period_end) {
    fail(409, "CANCELLATION_SCHEDULED", "Stripe has a cancellation scheduled for this membership. Clear it before changing the plan.");
  }
  const item = sm.getStripeSubscriptionItemForRecord({ subscription: current, stripeSubscription });
  if (!item?.id || !item?.price?.id) fail(409, "STRIPE_LINK_UNCERTAIN", "The Stripe subscription item for this membership was not found.");

  const currentPlan = sm.normalizePlanType(current.subscriptionType);
  const currentCycle = sm.normalizeBillingCycle(current.billingCycle, "monthly");
  const changeType = sm.classifyPlanChange({ currentPlan, currentBillingCycle: currentCycle, targetPlan, targetBillingCycle: targetCycle });
  if (changeType === "same") fail(400, "NO_CHANGE", "That is already this home's plan.");

  const { priceId: requestedPriceId } = await sm.resolveStripePriceId({ plan: targetPlan, billingCycle: targetCycle });
  if (!requestedPriceId) fail(409, "PRICE_MAPPING_NOT_FOUND", "No Stripe price is configured for that plan.");

  return { user, address, current, stripeSubscription, item, currentPlan, currentCycle, targetPlan, targetCycle, changeType, requestedPriceId };
}

/* ---------------------------------------------------------------- preview */

async function previewPlanChange({ userId, addressId, plan, cycle, now = new Date() }) {
  const state = await planChangeState({ userId, addressId, plan, cycle });
  const { user, address, current, stripeSubscription, item, currentPlan, currentCycle, targetPlan, targetCycle, changeType, requestedPriceId } = state;
  const warnings = [];

  let requestedPrice = null;
  try {
    requestedPrice = await sm.stripe.prices.retrieve(requestedPriceId);
  } catch (error) {
    fail(502, "STRIPE_UNAVAILABLE", "Stripe could not be reached. Nothing was changed. Try again.");
  }
  const currentPriceCents = centsOf(item.price, currentPlan, currentCycle);
  const requestedPriceCents = centsOf(requestedPrice, targetPlan, targetCycle);

  let amountDueNowCents = 0;
  let creditCents = 0;
  let nextRenewalDate = toIso(stripeSubscription.current_period_end);
  let effective = "period_end";

  if (changeType === "upgrade") {
    effective = "now";
    let invoice;
    try {
      invoice = await sm.stripe.invoices.createPreview({
        customer: String(stripeSubscription.customer),
        subscription: stripeSubscription.id,
        subscription_details: {
          items: [{ id: item.id, price: requestedPriceId }],
          proration_behavior: "always_invoice",
          proration_date: Math.floor(now.getTime() / 1000),
        },
      });
    } catch (error) {
      fail(502, "STRIPE_UNAVAILABLE", "Stripe could not price this change. Nothing was changed. Try again.");
    }
    amountDueNowCents = Math.max(0, Number(invoice?.amount_due || 0));
    const lines = invoice?.lines?.data || [];
    creditCents = lines.reduce((sum, line) => sum + (Number(line.amount) < 0 ? -Number(line.amount) : 0), 0);
    if (currentCycle !== targetCycle) {
      const ends = lines.map((line) => Number(line?.period?.end || 0)).filter(Boolean);
      if (ends.length) nextRenewalDate = toIso(Math.max(...ends));
      warnings.push({ code: "BILLING_CYCLE_CHANGES", message: "The billing cycle changes, so the renewal date moves." });
    }
    if (Number(invoice?.tax || 0) > 0) {
      warnings.push({ code: "INCLUDES_TAX", message: "The amount due now includes sales tax." });
    }
    if (amountDueNowCents > 0) {
      warnings.push({ code: "CHARGES_NOW", message: "The card on file is charged this amount as soon as you confirm." });
    }
  } else {
    warnings.push({ code: "STARTS_AT_RENEWAL", message: "Nothing is charged now. The new plan starts at the next renewal." });
  }
  if (current.pendingPlan) {
    warnings.push({ code: "REPLACES_SCHEDULED_CHANGE", message: `This replaces the change to ${current.pendingPlan} already scheduled.` });
  }
  if (stripeSubscription.status === "trialing") {
    warnings.push({ code: "IN_TRIAL", message: "This membership is in a trial; Stripe bills from the trial end." });
  }
  if (stripeSubscription.discount || (Array.isArray(stripeSubscription.discounts) && stripeSubscription.discounts.length)) {
    warnings.push({ code: "DISCOUNT_APPLIES", message: "A discount is on this membership; the renewal amount shown is before it." });
  }

  const fp = fingerprintOf({ local: current, stripeSubscription, itemPriceId: item.price.id, requestedPriceId });
  const expiresAt = new Date(now.getTime() + PREVIEW_TTL_SECONDS * 1000);
  const previewToken = jwt.sign(
    {
      p: PREVIEW_PURPOSE,
      u: String(user._id),
      a: String(address._id),
      s: String(current._id),
      plan: targetPlan,
      cycle: targetCycle,
      changeType,
      due: amountDueNowCents,
      fp,
    },
    previewSecret(),
    { expiresIn: PREVIEW_TTL_SECONDS }
  );

  return {
    previewToken,
    expiresAt: expiresAt.toISOString(),
    changeType,
    current: {
      plan: currentPlan,
      cycle: currentCycle,
      priceCents: currentPriceCents,
      status: String(current.status),
      currentPeriodEnd: toIso(stripeSubscription.current_period_end) || toIso(current.currentPeriodEnd),
    },
    requested: { plan: targetPlan, cycle: targetCycle, priceCents: requestedPriceCents },
    amountDueNowCents,
    creditCents,
    nextRenewalDate,
    nextRenewalAmountCents: requestedPriceCents,
    effective,
    warnings,
  };
}

/* ------------------------------------------------------------ idempotency */

/**
 * Run fn once per idempotency key. A repeat returns the stored answer.
 * A refusal raised before anything was done (MembershipActionError) frees the
 * key again, so the same key can be retried after, say, a fresh preview.
 */
async function withReceipt({ scope, key, req, targetUserId, targetAddressId = null }, fn) {
  /*
   * Review fix 9 (2026-11-13): the stored key is bound to the action, the
   * customer AND the home. The same client key sent for another customer or
   * another home never replays the first answer: it gets 409 KEY_REUSED and
   * nothing is done (a client sends a fresh UUID per action).
   */
  const fullKey = `${scope}:${key}`;
  const target = `${String(targetUserId || "")}:${String(targetAddressId || "")}`;
  try {
    await CustomerActionReceipt.create({ key: fullKey, scope, actorUserId: actorOf(req).id, targetUserId, target });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await CustomerActionReceipt.findOne({ key: fullKey }).lean();
    const sameTarget = existing && (existing.target ? existing.target === target : String(existing.targetUserId || "") === String(targetUserId || ""));
    if (existing && !sameTarget) {
      return { status: 409, body: { code: "KEY_REUSED", message: "This idempotency key was already used for a different customer or home. Nothing was changed." } };
    }
    if (existing?.status === "done") return { status: existing.httpStatus || 200, body: { ...(existing.body || {}), replayed: true } };
    return { status: 409, body: { code: "IN_PROGRESS", message: "This action is already being processed." } };
  }

  let outcome;
  try {
    outcome = { status: 200, body: await fn() };
  } catch (error) {
    if (error instanceof MembershipActionError) {
      await CustomerActionReceipt.deleteOne({ key: fullKey }).catch(() => {});
      throw error;
    }
    console.error(JSON.stringify({ level: "error", event: "admin_membership_action_failed", scope, message: error?.message || String(error) }));
    const status = Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 600 ? Number(error.statusCode) : 502;
    outcome = {
      status,
      body: {
        code: error?.code === "stripe_upgrade_payment_incomplete" ? "PAYMENT_INCOMPLETE" : "STRIPE_ERROR",
        message: error?.code === "stripe_upgrade_payment_incomplete" ? error.message : "Stripe refused or could not complete the change. Check the Stripe dashboard before trying again.",
      },
    };
  }
  await CustomerActionReceipt.updateOne({ key: fullKey }, { $set: { status: "done", httpStatus: outcome.status, body: outcome.body } });
  return outcome;
}

/* ---------------------------------------------------------------- confirm */

function readPreviewToken(token, { userId, addressId }) {
  let payload;
  try {
    payload = jwt.verify(String(token || ""), previewSecret());
  } catch (error) {
    if (error?.name === "TokenExpiredError") fail(409, "PREVIEW_EXPIRED", "This preview has expired. Preview the change again.");
    fail(400, "INVALID_PREVIEW", "This preview is not valid. Preview the change again.");
  }
  if (payload.p !== PREVIEW_PURPOSE || payload.u !== String(userId) || payload.a !== String(addressId)) {
    fail(400, "INVALID_PREVIEW", "This preview is for a different membership.");
  }
  return payload;
}

async function confirmPlanChange({ userId, addressId, previewToken, idempotencyKey, req }) {
  const key = readIdempotencyKey(idempotencyKey);
  return withReceipt({ scope: "plan_change", key, req, targetUserId: userId, targetAddressId: addressId }, async () => {
    const payload = readPreviewToken(previewToken, { userId, addressId });
    let state;
    try {
      state = await planChangeState({ userId, addressId, plan: payload.plan, cycle: payload.cycle });
    } catch (error) {
      // Anything that no longer qualifies (a cancel was scheduled, a payment failed) is a stale preview.
      if (error instanceof MembershipActionError && error.status === 409) {
        fail(409, "STALE", "The membership changed since the preview. Preview the change again.", { reason: error.code });
      }
      throw error;
    }
    const { user, address, current, stripeSubscription, item, requestedPriceId, changeType, currentPlan, currentCycle } = state;
    const fp = fingerprintOf({ local: current, stripeSubscription, itemPriceId: item.price.id, requestedPriceId });
    if (fp !== payload.fp || String(current._id) !== payload.s || changeType !== payload.changeType) {
      fail(409, "STALE", "The membership changed since the preview. Preview the change again.");
    }

    const args = { stripeSubscription, subscription: current, user, addressId: String(address._id), nextPriceId: requestedPriceId, idempotencyKey: `pfx_plan_${key}` };
    const updated = changeType === "upgrade" ? await sm.applyStripeSubscriptionUpgrade(args) : await sm.scheduleStripeSubscriptionDowngrade(args);
    await sm.upsertSubscriptionFromStripe({ stripeSubscription: updated, user, addressIdHint: String(address._id) });

    const after = await Subscription.findById(current._id).lean();
    await createAdminActivityLog(req, {
      action: "Plan Changed",
      entityType: "Subscription",
      entityId: current._id,
      entityName: `${user.name || user.userId} - ${address.line1}`,
      details: {
        customerUserId: String(user._id),
        customerName: user.name,
        addressId: String(address._id),
        address: formatAddressLine(address),
        changeType,
        effective: changeType === "upgrade" ? "now" : "period_end",
        before: { plan: currentPlan, cycle: currentCycle },
        after: { plan: payload.plan, cycle: payload.cycle, pendingPlan: after?.pendingPlan || null },
        amountDueNowCents: payload.due,
        idempotencyKey: key,
        source: "admin_plan_change_confirmed",
      },
    });
    return {
      message: changeType === "upgrade" ? "Plan changed in Stripe." : "Plan change scheduled for the next renewal.",
      changeType,
      effective: changeType === "upgrade" ? "now" : "period_end",
      addressPlan: planSummary(after),
    };
  });
}

/* ----------------------------------------------------------- cancellation */

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
function nyToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

async function setCancellation({ userId, addressId, mode, date, confirm, idempotencyKey, releasePendingPlanChange = false, req }) {
  if (confirm !== true) fail(428, "CONFIRMATION_REQUIRED", "Confirm the cancellation change (confirm: true).");
  if (!["period_end", "date", "clear"].includes(mode)) fail(400, "INVALID_MODE", "mode must be period_end, date or clear.");
  const key = readIdempotencyKey(idempotencyKey);

  return withReceipt({ scope: "cancellation", key, req, targetUserId: userId, targetAddressId: addressId }, async () => {
    const { user, address, current } = await loadHome({ userId, addressId });
    if (!current) fail(409, "NO_MEMBERSHIP", "This home has no membership.");
    const before = { cancelAt: toIso(cancelAtFor(current)), cancelAtPeriodEnd: Boolean(current.cancelAtPeriodEnd) };

    let cancelAtDate = null;
    if (mode === "date") {
      const m = YMD.exec(String(date || ""));
      if (!m) fail(400, "INVALID_DATE", "date must be YYYY-MM-DD.");
      if (String(date) < nyToday()) fail(400, "DATE_IN_PAST", "Choose today or a later date.");
      // The end of that day in New York: 05:00 UTC the next day (covers EST and EDT), as before.
      cancelAtDate = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1, 5, 0, 0));
    }
    if (mode === "clear" && !before.cancelAt && !before.cancelAtPeriodEnd) {
      fail(409, "NOTHING_SCHEDULED", "No cancellation is scheduled for this membership.");
    }

    const stripeKey = `pfx_cancel_${key}`;
    if (current.stripeSubscriptionId) {
      let stripeSubscription;
      try {
        stripeSubscription = await sm.resolveStripeSubscriptionForRecord({ subscription: current, user });
      } catch (error) {
        fail(502, "STRIPE_UNAVAILABLE", "Stripe could not be reached. Nothing was changed. Try again.");
      }
      if (!stripeSubscription) fail(409, "STRIPE_LINK_UNCERTAIN", "This membership could not be matched to one Stripe subscription with certainty.");

      let target = stripeSubscription;
      let params;
      if (mode === "period_end") {
        target = (await sm.clearStripeSubscriptionSchedule(stripeSubscription, { idempotencyKey: stripeKey })) || stripeSubscription;
        params = {
          cancel_at_period_end: true,
          metadata: { ...(target.metadata || {}), addressId: String(address._id), userId: String(user.userId || user._id), localSubscriptionId: String(current._id) },
        };
      } else {
        /*
         * Review fix 7 (2026-11-13). Stripe refuses cancel_at on a
         * subscription a schedule (a pending plan change) manages, and that
         * refusal used to be stored as a "done" 502. Refuse before touching
         * Stripe and say why; with releasePendingPlanChange the schedule is
         * released first, exactly as the period-end path does, under the
         * same derived idempotency key.
         */
        if (sm.getStripeScheduleId(stripeSubscription)) {
          if (releasePendingPlanChange !== true) {
            const pending = sm.getPendingPlanChange(stripeSubscription) || {};
            const when = pending.pendingChangeEffectiveDate ? toIso(pending.pendingChangeEffectiveDate) : null;
            fail(
              409,
              "PENDING_PLAN_CHANGE",
              `This membership has a plan change scheduled${pending.pendingPlan ? ` (to ${pending.pendingPlan}${when ? ` on ${when.slice(0, 10)}` : ""})` : ""}. ` +
                "Setting or clearing a cancellation date cancels that plan change. Confirm with releasePendingPlanChange: true, or keep it and change nothing.",
              { pendingPlanChange: { plan: pending.pendingPlan || null, billingCycle: pending.pendingBillingCycle || null, effectiveDate: when } }
            );
          }
          target = (await sm.clearStripeSubscriptionSchedule(stripeSubscription, { idempotencyKey: stripeKey })) || stripeSubscription;
        }
        params =
          mode === "date"
            ? { cancel_at: Math.floor(cancelAtDate.getTime() / 1000), cancel_at_period_end: false }
            : { cancel_at: "", cancel_at_period_end: false };
      }
      const updated = await sm.stripe.subscriptions.update(
        target.id,
        { ...params, expand: ["items.data.price", "schedule"] },
        sm.stripeStepOptions(stripeKey, `cancellation-${mode}`)
      );
      await sm.upsertSubscriptionFromStripe({ stripeSubscription: updated, user, addressIdHint: String(address._id) });
    } else {
      // Not billed by Stripe (complimentary or an old admin record): our record is the whole truth.
      if (mode === "period_end") {
        const end = sm.toDate(current.currentPeriodEnd);
        if (!end) fail(400, "DATE_REQUIRED", "This membership has no billing period. Choose a date instead.");
        current.cancelAtPeriodEnd = true;
        current.cancellationDate = end;
      } else if (mode === "date") {
        current.cancelAtPeriodEnd = true;
        current.cancellationDate = cancelAtDate;
      } else {
        current.cancelAtPeriodEnd = false;
        current.cancellationDate = null;
      }
      await current.save();
    }

    const fresh = await Subscription.findById(current._id).lean();
    const after = { cancelAt: toIso(cancelAtFor(fresh)), cancelAtPeriodEnd: Boolean(fresh?.cancelAtPeriodEnd) };
    const action =
      mode === "clear" ? "Membership Cancellation Cleared" : mode === "date" ? "Membership Cancellation Date Set" : "Membership Cancellation Scheduled";
    await createAdminActivityLog(req, {
      action,
      entityType: "Subscription",
      entityId: current._id,
      entityName: `${user.name || user.userId} - ${address.line1}`,
      details: {
        customerUserId: String(user._id),
        customerName: user.name,
        addressId: String(address._id),
        address: formatAddressLine(address),
        mode,
        requestedDate: mode === "date" ? String(date) : null,
        before,
        after,
        stripeManaged: Boolean(current.stripeSubscriptionId),
        idempotencyKey: key,
      },
    });
    return {
      message: mode === "clear" ? "Cancellation cleared." : "Cancellation scheduled.",
      before,
      after,
      addressPlan: planSummary(fresh),
    };
  });
}

/* ---------------------------------------------------------- complimentary */

async function grantComplimentary({ userId, addressId, plan, reason, confirm, endsOn = null, req }) {
  if (req?.accessRole !== "admin") fail(403, "OWNER_ONLY", "Only the owner can give a complimentary membership.");
  if (confirm !== true) fail(428, "CONFIRMATION_REQUIRED", "Confirm the complimentary membership (confirm: true).");
  const why = String(reason || "").trim().slice(0, 500);
  if (why.length < 3) fail(400, "REASON_REQUIRED", "Give the reason for this complimentary membership.");
  const targetPlan = sm.normalizePlanType(plan);
  if (!targetPlan) fail(400, "INVALID_PLAN", "Choose basic, plus, premium or elite.");

  let endsAt = null;
  if (endsOn) {
    const m = YMD.exec(String(endsOn));
    if (!m) fail(400, "INVALID_DATE", "endsOn must be YYYY-MM-DD.");
    if (String(endsOn) <= nyToday()) fail(400, "DATE_IN_PAST", "endsOn must be after today.");
    endsAt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1, 5, 0, 0));
  }

  const { user, address, live } = await loadHome({ userId, addressId });
  if (live.length) {
    fail(409, "ADDRESS_HAS_MEMBERSHIP", "This home already has a membership that has not ended (active, trialing or with a payment problem). A complimentary one cannot be added beside it.", {
      statuses: live.map((s) => s.status),
    });
  }
  // Our records can be wrong: ask Stripe whether it is still billing this home.
  if (user.stripeCustomerId) {
    let billing;
    try {
      billing = await sm.billingStripeSubscriptionsForAddress({ stripeCustomerId: user.stripeCustomerId, addressId: address._id });
    } catch (error) {
      fail(502, "STRIPE_UNAVAILABLE", "Could not confirm with Stripe that this home is not billed. Nothing was changed.");
    }
    if (billing.length) fail(409, "ADDRESS_HAS_MEMBERSHIP", "Stripe is still billing a membership for this home.");
  }

  const actor = actorOf(req);
  const now = new Date();
  let subscription;
  try {
    subscription = await Subscription.create({
      user: user._id,
      userId: user.userId,
      subscriptionType: targetPlan,
      addressId: address._id,
      addressSnapshot: { line1: address.line1, city: address.city, state: address.state, zip: address.zip, county: address.county || "" },
      startDate: now,
      latestPaymentDate: now,
      nextPaymentDate: endsAt || new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: endsAt,
      cancelAtPeriodEnd: Boolean(endsAt),
      cancellationDate: endsAt,
      status: "active",
      accessStatus: "active",
      planPrice: 0,
      paymentMethod: "complimentary",
      complimentary: { reason: why, grantedBy: actor.id, grantedByName: actor.name, grantedAt: now },
    });
  } catch (error) {
    if (error?.code === 11000) fail(409, "ADDRESS_HAS_MEMBERSHIP", "This home already has an active membership.");
    throw error;
  }
  await sm.syncLegacyUserSubscription(user._id);
  await createAdminActivityLog(req, {
    action: "Complimentary Membership Granted",
    entityType: "Subscription",
    entityId: subscription._id,
    entityName: `${user.name || user.userId} - ${address.line1}`,
    details: {
      customerUserId: String(user._id),
      customerName: user.name,
      addressId: String(address._id),
      address: formatAddressLine(address),
      plan: targetPlan,
      reason: why,
      endsAt: toIso(endsAt),
      before: { planStatus: "none" },
      after: { plan: targetPlan, planStatus: endsAt ? "ending" : "active", complimentary: true },
    },
  });
  return { message: "Complimentary membership added.", addressPlan: planSummary(subscription.toObject()) };
}

module.exports = {
  MembershipActionError,
  PREVIEW_TTL_SECONDS,
  confirmPlanChange,
  grantComplimentary,
  previewPlanChange,
  setCancellation,
};
