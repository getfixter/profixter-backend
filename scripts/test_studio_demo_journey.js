/**
 * The homeowner journey on the owner's DEMO stack (curated catalog, DEMO
 * prices, optimized build, reachable on this Wi-Fi) - phone, tablet and
 * desktop, timed, with screenshots. Nothing leaves this computer: in-memory
 * database, emails caught locally, no AWS.
 *
 *   node scripts/test_studio_demo_journey.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "..", "FrontEnd", "node_modules", "playwright"));
const demo = require("./studio_demo_env");

const OUT = path.join(os.tmpdir(), "studio-demo-journey");
fs.mkdirSync(OUT, { recursive: true });
let failed = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try { const info = await fn(); console.log(`  PASS  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)${info ? "  " + JSON.stringify(info) : ""}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n").slice(0, 3).join("\n        ")}`); }
}
const must = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  const env = await demo.start({ demo: true });
  const { FRONTEND_URL: FE, BACKEND_URL: BE, mail } = env;
  console.log(`  demo site: ${FE}/shower-studio`);
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors = [];
  async function device(viewport, label, touch) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: Boolean(touch), hasTouch: Boolean(touch) });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
    p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR_/.test(m.text())) errors.push(`${label} console: ${m.text().slice(0, 200)}`); });
    return p;
  }
  const strip = (p) => p.textContent('[data-testid="price-strip"]').then((t) => (t || "").replace(/\s+/g, " ").trim());
  const tap = (p, sel) => p.locator(sel).first().click();
  const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  /** The whole journey; returns timings. */
  async function journey(p, label, kind) {
    const t0 = Date.now();
    const shot = (n) => p.screenshot({ path: path.join(OUT, `${label}-${n}.png`) });
    await p.goto(`${FE}/shower-studio`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await p.locator(`[data-testid="start-${kind}"]`).waitFor({ timeout: 60000 });
    must(await p.locator('[data-testid="demo-banner"]').count(), "DEMO banner");
    await shot("1-start");
    await tap(p, `[data-testid="start-${kind}"]`);
    await p.waitForSelector('[data-testid="price-strip"]', { timeout: 60000 });
    await p.waitForFunction(() => /\$\d/.test(document.querySelector('[data-testid="price-strip"]')?.textContent || ""), null, { timeout: 60000 });
    const firstPicture = Date.now() - t0;
    const price0 = await strip(p);
    await shot("2-sample-bathroom");
    // walls: another finish family, then a colour
    const fams = p.locator('[data-testid^="family-finish-"]');
    must(await fams.count() >= 4, `4 wall finishes (${await fams.count()})`);
    await fams.nth(1).click();
    await p.locator('[data-testid="variants-finish"] button').last().click();
    await p.waitForTimeout(800);
    const price1 = await strip(p);
    await shot("3-walls");
    // base / tub
    await p.getByRole("tab", { name: "Base" }).click();
    const bases = p.locator('[data-testid^="family-base-"], [data-testid^="base-"]');
    must(await bases.count() >= 2, "2 bases or tubs");
    await bases.nth(1).click();
    await p.waitForTimeout(800);
    await shot("4-base");
    // faucet
    await p.getByRole("tab", { name: "Faucet" }).click();
    const fx = p.locator('[data-testid^="fixture-"]');
    must(await fx.count() >= 2, "2 fixture packages");
    await fx.nth(1).click();
    await p.waitForTimeout(600);
    // door
    await p.getByRole("tab", { name: "Door" }).click();
    await p.locator('[data-testid^="enclosure-"]').nth(1).click().catch(() => {});
    await p.waitForTimeout(600);
    await shot("5-door");
    // extras
    await p.getByRole("tab", { name: "Extras" }).click();
    const addBar = p.locator('[data-testid="add-grabBar"]');
    if (await addBar.isEnabled().catch(() => false)) await addBar.click();
    await p.waitForTimeout(1000);
    const price2 = await strip(p);
    await shot("6-extras");
    must(price0 !== price2 || price0 !== price1, `price never changed: ${price0}`);
    // result + request
    await p.getByRole("button", { name: "View design & price" }).click();
    await p.locator('[data-testid="price-card"]').waitFor({ timeout: 30000 });
    must(/DEMO PRICE/.test(await p.locator('[data-testid="price-card"]').innerText()), "the result says DEMO PRICE");
    await shot("7-result");
    await p.getByRole("button", { name: "Request installation" }).click();
    await p.fill('input[name="name"]', `Demo Homeowner (${label})`);
    await p.fill('input[name="phone"]', "631-555-0142");
    await p.fill('input[name="email"]', `demo.${label}@example.com`);
    await p.fill('input[name="zip"]', "11787");
    await p.locator('[data-testid="consent"]').check();
    await shot("8-request");
    const wait = 9000 - (Date.now() - t0); // the form refuses submissions faster than a person could design
    if (wait > 0) await p.waitForTimeout(wait);
    await tap(p, '[data-testid="submit-request"]');
    await p.waitForSelector('[data-testid="request-done"]', { timeout: 60000 });
    await shot("9-done");
    const o = await overflow(p);
    must(o <= 1, `page scrolls sideways by ${o}px`);
    return { firstPictureMs: firstPicture, totalSec: Math.round((Date.now() - t0) / 100) / 10, prices: [price0, price2] };
  }

  try {
    await step("catalog: curated demo set is what the public Studio offers (DEMO prices, no manufacturer images)", async () => {
      const r = await (await fetch(`${BE}/api/studio/catalog`)).json();
      const c = r.catalog;
      const fam = (list) => new Set(list.map((x) => x.family?.key || x.id)).size;
      const info = { wallFamilies: fam(c.finishes), walls: c.finishes.length, tubs: fam(c.bases.filter((b) => b.kind === "tub")), bases: fam(c.bases.filter((b) => b.kind === "pan")), fixtures: c.fixtures.length, doors: c.enclosures.length, extras: c.accessories.length };
      must(/DEMO PRICE/.test(r.disclaimer), "disclaimer says DEMO");
      // (the hand-researched starter products cite other makers' spec PDFs as sources; Swan media must not appear)
      const images = Object.values(c).filter(Array.isArray).flat().flatMap((x) => [x.photo, ...(x.photos || []).map((y) => y.url), x.texture?.url]).filter(Boolean);
      must(images.every((u) => u.includes("/api/studio/assets/")), `only Profixter-hosted images: ${images.find((u) => !u.includes("/api/studio/assets/"))}`);
      must(!/american-bath-group\/image\/upload[^"]*\/swan\/|salsify/.test(JSON.stringify(r)), "no Swan image links");
      must(info.tubs === 2 && info.bases === 2 && info.fixtures >= 4 && info.extras >= 4, JSON.stringify(info));
      return info;
    });
    await step("phone (390 × 844): bathtub journey, request sent", () => device({ width: 390, height: 844 }, "phone", true).then((p) => journey(p, "phone", "tub")));
    await step("iPad (820 × 1180): walk-in shower journey, request sent", () => device({ width: 820, height: 1180 }, "ipad", true).then((p) => journey(p, "ipad", "shower")));
    await step("desktop (1440 × 900): walk-in shower journey, request sent", () => device({ width: 1440, height: 900 }, "desktop", false).then((p) => journey(p, "desktop", "shower")));
    await step("requests were caught on this computer only (no email left it)", async () => {
      await new Promise((r) => setTimeout(r, 1500));
      must(mail.length >= 3, `caught ${mail.length}`);
      return { caught: mail.map((m) => m.subject) };
    });
    await step("error handling: the request form explains missing details instead of sending", async () => {
      const p = await device({ width: 390, height: 844 }, "errors", true);
      await p.goto(`${FE}/shower-studio`, { waitUntil: "domcontentloaded" });
      await tap(p, '[data-testid="start-shower"]');
      await p.waitForSelector('[data-testid="price-strip"]', { timeout: 60000 });
      await p.getByRole("button", { name: "View design & price" }).click();
      await p.getByRole("button", { name: "Request installation" }).click();
      await tap(p, '[data-testid="submit-request"]');
      await p.getByText("Please enter your name.").waitFor({ timeout: 10000 });
    });
    await step("no browser errors", async () => { must(!errors.length, errors.join("\n")); });
  } finally {
    await browser.close();
    await demo.stop();
  }
  console.log(`\n${failed ? `${failed} step(s) failed` : "all steps passed"}. Screenshots: ${OUT}`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await demo.stop(); } catch { /* ignore */ } process.exit(1); });
