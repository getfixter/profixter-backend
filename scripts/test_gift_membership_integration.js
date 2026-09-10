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

  console.log("\nEvery gift length grants exactly what was bought");

  const monthsBetween = (from, to) =>
    (new Date(to).getFullYear() - new Date(from).getFullYear()) * 12 +
    (new Date(to).getMonth() - new Date(from).getMonth());

  for (const months of [1, 2, 3, 6, 12]) {
    await test(`a ${months}-month gift runs exactly ${months} month(s)`, async () => {
      const email = `len${months}-${Date.now()}@example.com`;
      const buyer = await makeUser({ email: `buyer${months}-${Date.now()}@example.com` });
      const session = sessionFor(buyer, {
        recipientEmail: email,
        durationMonths: months,
        amountTotal: 24900 * months,
      });
      session.amount_subtotal = 24900 * months;

      const created = await giftWebhook.handleGiftCheckoutCompleted(session);
      assert.equal(created.created, true);
      assert.equal(created.gift.durationMonths, months, "the purchased length is stored");

      const recipient = await makeUser({ email });
      const claim = await giftService.claimGift({
        gift: await GiftMembership.findById(created.gift._id),
        user: recipient,
        addressId: recipient.addresses[0]._id,
      });
      assert.equal(claim.ok, true);

      const g = await GiftMembership.findById(created.gift._id).lean();
      assert.equal(
        monthsBetween(g.startAt, g.endAt),
        months,
        `the window must span ${months} month(s)`
      );

      // Active on the first day, gone the day after it ends.
      assert.equal(giftAccess.giftAccessState(g, new Date(g.startAt)).active, true);
      const dayAfter = new Date(new Date(g.endAt).getTime() + DAY);
      assert.equal(giftAccess.giftAccessState(g, dayAfter).active, false);
    });
  }

  await test("different lengths stack without overlapping or losing a day", async () => {
    const email = `mixed-${Date.now()}@example.com`;
    const recipient = await makeUser({ email });
    const addressId = recipient.addresses[0]._id;

    const made = [];
    for (const months of [1, 3, 12]) {
      const buyer = await makeUser({ email: `mixedbuyer${months}-${Date.now()}@example.com` });
      const session = sessionFor(buyer, {
        recipientEmail: email,
        durationMonths: months,
        amountTotal: 24900 * months,
      });
      const created = await giftWebhook.handleGiftCheckoutCompleted(session);
      const claim = await giftService.claimGift({
        gift: await GiftMembership.findById(created.gift._id),
        user: recipient,
        addressId,
      });
      assert.equal(claim.ok, true, `claim ${months} failed: ${claim.reason}`);
      made.push({ months, id: created.gift._id });
    }

    const stored = [];
    for (const m of made) stored.push(await GiftMembership.findById(m.id).lean());
    stored.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

    for (let i = 0; i < stored.length; i += 1) {
      assert.equal(
        monthsBetween(stored[i].startAt, stored[i].endAt),
        stored[i].durationMonths,
        "each gift keeps its own purchased length"
      );
      if (i > 0) {
        assert.equal(
          new Date(stored[i].startAt).getTime(),
          new Date(stored[i - 1].endAt).getTime(),
          "each begins exactly when the one before it ends - no gap, no overlap"
        );
      }
    }

    // Continuation must wait for the whole run, 16 months of it.
    const projected = await giftAccess.projectedGiftCoverageEnd(recipient._id, addressId, {
      now: new Date(),
    });
    assert.equal(
      projected.getTime(),
      new Date(stored[stored.length - 1].endAt).getTime(),
      "billing waits for the last gift of the run"
    );
    assert.equal(monthsBetween(stored[0].startAt, projected), 16, "1 + 3 + 12 months of cover");
  });

  console.log("\nA claimed gift grants membership access (production regression)");

  /*
   * Call the REAL GET /api/auth/me over HTTP with a real token.
   *
   * The bug this guards against was invisible to every unit-level check: the
   * gift record was perfect, giftAccessState said active, and the booking API
   * granted access. What was wrong was the ONE payload the whole customer UI
   * reads to decide whether somebody is a member. So the test has to be the
   * route, not a helper.
   */
  async function authMe(user) {
    const express = require("express");
    const http = require("http");
    const jwt = require("jsonwebtoken");

    const routerPath = require.resolve("../routes/auth");
    delete require.cache[routerPath];
    const authRouter = require("../routes/auth");
    delete require.cache[routerPath];

    const app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);

    const token = jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET);

    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path: "/api/auth/me",
            method: "GET",
            headers: { Authorization: "Bearer " + token },
          },
          (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => {
              server.close();
              try {
                resolve({ status: res.statusCode, body: JSON.parse(raw) });
              } catch (e) {
                resolve({ status: res.statusCode, body: { raw } });
              }
            });
          }
        );
        req.on("error", reject);
        req.end();
      });
    });
  }

  /** What the frontend's hasActiveMembership() computes from that payload. */
  const frontendSeesMembership = (body) =>
    Boolean(
      (body?.user?.addresses || body?.addresses || []).some(
        (a) => a.hasActiveSubscription === true
      )
    );

  const addressFrom = (body, addressId) =>
    (body?.user?.addresses || body?.addresses || []).find(
      (a) => String(a._id) === String(addressId)
    );

  await test("a brand new recipient has membership access the moment they claim", async () => {
    /* 1. Somebody buys the gift. The recipient has no account at all yet. */
    const purchaser = await makeUser({ email: "giver-" + Date.now() + "@example.com" });
    const recipientEmail = "newrecipient-" + Date.now() + "@example.com";
    assert.equal(
      await User.countDocuments({ email: recipientEmail }),
      0,
      "the recipient must not exist before the claim"
    );

    const created = await giftWebhook.handleGiftCheckoutCompleted(
      sessionFor(purchaser, { recipientEmail, plan: "basic", durationMonths: 2 })
    );
    assert.equal(created.created, true);

    /* 2. They create a NEW account, exactly as the claim flow has them do. */
    const recipient = await makeUser({ email: recipientEmail, name: "New Recipient" });
    const addressId = recipient.addresses[0]._id;

    /* Before claiming they are not a member. */
    const before = await authMe(recipient);
    assert.equal(before.status, 200);
    assert.equal(
      frontendSeesMembership(before.body),
      false,
      "an unclaimed gift must not grant anything"
    );

    /* 3. They claim it and pick the property. */
    const claim = await giftService.claimGift({
      gift: await GiftMembership.findById(created.gift._id),
      user: recipient,
      addressId,
    });
    assert.equal(claim.ok, true, "claim failed: " + claim.reason);

    const gift = await GiftMembership.findById(created.gift._id).lean();
    assert.equal(gift.status, "claimed");
    assert.equal(String(gift.recipient), String(recipient._id), "the account is attached");
    assert.equal(String(gift.addressId), String(addressId), "the chosen address is persisted");
    assert.ok(gift.startAt, "the gift has started");
    assert.ok(gift.endAt > gift.startAt, "and has an end");
    assert.equal(giftAccess.giftAccessState(gift, new Date()).state, "active");

    /* 4. IMMEDIATELY -- no background job, no second sign-in -- they are a member. */
    const after = await authMe(recipient);
    assert.equal(after.status, 200);
    const covered = addressFrom(after.body, addressId);

    assert.ok(covered, "the chosen address must come back in the payload");
    assert.equal(
      covered.hasActiveSubscription,
      true,
      "THE BUG: a claimed, active gift must read as membership cover"
    );
    assert.equal(covered.plan, "basic", "and must report the gifted plan");
    assert.equal(covered.coverageSource, "gift", "declared as a gift, since there is no billing");
    assert.equal(
      frontendSeesMembership(after.body),
      true,
      "hasActiveMembership() on the frontend must now be true"
    );
  });

  await test("that same recipient can book as a member", async () => {
    const purchaser = await makeUser({ email: "giver2-" + Date.now() + "@example.com" });
    const recipientEmail = "booker-" + Date.now() + "@example.com";
    const created = await giftWebhook.handleGiftCheckoutCompleted(
      sessionFor(purchaser, { recipientEmail, plan: "premium", durationMonths: 1 })
    );
    const recipient = await makeUser({ email: recipientEmail });
    const addressId = recipient.addresses[0]._id;

    await giftService.claimGift({
      gift: await GiftMembership.findById(created.gift._id),
      user: recipient,
      addressId,
    });

    /* Booking authorisation resolves the gift into a usable membership. */
    const found = await giftAccess.findActiveGift(recipient._id, addressId, { now: new Date() });
    assert.ok(found, "booking authorisation must find the gift");
    const synthetic = giftAccess.syntheticGiftSubscription(found);
    assert.equal(synthetic.subscriptionType, "premium", "booked on the gifted plan");
    assert.ok(
      ["active", "trialing"].includes(String(synthetic.status)),
      "a gift must present as usable cover, got " + synthetic.status
    );

    /* The UI and the booking API must agree, which is what failed in production. */
    const me = await authMe(recipient);
    const covered = addressFrom(me.body, addressId);
    assert.equal(
      covered.hasActiveSubscription,
      true,
      "the UI must not deny what the booking API grants"
    );
    assert.equal(covered.plan, synthetic.subscriptionType, "and must agree on the plan");
  });

  await test("a gift never overrides or invents paid billing", async () => {
    const purchaser = await makeUser({ email: "giver3-" + Date.now() + "@example.com" });
    const recipientEmail = "payer-" + Date.now() + "@example.com";
    const recipient = await makeUser({ email: recipientEmail });
    const addressId = recipient.addresses[0]._id;

    /* This person already pays for this address. */
    await Subscription.create({
      user: recipient._id,
      userId: recipient.userId,
      addressId,
      subscriptionType: "elite",
      startDate: new Date(Date.now() - 30 * DAY),
      latestPaymentDate: new Date(Date.now() - 30 * DAY),
      nextPaymentDate: new Date(Date.now() + 30 * DAY),
      currentPeriodEnd: new Date(Date.now() + 30 * DAY),
      status: "active",
      accessStatus: "active",
      stripeSubscriptionId: "sub_paid_regression",
      stripeCustomerId: "cus_paid_regression",
    });

    const created = await giftWebhook.handleGiftCheckoutCompleted(
      sessionFor(purchaser, { recipientEmail, plan: "basic", durationMonths: 1 })
    );
    await giftService.claimGift({
      gift: await GiftMembership.findById(created.gift._id),
      user: recipient,
      addressId,
    });

    const me = await authMe(recipient);
    const covered = addressFrom(me.body, addressId);
    assert.equal(covered.hasActiveSubscription, true);
    assert.equal(covered.plan, "elite", "the paid plan wins, not the gifted one");
    assert.equal(
      covered.coverageSource,
      "subscription",
      "a paying member must be reported exactly as before"
    );
  });

  await test("an expired gift stops granting access", async () => {
    const purchaser = await makeUser({ email: "giver4-" + Date.now() + "@example.com" });
    const recipientEmail = "expired-" + Date.now() + "@example.com";
    const created = await giftWebhook.handleGiftCheckoutCompleted(
      sessionFor(purchaser, { recipientEmail, plan: "plus", durationMonths: 1 })
    );
    const recipient = await makeUser({ email: recipientEmail });
    const addressId = recipient.addresses[0]._id;
    await giftService.claimGift({
      gift: await GiftMembership.findById(created.gift._id),
      user: recipient,
      addressId,
    });

    /* Wind the window into the past; nothing else about the record changes. */
    const ended = new Date(Date.now() - DAY);
    await GiftMembership.updateOne(
      { _id: created.gift._id },
      { $set: { startAt: new Date(ended.getTime() - 30 * DAY), endAt: ended } }
    );

    const me = await authMe(recipient);
    const covered = addressFrom(me.body, addressId);
    assert.equal(
      covered.hasActiveSubscription,
      false,
      "cover must end with the gift, not outlive it"
    );
    assert.equal(covered.coverageSource, null);
  });

  console.log("\nAdmin lifecycle notifications");

  /*
   * These capture what would be SENT, by replacing the transport rather than
   * the gift code. sendTx is the single door every transactional email goes
   * through, so a notice that does not appear here does not exist, and one
   * that appears twice really would arrive twice.
   */
  const mail = require("../utils/emailService");
  const giftEmails = require("../utils/gifts/giftEmails");
  const giftLifecycle = require("../jobs/giftLifecycle");

  function captureEmails() {
    const sent = [];
    const original = mail.sendTx;
    mail.sendTx = async (key, to, vars, opts) => {
      sent.push({ key, to, vars: vars || {}, opts: opts || {} });
      return { ok: true, messageId: "test-" + sent.length };
    };
    return {
      sent,
      of: (key) => sent.filter((m) => m.key === key),
      restore: () => {
        mail.sendTx = original;
      },
    };
  }

  /** A transport that always fails, to prove the retry path. */
  function failingEmails() {
    const attempts = [];
    const original = mail.sendTx;
    mail.sendTx = async (key) => {
      attempts.push(key);
      throw new Error("SMTP unavailable");
    };
    return {
      attempts,
      restore: () => {
        mail.sendTx = original;
      },
    };
  }


  /* Render a gift template by key, so subjects and bodies can be asserted. */
  const { createGiftEmailTemplates } = require("../utils/gifts/giftEmailTemplates");
  const giftTemplates = createGiftEmailTemplates({
    escapeHtml: (v) =>
      String(v == null ? "" : v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;"),
    urls: {},
  });
  const renderTemplate = (key, vars) => {
    const build = giftTemplates[key];
    assert.ok(build, `template ${key} must exist`);
    return build(vars || {});
  };

  const ADMIN = String(process.env.MAIL_ADMIN || "getfixter@gmail.com").trim();

  await test("a paid gift sends the admin purchase email exactly once", async () => {
    const cap = captureEmails();
    try {
      const purchaser = await makeUser({ name: "Sarah Chen", email: "sarah-admin@example.com" });
      const created = await giftWebhook.handleGiftCheckoutCompleted(
        sessionFor(purchaser, { recipientEmail: "gets@example.com", plan: "plus", durationMonths: 2 })
      );
      assert.equal(created.created, true);

      await giftEmails.sendGiftPurchasedAdminNotice(created.gift);
      await giftEmails.sendGiftPurchasedAdminNotice(created.gift);
      await giftEmails.sendGiftPurchasedAdminNotice(
        await GiftMembership.findById(created.gift._id).lean()
      );

      const admin = cap.of("gift_purchased_admin");
      assert.equal(admin.length, 1, `expected exactly one, got ${admin.length}`);
      assert.equal(admin[0].to, ADMIN, "it goes to the admin address");

      const v = admin[0].vars;
      assert.equal(v.giftNumber, created.gift.giftNumber);
      assert.equal(v.purchaserName, "Sarah Chen");
      assert.equal(v.purchaserEmail, "sarah-admin@example.com");
      assert.equal(v.recipientEmail, "gets@example.com");
      assert.equal(v.plan, "Plus");
      assert.equal(v.durationMonths, 2);
      assert.equal(v.amountPaid, "$498.00");
      assert.equal(v.wasFullyDiscounted, false);
      assert.equal(v.claimStatus, "Not claimed yet");
      assert.ok(v.subtotal && v.tax && v.purchasedAt, "money and timing are reported");

      const stamped = await GiftMembership.findById(created.gift._id).lean();
      assert.ok(stamped.adminPurchasedEmailSentAt, "the send is recorded on the gift");
    } finally {
      cap.restore();
    }
  });

  await test("a 100%-off gift settles and still sends it exactly once", async () => {
    const cap = captureEmails();
    try {
      const purchaser = await makeUser({ email: "freegiver@example.com" });
      /* What Stripe reports when a promotion code covers the whole amount. */
      const session = sessionFor(purchaser, {
        recipientEmail: "freegets@example.com",
        amountTotal: 0,
        discount: 49800,
      });
      session.payment_status = "no_payment_required";
      session.payment_intent = null;

      const created = await giftWebhook.handleGiftCheckoutCompleted(session);
      assert.equal(created.created, true, "a zero-total gift is still a real gift");

      await giftEmails.sendGiftPurchasedAdminNotice(created.gift);
      await giftEmails.sendGiftPurchasedAdminNotice(created.gift);

      const admin = cap.of("gift_purchased_admin");
      assert.equal(admin.length, 1);
      assert.equal(admin[0].vars.amountPaid, "$0.00");
      assert.equal(
        admin[0].vars.wasFullyDiscounted,
        true,
        "a $0 gift must be flagged as promotion-covered, not look like a fault"
      );
      assert.notEqual(admin[0].vars.discount, "None", "the discount is reported");
    } finally {
      cap.restore();
    }
  });

  await test("an unpaid or abandoned checkout sends nothing at all", async () => {
    const cap = captureEmails();
    try {
      const purchaser = await makeUser({ email: "abandoner@example.com" });
      const session = sessionFor(purchaser, { recipientEmail: "never@example.com" });
      session.payment_status = "unpaid";

      const result = await giftWebhook.handleGiftCheckoutCompleted(session);
      assert.notEqual(result.created, true, "an unpaid session must not create a gift");
      assert.equal(await GiftMembership.countDocuments({}), 0);
      assert.equal(
        cap.sent.length,
        0,
        `an abandoned checkout must send no email, got ${cap.sent.map((m) => m.key).join(", ")}`
      );
    } finally {
      cap.restore();
    }
  });

  await test("a claim sends the admin claimed email exactly once", async () => {
    const cap = captureEmails();
    try {
      const purchaser = await makeUser({ name: "Ada Gifter", email: "ada@example.com" });
      const recipientEmail = "claimer-" + Date.now() + "@example.com";
      const created = await giftWebhook.handleGiftCheckoutCompleted(
        sessionFor(purchaser, { recipientEmail, plan: "premium", durationMonths: 3 })
      );
      const recipient = await makeUser({ email: recipientEmail, name: "Cleo Claimer" });
      const claim = await giftService.claimGift({
        gift: await GiftMembership.findById(created.gift._id),
        user: recipient,
        addressId: recipient.addresses[0]._id,
      });
      assert.equal(claim.ok, true);

      const gift = await GiftMembership.findById(created.gift._id).lean();
      await giftEmails.sendGiftClaimedAdminNotice(gift, { queued: claim.queued });
      await giftEmails.sendGiftClaimedAdminNotice(gift, { queued: claim.queued });

      const admin = cap.of("gift_claimed_admin");
      assert.equal(admin.length, 1, `expected exactly one, got ${admin.length}`);
      assert.equal(admin[0].to, ADMIN);

      const v = admin[0].vars;
      assert.equal(v.giftNumber, gift.giftNumber);
      assert.equal(v.plan, "Premium");
      assert.equal(v.durationMonths, 3);
      assert.equal(v.recipientEmail, recipientEmail);
      assert.equal(v.purchaserEmail, "ada@example.com");
      assert.equal(v.queued, false, "this one started immediately");
      assert.ok(v.claimedAt && v.startsOn && v.endsOn, "dates are reported");
      assert.ok(/1 Main St/.test(v.propertyAddress), "the chosen property is named");
      assert.equal(v.giftState, "active");
    } finally {
      cap.restore();
    }
  });

  await test("a gift queued behind paid coverage says so in the admin email", async () => {
    const cap = captureEmails();
    try {
      const purchaser = await makeUser({ email: "queuegiver@example.com" });
      const recipientEmail = "queued-" + Date.now() + "@example.com";
      const recipient = await makeUser({ email: recipientEmail });
      const addressId = recipient.addresses[0]._id;

      const periodEnd = new Date(Date.now() + 40 * DAY);
      await Subscription.create({
        user: recipient._id,
        userId: recipient.userId,
        addressId,
        subscriptionType: "plus",
        startDate: new Date(Date.now() - 20 * DAY),
        latestPaymentDate: new Date(Date.now() - 20 * DAY),
        nextPaymentDate: periodEnd,
        currentPeriodEnd: periodEnd,
        status: "active",
        accessStatus: "active",
        cancelAtPeriodEnd: true,
        stripeSubscriptionId: "sub_queue_admin",
        stripeCustomerId: "cus_queue_admin",
      });

      const created = await giftWebhook.handleGiftCheckoutCompleted(
        sessionFor(purchaser, { recipientEmail, plan: "basic", durationMonths: 1 })
      );
      const claim = await giftService.claimGift({
        gift: await GiftMembership.findById(created.gift._id),
        user: recipient,
        addressId,
      });
      assert.equal(claim.ok, true);
      assert.equal(claim.queued, true, "it must be queued behind the paid membership");

      const gift = await GiftMembership.findById(created.gift._id).lean();
      await giftEmails.sendGiftClaimedAdminNotice(gift, { queued: claim.queued });

      const admin = cap.of("gift_claimed_admin");
      assert.equal(admin.length, 1);
      assert.equal(admin[0].vars.queued, true);
      assert.ok(
        String(admin[0].vars.activationNote || "").length > 0,
        "the expected activation behaviour must be spelled out"
      );

      /* And the rendered subject and body must carry the required wording. */
      const rendered = renderTemplate("gift_claimed_admin", admin[0].vars);
      assert.equal(rendered.subject, "Gift Membership Claimed - Profixter");
      assert.ok(
        /Gift claimed - activation pending existing paid coverage/.test(rendered.html),
        "the required queued wording must appear in the email body"
      );
    } finally {
      cap.restore();
    }
  });

  await test("14 days unclaimed sends one admin reminder", async () => {
    const cap = captureEmails();
    try {
      const purchaser = await makeUser({ email: "slowgiver@example.com" });
      const created = await giftWebhook.handleGiftCheckoutCompleted(
        sessionFor(purchaser, { recipientEmail: "slow@example.com" })
      );
      await GiftMembership.updateOne(
        { _id: created.gift._id },
        { $set: { purchasedAt: new Date(Date.now() - 15 * DAY) } }
      );

      const stats = { unclaimedAdminNotices: 0 };
      await giftLifecycle.sendUnclaimedAdminNotices(new Date(), stats, GiftMembership);

      const admin = cap.of("gift_unclaimed_admin");
      assert.equal(admin.length, 1, `expected one reminder, got ${admin.length}`);
      assert.equal(stats.unclaimedAdminNotices, 1);
      assert.equal(admin[0].to, ADMIN);
      assert.equal(admin[0].vars.daysUnclaimed, 15);
      assert.equal(admin[0].vars.giftStatus, "invited");
      assert.equal(admin[0].vars.recipientEmail, "slow@example.com");

      const stamped = await GiftMembership.findById(created.gift._id).lean();
      assert.ok(stamped.adminUnclaimed14dEmailSentAt, "the reminder is recorded persistently");
    } finally {
      cap.restore();
    }
  });

  await test("13 days unclaimed sends nothing yet", async () => {
    const cap = captureEmails();
    try {
      const purchaser = await makeUser({ email: "notyet@example.com" });
      const created = await giftWebhook.handleGiftCheckoutCompleted(
        sessionFor(purchaser, { recipientEmail: "notyet-r@example.com" })
      );
      await GiftMembership.updateOne(
        { _id: created.gift._id },
        { $set: { purchasedAt: new Date(Date.now() - 13 * DAY) } }
      );

      await giftLifecycle.sendUnclaimedAdminNotices(new Date(), { unclaimedAdminNotices: 0 }, GiftMembership);
      assert.equal(cap.of("gift_unclaimed_admin").length, 0, "13 days is too early");

      const gift = await GiftMembership.findById(created.gift._id).lean();
      assert.equal(gift.adminUnclaimed14dEmailSentAt, null, "and nothing is stamped");
    } finally {
      cap.restore();
    }
  });

  await test("a gift claimed before day 14 never gets the reminder", async () => {
    const cap = captureEmails();
    try {
      const purchaser = await makeUser({ email: "claimedearly@example.com" });
      const recipientEmail = "early-" + Date.now() + "@example.com";
      const created = await giftWebhook.handleGiftCheckoutCompleted(
        sessionFor(purchaser, { recipientEmail })
      );
      const recipient = await makeUser({ email: recipientEmail });
      await giftService.claimGift({
        gift: await GiftMembership.findById(created.gift._id),
        user: recipient,
        addressId: recipient.addresses[0]._id,
      });

      /* Now let a month pass. It is claimed, so it is not a candidate. */
      await GiftMembership.updateOne(
        { _id: created.gift._id },
        { $set: { purchasedAt: new Date(Date.now() - 30 * DAY) } }
      );

      await giftLifecycle.sendUnclaimedAdminNotices(new Date(), { unclaimedAdminNotices: 0 }, GiftMembership);
      assert.equal(cap.of("gift_unclaimed_admin").length, 0, "a claimed gift is not unclaimed");
    } finally {
      cap.restore();
    }
  });

  await test("a cancelled or fully refunded gift never gets the reminder", async () => {
    const cap = captureEmails();
    try {
      const purchaser = await makeUser({ email: "voided@example.com" });

      const cancelled = await giftWebhook.handleGiftCheckoutCompleted(
        sessionFor(purchaser, { recipientEmail: "cancelled-r@example.com" })
      );
      await GiftMembership.updateOne(
        { _id: cancelled.gift._id },
        {
          $set: {
            purchasedAt: new Date(Date.now() - 30 * DAY),
            status: "cancelled",
            cancelledAt: new Date(),
          },
        }
      );

      const refunded = await giftWebhook.handleGiftCheckoutCompleted(
        sessionFor(purchaser, { recipientEmail: "refunded-r@example.com" })
      );
      await GiftMembership.updateOne(
        { _id: refunded.gift._id },
        {
          $set: {
            purchasedAt: new Date(Date.now() - 30 * DAY),
            refundStatus: "full",
            amountRefundedCents: 49800,
          },
        }
      );

      await giftLifecycle.sendUnclaimedAdminNotices(new Date(), { unclaimedAdminNotices: 0 }, GiftMembership);
      assert.equal(
        cap.of("gift_unclaimed_admin").length,
        0,
        "neither a cancelled nor a fully refunded gift should be chased"
      );
    } finally {
      cap.restore();
    }
  });

  await test("repeated worker and webhook runs never duplicate an admin email", async () => {
    const cap = captureEmails();
    try {
      const purchaser = await makeUser({ email: "repeat@example.com" });
      const session = sessionFor(purchaser, { recipientEmail: "repeat-r@example.com" });

      /* The webhook fires three times, as Stripe is entitled to do. */
      for (let i = 0; i < 3; i += 1) {
        const r = await giftWebhook.handleGiftCheckoutCompleted(session);
        if (r.created && r.gift) await giftEmails.sendGiftPurchasedAdminNotice(r.gift);
      }
      assert.equal(cap.of("gift_purchased_admin").length, 1, "one sale, one email");

      const gift = await GiftMembership.findOne({ recipientEmail: "repeat-r@example.com" }).lean();
      await GiftMembership.updateOne(
        { _id: gift._id },
        { $set: { purchasedAt: new Date(Date.now() - 20 * DAY) } }
      );

      /* And the sweep runs every hour, forever. */
      for (let i = 0; i < 5; i += 1) {
        await giftLifecycle.sendUnclaimedAdminNotices(new Date(), { unclaimedAdminNotices: 0 }, GiftMembership);
      }
      assert.equal(cap.of("gift_unclaimed_admin").length, 1, "one gift, one reminder, ever");
    } finally {
      cap.restore();
    }
  });

  await test("a failed send is retried rather than lost", async () => {
    const purchaser = await makeUser({ email: "retry@example.com" });
    const created = await giftWebhook.handleGiftCheckoutCompleted(
      sessionFor(purchaser, { recipientEmail: "retry-r@example.com" })
    );

    /* First attempt: the mail server is down. */
    const broken = failingEmails();
    let outcome;
    try {
      outcome = await giftEmails.sendGiftPurchasedAdminNotice(created.gift);
    } finally {
      broken.restore();
    }
    assert.equal(outcome.sent, false);
    assert.equal(outcome.reason, "send_failed");

    const afterFailure = await GiftMembership.findById(created.gift._id).lean();
    assert.equal(
      afterFailure.adminPurchasedEmailSentAt,
      null,
      "a failed send must release the stamp so it can be retried"
    );

    /* Second attempt: the mail server is back. */
    const cap = captureEmails();
    try {
      const retry = await giftEmails.sendGiftPurchasedAdminNotice(afterFailure);
      assert.equal(retry.sent, true, "the retry must go through");
      assert.equal(cap.of("gift_purchased_admin").length, 1);
    } finally {
      cap.restore();
    }
  });

  await test("an email failure never undoes a purchase or blocks a claim", async () => {
    const broken = failingEmails();
    try {
      const purchaser = await makeUser({ email: "resilient@example.com" });
      const recipientEmail = "resilient-r-" + Date.now() + "@example.com";

      const created = await giftWebhook.handleGiftCheckoutCompleted(
        sessionFor(purchaser, { recipientEmail })
      );
      assert.equal(created.created, true, "the purchase stands even with mail down");
      await giftEmails.sendGiftPurchasedAdminNotice(created.gift);

      const recipient = await makeUser({ email: recipientEmail });
      const claim = await giftService.claimGift({
        gift: await GiftMembership.findById(created.gift._id),
        user: recipient,
        addressId: recipient.addresses[0]._id,
      });
      assert.equal(claim.ok, true, "the claim succeeds even with mail down");

      const gift = await GiftMembership.findById(created.gift._id).lean();
      await giftEmails.sendGiftClaimedAdminNotice(gift, { queued: claim.queued });

      /* Entitlement is untouched by any of it. */
      assert.equal(giftAccess.giftAccessState(gift, new Date()).active, true);
    } finally {
      broken.restore();
    }
  });

  await test("no admin email ever carries a raw claim token", async () => {
    const cap = captureEmails();
    try {
      const purchaser = await makeUser({ email: "tokencheck@example.com" });
      const created = await giftWebhook.handleGiftCheckoutCompleted(
        sessionFor(purchaser, { recipientEmail: "tokencheck-r@example.com" })
      );
      const token = created.invitation?.token;
      assert.ok(token && token.length > 10, "the fixture must have a real token to look for");

      await giftEmails.sendGiftPurchasedAdminNotice(created.gift);
      await GiftMembership.updateOne(
        { _id: created.gift._id },
        { $set: { purchasedAt: new Date(Date.now() - 20 * DAY) } }
      );
      await giftLifecycle.sendUnclaimedAdminNotices(new Date(), { unclaimedAdminNotices: 0 }, GiftMembership);

      const adminMails = cap.sent.filter((m) => String(m.key).endsWith("_admin"));
      assert.ok(adminMails.length >= 2, "both admin emails should have been captured");

      for (const message of adminMails) {
        const rendered = renderTemplate(message.key, message.vars);
        const haystack = JSON.stringify(message.vars) + rendered.subject + rendered.html + rendered.text;
        assert.ok(
          !haystack.includes(token),
          `${message.key} must never contain the raw claim token`
        );
        assert.ok(
          !/\/gift\/claim\//.test(haystack),
          `${message.key} must not contain a claim URL`
        );
      }
    } finally {
      cap.restore();
    }
  });

  await test("the admin emails carry the required subjects", async () => {
    const subjects = {
      gift_purchased_admin: "New Gift Membership Purchased - Profixter",
      gift_claimed_admin: "Gift Membership Claimed - Profixter",
      gift_unclaimed_admin: "Gift Membership Still Unclaimed After 14 Days",
    };
    for (const [key, expected] of Object.entries(subjects)) {
      const rendered = renderTemplate(key, {
        giftNumber: "GTEST123",
        purchaserName: "A",
        purchaserEmail: "a@example.com",
        recipientName: "B",
        recipientEmail: "b@example.com",
        plan: "Plus",
        durationMonths: 2,
        daysUnclaimed: 14,
      });
      assert.equal(rendered.subject, expected, `${key} subject`);
    }
  });

  await test("nothing in the admin notification path touches SMS", async () => {
    /* The gift feature must work with Twilio switched off, so nothing here
     * may so much as load the SMS modules, let alone call them. */
    const fs = require("fs");
    const path = require("path");
    const files = [
      "../utils/gifts/giftEmails.js",
      "../utils/gifts/giftEmailTemplates.js",
      "../jobs/giftLifecycle.js",
    ];
    for (const rel of files) {
      const source = fs.readFileSync(path.join(__dirname, rel), "utf8");
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      for (const forbidden of ["twilio", "sendSms", "smsNotifications", "sms/"]) {
        assert.ok(
          !code.toLowerCase().includes(forbidden.toLowerCase()),
          `${rel} must not reference ${forbidden}`
        );
      }
    }
  });

  console.log("\nOptional address, optional phone, and delivery");

  const smsConfig = require("../utils/sms/smsConfig");
  const SmsMessage = require("../models/SmsMessage");

  /* Run a block with specific SMS switches, always restoring them after. */
  async function withSmsFlags({ sms, gift }, fn) {
    const before = {
      SMS_ENABLED: process.env.SMS_ENABLED,
      GIFT_SMS_ENABLED: process.env.GIFT_SMS_ENABLED,
    };
    const set = (name, value) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    set("SMS_ENABLED", sms);
    set("GIFT_SMS_ENABLED", gift);
    try {
      return await fn();
    } finally {
      set("SMS_ENABLED", before.SMS_ENABLED);
      set("GIFT_SMS_ENABLED", before.GIFT_SMS_ENABLED);
    }
  }

  await test("a gift can be bought with no recipient address at all", async () => {
    const purchaser = await makeUser({ email: "noaddr-" + Date.now() + "@example.com" });
    const session = sessionFor(purchaser, { recipientEmail: "noaddr-r@example.com" });
    /* Exactly what the purchase screen sends when the section is left closed. */
    session.metadata.addressLine1 = "";
    session.metadata.addressCity = "";
    session.metadata.addressState = "";
    session.metadata.addressZip = "";

    const created = await giftWebhook.handleGiftCheckoutCompleted(session);
    assert.equal(created.created, true, "no address must not stop a purchase");

    const gift = await GiftMembership.findById(created.gift._id).lean();
    assert.equal(gift.addressSnapshot.line1, "");
    assert.equal(gift.addressId, null, "and no address is claimed yet");
    assert.ok(gift.claimTokenHash, "the invitation still exists");
  });

  await test("the address the recipient picks beats anything the purchaser typed", async () => {
    const purchaser = await makeUser({ email: "snapshot-" + Date.now() + "@example.com" });
    const recipientEmail = "snapshot-r-" + Date.now() + "@example.com";
    const session = sessionFor(purchaser, { recipientEmail });
    /* The purchaser guessed, and guessed wrong. */
    session.metadata.addressLine1 = "999 Wrong Street";
    session.metadata.addressCity = "Nowhere";
    session.metadata.addressZip = "00000";

    const created = await giftWebhook.handleGiftCheckoutCompleted(session);
    const recipient = await makeUser({ email: recipientEmail });
    const realAddressId = recipient.addresses[0]._id;

    const claim = await giftService.claimGift({
      gift: await GiftMembership.findById(created.gift._id),
      user: recipient,
      addressId: realAddressId,
    });
    assert.equal(claim.ok, true);

    const gift = await GiftMembership.findById(created.gift._id).lean();
    assert.equal(
      String(gift.addressId),
      String(realAddressId),
      "entitlement must point at the property the RECIPIENT chose"
    );
    assert.equal(
      gift.addressSnapshot.line1,
      "999 Wrong Street",
      "the purchaser's guess is kept as a reference and nothing more"
    );
    /* And access is granted at the real address, not the typed one. */
    const found = await giftAccess.findActiveGift(recipient._id, realAddressId, { now: new Date() });
    assert.ok(found, "the gift must be active at the recipient's own property");
  });

  await test("email is required and phone alone is refused", async () => {
    const purchaser = await makeUser({ email: "contact-" + Date.now() + "@example.com" });
    const lookup = { findCustomerByEmail: async () => null };

    const phoneOnly = await giftService.validateGiftPurchase({
      purchaser,
      plan: "plus",
      durationMonths: 2,
      recipientEmail: "",
      recipientPhone: "6315551234",
      UserLookup: lookup,
    });
    assert.equal(phoneOnly.ok, false, "phone-only is not purchasable");
    assert.equal(
      phoneOnly.reason,
      "invalid_recipient_email",
      "because claim identity binds on the email address"
    );

    const neither = await giftService.validateGiftPurchase({
      purchaser,
      plan: "plus",
      durationMonths: 2,
      recipientEmail: "",
      recipientPhone: "",
      UserLookup: lookup,
    });
    assert.equal(neither.ok, false, "no contact at all is refused");
  });

  await test("a phone number is optional, normalised, and validated", async () => {
    const purchaser = await makeUser({ email: "norm-" + Date.now() + "@example.com" });
    const lookup = { findCustomerByEmail: async () => null };
    const check = (recipientPhone) =>
      giftService.validateGiftPurchase({
        purchaser,
        plan: "plus",
        durationMonths: 2,
        recipientEmail: "norm-r@example.com",
        recipientPhone,
        UserLookup: lookup,
      });

    assert.equal((await check(undefined)).recipientPhone, "", "absent is fine");
    assert.equal((await check("   ")).recipientPhone, "", "blank is fine");
    assert.equal((await check("631-555-1234")).recipientPhone, "+16315551234", "normalised to E.164");
    assert.equal((await check("(631) 555 1234")).recipientPhone, "+16315551234", "however it is typed");
    assert.equal((await check("+16315551234")).recipientPhone, "+16315551234", "already E.164");

    /* A number we cannot dial is refused rather than silently dropped. */
    for (const bad of ["12", "abc", "555"]) {
      const result = await check(bad);
      assert.equal(result.ok, false, `${bad} should be refused`);
      assert.equal(result.reason, "invalid_recipient_phone");
    }
  });

  await test("email only sends the email and no text", async () => {
    await withSmsFlags({ sms: undefined, gift: "true" }, async () => {
      await SmsMessage.deleteMany({});
      const purchaser = await makeUser({ email: "emailonly-" + Date.now() + "@example.com" });
      const created = await giftWebhook.handleGiftCheckoutCompleted(
        sessionFor(purchaser, { recipientEmail: "emailonly-r@example.com" })
      );
      const gift = await GiftMembership.findById(created.gift._id).lean();
      assert.equal(gift.recipientPhone, "", "no phone was given");

      await giftEmails.sendGiftPurchaseEmails(gift, created.invitation);
      assert.equal(
        await SmsMessage.countDocuments({}),
        0,
        "a gift with no phone number must not queue a text"
      );
    });
  });

  await test("email plus phone sends both, using the same claim link", async () => {
    await withSmsFlags({ sms: undefined, gift: "true" }, async () => {
      await SmsMessage.deleteMany({});
      const purchaser = await makeUser({
        name: "Taras Bandura",
        email: "both-" + Date.now() + "@example.com",
      });
      const session = sessionFor(purchaser, { recipientEmail: "both-r@example.com" });
      session.metadata.recipientPhone = "+16315551234";

      const created = await giftWebhook.handleGiftCheckoutCompleted(session);
      const gift = await GiftMembership.findById(created.gift._id).lean();
      assert.equal(gift.recipientPhone, "+16315551234", "the phone is stored in E.164");

      await giftEmails.sendGiftPurchaseEmails(gift, created.invitation);

      const texts = await SmsMessage.find({}).lean();
      assert.equal(texts.length, 1, `expected one text, got ${texts.length}`);
      assert.equal(texts[0].notificationType, "GIFT_INVITATION");
      assert.equal(texts[0].toPhone, "+16315551234");

      /* The SAME secure link the email carries. */
      const expectedUrl = giftEmails.claimUrl(created.invitation.token);
      assert.ok(
        texts[0].body.includes(expectedUrl),
        "the text must carry the same secure claim URL as the email"
      );
      assert.ok(texts[0].body.includes("Taras"), "and name the purchaser");
    });
  });

  await test("the gift text says the right thing, with or without a name", async () => {
    const { renderSms } = require("../utils/sms/smsTemplates");
    const url = "https://www.profixter.com/gift/claim/tok123";

    const named = renderSms("GIFT_INVITATION", { fromName: "Taras Bandura", claimUrl: url });
    assert.ok(named.startsWith("You received a gift from Taras"), named);
    assert.ok(named.includes("Gift Membership for your home"), named);
    assert.ok(named.includes(url), "the claim link is the message");

    const anonymous = renderSms("GIFT_INVITATION", { fromName: "", claimUrl: url });
    assert.ok(
      anonymous.startsWith("Someone sent you a ProFixter Gift Membership"),
      anonymous
    );
    assert.ok(anonymous.includes(url));
  });

  await test("the gift text carries nothing sensitive", async () => {
    const { renderSms } = require("../utils/sms/smsTemplates");
    const body = renderSms("GIFT_INVITATION", {
      fromName: "Taras Bandura",
      claimUrl: "https://www.profixter.com/gift/claim/tok123",
    });

    /* No money, no plan pricing, no payment detail. */
    for (const forbidden of ["$", "149", "249", "349", "499", "card", "payment", "invoice"]) {
      assert.ok(
        !body.toLowerCase().includes(forbidden.toLowerCase()),
        `the text must not mention ${forbidden}: ${body}`
      );
    }
    /* No property address. */
    for (const forbidden of ["Main St", "Lindenhurst", "11757", "ZIP"]) {
      assert.ok(!body.includes(forbidden), `the text must not mention ${forbidden}`);
    }
    /* No internal identifier. */
    assert.ok(!/[0-9a-f]{24}/i.test(body), "no Mongo id may appear in the text");
    assert.ok(!/\bG[0-9A-F]{8}\b/.test(body), "not even the gift number");
  });

  await test("GIFT_SMS_ENABLED releases the gift text and NOTHING else", async () => {
    /* The whole point of the isolation, asserted directly. */
    await withSmsFlags({ sms: undefined, gift: "true" }, async () => {
      assert.equal(smsConfig.sendingAllowedFor("GIFT_INVITATION"), true);
      const { SMS_TYPES } = require("../utils/sms/smsTypes");
      const others = Object.keys(SMS_TYPES).filter((k) => k !== "GIFT_INVITATION");
      assert.ok(others.length >= 20, "there should be a lot of other types");
      for (const type of others) {
        assert.equal(
          smsConfig.sendingAllowedFor(type),
          false,
          `${type} must stay switched off while only GIFT_SMS_ENABLED is set`
        );
      }
    });
  });

  await test("with GIFT_SMS_ENABLED unset the gift text is only simulated", async () => {
    await withSmsFlags({ sms: undefined, gift: undefined }, async () => {
      await SmsMessage.deleteMany({});
      const purchaser = await makeUser({ email: "sim-" + Date.now() + "@example.com" });
      const session = sessionFor(purchaser, { recipientEmail: "sim-r@example.com" });
      session.metadata.recipientPhone = "+16315551234";

      const created = await giftWebhook.handleGiftCheckoutCompleted(session);
      const gift = await GiftMembership.findById(created.gift._id).lean();
      await giftEmails.sendGiftPurchaseEmails(gift, created.invitation);

      const texts = await SmsMessage.find({}).lean();
      assert.equal(texts.length, 1, "the message is still recorded");
      assert.equal(texts[0].status, "simulated", "but deliberately not sent");
      assert.equal(texts[0].suppressionReason, "sms_disabled");
    });
  });

  await test("claim identity is unchanged and still binds on email", async () => {
    const purchaser = await makeUser({ email: "sec-" + Date.now() + "@example.com" });
    const recipientEmail = "sec-r-" + Date.now() + "@example.com";
    const session = sessionFor(purchaser, { recipientEmail });
    session.metadata.recipientPhone = "+16315551234";
    const created = await giftWebhook.handleGiftCheckoutCompleted(session);
    const gift = await GiftMembership.findById(created.gift._id).lean();

    /* Somebody who knows the phone number but is not the addressee. */
    const impostor = await makeUser({
      email: "impostor-" + Date.now() + "@example.com",
      phone: "6315551234",
    });
    assert.equal(
      giftService.claimantMatches(gift, impostor),
      false,
      "a matching phone number must NOT be accepted as identity"
    );

    const rightPerson = await makeUser({ email: recipientEmail });
    assert.equal(
      giftService.claimantMatches(gift, rightPerson),
      true,
      "the addressee still matches, exactly as before"
    );

    /* And the claim itself refuses the impostor. */
    const refused = await giftService.claimGift({
      gift: await GiftMembership.findById(created.gift._id),
      user: impostor,
      addressId: impostor.addresses[0]._id,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "recipient_mismatch");
  });

  await test("gifts bought before any of this remain valid and claimable", async () => {
    /* A record exactly as it was written before recipientPhone existed. */
    const purchaser = await makeUser({ email: "legacy-" + Date.now() + "@example.com" });
    const recipientEmail = "legacy-r-" + Date.now() + "@example.com";
    const created = await giftWebhook.handleGiftCheckoutCompleted(
      sessionFor(purchaser, { recipientEmail })
    );
    await GiftMembership.collection.updateOne(
      { _id: created.gift._id },
      { $unset: { recipientPhone: "", adminPurchasedEmailSentAt: "" } }
    );

    const legacy = await GiftMembership.findById(created.gift._id).lean();
    assert.equal(legacy.recipientPhone, undefined, "the field is genuinely absent");

    const recipient = await makeUser({ email: recipientEmail });
    const claim = await giftService.claimGift({
      gift: await GiftMembership.findById(created.gift._id),
      user: recipient,
      addressId: recipient.addresses[0]._id,
    });
    assert.equal(claim.ok, true, "an old gift must still claim cleanly");

    const after = await GiftMembership.findById(created.gift._id).lean();
    assert.equal(giftAccess.giftAccessState(after, new Date()).active, true);
  });

  await test("admin emails show whichever contact methods exist", async () => {
    const cap = captureEmails();
    try {
      const purchaser = await makeUser({ email: "adminc-" + Date.now() + "@example.com" });

      const withPhone = sessionFor(purchaser, { recipientEmail: "withphone-r@example.com" });
      withPhone.metadata.recipientPhone = "+16315551234";
      const a = await giftWebhook.handleGiftCheckoutCompleted(withPhone);
      await giftEmails.sendGiftPurchasedAdminNotice(
        await GiftMembership.findById(a.gift._id).lean()
      );

      const b = await giftWebhook.handleGiftCheckoutCompleted(
        sessionFor(purchaser, { recipientEmail: "nophone-r@example.com" })
      );
      await giftEmails.sendGiftPurchasedAdminNotice(
        await GiftMembership.findById(b.gift._id).lean()
      );

      const sent = cap.of("gift_purchased_admin");
      assert.equal(sent.length, 2);

      const both = sent.find((m) => m.vars.recipientEmail === "withphone-r@example.com");
      assert.equal(both.vars.recipientPhone, "+16315551234");
      assert.ok(both.vars.recipientContact.includes("withphone-r@example.com"));
      assert.ok(both.vars.recipientContact.includes("+16315551234"), "both are shown");
      assert.ok(
        renderTemplate("gift_purchased_admin", both.vars).html.includes("+16315551234"),
        "and the phone reaches the rendered email"
      );

      const emailOnly = sent.find((m) => m.vars.recipientEmail === "nophone-r@example.com");
      assert.equal(emailOnly.vars.recipientPhone, "");
      assert.ok(
        !renderTemplate("gift_purchased_admin", emailOnly.vars).html.includes("Recipient phone"),
        "no empty phone row when there is no phone"
      );
    } finally {
      cap.restore();
    }
  });

  await test("no non-gift SMS automation can send, whatever the gift switch says", async () => {
    /*
     * The guarantee the whole isolation exists for, checked at BOTH gates:
     * the service layer and the provider must agree, or a future caller
     * reaching the provider directly could slip past.
     */
    const provider = require("../utils/sms/twilioProvider");
    await withSmsFlags({ sms: undefined, gift: "true" }, async () => {
      for (const type of ["BOOKING_REMINDER_24H", "MEMBERSHIP_STARTED", "SEASONAL_MARKETING", ""]) {
        assert.equal(smsConfig.sendingAllowedFor(type), false, `${type} at the service gate`);
        let threw = null;
        try {
          await provider.sendMessage({ to: "+16315551234", body: "x", notificationType: type });
        } catch (error) {
          threw = error;
        }
        assert.ok(threw, `${type} must be refused by the provider too`);
        assert.equal(threw.reason, "sms_disabled", `${type} refused for the right reason`);
      }
    });
  });

  console.log("\nThe purchaser's own claim link");

  /* Call the REAL route over HTTP, as the purchaser, with a real token. */
  async function claimLinkRequest(user, giftNumber) {
    const express = require("express");
    const http = require("http");
    const jwt = require("jsonwebtoken");

    /*
     * Every gift route answers 404 while the feature flag is down, and this
     * suite deliberately runs with it deleted. Turn it on for the request
     * and put it back afterwards, so the flag's own behaviour is unchanged
     * for every other test in the file.
     */
    const savedFlag = process.env.GIFTS_ENABLED;
    process.env.GIFTS_ENABLED = "true";

    const routerPath = require.resolve("../routes/gifts");
    delete require.cache[routerPath];
    const giftRouter = require("../routes/gifts");
    delete require.cache[routerPath];

    const app = express();
    app.use(express.json());
    app.use("/api/gifts", giftRouter);

    const token = user ? jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) : null;

    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path: `/api/gifts/purchased/${encodeURIComponent(giftNumber)}/claim-link`,
            method: "POST",
            headers: token ? { Authorization: "Bearer " + token } : {},
          },
          (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => {
              server.close();
              if (savedFlag === undefined) delete process.env.GIFTS_ENABLED;
              else process.env.GIFTS_ENABLED = savedFlag;
              let body;
              try {
                body = JSON.parse(raw);
              } catch (e) {
                body = { raw };
              }
              resolve({ status: res.statusCode, body });
            });
          }
        );
        req.on("error", reject);
        req.end();
      });
    });
  }

  const tokenFromUrl = (url) => String(url || "").split("/gift/claim/")[1] || "";

  async function boughtGift(overrides = {}) {
    const purchaser = await makeUser({ email: `buyer-${Date.now()}-${Math.random()}@example.com` });
    const recipientEmail = `rec-${Date.now()}-${Math.random()}@example.com`;
    const created = await giftWebhook.handleGiftCheckoutCompleted(
      sessionFor(purchaser, { recipientEmail, ...overrides })
    );
    return { purchaser, recipientEmail, created };
  }

  await test("the purchaser gets a working claim link for their own gift", async () => {
    const { purchaser, created } = await boughtGift();

    const res = await claimLinkRequest(purchaser, created.gift.giftNumber);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.claimUrl, "a link must come back");
    assert.ok(
      res.body.claimUrl.includes("/gift/claim/"),
      `not a claim URL: ${res.body.claimUrl}`
    );
    assert.equal(res.body.supersededPreviousLink, true, "the caller must be told");

    /* It is a real, verifying token for THIS gift and no other. */
    const stored = await GiftMembership.findById(created.gift._id).lean();
    const verdict = giftToken.verifyClaimToken(tokenFromUrl(res.body.claimUrl), stored);
    assert.equal(verdict.ok, true, `token did not verify: ${verdict.reason}`);
    assert.equal(String(verdict.giftId), String(created.gift._id), "wrong gift");
  });

  await test("the link exposes no internal identifier", async () => {
    const { purchaser, created } = await boughtGift();
    const res = await claimLinkRequest(purchaser, created.gift.giftNumber);
    const url = res.body.claimUrl;

    assert.ok(!url.includes(String(created.gift._id)), "the Mongo id is in the URL");
    assert.ok(!url.includes(String(purchaser._id)), "the purchaser id is in the URL");
    assert.ok(!url.includes(created.gift.recipientEmail), "the recipient email is in the URL");
    // The response carries the link and the dates, and nothing else.
    assert.deepStrictEqual(
      Object.keys(res.body).sort(),
      ["claimUrl", "expiresAt", "supersededPreviousLink"],
      "the response should carry nothing beyond the link"
    );
  });

  await test("nobody else can get a link for somebody else's gift", async () => {
    const { created } = await boughtGift();
    const stranger = await makeUser({ email: `stranger-${Date.now()}@example.com` });

    const res = await claimLinkRequest(stranger, created.gift.giftNumber);
    assert.equal(res.status, 404, "a stranger must not be told it exists");
    assert.ok(!res.body.claimUrl, "and certainly must not get a link");

    const anonymous = await claimLinkRequest(null, created.gift.giftNumber);
    assert.equal(anonymous.status, 401, "signed out must be refused");
  });

  await test("a claimed gift never hands out another claim link", async () => {
    const { created, recipientEmail } = await boughtGift();
    const recipient = await makeUser({ email: recipientEmail });
    const claim = await giftService.claimGift({
      gift: await GiftMembership.findById(created.gift._id),
      user: recipient,
      addressId: recipient.addresses[0]._id,
    });
    assert.equal(claim.ok, true);

    const purchaser = await User.findById(created.gift.purchaser);
    const res = await claimLinkRequest(purchaser, created.gift.giftNumber);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "ALREADY_CLAIMED");
    assert.ok(!res.body.claimUrl, "a claimed gift must expose no link");
  });

  await test("a cancelled or fully refunded gift hands out nothing", async () => {
    for (const [label, patch, code] of [
      ["cancelled", { status: "cancelled", cancelledAt: new Date() }, "CANCELLED"],
      ["refunded", { refundStatus: "full", amountRefundedCents: 49800 }, "REFUNDED"],
    ]) {
      const { purchaser, created } = await boughtGift();
      await GiftMembership.updateOne({ _id: created.gift._id }, { $set: patch });

      const res = await claimLinkRequest(purchaser, created.gift.giftNumber);
      assert.equal(res.status, 409, `${label} should be refused`);
      assert.equal(res.body.code, code);
      assert.ok(!res.body.claimUrl, `${label} must expose no link`);
    }
  });

  await test("an expired invitation is replaced by a working one", async () => {
    const { purchaser, created } = await boughtGift();

    /*
     * A genuinely expired invitation. The expiry is sealed INSIDE the token,
     * so moving the database column alone would not expire anything - the
     * token has to be minted with a life already behind it.
     */
    const dead = giftToken.createClaimToken({
      giftId: created.gift._id,
      version: 99,
      ttlDays: -1,
    });
    await GiftMembership.updateOne({ _id: created.gift._id }, { $set: dead.fields });

    const expired = await GiftMembership.findById(created.gift._id).lean();
    const verdict = giftToken.verifyClaimToken(dead.token, expired);
    assert.equal(verdict.ok, false, "the old link should be dead");
    assert.equal(verdict.reason, "expired", `expected expired, got ${verdict.reason}`);
    /* And the gift itself is untouched by its invitation lapsing. */
    assert.notEqual(expired.status, "cancelled");
    assert.equal(expired.recipient, null);

    const res = await claimLinkRequest(purchaser, created.gift.giftNumber);
    assert.equal(res.status, 200, "the gift is still valid, so a fresh link must be issued");

    const after = await GiftMembership.findById(created.gift._id).lean();
    assert.equal(
      giftToken.verifyClaimToken(tokenFromUrl(res.body.claimUrl), after).ok,
      true,
      "the replacement must work"
    );
    assert.ok(new Date(after.claimTokenExpiresAt) > new Date(), "and must not still be expired");
  });

  await test("issuing a link supersedes the emailed one, and says so", async () => {
    /*
     * The consequence the purchaser is warned about. Only the hash is stored
     * and the token carries a random IV, so a link to show has to be a new
     * one - and a new one replaces the old by design.
     */
    const { purchaser, created } = await boughtGift();
    const emailed = created.invitation.token;

    const before = await GiftMembership.findById(created.gift._id).lean();
    assert.equal(giftToken.verifyClaimToken(emailed, before).ok, true, "emailed link works first");

    const res = await claimLinkRequest(purchaser, created.gift.giftNumber);
    const after = await GiftMembership.findById(created.gift._id).lean();

    const old = giftToken.verifyClaimToken(emailed, after);
    assert.equal(old.ok, false, "the emailed link must stop working");
    assert.equal(old.reason, "superseded");
    assert.equal(
      giftToken.verifyClaimToken(tokenFromUrl(res.body.claimUrl), after).ok,
      true,
      "and the new one must work"
    );
    assert.equal(after.claimTokenReissuedCount, 1, "the reissue is counted");
  });

  await test("handing the purchaser a link does not weaken the claim check", async () => {
    /*
     * The whole safety argument. Holding the link has never been what proves
     * somebody is the recipient, and that is still true.
     */
    const { purchaser, created, recipientEmail } = await boughtGift();
    const res = await claimLinkRequest(purchaser, created.gift.giftNumber);
    const token = tokenFromUrl(res.body.claimUrl);

    const gift = await GiftMembership.findById(created.gift._id);
    assert.equal(giftToken.verifyClaimToken(token, gift.toObject()).ok, true, "the token is valid");

    /* The purchaser holds a valid token and still cannot claim it. */
    assert.equal(
      giftService.claimantMatches(gift.toObject(), purchaser),
      false,
      "the purchaser must not be able to claim their own gift"
    );
    const bySelf = await giftService.claimGift({
      gift,
      user: purchaser,
      addressId: purchaser.addresses[0]._id,
    });
    assert.equal(bySelf.ok, false);
    assert.equal(bySelf.reason, "recipient_mismatch");

    /* A stranger holding the same link cannot claim it either. */
    const stranger = await makeUser({ email: `outsider-${Date.now()}@example.com` });
    const byStranger = await giftService.claimGift({
      gift: await GiftMembership.findById(created.gift._id),
      user: stranger,
      addressId: stranger.addresses[0]._id,
    });
    assert.equal(byStranger.ok, false);
    assert.equal(byStranger.reason, "recipient_mismatch");

    /* The intended recipient still can. */
    const recipient = await makeUser({ email: recipientEmail });
    const proper = await giftService.claimGift({
      gift: await GiftMembership.findById(created.gift._id),
      user: recipient,
      addressId: recipient.addresses[0]._id,
    });
    assert.equal(proper.ok, true, `the recipient must still be able to claim: ${proper.reason}`);
  });

  await test("the purchased list reports invitation age without leaking a token", async () => {
    const { created } = await boughtGift();
    const gift = await GiftMembership.findById(created.gift._id).lean();

    /* Whatever /purchased returns, it must never carry the credential. */
    const { claimTokenHash } = gift;
    assert.ok(claimTokenHash, "the fixture should have a hash stored");

    const route = require("fs").readFileSync(
      require("path").join(__dirname, "../routes/gifts.js"),
      "utf8"
    );
    const purchasedBlock = route.slice(
      route.indexOf('router.get("/purchased"'),
      route.indexOf('router.post("/purchased/')
    );
    assert.ok(purchasedBlock.length > 100, "found the purchased handler");
    for (const leak of ["claimTokenHash", "claimToken:", "invitation.token", "claimUrl("]) {
      assert.ok(!purchasedBlock.includes(leak), `/purchased must not expose ${leak}`);
    }
    assert.ok(purchasedBlock.includes("invitationExpired"), "but it should report expiry");
  });

  await test("the raw token is never written to a log", async () => {
    const { purchaser, created } = await boughtGift();
    const lines = [];
    const realLog = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    let res;
    try {
      res = await claimLinkRequest(purchaser, created.gift.giftNumber);
    } finally {
      console.log = realLog;
    }

    const token = tokenFromUrl(res.body.claimUrl);
    assert.ok(token.length > 20, "the fixture needs a real token");
    const logged = lines.join("\n");
    assert.ok(!logged.includes(token), "the token reached a log line");
    assert.ok(!logged.includes(res.body.claimUrl), "the URL reached a log line");
    assert.ok(logged.includes("gift_claim_link_issued_to_purchaser"), "but the event is recorded");
    assert.ok(logged.includes(created.gift.giftNumber), "with the gift reference");
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
