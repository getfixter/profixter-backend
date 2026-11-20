/**
 * READ-ONLY: is the Stripe webhook endpoint subscribed to every event the
 * paid-visit and membership code relies on? (2026-11-20)
 *
 *   STRIPE_SECRET_KEY=rk_live_... node scripts/stripe_webhook_subscriptions_check.js
 *
 * Use a RESTRICTED key with only "Webhook Endpoints: Read" (rk_live_... or
 * rk_test_...). It makes one call, GET /v1/webhook_endpoints, prints each
 * endpoint's URL, status and the required events it is missing, and exits 1 if
 * the endpoint for /api/stripe/webhook lacks any. It changes nothing.
 */
"use strict";

const KEY = String(process.env.STRIPE_SECRET_KEY || "");
if (!/^(rk|sk)_(live|test)_/.test(KEY)) {
  console.error("Set STRIPE_SECRET_KEY to a Stripe key (a restricted key with Webhook Endpoints: Read is enough).");
  process.exit(2);
}

/* What routes/webhook.js acts on for paid visits and memberships, and why. */
const REQUIRED = {
  "checkout.session.completed": "records a paid One-Time / Full Day visit and a membership checkout",
  "checkout.session.expired": "releases the time of an unpaid page; membership first-visit hold release",
  "checkout.session.async_payment_succeeded": "a delayed payment that clears later (settles once)",
  "checkout.session.async_payment_failed": "a delayed payment that fails (ends the booking)",
  "payment_intent.payment_failed": "counts a declined card while the page stays open (never cancels since 2026-11-19)",
  "customer.subscription.created": "creates the Subscription record (first paid membership)",
  "customer.subscription.updated": "keeps membership status in step",
  "customer.subscription.deleted": "ends a membership",
  "invoice.paid": "renewals (loyalty months) and project invoices",
  "invoice.payment_failed": "membership payment recovery",
  "charge.refunded": "tips, gifts, loyalty reversal",
};

(async () => {
  const stripe = require("stripe")(KEY);
  const list = await stripe.webhookEndpoints.list({ limit: 100 });
  let target = null;
  for (const ep of list.data) {
    const all = ep.enabled_events.includes("*");
    const missing = all ? [] : Object.keys(REQUIRED).filter((e) => !ep.enabled_events.includes(e));
    console.log(`${ep.url}  status=${ep.status}  livemode=${ep.livemode}  ${all ? "ALL EVENTS" : `${ep.enabled_events.length} events`}`);
    for (const e of missing) console.log(`   MISSING ${e}  - ${REQUIRED[e]}`);
    if (/\/api\/stripe\/webhook\/?$/.test(ep.url)) target = { ep, missing };
  }
  if (!target) {
    console.log("\nNo endpoint ends in /api/stripe/webhook.");
    process.exit(1);
  }
  console.log(target.missing.length ? `\n${target.missing.length} required event(s) missing on ${target.ep.url}.` : `\nAll required events are enabled on ${target.ep.url}.`);
  process.exit(target.missing.length || target.ep.status !== "enabled" ? 1 : 0);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
