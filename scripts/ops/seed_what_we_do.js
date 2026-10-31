/*
 * What We Do (Customer Experience 4.0, 2026-10-30): publish the illustrative
 * before/after collection, and take the old single photos off the public site.
 *
 *   MONGO_URI=... S3_BUCKET=... node scripts/ops/seed_what_we_do.js <imagesDir> [--backup file.json] [--confirm]
 *   MONGO_URI=... node scripts/ops/seed_what_we_do.js --restore file.json [--confirm]
 *
 * CX 4.1 refresh (2026-10-31): replace some pairs with corrected photographs
 * and put the collection in manifest order.
 *
 *   MONGO_URI=... S3_BUCKET=... node scripts/ops/seed_what_we_do.js <imagesDir> --refresh slug,slug --backup file.json [--confirm]
 *   MONGO_URI=... node scripts/ops/seed_what_we_do.js --undo-refresh file.json [--confirm]
 *
 *  - each listed slug gets a NEW pair (internalNote "cx41-seed:<slug>", created
 *    once); the pair it replaces is unpublished to the Admin library, never deleted;
 *  - every seeded pair takes its manifest position as sortOrder; the LAST item
 *    gets 1000, so pairs uploaded later in Admin (sortOrder 0) never push it off the end;
 *  - --undo-refresh republishes the old pairs, unpublishes the new ones and puts
 *    every sortOrder back, from the backup written first.
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

async function refresh(dir, slugs) {
  const service = require("../../utils/recentWork/workPhotoService");
  const WorkPhoto = require("../../models/WorkPhoto");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).map((item, index) => ({ ...item, index }));
  const bySlug = new Map(manifest.map((item) => [item.slug, item]));
  for (const slug of slugs) {
    if (!bySlug.has(slug)) throw new Error(`not in manifest: ${slug}`);
    for (const side of ["before", "after"]) {
      if (!fs.existsSync(path.join(dir, `${slug}-${side}.webp`))) throw new Error(`missing ${slug}-${side}.webp`);
    }
  }
  const seeds = await WorkPhoto.find({ internalNote: /^cx41?-seed:/, deletedAt: null }).select("_id internalNote status sortOrder title").lean();
  const current = (slug, prefix) => seeds.find((p) => p.internalNote === `${prefix}-seed:${slug}`);
  const sortFor = (item) => (item.index === manifest.length - 1 ? 1000 : item.index);

  const toCreate = slugs.filter((slug) => !current(slug, "cx41"));
  const toRetire = slugs.map((slug) => current(slug, "cx4")).filter((p) => p && p.status === "published");
  console.log(`pairs to create: ${toCreate.join(", ") || "none"}`);
  console.log(`old pairs to move to the Admin library: ${toRetire.map((p) => p.internalNote).join(", ") || "none"}`);
  for (const item of manifest) {
    const live = current(item.slug, slugs.includes(item.slug) ? "cx41" : "cx4") || current(item.slug, "cx4");
    console.log(`  ${String(sortFor(item)).padStart(4)}  ${item.slug}${live ? ` (now ${live.sortOrder})` : " (new)"}`);
  }
  if (!CONFIRM) {
    console.log("DRY RUN. Re-run with --confirm (and --backup file.json) to write.");
    return;
  }
  const backupPath = valueOf("--backup");
  if (!backupPath) throw new Error("--backup file.json is required");
  fs.writeFileSync(backupPath, JSON.stringify({ at: new Date().toISOString(), seeds, retired: toRetire.map((p) => String(p._id)) }, null, 2));
  console.log(`backup written: ${backupPath}`);

  const actor = { userId: null, name: "Profixter (illustrative examples)" };
  const created = {};
  for (const slug of toCreate) {
    const item = bySlug.get(slug);
    const photo = await service.createPairFromBuffers({
      beforeBuffer: fs.readFileSync(path.join(dir, `${slug}-before.webp`)),
      afterBuffer: fs.readFileSync(path.join(dir, `${slug}-after.webp`)),
      uploader: { uploaderType: "admin", role: "admin" },
      actor,
      fields: {
        title: item.title,
        caption: item.caption,
        category: CATEGORY_FOR_SLUG[slug] || "general-handyman",
        group: item.category,
        illustrative: true,
        publishNow: true,
        sortOrder: sortFor(item),
        internalNote: `cx41-seed:${slug}`,
      },
    });
    created[slug] = photo._id;
    console.log(`created ${slug} -> ${photo._id} (${photo.status})`);
  }
  for (const old of toRetire) {
    await service.unpublish(old._id, actor);
    console.log(`moved to library: ${old._id} ${old.internalNote}`);
  }
  // Manifest order for every pair now on the site.
  const after = await WorkPhoto.find({ internalNote: /^cx41?-seed:/, deletedAt: null, status: "published" }).select("_id internalNote sortOrder").lean();
  for (const photo of after) {
    const item = bySlug.get(photo.internalNote.replace(/^cx41?-seed:/, ""));
    if (item && photo.sortOrder !== sortFor(item)) {
      await service.updateDetails(photo._id, { sortOrder: sortFor(item) });
      console.log(`sortOrder ${item.slug}: ${photo.sortOrder} -> ${sortFor(item)}`);
    }
  }
}

async function undoRefresh(file) {
  const service = require("../../utils/recentWork/workPhotoService");
  const WorkPhoto = require("../../models/WorkPhoto");
  const backup = JSON.parse(fs.readFileSync(file, "utf8"));
  const knownIds = new Set(backup.seeds.map((p) => String(p._id)));
  const added = await WorkPhoto.find({ internalNote: /^cx41-seed:/, deletedAt: null, status: "published" }).select("_id internalNote").lean();
  const newer = added.filter((p) => !knownIds.has(String(p._id)));
  console.log(`new pairs to unpublish: ${newer.length}; old pairs to republish: ${backup.retired.length}; sort orders to restore: ${backup.seeds.length}`);
  if (!CONFIRM) {
    console.log("DRY RUN. Re-run with --confirm to undo.");
    return;
  }
  const actor = { userId: null, name: "Profixter (illustrative examples)" };
  for (const p of newer) await service.unpublish(p._id, actor);
  for (const id of backup.retired) await service.publish(id, actor);
  for (const p of backup.seeds) await WorkPhoto.updateOne({ _id: p._id }, { $set: { sortOrder: p.sortOrder } });
  console.log("undone");
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
    const undoFile = valueOf("--undo-refresh");
    const refreshSlugs = valueOf("--refresh");
    if (undoFile) await undoRefresh(undoFile);
    else if (refreshSlugs) await refresh(args[0], refreshSlugs.split(",").map((s) => s.trim()).filter(Boolean));
    else if (restoreFile) await restore(restoreFile);
    else if (args[0] && !args[0].startsWith("--")) await seed(args[0]);
    else throw new Error("usage: seed_what_we_do.js <imagesDir> [--backup file.json] [--confirm] | --restore file.json [--confirm]");
  } finally {
    await mongoose.disconnect();
  }
})().catch((error) => {
  console.error("ERR", error.message);
  process.exit(1);
});
