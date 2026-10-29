/**
 * Admin's Gift button, through the REAL gift checkout route and webhook.
 *
 * Proves the owner buying for a registered customer gets exactly the customer
 * gift purchase: a one-time Stripe payment on the owner's own account, the
 * same price, tax and promotion codes, and a gift that exists only once the
 * webhook sees a paid session. And that the gift is for the customer the owner
 * picked and nobody else, whatever the request says.
 *
 * Stripe is intercepted: session creation is captured, and any other Stripe
 * call fails the test. Nothing leaves the process and nobody is charged.
 *
 *   node scripts/test_admin_gift_checkout.js
 *
 * Not in `npm test`: it boots a MongoDB binary.
 */

Object.assign(process.env, {
  S3_BUCKET: "test-bucket",
  JWT_SECRET: "test-secret",
  STRIPE_SECRET_KEY: "sk_test_fake",
  MAIL_ADMIN: "owner@profixter.test",
  GIFTS_ENABLED: "true",
  STRIPE_PRODUCT_GIFT_BASIC: "prod_TestGiftBasic1",
  STRIPE_PRODUCT_GIFT_PLUS: "prod_TestGiftPlus1",
  STRIPE_PRODUCT_GIFT_PREMIUM: "prod_TestGiftPremium1",
  STRIPE_PRODUCT_GIFT_ELITE: "prod_TestGiftElite1",
  CLIENT_URL: "https://www.profixter.com",
});

const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../models/User");
const GiftMembership = require("../models/GiftMembership");
const subsModule = require("../utils/subscriptionManagement");
const { quoteGift } = require("../utils/gifts/giftPricing");
const { handleGiftCheckoutCompleted } = require("../utils/gifts/giftWebhook");
const { claimantMatches } = require("../utils/gifts/giftService");

let passed = 0;
const failures = [];
let actingUserId = null;
let created = [];

/* ---- Stripe: capture session creation, refuse everything else ---- */
subsModule.stripe.checkout.sessions.create = async (config, options) => {
  created.push({ config, options });
  const key = options?.idempotencyKey;
  const id = key ? `cs_test_${key.slice(-10)}` : `cs_test_${created.length}`;
  return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
};
subsModule.stripe.customers.list = async () => {
  throw new Error("unexpected Stripe customers.list call");
};

/* ---- The real router, with auth replaced by "act as this user" ---- */
const authPath = require.resolve("../middleware/auth");
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: (req, _res, next) => {
    req.user = { id: String(actingUserId) };
    next();
  },
};
const app = express();
app.use(express.json());
app.use("/api/gifts", require("../routes/gifts"));

function post(body) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const raw = JSON.stringify(body);
      const req = http.request(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path: "/api/gifts/checkout-session",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode, body: JSON.parse(data || "{}") });
          });
        }
      );
      req.write(raw);
      req.end();
    });
  });
}

async function test(name, fn) {
  await Promise.all([User.deleteMany({}), GiftMembership.deleteMany({})]);
  created = [];
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error.stack}`);
  }
}

let seq = 0;
async function makeUser(overrides = {}) {
  seq += 1;
  return User.create({
    userId: String(30000000 + seq),
    name: "Jane Doe",
    email: `person${seq}@example.com`,
    phone: "6315551234",
    role: "customer",
    addresses: [{ line1: `${seq} Main St`, city: "Babylon", state: "NY", zip: "11702" }],
    ...overrides,
  });
}

const makeOwner = () =>
  makeUser({ name: "Profixter Owner", email: "owner@profixter.test", stripeCustomerId: "cus_owner", addresses: [] });

/** The completed session Stripe would send for what was captured. */
function completedSession(captured, overrides = {}) {
  return {
    id: captured.id || "cs_test_paid",
    object: "checkout.session",
    payment_status: "paid",
    amount_subtotal: 1000,
    amount_total: 1000,
    total_details: { amount_discount: 0, amount_tax: 0 },
    currency: "usd",
    payment_intent: "pi_test_1",
    metadata: captured.config.metadata,
    ...overrides,
  };
}

async function run() {
  console.log("\n--- the gift is for the customer the owner picked");

  await test("owner buys for a customer: recipient comes from the account, not the request", async () => {
    const owner = await makeOwner();
    const customer = await makeUser({ name: "Maria Lopez", email: "maria@example.com", phone: "6315550101" });
    actingUserId = owner._id;

    const res = await post({
      plan: "plus",
      durationMonths: 3,
      // A stale or tampered request naming somebody else must not matter.
      recipient: { email: "someone.else@example.com" },
      forCustomer: { userId: String(customer._id), addressId: String(customer.addresses[0]._id) },
    });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body.url, /^https:\/\/checkout\.stripe\.com\//);
    const { config, options } = created[0];
    const meta = config.metadata;
    assert.equal(meta.recipientEmail, "maria@example.com");
    assert.equal(meta.recipientFirstName, "Maria");
    assert.equal(meta.recipientLastName, "Lopez");
    assert.equal(meta.recipientPhone, "+16315550101");
    assert.equal(meta.addressLine1, customer.addresses[0].line1);
    assert.equal(meta.addressZip, "11702");
    assert.equal(meta.adminGiftRecipientId, String(customer._id));
    assert.equal(meta.purchaserMongoId, String(owner._id), "the owner is the purchaser");
    assert.ok(options?.idempotencyKey?.startsWith("admin-gift-"));
    assert.equal(config.success_url, "https://www.profixter.com/admin?tab=users&gift=paid&session_id={CHECKOUT_SESSION_ID}");
    assert.equal(config.cancel_url, "https://www.profixter.com/admin?tab=users&gift=canceled");
  });

  await test("the same ordinary purchase: one-time payment, owner's card, same price, tax, promo codes", async () => {
    const owner = await makeOwner();
    const customer = await makeUser();
    actingUserId = owner._id;
    await post({ plan: "premium", durationMonths: 6, forCustomer: { userId: String(customer._id) } });

    const { config } = created[0];
    assert.equal(config.mode, "payment");
    assert.equal(config.subscription_data, undefined);
    assert.equal(config.customer, "cus_owner", "charged to the owner's own Stripe customer");
    assert.equal(config.customer_email, undefined);
    assert.deepEqual(config.automatic_tax, { enabled: true });
    assert.equal(config.allow_promotion_codes, true);
    const quote = quoteGift({ plan: "premium", durationMonths: 6 });
    assert.equal(config.line_items[0].price_data.unit_amount, quote.totalCents, "the catalogue price, unchanged");
  });

  await test("owner may complete a missing phone and name, or leave the phone out", async () => {
    const owner = await makeOwner();
    const customer = await makeUser({ name: "Prince", phone: undefined });
    actingUserId = owner._id;
    await post({
      plan: "basic",
      durationMonths: 1,
      recipient: { firstName: "Prince", lastName: "Rogers", phone: "(631) 555-0199" },
      forCustomer: { userId: String(customer._id) },
    });
    assert.equal(created[0].config.metadata.recipientLastName, "Rogers");
    assert.equal(created[0].config.metadata.recipientPhone, "+16315550199");

    const withPhone = await makeUser({ phone: "6315550142" });
    await post({ plan: "basic", durationMonths: 1, recipient: { phone: "" }, forCustomer: { userId: String(withPhone._id) } });
    assert.equal(created[1].config.metadata.recipientPhone, "", "an explicitly blank phone sends no text");
  });

  await test("a customer with no address on file uses what the owner typed", async () => {
    const owner = await makeOwner();
    const customer = await makeUser();
    actingUserId = owner._id;
    await post({
      plan: "plus",
      durationMonths: 2,
      address: { line1: "9 Ocean Ave", city: "Montauk", state: "NY", zip: "11954" },
      forCustomer: { userId: String(customer._id) },
    });
    assert.equal(created[0].config.metadata.addressLine1, "9 Ocean Ave");
    assert.equal(created[0].config.metadata.addressCity, "Montauk");
  });

  console.log("\n--- refusals, before anything reaches Stripe");

  await test("only the owner can buy for a customer", async () => {
    const customer = await makeUser();
    const other = await makeUser();
    actingUserId = other._id;
    const res = await post({ plan: "plus", durationMonths: 1, forCustomer: { userId: String(customer._id) } });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "ADMIN_ONLY");
    assert.equal(created.length, 0);
  });

  await test("an unknown customer, an employee, or another customer's address is refused", async () => {
    const owner = await makeOwner();
    const customer = await makeUser();
    const stranger = await makeUser();
    const employee = await makeUser({ role: "employee" });
    actingUserId = owner._id;

    const unknown = await post({ plan: "plus", durationMonths: 1, forCustomer: { userId: String(new mongoose.Types.ObjectId()) } });
    assert.equal(unknown.status, 404);
    const staff = await post({ plan: "plus", durationMonths: 1, forCustomer: { userId: String(employee._id) } });
    assert.equal(staff.status, 404);
    const wrongAddress = await post({
      plan: "plus",
      durationMonths: 1,
      forCustomer: { userId: String(customer._id), addressId: String(stranger.addresses[0]._id) },
    });
    assert.equal(wrongAddress.status, 400);
    assert.equal(wrongAddress.body.code, "ADDRESS_NOT_ON_ACCOUNT");
    const bogus = await post({ plan: "plus", durationMonths: 1, forCustomer: { userId: "not-an-id" } });
    assert.equal(bogus.status, 400);
    assert.equal(created.length, 0);
  });

  await test("the existing gift rules still apply: offered lengths and plans only", async () => {
    const owner = await makeOwner();
    const customer = await makeUser();
    actingUserId = owner._id;
    const badLength = await post({ plan: "plus", durationMonths: 5, forCustomer: { userId: String(customer._id) } });
    assert.equal(badLength.status, 400);
    assert.equal(badLength.body.code, "UNSUPPORTED_DURATION");
    const badPlan = await post({ plan: "platinum", durationMonths: 1, forCustomer: { userId: String(customer._id) } });
    assert.equal(badPlan.status, 400);
    assert.equal(created.length, 0);
  });

  console.log("\n--- no duplicate charges, nothing before payment");

  await test("pressing Pay twice opens one checkout, not two", async () => {
    const owner = await makeOwner();
    const customer = await makeUser();
    actingUserId = owner._id;
    const body = { plan: "plus", durationMonths: 3, forCustomer: { userId: String(customer._id) } };
    const [first, second] = await Promise.all([post(body), post(body)]);
    assert.equal(first.body.sessionId, second.body.sessionId);
    assert.equal(created[0].options.idempotencyKey, created[1].options.idempotencyKey);

    await post({ ...body, durationMonths: 6 });
    assert.notEqual(created[2].options.idempotencyKey, created[0].options.idempotencyKey, "a different gift is a different checkout");
  });

  await test("no gift exists until the webhook sees a paid session; then exactly one, for the customer", async () => {
    const owner = await makeOwner();
    const customer = await makeUser({ email: "maria@example.com" });
    const impostor = await makeUser({ email: "impostor@example.com" });
    actingUserId = owner._id;
    const res = await post({ plan: "plus", durationMonths: 2, forCustomer: { userId: String(customer._id) } });
    const captured = { ...created[0], id: res.body.sessionId };

    assert.equal(await GiftMembership.countDocuments(), 0, "opening checkout records nothing");

    const unpaid = await handleGiftCheckoutCompleted(completedSession(captured, { payment_status: "unpaid" }));
    assert.equal(unpaid.created, false);
    assert.equal(await GiftMembership.countDocuments(), 0, "an unpaid session is not a gift");

    const paid = await handleGiftCheckoutCompleted(completedSession(captured));
    assert.equal(paid.created, true);
    const replay = await handleGiftCheckoutCompleted(completedSession(captured));
    assert.equal(replay.created, false, "a replayed webhook creates nothing");
    assert.equal(await GiftMembership.countDocuments(), 1);

    const gift = await GiftMembership.findOne().lean();
    assert.equal(gift.recipientEmail, "maria@example.com");
    assert.equal(String(gift.purchaser), String(owner._id));
    assert.equal(gift.status, "invited", "waits for the customer to claim it, as every gift does");
    assert.equal(gift.recipient, null, "not attached to any account before the claim");
    assert.equal(claimantMatches(gift, customer), true);
    assert.equal(claimantMatches(gift, impostor), false, "nobody else can claim it");
  });

  console.log("\n--- customer purchases are unchanged");

  await test("a customer buying a gift: same session as before, no idempotency key, gift pages", async () => {
    const buyer = await makeUser({ stripeCustomerId: "cus_buyer" });
    actingUserId = buyer._id;
    const res = await post({
      plan: "plus",
      durationMonths: 2,
      recipient: { email: "friend@example.com", firstName: "Sam" },
      address: { line1: "1 Elm St", city: "Islip", state: "NY", zip: "11751" },
    });
    assert.equal(res.status, 200);
    const { config, options } = created[0];
    assert.equal(options, undefined, "no second argument for customer purchases");
    assert.equal(config.metadata.recipientEmail, "friend@example.com");
    assert.equal(config.metadata.addressLine1, "1 Elm St");
    assert.equal(config.metadata.adminGiftRecipientId, undefined);
    assert.equal(config.success_url, "https://www.profixter.com/gift/confirmation?session_id={CHECKOUT_SESSION_ID}");
    assert.equal(config.cancel_url, "https://www.profixter.com/gift?canceled=true");
  });

  await test("a customer cannot use forCustomer to gift someone else's account", async () => {
    const buyer = await makeUser({ stripeCustomerId: "cus_buyer" });
    const victim = await makeUser();
    actingUserId = buyer._id;
    const res = await post({ plan: "plus", durationMonths: 1, forCustomer: { userId: String(victim._id) } });
    assert.equal(res.status, 403);
    assert.equal(created.length, 0);
  });
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  try {
    await run();
  } finally {
    await mongoose.disconnect();
    await mongod.stop();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
