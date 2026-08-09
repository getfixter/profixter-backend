/**
 * First Visit Free — eligibility state machine and address dedup tests.
 *
 * Pure unit tests. No database, no network, no production data.
 *   node scripts/test_intro_visit_eligibility.js
 */

const assert = require("assert");
const {
  INTRO_VISIT_STATUS,
  resolveClaimedState,
  getIntroVisitState,
  claimIntroVisit,
  buildAddressKey,
  findDuplicateAddress,
} = require("../utils/introVisitEligibility");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

/* ---------------- fakes ---------------- */

function fakeBookingModel(docs = []) {
  const store = docs.slice();
  return {
    store,
    findById(id) {
      const found = store.find((d) => String(d._id) === String(id)) || null;
      return {
        select: () => ({ lean: async () => found }),
      };
    },
    findOne() {
      const self = this;
      return {
        sort: () => ({
          select: () => ({
            lean: async () => self.store.find((d) => d.isFreeFirstVisit) || null,
          }),
        }),
      };
    },
  };
}

function fakeUser(addresses = []) {
  return {
    _id: "user-1",
    addresses,
    saveCount: 0,
    async save() {
      this.saveCount += 1;
    },
  };
}

/* ---------------- state machine ---------------- */

console.log("\nresolveClaimedState");

test("completedAt consumes the offer", () => {
  assert.strictEqual(
    resolveClaimedState({ status: "Confirmed", completedAt: new Date() }),
    INTRO_VISIT_STATUS.CONSUMED
  );
});

test("Completed status consumes the offer", () => {
  assert.strictEqual(
    resolveClaimedState({ status: "Completed", completedAt: null }),
    INTRO_VISIT_STATUS.CONSUMED
  );
});

test("Canceled before service releases the offer", () => {
  assert.strictEqual(
    resolveClaimedState({ status: "Canceled", completedAt: null }),
    INTRO_VISIT_STATUS.AVAILABLE
  );
});

test("British spelling 'Cancelled' also releases", () => {
  assert.strictEqual(
    resolveClaimedState({ status: "Cancelled", completedAt: null }),
    INTRO_VISIT_STATUS.AVAILABLE
  );
});

test("Pending stays claimed", () => {
  assert.strictEqual(
    resolveClaimedState({ status: "Pending", completedAt: null }),
    INTRO_VISIT_STATUS.CLAIMED
  );
});

test("Confirmed stays claimed", () => {
  assert.strictEqual(
    resolveClaimedState({ status: "Confirmed", completedAt: null }),
    INTRO_VISIT_STATUS.CLAIMED
  );
});

test("no-show stays claimed (conservative, not released)", () => {
  assert.strictEqual(
    resolveClaimedState({ status: "No-Show", completedAt: null }),
    INTRO_VISIT_STATUS.CLAIMED
  );
});

test("missing booking stays claimed, never released", () => {
  assert.strictEqual(resolveClaimedState(null), INTRO_VISIT_STATUS.CLAIMED);
});

test("completed booking that was later deleted cannot be released", () => {
  // The consumed state is already persisted on the address, so a vanished
  // booking never re-grants the offer. Guarded here at the unit level too.
  assert.notStrictEqual(resolveClaimedState(null), INTRO_VISIT_STATUS.AVAILABLE);
});

/* ---------------- lifecycle ---------------- */

(async () => {
  console.log("\ngetIntroVisitState — lifecycle");

  await testAsync("new address with no history is available", async () => {
    const address = { _id: "addr-1" };
    const user = fakeUser([address]);
    const state = await getIntroVisitState({
      user,
      address,
      Booking: fakeBookingModel([]),
    });
    assert.strictEqual(state.status, INTRO_VISIT_STATUS.AVAILABLE);
    assert.strictEqual(state.isAvailable, true);
  });

  await testAsync("legacy address with completed free visit derives consumed", async () => {
    const address = { _id: "addr-1" };
    const user = fakeUser([address]);
    const Booking = fakeBookingModel([
      { _id: "b1", isFreeFirstVisit: true, status: "Completed", completedAt: new Date() },
    ]);
    const state = await getIntroVisitState({ user, address, Booking });
    assert.strictEqual(state.status, INTRO_VISIT_STATUS.CONSUMED);
    assert.strictEqual(state.isAvailable, false);
  });

  await testAsync("legacy address with canceled free visit derives available", async () => {
    const address = { _id: "addr-1" };
    const user = fakeUser([address]);
    const Booking = fakeBookingModel([
      { _id: "b1", isFreeFirstVisit: true, status: "Canceled", completedAt: null },
    ]);
    const state = await getIntroVisitState({ user, address, Booking });
    assert.strictEqual(state.status, INTRO_VISIT_STATUS.AVAILABLE);
  });

  await testAsync("claim marks the address claimed", async () => {
    const address = { _id: "addr-1" };
    const user = fakeUser([address]);
    await claimIntroVisit({ user, address, bookingId: "b1" });
    assert.strictEqual(address.introVisit.status, INTRO_VISIT_STATUS.CLAIMED);
    assert.strictEqual(address.introVisit.bookingId, "b1");
  });

  await testAsync("claimed + canceled booking releases back to available", async () => {
    const address = {
      _id: "addr-1",
      introVisit: { status: "claimed", bookingId: "b1", claimedAt: new Date(), consumedAt: null },
    };
    const user = fakeUser([address]);
    const Booking = fakeBookingModel([{ _id: "b1", status: "Canceled", completedAt: null }]);
    const state = await getIntroVisitState({ user, address, Booking });
    assert.strictEqual(state.status, INTRO_VISIT_STATUS.AVAILABLE);
    assert.strictEqual(address.introVisit.bookingId, null);
  });

  await testAsync("claimed + completed booking becomes consumed", async () => {
    const completedAt = new Date();
    const address = {
      _id: "addr-1",
      introVisit: { status: "claimed", bookingId: "b1", claimedAt: new Date(), consumedAt: null },
    };
    const user = fakeUser([address]);
    const Booking = fakeBookingModel([{ _id: "b1", status: "Completed", completedAt }]);
    const state = await getIntroVisitState({ user, address, Booking });
    assert.strictEqual(state.status, INTRO_VISIT_STATUS.CONSUMED);
    assert.strictEqual(address.introVisit.consumedAt.getTime(), completedAt.getTime());
  });

  await testAsync("consumed is permanent even if the booking disappears", async () => {
    const address = {
      _id: "addr-1",
      introVisit: { status: "consumed", bookingId: "b1", claimedAt: new Date(), consumedAt: new Date() },
    };
    const user = fakeUser([address]);
    // Empty booking store: the booking no longer exists at all.
    const state = await getIntroVisitState({ user, address, Booking: fakeBookingModel([]) });
    assert.strictEqual(state.status, INTRO_VISIT_STATUS.CONSUMED);
    assert.strictEqual(state.isAvailable, false);
  });

  await testAsync("consumed is permanent even if booking flips to Canceled", async () => {
    const address = {
      _id: "addr-1",
      introVisit: { status: "consumed", bookingId: "b1", claimedAt: new Date(), consumedAt: new Date() },
    };
    const user = fakeUser([address]);
    const Booking = fakeBookingModel([{ _id: "b1", status: "Canceled", completedAt: null }]);
    const state = await getIntroVisitState({ user, address, Booking });
    assert.strictEqual(state.status, INTRO_VISIT_STATUS.CONSUMED);
  });

  await testAsync("rebooking after release works, then consumes", async () => {
    const address = { _id: "addr-1" };
    const user = fakeUser([address]);

    await claimIntroVisit({ user, address, bookingId: "b1" });
    let Booking = fakeBookingModel([{ _id: "b1", status: "Canceled", completedAt: null }]);
    let state = await getIntroVisitState({ user, address, Booking });
    assert.strictEqual(state.status, INTRO_VISIT_STATUS.AVAILABLE, "released after cancel");

    await claimIntroVisit({ user, address, bookingId: "b2" });
    Booking = fakeBookingModel([{ _id: "b2", status: "Completed", completedAt: new Date() }]);
    state = await getIntroVisitState({ user, address, Booking });
    assert.strictEqual(state.status, INTRO_VISIT_STATUS.CONSUMED, "consumed after completion");
  });

  /* ---------------- address dedup ---------------- */

  console.log("\nAddress normalization and dedup");

  test("identical addresses match", () => {
    const a = { line1: "123 Main St", city: "Babylon", state: "NY", zip: "11702" };
    const b = { line1: "123 Main St", city: "Babylon", state: "NY", zip: "11702" };
    assert.strictEqual(buildAddressKey(a), buildAddressKey(b));
  });

  test("street suffix variants match", () => {
    const a = { line1: "123 Main Street", city: "Babylon", state: "NY", zip: "11702" };
    const b = { line1: "123 Main St.", city: "Babylon", state: "NY", zip: "11702" };
    assert.strictEqual(buildAddressKey(a), buildAddressKey(b));
  });

  test("case and spacing variants match", () => {
    const a = { line1: "123  MAIN st", city: "babylon", state: "ny", zip: "11702" };
    const b = { line1: "123 Main St", city: "Babylon", state: "NY", zip: "11702" };
    assert.strictEqual(buildAddressKey(a), buildAddressKey(b));
  });

  test("ZIP+4 matches base ZIP", () => {
    const a = { line1: "123 Main St", city: "Babylon", state: "NY", zip: "11702-1234" };
    const b = { line1: "123 Main St", city: "Babylon", state: "NY", zip: "11702" };
    assert.strictEqual(buildAddressKey(a), buildAddressKey(b));
  });

  test("CRITICAL: Apt 1 and Apt 2 never match", () => {
    const a = { line1: "123 Main St Apt 1", city: "Babylon", state: "NY", zip: "11702" };
    const b = { line1: "123 Main St Apt 2", city: "Babylon", state: "NY", zip: "11702" };
    assert.notStrictEqual(buildAddressKey(a), buildAddressKey(b));
  });

  test("CRITICAL: Unit 3A and Unit 3B never match", () => {
    const a = { line1: "50 Ocean Ave Unit 3A", city: "Bay Shore", state: "NY", zip: "11706" };
    const b = { line1: "50 Ocean Ave Unit 3B", city: "Bay Shore", state: "NY", zip: "11706" };
    assert.notStrictEqual(buildAddressKey(a), buildAddressKey(b));
  });

  test("unit synonyms match when the unit value is the same", () => {
    const a = { line1: "50 Ocean Ave Apt 3", city: "Bay Shore", state: "NY", zip: "11706" };
    const b = { line1: "50 Ocean Ave #3", city: "Bay Shore", state: "NY", zip: "11706" };
    assert.strictEqual(buildAddressKey(a), buildAddressKey(b));
  });

  test("house and apartment at same street are distinct", () => {
    const a = { line1: "123 Main St", city: "Babylon", state: "NY", zip: "11702" };
    const b = { line1: "123 Main St Apt 1", city: "Babylon", state: "NY", zip: "11702" };
    assert.notStrictEqual(buildAddressKey(a), buildAddressKey(b));
  });

  test("different house numbers are distinct", () => {
    const a = { line1: "123 Main St", city: "Babylon", state: "NY", zip: "11702" };
    const b = { line1: "125 Main St", city: "Babylon", state: "NY", zip: "11702" };
    assert.notStrictEqual(buildAddressKey(a), buildAddressKey(b));
  });

  test("different ZIP is distinct", () => {
    const a = { line1: "123 Main St", city: "Babylon", state: "NY", zip: "11702" };
    const b = { line1: "123 Main St", city: "Babylon", state: "NY", zip: "11703" };
    assert.notStrictEqual(buildAddressKey(a), buildAddressKey(b));
  });

  test("incomplete address yields no key (never matches everything)", () => {
    assert.strictEqual(buildAddressKey({ line1: "", city: "Babylon", zip: "11702" }), "");
    assert.strictEqual(buildAddressKey({ line1: "123 Main St", city: "Babylon", zip: "" }), "");
  });

  test("findDuplicateAddress locates an equivalent existing record", () => {
    const user = {
      addresses: [
        { _id: "a1", line1: "123 Main Street", city: "Babylon", state: "NY", zip: "11702" },
      ],
    };
    const found = findDuplicateAddress(user, {
      line1: "123 main st",
      city: "Babylon",
      state: "NY",
      zip: "11702",
    });
    assert.ok(found, "should find duplicate");
    assert.strictEqual(found._id, "a1");
  });

  test("findDuplicateAddress does not merge separate units", () => {
    const user = {
      addresses: [
        { _id: "a1", line1: "123 Main St Apt 1", city: "Babylon", state: "NY", zip: "11702" },
      ],
    };
    const found = findDuplicateAddress(user, {
      line1: "123 Main St Apt 2",
      city: "Babylon",
      state: "NY",
      zip: "11702",
    });
    assert.strictEqual(found, null);
  });

  test("findDuplicateAddress returns null on incomplete input", () => {
    const user = {
      addresses: [{ _id: "a1", line1: "123 Main St", city: "Babylon", state: "NY", zip: "11702" }],
    };
    assert.strictEqual(findDuplicateAddress(user, { line1: "", city: "", zip: "" }), null);
  });

  /* ---------------- summary ---------------- */

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.error(`FAILED: ${f.name}\n${f.err.stack}\n`);
    process.exit(1);
  }
  process.exit(0);
})();
