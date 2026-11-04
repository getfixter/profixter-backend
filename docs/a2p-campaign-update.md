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

**SUPERSEDED 2026-11-03** by "Message flow to submit (2026-11-03)" at the end of
this file. Kept for history; do not submit it.

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

**SUPERSEDED 2026-11-03** by "Message flow to submit (2026-11-03)" at the end of
this file. Kept for history; do not submit it.

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

## Automatic service-text enrollment at phone verification (NOT enabled, 2026-11-03)

The owner asked whether service texts (booking confirmations, reminders,
arrival updates) could switch on automatically once a customer verifies a
mobile number. **They do not, and must not, until everything below is done.**
Every new account must now verify a phone (PhoneRequiredGate), so agreeing to
texts "by continuing" would make text consent a condition of having an
account. That is the pattern carriers rejected as error 30923 ("consent
required for service"), and it would also contradict what the public evidence
pages (/sms-consent-example, /communication-consent, /privacy, /terms) say.
Today, service texts are an optional, unticked "Text me about my visits" box at
booking (now in Book a Handyman too) and a switch in account settings, and
service email is on by default.

Before automatic enrollment could even be considered:

1. **Legal check (owner's counsel).** Confirm that, for informational texts, a
   number the customer provides and verifies for their visits, with a clear
   disclosure, counts as prior express consent for us, and that requiring the
   number for an account does not make the texts "a condition of purchase".
2. **Make it separable on screen.** The customer must be able to verify a
   phone *without* agreeing to texts. That means either a visible, optional
   choice on the phone step (e.g. "Also text me about my visits", unticked), or
   a disclosure plus a one-tap "No thanks" that is just as easy as continuing.
   A pre-ticked box is not consent.
3. **Re-register the message flow with Twilio** (Console only; a VERIFIED
   campaign cannot be edited by API - see "Order of operations" above). The
   new flow must describe the phone-verification screen exactly: where it
   appears (sign-up, sign-in, "Add your mobile number"), the exact wording, the
   opt-out on screen, that consent is optional and not required to create an
   account or book, and the STOP/HELP language. Attach a screenshot of each
   screen. Wait until Twilio shows the campaign VERIFIED with the new flow.
4. **Update every public statement to match**: /sms-consent-example (it says
   "Sign-up collects no SMS consent"), /communication-consent, /privacy and
   /terms, and the pinned checks in scripts/test_a2p_public_evidence.js.
5. **Record it as its own consent version** in utils/consent/consentText.js
   (word-for-word screen text), write a ConsentEvent for each enrollment, and
   never override a customer's own "off" or a STOP (smsEligibility already
   refuses both at send time).
6. **Only then** switch it on in code, behind a code default (EB environment
   variables are at AWS's 4096-character limit, so a new env flag cannot be
   added without removing others).

## Message flow to submit (2026-11-03)

**This supersedes both earlier drafts in this file** (the Registration 2.0
"New message flow" and the 2026-10-31 "Message flow to submit"). Neither was
ever submitted; campaign …ba0b still carries the 2026-09-11 Registration 1.0
flow. Both drafts are now wrong: the first says the only places are the
booking step and settings and "There is no keyword, verbal or paper opt-in";
the second still names the old booking label and leaves out the guest Free
Visit request and the staff-recorded yes for service texts. Submit the text
below instead.

### What changed since the registered 2026-09-11 flow

- Sign-up no longer collects any SMS consent (it had service and marketing
  boxes). Sign-in codes are sent by Twilio Verify, outside this campaign.
- Service texts: an optional, unchecked box at the booking step, "Text me
  about my ProFixter visits", with the SMS Terms, Privacy and Terms linked at
  the box (consent version `sms_service.booking.v2`).
- New: the guest Free Visit request (no account, no checkbox). Pressing
  "Request my Free Visit" under the full disclosure line is consent to texts
  about that one visit only.
- New: staff record a caller's Yes or No for texts about their visits, with
  nothing pre-selected; the record names the staff member and the time. It is
  never used for marketing.
- New (marketing, held until this flow is VERIFIED): the one-click page
  /texts/confirm, and a customer's own written permission recorded by staff
  with its evidence.
- Unchanged: account settings (two separate unchecked boxes); STOP stops
  everything; START only lifts a STOP and grants no consent; no purchased or
  shared lists.
- Account settings now also show the sending number and link the SMS Terms,
  Privacy Policy and Terms of Service under the two boxes.
- New (2026-11-03, later): the mobile-number screen (adding or changing the
  number on an account, also shown right after an email/Google/Apple
  sign-up) has one optional, unchecked box "Text me ProFixter offers, too."
  (`sms_marketing.phone_verify.v1`), recorded only after the code verifies
  the number; a number change also offers an unchecked visit-texts box
  (`sms_service.phone_change.v1`), because consent stays with the old number.
  The registered 2026-09-11 flow already describes an optional marketing box
  on the website sign-up form, so these qualify for marketing now
  (marketingSmsBasis source `phone_verification`); this flow describes the
  screen exactly so the registration matches the site word for word.

### Message flow (paste into the "Message flow" field; 1,986 characters, plain ASCII)

Twilio does not state a limit on this field in this file; it is kept under
2,000 characters.

> ProFixter (Premium Island Homes Inc.) collects SMS consent in six places. Texts are never required to book or buy. (1) Booking step (signed in): optional unchecked box "Text me about my ProFixter visits" above the final button, for visit updates. (2) Free Visit request at https://www.profixter.com/book/free (no account): no checkbox; the line under the "Request my Free Visit" button reads "By requesting a visit, you agree that ProFixter may call or text you about this visit. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out or HELP for help." Pressing it covers texts about that visit only. (3) Account settings at https://www.profixter.com/account: two separate unchecked boxes, "Text me about my ProFixter visits." and "Text me occasional ProFixter offers." (marketing). (4) Mobile-number screen, where a signed-in customer adds or changes their number (incl. right after an email, Google or Apple sign-up): optional unchecked box "Text me ProFixter offers, too." (marketing), saved only after the number is verified by code; on a number change also an unchecked "Text me about my ProFixter visits". (5) Phone call: staff must ask whether the caller agrees to texts about their visits and record Yes or No (nothing pre-selected), with staff name and time; never used for marketing. (6) Marketing, staff-assisted: a customer who asks for offers by text may get an email link to https://www.profixter.com/texts/confirm and texts start only after they press "Yes, text me occasional ProFixter offers"; a customer's own written request is recorded by staff with that evidence. Every web opt-in states brand, frequency, rates and STOP/HELP and links the SMS Terms (https://www.profixter.com/communication-consent) and Privacy Policy. The phone sign-up screen collects no SMS consent; one-time codes go via Twilio Verify, outside this campaign. START only lifts a STOP. No purchased or shared lists. Screenshots: https://www.profixter.com/sms-consent-example

### Campaign description (only if the console asks for it again)

Leave the registered description alone unless the edit form requires it. If
it does:

> ProFixter (Premium Island Homes Inc.), a Long Island home-services company, texts customers who opted in about their visits: request received, booking confirmations, appointment reminders, reschedules and cancellations, who is coming, and membership and billing notices. Customers who separately opted in to marketing also receive occasional offers about memberships and home services. Every marketing text ends "Reply STOP to opt out."

### Message samples (rendered from utils/sms/smsTemplates.js, 2026-11-03)

1. Free Visit request received (`FREE_VISIT_REQUEST_RECEIVED`, the current /book/free form):
   `Got it! We've reserved your Free Visit on Thursday, November 12 at 10:00 AM. A Profixter team member will confirm it shortly. Reply STOP to opt out.`
2. Booking request received, awaiting confirmation (`BOOKING_CONFIRMED`, status Pending):
   `ProFixter: we received your One-Time Visit request for Thu, Nov 12 at 10:00 AM. We'll text you once it's confirmed. Questions? Call 631-599-1363`
3. Confirmation (`FREE_VISIT_CONFIRMED`, a /book/free visit):
   `ProFixter: your Free Visit is confirmed for Thu, Nov 12 at 10:00 AM. We'll go over your to-do list together, at no charge. We will text you a reminder beforehand.`
4. Reminder (`BOOKING_REMINDER_24H`):
   `ProFixter reminder: your One-Time Visit is scheduled for Thu, Nov 12 at 10:00 AM. Need to make a change? Call 631-599-1363`
5. Marketing (`MEMBERSHIP_MARKETING`; the renderer appends the opt-out line):
   `ProFixter: Handyman labor and trip costs are included with membership. Get small home repairs done easily: profixter.com/membership Reply STOP to opt out.`

### Keywords and their replies (as configured in the Twilio console; utils/sms/twilioOptOutCopy.js)

- Opt-out keywords: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT. Reply:
  `ProFixter: You are unsubscribed and will get no more texts from us. Your service and offer text settings are now off. Reply START to unblock this number, then switch texts back on at profixter.com/account. Help: 631-599-1363`
- Help keywords: HELP, INFO. Reply:
  `ProFixter by Premium Island Homes Inc - Long Island home services. Msg frequency varies. Msg&data rates may apply. Help: 631-599-1363 or getfixter@gmail.com. Reply STOP to opt out. profixter.com/communication-consent`
- Opt-in keywords: START, YES, UNSTOP (Twilio's reserved set). They only lift
  a STOP; they grant no service or marketing consent. Reply:
  `ProFixter: This number can receive texts from us again. To choose which ProFixter texts you want, turn on service or offer texts in your account at profixter.com/account. Msg&data rates may apply. Reply STOP to opt out, HELP for help.`
- Anything else texted to 631-888-6340 gets at most one automated reply per
  number per day (`INBOUND_INFO_REPLY`): `ProFixter: This number is used only
  for automated notifications and is not monitored for replies. For
  assistance, call 631-599-1363. Reply STOP to opt out.`

### Order of operations (do not reverse)

1. Deploy the backend (consent version `sms_service.booking.v2`, the v2 guest
   line accepted by routes/freeVisitRequests.js), then the frontend (the
   booking box, the Free Visit line, the settings documents line, the Admin
   Yes/No question, /communication-consent, /sms-consent-example and the four
   `public/compliance/a2p-v3-*.png` screenshots).
2. Check the live site as a reviewer would: /sms-consent-example shows the
   four v3 screenshots and lists five places; /communication-consent shows
   "Last Updated: November 3, 2026"; /book/free shows the new line under the
   button. Client-rendered pages need a browser, not curl.
3. Only then submit in the Twilio Console (a VERIFIED campaign cannot be
   edited through the API): Messaging > Regulatory Compliance > Campaigns >
   open campaign …ba0b (Messaging Service …70d0) > Edit > replace the whole
   "Message flow" field with the text above > (description only if required)
   > Save / Submit for review. If the console shows the path differently,
   the campaign is the one under the "Profixter users" Messaging Service.
4. Ask Twilio support, from the Console, whether the campaign keeps sending
   during re-review, and track it until it shows VERIFIED with this flow.
5. Only after VERIFIED: switch on the held marketing methods
   (`SMS_ADMIN_ASSISTED_OPTIN_REGISTERED=true`). The EB environment is at its
   4096-character limit, so this needs room made or a code default.

### Reviewer notes (not for submission)

Every sentence above, against the code:

- Five places and their wording: FrontEnd
  app/components/booking/ServiceTextsOptIn.tsx (box, label, line, three
  links; shown only to a signed-in customer with a phone, saved only after
  the booking succeeds), rendered above the button in
  app/components/booking4/HandymanBooker.tsx, app/book/page.tsx,
  app/components/booking/FullDayVisitPanel.tsx and
  app/components/sections/BookingSection.tsx; BackEnd
  utils/consent/consentText.js (`sms_service.booking.v2`, CURRENT.booking).
- Guest line: FrontEnd app/components/booking4/FreeVisitForm.tsx
  (CONTACT_CONSENT_TEXT, no checkbox, links); BackEnd
  routes/freeVisitRequests.js (accepts the v2 line or the old v1 line and
  stores the one shown, with time, IP and browser); utils/sms/smsEligibility.js
  (FREE_VISIT_REQUEST_RECEIVED within an hour of the press, then
  GUEST_VISIT_TYPES for that booking only, never marketing, STOP still wins).
- Settings: FrontEnd app/components/account/SmsPreferences.tsx;
  `sms_service.settings.v1`, `sms_marketing.settings.v1`.
- Phone call: FrontEnd app/components/admin/tools/AdminSheet.tsx
  (SmsAgreedChoice, nothing pre-selected), CreateCustomerSheet.tsx (cannot
  submit with a phone until answered; marketing texts start off),
  CreateVisitSheet.tsx (guest visit cannot be submitted until answered);
  BackEnd utils/admin/communicationControls.js (source `admin_phone`,
  `sms_service.admin_phone.v1`, "recorded by <staff>", time) and
  utils/admin/adminVisits.js (guest visit record naming the staff member).
  For an existing customer, staff switch service texts on in the customer's
  Messages panel (app/components/admin/tools/CommunicationPanel.tsx); that
  panel is a switch, not a Yes/No question.
- Marketing never on a spoken yes: utils/consent/marketingSmsBasis.js
  (`admin_phone` is always `needs_confirmation`; `sms_confirm_link` and
  `admin_written` are `awaiting_registration` until the flag);
  utils/consent/smsConfirmLink.js (the email links to account settings until
  the flag is set; the page records consent only on the button press).
- START: routes/smsWebhook.js applyOptIn sets no consent flag.
- Inbound reply: routes/smsWebhook.js replyThatNobodyIsReading (one per number
  per New York day).
- Sign-up: app/(auth)/signup/page.tsx, `terms.continue.v1`, Twilio Verify.
- Samples are the code templates. Admin can override a template's wording in
  production (utils/communications/templateOverrides.js); check Admin >
  Communications before submitting that no override changes these five.
- Server default to know about: utils/admin/customerAccess.js
  DEFAULT_COMMUNICATION still defaults `service.sms` (and `marketing.sms`) to
  true when a create-customer request omits `communication`. The Admin screen
  always sends all four values, so this never applies from the UI, but a
  direct API call without them would record a phone yes nobody asked for.
- Pinned by scripts/test_a2p_public_evidence.js,
  scripts/test_sms_consent_mechanics.js, scripts/test_consent_system.js and
  scripts/test_free_visit_request.js.
