# Stripe Subscription Sync Manual Checklist

1. Create a new subscription through Stripe Checkout and confirm webhook sync creates or updates the local Stripe-managed subscription record.
2. Upgrade plan from the website and confirm Stripe changes first, then local plan, Stripe price ID, billing cycle, current period dates, and access state match Stripe.
3. Downgrade plan from the website and confirm the Stripe schedule exists and local pending plan fields reflect the scheduled change.
4. Schedule cancellation at period end and confirm Stripe `cancel_at_period_end=true`, local `cancelAtPeriodEnd=true`, and access remains active until period end.
5. If immediate cancellation is performed in Stripe Dashboard, confirm `customer.subscription.deleted` updates the local record to inactive.
6. Reactivate a scheduled cancellation from the website and confirm Stripe clears cancellation before local state updates.
7. Trigger a failed payment in Stripe test mode and confirm invoice webhook updates latest invoice/payment state without Profixter force-canceling Stripe.
8. Change a subscription plan directly in Stripe Dashboard and confirm webhook updates local plan, price ID, billing cycle, and access state.
9. Cancel a subscription directly in Stripe Dashboard and confirm webhook updates the customer account and address coverage.
10. Update a customer payment method in Billing Portal and confirm `payment_method.attached` / follow-on Stripe events sync related records.
11. Re-send a webhook event from Stripe and confirm duplicate delivery is ignored safely.
12. Open the customer account UI after each test and confirm plan/access reflects Stripe-derived backend state.
