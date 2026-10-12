# Acrylic Shower Studio - Milestone 2 (development build)

Branch `shower-studio` in both repositories (BackEnd and FrontEnd), built from
`origin/main` at 0ce1e8c / 03bcf0c. **Not deployed. Not pushed.**

## What it is

One design engine (the Milestone 1b prototype, unchanged in substance), three experiences:

| Experience | Where | Who |
|---|---|---|
| Public Shower Studio | `/shower-studio` (noindex, not in nav/sitemap until launch) | anyone, no account |
| Employee Sales Studio | Admin -> **Shower Studio** tab | permission `studio.sell` |
| Catalog Manager & prices | Admin -> **Studio Catalog** tab | permission `studio.catalog` (owner by default) |

Price overrides and discounts need `studio.priceAdjust`; creating a proposal also
needs `projects.manage`. All three are new owner-grantable sections in the
Employees editor ("Shower Studio", "Shower Studio price adjustments",
"Shower Studio catalog & prices"); no existing employee has them until the owner turns them on.

## Flow

1. **Owner** manages products (Admin -> Studio Catalog): identity, specs with
   VERIFIED/ESTIMATE status and sources, visualization/compatibility fields
   (form generated from `utils/studio/catalogFields.js`), photos, wall textures
   (tiled at their real size), publish/unpublish/archive, order, featured;
   and the Studio price list: base price per project type, product prices and
   install adders, automatic/manual adders, packages, employee discount cap,
   customer price note. "Import starter products" adds the 30 researched
   Milestone 1b products as **unpriced drafts**.
2. **Homeowner** (phone-first): Start -> photo -> the alcove is found
   automatically (dots, snapping, magnifier, tap-4 fallback, tap-to-remove) ->
   measurements -> shower/tub -> customize -> before/after + estimated total ->
   request installation. The design auto-saves to the server under an edit
   token kept only in that browser; the visitor can delete it.
3. **Submission** validates contact details, re-checks compatibility on the
   server, freezes the price and product selections, creates an `EstimateLead`
   (Admin -> Leads, source `/shower-studio`, "Open in Shower Studio") and
   emails staff through the existing lead notifier. **No booking is created.**
4. **Salesperson** opens the design, verifies measurements on site, edits
   products, adds adders / (with permission) discounts or a set total, saves
   revisions, then **Create proposal** -> a Bathroom Project + Estimate whose
   line items reproduce the frozen price to the cent.
5. **Contract and signature** use the existing Projects workflow unchanged:
   contract draft from that estimate -> PDF -> native e-signature -> the
   customer signs at `/sign/<token>`.

## Pricing rules (`utils/studio/pricing.js`)

Total = project base + products (+ their install adders) + automatic adders
(paint above, door, per grab bar/seat/shelf) + manual adders - discounts;
an override sets the total; a package replaces the prices of the products it
contains. **If any needed price is not set, there is no total**: the public
sees "We'll confirm your price", staff see what is missing. Public users only
ever receive the total; item prices, internal notes and missing-price details
stay on the server. Quoted prices are snapshots: later catalog edits never
change a submitted request or a proposal.

## Private photo storage

- Customer photos are sanitized (real image check, EXIF/GPS stripped, rotated,
  1600 px JPEG) and stored under `private/studio/` (S3 via the existing
  `putPrivateObject`, the same private area as contracts) with random keys.
  The public `uploads/` prefix used by booking photos is never used.
- Read access: 15-minute HMAC-signed links (`utils/studio/signedLinks.js`)
  that cannot be extended or moved to another photo; no listing endpoint.
- Retention (nightly): unsent public drafts deleted after 30 days; sent
  requests keep photos 2 years, then the photos are erased and the request
  record stays. Staff can erase a design's photos at any time.
- **Booking-photo storage was not changed.**

## Security controls

Rate limits on every public route; body limits (Studio routers are mounted
before the global 500 MB parser); upload type/size/pixel validation; edit
tokens stored as hashes and compared in constant time; server-side state
validation (`utils/studio/designState.js`); honeypot + minimum time + per-email
daily cap + idempotent submit; catalog/pricing writes require `studio.catalog`;
prices computed server-side only; AI budget guards from Milestone 1b remain
(no AI provider is connected).

## Run it (isolated - test data only)

```
cd BackEnd
node scripts/studio_demo_env.js      # in-memory DB, test staff/customer/catalog, local storage,
                                     # SMTP catcher, local S3 stub; prints logins (tokens)
node scripts/test_studio_backend.js            # 23 API tests (in-memory)
node scripts/test_studio_proposal_signing.js   # 6: design -> proposal -> contract -> signature
node scripts/test_studio_e2e.js                # 17: the full Definition of Done in a browser
node scripts/test_studio_engine_sync.js        # shared rules identical in BackEnd and FrontEnd
npm test                                       # existing CI suites (82) + the sync test
```

The demo stack never touches production: no `.env`, in-memory MongoDB, every
AWS SDK call goes to a local S3 stub with dummy credentials (this machine's own
AWS credentials are deliberately hidden from it), email goes to a local catcher.

## Limitations

- Previews are illustrative (drawn patterns and colours unless the owner
  uploads verified textures); geometry is a rectangular alcove from one photo.
- Auto-find is a suggestion; one real test photo plus synthetic scenes.
- A Studio design does not move to "signed" automatically when its contract is
  signed (the contract/project shows that); the design stays "proposal".
- The contract's deposit and payment schedule are entered in Projects as today.
- Rendering uses WebGL; very old phones fall back to "call us".
- Saved public designs live 30 days unless sent.
- Estimates have no tax line (as existing estimates).

## Needs the owner before launch

1. Review on staging and approve deployment (nothing is deployed).
2. Real prices and which starter products to publish (all are unpriced drafts).
3. Product photos/textures you are licensed to use (none uploaded).
4. Confirm the private S3 prefix: `private/studio/` must stay outside the
   bucket's public-read policy (the code never writes elsewhere; the policy
   itself could not be inspected from here).
5. Retention periods (30 days drafts / 2 years requests) and the customer
   privacy wording; add Studio to the privacy policy.
6. Who gets the new permissions; who receives Studio lead emails (MAIL_ADMIN + LEADS_EMAIL today).
7. Launch: remove `noindex`, add to navigation/sitemap, ads/analytics events.
8. AI enhancement: provider, key and budget (still mock-only; no paid calls made).
