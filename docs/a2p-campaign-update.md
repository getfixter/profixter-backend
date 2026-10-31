# A2P campaign update for Registration 2.0

Campaign: Messaging Service …70d0, A2P campaign …ba0b, use case LOW_VOLUME,
status VERIFIED. Only the **message flow** (how people opt in) changes. The
description, sample messages, opt-in/opt-out/help messages and the use case
stay exactly as registered.

## Why it has to change

The registered message flow describes the old sign-up form (two SMS boxes and
a separate Terms box). Registration 2.0 removes all checkboxes from sign-up:

- Sign-in codes are sent by **Twilio Verify**, from Twilio's own registered
  senders, not through this campaign. A code the person requests is not
  campaign traffic and needs no checkbox.
- Service texts become an optional, unticked box at the **booking step**
  ("Text me about my visits"), in addition to account settings.
- Marketing texts stay optional and are offered **only** in account settings.

Carriers check that the live opt-in matches the registered description, so the
description must be updated when the new screens go live.

## New message flow (paste into the campaign's "Message flow" field)

> End users opt in to ProFixter service text messages on the ProFixter website
> in two places, both optional and unchecked by default. (1) At the booking
> step (https://www.profixter.com/book and /book/free), a single checkbox
> "Text me about my visits" appears above the booking button; it covers booking
> confirmations, appointment reminders and arrival updates, and links to the
> SMS Terms at https://www.profixter.com/communication-consent. (2) In account
> settings at https://www.profixter.com/account, two separate unchecked
> checkboxes: "Text me about my ProFixter visits." (service) and "Text me
> occasional ProFixter offers." (marketing). Marketing consent is collected
> only in account settings, is never required, and is never combined with any
> other consent. Every opt-in location states the brand, that message
> frequency varies, that message and data rates may apply, and "Reply STOP to
> opt out or HELP for help", and links to the Privacy Policy
> (https://www.profixter.com/privacy), Terms of Service
> (https://www.profixter.com/terms) and SMS Terms
> (https://www.profixter.com/communication-consent). Account sign-up collects
> no SMS consent: a person may verify their own phone number with a one-time
> code they request, which is sent by Twilio Verify and is not sent under this
> campaign. Customers can book and use ProFixter without consenting to any
> texts. There is no keyword, verbal or paper opt-in, and no purchased, rented
> or shared list. Annotated screenshots of the booking-step checkbox and the
> account settings are published at
> https://www.profixter.com/sms-consent-example.

## Order of operations (do not reverse)

1. Deploy Registration 2.0, so the new screens and the updated public pages
   (/communication-consent, /sms-consent-example with the new screenshots)
   are live. Reviewers visit these URLs.
2. Submit the message-flow update for campaign …ba0b (Twilio Console →
   Messaging → Regulatory compliance → Campaigns → edit, or the Usa2p update
   API). Only after the owner approves submission.
3. Confirm with Twilio support whether the campaign keeps sending during the
   re-review (normally it does for a message-flow-only edit) and track the
   status until it returns to VERIFIED.

Note: production today already differs from the registered flow (it requires
the service-texts box, while the campaign registered it as optional). This
update brings the registration back in line with the live site.

## Admin-assisted opt-in (updated 2026-10-31, evening)

**Status checked 2026-10-31 (Twilio API, read-only):** campaign …ba0b is
VERIFIED, last updated 2026-09-11, and still carries the OLD Registration 1.0
flow above ("sign-up form ... There is no keyword opt-in, no verbal opt-in, no
paper opt-in"). The Registration 2.0 update in this file was never submitted.
So today the only registered places a customer can give marketing consent are
the sign-up form and account settings.

What the code does (utils/consent/marketingSmsBasis.js decides for every
marketing text):

| How the customer agreed | Recorded as | Marketing texts |
|---|---|---|
| Sign-up form, account settings, website, START | their own source | yes, now |
| Phone call, recorded by staff in Admin | `admin_phone`, method `phone_call` | no - the customer confirms in account settings (Admin can email them the link) |
| Their own email / text / signed form, recorded by staff with the evidence | `admin_written` | after Twilio confirms the flow below and `SMS_ADMIN_ASSISTED_OPTIN_REGISTERED=true` is set on EB |
| One-click "Yes, text me offers" page from the email Admin sends | `sms_confirm_link` | same - after confirmation and the flag |

Until the flag is set, the confirmation email Admin sends links to account
settings (sign in, tap "Text me occasional ProFixter offers"), which is the
registered opt-in and qualifies at once.

### Message flow to submit (replaces the whole field; covers Registration 2.0 too)

Submit in the Twilio Console: Messaging > Regulatory compliance > Campaigns >
campaign …ba0b > edit Message flow (a VERIFIED campaign cannot be edited through
the API). Ask Twilio support, through the Console, whether the campaign keeps
sending during re-review. Set `SMS_ADMIN_ASSISTED_OPTIN_REGISTERED=true` only
after the campaign shows VERIFIED with this flow.

> End users opt in on the ProFixter website; every opt-in is optional,
> unchecked by default, never required to buy anything, and never combined
> with another consent. SERVICE TEXTS: (1) at the booking step
> (https://www.profixter.com/book and /book/free), a checkbox "Text me about
> my visits"; (2) in account settings at https://www.profixter.com/account,
> "Text me about my ProFixter visits." MARKETING TEXTS: (1) in account settings
> at https://www.profixter.com/account, a separate checkbox "Text me occasional
> ProFixter offers."; (2) existing customers who tell ProFixter staff, by phone
> or in writing, that they want offers by text are sent an email that links
> either to that account setting or to a confirmation page
> (https://www.profixter.com/texts/confirm) showing their phone number's last
> four digits and a "Yes, text me occasional ProFixter offers" button; texts
> start only after the customer presses it; (3) a customer's own written
> request (an email or text message from them, or a signed form) is recorded
> by staff together with that evidence. A spoken yes on a call is never by
> itself treated as consent. Every opt-in location and the confirmation email
> state the brand, that message frequency varies, that message and data rates
> may apply, and "Reply STOP to opt out or HELP for help", and link to the
> Privacy Policy (https://www.profixter.com/privacy), Terms of Service
> (https://www.profixter.com/terms) and SMS Terms
> (https://www.profixter.com/communication-consent). Each consent is stored
> with the wording shown, time, method, the staff member where one was
> involved, and the evidence. Account sign-up collects no SMS consent: a person
> may verify their own phone number with a one-time code they request, sent by
> Twilio Verify and not under this campaign. No purchased, rented or shared
> list. Screenshots: https://www.profixter.com/sms-consent-example.

Before submitting, make sure /sms-consent-example shows the current booking
checkbox and account settings (reviewers open it).
