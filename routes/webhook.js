const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const mongoose = require("mongoose");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const mail = require("../utils/emailService");

async function sendMetaCapi(body) {
  try {
    const pixelId = process.env.FB_PIXEL_ID;
    const token   = process.env.FB_ACCESS_TOKEN;
    if (!pixelId || !token) return;
    const url = `https://graph.facebook.com/v17.0/${pixelId}/events?access_token=${token}`;
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: [body] }) });
    if (!r.ok) console.warn("Meta CAPI (webhook) error:", r.status, await r.text());
  } catch (e) { console.warn("Meta CAPI (webhook) failed:", e.message); }
}

function getPlanPrice(plan) {
  switch (plan) { case "basic": return 149; case "plus": return 249; case "premium": return 349; case "elite": return 499; default: return 0; }
}

// Map Stripe Price IDs to plan names (from Payment Links)
const PRICE_TO_PLAN = {
  "price_1RUdq2Bw0RtvSZjMnnI6uRgn": "basic",   // Basic - $149
  "price_1RUds8Bw0RtvSZjMFS1BoQEU": "plus",    // Plus - $249
  "price_1RUdtWBw0RtvSZjMOo8Q1as9": "premium", // Premium - $349
  "price_1RUduRBw0RtvSZjMy6ySmgHk": "elite",   // Elite - $499
};

module.exports = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        console.log("🔔 Checkout session completed:", session.id);

        // Get email
        let email = session.customer_email || session?.customer_details?.email || null;
        if (!email && session.customer) {
          const c = await stripe.customers.retrieve(session.customer);
          email = c?.email || null;
        }
        if (!email) {
          console.warn("⚠️ No email found in session:", session.id);
          break;
        }

        // Find user
        const user = await User.findOne({ email: String(email).toLowerCase() });
        if (!user) {
          console.warn("⚠️ User not found for email:", email);
          break;
        }

        // Determine plan from metadata OR price_id
        const md = session.metadata || {};
        let plan = String(md.plan || "").toLowerCase();
        let addressId = md.addressId && mongoose.isValidObjectId(md.addressId) ? md.addressId : null;

        // If no plan in metadata, try to get from line items (Payment Links)
        if (!plan) {
          try {
            const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
            if (lineItems.data && lineItems.data[0]) {
              const priceId = lineItems.data[0].price.id;
              plan = PRICE_TO_PLAN[priceId] || "";
              console.log(`📦 Detected plan from price_id ${priceId}: ${plan}`);
            }
          } catch (e) {
            console.error("❌ Failed to retrieve line items:", e.message);
          }
        }

        if (!plan) {
          console.warn("⚠️ No plan detected for session:", session.id);
          break;
        }

        const now = new Date();

        // Determine address: metadata > client_reference_id > defaultAddressId
        let subdoc = null;
        
        // Try metadata addressId
        if (addressId) {
          subdoc = user.addresses.id(addressId);
        }
        
        // Try client_reference_id as addressId (for Payment Links)
        if (!subdoc && session.client_reference_id && mongoose.isValidObjectId(session.client_reference_id)) {
          subdoc = user.addresses.id(session.client_reference_id);
          if (subdoc) {
            console.log(`📍 Found address from client_reference_id: ${session.client_reference_id}`);
          }
        }
        
        // Fallback to default address
        if (!subdoc && user.defaultAddressId) {
          subdoc = user.addresses.id(user.defaultAddressId);
          console.log(`📍 Using default address: ${user.defaultAddressId}`);
        }
        
        // Last resort: use first address
        if (!subdoc && user.addresses && user.addresses.length > 0) {
          subdoc = user.addresses[0];
          console.log(`📍 Using first address as fallback`);
        }

        const next = new Date(now); next.setMonth(now.getMonth() + 1);

        // Create subscription record
        const subscription = new Subscription({
          user: user._id,
          userId: user.userId,
          subscriptionType: plan,
          addressId: subdoc ? subdoc._id : null,
          addressSnapshot: subdoc ? {
            line1: subdoc.line1, city: subdoc.city, state: subdoc.state, zip: subdoc.zip, county: subdoc.county || ""
          } : undefined,
          startDate: now,
          latestPaymentDate: now,
          nextPaymentDate: next,
          status: "active",
          planPrice: getPlanPrice(plan),
          paymentMethod: "card",
        });
        await subscription.save();

        // Back-compat: update user fields
        await User.updateOne({ _id: user._id }, {
          subscription: plan,
          subscriptionStart: now,
          subscriptionStatus: "active",
        });

        console.log(`✅ Subscription created: ${plan} for ${user.email} (userId: ${user.userId})`);

        // Send emails
        await mail.sendTx("subscription_started", user.email, {
          name: user.name || email.split("@")[0],
          plan: (plan || "").replace(/^./, c => c.toUpperCase()),
        }, { bccAdmin: false });

        await mail.sendPromo(process.env.MAIL_ADMIN || "getfixter@gmail.com", {
          subject: `✅ New Subscription: ${plan.toUpperCase()} - ${user.name || email}`,
          html: `
            <h2>🎉 New Subscription Activated</h2>
            <p><strong>Plan:</strong> ${plan.toUpperCase()} ($${getPlanPrice(plan)})</p>
            <p><strong>Name:</strong> ${user.name || ""}</p>
            <p><strong>Email:</strong> ${user.email}</p>
            <p><strong>User ID:</strong> ${user.userId}</p>
            <p><strong>Address:</strong> ${subdoc ? `${subdoc.line1}, ${subdoc.city}, ${subdoc.state} ${subdoc.zip}` : "⚠️ No address assigned"}</p>
            <p><strong>Session ID:</strong> ${session.id}</p>
            <p><strong>Payment Method:</strong> Card</p>
            <hr>
            <p><em>Source: ${md.plan ? 'Checkout Flow' : 'Payment Link'}</em></p>
          `,
        });

        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object;
        if (invoice.billing_reason === "subscription_cycle" || invoice.billing_reason === "subscription_create") {
          const amount   = (invoice.amount_paid || 0) / 100;
          const currency = (invoice.currency || "usd").toUpperCase();
          await sendMetaCapi({
            event_name: "Subscribe",
            event_time: Math.floor(Date.now() / 1000),
            event_id: `sub_paid_${invoice.id}`,
            action_source: "other",
            custom_data: { currency, value: amount },
          });
        }
        break;
      }

      default: break;
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    res.status(500).send("Server error");
  }
};
