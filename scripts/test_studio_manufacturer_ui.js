/**
 * Shower Studio manufacturer catalog - browser walk-through on the isolated
 * demo stack (in-memory database, local storage, no AWS, no email sent):
 *
 *   1. owner imports the real Swan price file in Admin (preview, then apply)
 *   2. browses the walls, searches by model number, adds colours as drafts
 *   3. adds a tub/shower unit and a shower base
 *   4. views a variant (manufacturer images, documents, approximations)
 *   5. colours & patterns, image rights & links pages
 *   6. sets material cost, selling price and compatibility on a product
 *   7. designs with Swan products in the staff designer (wall pattern drawn)
 *   8. nothing Swan reaches the public catalog; employees are refused
 *
 * Needs catalog-imports/swan-epf-*.xlsx (not committed). Screenshots go to
 * the temp folder. Manufacturer images load from Swan's CDN in the browser.
 *   node scripts/test_studio_manufacturer_ui.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
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
  try { const info = await fn(); console.log(`  PASS  ${name}${info ? "  " + JSON.stringify(info) : ""}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n").slice(0, 3).join("\n        ")}`); }
}
const must = (c, m) => { if (!c) throw new Error(m); };

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
    await ctx.addInitScript(([t]) => { localStorage.setItem("token", t); }, [user.token]);
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
    // React warnings too (a manufacturer image that fails to load is not an app error)
    p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push(`${label} console: ${m.text().slice(0, 200)}`); });
    p.on("dialog", (d) => d.accept());
    return p;
  }
  try {
    const p = await page(users.owner, { width: 1440, height: 1000 }, "owner");
    await step("1. owner imports the Swan price file: preview first, then apply", async () => {
      await p.goto(`${FE}/admin?tab=studio-catalog`, { waitUntil: "domcontentloaded", timeout: 180000 });
      await p.click('[data-testid="catalog-tab-manufacturers"]', { timeout: 120000 });
      await p.click('[data-testid="mfr-tab-import"]');
      await p.setInputFiles('[data-testid="mfr-file"]', FILE);
      await p.locator('[data-testid="mfr-preview"]').getByText("Preview").waitFor({ timeout: 120000 });
      const text = await p.locator('[data-testid="mfr-preview"]').innerText();
      must(/3,672/.test(text), "3,672 variants in the preview");
      must((await api("GET", "/api/admin/studio/manufacturers/swan/items?per=10", users.owner)).body.total === 0, "the preview imported nothing");
      await p.screenshot({ path: path.join(OUT, "1-import-preview.png"), fullPage: true });
      await p.click('[data-testid="mfr-apply"]');
      await p.locator('[data-testid="mfr-preview"]').getByText(/Imported in/).waitFor({ timeout: 180000 });
      const total = (await api("GET", "/api/admin/studio/manufacturers/swan/items?per=10&availability=all", users.owner)).body.total;
      must(total === 3672, `imported ${total}`);
      await p.screenshot({ path: path.join(OUT, "1b-import-done.png"), fullPage: true });
      return { variants: total };
    });

    await step("2. browse walls by series; search a model number; add two colours as drafts", async () => {
      await p.click('[data-testid="mfr-tab-browse"]');
      await p.locator('[data-testid="mfr-series"]').first().waitFor({ timeout: 60000 });
      const series = await p.locator('[data-testid="mfr-series"]').count();
      await p.screenshot({ path: path.join(OUT, "2-walls-series.png") });
      await p.fill('[data-testid="mfr-search"]', "TSMK84-3062");
      await p.locator('[data-testid="mfr-variant-TSMK843062.221"]').waitFor({ timeout: 30000 });
      await p.locator('[data-testid="mfr-variant-TSMK843062.221"] input').check();
      await p.locator('[data-testid="mfr-variant-TSMK843062.203"] input').check();
      await p.screenshot({ path: path.join(OUT, "2b-search-select.png") });
      await p.click('[data-testid="mfr-add"]');
      await p.locator('[data-testid="mfr-add-result"]').getByText(/Added 2 products/).waitFor({ timeout: 30000 });
      return { series };
    });

    await step("3. add a tub/shower unit and shower bases (API path the page uses)", async () => {
      const r = await api("POST", "/api/admin/studio/manufacturers/swan/add-to-studio", users.owner, { partNumbers: ["VP6030CTSML.010", "VP6030CPANNSL.010", "SR03260LM.221", "BF05024.000"] });
      must(r.status === 201 && r.body.added.length === 4, JSON.stringify(r.body));
      return { added: r.body.added.map((a) => a.sku) };
    });

    await step("4. a variant shows manufacturer images, documents, list price and how it is drawn", async () => {
      await p.fill('[data-testid="mfr-search"]', "VP6030CTSML");
      // wait for this search's results (the box searches 300 ms after typing)
      await p.locator('[data-testid="mfr-model"]', { has: p.locator('[data-testid="mfr-variant-VP6030CTSML.010"]') }).locator("button").first().click({ timeout: 30000 });
      await p.locator('[data-testid="mfr-detail"]').waitFor();
      const t = await p.locator('[data-testid="mfr-detail"]').innerText();
      await p.screenshot({ path: path.join(OUT, "4-variant-detail-top.png") });
      must(/Manufacturer list price/i.test(t) && /\$1,222\b/.test(t), `list price shown: ${t.slice(0, 400).replace(/\s+/g, " ")}`);
      must(/Technical drawing|Installation guide/.test(t), "documents listed");
      must(/integral walls/.test(t), "unit drawn with its walls");
      await p.waitForTimeout(2500);
      await p.screenshot({ path: path.join(OUT, "4-variant-detail.png"), fullPage: true });
    });

    await step("5. colours & textures, and image rights & links", async () => {
      await p.click('[data-testid="mfr-tab-colors"]');
      await p.locator('[data-testid="mfr-color-221"]').waitFor({ timeout: 30000 });
      await p.waitForTimeout(2000);
      await p.screenshot({ path: path.join(OUT, "5-colors.png"), fullPage: true });
      await p.click('[data-testid="mfr-tab-rights"]');
      await p.locator('[data-testid="mfr-rights"]').waitFor();
      await p.screenshot({ path: path.join(OUT, "5b-rights.png"), fullPage: true });
    });

    await step("6. owner sets material cost, selling price and compatibility on a Swan product (stays a draft)", async () => {
      await p.click('[data-testid="catalog-tab-products"]');
      await p.getByRole("button", { name: /^Wall kits/ }).click();
      await p.locator('[data-testid="catalog-row-TSMK843062.221"] button').last().click({ timeout: 30000 });
      await p.locator('[data-testid="product-source"]').waitFor();
      await p.fill('[data-testid="product-cost"]', "1800");
      await p.fill('[data-testid="product-price"]', "3900");
      await p.selectOption('[data-testid="product-compat"]', "reviewed");
      await p.click('[data-testid="product-save"]');
      await p.getByText("Saved.").waitFor({ timeout: 30000 });
      await p.screenshot({ path: path.join(OUT, "6-product-prices.png"), fullPage: true });
      const prod = (await api("GET", "/api/admin/studio/products?category=wall", users.owner)).body.products.find((x) => x.sku === "TSMK843062.221");
      must(prod.pricing.costCents === 180000 && prod.pricing.priceCents === 390000 && prod.status === "draft" && prod.source.listPriceCents === 351600, JSON.stringify(prod.pricing));
    });

    await step("7. the staff designer draws Swan products on the example bathroom and prices them", async () => {
      const StudioDesign = require("../models/studio/StudioDesign");
      const created = await api("POST", "/api/admin/studio/designs", users.owner, { projectType: "shower-replacement", customer: { name: "QA Swan" } });
      must(created.status === 201, JSON.stringify(created.body));
      const id = created.body.design.id;
      await StudioDesign.updateOne({ publicId: id }, { $set: { exampleScene: "example-bathroom-1", measureSource: "standard" } });
      await p.goto(`${FE}/admin?tab=studio&design=${id}`, { waitUntil: "domcontentloaded" });
      await p.locator('[data-testid="studio-editor"]').waitFor({ timeout: 120000 });
      await p.locator('[data-testid="base-VP6030CPANNSL.010"]').click({ timeout: 120000 });
      await p.locator('[data-testid="finish-TSMK843062.221"]').click({ timeout: 60000 });
      await p.waitForTimeout(4000);
      await p.screenshot({ path: path.join(OUT, "7-designer-swan.png"), fullPage: true });
      await p.getByRole("button", { name: "Design", exact: true }).click();
      await p.waitForTimeout(5000);
      await p.screenshot({ path: path.join(OUT, "7b-designer-swan-view.png") });
      const r = await api("GET", `/api/admin/studio/designs/${id}`, users.owner);
      const names = JSON.stringify(r.body.catalog.finishes.map((f) => f.id));
      must(names.includes("TSMK843062.221"), "Swan wall in the staff catalog");
      const price = await p.locator('[data-testid="studio-price"]').innerText();
      return { priceBox: price.replace(/\s+/g, " ").slice(0, 160) };
    });

    await step("8. nothing from Swan reaches the public catalog; employees without catalog access are refused", async () => {
      const pub = await api("GET", "/api/studio/catalog");
      const t = JSON.stringify(pub.body);
      // (the hand-researched starter products already cite manufacturer spec pages; Swan data must not appear)
      const swanUrls = (await api("GET", "/api/admin/studio/products", users.owner)).body.products.filter((x) => x.source?.manufacturer).flatMap((x) => (x.externalMedia || []).map((m) => m.url));
      must(swanUrls.length > 0, "Swan products have manufacturer links");
      must(!/TSMK843062|VP6030C|SR03260|BF05024|listPrice|costCents/.test(t), "no Swan products, list prices or costs");
      must(!swanUrls.some((u) => t.includes(u)), "no Swan media links");
      for (const u of [users.seller, users.outsider]) {
        const r = await api("GET", "/api/admin/studio/manufacturers", u);
        must(r.status === 403, `${u.email}: ${r.status}`);
      }
    });

    await step("9. phone layout: the manufacturer catalog fits a phone screen", async () => {
      const m = await page(users.owner, { width: 390, height: 844 }, "phone");
      await m.goto(`${FE}/admin?tab=studio-catalog`, { waitUntil: "domcontentloaded", timeout: 180000 });
      await m.click('[data-testid="catalog-tab-manufacturers"]', { timeout: 120000 });
      await m.locator('[data-testid="mfr-series"]').first().waitFor({ timeout: 60000 });
      const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      await m.screenshot({ path: path.join(OUT, "9-phone.png"), fullPage: false });
      must(overflow <= 1, `page scrolls sideways by ${overflow}px`);
    });

    await step("10. no browser errors", async () => { must(!errors.length, errors.join("\n")); });
  } finally {
    await browser.close();
    await demo.stop();
  }
  console.log(`\n${failed ? `${failed} step(s) failed` : "all steps passed"}. Screenshots: ${OUT}`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await demo.stop(); } catch { /* ignore */ } process.exit(1); });
