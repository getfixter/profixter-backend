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
