const assert = require("node:assert/strict");
const {
  MINUTE_MS,
  evaluateReviewRequest,
  isCompletionTransition,
} = require("../utils/bookingReviewRequestPolicy");
const {
  claimReviewRequest,
  runBookingReviewRequestCycle,
} = require("../jobs/bookingReviewRequests");

const now = new Date("2026-06-20T16:00:00.000Z");

function completedBooking(minutesAgo, overrides = {}) {
  return {
    _id: "booking-1",
    status: "Completed",
    email: "customer@example.com",
    completedAt: new Date(now.getTime() - minutesAgo * MINUTE_MS),
    ...overrides,
  };
}

assert.equal(evaluateReviewRequest(completedBooking(59), now).eligible, false);
assert.equal(
  evaluateReviewRequest(completedBooking(59), now).reason,
  "waiting_60_minutes"
);
assert.equal(evaluateReviewRequest(completedBooking(60), now).eligible, true);
assert.equal(evaluateReviewRequest(completedBooking(180), now).eligible, true);
assert.equal(
  evaluateReviewRequest(
    completedBooking(60, { reviewRequestSentAt: new Date() }),
    now
  ).reason,
  "already_sent"
);
assert.equal(
  evaluateReviewRequest(completedBooking(60, { status: "Canceled" }), now)
    .reason,
  "status_not_completed"
);
assert.equal(
  evaluateReviewRequest(completedBooking(60, { status: "Failed" }), now)
    .eligible,
  false
);
assert.equal(
  evaluateReviewRequest(completedBooking(60, { status: "No-Show" }), now)
    .eligible,
  false
);

assert.equal(isCompletionTransition("Confirmed", "Completed"), true);
assert.equal(isCompletionTransition("Completed", "Completed"), false);
assert.equal(isCompletionTransition("Canceled", "Completed"), true);

function createAtomicBookingModel(initial) {
  const state = { ...initial };

  return {
    state,
    async updateOne(query, update) {
      const due =
        state.completedAt &&
        state.completedAt.getTime() <= query.completedAt.$lte.getTime();
      const statusMatches = query.status.test(state.status);
      const unsent = !state.reviewRequestSentAt;
      const unskipped = !state.reviewRequestSkippedAt;
      const lockAvailable =
        !state.reviewRequestLockExpiresAt ||
        state.reviewRequestLockExpiresAt <= now;

      if (!due || !statusMatches || !unsent || !unskipped || !lockAvailable) {
        return { modifiedCount: 0 };
      }

      Object.assign(state, update.$set);
      return { modifiedCount: 1 };
    },
  };
}

async function testAtomicClaim() {
  const BookingModel = createAtomicBookingModel(completedBooking(61));
  const claims = await Promise.all([
    claimReviewRequest("booking-1", now, BookingModel),
    claimReviewRequest("booking-1", now, BookingModel),
  ]);

  assert.equal(
    claims.filter((claim) => claim.claimed).length,
    1,
    "only one EB instance may claim a review request"
  );
  assert.ok(BookingModel.state.reviewRequestQueuedAt);
  assert.ok(BookingModel.state.reviewRequestLockExpiresAt > now);
}

function matchesValue(actual, expected) {
  if (expected instanceof RegExp) {
    expected.lastIndex = 0;
    return expected.test(String(actual || ""));
  }
  if (
    expected &&
    typeof expected === "object" &&
    !(expected instanceof Date)
  ) {
    if (Object.prototype.hasOwnProperty.call(expected, "$exists")) {
      return expected.$exists ? actual !== undefined : actual === undefined;
    }
    if (Object.prototype.hasOwnProperty.call(expected, "$lte")) {
      return actual != null && new Date(actual) <= new Date(expected.$lte);
    }
    if (Object.prototype.hasOwnProperty.call(expected, "$ne")) {
      return actual !== expected.$ne;
    }
    if (Object.prototype.hasOwnProperty.call(expected, "$gte")) {
      return actual != null && new Date(actual) >= new Date(expected.$gte);
    }
    if (Object.prototype.hasOwnProperty.call(expected, "$in")) {
      return expected.$in.includes(actual);
    }
  }
  if (expected === null) return actual == null;
  if (expected instanceof Date) {
    return new Date(actual).getTime() === expected.getTime();
  }
  return actual === expected;
}

function matchesQuery(document, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === "$and") {
      return expected.every((part) => matchesQuery(document, part));
    }
    if (key === "$or") {
      return expected.some((part) => matchesQuery(document, part));
    }
    return matchesValue(document[key], expected);
  });
}

function createFakeBookingModel(initialDocuments) {
  const documents = initialDocuments.map((document) => ({ ...document }));

  return {
    documents,
    find(query) {
      const chain = {
        results: documents.filter((document) => matchesQuery(document, query)),
        select() {
          return this;
        },
        sort(spec) {
          const [field, direction] = Object.entries(spec)[0];
          this.results.sort(
            (a, b) =>
              (new Date(a[field]).getTime() - new Date(b[field]).getTime()) *
              direction
          );
          return this;
        },
        limit(count) {
          this.results = this.results.slice(0, count);
          return this;
        },
        async lean() {
          return this.results.map((document) => ({ ...document }));
        },
      };
      return chain;
    },
    async updateOne(query, update) {
      const document = documents.find((item) => matchesQuery(item, query));
      if (!document) return { modifiedCount: 0 };
      if (update.$set) Object.assign(document, update.$set);
      if (update.$unset) {
        for (const field of Object.keys(update.$unset)) delete document[field];
      }
      return { modifiedCount: 1 };
    },
    async exists(query) {
      return documents.some((document) => matchesQuery(document, query));
    },
  };
}

async function testWorkerCycle() {
  const BookingModel = createFakeBookingModel([
    { ...completedBooking(59), _id: "too-early" },
    { ...completedBooking(61), _id: "due" },
    { ...completedBooking(61), _id: "canceled", status: "Canceled" },
    {
      ...completedBooking(61),
      _id: "already-sent",
      reviewRequestSentAt: new Date(),
    },
  ]);
  const sends = [];
  const sendEmail = async (...args) => {
    sends.push(args);
    return { messageId: "test-message" };
  };

  const first = await runBookingReviewRequestCycle(now, {
    BookingModel,
    sendEmail,
  });
  assert.equal(first.sent, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0][0], "booking_review_request");
  assert.ok(
    BookingModel.documents.find((item) => item._id === "due")
      .reviewRequestSentAt
  );

  const second = await runBookingReviewRequestCycle(now, {
    BookingModel,
    sendEmail,
  });
  assert.equal(second.sent, 0);
  assert.equal(sends.length, 1, "already-sent booking must not send twice");
}

async function testConcurrentWorkers() {
  const BookingModel = createFakeBookingModel([
    { ...completedBooking(61), _id: "concurrent" },
  ]);
  let sends = 0;
  const sendEmail = async () => {
    sends++;
    return { messageId: "concurrent-message" };
  };

  await Promise.all([
    runBookingReviewRequestCycle(now, { BookingModel, sendEmail }),
    runBookingReviewRequestCycle(now, { BookingModel, sendEmail }),
  ]);
  assert.equal(sends, 1, "multiple EB workers must produce one send");
}

async function testFailureReleasesLock() {
  const BookingModel = createFakeBookingModel([
    { ...completedBooking(61), _id: "failure" },
  ]);
  const result = await runBookingReviewRequestCycle(now, {
    BookingModel,
    sendEmail: async () => {
      throw new Error("simulated provider failure");
    },
  });
  const booking = BookingModel.documents[0];

  assert.equal(result.failed, 1);
  assert.equal(booking.reviewRequestQueuedAt, undefined);
  assert.equal(booking.reviewRequestLockExpiresAt, undefined);
  assert.equal(booking.reviewRequestSentAt, undefined);
}

/*
 * The per-customer cooldown: off by default (every completed booking is asked,
 * exactly as before), and when set, a customer asked within the window is not
 * asked again - their new booking is marked skipped, not emailed.
 */
async function testCustomerCooldown() {
  const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
  const seed = () => [
    { ...completedBooking(61), _id: "earlier", email: "member@example.com", reviewRequestSentAt: tenDaysAgo },
    { ...completedBooking(61), _id: "latest", email: "Member@Example.com" },
  ];
  const sendEmail = async () => ({ messageId: "test-message" });

  const off = createFakeBookingModel(seed());
  const offResult = await runBookingReviewRequestCycle(now, { BookingModel: off, sendEmail, cooldownDays: 0 });
  assert.equal(offResult.sent, 1, "cooldown off: the new booking is asked, as before");

  const on = createFakeBookingModel(seed());
  const onResult = await runBookingReviewRequestCycle(now, { BookingModel: on, sendEmail, cooldownDays: 30 });
  const latest = on.documents.find((item) => item._id === "latest");
  assert.equal(onResult.sent, 0, "asked 10 days ago: not asked again inside a 30-day window");
  assert.ok(latest.reviewRequestSkippedAt, "the skipped booking is marked so it is not re-evaluated");
  assert.equal(latest.reviewRequestSentAt, undefined);

  const outside = createFakeBookingModel(seed());
  const outsideResult = await runBookingReviewRequestCycle(now, { BookingModel: outside, sendEmail, cooldownDays: 7 });
  assert.equal(outsideResult.sent, 1, "asked 10 days ago: asked again once a 7-day window has passed");
}

Promise.resolve()
  .then(testAtomicClaim)
  .then(testCustomerCooldown)
  .then(testWorkerCycle)
  .then(testConcurrentWorkers)
  .then(testFailureReleasesLock)
  .then(() => {
    console.log("Booking review request policy tests passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
