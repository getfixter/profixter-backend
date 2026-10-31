# What We Do - illustrative before/after collection (2026-10-30)

Photorealistic **generated** example pairs (Meshy nano-banana-pro: the AFTER
generated first, the BEFORE edited from it so the scene is identical), reviewed
by hand. They illustrate kinds of jobs; they are not photographs of Profixter
customers' homes, and every record seeded from them is `illustrative: true`.

Seed or re-seed production (dry run unless --confirm; idempotent):

    MONGO_URI=... S3_BUCKET=... node scripts/ops/seed_what_we_do.js assets/what-we-do --backup backup.json --confirm

Restore the photos the seed unpublished:

    MONGO_URI=... node scripts/ops/seed_what_we_do.js --restore backup.json --confirm
