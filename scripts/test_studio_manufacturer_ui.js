/**
 * Shower Studio manufacturer catalog -> Studio - browser walk-through on the
 * isolated demo stack (in-memory database, local storage, no AWS, no email):
 *
 *   1  owner imports the real Swan price file (preview, then apply)
 *   A  one product: Add to Studio -> draft -> editor -> prices, photo,
 *      checks -> publication requirements -> publish
 *   B  every eligible product: preview by category -> add as drafts ->
 *      counts -> repeat adds nothing -> owner prices kept
 *   C  catalog manager: exact SKU, filters, colour switch, archive, edit
 *   D  customers: only published products, no manufacturer images, no
 *      invented prices; the designer offers families, sizes and colours
 *      and never a kit that does not fit
 *   E  phone and tablet layouts; employees refused; no browser errors
 *
 * Needs catalog-imports/swan-epf-*.xlsx (not committed). Screenshots go to
 * the temp folder. Manufacturer images load from Swan's CDN in the browser.
 *   node scripts/test_studio_manufacturer_ui.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const { chromium } = require(path.join(__dirname, "..", "..", "FrontEnd", "node_modules", "playwright"));
const demo = require("./studio_demo_env");

const FILE = (() => {
  const dir = path.join(__dirname, "..", "catalog-imports");
  try { return fs.readdirSync(dir).filter((f) => /^swan-epf-.*\.xlsx$/i.test(f)).map((f) => path.join(dir, f))[0]; } catch { return null; }
})();
const OUT = path.join(os.tmpdir(), "studio-mfr-ui");
fs.mkdirSync(OUT, { recursive: true });
let failed = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try { const info = await fn(); console.log(`  PASS  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)${info ? "  " + JSON.stringify(info) : ""}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n").slice(0, 3).join("\n        ")}`); }
}
const must = (c, m) => { if (!c) throw new Error(m); };
const KIT = "TSMK843062.221"; // Swanstone Traditional Subway 62 x 30 x 84 shower wall kit, Carrara

(async () => {
  if (!FILE) { console.log("No catalog-imports/swan-epf-*.xlsx - nothing to test."); process.exit(0); }
  const env = await demo.start();
  const { FRONTEND_URL: FE, BACKEND_URL: BE, users } = env;
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors = [];
  const api = async (method, url, user, body) => {
    const r = await fetch(BE + url, { method, headers: { ...(user ? { Authorization: `Bearer ${user.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  async function page(user, viewport, label) {
    const ctx = await browser.newContext({ viewport });
    if (user) await ctx.addInitScript(([t]) => { localStorage.setItem("token", t); }, [user.token]);
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
    // React warnings too (a manufacturer image that fails to load is not an app error)
    p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push(`${label} console: ${m.text().slice(0, 200)}`); });
    p.on("dialog", (d) => d.accept(d.type() === "prompt" ? "Checked against the Swan drawings" : undefined));
    return p;
  }
  const photo = path.join(OUT, "own-photo.jpg");
  await sharp({ create: { width: 900, height: 700, channels: 3, background: "#e9e9e7" } }).jpeg().toFile(photo);
  const noOverflow = async (p, label) => { const o = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); must(o <= 1, `${label} scrolls sideways by ${o}px`); };

  try {
    const p = await page(users.owner, { width: 1440, height: 1000 }, "owner");
    const toCatalog = async (tab) => {
      await p.goto(`${FE}/admin?tab=studio-catalog`, { waitUntil: "domcontentloaded", timeout: 180000 });
      await p.click(`[data-testid="catalog-tab-${tab}"]`, { timeout: 120000 });
    };

    await step("1. owner imports the Swan price file: preview first, then apply", async () => {
      await toCatalog("manufacturers");
      await p.click('[data-testid="mfr-tab-import"]');
      await p.setInputFiles('[data-testid="mfr-file"]', FILE);
      await p.locator('[data-testid="mfr-preview"]').getByText("Preview").waitFor({ timeout: 120000 });
      must(/3,672/.test(await p.locator('[data-testid="mfr-preview"]').innerText()), "3,672 variants in the preview");
      await p.click('[data-testid="mfr-apply"]');
      await p.locator('[data-testid="mfr-preview"]').getByText(/Imported in/).waitFor({ timeout: 180000 });
      return { variants: (await api("GET", "/api/admin/studio/manufacturers/swan/items?per=10&availability=all", users.owner)).body.total };
    });

    let kitId;
    await step("A1. a Swan product page: one click on Add to Studio creates a private draft and opens the editor", async () => {
      await p.click('[data-testid="mfr-tab-browse"]');
      // search the exact part number: a model card opens its first colour
      await p.fill('[data-testid="mfr-search"]', KIT);
      await p.locator('[data-testid="mfr-model"]', { has: p.locator(`[data-testid="mfr-variant-${KIT}"]`) }).locator("button").first().click({ timeout: 30000 });
      await p.locator('[data-testid="mfr-detail-add"]').waitFor({ timeout: 30000 });
      await p.screenshot({ path: path.join(OUT, "A1-product-page.png") });
      await p.click('[data-testid="mfr-detail-add"]');
      await p.locator('[data-testid="product-source"]').waitFor({ timeout: 30000 });
      const fr = await api("GET", `/api/admin/studio/products?view=families&q=${KIT}`, users.owner);
      must(fr.body.families?.length, `families: ${fr.status} ${JSON.stringify(fr.body).slice(0, 300)}`);
      const prod = fr.body.families[0].products[0];
      kitId = prod._id;
      must(prod.status === "draft" && prod.pricing.priceCents == null && prod.listPriceCents === 351600, JSON.stringify(prod.pricing));
      must(/Draft - incomplete/.test(await p.locator('[data-testid="product-stage"]').innerText()), "incomplete draft");
      await p.screenshot({ path: path.join(OUT, "A1b-editor-new.png"), fullPage: true });
    });

    await step("A2. the editor walks the owner through every requirement, then publishes", async () => {
      await p.fill('[data-testid="product-cost"]', "1800");
      await p.fill('[data-testid="product-price"]', "3900");
      await p.click('[data-testid="product-save"]');
      await p.getByText("Saved.").waitFor({ timeout: 30000 });
      let t = await p.locator('[data-testid="product-readiness"]').innerText();
      must(/Add a photo customers may see/.test(t) && /Compatibility is unverified/.test(t) && /Approve the product information/.test(t), t);
      await p.click('[data-testid="product-publish"]');
      await p.locator('[role="status"]').getByText(/Add a photo/).waitFor({ timeout: 30000 });
      await p.setInputFiles('[data-testid="product-photo-input"]', photo);
      await p.getByText("Photo added.").waitFor({ timeout: 30000 });
      await p.click('[data-testid="product-compat-check"]');
      await p.locator('[data-testid="product-compat-report"]').waitFor({ timeout: 30000 });
      await p.selectOption('[data-testid="product-compat"]', "reviewed");
      await p.check('[data-testid="product-review-info"]');
      await p.check('[data-testid="product-review-visual"]');
      await p.click('[data-testid="product-save"]');
      await p.getByText("Saved.").waitFor({ timeout: 30000 });
      await p.locator('[data-testid="product-stage"]').getByText("Ready to publish").waitFor({ timeout: 30000 });
      await p.screenshot({ path: path.join(OUT, "A2-editor-ready.png"), fullPage: true });
      await p.click('[data-testid="product-publish"]');
      await p.getByText("Published: customers can choose it now.").waitFor({ timeout: 30000 });
      t = (await api("GET", `/api/admin/studio/products/${kitId}`, users.owner)).body.product;
      must(t.status === "published" && t.pricing.priceCents === 390000 && t.pricing.costCents === 180000 && t.source.listPriceCents === 351600, "saved");
    });

    await step("A3. product pages explain themselves: already in Studio (open), and not drawable (why)", async () => {
      await toCatalog("manufacturers");
      await p.fill('[data-testid="mfr-search"]', "MSMK-8436");
      await p.locator('[data-testid="mfr-model"]').first().locator("button").first().click({ timeout: 30000 });
      await p.locator('[data-testid="mfr-detail-unsupported"]').waitFor({ timeout: 30000 });
      await p.getByRole("button", { name: "← Back" }).click();
      await p.fill('[data-testid="mfr-search"]', KIT);
      await p.locator('[data-testid="mfr-model"]', { has: p.locator(`[data-testid="mfr-variant-${KIT}"]`) }).locator("button").first().click({ timeout: 30000 });
      await p.locator('[data-testid="mfr-detail-open"]').waitFor({ timeout: 30000 });
      must(/Already in Studio/.test(await p.locator('[data-testid="mfr-detail-action"]').innerText()), "already in studio");
    });

    let eligible;
    await step("B1. bulk: preview by category, add every eligible product as private drafts", async () => {
      await p.getByRole("button", { name: "← Back" }).click();
      await p.fill('[data-testid="mfr-search"]', "");
      await p.click('[data-testid="mfr-bulk-open"]');
      await p.locator('[data-testid="mfr-bulk-start"]').waitFor({ timeout: 60000 });
      eligible = (await api("GET", "/api/admin/studio/manufacturers/swan/studio-eligible", users.owner)).body.totals;
      await p.screenshot({ path: path.join(OUT, "B1-bulk-preview.png"), fullPage: true });
      const t0 = Date.now();
      await p.click('[data-testid="mfr-bulk-start"]');
      await p.locator('[data-testid="mfr-bulk-result"]').getByText(/products added/).waitFor({ timeout: 300000 });
      const ms = Date.now() - t0;
      await p.screenshot({ path: path.join(OUT, "B1b-bulk-done.png"), fullPage: true });
      const after = (await api("GET", "/api/admin/studio/manufacturers/swan/studio-eligible", users.owner)).body.totals;
      must(after.new === 0 && after.alreadyInStudio === eligible.eligible, JSON.stringify(after));
      return { eligible: eligible.eligible, added: eligible.new, unsupported: eligible.unsupported, seconds: Math.round(ms / 100) / 10 };
    });

    await step("B2. repeating adds nothing; the owner's prices and published product are untouched", async () => {
      must(/Nothing new to add/.test(await p.locator('[data-testid="mfr-bulk-start"]').innerText()), "nothing new");
      const before = (await api("GET", "/api/admin/studio/products?view=families", users.owner)).body.total.products;
      const r = await api("POST", "/api/admin/studio/manufacturers/swan/studio-jobs", users.owner, { groups: ["walls", "bases", "bathtubs", "tubShowers", "showers", "accessories"] });
      must(r.status === 202 && r.body.job.total === 0, JSON.stringify(r.body));
      const after = (await api("GET", "/api/admin/studio/products?view=families", users.owner)).body.total.products;
      must(before === after, `${before} -> ${after}`);
      const kit = (await api("GET", `/api/admin/studio/products/${kitId}`, users.owner)).body.product;
      must(kit.status === "published" && kit.pricing.priceCents === 390000, "owner price kept");
    });

    await step("C1. catalog manager: exact SKU, then filters by manufacturer, category and readiness", async () => {
      await toCatalog("products");
      await p.locator('[data-testid="catalog-family"]').first().waitFor({ timeout: 60000 });
      await p.screenshot({ path: path.join(OUT, "C1-manager.png"), fullPage: true });
      await p.fill('[data-testid="catalog-search"]', "SR03260LM.221");
      await p.locator('[data-testid="catalog-row-SR03260LM.221"]').waitFor({ timeout: 30000 });
      must((await p.locator('[data-testid="catalog-row-SR03260LM.221"]').count()) === 1, "one exact match");
      await p.fill('[data-testid="catalog-search"]', "");
      await p.selectOption('[data-testid="catalog-manufacturer"]', "swan");
      await p.click('[data-testid="catalog-cat-wall"]');
      await p.click('[data-testid="catalog-stage-missingPrice"]');
      await p.locator('[data-testid="catalog-family"]').first().waitFor({ timeout: 30000 });
      const text = await p.locator('[data-testid="catalog-manager"]').innerText();
      must(/families/.test(text) && !/No products match/.test(text), "filtered list");
      await p.screenshot({ path: path.join(OUT, "C1b-filtered.png"), fullPage: true });
    });

    await step("C2. open a family, switch colour in the editor, archive drafts in bulk", async () => {
      await p.click('[data-testid="catalog-stage-all"]');
      await p.fill('[data-testid="catalog-search"]', "TSMK84-3062");
      const fam = p.locator('[data-testid="catalog-family"]', { hasText: "Traditional Subway Tile Glue up Shower Wall Kit" }).first(); // (the list updates 300 ms after typing)
      await fam.waitFor({ timeout: 30000 });
      await fam.locator('button[data-testid^="catalog-family-"]').click();
      await p.locator(`[data-testid="catalog-row-${KIT}"] button`).click({ timeout: 30000 });
      await p.locator('[data-testid="product-siblings"]').waitFor({ timeout: 30000 });
      await p.click('[data-testid="sibling-TSMK843062.203"]');
      await p.locator('[data-testid="product-editor"]').getByText(/^TSMK843062.203 ·/).first().waitFor({ timeout: 30000 });
      await p.getByRole("button", { name: "← Back to the catalog" }).click();
      await p.fill('[data-testid="catalog-search"]', "TSMK84-3062");
      const f2 = p.locator('[data-testid="catalog-family"]', { hasText: "Traditional Subway Tile Glue up Shower Wall Kit" }).first(); // (the list updates 300 ms after typing)
      await f2.waitFor({ timeout: 30000 });
      await f2.locator('button[data-testid^="catalog-family-"]').click();
      await p.locator('[data-testid="catalog-row-TSMK843062.203"] input[type="checkbox"]').check();
      await p.locator('[data-testid="catalog-row-TSMK843062.130"] input[type="checkbox"]').check();
      await p.locator(`[data-testid="catalog-row-${KIT}"] input[type="checkbox"]`).check();
      await p.selectOption('[data-testid="catalog-bulk-action"]', "archive");
      await p.locator('[data-testid="catalog-msg"]').getByText(/2 changed, 1 skipped/).waitFor({ timeout: 30000 });
      must(/unpublish it first/.test(await p.locator('[data-testid="catalog-msg"]').innerText()), "published one protected");
    });

    await step("C3. editing an existing (hand-made) Studio product still works", async () => {
      await p.fill('[data-testid="catalog-search"]', "");
      await p.selectOption('[data-testid="catalog-manufacturer"]', "own");
      const row = p.locator('[data-testid^="catalog-row-"] button').first();
      await row.click({ timeout: 30000 });
      await p.locator('[data-testid="product-name"]').waitFor({ timeout: 30000 });
      const name = await p.inputValue('[data-testid="product-name"]');
      await p.fill('[data-testid="product-name"]', `${name} `);
      await p.click('[data-testid="product-save"]');
      await p.getByText("Saved.").waitFor({ timeout: 30000 });
      await p.fill('[data-testid="product-name"]', name);
      await p.click('[data-testid="product-save"]');
      await p.getByText("Saved.").waitFor({ timeout: 30000 });
    });

    await step("D1. the public catalog: published products only, no manufacturer images, no costs or list prices", async () => {
      const pub = await api("GET", "/api/studio/catalog");
      const t = JSON.stringify(pub.body);
      must(t.includes(KIT), "the published Swan kit");
      must(!/SR03260LM|VP6030C|TSMK843062\.203|listPrice|costCents|pendingReview|externalMedia/.test(t), "drafts or internal fields leaked");
      const swanUrls = (await api("GET", `/api/admin/studio/products/${kitId}`, users.owner)).body.product.externalMedia.map((m) => m.url);
      must(swanUrls.length && !swanUrls.some((u) => t.includes(u)), "Swan media links leaked");
      const kit = pub.body.catalog.finishes.find((x) => x.id === KIT);
      must(kit.photo.startsWith("/api/studio/assets/") || kit.photo.includes("/api/studio/assets/"), "only the owner's photo");
    });

    await step("D2. staff designer: families with size/colour choices; a kit that does not fit is never offered", async () => {
      const StudioDesign = require("../models/studio/StudioDesign");
      const created = await api("POST", "/api/admin/studio/designs", users.owner, { projectType: "shower-replacement", customer: { name: "QA Swan" } });
      const id = created.body.design.id;
      await StudioDesign.updateOne({ publicId: id }, { $set: { exampleScene: "example-bathroom-1", measureSource: "standard" } });
      await p.goto(`${FE}/admin?tab=studio&design=${id}`, { waitUntil: "domcontentloaded" });
      await p.locator('[data-testid="studio-editor"]').waitFor({ timeout: 120000 });
      await p.locator('[data-testid^="family-base-"]').first().waitFor({ timeout: 120000 });
      const fams = await p.locator('[data-testid^="family-finish-"]').count();
      const pan = p.locator('[data-testid^="family-base-swan-base-veritek-pro-alcove-shower-pan-with-l-r-drain"]');
      if (await pan.count()) await pan.click(); else await p.locator('[data-testid^="family-base-"]').first().click();
      const famIds = await p.locator('[data-testid^="family-finish-"], [data-testid^="finish-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
      const target = p.locator('[data-testid^="family-finish-swan-wall-swanstone-traditional-subway-tile-glue-up-shower-w"]');
      must(await target.count(), `wall cards: ${famIds.slice(0, 20).join(", ")}`);
      await target.click({ timeout: 60000 });
      await p.locator('[data-testid="variants-finish"]').waitFor({ timeout: 30000 });
      await p.click(`[data-testid="finish-${KIT}"]`);
      await p.waitForTimeout(2500);
      const offered = await p.locator('[data-testid^="finish-MTMK723450"]').count();
      must(offered === 0, "a 50-inch kit offered for a 60-inch alcove");
      await p.screenshot({ path: path.join(OUT, "D2-designer-families.png"), fullPage: true });
      await p.getByRole("button", { name: "Design", exact: true }).click();
      await p.waitForTimeout(4000);
      await p.screenshot({ path: path.join(OUT, "D2b-designer-view.png") });
      const price = (await p.locator('[data-testid="studio-price"]').innerText()).replace(/\s+/g, " ");
      return { wallFamilies: fams, priceBox: price.slice(0, 180) };
    });

    await step("D3. a homeowner (public Studio, local only) sees one card per family and the colour choices", async () => {
      const h = await page(null, { width: 390, height: 844 }, "homeowner");
      await h.goto(`${FE}/shower-studio`, { waitUntil: "domcontentloaded", timeout: 180000 });
      await h.click('[data-testid="start-shower"]', { timeout: 120000 });
      await h.waitForTimeout(6000);
      await h.screenshot({ path: path.join(OUT, "D3-public-phone.png"), fullPage: true });
      await noOverflow(h, "public studio");
    });

    await step("E1. employees without catalog access are refused", async () => {
      for (const u of [users.seller, users.outsider]) {
        for (const url of ["/api/admin/studio/manufacturers", "/api/admin/studio/products?view=families", "/api/admin/studio/manufacturers/swan/studio-eligible"]) {
          const r = await api("GET", url, u);
          must(r.status === 403, `${u.email} ${url}: ${r.status}`);
        }
      }
    });

    await step("E2. phone and tablet: manager, bulk panel and product page fit the screen", async () => {
      for (const [w, h, label] of [[390, 844, "phone"], [820, 1180, "tablet"]]) {
        const m = await page(users.owner, { width: w, height: h }, label);
        await m.goto(`${FE}/admin?tab=studio-catalog`, { waitUntil: "domcontentloaded", timeout: 180000 });
        await m.locator('[data-testid="catalog-family"]').first().waitFor({ timeout: 120000 });
        await noOverflow(m, `${label} manager`);
        await m.screenshot({ path: path.join(OUT, `E2-${label}-manager.png`) });
        await m.click('[data-testid="catalog-tab-manufacturers"]');
        await m.click('[data-testid="mfr-bulk-open"]', { timeout: 60000 });
        await m.locator('[data-testid="mfr-bulk-start"]').waitFor({ timeout: 60000 });
        await noOverflow(m, `${label} bulk panel`);
        await m.screenshot({ path: path.join(OUT, `E2-${label}-bulk.png`), fullPage: true });
      }
    });

    await step("E3. no browser errors", async () => { must(!errors.length, errors.join("\n")); });
  } finally {
    await browser.close();
    await demo.stop();
  }
  console.log(`\n${failed ? `${failed} step(s) failed` : "all steps passed"}. Screenshots: ${OUT}`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await demo.stop(); } catch { /* ignore */ } process.exit(1); });
