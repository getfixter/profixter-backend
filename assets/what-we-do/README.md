# What We Do - illustrative before/after collection (2026-10-30)

Photorealistic **generated** example pairs (Meshy nano-banana-pro: the AFTER
generated first, the BEFORE edited from it so the scene is identical), reviewed
by hand. They illustrate kinds of jobs; they are not photographs of Profixter
customers' homes, and every record seeded from them is `illustrative: true`.

Seed or re-seed production (dry run unless --confirm; idempotent):

    MONGO_URI=... S3_BUCKET=... node scripts/ops/seed_what_we_do.js assets/what-we-do --backup backup.json --confirm

Restore the photos the seed unpublished:

    MONGO_URI=... node scripts/ops/seed_what_we_do.js --restore backup.json --confirm

## CX 4.1 corrections (2026-10-31)

The owner reviewed the pairs on a phone. Nine were corrected; every new image
was made from its partner image, so the scene, camera and geometry match:
bath-faucet, showerhead, door-handle, cabinet-door, bath-accessories (hook
removed), towel-bar (new scene), door-paint (new full-door scene),
cabinet-hardware (third pull restored), trim-repair (same trim profile).
The replaced files are kept in `retired-cx4/`. Power washing is now last.

    MONGO_URI=... S3_BUCKET=... node scripts/ops/seed_what_we_do.js assets/what-we-do --refresh <slugs> --backup refresh.json --confirm
    MONGO_URI=... node scripts/ops/seed_what_we_do.js --undo-refresh refresh.json --confirm
