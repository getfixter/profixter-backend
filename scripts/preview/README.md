# Local Admin preview stack

A fully local copy of the Profixter backend for looking at and clicking through the
Admin redesign: the **real Express app** (`server.js`, every route it mounts) on
`http://localhost:5055`, a local MongoDB kept on disk, invented seed data, and every
external effect made impossible.

Nothing here is for production. It never reads a real credential and cannot reach the
network.

## Start

From the `BackEnd` worktree:

```
node scripts/preview/start.js            # start; seeds on the first run
node scripts/preview/start.js --reset    # wipe the data folder and reseed
```

Options:

| Option | Default | Meaning |
|---|---|---|
| `--port` | `5055` | API port, bound to `127.0.0.1` and `::1` only |
| `--mongo-port` | `27555` | Local MongoDB port. If it is busy, another port is used and the replica set is re-pointed. |
| `--data <dir>` | `..\preview-data` (that is, `C:\Users\Taras\profixter-admin\preview-data`) | MongoDB files (`db\`) and the fake S3 store (`s3\`) |
| `--frontend <url>` | `http://localhost:3105` | Used for links in emails and for CORS |

**Backend and frontend together:** from `C:\Users\Taras\profixter-admin`, run
`preview.cmd` or `.\preview.ps1`. It accepts `-Reset`, `-BackendOnly` and `-FrontendOnly`.
- The API opens in its own window.
- The frontend runs `npx next dev -p 3105` in `FrontEnd`, with `NEXT_PUBLIC_API_URL=http://localhost:5055` and `TURBOPACK_ROOT` set (the frontend's `node_modules` is a junction).
- Then open `http://localhost:3105/admin`.

**Stop** with Ctrl+C in the API window. MongoDB stops with it.

The data persists between restarts. Its dates were placed relative to the day it was
seeded, and they do not move. Use `--reset` for a fresh two-week window around today.

## Accounts (all invented)

| Role | Email | Password |
|---|---|---|
| Owner (admin) | `owner@preview.test` | `preview-owner-1` |
| General Fixter | `general@preview.test` | `preview-general-1` |
| Fixter (field; sees only own jobs) | `fixter1@preview.test` | `preview-fixter-1` |
| Fixter (field) | `fixter2@preview.test` | `preview-fixter-2` |
| Customer (Test Customer 01, Plus member) | `customer01@example.test` | `preview-customer-1` |

## Preview-only URLs

- `GET /__preview/outbox` lists every email and text the app "sent". It is HTML in a browser, JSON otherwise (`?format=json`). `/__preview/outbox/:id` renders one email.
- `GET /__preview/status` shows the seed counts, project ids, the schedulers that were not started, and every blocked outbound attempt.
- `GET /preview-s3/<key>` (and `/uploads/*`) serves files from the local S3 store: booking photos, recent-work images, agreement PDFs.
- `/__preview/checkout/:id`, `/__preview/portal/:id` and `/__preview/invoice/:id` are where fake Stripe Checkout, billing-portal and hosted-invoice links land. They say that nothing can be paid.

## The seed

The seed is deterministic: fixed ids, names and amounts. Only the dates are relative to
seeding, so the windows still show work.

**People**
- Staff: the owner, one General Fixter, and Fixter One (the default Fixter) and Fixter Two.
- 40 customers, "Test Customer 01" to "40":
  - phones `(516) 555-0101` to `0140`; emails `customerNN@example.test`;
  - fake streets ("Oak Demo St", "Harbor Demo Blvd", and so on) in Long Island towns;
  - five have two homes, and five have an apartment or unit.

**Memberships.** `Subscription` records with matching fake-Stripe subscriptions, invoices and charges:

| Customers | State |
|---|---|
| 1 to 10 | Active. Customer 5 is Elite; customers 8 and 9 are annual; customer 3 also has a Basic plan on a second home. |
| 11 to 12 | Trialing |
| 13 to 15 | Past due (an open invoice with 3 attempts) |
| 16 to 18 | Ending: 16 at period end, 17 and 18 on a date |
| 19 to 21 | Ended |
| 22 | Complimentary (owner grant, no Stripe) |
| 23 to 40 | No membership |

Loyalty: paid months are counted for monthly members, and customer 6 has one milestone grant.

**Bookings.** 60 bookings from 14 days ago to 14 days ahead, in New York time. Future ones go through the real reservation engine. They cover:
- completed jobs (some with tips) and canceled jobs;
- Pending member requests;
- two Pending Confirmation free visits: a callback request linked to its lead, and an online one flagged as a repeat;
- Confirmed jobs, assigned and unassigned;
- one-time visits: paid, awaiting payment, and failed payment;
- an Elite Full Day;
- admin free visits;
- one job that is "not closed" (Confirmed, more than 2 hours past its start);
- one job with a reservation issue;
- notes, internal staff notes, and photos.

**Leads**
- Requests: a free-visit callback linked to its booking, a callback request, a general-contractor request, a home-improvement request and a membership question.
- Estimate leads, with full answers: bathroom, kitchen and roofing.

**Projects**

| Project | State |
|---|---|
| `PRJ-2026-00001` | Converted from the roofing lead through the real conversion. Its id is not fixed. |
| `d00000000000000000000002` | Agreement emailed and awaiting signature. Signing link: `/sign/preview-sign-pv1002`. |
| `d00000000000000000000003` | Signed; no deposit invoice yet. |
| `d00000000000000000000004` | In progress: an executed change order, another awaiting signature, the deposit paid, and a milestone partly paid. |
| `d00000000000000000000005` | Substantially complete: punch list open, final invoice overdue. |

The agreement, change-order and certificate PDFs are placeholder PDFs marked "PREVIEW".

**Everything else**
- Blacklist: one active block (customer 38) and one lifted block (customer 39).
- Consent events, including one STOP (customer 7) and one email unsubscribe (customer 2).
- Email and SMS history.
- Activity-log entries.
- Six recent-work photos: published, pending review, and library.
- An enabled homepage promotion popup.
- Email templates are left at their code defaults.

## What is faked (installed before `server.js` is loaded; see `fakes.js`)

| Real | In the preview |
|---|---|
| Stripe (every `require("stripe")`) | `fakeStripe.js`: a stateful fake built from the preview DB. Billing, invoices, charges and plan-change previews are realistic; a confirmed upgrade "charges" a simulated proration. Checkout and the portal return `localhost` pages. **Refunds and webhooks are refused.** |
| Email (SES over SMTP via nodemailer) | A transport that writes to the outbox and prints `[preview outbox]`. `EmailLog` rows are still written by the app. |
| SMS (Twilio) | `twilioProvider.sendMessage` writes to the outbox. `SMS_ENABLED=true` with obviously fake credentials, so the app's normal rules apply (consent, quiet hours: at night texts are `skipped: outside_send_window`). |
| S3 | `utils/s3` reads and writes `preview-data\s3`, and URLs point at `/preview-s3/...`. The event-display kiosk only shows real S3 photo URLs, so it is empty here. |
| AWS SDK (SES suppression sync, SSM, raw S3) | Every client's `send()` refuses. Parameter Store is never loaded (`PARAMETER_STORE_DISABLED=true`, and the loader is replaced). |
| Anthropic | A canned "[preview] AI is disabled" answer. No key is set, so the agents stay inert anyway. |
| GoHighLevel, Meta CAPI and ad sync, IndexNow, Google Places/Maps, OpenAI | No credentials, and the network guard blocks them anyway. |
| `dotenv` | A no-op, so a stray `.env` can never add real credentials behind the guard. |

**Schedulers not started:**
- booking reminders and review requests;
- marketing and SMS sweeps;
- gift, membership and loyalty notices;
- the growth engine, agents and visibility collectors;
- the GHL outreach sync and the recent-work publisher;
- signature expiry;
- the Stripe revenue ledger and Meta syncs;
- the growth self-check and e-sign provisioning.

**Kept**, because they are local only:
- the template-override refresh (database);
- the campaign sender (its mail goes to the outbox, so a campaign queued in Admin shows its progress);
- `server.js`'s database-only nightly auto-cancel.

## Safety guards (`safety.js`)

1. **Refuse a live-looking environment.** `start.js` exits with code 2 before it starts
   MongoDB or loads any app code if the environment has any of the following:
   - a `mongodb+srv://` URI, or a `mongodb://` URI with a non-loopback host, in any variable;
   - an `sk_live_` or `rk_live_` value anywhere;
   - any `TWILIO_*`, `AWS_SES_SMTP_USER`/`PASS`, `ANTHROPIC_*`, `GHL_*`, `OPENAI_*`, `META_CAPI_TOKEN`, `META_ADS_ACCESS_TOKEN`, `FB_ACCESS_TOKEN`, `GSC_*_JSON`, `DATAFORSEO_*`, Adobe Sign secret, `GOOGLE_PLACES_API_KEY` / `GOOGLE_MAPS_API_KEY`, `INDEXNOW_KEY`, SendGrid or Mailgun variable.

   Only variable **names** are printed, never values. Generic AWS credentials
   (`AWS_ACCESS_KEY_ID`, `AWS_PROFILE` and similar) are removed from the process rather
   than refused, and `AWS_EC2_METADATA_DISABLED=true` is set.
2. **Fixed fake configuration.** After the check, the preview sets its own values:
   - `NODE_ENV=development`;
   - preview-only JWT and token secrets;
   - `sk_test_preview_fake…`;
   - fake Twilio values;
   - `MAIL_ADMIN=owner@preview.test`;
   - links pointing at `localhost:3105`;
   - the reservation engine on.
3. **No outbound network.** `net.Socket#connect` (which covers TCP, TLS, SMTP, the HTTP
   agents, undici and node-fetch), `dns.lookup` and the global `fetch` refuse every host
   that is not loopback. Each attempt is logged as `[preview blocked] outbound … to host:port`
   and listed under `/__preview/status`. This holds even if a fake were missed.
4. **The seed refuses** to run unless mongoose is connected to `127.0.0.1` or `localhost`.

`node scripts/preview/test_preview_safety.js` checks all of the above: 34 assertions, no
database, no network. It is registered in `scripts/run_ci_tests.js`.

## Notes

- `next dev` may rewrite `FrontEnd/next-env.d.ts`. If git shows it changed, restore it.
- In dev, public pages (sign-in, home) still load GTM and the Meta Pixel in the browser. The admin pages do not, after the foundation work. The browser is not covered by the backend's network guard.
- Only one `next dev` can run per worktree.
