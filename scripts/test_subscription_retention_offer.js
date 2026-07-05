const assert = require("node:assert/strict");
const {
  applyRetentionCouponToStripe,
  buildRetentionAcceptedAdminSections,
  calculateRetentionDiscountCents,
  describeCouponDiscount,
  evaluateRetentionOfferAcceptance,
  evaluateRetentionOfferDisplay,
} = require("../utils/subscriptionRetentionOffer");
const {
  renderAdminEventSectionsEmail,
} = require("../utils/adminLeadNotification");

const env = { STRIPE_RETENTION_COUPON_ID: "coupon_retention_test" };

function activeSubscription(overrides = {}) {
  return {
    _id: "submongo_123",
    userId: "12345678",
    status: "active",
    cancelAtPeriodEnd: false,
    subscriptionType: "plus",
    planPrice: 249,
    billingCycle: "monthly",
    currentPeriodEnd: new Date("2026-08-05T14:00:00.000Z"),
    stripeSubscriptionId: "sub_123",
    stripeCustomerId: "cus_123",
    addressId: "addr_123",
    addressSnapshot: {
      line1: "100 Main Street",
      city: "Babylon",
      state: "NY",
      zip: "11702",
      county: "Suffolk",
    },
    retentionOffer: {},
    ...overrides,
  };
}

async function run() {
  assert.deepEqual(evaluateRetentionOfferDisplay(activeSubscription(), env), {
    eligible: true,
    reason: "eligible",
  });

  assert.equal(
    evaluateRetentionOfferDisplay(activeSubscription(), {}).reason,
    "coupon_env_missing"
  );
  assert.equal(
    evaluateRetentionOfferDisplay(
      activeSubscription({ cancelAtPeriodEnd: true }),
      env
    ).reason,
    "subscription_cancellation_unavailable"
  );
  assert.equal(
    evaluateRetentionOfferDisplay(
      activeSubscription({ retentionOffer: { offeredAt: new Date() } }),
      env
    ).eligible,
    true
  );
  assert.equal(
    evaluateRetentionOfferDisplay(
      activeSubscription({ retentionOffer: { acceptedAt: new Date() } }),
      env
    ).reason,
    "retention_offer_already_accepted"
  );
  assert.equal(
    evaluateRetentionOfferDisplay(
      activeSubscription({ retentionOffer: { declinedAt: new Date() } }),
      env
    ).reason,
    "retention_offer_already_declined"
  );

  assert.equal(
    evaluateRetentionOfferAcceptance(
      activeSubscription({ retentionOffer: { offeredAt: new Date() } }),
      env
    ).eligible,
    true
  );
  assert.equal(
    evaluateRetentionOfferAcceptance(
      activeSubscription({ retentionOffer: { acceptedAt: new Date() } }),
      env
    ).reason,
    "retention_offer_already_accepted"
  );
  assert.equal(
    evaluateRetentionOfferAcceptance(
      activeSubscription({ retentionOffer: { declinedAt: new Date() } }),
      env
    ).reason,
    "retention_offer_already_declined"
  );

  let capturedUpdate;
  const stripeClient = {
    subscriptions: {
      update: async (id, params) => {
        capturedUpdate = { id, params };
        return {
          id,
          customer: "cus_123",
          discounts: [{ discount: { id: "di_123" } }],
        };
      },
    },
  };

  const updatedStripeSubscription = await applyRetentionCouponToStripe({
    stripeClient,
    stripeSubscriptionId: "sub_123",
    couponId: "coupon_retention_test",
  });

  assert.equal(updatedStripeSubscription.id, "sub_123");
  assert.equal(capturedUpdate.id, "sub_123");
  assert.deepEqual(capturedUpdate.params.discounts, [
    { coupon: "coupon_retention_test" },
  ]);
  assert.equal(capturedUpdate.params.proration_behavior, "none");

  const coupon = {
    id: "coupon_retention_test",
    percent_off: 30,
    currency: "usd",
  };
  assert.equal(calculateRetentionDiscountCents(coupon, 24900), 7470);
  assert.equal(
    describeCouponDiscount(coupon, 7470, "usd"),
    "30% off ($74.70 estimated)"
  );

  const sections = buildRetentionAcceptedAdminSections({
    user: {
      _id: "user_mongo_123",
      userId: "12345678",
      name: "Taylor Homeowner",
      email: "taylor@example.com",
      phone: "631-555-1212",
    },
    address: activeSubscription().addressSnapshot,
    subscription: activeSubscription(),
    stripeSubscription: updatedStripeSubscription,
    coupon,
    couponId: "coupon_retention_test",
    acceptedAt: new Date("2026-07-05T15:00:00.000Z"),
  });

  const rendered = renderAdminEventSectionsEmail({
    subject: "RETENTION OFFER ACCEPTED",
    heading: "RETENTION OFFER ACCEPTED",
    sections,
  });

  assert.equal(rendered.subject, "RETENTION OFFER ACCEPTED");
  assert.ok(rendered.text.includes("Customer name: Taylor Homeowner"));
  assert.ok(rendered.text.includes("Property address: 100 Main Street, Babylon, NY, 11702, Suffolk"));
  assert.ok(rendered.text.includes("Coupon ID applied: coupon_retention_test"));
  assert.ok(rendered.text.includes("Stripe Subscription ID: sub_123"));
  assert.ok(rendered.text.includes("Stripe Customer ID: cus_123"));
  assert.ok(rendered.text.includes("Stripe Discount ID: di_123"));

  console.log("Subscription retention offer tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
