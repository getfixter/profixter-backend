/*
 * Meta conversions from the Stripe webhook (2026-11-03).
 *
 *  - The value is what Stripe charged before tax (welcome offer, promotion
 *    codes and gift-covered trials included), not the catalogue price.
 *  - A sale made by staff (pay-by-phone, payment link, Admin visit or gift
 *    checkout) is not reported as a website conversion.
 *  - A paid gift is reported once as Purchase, from the purchaser.
 *  - The membership Subscribe uses this checkout's event id and browser ids.
 *  - Checkouts accept the browser's fbp/fbc/page URL from the body, validated.
 *
 * No network, no database: metaCapi and User are stubbed.
 *
 *   node scripts/test_meta_conversions.js
 */
process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const metaCapi = require("../utils/metaCapi");
const User = require("../models/User");
const { browserIdsFrom, checkoutMetadataFrom } = require("../utils/metaBrowserIds");
const { __testables: w } = require("../routes/webhook");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}
const sent = [];
metaCapi.sendDetached = (args) => sent.push(args);
const realLog = console.log;
const quiet = (fn) => async () => {
  console.log = () => {};
  try {
    await fn();
  } finally {
    console.log = realLog;
  }
};
const user = { _id: "u1", userId: "1001", email: "a@example.test", phone: "6315550100", addresses: [] };

(async () => {
  console.log("\nValue: what was charged");
  await check("subtotal less discounts, before tax", () => {
    assert.strictEqual(w.chargedBeforeTax({ amount_subtotal: 14900, total_details: { amount_discount: 2980, amount_tax: 1300 } }, 149), 119.2);
    assert.strictEqual(w.chargedBeforeTax({ amount_subtotal: 0, total_details: { amount_discount: 0 } }, 149), 0, "gift-covered trial charges nothing now");
    assert.strictEqual(w.chargedBeforeTax({}, 149), 149, "no amounts on the object: the fallback");
  });

  console.log("\nStaff sales are not website conversions");
  await check("pay-by-phone, payment link, Admin visit and Admin gift are all staff sales", () => {
    for (const metadata of [{ adminInitiated: "phone" }, { adminInitiated: "link" }, { adminInitiated: "true" }, { adminGiftRecipientId: "x" }]) {
      assert.ok(w.soldByStaff({ metadata }), JSON.stringify(metadata));
    }
    assert.ok(!w.soldByStaff({ metadata: { plan: "basic" } }));
  });
  await check("a staff-sold visit sends no Purchase; a customer's does, at amount_total", quiet(() => {
    sent.length = 0;
    w.reportPaidVisitPurchase({ session: { id: "cs_a", metadata: { adminInitiated: "true" }, amount_total: 9900 }, user, booking: {}, contentName: "one_time_visit" });
    assert.strictEqual(sent.length, 0);
    w.reportPaidVisitPurchase({ session: { id: "cs_b", metadata: { fbp: "fb.1.1700000000000.123" }, amount_total: 9900, currency: "usd" }, user, booking: {}, contentName: "one_time_visit" });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].eventId, "sess_cs_b");
    assert.strictEqual(sent[0].customData.value, 99);
    assert.strictEqual(sent[0].fbp, "fb.1.1700000000000.123");
  }));

  console.log("\nGifts");
  await check("a paid gift is one Purchase from the purchaser, value before tax", quiet(async () => {
    sent.length = 0;
    const realFind = User.findById;
    User.findById = () => ({ lean: async () => ({ ...user, firstName: "Ann" }) });
    try {
      const session = { id: "cs_g", currency: "usd", amount_total: 32500, amount_subtotal: 30000, total_details: { amount_discount: 0 }, metadata: { plan: "basic", fbc: "fb.1.1700000000000.AbC" } };
      await w.reportGiftPurchase(session, { purchaser: "u1", plan: "basic" });
      assert.strictEqual(sent.length, 1);
      const e = sent[0];
      assert.strictEqual(e.eventName, "Purchase");
      assert.strictEqual(e.eventId, "sess_cs_g");
      assert.strictEqual(e.customData.value, 300);
      assert.strictEqual(e.customData.content_name, "gift_membership");
      assert.strictEqual(e.user.email, "a@example.test");
      assert.strictEqual(e.fbc, "fb.1.1700000000000.AbC");
      sent.length = 0;
      await w.reportGiftPurchase({ ...session, metadata: { adminGiftRecipientId: "c1" } }, { purchaser: "u1" });
      assert.strictEqual(sent.length, 0, "a gift bought from Admin is not reported");
    } finally {
      User.findById = realFind;
    }
  }));
  await check("a tracking failure never fails the gift", quiet(async () => {
    const realFind = User.findById;
    User.findById = () => ({ lean: async () => { throw new Error("db down"); } });
    const realErr = console.error;
    console.error = () => {};
    try {
      await w.reportGiftPurchase({ id: "cs_x", metadata: {} }, { purchaser: "u1" });
    } finally {
      User.findById = realFind;
      console.error = realErr;
    }
  }));

  console.log("\nThe membership Subscribe");
  await check("uses this session's event id, browser ids and charged value; skips staff sales", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "routes", "webhook.js"), "utf8").replace(/\r\n/g, "\n");
    assert.ok(src.includes("const metaEventId = session.metadata?.eventId || `sess_${session.id}`;"));
    assert.ok(src.includes('if (soldByStaff(session)) logStaffSaleSkipped(session, "Subscribe");\n  else await metaCapi.send({\n    eventName: "Subscribe",\n    eventId: metaEventId,'));
    assert.ok(src.includes("      value: chargedValue,"));
    assert.ok(src.includes("    fbp: session.metadata?.fbp || prevLP.fbp,"));
    assert.ok(!src.includes("eventId: prevLP.eventId"), "never the previous checkout's id");
  });

  console.log("\nBrowser ids from the checkout request");
  await check("well-formed ids and a profixter.com URL pass; anything else is dropped", () => {
    const ok = browserIdsFrom({ fbp: "fb.1.1700000000000.1234567890", fbc: "fb.1.1700000000000.IwAR_x-1", sourceUrl: "https://www.profixter.com/membership/plans" });
    assert.deepStrictEqual(ok, { fbp: "fb.1.1700000000000.1234567890", fbc: "fb.1.1700000000000.IwAR_x-1", sourceUrl: "https://www.profixter.com/membership/plans" });
    const bad = browserIdsFrom({ fbp: "<script>", fbc: { $ne: 1 }, sourceUrl: "https://evil.example/profixter.com" });
    assert.deepStrictEqual(bad, { fbp: "", fbc: "", sourceUrl: "" });
    assert.deepStrictEqual(checkoutMetadataFrom({}), {});
    assert.deepStrictEqual(Object.keys(checkoutMetadataFrom({ sourceUrl: "https://profixter.com/" })), ["source_url"]);
  });
  await check("membership, visit and gift checkouts read them", () => {
    const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
    assert.ok(read("routes", "stripe.js").includes("browserIdsFrom(req.body).fbp"));
    assert.strictEqual((read("routes", "bookings.js").match(/\.\.\.checkoutMetadataFrom\(req\.body\)/g) || []).length, 2);
    assert.ok(read("routes", "gifts.js").includes("...(adminTarget ? {} : checkoutMetadataFrom(req.body))"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
