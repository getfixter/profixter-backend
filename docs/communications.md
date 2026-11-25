# Communications: operations guide

The shared text inbox, customer communication history, one-to-one and bulk SMS in
Profixter Admin (`/admin/communications`). Code: `utils/comms/*`,
`routes/adminComms.js`, `routes/commsPublic.js`, `jobs/comms.js`, models
`CommConversation`, `CommMessage`, `Comms.js`; frontend
`app/components/admin/comms/*`, `lib/admin/comms.ts`.

## 1. How texting is wired (inspected read-only on 2026-11-25)

| What | Value |
|---|---|
| Twilio account | One full account (`AC48…2955`), active |
| Texting number | **(631) 888-6340** (SMS, MMS, voice), created 2026-09-11 |
| Messaging Service | `MG0e…70d0`, sender pool = that one number, sticky sender on |
| Inbound texts | Messaging Service inbound URL → `https://api.profixter.com/api/sms/webhook/inbound` (Profixter) |
| Delivery callbacks | `https://api.profixter.com/api/sms/webhook/status` (service and per message) |
| Inbound calls | Number voice URL → `https://api.profixter.com/api/voice/webhook/inbound` (plays "this number doesn't accept calls, call 631-599-1363") |
| A2P 10DLC | Campaign **VERIFIED**, use case LOW_VOLUME (mixed), last updated 2026-09-11 |
| Phone verification | Separate **Twilio Verify** service (`VA79…`, own API key). Never read, never imported. |
| GoHighLevel | Location "Mr. Fixter"; its three 631 numbers live in GoHighLevel's own phone system, not in this Twilio account. ≥10,000 conversations, oldest activity 2026-03-13. Read-only token (conversations, messages, contacts). |
| 30-day traffic | 320 automated texts delivered, 2 inbound replies, 3 inbound calls, 0 recordings |

**Who owns replies today:** Profixter. The Messaging Service already sends every
inbound text to Profixter's webhook; nothing else consumes it. **No Twilio
routing change is needed.** Before this release the webhook stored only STOP /
START / HELP and auto-replied "this number isn't monitored" (once per number per
day) to everything else; the text of ordinary replies was discarded.

**Outbound:** every text (automated, manual, bulk) is sent through the Messaging
Service. Communications also passes `From` = the line the person chose; Twilio
uses a `From` that is in the service's sender pool, so the customer sees exactly
that number, and the service's opt-out handling and callbacks still apply.

## 2. What changes at deploy (and what does not)

Defaults reproduce today's behaviour exactly; nothing a customer sees changes
until the owner flips a switch in **Communications → Settings**:

| Setting (database, `comm_settings`) | Default | Effect |
|---|---|---|
| Manual texts | **off** | Inbox is read-only until on |
| Bulk texts | **off** | Bulk sends can be prepared/previewed; nothing goes out |
| "Not monitored" auto-reply | **on** | Same auto-reply as today. Switch **off** once someone answers the inbox (the reply becomes untrue) |
| Keep GoHighLevel flowing | **off** | GHL history only updates when an import is run |

Changes that take effect at deploy (no customer-visible effect):
- Inbound texts are **stored** (body, pictures copied to private S3) and shown in
  the inbox; replays of the same `MessageSid` are no-ops.
- Inbound calls to the Twilio number are logged (metadata only).
- Every automated text the existing pipeline records (`SmsMessage`) is mirrored
  into the customer's thread (including held-back ones, labelled "Not sent").
  How automations decide and send is unchanged.
- Delivery callbacks also update Communications.
- New permissions `comms.read`, `comms.send`, `comms.bulk` on two new Team
  sections ("Conversations", "Bulk texts"). Nobody but the owner has them until
  granted. Field Fixters and Telemarketers never do.
- Phone bottom bar: Jobs · **Messages** · Customers · Schedule · More (Projects
  moved to More).

No existing collection is migrated. New collections and indexes are created by
Mongoose at boot (`commconversations`, `commmessages` (with a text index),
`commbulksends`, `commbulkrecipients`, `comm_settings`, `commsavedreplies`,
`commimportruns`, `commpendingstatuses` (TTL 1 day), `commhealthevents`
(TTL 14 days), `commmediauploads`). All start empty; safe with the live app.

## 3. Consent rules (server-enforced, reused from `utils/sms/smsEligibility.js`)

- **STOP** (SmsOptOut, also learned from Twilio error 21610) blocks everything.
  Carrier-refused numbers are not texted.
- **Service** messages: the customer's own service-text opt-in, **or** a
  conversation the customer started (they texted us in the last 30 days;
  one-to-one only, never for bulk). Outside 8am-9pm New York the sender must
  tick a confirmation.
- **Promotions**: only the marketing consent that qualifies under
  `marketingSmsBasis` (never inferred from an account, booking, membership or a
  service text), the marketing switch, the launch date, 11am-6pm; "Reply STOP
  to opt out." is appended.
- Bulk: blocked customers, duplicates, no phone, STOP and missing consent are
  excluded with their reasons; everyone is re-checked just before their text.

## 4. Sources of history and how far back

| Source | How it arrives | Earliest available |
|---|---|---|
| Profixter automated texts (`SmsMessage`) | Live mirror + import "Profixter automated texts" | Start of Profixter SMS (Sept 2026) |
| Twilio message log | Import "Twilio message history" (recovers the replies that were never stored) | Twilio keeps message logs; this account's number exists since 2026-09-11 |
| Twilio calls | Live (voice webhook) + import "Twilio call history" | 2026-09-11 (no recordings exist) |
| Profixter emails (`EmailLog`) | Read live into the customer timeline | Start of the email log |
| Bookings | Read live into the timeline | All bookings |
| GoHighLevel texts, calls, emails, chats | Import "GoHighLevel conversations" (read-only), optional 10-minute sync | Oldest GHL activity 2026-03-13; message bodies when GHL provides them; call recordings stay in GHL (labelled) |
| Calls to 631-599-1363 | **Not integrated** unless that number is one of GoHighLevel's (then via the GHL import). Needs the owner to confirm where that line lives. |
| Inbound customer email | Not available (Profixter has no inbound email store); GHL emails come through the GHL import |

Imports are paginated and resumable (checkpoint after every page), dedupe by
provider id (re-runs only count duplicates), never send or change anything in
the source, and never import Verify (sign-in) messages. GHL contacts that match
no single customer are kept under **Unknown numbers** and stay out of the
everyday inbox until linked.

## 5. Release procedure (needs the owner's approval)

1. **Pre-flight:** note rollback versions (EB label, Vercel deployment).
2. **Backend:** push the reviewed commit to `main` (CI runs the full suite on
   MongoDB 8.2.6 and deploys). Verify EB `VersionLabel` and `/` 200;
   `GET /api/admin/comms/bootstrap` without a token → 401;
   `GET /api/comms/media/<id>?exp=0&sig=x` → 404. EB health is not a signal.
3. **Frontend:** push to `main`; check the Vercel status via the GitHub API.
4. **Owner, in Admin → Communications → Settings:**
   1. *Check with Twilio* (read-only): confirms (631) 888-6340 and the A2P status.
   2. Start imports in this order: Profixter automated texts → Twilio message
      history → Twilio call history. (GoHighLevel: optional; ≥10,000
      conversations, mostly cold prospects; runs in the background.)
   3. Do the **live round trip** below with manual texts on.
   4. Switch the "not monitored" auto-reply **off** when someone will watch the
      inbox.
   5. Turn bulk texts on only when needed.
5. **No webhook cutover**: Twilio already posts to Profixter. Do **not** change
   the Messaging Service or number URLs.

### Live round-trip test (owner's own phone; no customer is texted)

1. The owner's customer-side account (or a test customer account) must carry the
   owner's mobile number with **service texts on**.
2. Settings → Manual texts **on**.
3. Inbox → New → find that account → its number → type a test → Send. Expect
   "Accepted by Twilio", then "Delivered" within a minute.
4. Reply from the phone: the reply appears in the same thread within ~5 s,
   unread, without refreshing.
5. Optional MMS: attach a photo; confirm it arrives.
6. Optional bulk: New bulk text → Specific customers → that one account →
   Preview (1 recipient) → Send now; check the result turns Delivered.
7. Do **not** reply STOP from the owner's phone unless you intend to opt it
   out (START undoes the carrier block; texting preferences are unchanged).

## 6. Monitoring

- Settings → **Health**: last inbound text, failures today, sends being checked
  with Twilio, stuck bulk sends, stalled imports, and 24 h counts of webhook
  rejections, inbound/storage failures, reconcile errors, mirror failures.
- Logs (CloudWatch / EB): `comms_health_alert` (error level) every 10 minutes
  while a bulk send is stuck > 15 min, an import heartbeat is > 20 min old, or
  > 5 sends are unresolved; `comms_job_error`, `sms_webhook_rejected`,
  `comms_inbound_record_failed`, `comms_sms_send_failed`. Message text and full
  numbers are never logged.

## 7. Rollback

- **Instant, no deploy:** Settings → manual and bulk texts **off** (sending
  stops), auto-reply **on** (restores today's reply). Cancel any scheduled bulk
  send (texts already handed to Twilio may still be delivered).
- **Code:** redeploy the previous EB label and Vercel deployment. The webhooks
  then return to storing nothing; new collections stay and are inert. No data
  migration to undo.

## 8. Ambiguity and safety guarantees (tested in `scripts/test_comms.js`)

- One text per Send press: the idempotency key is inserted before Twilio is
  called; replays return the same message.
- A Twilio request that times out is **unknown**, never resent; the reconcile
  job adopts Twilio's record or, after 15 minutes with none, marks it failed so
  an explicit retry is offered. One retry per failure.
- Status callbacks only move forward; a callback that beats the send is parked
  and applied when the SID is saved.
- Webhooks: Twilio signature on the configured public URL; replays are no-ops.
- A shared number is never attached to a customer until someone chooses; a
  recycled number becomes ambiguous; messages keep the customer they belonged
  to when sent; relinking moves history only when asked.
- Bulk: audience frozen at preview; confirm must quote the count; worker never
  exceeds it; overlapping workers and crashed workers do not duplicate.
- Media: private S3; Twilio fetches outbound pictures through a 2-hour HMAC URL;
  Admin views pictures only through a permission-checked endpoint.
