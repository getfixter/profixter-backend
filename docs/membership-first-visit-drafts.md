# Membership first-visit drafts: lifecycle and retention

Book a Handyman saves a membership's first visit (job, home, photos, time, hold)
as a `MembershipFirstVisitDraft` before the Stripe page opens. The Stripe webhook
books it when the payment is confirmed (`utils/membershipFirstVisitFulfillment.js`).
Drafts nobody paid for are cleaned up by `utils/membershipFirstVisitCleanup.js`,
which runs every 5 minutes with the hold-cleanup job (`jobs/oneTimeVisitHolds.js`,
`ONE_TIME_VISIT_HOLD_CLEANUP_MS`).

| Draft | When | What happens |
| --- | --- | --- |
| Never reached Stripe (`draft`) | 24 hours after it was last touched | Abandoned; its photos are deleted |
| Stripe page still `checkout_open` here | 2 hours (pages expire after 31 minutes) | Stripe is asked: **paid** -> booked; **expired** -> abandoned, photos deleted; **open** or Stripe unreachable -> kept, asked again next run |
| Page expired (webhook) | at once | Marked `expired`; photos deleted |
| `abandoned` / `expired` record | 30 days after its photos were deleted | Record deleted |
| `paid`, `fulfilling`, `booked`, `needs_admin`, `rebooked` | never | Never cleaned up |

Rules the cleanup keeps:

- A photo any Booking refers to is never deleted.
- Photos are deleted only after the draft is safely marked abandoned/expired
  (one conditional update: a payment confirmed meanwhile wins).
- A failed deletion is recorded (`cleanupError`, `cleanupAttempts`) and retried
  on the next run; a run that crashes mid-way releases its claim after 10 minutes.
- Within the 30 days a late payment for an abandoned or expired draft is still
  booked from the record (without the deleted photos); `markFirstVisitPaid`
  accepts it. Stripe cannot complete an expired page, so this is a safety net.
- Nothing here changes a Booking, Subscription or User.
