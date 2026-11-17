# Convert to paid visit

A free visit can become a **membership visit** or a **One-Time Visit**. The customer pays a secure link themselves. Card details are never taken over the phone.

The booking is converted **in place**. Its id, day and time, slot reservation, assigned Fixter, address, notes and photos all stay the same. Nothing is cancelled and nothing is rebooked.

**Code**
- `utils/freeVisit/conversion.js` (the rules)
- `routes/adminFreeVisitConversions.js` (Admin)
- `routes/pay.js` (the customer's page)
- `routes/webhook.js` (payment)
- `models/FreeVisitConversion.js` (the record and its history)
- `routes/visitUpgrade.js` (the customer's own upgrade, signed in, and the verified payment status after Stripe)
- `utils/freeVisit/paymentResolution.js` (settling a paid conversion's money by hand, checked with Stripe)
- `utils/freeVisit/guestLink.js` (a guest visit joined to the account that proved its phone or email)
- Tests:
  - `scripts/test_free_visit_conversion.js` (in CI)
  - FrontEnd `scripts/test_free_visit_conversion_ui.js` (Admin and /pay)
  - FrontEnd `scripts/test_visit_upgrade_ui.js` (My Visits)
  - `scripts/stripe_testmode_conversion.js`: real Stripe test mode, run by hand (see "Verifying with Stripe test mode")

## Using it (Admin)

1. Open the job.
2. Choose **More actions → Convert to paid visit**. This needs the Jobs section (`bookings.assign`).
3. Choose the offer:
   - **Membership**: pick a plan and monthly or annual billing.
   - **One-Time Visit**: uses the One-Time price and its on/off switch.
4. Check the task the paid visit is for.
5. For a membership on a guest visit, choose the account:
   - one of the accounts matching the visit's email or phone, or
   - **Create an account from this visit**, which sends the usual sign-in details.

   Choosing, creating, or adding a home to an account needs the Customers section.
   - The visit is never placed on the account that its email does not belong to.
   - An account that matches by phone only, with a different email, needs your explicit "same person" confirmation.
   - Every refusal is checked before any account or home is written.
6. Inside the member seven-day rule:
   - A brand-new membership's first visit is exempt. This is the existing rule.
   - An existing member needs **Override the seven-day rule** with a reason. Your name and the reason are recorded.
7. Press **Create payment link**. Nothing is sent at this point. The link is shown once:
   - **Copy** it into your own message, or
   - **Send** it by email and/or text. Each channel can be used once per link.

   A homepage guest agreed to texts about their visit only. That consent does not cover a payment link, so for them the link goes by email (or you copy it).
8. The job shows the link's state:
   - **Link ready**
   - **Checkout pending**: the customer has the Stripe page open.
   - **Paid and converted**
   - **Needs attention**

The customer's page, `profixter.com/pay/<token>`, shows only:
- the first name,
- the visit's day, time and street,
- the offer and price.

The customer must tick the terms before Stripe opens. Their exact wording and version are recorded.

## The customer upgrading their own visit

The free visit's card in **My Visits** (under Book) has **Upgrade to a handyman visit**. The customer's **Next visit** card in My Account links to it.

**Who can use it**
- It requires sign-in, and only the account the visit is on. Anyone else's visit is "not found".
- A guest from the homepage form gets their visit onto their account by proving the phone or email they booked with. The guest-visit link does this (`utils/freeVisit/guestLink.js`) at two moments:
  - when they sign in, and
  - when an already signed-in customer opens **My Visits**. A visit booked as a guest while signed in appears there without signing in again, with a one-time note: "We found the free visit you booked ... and added it here."
- Both moments use the same checks:
  - Only a phone or email the account has **proved** counts (`phoneVerifiedAt` or `emailVerifiedAt`). That is exactly what sign-in already trusts.
  - It refuses anything ambiguous:
    - an email that belongs to another account;
    - a phone another customer has also proved (a shared handset);
    - an unproved contact.

  Such visits stay with Admin. Nothing is merged, and no account is created.
- The visit records when and how it was joined: `freeVisitIdentity.linkedAt`, and `linkedVia` set to `sign_in`, `my_visits` or `completion`.

**What it reuses**
- The visit's day, time and address.
- The account's name, email and phone. Only a missing detail is asked for, by the same contact step every booking uses.
- For a membership, the visit's address is added to the customer's account as a home if it is not there yet. This happens only after every check has passed.

**How it works**
1. The customer chooses Membership (plan, monthly or annual) or One-Time Visit.
2. They tick the terms for that exact choice and price.
3. They go straight to their own Stripe page. There is no link, and nothing is sent.

From payment on it is the same conversion as an Admin link: the same webhook, rules, notices, states, Needs action entry and history. On the job it shows as **Started by customer**.

**Rules that differ from an Admin link**
- **No seven-day override.** Inside the seven days, a membership needs the first-visit exception: a customer with no live membership. Otherwise the sheet says why, and One-Time keeps the time.
- **A customer upgrade replaces an unpaid Admin link**, and the history records it. Admin making a link replaces an unpaid customer upgrade, and closes the customer's Stripe page. Neither can start while a payment is unsettled.
- **The 20% first-payment offer** applies exactly as on the customer's own membership checkout (`routes/stripe.js` create-checkout-session), when `utils/welcomeOffer.js` finds them eligible:
  - inside the 10 minutes after creating their own account, or after opening a live campaign,
  - with no live membership,
  - once per account and once per home,
  - monthly or annual.

  The sheet shows the first-payment price, the countdown and terms that name it. If the offer ended while the sheet was open, Continue is refused and the regular price is shown. A welcome-priced Stripe page lasts 31 minutes.
- **Reported to Meta** as the customer's own purchase (Subscribe, or Purchase for One-Time, reported once). Admin links are staff sales and are never reported.

**Why Admin links never carry the 20% offer**
- The offer belongs to the customer's own session: a window opened by their own sign-up, or by their own click on a campaign. An Admin link can be opened by anyone holding it, signed in or not.
- Accounts Admin creates are never eligible (`welcomeOfferWindow`).
- Admin links keep the price Admin quoted. The membership page still has Stripe's promotion-code field, as before.
- If Admin wants to give a discount on a link, that is a promotion code. It is not the welcome offer.

**Kept from the Admin feature**
- A converted visit still counts as the person's one free visit.
- No abandoned-checkout email for any conversion page.
- An abandoned page leaves the free visit as it was.

**Coming back from Stripe**

Returning to My Visits proves nothing. Backing out, a slow webhook, and a page that was paid all land in the same place. So My Visits first says **"Checking payment status..."** and asks the server (`GET /api/visit-upgrade/:bookingId/payment`). The server reads its own records, and for any page still marked unpaid it asks Stripe. The customer is then told:

| State | Shown | Offered |
| --- | --- | --- |
| converted | "Payment received. Your visit is now ...", and "waiting for our confirmation" when it is Pending | nothing |
| processing | "Payment received. We're updating your visit now ... Please don't pay again." The server checks again every 5 seconds for about 3 minutes. | nothing |
| pending | Stripe has the order, but the payment has not cleared: "don't pay again" | nothing |
| attention | Paid, but not converted: "Our team will contact you ... don't pay again" | nothing |
| unpaid | "Payment not completed. Nothing was charged, and your free visit is still booked." | **Return to payment** (the same Stripe page, if it is still open) or the sheet |
| unknown / network error | "We couldn't confirm your payment status yet ... don't pay again" | **Check again** only |

Only a verified **unpaid** ever says nothing was charged or reopens the sheet. The server also refuses every way to a second payment while a page has completed but its webhook has not arrived:
- the customer pressing Continue again;
- choosing a different upgrade;
- Admin making a new link;
- Admin withdrawing the link.

Each of these asks Stripe first, and the answer is `CONVERSION_IN_PROGRESS`. If Stripe cannot be asked, the action is refused too. The status check never converts anything itself: only the webhook does, and Stripe retries it, with the sweep as a backstop.

## What happens on payment

The webhook converts the booking once, and only if it is still the free visit at the time the link was made for.

**Status**
- **Pending Confirmation** becomes **Pending**. This is how a paid visit waits for your approval.
- **Confirmed** stays **Confirmed**.
- Nothing is approved or rejected automatically.

**Notices**
- The customer gets one email: "Your visit is now a … visit". A membership also sends its normal "membership started" email and text.
- You get one email and an activity-log entry.

**What the booking keeps**
- `guestRequestId` and the free-visit identity stay on the booking.
- The old type is kept in `booking.freeVisitConversion.from`.
- The visit still counts as the person's one free visit: converting it does not give them another.

If the visit cannot be converted safely, the conversion becomes **Needs attention**. The causes are:
- the visit was cancelled, moved or edited during checkout,
- the reservation was lost,
- the seven-day rule or the plan limit now refuses it,
- the membership never became active,
- the home was billed twice.

In that case:
- the booking is not touched,
- the customer is told the payment arrived and that their visit has not changed yet,
- you are emailed,
- it is listed under **Needs action → Paid, not converted**.

The visit is also left alone if it was put on a different account, or had already started.

Open the job, then either:
- **Retry conversion**. You can add a seven-day override reason if that rule was the cause. For a visit that was moved, you can tick "convert it as it is now"; this is recorded. Or
- settle the payment yourself, then record how. See "Settling a payment by hand" below.

## Declining or canceling a visit after it was paid

A converted visit is an ordinary paid visit, approved by hand as before: an online free visit becomes **Pending** and waits for you. You can decline it with **Cancel job**, as any job. Canceling it **never** refunds anything, and **never** cancels a membership.

**A One-Time Visit**
- The payment stays in Stripe until you refund it there.
- The cancel result says "Canceling did not refund it."

**A membership**
- The conversion started a **subscription**, which keeps billing every month or year.
- Refunding its first payment in Stripe does **not** stop the next payment.
- To stop billing, cancel the membership on the customer's profile.
- The Cancel step warns about this before you confirm, and the result repeats it.

**What you see afterwards**
- The job says "Canceled after it was paid", with **Resolve payment**.
- It is listed under **Needs action → Paid, then canceled** until you record what you did.
- Reinstating the visit clears it ("the visit was reinstated").

## Settling a payment by hand

This applies to a payment that **needs attention** (closed with **Record and close**) and to a visit **canceled after payment** (**Record decision**).

**What the job shows, as Stripe has it now**
- the amount paid, and the link to the payment in Stripe;
- for a One-Time Visit, whether Stripe shows a refund;
- for a membership:
  - the subscription's state ("bills again on ...", "set to end on ...", or "ended");
  - a link to the subscription in Stripe;
  - a link to the customer's profile, where the membership is canceled.

**What you record, checked with Stripe before it is accepted**

| Visit | Choice | Accepted only when |
| --- | --- | --- |
| One-Time | **Refunded in Stripe** | Stripe shows a refund on the payment (full or partial; the amount is recorded) |
| One-Time | **Kept, no refund** | a note says why |
| Membership | **Membership canceled** | Stripe shows the subscription ended, or set to end, so it will not bill again. You also say whether the first payment was refunded; that is your statement and is recorded as such. |
| Membership | **The customer keeps the membership** | the subscription is still active, and a note says why |

Every choice needs a note. If Stripe cannot be asked, nothing is recorded. Your name, the choice, the note and what Stripe showed are kept in the conversion's history. Nothing here refunds or cancels anything.

## Verifying with Stripe test mode

`scripts/stripe_testmode_conversion.js` runs the real flows against **Stripe test mode**:
- real hosted Checkout pages, paid in a browser with the test card 4242 4242 4242 4242;
- real webhooks, delivered through the Stripe CLI;
- a throwaway in-memory database;
- no email, SMS or Meta call leaves the machine.

It refuses any key that is not a test key, and stops if Stripe reports live mode.

```
stripe listen --forward-to http://localhost:5077/api/stripe/webhook       # prints whsec_...
STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... node scripts/stripe_testmode_conversion.js
```

It covers:
1. a customer membership with the 20% welcome offer;
2. a customer One-Time Visit;
3. an Admin link;
4. an abandoned (expired) page;
5. the same webhook delivered again;
6. paying after leaving Stripe, with the webhook held back;
7. declining after payment, for One-Time and for membership.

It writes a JSON report to `reports/stripe-testmode/`. Its test products and prices are tagged `profixter_testmode=conversion`, and the subscriptions it starts are canceled at the end.

## Safety rules

| Situation | What happens |
| --- | --- |
| Making or sending a link, opening the page, a declined card, an abandoned or expired page | The free visit is unchanged. An expired Stripe page leaves the link usable until it runs out. |
| The visit changed after the link was made | The page refuses to open Stripe. |
| Pay pressed twice, or two tabs | The same Stripe page. Only one page can be opening at a time. |
| A second link for the same visit | Replaces an unpaid one. Refused while a payment is unsettled. |
| Webhook replays, simultaneous deliveries, or the sweep at the same time | Converted once and confirmed once. The booking update only matches the unconverted visit. |
| A second, different paid page | Not converted again. You are alerted to refund it. |
| A replaced or withdrawn link paid late | It converts the visit if the visit is still free. The newer unpaid link is withdrawn. If the visit was already converted, the payment is recorded and you are alerted. It is never lost, and it never causes a webhook error. |
| A Stripe page with no first-visit exception | It closes before the visit enters the member seven days. |
| A link's expiry | It closes 90 minutes before the visit, and lasts at most 7 days. |
| A page was paid, but its webhook has not arrived | Our record still says "open". Continue, a new choice, a new Admin link, or Withdraw each ask Stripe first, and are refused. The return screen says "Payment received", never "Nothing was charged". |
| Coming back from Stripe while Stripe can't be asked | "We couldn't confirm your payment status yet ... don't pay again", with Check again only. |
| A converted visit is canceled | No refund and no membership cancellation. It is listed in Needs action until Admin records, checked with Stripe, what was done. |

A conversion page never gets an abandoned-checkout recovery email. An Admin link is never reported to Meta, because it is a staff sale; the customer's own upgrade is reported as their purchase.

## Rollback

- The feature adds collections, fields and routes. It does not migrate existing data.
- Rolling the code back removes the Admin action and the `/pay` branch.
- Converted bookings stay valid paid visits. Their `freeVisitConversion` field is simply ignored by older code.
- An **open** conversion link stops working after a rollback, because older code does not know the `visit_conversion` link kind.
- Before rolling back, check for conversions that must be settled by hand. Any that are **Paid**, **Needs attention**, or **canceled after payment** and not yet recorded. Use these queries:

  ```
  db.freevisitconversions.find({ status: { $in: ["paid", "converting", "needs_attention"] } })
  db.freevisitconversions.find({ "afterCancel.at": { $type: "date" }, "afterCancel.resolvedAt": null })
  ```
- Older code ignores the `afterCancel`, `resolution` and `freeVisitIdentity.linkedAt` / `linkedVia` fields.
