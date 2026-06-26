const assert = require("assert");
const {
  applyOneTimePaymentSuccessToBooking,
  applyOneTimePaymentSuccessToEntitlement,
  expiredOneTimeHoldBookingUpdate,
  oneTimeReservationProtectionExpiresAt,
  reservationIssueFromPromotionError,
} = require("../utils/oneTimeVisitPaymentFlow");
const { expireOneTimeVisitHolds } = require("../jobs/oneTimeVisitHolds");

const now = new Date("2026-06-25T14:00:00.000Z");
const session = {
  id: "cs_test_one_time",
  customer: "cus_test",
  payment_intent: "pi_test",
};

function booking(overrides = {}) {
  return {
    _id: "booking-1",
    date: new Date("2026-06-26T15:00:00.000Z"),
    status: "Pending",
    paymentState: "pending",
    paymentStatus: "Pending",
    paymentHoldExpiresAt: new Date("2026-06-25T14:20:00.000Z"),
    note: "Replace faucet in upstairs bath",
    ...overrides,
  };
}

function entitlement(overrides = {}) {
  return {
    status: "pending_payment",
    stripeCheckoutSessionId: null,
    stripeCustomerId: null,
    stripePaymentIntentId: null,
    purchasedAt: null,
    bookingId: null,
    holdExpiresAt: new Date("2026-06-25T14:20:00.000Z"),
    ...overrides,
  };
}

{
  const state = applyOneTimePaymentSuccessToBooking(booking(), { session });
  assert.equal(state.paymentState, "paid");
  assert.equal(state.paymentStatus, "Paid");
  assert.equal(state.status, "Pending");
  assert.equal(state.accessType, "one_time");
  assert.equal(state.bookingType, "one_time_handyman_visit");
  assert.equal(state.paymentHoldExpiresAt, null);
  assert.equal(state.reservationIssue, undefined);
}

{
  const paidEntitlement = applyOneTimePaymentSuccessToEntitlement(
    entitlement(),
    session,
    "booking-1"
  );
  assert.equal(paidEntitlement.status, "paid");
  assert.equal(paidEntitlement.stripeCheckoutSessionId, session.id);
  assert.equal(paidEntitlement.stripeCustomerId, session.customer);
  assert.equal(paidEntitlement.stripePaymentIntentId, session.payment_intent);
  assert.equal(paidEntitlement.bookingId, "booking-1");
  assert.equal(paidEntitlement.holdExpiresAt, null);
}

{
  const holdExpiresAt = oneTimeReservationProtectionExpiresAt(
    "2026-06-26T15:00:00.000Z",
    now
  );
  assert.ok(holdExpiresAt > new Date("2026-06-26T15:00:00.000Z"));

  const issue = reservationIssueFromPromotionError(
    Object.assign(new Error("Booking reservation hold was not found"), {
      code: "RESERVATION_NOT_FOUND",
    }),
    session,
    holdExpiresAt
  );
  const state = applyOneTimePaymentSuccessToBooking(booking(), {
    session,
    reservationIssue: issue,
  });
  assert.equal(state.paymentState, "paid");
  assert.equal(state.paymentStatus, "Paid - Reservation Review Needed");
  assert.equal(state.status, "Pending");
  assert.equal(state.paymentHoldExpiresAt, holdExpiresAt);
  assert.equal(state.reservationIssue.status, "reservation_promotion_failed");
  assert.match(state.note, /ADMIN REVIEW/);

  const duplicate = applyOneTimePaymentSuccessToBooking(state, {
    session,
    reservationIssue: issue,
  });
  assert.equal(
    duplicate.note.match(/ADMIN REVIEW/g).length,
    1,
    "duplicate webhook processing must not duplicate admin issue notes"
  );
}

{
  const update = expiredOneTimeHoldBookingUpdate("expired");
  assert.deepEqual(update, {
    status: "Canceled",
    paymentState: "expired",
    paymentStatus: "Expired",
  });
}

async function testExpiredHoldRelease() {
  const expiredBooking = booking({
    _id: "expired-booking",
    bookingType: "one_time_handyman_visit",
    paymentState: "pending",
    paymentHoldExpiresAt: new Date("2026-06-25T13:59:00.000Z"),
  });
  const calls = {
    releaseLegacySlot: 0,
    bookingUpdates: [],
    entitlementUpdates: [],
  };

  const BookingModel = {
    find(query) {
      assert.equal(query.bookingType, "one_time_handyman_visit");
      assert.equal(query.paymentState, "pending");
      assert.deepEqual(query.paymentHoldExpiresAt, { $lte: now });
      return {
        limit(limit) {
          assert.equal(limit, 100);
          return [expiredBooking];
        },
      };
    },
    async updateOne(filter, update) {
      calls.bookingUpdates.push({ filter, update });
    },
  };

  const VisitEntitlementModel = {
    async updateOne(filter, update) {
      calls.entitlementUpdates.push({ filter, update });
    },
  };

  const expired = await expireOneTimeVisitHolds(now, {
    BookingModel,
    VisitEntitlementModel,
    reservationEngineEnabled: () => false,
    releaseLegacySlot: async (releasedBooking) => {
      assert.equal(releasedBooking._id, expiredBooking._id);
      calls.releaseLegacySlot += 1;
    },
  });

  assert.equal(expired, 1);
  assert.equal(calls.releaseLegacySlot, 1);
  assert.equal(calls.bookingUpdates.length, 1);
  assert.deepEqual(calls.bookingUpdates[0].filter, {
    _id: "expired-booking",
    paymentState: "pending",
  });
  assert.deepEqual(calls.bookingUpdates[0].update.$set, {
    status: "Canceled",
    paymentState: "expired",
    paymentStatus: "Expired",
  });
  assert.equal(calls.entitlementUpdates.length, 1);
}

testExpiredHoldRelease()
  .then(() => {
    console.log("One-time visit payment flow tests passed");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
