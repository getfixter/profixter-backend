# Email delivery tracking (Amazon SES) - next steps, not yet done

Status 2026-11-03: **not enabled.** Today every email (review requests
included) is logged in `EmailLog` as `sent` the moment SES *accepts* it over
SMTP. Whether it was then *delivered*, bounced or marked as spam is not
recorded per email. Account-wide, SES reported 698 delivery attempts, 0
bounces and 0 complaints for the 14 days before 2026-11-03, and hard bounces
and complaints already land on the SES account suppression list (mirrored by
`utils/marketing/sesSuppressionSync`).

Turning per-email delivery events on touches the production email system
(every send), so it was left out of the Customer Experience 5 deploy on
purpose. What it takes, in order:

## 1. AWS (SES console, us-east-1) - owner or whoever holds AWS admin

1. **Configuration sets → Create set**, name `profixter-tx`. Leave
   reputation metrics on. Sending pool: default.
2. In that set, **Event destinations → Add destination**:
   - Event types: *Delivery*, *Bounce*, *Complaint* (optionally *Reject*,
     *Rendering failure*, *Delivery delay*). Leave *Open* and *Click* OFF:
     open/click tracking rewrites links and adds a pixel, which the review
     email does not need (`/review` counts link opens anonymously already).
   - Destination: **Amazon SNS**, new topic `profixter-ses-events`.
3. Do **not** set this configuration set as the account default yet.

Nothing changes for any email until step 3 below.

## 2. Backend (one deploy, tested first)

1. A webhook `POST /api/ses/events` that accepts SNS messages: confirm the
   subscription (SubscribeURL), **verify the SNS signature** (reject anything
   unsigned or not from `sns.us-east-1.amazonaws.com`), then match
   `mail.messageId` to `EmailLog.providerMessageId` and set
   `deliveredAt` / `bouncedAt` / `complainedAt` (new fields, append-only).
   SMTP message ids look like `<0100018b...@email.amazonses.com>`; SES events
   carry the bare id, so strip the angle brackets and domain when matching.
2. Subscribe that URL to the SNS topic (HTTPS subscription).
3. Add the header `X-SES-CONFIGURATION-SET: profixter-tx` to transactional
   mail in `utils/emailService.js` (Nodemailer `headers`), behind a code
   default that can be switched off in one change. **Order matters:** SES
   rejects mail that names a configuration set that does not exist, so the
   set (AWS step 1) must exist before this deploys.
4. Admin: show Delivered / Bounced next to each email in Customer details →
   Communication history, and a "delivered" count in the review summary.

## 3. Verify

Send one email to the owner's own address from Admin, check the SNS
delivery arrives, `EmailLog.deliveredAt` is set, and that a send to
`bounce@simulator.amazonses.com` records a bounce. Only then leave it on.

## Rollback

Remove the header (one code default) - mail goes out exactly as today. The
configuration set and topic can stay; they cost nothing unused.
