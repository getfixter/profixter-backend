# Shower Studio - production readiness and launch procedure

Status (2026-10-12): ready to deploy **dark** after owner approval. Branch
`shower-studio` in BackEnd and FrontEnd, merged with the current `origin/main`
locally (BackEnd a8d956a+, FrontEnd 6eeb1e8+), all tests passing. Nothing
deployed or pushed.

## 1. Security audit

### Production S3 (read-only inspection of `profixter-uploads-prod`, 2026-10-12)

| Check | Finding |
|---|---|
| Bucket policy | Public `GetObject` only on `uploads/*` (minus PDFs/CSV/XLSX/DOCX and two folders) and on `recent-work/*/{thumb,display,full}.jpg`. **Nothing grants access to `private/*`.** No public `ListBucket`. |
| Object ACLs | Disabled (`BucketOwnerEnforced`) - no object can be made public by an ACL. |
| Access points | None. |
| Public-access block | All four settings **off** (needed today because `uploads/` is public by policy). |
| Server write access | Instance role `Profixter-EC2-S3Access` has `AmazonS3FullAccess` - Studio writes to `private/studio/` will work. |

**Conclusion:** Studio photos (`private/studio/photos/...`, `private/studio/previews/...`)
and catalog images (`private/studio/catalog/...`) are not publicly readable; the
only way to read them is through the backend (signed 15-minute links for photos,
unguessable ids for catalog images). No production setting needs to change for the Studio.

Not changed, recommended (owner decisions, not blockers):
- The instance role has S3 **full** access to every bucket in the account; a
  policy limited to `profixter-uploads-prod` would be safer.
- The AWS credentials on the development laptop are **root account keys**.
  AWS recommends deleting root access keys and using an IAM user/role with only
  the needed permissions.

### Application

| Area | Status |
|---|---|
| Upload | Public photo upload needs the design's edit token; 20 MB, real images only (decoded and re-encoded), EXIF/GPS removed, 100 MP cap, 30/hour per IP. Staff upload needs `studio.sell`. |
| Download | Customer photos only by HMAC-signed 15-minute links (tested: unsigned, tampered, extended or expired links are refused); no listing anywhere. |
| Public submissions | 10/hour per IP, 5/day per email, honeypot, 8-second minimum, idempotent re-send, server-side validation and compatibility check. |
| Rate-limit IP | **Fixed during this audit**: the IP is now taken from the right of `X-Forwarded-For` (the address our load balancer adds), so a forged header no longer bypasses limits. Test: `test_studio_client_ip.js` (in CI). |
| Catalog / prices | Writes need `studio.catalog`; price overrides/discounts `studio.priceAdjust` (employee discounts capped); proposals also `projects.manage`. Tested for owner, each employee type, customers and anonymous. |
| Data exposure | Public catalog and quotes contain no prices except the total, no internal notes, no missing-price details (tested). A visitor sees only their own design. Staff lists never show a visitor's unsent draft. |
| Note | Production is load-balanced (up to 4 servers). Rate limits and the 30-second public-catalog cache are per server: effective limits are up to 4x the numbers above; a catalog edit can take up to 30 s to appear everywhere. The nightly retention job runs on each server (safe to repeat). |

## 2. What the launch changes in existing Profixter

BackEnd (49 lines in 5 existing files): `server.js` (Studio routes mounted
before the global body parser, `x-studio-token` CORS header, nightly retention
job), `utils/adminAccess.js` (3 new sections, off for every employee),
`models/EstimateLead.js` (optional `studioDesignId`), `scripts/run_ci_tests.js`,
`.gitignore`. FrontEnd (6 existing files): Admin tab list and permission keys,
Leads row button (only on Studio leads), desktop-scale CSS (generated).
Everything else is new files. Existing tests: 84/84 backend CI suites, Admin
access UI 48/48, desktop scale 26/26.

## 3. Database

No migrations. New collections (`studioproducts`, `studioassets`,
`studiopricings`, `studiodesigns`, `studiophotos`) are created on first write;
the price list document is created on first use. Existing documents are not
modified. `estimateleads` gets one new optional field and an index
(`studioDesignId`), built automatically at startup (small collection).

## 4. Settings (environment / SSM `/profixter/prod`)

| Name | Needed? | Value |
|---|---|---|
| `S3_BUCKET` | existing | unchanged |
| `JWT_SECRET` | existing | unchanged (photo links are signed with a key derived from it if the next one is absent) |
| `STUDIO_LINK_SECRET` | **recommended** | a new random secret (32+ characters) dedicated to photo links |
| `STUDIO_STORAGE` | no | leave unset (S3 when `S3_BUCKET` is set) |
| `STUDIO_S3_PREFIX` | no | default `private/studio` (must stay under `private/`) |
| `STUDIO_LINK_TTL_SECONDS` | no | default 900 |
| `STUDIO_DRAFT_RETENTION_DAYS` / `STUDIO_SUBMITTED_RETENTION_DAYS` | no | defaults 30 / 730 (owner decision) |
| `PUBLIC_API_BASE_URL` | no | if set, catalog image links are absolute; otherwise relative (works) |
| Frontend `NEXT_PUBLIC_API_URL` | existing | unchanged |

## 5. Deployment procedure (after owner approval)

1. Re-merge `origin/main` into `shower-studio` (both repos) and run:
   `npm test`, `node scripts/test_studio_backend.js`,
   `node scripts/test_studio_proposal_signing.js`, `node scripts/test_studio_e2e.js`.
2. Open pull requests `shower-studio -> main` (BackEnd, FrontEnd); review.
3. Add `STUDIO_LINK_SECRET` to the production settings.
4. Merge BackEnd first (GitHub Actions runs CI, then deploys to EB
   `Handyman-v2-env`), then FrontEnd (Vercel).
5. The launch is **dark**: no product is published, so `/shower-studio` shows
   "coming soon" (it is also `noindex` and not linked); the new Admin sections
   are visible to the owner only.
6. Smoke test in production (owner): `GET https://api.profixter.com/api/studio/catalog`
   returns an empty catalog; Admin -> Studio Catalog -> Import starter products
   (drafts, unpriced); set prices; publish a few; make a test design with your
   own test email; check the lead arrives; delete it.
7. Going public (separate approval): link it in the navigation, add it to the
   sitemap, remove `noindex` in `app/shower-studio/layout.tsx`.

## 6. Rollback

- BackEnd: redeploy the previous EB application version (EB console ->
  Application versions -> Deploy), or revert the merge commit on `main`.
- FrontEnd: Vercel -> Deployments -> promote the previous deployment.
- Data left behind is harmless to the old code: Studio collections are ignored,
  Studio leads are ordinary leads. Private Studio files stay private.

## 7. Owner approvals required

1. Approve deployment (and who merges the pull requests).
2. Real selling prices and which products to publish (`STUDIO_CATALOG_CHECKLIST.md`).
3. Product photos/textures you are licensed to use.
4. Retention periods (30 days unsent / 2 years sent) and the privacy-policy wording for Studio photos.
5. Which employees get Shower Studio, price adjustments, catalog & prices.
6. Who receives Studio lead emails (today `MAIL_ADMIN` + `LEADS_EMAIL`).
7. Going public (navigation, sitemap, indexing).
8. Optional hardening: least-privilege S3 role; remove root access keys from the laptop.
