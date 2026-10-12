/**
 * Shower Studio data retention (runs nightly).
 *
 * - A visitor's unsent design (and its photos) is deleted 30 days after it was
 *   last saved (STUDIO_DRAFT_RETENTION_DAYS).
 * - A sent request keeps its photos for 2 years (STUDIO_SUBMITTED_RETENTION_DAYS)
 *   unless it became a proposal; after that the photos are erased and only the
 *   request record (contact, selections, price) remains with the lead.
 * - Designs that became proposals or were signed are kept with the project.
 */
const StudioDesign = require("../../models/studio/StudioDesign");
const StudioPhoto = require("../../models/studio/StudioPhoto");
const storage = require("./storage");

async function erasePhotos(designId) {
  const photos = await StudioPhoto.find({ designId, deletedAt: null });
  for (const p of photos) {
    await storage.remove(p.storageKey).catch(() => {});
    p.deletedAt = new Date();
    await p.save();
  }
  return photos.length;
}

async function sweepStudioRetention({ now = new Date() } = {}) {
  const out = { draftsDeleted: 0, photosErased: 0 };
  const drafts = await StudioDesign.find({ origin: "public", status: "draft", deleteAfter: { $lte: now } }).select("_id").lean();
  for (const d of drafts) {
    out.photosErased += await erasePhotos(d._id);
    await StudioDesign.deleteOne({ _id: d._id });
    out.draftsDeleted += 1;
  }
  const expired = await StudioDesign.find({ status: { $in: ["submitted", "in_review", "closed", "archived"] }, deleteAfter: { $lte: now }, photo: { $ne: null } }).select("_id").lean();
  for (const d of expired) {
    out.photosErased += await erasePhotos(d._id);
    await StudioDesign.updateOne({ _id: d._id }, { $set: { photo: null, preview: null, state: null, revisions: [] } });
  }
  if (out.draftsDeleted || out.photosErased) console.log(JSON.stringify({ event: "studio_retention", ...out }));
  return out;
}

module.exports = { sweepStudioRetention, erasePhotos };
