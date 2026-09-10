/**
 * Gift memberships against a real database.
 *
 * test_gift_membership proves the rules. This proves the behaviour that only
 * exists once records interact: webhook idempotency, claiming, stacking behind
 * paid coverage, refund synchronisation, and the guarantee that no gift code
 * path ever writes a Subscription.
 *
 *   node scripts/test_gift_membership_integration.js
 *
 * Not in `npm test`: it boots a MongoDB binary.
 */

process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";
delete process.env.GIFTS_ENABLED;

const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const GiftMembership = require("../models/GiftMembership");
const Subscription = require("../models/Subscription");
const User = require("../models/User");
const giftService = require("../utils/gifts/giftService");
const giftAccess = require("../utils/gifts/giftAccess");
const giftToken = require("../utils/gifts/giftClaimToken");
const giftWebhook = require("../utils/gifts/giftWebhook");
const { termWindow } = require("../utils/gifts/giftPricing");

const DAY = 24 * 60 * 60 * 1000;

let passed = 0;
const failures = [];
let mongod;

async function test(name, fn) {
  await Promise.all([
    GiftMembership.deleteMany({}),
    Subscription.deleteMany({}),
    User.deleteMany({}),
  ]);
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

let seq = 0;
async function makeUser(overrides = {}) {
  seq += 1;
  return User.create({
    userId: `u${String(seq).padStart(7, "0")}`,
    name: overrides.name || "Jane Doe",
    email: overrides.email || `person${seq}@example.com`,
    phone: "6315991363",
    role: "customer",
    addresses: [{ line1: "1 Main St", city: "Lindenhurst", state: "NY", zip: "11757" }],
    ...overrides,
  });
}

/** A Stripe checkout session as the webhook would receive it. */
function sessionFor(purchaser, overrides = {}) {
  const id = overrides.id || `cs_test_${Math.random().toString(16).slice(2)}`;
  return {
    id,
    mode: "payment",
    payment_status: "paid",
    payment_intent: overrides.paymentIntent || `pi_${id}`,
    amount_subtotal: 49800,
    amount_total: overrides.amountTotal ?? 49800,
    currency: "usd",
    total_details: {
      amount_discount: overrides.discount || 0,
      amount_tax: overrides.tax || 0,
    },
    automatic_tax: { enabled: true, status: overrides.taxStatus || "complete" },
    discounts: overrides.discounts || [],
    metadata: {
      productKind: "gift_membership",
      plan: overrides.plan || "plus",
      durationMonths: String(overrides.durationMonths || 2),
      purchaserMongoId: String(purchaser._id),
      purchaserUserId: purchaser.userId,
      recipientEmail: overrides.recipientEmail || "jane@example.com",
      recipientFirstName: "Jane",
      recipientLastName: "Doe",
      addressLine1: "1 Main St",
      addressCity: "Lindenhurst",
      addressState: "NY",
      addressZip: "11757",
      ...overrides.metadata,
    },
  };
}

/* ========================================================================== */

async function run() {
  console.log("\nPurchase and webhook");

  await test("a confirmed payment creates exactly one gift", async () => {
    const purchaser = await makeUser({ email: "sarah@example.com", name: "Sarah Chen" });
    const result = await giftWebhook.handleGiftCheckoutCompleted(sessionFor(purchaser));

    assert.equal(result.created, true);
    assert.equal(await GiftMembership.countDocuments({}), 1);

    const gift = await GiftMembership.findOne({});
    assert.equal(gift.plan, "plus");
    assert.equal(gift.durationMonths, 2);
    assert.equal(gift.amountPaidCents, 49800);
    assert.equal(gift.status, "invited", "an invitation is issued immediately");
    assert.ok(gift.claimTokenHash, "a claim token exists");
    assert.equal(gift.recipientEmail, "jane@example.com");
  });

  await test("A REPLAYED WEBHOOK DOES NOT CREATE A SECOND GIFT", async () => {
    const purchaser = await makeUser();
    const session = sessionFor(purchaser);

    const first = await giftWebhook.handleGiftCheckoutCompleted(session);
    const second = await giftWebhook.handleGiftCheckoutCompleted(session);
    const third = await giftWebhook.handleGiftCheckoutCompleted(session);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.duplicate, true);
    assert.equal(third.created, false);
    assert.equal(await GiftMembership.countDocuments({}), 1);
  });

  await test("concurrent webhook deliveries still produce one gift", async () => {
    const purchaser = await makeUser();
    const session = sessionFor(purchaser);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => giftWebhook.handleGiftCheckoutCompleted(session))
    );

    assert.equal(await GiftMembership.countDocuments({}), 1);
    assert.equal(results.filter((r) => r.created).length, 1, "exactly one creation wins");
  });

  await test("AN UNPAID SESSION CREATES NO GIFT", async () => {
    const purchaser = await makeUser();
    const session = sessionFor(purchaser);
    session.payment_status = "unpaid";

    const result = await giftWebhook.handleGiftCheckoutCompleted(session);
    assert.equal(result.created, false);
    assert.equal(result.reason, "not_paid");
    assert.equal(await GiftMembership.countDocuments({}), 0);
  });

  await test("a coupon is recorded from Stripe, not from us", async () => {
    const purchaser = await makeUser();
    const session = sessionFor(purchaser, {
      discount: 5000,
      amountTotal: 44800,
      discounts: [{ promotion_code: "promo_abc", coupon: "coupon_xyz" }],
    });

    await giftWebhook.handleGiftCheckoutCompleted(session);
    const gift = await GiftMembership.findOne({});

    assert.equal(gift.amountSubtotalCents, 49800);
    assert.equal(gift.discountCents, 5000);
    assert.equal(gift.amountPaidCents, 44800, "what Stripe actually took");
    assert.equal(gift.promotionCodeId, "promo_abc");
    assert.equal(gift.couponId, "coupon_xyz");
  });

  console.log("\nClaiming");

  /**
   * A purchased, invited gift plus a live token for it.
   *
   * Each call makes its OWN purchaser. Several tests buy two gifts for the
   * same recipient to exercise stacking, and reusing one email would collide
   * on the {email, role} unique index on User — which is correct behaviour for
   * that index and simply the wrong fixture.
   */
  async function purchasedGift(recipientEmail = "jane@example.com", overrides = {}) {
    const purchaser = await makeUser({ name: "Sarah Chen" });
    const session = sessionFor(purchaser, { recipientEmail, ...overrides });
    const result = await giftWebhook.handleGiftCheckoutCompleted(session);
    return { purchaser, gift: result.gift, token: result.invitation.token };
  }

  await test("the intended recipient can claim, and the window is set immediately", async () => {
    const { gift, token } = await purchasedGift("jane@example.com");
    const jane = await makeUser({ email: "jane@example.com" });

    const claim = await giftService.claimGift({
      gift: await GiftMembership.findById(gift._id),
      user: jane,
      addressId: jane.addresses[0]._id,
    });

    assert.equal(claim.ok, true);
    assert.equal(claim.queued, false);

    const stored = await GiftMembership.findById(gift._id).lean();
    assert.equal(stored.status, "claimed");
    assert.equal(String(stored.recipient), String(jane._id));
    assert.ok(stored.startAt && stored.endAt, "the window is persisted at claim");
    // And it is immediately usable, with no worker having run.
    assert.equal(giftAccess.giftAccessState(stored).active, true);
  });

  await test("A DIFFERENT ACCOUNT CANNOT CLAIM SOMEBODY ELSE'S GIFT", async () => {
    const { gift } = await purchasedGift("jane@example.com");
    const someoneElse = await makeUser({ email: "intruder@example.com" });

    const claim = await giftService.claimGift({
      gift: await GiftMembership.findById(gift._id),
      user: someoneElse,
      addressId: someoneElse.addresses[0]._id,
    });

    assert.equal(claim.ok, false);
    assert.equal(claim.reason, "recipient_mismatch");

    const stored = await GiftMembership.findById(gift._id).lean();
    assert.equal(stored.status, "invited", "the gift is untouched");
    assert.equal(stored.recipient, null);
  });

  await test("a gift can only be claimed once, even by two tabs at the same time", async () => {
    const { gift } = await purchasedGift("jane@example.com");
    const jane = await makeUser({ email: "jane@example.com" });

    const results = await Promise.all(
      Array.from({ length: 5 }, async () =>
        giftService.claimGift({
          gift: await GiftMembership.findById(gift._id),
          user: jane,
          addressId: jane.addresses[0]._id,
        })
      )
    );

    assert.equal(results.filter((r) => r.ok).length, 1, "exactly one claim succeeds");
    assert.equal(results.filter((r) => r.reason === "already_claimed").length, 4);
  });

  await test("claiming consumes the link", async () => {
    const { gift, token } = await purchasedGift("jane@example.com");
    const jane = await makeUser({ email: "jane@example.com" });

    await giftService.claimGift({
      gift: await GiftMembership.findById(gift._id),
      user: jane,
      addressId: jane.addresses[0]._id,
    });

    const stored = await GiftMembership.findById(gift._id).lean();
    assert.equal(giftToken.verifyClaimToken(token, stored).ok, false, "the link stops working");
  });

  console.log("\nToken expiry and re-issue");

  await test("AN EXPIRED LINK LEAVES THE PAID GIFT COMPLETELY INTACT", async () => {
    const { gift } = await purchasedGift("jane@example.com");

    // Age the token out.
    await GiftMembership.updateOne(
      { _id: gift._id },
      { $set: { claimTokenExpiresAt: new Date(Date.now() - 1000) } }
    );

    const stored = await GiftMembership.findById(gift._id).lean();
    assert.equal(stored.status, "invited", "still invited");
    assert.equal(stored.amountPaidCents, 49800, "the money is still recorded");
    assert.equal(stored.plan, "plus");
    assert.equal(stored.durationMonths, 2);
    assert.notEqual(stored.status, "cancelled", "an expired link must not cancel the gift");
  });

  await test("Admin can issue a fresh invitation after expiry", async () => {
    const { gift } = await purchasedGift("jane@example.com");
    await GiftMembership.updateOne(
      { _id: gift._id },
      { $set: { claimTokenExpiresAt: new Date(Date.now() - 1000) } }
    );

    const reissued = await giftService.issueInvitation(
      await GiftMembership.findById(gift._id),
      { reissue: true }
    );

    const stored = await GiftMembership.findById(gift._id).lean();
    assert.equal(giftToken.verifyClaimToken(reissued.token, stored).ok, true, "the new link works");
    assert.ok(new Date(stored.claimTokenExpiresAt) > new Date(), "and it is not expired");
    assert.equal(stored.claimTokenReissuedCount, 1);
  });

  await test("THE OLD LINK STOPS WORKING AFTER A RE-ISSUE", async () => {
    const { gift, token: original } = await purchasedGift("jane@example.com");

    const reissued = await giftService.issueInvitation(
      await GiftMembership.findById(gift._id),
      { reissue: true }
    );
    const stored = await GiftMembership.findById(gift._id).lean();

    assert.equal(giftToken.verifyClaimToken(reissued.token, stored).ok, true);
    const old = giftToken.verifyClaimToken(original, stored);
    assert.equal(old.ok, false, "the superseded link must be dead");
    assert.equal(old.reason, "superseded");
  });

  await test("a re-issued gift can still be claimed normally", async () => {
    const { gift } = await purchasedGift("jane@example.com");
    await giftService.issueInvitation(await GiftMembership.findById(gift._id), { reissue: true });
    const jane = await makeUser({ email: "jane@example.com" });

    const claim = await giftService.claimGift({
      gift: await GiftMembership.findById(gift._id),
      user: jane,
      addressId: jane.addresses[0]._id,
    });
    assert.equal(claim.ok, true);
  });

  console.log("\nStacking and existing paid members");

  await test("AN EXISTING PAID MEMBERSHIP IS NEVER TOUCHED, AND THE GIFT QUEUES BEHIND IT", async () => {
    const { gift } = await purchasedGift("jane@example.com");
    const jane = await makeUser({ email: "jane@example.com" });
    const addressId = jane.addresses[0]._id;

    const periodEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const paid = await Subscription.create({
      user: jane._id,
      userId: jane.userId,
      subscriptionType: "premium",
      addressId,
      startDate: new Date(),
      latestPaymentDate: new Date(),
      nextPaymentDate: periodEnd,
      currentPeriodEnd: periodEnd,
      status: "active",
      stripeSubscriptionId: "sub_existing",
      stripeCustomerId: "cus_jane_own",
    });
    const before = paid.toObject();

    const claim = await giftService.claimGift({
      gift: await GiftMembership.findById(gift._id),
      user: jane,
      addressId,
    });

    assert.equal(claim.ok, true);
    assert.equal(claim.queued, true, "the gift waits its turn");

    const stored = await GiftMembership.findById(gift._id).lean();
    /*
     * It waits WITHOUT a date, and that is the point.
     *
     * This assertion used to be "startAt === currentPeriodEnd". That is the
     * next RENEWAL, not an ending: the moment the membership renewed the
     * gift went active alongside coverage Jane was still paying for, and a
     * two-month gift could expire having delivered nothing. A membership
     * that keeps renewing has no knowable end, so the gift holds no window
     * at all until one exists.
     */
    assert.equal(stored.startPending, true, "it waits without a date");
    assert.equal(stored.startAt, null, "no fabricated start");
    assert.equal(stored.endAt, null, "and therefore no clock running");
    assert.equal(giftAccess.giftAccessState(stored).state, "pending");
    assert.equal(giftAccess.giftAccessState(stored).active, false);

    // The paid subscription is byte-for-byte unchanged.
    const after = (await Subscription.findById(paid._id)).toObject();
    for (const field of [
      "status",
      "subscriptionType",
      "stripeSubscriptionId",
      "stripeCustomerId",
      "currentPeriodEnd",
      "cancelAtPeriodEnd",
    ]) {
      assert.deepEqual(after[field], before[field], `${field} must not change`);
    }
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), "not even touched");
  });

  await test("a second gift stacks after the first instead of overlapping", async () => {
    const jane = await makeUser({ email: "jane@example.com" });
    const addressId = jane.addresses[0]._id;

    const first = await purchasedGift("jane@example.com");
    await giftService.claimGift({
      gift: await GiftMembership.findById(first.gift._id),
      user: jane,
      addressId,
    });
    const firstStored = await GiftMembership.findById(first.gift._id).lean();

    const second = await purchasedGift("jane@example.com");
    const claim = await giftService.claimGift({
      gift: await GiftMembership.findById(second.gift._id),
      user: jane,
      addressId,
    });

    assert.equal(claim.queued, true);
    const secondStored = await GiftMembership.findById(second.gift._id).lean();
    assert.equal(
      new Date(secondStored.startAt).getTime(),
      new Date(firstStored.endAt).getTime(),
      "the second begins exactly where the first ends — no day wasted, none doubled"
    );
    // Four months of coverage from two 2-month gifts.
    assert.equal(
      new Date(secondStored.endAt).getTime(),
      termWindow(firstStored.endAt, 2).endAt.getTime()
    );
  });

  await test("gifts of DIFFERENT plans run sequentially, each keeping its own plan", async () => {
    const jane = await makeUser({ email: "jane@example.com" });
    const addressId = jane.addresses[0]._id;

    const plusGift = await purchasedGift("jane@example.com", { plan: "plus" });
    await giftService.claimGift({
      gift: await GiftMembership.findById(plusGift.gift._id),
      user: jane,
      addressId,
    });

    const basicGift = await purchasedGift("jane@example.com", { plan: "basic" });
    await giftService.claimGift({
      gift: await GiftMembership.findById(basicGift.gift._id),
      user: jane,
      addressId,
    });

    const timeline = await giftAccess.findGiftTimeline(jane._id, addressId);
    assert.equal(timeline.active.plan, "plus", "the running gift keeps its plan");
    assert.equal(timeline.queued.length, 1);
    assert.equal(timeline.queued[0].plan, "basic", "the queued gift keeps its own plan");
    // Never merged, averaged or upgraded to match.
    assert.notEqual(timeline.active.plan, timeline.queued[0].plan);
  });

  await test("the active gift is the one covering today, not simply the first", async () => {
    const jane = await makeUser({ email: "jane@example.com" });
    const addressId = jane.addresses[0]._id;

    const past = await purchasedGift("jane@example.com");
    await giftService.claimGift({
      gift: await GiftMembership.findById(past.gift._id),
      user: jane,
      addressId,
    });
    // Push the first one into the past.
    await GiftMembership.updateOne(
      { _id: past.gift._id },
      {
        $set: {
          startAt: new Date(Date.now() - 90 * 24 * 3600 * 1000),
          endAt: new Date(Date.now() - 30 * 24 * 3600 * 1000),
        },
      }
    );

    const current = await purchasedGift("jane@example.com");
    await giftService.claimGift({
      gift: await GiftMembership.findById(current.gift._id),
      user: jane,
      addressId,
    });

    const active = await giftAccess.findActiveGift(jane._id, addressId);
    assert.equal(String(active._id), String(current.gift._id));
  });

  console.log("\nAccess without the worker");

  await test("A GIFT WORKS EVEN THOUGH NO LIFECYCLE JOB HAS EVER RUN", async () => {
    const { gift } = await purchasedGift("jane@example.com");
    const jane = await makeUser({ email: "jane@example.com" });
    const addressId = jane.addresses[0]._id;

    await giftService.claimGift({
      gift: await GiftMembership.findById(gift._id),
      user: jane,
      addressId,
    });

    // Nothing has swept, nothing has been marked active by any job.
    const active = await giftAccess.findActiveGift(jane._id, addressId);
    assert.ok(active, "the gift must be usable purely from its dates");
    assert.equal(active.plan, "plus");
  });

  await test("A QUEUED GIFT BECOMES USABLE ON ITS OWN WHEN ITS START PASSES", async () => {
    /*
     * The reliability requirement. This gift was queued behind paid coverage;
     * that coverage has now ended and the start date has passed. No worker has
     * run. It must simply work.
     */
    const { gift } = await purchasedGift("jane@example.com");
    const jane = await makeUser({ email: "jane@example.com" });
    const addressId = jane.addresses[0]._id;

    await giftService.claimGift({
      gift: await GiftMembership.findById(gift._id),
      user: jane,
      addressId,
    });
    // Pretend it was queued to start an hour ago.
    await GiftMembership.updateOne(
      { _id: gift._id },
      {
        $set: {
          startAt: new Date(Date.now() - 3600 * 1000),
          endAt: new Date(Date.now() + 60 * 24 * 3600 * 1000),
        },
      }
    );

    const active = await giftAccess.findActiveGift(jane._id, addressId);
    assert.ok(active, "a due gift must be live without any sweep having run");
  });

  await test("an ended gift stops granting access without a worker either", async () => {
    const { gift } = await purchasedGift("jane@example.com");
    const jane = await makeUser({ email: "jane@example.com" });
    const addressId = jane.addresses[0]._id;

    await giftService.claimGift({
      gift: await GiftMembership.findById(gift._id),
      user: jane,
      addressId,
    });
    await GiftMembership.updateOne(
      { _id: gift._id },
      {
        $set: {
          startAt: new Date(Date.now() - 90 * 24 * 3600 * 1000),
          endAt: new Date(Date.now() - 1000),
        },
      }
    );

    assert.equal(await giftAccess.findActiveGift(jane._id, addressId), null);
  });

  await test("a gift is scoped to the property it was claimed against", async () => {
    const { gift } = await purchasedGift("jane@example.com");
    const jane = await makeUser({ email: "jane@example.com" });
    jane.addresses.push({ line1: "2 Other Rd", city: "Babylon", state: "NY", zip: "11702" });
    await jane.save();

    await giftService.claimGift({
      gift: await GiftMembership.findById(gift._id),
      user: jane,
      addressId: jane.addresses[0]._id,
    });

    assert.ok(await giftAccess.findActiveGift(jane._id, jane.addresses[0]._id));
    assert.equal(await giftAccess.findActiveGift(jane._id, jane.addresses[1]._id), null);
  });

  console.log("\nRefunds");

  await test("a PARTIAL refund is recorded and does NOT revoke the gift", async () => {
    const { gift } = await purchasedGift("jane@example.com");
    const jane = await makeUser({ email: "jane@example.com" });
    await giftService.claimGift({
      gift: await GiftMembership.findById(gift._id),
      user: jane,
      addressId: jane.addresses[0]._id,
    });

    await giftWebhook.handleGiftRefund({
      id: "ch_1",
      payment_intent: gift.stripePaymentIntentId,
      refunds: { data: [{ id: "re_1", amount: 10000, currency: "usd", reason: "requested_by_customer" }] },
    });

    const stored = await GiftMembership.findById(gift._id).lean();
    assert.equal(stored.refundStatus, "partial");
    assert.equal(stored.amountRefundedCents, 10000);
    assert.equal(stored.refunds.length, 1);
    assert.equal(stored.refunds[0].stripeRefundId, "re_1");
    // The entitlement is deliberately untouched.
    assert.equal(stored.status, "claimed");
    assert.equal(giftAccess.giftAccessState(stored).active, true, "still usable");
  });

  await test("a FULL refund is recorded and still does not revoke the gift", async () => {
    const { gift } = await purchasedGift("jane@example.com");
    const jane = await makeUser({ email: "jane@example.com" });
    await giftService.claimGift({
      gift: await GiftMembership.findById(gift._id),
      user: jane,
      addressId: jane.addresses[0]._id,
    });

    await giftWebhook.handleGiftRefund({
      id: "ch_2",
      payment_intent: gift.stripePaymentIntentId,
      refunds: { data: [{ id: "re_full", amount: 49800, currency: "usd" }] },
    });

    const stored = await GiftMembership.findById(gift._id).lean();
    assert.equal(stored.refundStatus, "full");
    assert.equal(stored.amountRefundedCents, 49800);
    assert.equal(stored.status, "claimed", "revocation is an Admin decision, not a webhook's");
    assert.equal(giftAccess.giftAccessState(stored).active, true);
  });

  await test("several partial refunds add up to full", async () => {
    const { gift } = await purchasedGift("jane@example.com");

    for (const [id, amount] of [["re_a", 20000], ["re_b", 20000], ["re_c", 9800]]) {
      await giftWebhook.handleGiftRefund({
        id: "ch_3",
        payment_intent: gift.stripePaymentIntentId,
        refunds: { data: [{ id, amount, currency: "usd" }] },
      });
    }

    const stored = await GiftMembership.findById(gift._id).lean();
    assert.equal(stored.amountRefundedCents, 49800);
    assert.equal(stored.refundStatus, "full");
    assert.equal(stored.refunds.length, 3);
  });

  await test("a re-delivered refund webhook is not counted twice", async () => {
    const { gift } = await purchasedGift("jane@example.com");
    const charge = {
      id: "ch_4",
      payment_intent: gift.stripePaymentIntentId,
      refunds: { data: [{ id: "re_dup", amount: 10000, currency: "usd" }] },
    };

    await giftWebhook.handleGiftRefund(charge);
    await giftWebhook.handleGiftRefund(charge);
    await giftWebhook.handleGiftRefund(charge);

    const stored = await GiftMembership.findById(gift._id).lean();
    assert.equal(stored.amountRefundedCents, 10000, "counted once");
    assert.equal(stored.refunds.length, 1);
    assert.equal(stored.refundStatus, "partial");
  });

  await test("a refund for an unrelated charge is ignored", async () => {
    await purchasedGift("jane@example.com");
    const result = await giftWebhook.handleGiftRefund({
      id: "ch_other",
      payment_intent: "pi_not_ours",
      refunds: { data: [{ id: "re_x", amount: 5000 }] },
    });
    assert.equal(result.handled, false);
    const stored = await GiftMembership.findOne({});
    assert.equal(stored.refundStatus, "none");
  });


  console.log("\nAutomatic tax");

  await test("the tax Stripe charged is stored, and the total stays tax-inclusive", async () => {
    const buyer = await makeUser({ email: `tax-${Date.now()}@example.com` });
    // $498.00 of gift, $43.58 of New York sales tax on top.
    const session = sessionFor(buyer, { tax: 4358, amountTotal: 54158 });

    const result = await giftWebhook.handleGiftCheckoutCompleted(session);
    assert.equal(result.created, true);

    const stored = await GiftMembership.findById(result.gift._id);
    assert.equal(stored.amountSubtotalCents, 49800, "subtotal is the pre-tax amount we quoted");
    assert.equal(stored.taxCents, 4358, "tax must be Stripe's figure, not one we computed");
    assert.equal(stored.amountPaidCents, 54158, "the paid total includes tax");
    assert.equal(stored.automaticTaxStatus, "complete");
    assert.equal(
      stored.amountSubtotalCents + stored.taxCents - stored.discountCents,
      stored.amountPaidCents,
      "the stored figures must reconcile"
    );
  });

  await test("tax does not shorten or move the entitlement", async () => {
    const untaxed = await makeUser({ email: `noTax-${Date.now()}@example.com` });
    const taxed = await makeUser({ email: `withTax-${Date.now()}@example.com` });

    const stamp = Date.now();
    const a = await giftWebhook.handleGiftCheckoutCompleted(
      sessionFor(untaxed, { tax: 0, recipientEmail: `plainRecipient-${stamp}@example.com` })
    );
    const b = await giftWebhook.handleGiftCheckoutCompleted(
      sessionFor(taxed, {
        tax: 4358,
        amountTotal: 54158,
        recipientEmail: `taxedRecipient-${stamp}@example.com`,
      })
    );

    assert.equal(a.gift.durationMonths, b.gift.durationMonths, "same term, tax or no tax");

    const claimant = await makeUser({ email: a.gift.recipientEmail });
    const claimantB = await makeUser({ email: b.gift.recipientEmail });
    const at = new Date("2026-04-01T12:00:00Z");

    const claimedA = await giftService.claimGift({
      gift: await GiftMembership.findById(a.gift._id),
      user: claimant,
      addressId: claimant.addresses[0]._id,
      now: at,
    });
    const claimedB = await giftService.claimGift({
      gift: await GiftMembership.findById(b.gift._id),
      user: claimantB,
      addressId: claimantB.addresses[0]._id,
      now: at,
    });

    assert.equal(
      claimedA.gift.startAt.toISOString(),
      claimedB.gift.startAt.toISOString(),
      "tax must not move startAt"
    );
    assert.equal(
      claimedA.gift.endAt.toISOString(),
      claimedB.gift.endAt.toISOString(),
      "tax must not move endAt"
    );
  });

  await test("a full refund is measured against the tax-inclusive total", async () => {
    const buyer = await makeUser({ email: `taxRefund-${Date.now()}@example.com` });
    const created = await giftWebhook.handleGiftCheckoutCompleted(
      sessionFor(buyer, { tax: 4358, amountTotal: 54158 })
    );

    // Refunding only the pre-tax amount is a PARTIAL refund, because the
    // customer paid the tax too.
    await giftService.syncRefund({
      gift: await GiftMembership.findById(created.gift._id),
      refund: { id: `re_${Date.now()}_a`, amount: 49800, currency: "usd" },
    });
    let stored = await GiftMembership.findById(created.gift._id);
    assert.equal(stored.refundStatus, "partial", "the tax has not come back yet");

    await giftService.syncRefund({
      gift: stored,
      refund: { id: `re_${Date.now()}_b`, amount: 4358, currency: "usd" },
    });
    stored = await GiftMembership.findById(created.gift._id);
    assert.equal(stored.refundStatus, "full");
    assert.equal(stored.amountRefundedCents, 54158);
  });

  console.log("\nQueuing behind a paid membership");

  /*
   * The rule: a gift must never consume a day while a paid membership is
   * still providing coverage. currentPeriodEnd is the next RENEWAL, not an
   * ending, so a renewing membership leaves the gift PENDING — no dates, no
   * access, no clock — until that membership genuinely stops.
   */
  async function paidFor(user, overrides = {}) {
    return Subscription.create({
      user: user._id,
      userId: user.userId,
      subscriptionType: "premium",
      addressId: user.addresses[0]._id,
      startDate: new Date(Date.now() - 30 * DAY),
      latestPaymentDate: new Date(Date.now() - 30 * DAY),
      nextPaymentDate: new Date(Date.now() + 30 * DAY),
      currentPeriodEnd: new Date(Date.now() + 30 * DAY),
      status: "active",
      stripeSubscriptionId: `sub_${Math.random().toString(16).slice(2)}`,
      stripeCustomerId: "cus_recipient_own",
      ...overrides,
    });
  }

  async function claimedBehindPaid(email, subOverrides = {}) {
    const { gift } = await purchasedGift(email);
    const user = await makeUser({ email });
    const sub = await paidFor(user, subOverrides);
    const claim = await giftService.claimGift({
      gift: await GiftMembership.findById(gift._id),
      user,
      addressId: user.addresses[0]._id,
    });
    return { user, sub, gift: await GiftMembership.findById(gift._id).lean(), claim };
  }

  await test("a renewing paid membership leaves the gift pending, with no dates", async () => {
    const { gift } = await claimedBehindPaid("renew1@example.com");
    assert.equal(gift.startPending, true);
    assert.equal(gift.startAt, null, "no fabricated start date");
    assert.equal(gift.endAt, null);
    assert.equal(giftAccess.giftAccessState(gift).state, "pending");
    assert.equal(giftAccess.giftAccessState(gift).active, false);
  });

  await test("the paid membership renewing once consumes no gift time", async () => {
    const { user, sub, gift } = await claimedBehindPaid("renew2@example.com");
    // Stripe renews: the period rolls forward.
    await Subscription.updateOne(
      { _id: sub._id },
      { $set: { currentPeriodEnd: new Date(Date.now() + 60 * DAY) } }
    );
    const at = new Date(Date.now() + 31 * DAY);
    await giftAccess.activateDueGifts(user._id, user.addresses[0]._id, { now: at });
    const after = await GiftMembership.findById(gift._id).lean();
    assert.equal(after.startPending, true, "still waiting");
    assert.equal(after.startAt, null, "and still no clock running");
    assert.equal(giftAccess.giftAccessState(after, at).active, false);
  });

  await test("renewing many times still consumes no gift time", async () => {
    const { user, sub, gift } = await claimedBehindPaid("renew3@example.com");
    for (const months of [1, 2, 3, 4, 5, 6]) {
      await Subscription.updateOne(
        { _id: sub._id },
        { $set: { currentPeriodEnd: new Date(Date.now() + months * 30 * DAY) } }
      );
      const at = new Date(Date.now() + months * 30 * DAY + DAY);
      await giftAccess.activateDueGifts(user._id, user.addresses[0]._id, { now: at });
      const cur = await GiftMembership.findById(gift._id).lean();
      assert.equal(cur.startAt, null, `still pending after ${months} renewals`);
    }
    const final = await GiftMembership.findById(gift._id).lean();
    assert.equal(giftAccess.giftAccessState(final, new Date(Date.now() + 200 * DAY)).state, "pending");
  });

  await test("cancelAtPeriodEnd is a genuine ending, so the gift is scheduled", async () => {
    const periodEnd = new Date(Date.now() + 20 * DAY);
    const { gift } = await claimedBehindPaid("cancelend@example.com", {
      cancelAtPeriodEnd: true,
      currentPeriodEnd: periodEnd,
      nextPaymentDate: periodEnd,
    });
    assert.equal(gift.startPending, false, "a known ending gets a real date");
    assert.equal(
      new Date(gift.startAt).getTime(),
      periodEnd.getTime(),
      "it starts exactly when the paid coverage genuinely ends"
    );
    assert.equal(giftAccess.giftAccessState(gift).state, "queued");
  });

  await test("when the paid membership genuinely ends, the gift starts", async () => {
    const { user, sub, gift } = await claimedBehindPaid("ended@example.com");
    await Subscription.updateOne({ _id: sub._id }, { $set: { status: "canceled" } });
    const at = new Date(Date.now() + DAY);
    const activated = await giftAccess.activateDueGifts(user._id, user.addresses[0]._id, { now: at });
    assert(activated, "the gift should have been activated");
    const after = await GiftMembership.findById(gift._id).lean();
    assert.equal(after.startPending, false);
    assert.equal(new Date(after.startAt).getTime(), at.getTime(), "it starts the moment cover ends");
    assert.equal(giftAccess.giftAccessState(after, at).active, true);
    assert.equal(after.durationMonths, 2, "and still runs its full purchased term");
  });

  await test("ending early starts the gift early, not at the old period end", async () => {
    const { user, sub, gift } = await claimedBehindPaid("early@example.com", {
      currentPeriodEnd: new Date(Date.now() + 200 * DAY),
    });
    await Subscription.updateOne({ _id: sub._id }, { $set: { status: "canceled" } });
    const at = new Date(Date.now() + 2 * DAY);
    await giftAccess.activateDueGifts(user._id, user.addresses[0]._id, { now: at });
    const after = await GiftMembership.findById(gift._id).lean();
    assert.equal(new Date(after.startAt).getTime(), at.getTime());
  });

  await test("ZERO gift days are consumed while paid coverage runs", async () => {
    const { user, sub, gift } = await claimedBehindPaid("zero@example.com");
    // Three months of renewals, then the membership stops.
    for (const m of [1, 2, 3]) {
      await Subscription.updateOne(
        { _id: sub._id },
        { $set: { currentPeriodEnd: new Date(Date.now() + m * 30 * DAY) } }
      );
      await giftAccess.activateDueGifts(user._id, user.addresses[0]._id, {
        now: new Date(Date.now() + m * 30 * DAY),
      });
    }
    await Subscription.updateOne({ _id: sub._id }, { $set: { status: "canceled" } });
    const at = new Date(Date.now() + 95 * DAY);
    await giftAccess.activateDueGifts(user._id, user.addresses[0]._id, { now: at });

    const after = await GiftMembership.findById(gift._id).lean();
    const months =
      (new Date(after.endAt).getFullYear() - new Date(after.startAt).getFullYear()) * 12 +
      (new Date(after.endAt).getMonth() - new Date(after.startAt).getMonth());
    assert.equal(months, 2, "the full two months are still ahead of them");
    assert.equal(new Date(after.startAt).getTime(), at.getTime());
  });

  await test("several gifts behind a paid membership run one after another", async () => {
    const email = "stack-pending@example.com";
    const first = await purchasedGift(email);
    const second = await purchasedGift(email);
    const user = await makeUser({ email });
    const addressId = user.addresses[0]._id;
    const sub = await paidFor(user);

    for (const p of [first, second]) {
      const c = await giftService.claimGift({
        gift: await GiftMembership.findById(p.gift._id),
        user,
        addressId,
      });
      assert.equal(c.ok, true);
    }

    let a = await GiftMembership.findById(first.gift._id).lean();
    let b = await GiftMembership.findById(second.gift._id).lean();
    assert.equal(a.startPending, true, "both wait while the membership renews");
    assert.equal(b.startPending, true);

    // The membership stops. Only the FIRST gift starts.
    await Subscription.updateOne({ _id: sub._id }, { $set: { status: "canceled" } });
    const at = new Date(Date.now() + DAY);
    await giftAccess.activateDueGifts(user._id, addressId, { now: at });

    a = await GiftMembership.findById(first.gift._id).lean();
    b = await GiftMembership.findById(second.gift._id).lean();
    assert.equal(a.startPending, false, "the first gift starts");
    assert.equal(b.startPending, true, "the second keeps waiting - never concurrent");
    assert.equal(giftAccess.giftAccessState(a, at).active, true);
    assert.equal(giftAccess.giftAccessState(b, at).active, false);

    // When the first runs out, the second takes over.
    const later = new Date(new Date(a.endAt).getTime() + 60 * 1000);
    await giftAccess.activateDueGifts(user._id, addressId, { now: later });
    b = await GiftMembership.findById(second.gift._id).lean();
    assert.equal(b.startPending, false, "the second gift starts when the first ends");
    assert.equal(giftAccess.giftAccessState(b, later).active, true);
    assert.equal(
      new Date(b.startAt).getTime() >= new Date(a.endAt).getTime(),
      true,
      "and never overlaps it"
    );
  });

  await test("booking activates a due gift without any worker having run", async () => {
    const { user, sub, gift } = await claimedBehindPaid("noworker@example.com");
    await Subscription.updateOne({ _id: sub._id }, { $set: { status: "canceled" } });
    const at = new Date(Date.now() + DAY);
    // findActiveGift is what the booking path calls. No sweep in between.
    const found = await giftAccess.findActiveGift(user._id, user.addresses[0]._id, { now: at });
    assert(found, "the gift is usable on the first request after cover ends");
    assert.equal(String(found._id), String(gift._id));
  });

  console.log("\nContinuation must not bill over gift coverage");

  await test("projected coverage includes a pending gift's unscheduled months", async () => {
    const { user, sub } = await claimedBehindPaid("project@example.com");
    // While the membership renews, the gift has no dates at all - but its
    // months are still owed and must delay any billing.
    const projected = await giftAccess.projectedGiftCoverageEnd(
      user._id,
      user.addresses[0]._id,
      { now: new Date() }
    );
    assert(projected, "a pending gift still counts as coverage");
    const monthsOut =
      (projected.getFullYear() - new Date().getFullYear()) * 12 +
      (projected.getMonth() - new Date().getMonth());
    assert(monthsOut >= 1, `expected roughly two months of cover, got ${monthsOut}`);
    await Subscription.deleteOne({ _id: sub._id });
  });

  await test("projected coverage runs to the LAST gift, not the active one", async () => {
    const email = "projectlast@example.com";
    const first = await purchasedGift(email);
    const second = await purchasedGift(email);
    const user = await makeUser({ email });
    const addressId = user.addresses[0]._id;

    for (const p of [first, second]) {
      const c = await giftService.claimGift({
        gift: await GiftMembership.findById(p.gift._id),
        user,
        addressId,
      });
      assert.equal(c.ok, true, `claim failed: ${c.reason}`);
    }
    const a = await GiftMembership.findById(first.gift._id).lean();
    const b = await GiftMembership.findById(second.gift._id).lean();
    assert(a.endAt, "first gift must have an end date");
    assert(b.endAt, "second gift must have an end date");

    const projected = await giftAccess.projectedGiftCoverageEnd(user._id, addressId, {
      now: new Date(),
    });
    assert(projected, "two dated gifts must project coverage");
    assert.equal(
      projected.getTime(),
      new Date(b.endAt).getTime(),
      "billing must wait for the second gift, not the first"
    );
    assert(
      projected.getTime() > new Date(a.endAt).getTime(),
      "and that is later than the active one"
    );
  });

  await test("no gift coverage means no deferral at all", async () => {
    const user = await makeUser({ email: "nogift@example.com" });
    const projected = await giftAccess.projectedGiftCoverageEnd(
      user._id,
      user.addresses[0]._id,
      { now: new Date() }
    );
    assert.equal(projected, null, "an ordinary customer is billed immediately as before");
  });

  await test("expired gifts do not defer billing", async () => {
    const email = "expiredgift@example.com";
    const { gift } = await purchasedGift(email);
    const user = await makeUser({ email });
    const addressId = user.addresses[0]._id;
    await giftService.claimGift({
      gift: await GiftMembership.findById(gift._id),
      user,
      addressId,
    });
    const long = new Date(Date.now() + 400 * DAY);
    const projected = await giftAccess.projectedGiftCoverageEnd(user._id, addressId, { now: long });
    assert.equal(projected, null, "coverage that has run out defers nothing");
  });

  console.log("\nContinuation through the REAL subscription checkout route");

  /*
   * These drive routes/stripe.js itself rather than the helper it calls.
   *
   * The deferral has to be a SERVER decision: the recipient can reach
   * /membership directly, or forge the request entirely, so a UI that knows
   * about gifts protects nobody. Stripe's session create is intercepted, so
   * nothing leaves the process and the exact config is asserted.
   */
  const subsModule = require("../utils/subscriptionManagement");
  const originalCreate = subsModule.stripe.checkout.sessions.create;

  async function checkoutFor(user, addressId, plan = "plus") {
    let captured = null;
    subsModule.stripe.checkout.sessions.create = async (config) => {
      captured = config;
      return { id: "cs_test_captured", url: "https://checkout.stripe.com/c/pay/cs_test" };
    };

    const express = require("express");
    const http = require("http");
    const authPath = require.resolve("../middleware/auth");
    const routerPath = require.resolve("../routes/stripe");
    const realAuth = require.cache[authPath];
    require.cache[authPath] = {
      id: authPath,
      filename: authPath,
      loaded: true,
      exports: (req, _res, next) => {
        req.user = { id: String(user._id) };
        next();
      },
    };
    delete require.cache[routerPath];
    const router = require("../routes/stripe");
    delete require.cache[routerPath];
    if (realAuth) require.cache[authPath] = realAuth;
    else delete require.cache[authPath];

    const app = express();
    app.use(express.json());
    app.use("/api/stripe/checkout", router);

    const response = await new Promise((resolve) => {
      const server = app.listen(0, () => {
        const body = JSON.stringify({ plan, addressId: String(addressId), billingCycle: "monthly" });
        const req = http.request(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path: "/api/stripe/checkout/create-checkout-session",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => {
              server.close();
              let parsed = {};
              try {
                parsed = JSON.parse(raw);
              } catch {
                parsed = { raw };
              }
              resolve({ status: res.statusCode, body: parsed });
            });
          }
        );
        req.write(body);
        req.end();
      });
    });

    subsModule.stripe.checkout.sessions.create = originalCreate;
    return { response, captured };
  }

  /** A recipient with their own Stripe customer, so no customer lookup runs. */
  async function recipientWithCustomer(email) {
    return makeUser({ email, stripeCustomerId: "cus_recipient_own" });
  }

  async function claimFor(user, email) {
    const { gift } = await purchasedGift(email);
    const claim = await giftService.claimGift({
      gift: await GiftMembership.findById(gift._id),
      user,
      addressId: user.addresses[0]._id,
    });
    assert.equal(claim.ok, true, `claim failed: ${claim.reason}`);
    return GiftMembership.findById(gift._id).lean();
  }

  await test("no gift means no deferral: an ordinary customer bills immediately", async () => {
    const user = await recipientWithCustomer("plainbuyer@example.com");
    const { response, captured } = await checkoutFor(user, user.addresses[0]._id);
    assert.equal(response.status, 200);
    assert.equal(captured.mode, "subscription");
    assert.equal(
      captured.subscription_data.trial_end,
      undefined,
      "nothing should be deferred for somebody with no gift"
    );
    assert.equal(response.body.billingStartsAt, null);
  });

  await test("an ACTIVE gift defers billing to the day it ends", async () => {
    const email = "activegift@example.com";
    const user = await recipientWithCustomer(email);
    const gift = await claimFor(user, email);
    const { response, captured } = await checkoutFor(user, user.addresses[0]._id);
    assert.equal(response.status, 200);
    const trialEnd = captured.subscription_data.trial_end;
    assert(trialEnd, "billing must be deferred");
    assert.equal(
      trialEnd,
      Math.floor(new Date(gift.endAt).getTime() / 1000),
      "and deferred to exactly when the gift runs out"
    );
    assert(response.body.billingStartsAt, "the customer must be told the date");
  });

  await test("a DIRECT visit is deferred identically - the server decides, not the UI", async () => {
    // Same request the CTA makes; nothing in it says where the click came
    // from, which is the point: there is no UI-only path to bypass.
    const email = "directvisit@example.com";
    const user = await recipientWithCustomer(email);
    const gift = await claimFor(user, email);
    const { captured } = await checkoutFor(user, user.addresses[0]._id);
    assert.equal(
      captured.subscription_data.trial_end,
      Math.floor(new Date(gift.endAt).getTime() / 1000)
    );
  });

  await test("MULTIPLE queued gifts push billing to the LAST one", async () => {
    const email = "twogifts@example.com";
    const user = await recipientWithCustomer(email);
    const first = await claimFor(user, email);
    const second = await claimFor(user, email);
    assert(
      new Date(second.endAt).getTime() > new Date(first.endAt).getTime(),
      "the second gift must queue behind the first"
    );
    const { captured } = await checkoutFor(user, user.addresses[0]._id);
    assert.equal(
      captured.subscription_data.trial_end,
      Math.floor(new Date(second.endAt).getTime() / 1000),
      "billing waits for the last gift, not the active one"
    );
  });

  await test("an EXPIRED gift defers nothing", async () => {
    const email = "expiredonly@example.com";
    const user = await recipientWithCustomer(email);
    const gift = await claimFor(user, email);
    // Push it entirely into the past.
    await GiftMembership.updateOne(
      { _id: gift._id },
      {
        $set: {
          startAt: new Date(Date.now() - 200 * DAY),
          endAt: new Date(Date.now() - 100 * DAY),
        },
      }
    );
    const { captured } = await checkoutFor(user, user.addresses[0]._id);
    assert.equal(captured.subscription_data.trial_end, undefined);
  });

  await test("a gift on address A must not defer billing for address B", async () => {
    const email = "twoaddresses@example.com";
    const user = await makeUser({
      email,
      stripeCustomerId: "cus_recipient_own",
      addresses: [
        { line1: "1 Main St", city: "Lindenhurst", state: "NY", zip: "11757" },
        { line1: "2 Ocean Rd", city: "Babylon", state: "NY", zip: "11702" },
      ],
    });
    const addressA = user.addresses[0]._id;
    const addressB = user.addresses[1]._id;

    const { gift } = await purchasedGift(email);
    const claim = await giftService.claimGift({
      gift: await GiftMembership.findById(gift._id),
      user,
      addressId: addressA,
    });
    assert.equal(claim.ok, true);

    const onA = await checkoutFor(user, addressA);
    assert(onA.captured.subscription_data.trial_end, "address A is covered, so it defers");

    const onB = await checkoutFor(user, addressB);
    assert.equal(
      onB.captured.subscription_data.trial_end,
      undefined,
      "address B has no gift and must bill immediately"
    );
  });

  await test("a PENDING gift behind paid coverage still defers billing", async () => {
    const email = "pendingdefer@example.com";
    const user = await recipientWithCustomer(email);
    const addressId = user.addresses[0]._id;
    const sub = await Subscription.create({
      user: user._id,
      userId: user.userId,
      subscriptionType: "premium",
      addressId,
      startDate: new Date(),
      latestPaymentDate: new Date(),
      nextPaymentDate: new Date(Date.now() + 30 * DAY),
      currentPeriodEnd: new Date(Date.now() + 30 * DAY),
      status: "active",
      stripeSubscriptionId: "sub_paid",
      stripeCustomerId: "cus_recipient_own",
    });
    const gift = await claimFor(user, email);
    assert.equal(gift.startPending, true, "it waits behind the renewing membership");

    // The duplicate-subscription guard must still fire FIRST for this address.
    const { response } = await checkoutFor(user, addressId);
    assert.equal(response.status, 409, "an existing paid membership still blocks a second one");
    assert.equal(response.body.code, "ADDRESS_ALREADY_SUBSCRIBED");

    // Once that membership ends, the pending months still defer billing.
    await Subscription.deleteOne({ _id: sub._id });
    const after = await checkoutFor(user, addressId);
    assert.equal(after.response.status, 200);
    assert(
      after.captured.subscription_data.trial_end,
      "the pending gift's unscheduled months must still delay the first charge"
    );
  });

  await test("the deferred subscription still uses the RECIPIENT's own customer", async () => {
    const email = "ownbilling@example.com";
    const user = await recipientWithCustomer(email);
    await claimFor(user, email);
    const { captured } = await checkoutFor(user, user.addresses[0]._id);
    assert.equal(captured.customer, "cus_recipient_own");
    const serialized = JSON.stringify(captured);
    assert(!serialized.includes("cus_purchaser"), "no purchaser customer may appear");
    assert(!/purchaser/i.test(serialized), "nothing about a purchaser may reach Stripe here");
  });

  console.log("\nDiscounted and free gifts");

  await test("a 100% discounted gift is created, not silently dropped", async () => {
    /*
     * Stripe completes a zero-total session with payment_status
     * "no_payment_required" and NO payment intent. Accepting only "paid"
     * meant the purchaser finished checkout and no gift ever existed.
     */
    const buyer = await makeUser({ email: `freegift-${Date.now()}@example.com` });
    const session = sessionFor(buyer, {
      recipientEmail: `freerecipient-${Date.now()}@example.com`,
      discount: 49800,
      amountTotal: 0,
    });
    session.payment_status = "no_payment_required";
    session.payment_intent = null;

    const result = await giftWebhook.handleGiftCheckoutCompleted(session);
    assert.equal(result.created, true, "a fully discounted gift is still a gift");

    const stored = await GiftMembership.findById(result.gift._id).lean();
    assert.equal(stored.amountSubtotalCents, 49800);
    assert.equal(stored.discountCents, 49800);
    assert.equal(stored.amountPaidCents, 0, "nothing was charged");
    assert.equal(stored.stripePaymentIntentId, null, "and there is no payment intent");
    assert.equal(stored.plan, "plus", "the full entitlement is still granted");
    assert.equal(stored.durationMonths, 2);
  });

  await test("two free gifts do not collide on the null payment intent", async () => {
    // The unique index is partial on a string, so many nulls coexist.
    const created = [];
    for (let i = 0; i < 2; i += 1) {
      const buyer = await makeUser({ email: `free${i}-${Date.now()}@example.com` });
      const session = sessionFor(buyer, {
        recipientEmail: `freer${i}-${Date.now()}@example.com`,
        discount: 49800,
        amountTotal: 0,
      });
      session.payment_status = "no_payment_required";
      session.payment_intent = null;
      const r = await giftWebhook.handleGiftCheckoutCompleted(session);
      assert.equal(r.created, true, `gift ${i} should be created`);
      created.push(String(r.gift._id));
    }
    assert.equal(new Set(created).size, 2, "two distinct gifts");
  });

  await test("a genuinely unpaid session is still refused", async () => {
    const buyer = await makeUser({ email: `unpaid-${Date.now()}@example.com` });
    const session = sessionFor(buyer, { recipientEmail: `unpaidr-${Date.now()}@example.com` });
    session.payment_status = "unpaid";
    const result = await giftWebhook.handleGiftCheckoutCompleted(session);
    assert.equal(result.created, false);
    assert.equal(result.reason, "not_paid");
  });

  await test("a partly discounted gift reconciles for the receipt", async () => {
    const buyer = await makeUser({ email: `disc-${Date.now()}@example.com` });
    const session = sessionFor(buyer, {
      recipientEmail: `discr-${Date.now()}@example.com`,
      discount: 12450,
      tax: 3268,
      amountTotal: 40618,
    });
    const result = await giftWebhook.handleGiftCheckoutCompleted(session);
    const g = await GiftMembership.findById(result.gift._id).lean();
    assert.equal(
      g.amountSubtotalCents - g.discountCents + g.taxCents,
      g.amountPaidCents,
      "subtotal - discount + tax must equal what Stripe charged"
    );
    assert.equal(g.discountCents, 12450);
    assert.equal(g.taxCents, 3268);
  });

  await test("a free gift grants the same entitlement as a paid one", async () => {
    const email = `freeclaim-${Date.now()}@example.com`;
    const buyer = await makeUser({ email: `freebuyer-${Date.now()}@example.com` });
    const session = sessionFor(buyer, {
      recipientEmail: email,
      discount: 49800,
      amountTotal: 0,
    });
    session.payment_status = "no_payment_required";
    session.payment_intent = null;
    const created = await giftWebhook.handleGiftCheckoutCompleted(session);

    const recipient = await makeUser({ email });
    const claim = await giftService.claimGift({
      gift: await GiftMembership.findById(created.gift._id),
      user: recipient,
      addressId: recipient.addresses[0]._id,
    });
    assert.equal(claim.ok, true);
    const active = await giftAccess.findActiveGift(
      recipient._id,
      recipient.addresses[0]._id
    );
    assert(active, "a free gift must still grant access");
    const synthetic = giftAccess.syntheticGiftSubscription(active);
    assert.equal(synthetic.subscriptionType, "plus");
    assert.equal(synthetic.stripeCustomerId, undefined, "and still no billing identity");
  });

  console.log("\nPayment safety");

  await test("NO GIFT OPERATION EVER CREATES OR MODIFIES A SUBSCRIPTION", async () => {
    /*
     * The end-to-end version of the schema test: run the whole lifecycle and
     * assert the Subscription collection is untouched throughout.
     */
    const before = await Subscription.countDocuments({});

    const { gift } = await purchasedGift("jane@example.com");
    const jane = await makeUser({ email: "jane@example.com" });
    await giftService.claimGift({
      gift: await GiftMembership.findById(gift._id),
      user: jane,
      addressId: jane.addresses[0]._id,
    });
    await giftWebhook.handleGiftRefund({
      id: "ch_5",
      payment_intent: gift.stripePaymentIntentId,
      refunds: { data: [{ id: "re_5", amount: 1000 }] },
    });

    assert.equal(await Subscription.countDocuments({}), before, "no Subscription was created");
  });

  await test("a claimed gift stores nothing that could reach the purchaser's card", async () => {
    const { gift } = await purchasedGift("jane@example.com");
    const jane = await makeUser({ email: "jane@example.com" });
    await giftService.claimGift({
      gift: await GiftMembership.findById(gift._id),
      user: jane,
      addressId: jane.addresses[0]._id,
    });

    const stored = await GiftMembership.findById(gift._id).lean();
    const serialized = JSON.stringify(stored);

    assert.ok(!/cus_/.test(serialized), "no Stripe customer id anywhere on the record");
    assert.ok(!/sub_/.test(serialized), "no Stripe subscription id anywhere on the record");
    assert.equal(stored.stripeCustomerId, undefined);
    assert.equal(stored.stripeSubscriptionId, undefined);
  });

  await test("the purchaser's own subscription is invisible from the gift", async () => {
    const purchaser = await makeUser({ email: "sarah@example.com", name: "Sarah Chen" });
    await Subscription.create({
      user: purchaser._id,
      userId: purchaser.userId,
      subscriptionType: "elite",
      addressId: purchaser.addresses[0]._id,
      startDate: new Date(),
      latestPaymentDate: new Date(),
      nextPaymentDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      status: "active",
      stripeCustomerId: "cus_sarah_secret",
      stripeSubscriptionId: "sub_sarah_secret",
    });

    const session = sessionFor(purchaser, { recipientEmail: "jane@example.com" });
    await giftWebhook.handleGiftCheckoutCompleted(session);
    const jane = await makeUser({ email: "jane@example.com" });
    const gift = await GiftMembership.findOne({});
    await giftService.claimGift({ gift, user: jane, addressId: jane.addresses[0]._id });

    const stored = await GiftMembership.findById(gift._id).lean();
    assert.ok(!JSON.stringify(stored).includes("cus_sarah_secret"));
    assert.ok(!JSON.stringify(stored).includes("sub_sarah_secret"));

    // And the recipient owns no subscription at all, so a billing-portal
    // lookup on their account finds nothing to open.
    assert.equal(await Subscription.countDocuments({ user: jane._id }), 0);
  });

  console.log("\nExisting behaviour is unaffected");

  await test("a normal paid member still resolves to their own subscription", async () => {
    const jane = await makeUser({ email: "jane@example.com" });
    const addressId = jane.addresses[0]._id;
    await Subscription.create({
      user: jane._id,
      userId: jane.userId,
      subscriptionType: "premium",
      addressId,
      startDate: new Date(),
      latestPaymentDate: new Date(),
      nextPaymentDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      status: "active",
    });

    // Gift lookup is address-scoped and finds nothing, so the paid path is
    // reached exactly as before.
    assert.equal(await giftAccess.findActiveGift(jane._id, addressId), null);
    assert.equal(await Subscription.countDocuments({ user: jane._id, status: "active" }), 1);
  });

  await test("a user with no gift and no subscription is unchanged", async () => {
    const jane = await makeUser({ email: "jane@example.com" });
    assert.equal(await giftAccess.findActiveGift(jane._id, jane.addresses[0]._id), null);
    const timeline = await giftAccess.findGiftTimeline(jane._id, jane.addresses[0]._id);
    assert.deepEqual(timeline, { active: null, queued: [], expired: [] });
  });
}

/* ========================================================================== */

(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: "gift_test" });
  await Promise.all([GiftMembership.init(), Subscription.init(), User.init()]);

  try {
    await run();
  } finally {
    await mongoose.disconnect();
    await mongod.stop();
  }

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) {
    for (const { name, error } of failures) {
      console.error(`\n--- ${name} ---\n${error.stack || error.message}`);
    }
    process.exit(1);
  }
  process.exit(0);
})();
