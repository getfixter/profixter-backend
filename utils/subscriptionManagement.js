const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || "").trim();
const stripe = require("stripe")(STRIPE_SECRET_KEY || "sk_test_missing_stripe_secret_key");
const Subscription = require("../models/Subscription");
const User = require("../models/User");

function hasStripeSecretKey() {
  return !!STRIPE_SECRET_KEY;
}

if (!hasStripeSecretKey()) {
  console.error(
    JSON.stringify({
      level: "error",
      event: "stripe_config_missing",
      missing: ["STRIPE_SECRET_KEY"],
    })
  );
}

const PLAN_PRICES = {
  basic: 149,
  plus: 249,
  premium: 349,
  elite: 499,
};

const LEGACY_PRICE_MAP = {
  monthly: {
    basic: "price_1RUdq2Bw0RtvSZjMnnI6uRgn",
    plus: "price_1RUds8Bw0RtvSZjMFS1BoQEU",
    premium: "price_1RUdtWBw0RtvSZjMOo8Q1as9",
    elite: "price_1RUduRBw0RtvSZjMy6ySmgHk",
  },
  annual: {
    basic: "price_1T1FWUBw0RtvSZjMFXMTrt9o",
    plus: "price_1T1FXiBw0RtvSZjMTmqGIl2d",
    premium: "price_1T1FYPBw0RtvSZjMEYMourmW",
    elite: "price_1T1FZGBw0RtvSZjMSoBGm4p6",
  },
};

const PRICE_ENV_KEYS = {
  monthly: {
    basic: "STRIPE_PRICE_BASIC_MONTHLY",
    plus: "STRIPE_PRICE_PLUS_MONTHLY",
    premium: "STRIPE_PRICE_PREMIUM_MONTHLY",
    elite: "STRIPE_PRICE_ELITE_MONTHLY",
  },
  annual: {
    basic: "STRIPE_PRICE_BASIC_ANNUAL",
    plus: "STRIPE_PRICE_PLUS_ANNUAL",
    premium: "STRIPE_PRICE_PREMIUM_ANNUAL",
    elite: "STRIPE_PRICE_ELITE_ANNUAL",
  },
};

const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;
const priceResolutionCache = new Map();

const PRICE_LOOKUP = Object.entries(LEGACY_PRICE_MAP).reduce((acc, [billingCycle, plans]) => {
  for (const [plan, priceId] of Object.entries(plans)) {
    acc[priceId] = { plan, billingCycle };
  }
  return acc;
}, {});

function logPriceResolution(level, event, details = {}) {
  const payload = JSON.stringify({
    level,
    event,
    scope: "stripe_price_resolution",
    ...details,
  });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

function normalizePlanType(raw) {
  const plan = String(raw || "").trim().toLowerCase();
  return ["basic", "plus", "premium", "elite"].includes(plan) ? plan : null;
}

function normalizeBillingCycle(raw, fallback = "monthly") {
  return String(raw || "").trim().toLowerCase() === "annual" ? "annual" : fallback;
}

function getLegacyPriceId(plan, billingCycle = "monthly") {
  const normalizedPlan = normalizePlanType(plan);
  const normalizedCycle = normalizeBillingCycle(billingCycle);
  if (!normalizedPlan) return null;
  return LEGACY_PRICE_MAP[normalizedCycle]?.[normalizedPlan] || null;
}

function rememberPriceMapping(priceId, plan, billingCycle) {
  if (!priceId) return;
  PRICE_LOOKUP[String(priceId)] = {
    plan: normalizePlanType(plan),
    billingCycle: normalizeBillingCycle(billingCycle, "monthly"),
  };
}

function getStripeMetadataValue(price, key) {
  const direct = price?.metadata?.[key];
  if (direct) return direct;
  const product = price?.product;
  if (product && typeof product === "object") {
    return product.metadata?.[key] || null;
  }
  return null;
}

async function resolveStripePriceId({ plan, billingCycle = "monthly" }) {
  const normalizedPlan = normalizePlanType(plan);
  const normalizedCycle = normalizeBillingCycle(billingCycle, "monthly");
  const cacheKey = `${normalizedPlan || "invalid"}:${normalizedCycle}`;
  const cached = priceResolutionCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  if (!normalizedPlan) {
    const value = { priceId: null, source: null };
    priceResolutionCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + PRICE_CACHE_TTL_MS,
    });
    logPriceResolution("warn", "stripe_price_resolution_failed", {
      requestedPlan: plan || null,
      billingCycle: normalizedCycle,
      source: null,
      found: false,
    });
    return value;
  }

  const envKey = PRICE_ENV_KEYS[normalizedCycle]?.[normalizedPlan] || null;
  const envPriceId = envKey ? String(process.env[envKey] || "").trim() : "";
  if (envPriceId) {
    rememberPriceMapping(envPriceId, normalizedPlan, normalizedCycle);
    const value = { priceId: envPriceId, source: "env" };
    priceResolutionCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + PRICE_CACHE_TTL_MS,
    });
    logPriceResolution("info", "stripe_price_resolution_succeeded", {
      requestedPlan: normalizedPlan,
      billingCycle: normalizedCycle,
      source: value.source,
      found: true,
    });
    return value;
  }

  if (hasStripeSecretKey()) {
    try {
      const prices = await stripe.prices.list({
        active: true,
        limit: 100,
        expand: ["data.product"],
      });

      const matched = (prices.data || []).find((price) => {
        const metadataPlan = normalizePlanType(getStripeMetadataValue(price, "profixter_plan"));
        const metadataCycle = normalizeBillingCycle(
          getStripeMetadataValue(price, "billing_cycle"),
          ""
        );
        return metadataPlan === normalizedPlan && metadataCycle === normalizedCycle;
      });

      if (matched?.id) {
        rememberPriceMapping(matched.id, normalizedPlan, normalizedCycle);
        const value = { priceId: matched.id, source: "stripe_metadata" };
        priceResolutionCache.set(cacheKey, {
          value,
          expiresAt: Date.now() + PRICE_CACHE_TTL_MS,
        });
        logPriceResolution("info", "stripe_price_resolution_succeeded", {
          requestedPlan: normalizedPlan,
          billingCycle: normalizedCycle,
          source: value.source,
          found: true,
        });
        return value;
      }
    } catch (error) {
      logPriceResolution("warn", "stripe_price_metadata_lookup_failed", {
        requestedPlan: normalizedPlan,
        billingCycle: normalizedCycle,
        source: "stripe_metadata",
        found: false,
        message: error?.message || "Unable to query Stripe prices",
      });
    }
  }

  const legacyPriceId = getLegacyPriceId(normalizedPlan, normalizedCycle);
  if (legacyPriceId) {
    rememberPriceMapping(legacyPriceId, normalizedPlan, normalizedCycle);
    const value = { priceId: legacyPriceId, source: "legacy" };
    priceResolutionCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + PRICE_CACHE_TTL_MS,
    });
    logPriceResolution("info", "stripe_price_resolution_succeeded", {
      requestedPlan: normalizedPlan,
      billingCycle: normalizedCycle,
      source: value.source,
      found: true,
    });
    return value;
  }

  const value = { priceId: null, source: null };
  priceResolutionCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + PRICE_CACHE_TTL_MS,
  });
  logPriceResolution("error", "stripe_price_resolution_failed", {
    requestedPlan: normalizedPlan,
    billingCycle: normalizedCycle,
    source: null,
    found: false,
  });
  return value;
}

function getPlanAndBillingFromPrice(priceId) {
  return PRICE_LOOKUP[String(priceId || "")] || { plan: null, billingCycle: "monthly" };
}

function mapStripePriceToPlan(priceOrId) {
  const price =
    priceOrId && typeof priceOrId === "object"
      ? priceOrId
      : { id: String(priceOrId || "") };
  const mapped = getPlanAndBillingFromPrice(price.id);
  const metadataPlan = normalizePlanType(getStripeMetadataValue(price, "profixter_plan"));
  const metadataCycle = normalizeBillingCycle(
    getStripeMetadataValue(price, "billing_cycle"),
    mapped.billingCycle
  );
  const interval = String(price?.recurring?.interval || "").toLowerCase();
  const billingCycle =
    interval === "year"
      ? "annual"
      : interval === "month"
        ? "monthly"
        : metadataCycle;
  const plan = metadataPlan || mapped.plan;
  if (plan && price.id) {
    rememberPriceMapping(price.id, plan, billingCycle);
  }
  return {
    plan,
    billingCycle,
    priceId: price.id || null,
  };
}

function normalizeStripeStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  const allowed = new Set([
    "active",
    "trialing",
    "past_due",
    "unpaid",
    "incomplete",
    "incomplete_expired",
    "canceled",
    "expired",
    "paused",
  ]);
  return allowed.has(normalized) ? normalized : "incomplete";
}

function deriveAccessStatus(subscription) {
  const status = normalizeStripeStatus(subscription?.status);
  return ["active", "trialing"].includes(status) ? "active" : "inactive";
}

function subscriptionGrantsAccess(subscription, options = {}) {
  if (!subscription) return false;

  const now = options.now instanceof Date ? options.now : new Date();
  const stripeConfirmed = options.stripeConfirmed === true;
  const status = String(subscription.status || "").trim().toLowerCase();

  if (!["active", "trialing"].includes(status)) return false;

  // Stripe-managed records use accessStatus as an additional safety latch.
  // Legacy/manual records do not because older admin-created records may not
  // have this field populated.
  if (
    subscription.stripeSubscriptionId &&
    String(subscription.accessStatus || "").toLowerCase() !== "active" &&
    !stripeConfirmed
  ) {
    return false;
  }

  const periodEnd = toDate(subscription.currentPeriodEnd);
  if (periodEnd && periodEnd.getTime() <= now.getTime() && !stripeConfirmed) {
    return false;
  }

  if (subscription.cancelAtPeriodEnd) {
    const accessEnd = toDate(subscription.currentPeriodEnd || subscription.cancellationDate);
    if (!accessEnd || accessEnd.getTime() <= now.getTime()) return false;
  }

  return true;
}

function isStripeSubscriptionMissingError(error) {
  return error?.statusCode === 404 || error?.code === "resource_missing";
}

function subscriptionAccessSnapshot(subscription) {
  return {
    status: subscription?.status || null,
    accessStatus: subscription?.accessStatus || null,
    currentPeriodEnd: subscription?.currentPeriodEnd || null,
    cancelAtPeriodEnd: !!subscription?.cancelAtPeriodEnd,
    cancellationDate: subscription?.cancellationDate || null,
  };
}

function accessSnapshotsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function logSubscriptionAccessChange(subscription, oldState, reason) {
  const newState = subscriptionAccessSnapshot(subscription);
  if (accessSnapshotsEqual(oldState, newState)) return;

  console.log(
    JSON.stringify({
      level: "info",
      event: "subscription_access_reconciled",
      scope: "stripe_subscription_reconciliation",
      userId: String(subscription.userId || subscription.user || ""),
      subscriptionId: String(subscription._id || ""),
      stripeSubscriptionId: subscription.stripeSubscriptionId || null,
      oldStatus: oldState.status,
      newStatus: newState.status,
      oldAccessStatus: oldState.accessStatus,
      newAccessStatus: newState.accessStatus,
      reason,
    })
  );
}

async function markSubscriptionAccessInactive(subscription, reason, stripeSubscription = null) {
  const oldState = subscriptionAccessSnapshot(subscription);
  const canceledAt =
    toDate(stripeSubscription?.canceled_at) ||
    toDate(stripeSubscription?.ended_at) ||
    subscription.cancellationDate ||
    new Date();

  subscription.status = "canceled";
  subscription.accessStatus = "inactive";
  subscription.cancelAtPeriodEnd = false;
  subscription.cancellationDate = canceledAt;
  subscription.cancellationReason = reason;
  subscription.pendingPlan = null;
  subscription.pendingBillingCycle = null;
  subscription.pendingStripePriceId = null;
  subscription.pendingChangeEffectiveDate = null;

  await subscription.save();
  await syncLegacyUserSubscription(subscription.user);
  logSubscriptionAccessChange(subscription, oldState, reason);
  return subscription;
}

async function syncSubscriptionAccessFromStripe(subscription, stripeSubscription) {
  const oldState = subscriptionAccessSnapshot(subscription);
  const stripeStatus = normalizeStripeStatus(stripeSubscription?.status);

  if (!["active", "trialing"].includes(stripeStatus)) {
    return markSubscriptionAccessInactive(
      subscription,
      `stripe_status_${stripeStatus}`,
      stripeSubscription
    );
  }

  const period = handleCurrentPeriodStartEnd(stripeSubscription);
  const cancellation = handleCancelAtPeriodEnd(stripeSubscription);

  subscription.status = stripeStatus;
  subscription.accessStatus = "active";
  subscription.currentPeriodStart = period.currentPeriodStart;
  subscription.currentPeriodEnd = period.currentPeriodEnd;
  subscription.nextPaymentDate =
    period.currentPeriodEnd || subscription.nextPaymentDate || new Date();
  subscription.cancelAtPeriodEnd = cancellation.cancelAtPeriodEnd;
  subscription.cancellationDate = cancellation.cancellationDate;
  if (!cancellation.cancelAtPeriodEnd) {
    subscription.cancellationReason = null;
  }

  await subscription.save();
  await syncLegacyUserSubscription(subscription.user);
  logSubscriptionAccessChange(subscription, oldState, `stripe_status_${stripeStatus}`);
  return subscription;
}

async function verifySubscriptionAccess(subscription, options = {}) {
  if (!subscription) {
    return { grantsAccess: false, subscription: null, reason: "missing_local_subscription" };
  }

  if (!subscription.stripeSubscriptionId) {
    return {
      grantsAccess: subscriptionGrantsAccess(subscription),
      subscription,
      reason: subscriptionGrantsAccess(subscription)
        ? "legacy_local_access_valid"
        : "legacy_local_access_inactive",
    };
  }

  let stripeSubscription;
  try {
    stripeSubscription = await retrieveStripeSubscription(subscription.stripeSubscriptionId);
  } catch (error) {
    if (isStripeSubscriptionMissingError(error)) {
      const updated = await markSubscriptionAccessInactive(
        subscription,
        "stripe_subscription_missing"
      );
      return {
        grantsAccess: false,
        subscription: updated,
        reason: "stripe_subscription_missing",
      };
    }

    console.error(
      JSON.stringify({
        level: "error",
        event: "subscription_access_verification_failed",
        scope: "stripe_subscription_reconciliation",
        userId: String(subscription.userId || subscription.user || ""),
        subscriptionId: String(subscription._id || ""),
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        message: error?.message || "Stripe verification failed",
        source: options.source || "unknown",
      })
    );
    return {
      grantsAccess: false,
      subscription,
      reason: "stripe_verification_failed",
      error,
    };
  }

  const updated = await syncSubscriptionAccessFromStripe(subscription, stripeSubscription);
  const stripeStatus = normalizeStripeStatus(stripeSubscription.status);
  return {
    grantsAccess: subscriptionGrantsAccess(updated, {
      stripeConfirmed: ["active", "trialing"].includes(stripeStatus),
    }),
    subscription: updated,
    stripeSubscription,
    reason: `stripe_status_${stripeStatus}`,
  };
}

async function reconcileActiveStripeSubscriptions(options = {}) {
  const subscriptions = await Subscription.find({
    status: { $in: ["active", "trialing"] },
    stripeSubscriptionId: { $nin: [null, ""] },
  }).sort({ updatedAt: 1 });

  const summary = {
    scanned: subscriptions.length,
    accessKept: 0,
    accessRemoved: 0,
    errors: 0,
  };

  for (const subscription of subscriptions) {
    const result = await verifySubscriptionAccess(subscription, {
      source: options.source || "scheduled_reconciliation",
    });

    if (result.error) summary.errors += 1;
    else if (result.grantsAccess) summary.accessKept += 1;
    else summary.accessRemoved += 1;
  }

  console.log(
    JSON.stringify({
      level: "info",
      event: "subscription_reconciliation_completed",
      scope: "stripe_subscription_reconciliation",
      source: options.source || "scheduled_reconciliation",
      ...summary,
    })
  );

  return summary;
}

function handleCancelAtPeriodEnd(stripeSubscription) {
  const hasCancelAt = !!stripeSubscription?.cancel_at;
  const cancelAtPeriodEnd = !!(stripeSubscription?.cancel_at_period_end || hasCancelAt);
  const cancellationDate = stripeSubscription?.cancel_at_period_end
    ? toDate(stripeSubscription.current_period_end)
    : hasCancelAt
      ? toDate(stripeSubscription.cancel_at)
      : toDate(stripeSubscription?.canceled_at) || null;
  return { cancelAtPeriodEnd, cancellationDate };
}

function handleCurrentPeriodStartEnd(stripeSubscription) {
  return {
    currentPeriodStart: toDate(stripeSubscription?.current_period_start),
    currentPeriodEnd: toDate(stripeSubscription?.current_period_end),
  };
}

function handleTrial(stripeSubscription) {
  return {
    trialStart: toDate(stripeSubscription?.trial_start),
    trialEnd: toDate(stripeSubscription?.trial_end),
  };
}

function latestInvoiceDetails(stripeSubscription) {
  const invoice =
    stripeSubscription?.latest_invoice &&
    typeof stripeSubscription.latest_invoice !== "string"
      ? stripeSubscription.latest_invoice
      : null;
  const paymentIntent =
    invoice?.payment_intent && typeof invoice.payment_intent !== "string"
      ? invoice.payment_intent
      : null;
  return {
    latestInvoiceId:
      typeof stripeSubscription?.latest_invoice === "string"
        ? stripeSubscription.latest_invoice
        : invoice?.id || null,
    latestInvoiceStatus: invoice?.status || null,
    latestPaymentIntentStatus: paymentIntent?.status || null,
  };
}

function getPlanPrice(plan) {
  return PLAN_PRICES[String(plan || "").toLowerCase()] || 0;
}

function getPlanRank(plan) {
  if (plan === "basic") return 1;
  if (plan === "plus") return 2;
  if (plan === "premium") return 3;
  if (plan === "elite") return 4;
  return 0;
}

function classifyPlanChange({
  currentPlan,
  currentBillingCycle,
  targetPlan,
  targetBillingCycle,
}) {
  const currentRank = getPlanRank(normalizePlanType(currentPlan));
  const targetRank = getPlanRank(normalizePlanType(targetPlan));
  const normalizedCurrentCycle = normalizeBillingCycle(currentBillingCycle, "monthly");
  const normalizedTargetCycle = normalizeBillingCycle(targetBillingCycle, "monthly");

  if (currentRank === targetRank && normalizedCurrentCycle === normalizedTargetCycle) {
    return "same";
  }

  if (targetRank > currentRank) {
    return "upgrade";
  }

  if (targetRank < currentRank) {
    return "downgrade";
  }

  if (normalizedCurrentCycle === "monthly" && normalizedTargetCycle === "annual") {
    return "upgrade";
  }

  return "downgrade";
}

function getStripeScheduleId(stripeSubscription) {
  if (!stripeSubscription?.schedule) return null;
  if (typeof stripeSubscription.schedule === "string") {
    return stripeSubscription.schedule;
  }
  return stripeSubscription.schedule?.id || null;
}

async function retrieveStripeSubscription(subscriptionId) {
  return stripe.subscriptions.retrieve(String(subscriptionId), {
    expand: ["items.data.price", "schedule", "latest_invoice.payment_intent"],
  });
}

async function retrieveStripeSubscriptionSchedule(scheduleId) {
  if (!scheduleId) return null;
  return stripe.subscriptionSchedules.retrieve(String(scheduleId), {
    expand: ["phases.items.price", "phases.items.price.product"],
  });
}

function getPendingPlanChange(stripeSubscription) {
  const schedule = stripeSubscription?.schedule;
  if (!schedule || typeof schedule === "string") {
    return {
      pendingPlan: null,
      pendingBillingCycle: null,
      pendingStripePriceId: null,
      pendingChangeEffectiveDate: null,
    };
  }

  if (!["active", "not_started"].includes(String(schedule.status || "").toLowerCase())) {
    return {
      pendingPlan: null,
      pendingBillingCycle: null,
      pendingStripePriceId: null,
      pendingChangeEffectiveDate: null,
    };
  }

  const currentPeriodEnd = Number(stripeSubscription?.current_period_end || 0);
  const phases = Array.isArray(schedule.phases) ? schedule.phases : [];
  const nextPhase =
    phases
      .filter((phase) => Number(phase?.start_date || 0) >= currentPeriodEnd)
      .sort((a, b) => Number(a.start_date || 0) - Number(b.start_date || 0))[0] || null;

  const nextItem = nextPhase?.items?.[0] || null;
  const nextPriceId =
    typeof nextItem?.price === "string" ? nextItem.price : nextItem?.price?.id || null;
  const nextPrice = typeof nextItem?.price === "string" ? nextPriceId : nextItem?.price || null;
  const { plan, billingCycle } = mapStripePriceToPlan(nextPrice);
  const currentItem = stripeSubscription?.items?.data?.[0] || null;
  const currentPriceId = currentItem?.price?.id || null;
  const currentMappedPrice = mapStripePriceToPlan(currentItem?.price || currentPriceId);
  const currentPlan = currentMappedPrice.plan;
  const currentCycle = currentMappedPrice.billingCycle;

  if (!plan || (plan === currentPlan && billingCycle === currentCycle)) {
    return {
      pendingPlan: null,
      pendingBillingCycle: null,
      pendingStripePriceId: null,
      pendingChangeEffectiveDate: null,
    };
  }

  return {
    pendingPlan: plan,
    pendingBillingCycle: billingCycle,
    pendingStripePriceId: nextPriceId,
    pendingChangeEffectiveDate: toDate(nextPhase?.start_date) || null,
  };
}

function getStripeSubscriptionItemForRecord({ subscription, stripeSubscription }) {
  const items = stripeSubscription?.items?.data || [];
  if (!items.length) return null;

  if (subscription?.stripeSubscriptionItemId) {
    const exactItem = items.find(
      (item) => String(item?.id || "") === String(subscription.stripeSubscriptionItemId)
    );
    if (exactItem) return exactItem;
  }

  if (subscription?.stripePriceId) {
    const exactPrice = items.find(
      (item) => String(item?.price?.id || "") === String(subscription.stripePriceId)
    );
    if (exactPrice) return exactPrice;
  }

  const targetPlan = normalizePlanType(subscription?.subscriptionType);
  const targetCycle = normalizeBillingCycle(subscription?.billingCycle, "monthly");
  const derivedMatch = items.find((item) => {
    const derived = getPlanAndBillingFromPrice(item?.price?.id || "");
    return derived.plan === targetPlan && derived.billingCycle === targetCycle;
  });
  if (derivedMatch) return derivedMatch;

  return items.length === 1 ? items[0] : null;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value * 1000);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function serializeSubscription(subscription, address = null) {
  const grantsAccess = subscriptionGrantsAccess(subscription);
  const storedStatus = String(subscription.status || "").toLowerCase();
  const effectiveStatus =
    ["active", "trialing"].includes(storedStatus) && !grantsAccess
      ? "expired"
      : subscription.status;

  return {
    _id: String(subscription._id),
    addressId: subscription.addressId ? String(subscription.addressId) : null,
    address: address
      ? {
          _id: String(address._id),
          label: address.label,
          line1: address.line1,
          city: address.city,
          state: address.state,
          zip: address.zip,
          county: address.county || "",
        }
      : null,
    addressSnapshot: subscription.addressSnapshot || null,
    subscriptionType: String(subscription.subscriptionType || "").toLowerCase(),
    status: effectiveStatus,
    billingCycle: subscription.billingCycle || "monthly",
    startDate: subscription.startDate || null,
    latestPaymentDate: subscription.latestPaymentDate || null,
    nextPaymentDate: subscription.nextPaymentDate || null,
    currentPeriodStart: subscription.currentPeriodStart || null,
    currentPeriodEnd: subscription.currentPeriodEnd || subscription.nextPaymentDate || null,
    trialStart: subscription.trialStart || null,
    trialEnd: subscription.trialEnd || null,
    latestInvoiceId: subscription.latestInvoiceId || null,
    latestInvoiceStatus: subscription.latestInvoiceStatus || null,
    latestPaymentIntentStatus: subscription.latestPaymentIntentStatus || null,
    accessStatus: grantsAccess ? "active" : "inactive",
    cancelAtPeriodEnd: !!subscription.cancelAtPeriodEnd,
    cancellationDate: subscription.cancellationDate || null,
    cancellationReason: subscription.cancellationReason || null,
    pendingPlan: subscription.pendingPlan || null,
    pendingBillingCycle: subscription.pendingBillingCycle || null,
    pendingStripePriceId: subscription.pendingStripePriceId || null,
    pendingChangeEffectiveDate: subscription.pendingChangeEffectiveDate || null,
    planPrice: subscription.planPrice ?? null,
    stripeManaged: !!subscription.stripeSubscriptionId,
  };
}

async function syncLegacyUserSubscription(userId) {
  const user = await User.findById(userId);
  if (!user) return null;

  const candidates = await Subscription.find({
    user: user._id,
    status: { $in: ["active", "trialing"] },
  }).sort({ currentPeriodEnd: 1, nextPaymentDate: 1, updatedAt: -1 });
  const activeSubs = candidates.filter((subscription) =>
    subscriptionGrantsAccess(subscription)
  );

  let chosen = null;
  if (user.defaultAddressId) {
    chosen =
      activeSubs.find((sub) => String(sub.addressId) === String(user.defaultAddressId)) || null;
  }
  if (!chosen) chosen = activeSubs[0] || null;

  const $set = {};
  if (!chosen) {
    $set.subscription = null;
    $set.subscriptionStart = null;
    $set.subscriptionExpiry = null;
  } else {
    $set.subscription = String(chosen.subscriptionType || "").toLowerCase() || null;
    $set.subscriptionStart = chosen.startDate || null;
    $set.subscriptionExpiry =
      chosen.currentPeriodEnd || chosen.nextPaymentDate || chosen.cancellationDate || null;
    if (chosen.stripeCustomerId && !user.stripeCustomerId) {
      $set.stripeCustomerId = chosen.stripeCustomerId;
    }
  }

  // Use raw collection update to bypass Mongoose validation.
  // Some legacy User documents are missing required fields (name, userId) and
  // user.save() would throw a validation error, blocking every webhook event for those users.
  await User.collection.updateOne({ _id: user._id }, { $set });
  return user;
}

async function resolveUserStripeCustomerId(user) {
  if (user?.stripeCustomerId) return user.stripeCustomerId;
  if (!user?.email) return null;

  const customers = await stripe.customers.list({
    email: String(user.email).toLowerCase(),
    limit: 10,
  });

  const customer = customers.data?.[0] || null;
  if (!customer) return null;

  user.stripeCustomerId = customer.id;
  await user.save();
  return customer.id;
}

async function resolveStripeSubscriptionForRecord({ subscription, user }) {
  if (subscription?.stripeSubscriptionId) {
    const direct = await retrieveStripeSubscription(subscription.stripeSubscriptionId);
    const metadata = direct?.metadata || {};
    const targetAddressId = subscription?.addressId ? String(subscription.addressId) : "";
    const customerId = String(direct?.customer || "");

    if (
      metadata.localSubscriptionId &&
      String(metadata.localSubscriptionId) !== String(subscription._id)
    ) {
      return null;
    }

    if (metadata.addressId && targetAddressId && String(metadata.addressId) !== targetAddressId) {
      return null;
    }

    if (
      customerId &&
      subscription?.stripeCustomerId &&
      customerId !== String(subscription.stripeCustomerId)
    ) {
      return null;
    }

    if (customerId && user?.stripeCustomerId && customerId !== String(user.stripeCustomerId)) {
      return null;
    }

    return direct;
  }

  const customerIds = new Set();
  if (subscription?.stripeCustomerId) customerIds.add(subscription.stripeCustomerId);
  if (user?.stripeCustomerId) customerIds.add(user.stripeCustomerId);

  if (!customerIds.size && user) {
    const resolvedCustomerId = await resolveUserStripeCustomerId(user);
    if (resolvedCustomerId) customerIds.add(resolvedCustomerId);
  }

  const candidates = [];
  for (const customerId of customerIds) {
    const result = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
      expand: ["data.items.data.price", "data.schedule"],
    });
    candidates.push(...result.data);
  }

  const targetPlan = normalizePlanType(subscription?.subscriptionType);
  const targetCycle = normalizeBillingCycle(subscription?.billingCycle, "monthly");
  const targetAddressId = subscription?.addressId ? String(subscription.addressId) : "";
  const targetNextPayment = subscription?.nextPaymentDate
    ? toDate(subscription.nextPaymentDate)?.getTime() || 0
    : 0;

  const scored = candidates
    .map((candidate) => {
      const item = candidate.items?.data?.[0];
      const priceId = item?.price?.id || "";
      const derived = getPlanAndBillingFromPrice(priceId);
      const metadata = candidate.metadata || {};
      const hasLocalMatch =
        !!metadata.localSubscriptionId &&
        String(metadata.localSubscriptionId) === String(subscription._id);
      const hasAddressMatch =
        !!targetAddressId && !!metadata.addressId && String(metadata.addressId) === targetAddressId;
      let score = 0;

      if (hasLocalMatch) {
        score += 300;
      }
      if (hasAddressMatch) {
        score += 200;
      }
      if (targetPlan && derived.plan === targetPlan) score += 40;
      if (targetCycle && derived.billingCycle === targetCycle) score += 20;
      if (subscription?.stripeCustomerId && String(candidate.customer) === String(subscription.stripeCustomerId)) {
        score += 15;
      }
      if (user?.stripeCustomerId && String(candidate.customer) === String(user.stripeCustomerId)) {
        score += 15;
      }

      if (targetNextPayment && candidate.current_period_end) {
        const delta = Math.abs(candidate.current_period_end * 1000 - targetNextPayment);
        if (delta < 3 * 24 * 60 * 60 * 1000) score += 10;
      }

      return { candidate, score, hasLocalMatch, hasAddressMatch };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const bestEntry = scored[0] || null;
  const secondEntry = scored[1] || null;
  if (!bestEntry) return null;

  if (secondEntry && bestEntry.score === secondEntry.score) {
    return null;
  }

  if (!bestEntry.hasLocalMatch && !bestEntry.hasAddressMatch) {
    return null;
  }

  const best = bestEntry.candidate;

  if (String(best.customer || "").trim() && !user?.stripeCustomerId && user) {
    user.stripeCustomerId = String(best.customer);
    await user.save();
  }

  return best;
}

async function upsertSubscriptionRecordFromStripe({
  stripeSubscription,
  user,
  addressIdHint = null,
  stripeCheckoutSessionId = null,
}) {
  if (!stripeSubscription || !user) return null;

  const scheduleId = getStripeScheduleId(stripeSubscription);
  let canonicalStripeSubscription = stripeSubscription;
  if (scheduleId && typeof stripeSubscription.schedule === "string") {
    canonicalStripeSubscription = await retrieveStripeSubscription(stripeSubscription.id);
  }
  if (scheduleId) {
    const expandedSchedule = await retrieveStripeSubscriptionSchedule(scheduleId);
    if (expandedSchedule) {
      canonicalStripeSubscription = {
        ...canonicalStripeSubscription,
        schedule: expandedSchedule,
      };
    }
  }

  const pendingChange = getPendingPlanChange(canonicalStripeSubscription);
  const item = canonicalStripeSubscription.items?.data?.[0] || null;
  const { plan, billingCycle, priceId } = mapStripePriceToPlan(item?.price || null);

  if (!plan) {
    throw new Error(`Unable to map Stripe price to local plan: ${priceId || "missing price id"}`);
  }

  const metadata = canonicalStripeSubscription.metadata || {};
  let subscription =
    (await Subscription.findOne({ stripeSubscriptionId: canonicalStripeSubscription.id })) ||
    null;

  if (!subscription && metadata.localSubscriptionId) {
    subscription = await Subscription.findOne({
      _id: metadata.localSubscriptionId,
      user: user._id,
    });
  }

  const addressId = metadata.addressId || addressIdHint || subscription?.addressId || null;
  if (!metadata.addressId) {
    console.warn(
      "[upsertSubscriptionFromStripe] No addressId in Stripe metadata — falling back:",
      JSON.stringify({
        stripeSubscriptionId: canonicalStripeSubscription.id,
        fallbackSource: addressIdHint ? "addressIdHint" : subscription?.addressId ? "existing subscription" : "none",
        resolvedAddressId: addressId || null,
      })
    );
  }
  const address = addressId ? user.addresses?.id(addressId) : null;
  if (!address) {
    throw new Error("Unable to resolve subscription address for Stripe subscription");
  }

  if (!subscription) {
    subscription =
      (await Subscription.findOne({
        user: user._id,
        addressId: address._id,
        status: { $in: ["active", "trialing", "past_due", "unpaid", "incomplete"] },
      }).sort({ updatedAt: -1 })) || null;
  }

  if (!subscription) {
    subscription = new Subscription({
      user: user._id,
      userId: user.userId,
      addressId: address._id,
      startDate: toDate(canonicalStripeSubscription.start_date) || new Date(),
      latestPaymentDate: toDate(canonicalStripeSubscription.current_period_start) || new Date(),
      nextPaymentDate: toDate(canonicalStripeSubscription.current_period_end) || new Date(),
    });
  }

  subscription.user = user._id;
  subscription.userId = user.userId;
  subscription.subscriptionType = plan;
  subscription.addressId = address._id;
  subscription.addressSnapshot = {
    line1: address.line1,
    city: address.city,
    state: address.state,
    zip: address.zip,
    county: address.county || "",
  };
  subscription.stripeCustomerId = String(
    canonicalStripeSubscription.customer || user.stripeCustomerId || ""
  );
  subscription.stripeSubscriptionId = canonicalStripeSubscription.id;
  subscription.stripeSubscriptionItemId = item?.id || null;
  subscription.stripePriceId = priceId;
  subscription.stripeCheckoutSessionId =
    stripeCheckoutSessionId || subscription.stripeCheckoutSessionId || null;
  subscription.billingCycle = billingCycle;
  subscription.startDate =
    toDate(canonicalStripeSubscription.start_date) || subscription.startDate || new Date();
  const period = handleCurrentPeriodStartEnd(canonicalStripeSubscription);
  const trial = handleTrial(canonicalStripeSubscription);
  const cancellation = handleCancelAtPeriodEnd(canonicalStripeSubscription);
  const invoice = latestInvoiceDetails(canonicalStripeSubscription);

  subscription.latestPaymentDate =
    period.currentPeriodStart ||
    subscription.latestPaymentDate ||
    subscription.startDate ||
    new Date();
  subscription.nextPaymentDate =
    period.currentPeriodEnd ||
    subscription.nextPaymentDate ||
    subscription.latestPaymentDate ||
    new Date();
  subscription.currentPeriodStart = period.currentPeriodStart || subscription.currentPeriodStart || null;
  subscription.currentPeriodEnd = period.currentPeriodEnd || subscription.currentPeriodEnd || null;
  subscription.trialStart = trial.trialStart;
  subscription.trialEnd = trial.trialEnd;
  subscription.status = normalizeStripeStatus(canonicalStripeSubscription.status);
  subscription.accessStatus = deriveAccessStatus(canonicalStripeSubscription);
  subscription.cancelAtPeriodEnd = cancellation.cancelAtPeriodEnd;
  subscription.cancellationDate = cancellation.cancellationDate;
  subscription.latestInvoiceId = invoice.latestInvoiceId;
  subscription.latestInvoiceStatus = invoice.latestInvoiceStatus;
  subscription.latestPaymentIntentStatus = invoice.latestPaymentIntentStatus;
  if (["active", "trialing"].includes(String(subscription.status || "").toLowerCase()) && !subscription.cancelAtPeriodEnd) {
    subscription.cancellationReason = null;
  }
  subscription.pendingPlan = pendingChange.pendingPlan;
  subscription.pendingBillingCycle = pendingChange.pendingBillingCycle;
  subscription.pendingStripePriceId = pendingChange.pendingStripePriceId;
  subscription.pendingChangeEffectiveDate = pendingChange.pendingChangeEffectiveDate;
  subscription.planPrice = getPlanPrice(plan);
  subscription.paymentMethod = "card";

  await subscription.save();

  // Cancel any other active subscriptions for the same address.
  // Stripe is the single source of truth; the record we just synced is canonical.
  // This is the only place new active state is ever written, so running dedup here
  // covers every code path: checkout, webhook, upgrade, downgrade, reactivate.
  if (subscription.addressId && ["active", "trialing"].includes(subscription.status)) {
    await Subscription.updateMany(
      {
        user: user._id,
        addressId: subscription.addressId,
        _id: { $ne: subscription._id },
        status: { $in: ["active", "trialing"] },
      },
      {
        $set: {
          status: "canceled",
          cancelAtPeriodEnd: false,
          cancellationDate: new Date(),
          cancellationReason: "duplicate_deactivated",
        },
      }
    );
  }

  if (!user.stripeCustomerId && subscription.stripeCustomerId) {
    user.stripeCustomerId = subscription.stripeCustomerId;
    await user.save();
  }

  await syncLegacyUserSubscription(user._id);
  return subscription;
}

async function findUserForStripeCustomerId(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  return User.findOne({ stripeCustomerId: String(stripeCustomerId) });
}

async function syncCustomerFromStripe(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  const customer = await stripe.customers.retrieve(String(stripeCustomerId));
  if (!customer || customer.deleted) return null;

  let user = await findUserForStripeCustomerId(customer.id);
  if (!user && customer.email) {
    user = await User.findOne({ email: String(customer.email).trim().toLowerCase() });
  }
  if (!user) return null;

  if (!user.stripeCustomerId) {
    await User.collection.updateOne(
      { _id: user._id },
      { $set: { stripeCustomerId: String(customer.id) } }
    );
    user.stripeCustomerId = String(customer.id);
  }

  return user;
}

async function upsertSubscriptionFromStripe(input, options = {}) {
  if (typeof input === "string") {
    const stripeSubscription = await retrieveStripeSubscription(input);
    const stripeCustomerId = String(stripeSubscription?.customer || "");
    const user =
      options.user ||
      (stripeCustomerId ? await syncCustomerFromStripe(stripeCustomerId) : null);
    if (!user) return null;
    return upsertSubscriptionRecordFromStripe({
      stripeSubscription,
      user,
      addressIdHint: options.addressIdHint || null,
      stripeCheckoutSessionId: options.stripeCheckoutSessionId || null,
    });
  }

  return upsertSubscriptionRecordFromStripe(input || {});
}

async function handlePaymentFailure(invoice, stripeSubscription = null, user = null) {
  const resolvedSubscription =
    stripeSubscription ||
    (invoice?.subscription ? await retrieveStripeSubscription(String(invoice.subscription)) : null);
  if (!resolvedSubscription) return null;

  const resolvedUser =
    user ||
    (resolvedSubscription.customer
      ? await syncCustomerFromStripe(String(resolvedSubscription.customer))
      : null);
  if (!resolvedUser) return null;

  const subscription = await upsertSubscriptionRecordFromStripe({
    stripeSubscription: resolvedSubscription,
    user: resolvedUser,
    addressIdHint: resolvedSubscription.metadata?.addressId || null,
  });
  if (!subscription) return null;

  subscription.latestInvoiceId = invoice?.id || subscription.latestInvoiceId || null;
  subscription.latestInvoiceStatus = invoice?.status || subscription.latestInvoiceStatus || null;
  subscription.latestPaymentIntentStatus =
    typeof invoice?.payment_intent === "object"
      ? invoice.payment_intent?.status || subscription.latestPaymentIntentStatus || null
      : subscription.latestPaymentIntentStatus || null;
  if (["past_due", "unpaid", "incomplete_expired"].includes(subscription.status)) {
    subscription.cancellationReason = subscription.cancellationReason || "payment_failed";
  }
  await subscription.save();
  await syncLegacyUserSubscription(resolvedUser._id);
  return subscription;
}

async function clearStripeSubscriptionSchedule(stripeSubscription) {
  const scheduleId = getStripeScheduleId(stripeSubscription);
  if (!scheduleId) return null;
  await stripe.subscriptionSchedules.release(String(scheduleId), {
    preserve_cancel_date: false,
  });
  return retrieveStripeSubscription(stripeSubscription.id);
}

async function applyStripeSubscriptionUpgrade({
  stripeSubscription,
  subscription,
  user,
  addressId,
  nextPriceId,
}) {
  const previousPendingChange = getPendingPlanChange(stripeSubscription);
  const activeStripeSubscription = await clearStripeSubscriptionSchedule(stripeSubscription);
  const upgradeTarget = activeStripeSubscription || stripeSubscription;
  const upgradeItem = getStripeSubscriptionItemForRecord({
    subscription,
    stripeSubscription: upgradeTarget,
  });

  if (!upgradeItem?.id) {
    throw new Error("Stripe subscription item not found");
  }

  let updatedStripeSubscription;
  try {
    updatedStripeSubscription = await stripe.subscriptions.update(upgradeTarget.id, {
      proration_behavior: "always_invoice",
      payment_behavior: "pending_if_incomplete",
      items: [{ id: upgradeItem.id, price: nextPriceId }],
      expand: ["items.data.price", "schedule", "latest_invoice.payment_intent"],
    });
  } catch (error) {
    if (previousPendingChange.pendingStripePriceId) {
      const restoredSubscription = await retrieveStripeSubscription(upgradeTarget.id);
      await scheduleStripeSubscriptionDowngrade({
        stripeSubscription: restoredSubscription,
        subscription,
        user,
        addressId: String(addressId),
        nextPriceId: previousPendingChange.pendingStripePriceId,
      });
    }
    throw error;
  }

  if (updatedStripeSubscription.pending_update) {
    if (previousPendingChange.pendingStripePriceId) {
      const restoredSubscription = await retrieveStripeSubscription(upgradeTarget.id);
      await scheduleStripeSubscriptionDowngrade({
        stripeSubscription: restoredSubscription,
        subscription,
        user,
        addressId: String(addressId),
        nextPriceId: previousPendingChange.pendingStripePriceId,
      });
    }

    const invoice =
      updatedStripeSubscription.latest_invoice &&
      typeof updatedStripeSubscription.latest_invoice !== "string"
        ? updatedStripeSubscription.latest_invoice
        : null;
    const paymentIntent =
      invoice?.payment_intent && typeof invoice.payment_intent !== "string"
        ? invoice.payment_intent
        : null;

    const error = new Error(
      paymentIntent?.status === "requires_action"
        ? "Stripe requires additional payment confirmation before the upgrade can be applied. Your current plan is unchanged."
        : "Stripe could not complete the prorated upgrade charge. Your current plan is unchanged."
    );
    error.statusCode = 402;
    error.code = "stripe_upgrade_payment_incomplete";
    throw error;
  }

  try {
    await stripe.subscriptions.update(updatedStripeSubscription.id, {
      metadata: {
        ...(upgradeTarget.metadata || {}),
        addressId: String(addressId),
        userId: String(user.userId || user._id),
        localSubscriptionId: String(subscription._id),
      },
    });
  } catch (metadataError) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "subscription_upgrade_metadata_sync_failed",
        scope: "stripe_subscription_management",
        stripeSubscriptionId: updatedStripeSubscription.id,
        userId: String(user._id),
        addressId: String(addressId),
        message: metadataError?.message || "Unable to update Stripe subscription metadata",
      })
    );
  }

  return retrieveStripeSubscription(updatedStripeSubscription.id);
}

async function scheduleStripeSubscriptionDowngrade({
  stripeSubscription,
  subscription,
  user,
  addressId,
  nextPriceId,
}) {
  const item = getStripeSubscriptionItemForRecord({ subscription, stripeSubscription });
  if (!item?.id || !item?.price?.id) {
    throw new Error("Stripe subscription item not found");
  }

  let scheduleId = getStripeScheduleId(stripeSubscription);
  let schedule = scheduleId ? await retrieveStripeSubscriptionSchedule(scheduleId) : null;

  if (!schedule) {
    schedule = await stripe.subscriptionSchedules.create({
      from_subscription: stripeSubscription.id,
    });
    scheduleId = schedule.id;
    schedule = await retrieveStripeSubscriptionSchedule(scheduleId);
  }

  const scheduleMetadata = {
    ...(schedule?.metadata || {}),
    addressId: String(addressId),
    userId: String(user.userId || user._id),
    localSubscriptionId: String(subscription._id),
  };

  await stripe.subscriptionSchedules.update(String(scheduleId), {
    end_behavior: "release",
    metadata: scheduleMetadata,
    phases: [
      {
        start_date: stripeSubscription.current_period_start,
        end_date: stripeSubscription.current_period_end,
        items: [{ price: item.price.id, quantity: item.quantity || 1 }],
        metadata: scheduleMetadata,
        proration_behavior: "none",
      },
      {
        start_date: stripeSubscription.current_period_end,
        items: [{ price: nextPriceId, quantity: item.quantity || 1 }],
        metadata: scheduleMetadata,
        proration_behavior: "none",
      },
    ],
  });

  return retrieveStripeSubscription(stripeSubscription.id);
}

async function getOwnedSubscriptionForAddress({ userId, addressId, statuses = null }) {
  const query = {
    user: userId,
    addressId,
  };

  if (Array.isArray(statuses) && statuses.length) {
    query.status = { $in: statuses };
  }

  return Subscription.findOne(query).sort({ updatedAt: -1 });
}

module.exports = {
  stripe,
  hasStripeSecretKey,
  PLAN_PRICES,
  PRICE_MAP: LEGACY_PRICE_MAP,
  LEGACY_PRICE_MAP,
  PRICE_LOOKUP,
  normalizePlanType,
  normalizeBillingCycle,
  getPriceId: getLegacyPriceId,
  getLegacyPriceId,
  resolveStripePriceId,
  getPlanAndBillingFromPrice,
  mapStripePriceToPlan,
  normalizeStripeStatus,
  deriveAccessStatus,
  subscriptionGrantsAccess,
  verifySubscriptionAccess,
  reconcileActiveStripeSubscriptions,
  handleCancelAtPeriodEnd,
  handleCurrentPeriodStartEnd,
  handleTrial,
  handlePaymentFailure,
  getPlanPrice,
  getPlanRank,
  classifyPlanChange,
  toDate,
  serializeSubscription,
  syncLegacyUserSubscription,
  resolveUserStripeCustomerId,
  syncCustomerFromStripe,
  retrieveStripeSubscription,
  resolveStripeSubscriptionForRecord,
  getStripeSubscriptionItemForRecord,
  clearStripeSubscriptionSchedule,
  applyStripeSubscriptionUpgrade,
  scheduleStripeSubscriptionDowngrade,
  upsertSubscriptionFromStripe,
  getOwnedSubscriptionForAddress,
};
