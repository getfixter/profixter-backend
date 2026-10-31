/*
 * What We Do (Customer Experience 4.0, 2026-10-30): publish the illustrative
 * before/after collection, and take the old single photos off the public site.
 *
 *   MONGO_URI=... S3_BUCKET=... node scripts/ops/seed_what_we_do.js <imagesDir> [--backup file.json] [--confirm]
 *   MONGO_URI=... node scripts/ops/seed_what_we_do.js --restore file.json [--confirm]
 *
 * <imagesDir> holds manifest.json and <slug>-before.webp / <slug>-after.webp.
 *
 * Safe by construction:
 *  - dry run unless --confirm;
 *  - each pair is created once (internalNote "cx4-seed:<slug>"); a re-run skips it;
 *  - old photos are UNPUBLISHED to the Admin library, never deleted. Their ids,
 *    previous status and dates are written to the backup file first, and
 *    --restore puts exactly those back as they were.
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

/* The gallery chip (manifest) -> the service slug a photo links to. Minor fixes never link to remodeling pages. */
const CATEGORY_FOR_SLUG = {
  outlet: "light-fixture-installation",
  "light-fixture": "light-fixture-installation",
  "tub-caulk": "caulking",
  "kitchen-sink-caulk": "caulking",
  "drywall-patch": "drywall-repair",
  "wall-touchup": "drywall-repair",
  "door-paint": "door-repair",
  "door-handle": "door-repair",
};

async function seed(dir) {
  const service = require("../../utils/recentWork/workPhotoService");
  const WorkPhoto = require("../../models/WorkPhoto");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  for (const item of manifest) {
    for (const side of ["before", "after"]) {
      if (!fs.existsSync(path.join(dir, `${item.slug}-${side}.webp`))) throw new Error(`missing ${item.slug}-${side}.webp`);
    }
  }

  const toArchive = await WorkPhoto.find({ status: "published", kind: { $ne: "before_after" } })
    .select("_id title status publishedAt firstPublishedAt featured")
    .lean();
  const existingSeeds = await WorkPhoto.find({ internalNote: /^cx4-seed:/ }).select("internalNote").lean();
  const seeded = new Set(existingSeeds.map((p) => p.internalNote.replace("cx4-seed:", "")));
  const pending = manifest.filter((item) => !seeded.has(item.slug));

  console.log(`pairs in manifest: ${manifest.length}; already seeded: ${seeded.size}; to create: ${pending.length}`);
  console.log(`old published photos to move to the Admin library: ${toArchive.length}`);
  if (!CONFIRM) {
    console.log("DRY RUN. Re-run with --confirm (and --backup file.json) to write.");
    return;
  }

  const backupPath = valueOf("--backup");
  if (toArchive.length) {
    if (!backupPath) throw new Error("--backup file.json is required when photos will be unpublished");
    fs.writeFileSync(backupPath, JSON.stringify({ at: new Date().toISOString(), photos: toArchive }, null, 2));
    console.log(`backup written: ${backupPath}`);
  }

  const actor = { userId: null, name: "Profixter (illustrative examples)" };
  for (const [index, item] of manifest.entries()) {
    if (seeded.has(item.slug)) continue;
    const photo = await service.createPairFromBuffers({
      beforeBuffer: fs.readFileSync(path.join(dir, `${item.slug}-before.webp`)),
      afterBuffer: fs.readFileSync(path.join(dir, `${item.slug}-after.webp`)),
      uploader: { uploaderType: "admin", role: "admin" },
      actor,
      fields: {
        title: item.title,
        caption: item.caption,
        category: CATEGORY_FOR_SLUG[item.slug] || "general-handyman",
        group: item.category,
        illustrative: true,
        publishNow: true,
        sortOrder: index,
        internalNote: `cx4-seed:${item.slug}`,
      },
    });
    console.log(`created ${item.slug} -> ${photo._id} (${photo.status})`);
  }

  for (const old of toArchive) {
    await service.unpublish(old._id, actor);
    console.log(`moved to library: ${old._id} ${old.title || ""}`);
  }
}

async function restore(file) {
  const WorkPhoto = require("../../models/WorkPhoto");
  const backup = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`photos to restore: ${backup.photos.length}`);
  if (!CONFIRM) {
    console.log("DRY RUN. Re-run with --confirm to restore.");
    return;
  }
  for (const p of backup.photos) {
    await WorkPhoto.updateOne(
      { _id: p._id },
      { $set: { status: p.status, publishedAt: p.publishedAt, firstPublishedAt: p.firstPublishedAt, featured: p.featured, unpublishedAt: null } }
    );
    console.log(`restored ${p._id}`);
  }
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const restoreFile = valueOf("--restore");
    if (restoreFile) await restore(restoreFile);
    else if (args[0] && !args[0].startsWith("--")) await seed(args[0]);
    else throw new Error("usage: seed_what_we_do.js <imagesDir> [--backup file.json] [--confirm] | --restore file.json [--confirm]");
  } finally {
    await mongoose.disconnect();
  }
})().catch((error) => {
  console.error("ERR", error.message);
  process.exit(1);
});
