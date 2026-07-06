const assert = require("node:assert/strict");

const {
  buildSubscriptionCanceledAdminFields,
  formatMoneyPerMonth,
  shouldSendSubscriptionCanceledAdminEmail,
} = require("../utils/subscriptionCancellationAdminEmail");
const {
  renderAdminEventEmail,
} = require("../utils/adminLeadNotification");

function date(value) {
  return new Date(value);
}

function formatDateTime(value) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function fieldMap(fields) {
  return new Map(fields);
}

const user = {
  _id: "user_mongo_123",
  userId: "customer_123",
  name: "Taylor Homeowner",
  email: "taylor@example.com",
  phone: "631-555-0100",
};

const address = {
  _id: "address_123",
  line1: "100 Main Street",
  city: "Babylon",
  state: "NY",
  zip: "11702",
  county: "Suffolk",
};

const previousActiveSubscription = {
  _id: "local_subscription_123",
  status: "active",
  cancelAtPeriodEnd: false,
  retentionOffer: {
    offeredAt: date("2026-07-05T14:00:00.000Z"),
    declinedAt: null,
    acceptedAt: null,
  },
};

const scheduledSubscription = {
  _id: "local_subscription_123",
  status: "active",
  subscriptionType: "Premium",
  planPrice: 149,
  stripeCustomerId: "cus_local",
  stripeSubscriptionId: "sub_local",
  addressId: "address_123",
  cancelAtPeriodEnd: true,
  cancellationDate: date("2026-08-01T13:00:00.000Z"),
  currentPeriodEnd: date("2026-08-01T13:00:00.000Z"),
  addressSnapshot: {
    line1: "100 Main Street",
    city: "Babylon",
    state: "NY",
    zip: "11702",
    county: "Suffolk",
  },
  retentionOffer: {
    offeredAt: date("2026-07-05T14:00:00.000Z"),
    declinedAt: date("2026-07-06T15:00:00.000Z"),
    acceptedAt: null,
  },
};

const stripeBeforeActive = {
  id: "sub_123",
  customer: "cus_123",
  status: "active",
  cancel_at_period_end: false,
};

const stripeAfterScheduled = {
  id: "sub_123",
  customer: "cus_123",
  status: "active",
};

assert.equal(formatMoneyPerMonth(149), "$149/month");
assert.equal(formatMoneyPerMonth(149.5), "$149.50/month");

assert.equal(
  shouldSendSubscriptionCanceledAdminEmail({
    previousSubscription: previousActiveSubscription,
    updatedSubscription: scheduledSubscription,
    stripeSubscriptionBefore: stripeBeforeActive,
  }),
  true,
  "fresh period-end cancellation should send the admin cancellation email"
);

assert.equal(
  shouldSendSubscriptionCanceledAdminEmail({
    previousSubscription: {
      ...previousActiveSubscription,
      cancelAtPeriodEnd: true,
    },
    updatedSubscription: scheduledSubscription,
    stripeSubscriptionBefore: stripeBeforeActive,
  }),
  false,
  "already locally scheduled cancellations should not send duplicate admin emails"
);

assert.equal(
  shouldSendSubscriptionCanceledAdminEmail({
    previousSubscription: previousActiveSubscription,
    updatedSubscription: scheduledSubscription,
    stripeSubscriptionBefore: {
      ...stripeBeforeActive,
      cancel_at_period_end: true,
    },
  }),
  false,
  "already scheduled Stripe subscriptions should not send duplicate admin emails"
);

assert.equal(
  shouldSendSubscriptionCanceledAdminEmail({
    previousSubscription: previousActiveSubscription,
    updatedSubscription: {
      ...scheduledSubscription,
      retentionOffer: {
        acceptedAt: date("2026-07-06T15:00:00.000Z"),
      },
    },
    stripeSubscriptionBefore: stripeBeforeActive,
  }),
  false,
  "accepted retention offers should suppress the cancellation admin email"
);

const fields = buildSubscriptionCanceledAdminFields({
  user,
  address,
  subscription: scheduledSubscription,
  stripeSubscription: stripeAfterScheduled,
  requestedAt: date("2026-07-06T15:01:00.000Z"),
  accessEndDate: scheduledSubscription.cancellationDate,
  retentionOfferDeclined: true,
  formatDateTime,
});
const fieldsByLabel = fieldMap(fields);

assert.equal(fieldsByLabel.get("Customer full name"), "Taylor Homeowner");
assert.equal(fieldsByLabel.get("Email"), "taylor@example.com");
assert.equal(fieldsByLabel.get("Phone"), "631-555-0100");
assert.equal(
  fieldsByLabel.get("Service address"),
  "100 Main Street, Babylon, NY, 11702, Suffolk"
);
assert.equal(fieldsByLabel.get("City"), "Babylon");
assert.equal(fieldsByLabel.get("State"), "NY");
assert.equal(fieldsByLabel.get("ZIP"), "11702");
assert.equal(fieldsByLabel.get("County"), "Suffolk");
assert.equal(fieldsByLabel.get("Plan name"), "Premium");
assert.equal(fieldsByLabel.get("Monthly price"), "$149/month");
assert.equal(fieldsByLabel.get("Stripe customer ID"), "cus_123");
assert.equal(fieldsByLabel.get("Stripe subscription ID"), "sub_123");
assert.equal(fieldsByLabel.get("Local subscription ID"), "local_subscription_123");
assert.equal(fieldsByLabel.get("Address ID"), "address_123");
assert.equal(
  fieldsByLabel.get("Cancellation requested date/time"),
  "2026-07-06T15:01:00.000Z"
);
assert.equal(
  fieldsByLabel.get("Access termination date / period end date"),
  "2026-08-01T13:00:00.000Z"
);
assert.equal(fieldsByLabel.get("Cancellation timing"), "Scheduled at period end");
assert.equal(fieldsByLabel.get("Current subscription status"), "active");
assert.equal(
  fieldsByLabel.get("Retention offer status"),
  "Declined and continued cancellation"
);
assert.equal(fieldsByLabel.get("Was retention offer shown?"), "Yes");
assert.equal(
  fieldsByLabel.get("Was retention offer declined?"),
  "Yes - 2026-07-06T15:00:00.000Z"
);
assert.equal(fieldsByLabel.get("Was retention offer accepted?"), "No");
assert.equal(
  fieldsByLabel.get("Retention offer shown at"),
  "2026-07-05T14:00:00.000Z"
);

const rendered = renderAdminEventEmail({
  subject: "SUBSCRIPTION CANCELED",
  heading: "SUBSCRIPTION CANCELED",
  fields,
});

assert.equal(rendered.subject, "SUBSCRIPTION CANCELED");
assert.match(rendered.text, /^SUBSCRIPTION CANCELED/);
assert.match(rendered.text, /Monthly price: \$149\/month/);
assert.match(rendered.text, /Stripe customer ID: cus_123/);
assert.match(rendered.text, /Stripe subscription ID: sub_123/);
assert.match(rendered.text, /Local subscription ID: local_subscription_123/);
assert.match(rendered.text, /Address ID: address_123/);
assert.match(rendered.text, /Retention offer status: Declined and continued cancellation/);
assert.match(rendered.text, /Was retention offer accepted\?: No/);

console.log("Subscription cancellation admin email tests passed.");
