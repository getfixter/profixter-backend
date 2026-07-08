process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_subscription_resolution";

const assert = require("assert");
const {
  subscriptionGrantsAccess,
  selectCurrentSubscription,
  subscriptionSelectionDiagnostics,
} = require("../utils/subscriptionManagement");

function sub(overrides = {}) {
  return {
    _id: overrides._id || `sub_${Math.random().toString(16).slice(2)}`,
    subscriptionType: overrides.subscriptionType || "basic",
    status: overrides.status || "active",
    accessStatus: overrides.accessStatus || "active",
    stripeSubscriptionId: overrides.stripeSubscriptionId || "sub_stripe",
    cancelAtPeriodEnd: overrides.cancelAtPeriodEnd || false,
    currentPeriodEnd: overrides.currentPeriodEnd || new Date("2026-08-01T12:00:00.000Z"),
    nextPaymentDate: overrides.nextPaymentDate || new Date("2026-08-01T12:00:00.000Z"),
    createdAt: overrides.createdAt || new Date("2026-07-01T12:00:00.000Z"),
    updatedAt: overrides.updatedAt || new Date("2026-07-01T12:00:00.000Z"),
  };
}

const oldCanceled = sub({
  _id: "old_canceled",
  status: "canceled",
  accessStatus: "inactive",
  stripeSubscriptionId: "sub_old",
  currentPeriodEnd: new Date("2026-06-01T12:00:00.000Z"),
  createdAt: new Date("2026-01-01T12:00:00.000Z"),
});

const activeBasic = sub({
  _id: "active_basic",
  stripeSubscriptionId: "sub_active",
  currentPeriodEnd: new Date("2026-08-01T12:00:00.000Z"),
  createdAt: new Date("2026-07-01T12:00:00.000Z"),
});

assert.equal(subscriptionGrantsAccess(oldCanceled), false);
assert.equal(subscriptionGrantsAccess(activeBasic), true);
assert.equal(selectCurrentSubscription([oldCanceled, activeBasic])._id, "active_basic");

const newerCanceled = sub({
  _id: "newer_canceled",
  status: "canceled",
  accessStatus: "inactive",
  stripeSubscriptionId: "sub_newer_canceled",
  currentPeriodEnd: new Date("2026-09-01T12:00:00.000Z"),
  createdAt: new Date("2026-08-01T12:00:00.000Z"),
});

assert.equal(
  selectCurrentSubscription([oldCanceled, activeBasic, newerCanceled])._id,
  "active_basic"
);

const staleLocalActive = sub({
  _id: "stale_local",
  status: "active",
  accessStatus: "inactive",
  stripeSubscriptionId: "sub_stale",
  currentPeriodEnd: new Date("2026-06-01T12:00:00.000Z"),
});

assert.equal(subscriptionGrantsAccess(staleLocalActive), false);

const stripeStatusBySubscriptionId = new Map([["sub_stale", "active"]]);
assert.equal(
  selectCurrentSubscription([oldCanceled, staleLocalActive], {
    stripeStatusBySubscriptionId,
  })._id,
  "stale_local"
);
assert.equal(
  subscriptionGrantsAccess(staleLocalActive, {
    stripeStatus: "active",
    stripeConfirmed: true,
  }),
  true
);

const diagnostics = subscriptionSelectionDiagnostics(
  [oldCanceled, activeBasic],
  activeBasic
);
assert.deepEqual(
  diagnostics.map((entry) => ({
    id: entry.subscriptionId,
    selected: entry.selected,
    grantsAccess: entry.grantsAccess,
  })),
  [
    { id: "old_canceled", selected: false, grantsAccess: false },
    { id: "active_basic", selected: true, grantsAccess: true },
  ]
);

console.log("admin subscription plan resolution tests passed");
