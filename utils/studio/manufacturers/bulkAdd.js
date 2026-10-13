/**
 * "Add eligible products to Studio" - every variant of a manufacturer that
 * the designer can draw and that is still sold, added as private drafts.
 *
 * Eligible = the adapter can draw it (studioMapping supported) AND it is
 * active or special order. Discontinued / no-longer-listed variants, vanity
 * tops, sinks, single wall panels and other unsupported items stay in the
 * manufacturer library only.
 *
 * Uses the same addToStudio() as adding one product, in batches, so it is
 * idempotent: running it again adds only what is missing.
 */
const StudioSupplierItem = require("../../../models/studio/StudioSupplierItem");
const StudioManufacturer = require("../../../models/studio/StudioManufacturer");
const StudioProduct = require("../../../models/studio/StudioProduct");
const StudioMediaCheck = require("../../../models/studio/StudioMediaCheck");
const StudioBulkJob = require("../../../models/studio/StudioBulkJob");
const { adapterFor } = require("./index");
const { GROUPS } = require("./abgEpf");
const { addToStudio } = require("./studioLink");

const BATCH = 200;
const STALE_MS = 5 * 60 * 1000;
const SELLABLE = ["active", "special-order"];
/** Approximations that mean the file lacks something the drawing needs. */
const MISSING_SPEC = /not in the file|not published|no measured swatch|not give/i;

const fail = (status, message) => Object.assign(new Error(message), { status });

async function loadItems(key) {
  return StudioSupplierItem.find({ manufacturer: key }).select("partNumber group availability name shortName baseModel modelNumber seriesName color dims media installationType shape pieces configuration material surface programs studioSku").lean();
}

/** What a bulk add would do, per category. Nothing is changed. */
async function previewEligible(key) {
  const adapter = adapterFor(key);
  if (!adapter) throw fail(404, "Unknown manufacturer.");
  const mfr = await StudioManufacturer.forKey(key);
  const trimAllowanceIn = mfr.settings?.trimAllowanceIn ?? adapter.DEFAULT_TRIM_ALLOWANCE_IN;
  const items = await loadItems(key);
  const inStudio = new Set((await StudioProduct.find({ "source.manufacturer": key }).select("sku").lean()).map((p) => p.sku));
  const photoUrls = items.flatMap((i) => i.media.filter((m) => m.kind === "photo").map((m) => m.url));
  const checks = new Map((await StudioMediaCheck.find({ url: { $in: photoUrls } }).select("url status").lean()).map((c) => [c.url, c.status]));
  const linkChecked = checks.size > 0;
  const byGroup = new Map(GROUPS.map((g) => [g.key, { key: g.key, label: g.label, variants: 0, eligible: 0, new: 0, alreadyInStudio: 0, unsupported: 0, notSold: 0, specialOrder: 0, missingSpecs: 0, noPhoto: 0, units: 0, unsupportedReasons: {} }]));
  for (const it of items) {
    const g = byGroup.get(it.group) || byGroup.get("other");
    g.variants++;
    if (!SELLABLE.includes(it.availability)) { g.notSold++; continue; }
    const m = adapter.studioMapping(it, { trimAllowanceIn });
    if (!m.supported) { g.unsupported++; g.unsupportedReasons[m.reason] = (g.unsupportedReasons[m.reason] || 0) + 1; continue; }
    g.eligible++;
    if (inStudio.has(it.partNumber) || it.studioSku) { g.alreadyInStudio++; continue; }
    g.new++;
    if (it.availability === "special-order") g.specialOrder++;
    if (m.companion) g.units++;
    if (m.approximations.some((a) => MISSING_SPEC.test(a))) g.missingSpecs++;
    const photos = it.media.filter((x) => x.kind === "photo").map((x) => x.url);
    if (!photos.length || (linkChecked && !photos.some((u) => checks.get(u) === "ok"))) g.noPhoto++;
  }
  const groups = [...byGroup.values()].filter((g) => g.variants);
  const sum = (k) => groups.reduce((s, g) => s + g[k], 0);
  return {
    groups,
    totals: { variants: sum("variants"), eligible: sum("eligible"), new: sum("new"), alreadyInStudio: sum("alreadyInStudio"), unsupported: sum("unsupported"), notSold: sum("notSold"), missingSpecs: sum("missingSpecs"), noPhoto: sum("noPhoto"), units: sum("units"), specialOrder: sum("specialOrder") },
    linkChecked,
    imageRights: mfr.imageRights?.status || "unconfirmed",
    running: await currentJob(key),
  };
}

/** The job running now (a stale one is marked interrupted first). */
async function currentJob(key) {
  await StudioBulkJob.updateMany({ manufacturer: key, status: "running", heartbeatAt: { $lt: new Date(Date.now() - STALE_MS) } }, { $set: { status: "interrupted", error: "Stopped before finishing (server restart?). Start again to continue - products already added are skipped." } });
  return StudioBulkJob.findOne({ manufacturer: key, status: "running" }).lean();
}

/** Start adding every eligible, not-yet-added variant of the chosen categories. */
async function startBulkAdd({ key, groups, actorId = null, wait = false }) {
  const adapter = adapterFor(key);
  if (!adapter) throw fail(404, "Unknown manufacturer.");
  const chosen = [...new Set((Array.isArray(groups) ? groups : []).map(String))].filter((g) => GROUPS.some((x) => x.key === g));
  if (!chosen.length) throw fail(400, "Choose at least one category.");
  if (await currentJob(key)) throw fail(409, "Products are already being added. Wait for it to finish.");
  const mfr = await StudioManufacturer.forKey(key);
  const trimAllowanceIn = mfr.settings?.trimAllowanceIn ?? adapter.DEFAULT_TRIM_ALLOWANCE_IN;
  const items = (await loadItems(key)).filter((it) => chosen.includes(it.group) && SELLABLE.includes(it.availability) && !it.studioSku && adapter.studioMapping(it, { trimAllowanceIn }).supported);
  const job = await StudioBulkJob.create({ manufacturer: key, groups: chosen, total: items.length, createdBy: actorId });
  const run = (async () => {
    const started = Date.now();
    const reasons = {};
    let added = 0, companions = 0, skipped = 0, processed = 0;
    try {
      for (let i = 0; i < items.length; i += BATCH) {
        const parts = items.slice(i, i + BATCH).map((x) => x.partNumber);
        const r = await addToStudio({ key, partNumbers: parts, actorId });
        added += r.added.length;
        companions += r.added.filter((a) => a.companion).length;
        skipped += r.skipped.length;
        for (const s of r.skipped) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
        processed += parts.length;
        await StudioBulkJob.updateOne({ _id: job._id }, { $set: { processed, added, companions, skipped, skippedReasons: reasons, heartbeatAt: new Date() } });
      }
      await StudioBulkJob.updateOne({ _id: job._id }, { $set: { status: "done", finishedAt: new Date(), durationMs: Date.now() - started } });
    } catch (e) {
      await StudioBulkJob.updateOne({ _id: job._id }, { $set: { status: "failed", error: String(e.message || e).slice(0, 300), finishedAt: new Date(), durationMs: Date.now() - started } });
      console.error(JSON.stringify({ event: "studio_bulk_add_failed", manufacturer: key, jobId: String(job._id), error: String(e.message || e).slice(0, 200) }));
    }
  })();
  if (wait) await run;
  else run.catch(() => {});
  return StudioBulkJob.findById(job._id).lean();
}

module.exports = { previewEligible, startBulkAdd, currentJob, SELLABLE };
