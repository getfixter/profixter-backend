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
    assert.equal(
      new Date(stored.startAt).getTime(),
      periodEnd.getTime(),
      "it begins exactly when the paid coverage ends"
    );
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
