# Tips: recording, reconciliation and repair

## What counts as a tip

A paid Stripe Checkout Session from one of the two tip flows. A tip is
identified by the flow that took it, never by its amount.

| Flow | How it is recognised | Attribution |
|---|---|---|
| Profixter tip checkout (`/tip`, completion email, My Visits) | metadata `productKind: "fixter_tip"` | the encrypted tip token (`attributionBasis: checkout_token`) |
| Old static Stripe Payment Link "Tip Mr. Fixter", `buy.stripe.com/eVq8wO3W98O03NL3ASawo00` | `payment_link == plink_1RycuaBw0RtvSZjMIGYLnCpD` (`STRIPE_LEGACY_TIP_PAYMENT_LINKS` replaces the list) | from the customer's visit history (below), or unassigned and flagged |

The old link is still active in Stripe. It may be printed or bookmarked
somewhere this code cannot see, so it is recognised rather than switched off.

## The incident this fixes (2026-11-25)

Gwen paid a $50 tip (`pi_3UforXBw0RtvSZjM1HSmdcli`) from My Visits. "Leave a
tip" on completed visits was hard-coded to the old static link. The August
2026 tip-ledger cutover moved the emails (`TIP_LINK`) but missed that button.
Stripe delivered the event; the webhook only recognised `productKind:
"fixter_tip"`, so it ignored the event and no Tip was written. The Tips view
cannot show a record that does not exist.

The same cause hid a $20 tip on 2026-11-11 (`pi_3UagOCBw0RtvSZjM1gswjY7I`).

## Old-link attribution rule (`utils/fixterTips attributionFromVisitHistory`)

- **Customer:** the payer's email must match a Profixter customer account
  whose email is not "typed at checkout only" (the existing `loadTipUser`
  policy).
- **Fixter:** credited only if every visit that customer had **completed in the
  30 days before the tip** was assigned to the same single Fixter or General
  Fixter.
- **Visit:** linked only when exactly one visit was completed in the 24 hours
  before the tip.
- **Anything else:** the tip is stored unassigned, with `needsReview` set and
  a reason in the admin Tips list. Assigning it by hand clears the flag
  (`attributionBasis: admin`).

## Every writer uses one recorder (`utils/tipRecording`)

`recordTipFromSession` is called by:

- the live webhook, which also emails the Fixter;
- the hourly reconcile job, which emails nobody;
- the repair script, which emails nobody.

It is idempotent: a read first, then the unique index on
`Tip.stripePaymentIntentId`. Webhook retries, races, the job and repeated
repairs cannot create a second Tip.

`receivedAt` is the payment time: the event time for the webhook, the charge
time for reconcile and repair. It is not the moment the record was written, so
a late record lands in the right Friday-to-Thursday pay period.

## Refunds and disputes

- **Refunds:** reduce `refundedCents` (existing rule). The record is never
  deleted. Reconcile brings a refund that is behind Stripe level.
- **Disputes:** `charge.dispute.created` and `charge.dispute.closed` set
  `disputeStatus` and `needsReview` and leave the amounts untouched. A lost
  dispute is a separate money movement in Stripe and is not guessed here.

## Hourly check (`jobs/tipReconcile.js`, minute :23 New York time)

- **Window:** 7 days. Tips younger than 30 minutes are left to the webhook.
- **Missing tip paid on or after 2026-11-28:** recorded with
  `recordedBy: "reconcile"`, without notifying anyone.
- **Older gaps, amount differences, disputes, and ledger rows with no Stripe
  tip behind them:** reported, never rewritten.
- **Signals:** a `tip_reconcile` log line every run. When something needs a
  person, an error-level `tip_reconcile_alert` line plus one Admin email
  (`admin_tip_reconcile_alert`). The same unresolved findings are re-sent at
  most once a day; newly recorded tips are always reported.

## Repair (`scripts/repair_missing_tips.js`)

```
node scripts/repair_missing_tips.js                     # dry run, ledger lifetime
node scripts/repair_missing_tips.js --pi=pi_a,pi_b       # dry run, these payments
node scripts/repair_missing_tips.js --pi=pi_a,pi_b --apply
```

- **Dry run by default.** It prints each category and, for every missing tip,
  the exact record it would write.
- **`--apply` requires `--pi`,** so a repair writes only what was reviewed.
- **Scope:** never before the tip ledger existed
  (`TIP_LEDGER_STARTED_AT` = 2026-08-12 18:00 UTC).
- **Stripe:** read only (`list` and `retrieve`).
- **Messages and payouts:** none.

## Stripe-only history (not website records)

88 old-link tips were paid before the ledger existed, from 2025-08-21 to
2026-08-12 14:32 UTC. One of them (2026-04-28, $275) was fully refunded. They
were never website records and are not imported. Importing them is an owner
decision. On purpose, the reconciler today clamps any earlier `--since` to
the ledger start, so this would need a deliberate code change and its own
reviewed dry run.
