/**
 * The owner's live preview (/shower-studio/preview) in a browser, with the
 * public Studio switched OFF exactly as in production: owner on phone, iPad
 * and desktop; employees and visitors refused; prices recalculate; the test
 * request is checked and nothing is stored or sent.
 *
 *   node scripts/test_studio_preview_ui.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "..", "FrontEnd", "node_modules", "playwright"));
const demo = require("./studio_demo_env");

const OUT = path.join(os.tmpdir(), "studio-preview-ui");
fs.mkdirSync(OUT, { recursive: true });
let failed = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try { const info = await fn(); console.log(`  PASS  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)${info ? "  " + JSON.stringify(info) : ""}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n").slice(0, 3).join("\n        ")}`); }
}
const must = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  const env = await demo.start({ publicEnabled: false });
  const { FRONTEND_URL: FE, BACKEND_URL: BE, users, mail } = env;
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors = [];
  async function device(user, viewport, label, touch) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: Boolean(touch), hasTouch: Boolean(touch) });
    if (user) await ctx.addInitScript(([t]) => { localStorage.setItem("token", t); }, [user.token]);
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
    return p;
  }
  const mongoose = require("mongoose");
  const counts = async () => ({ leads: await mongoose.connection.db.collection("estimateleads").countDocuments(), designs: await mongoose.connection.db.collection("studiodesigns").countDocuments(), photos: await mongoose.connection.db.collection("studiophotos").countDocuments() });
  // open one configurator section (they are an accordion: tapping an open one closes it)
  const openSec = async (p, id) => { const b = p.locator(`[data-testid="section-${id}"]`); if ((await b.getAttribute("aria-expanded")) !== "true") await b.click(); await p.waitForTimeout(500); };
  const card = (prefix) => `[data-testid^="${prefix}"]:not([data-testid$="-delta"])`;
  const strip = (p) => p.textContent('[data-testid="price-strip"]').then((t) => (t || "").replace(/\s+/g, " ").trim());

  async function journey(p, label, kind) {
    const t0 = Date.now();
    const shot = (n) => p.screenshot({ path: path.join(OUT, `${label}-${n}.png`) });
    await p.goto(`${FE}/shower-studio/preview`, { waitUntil: "domcontentloaded", timeout: 180000 });
    await p.locator(`[data-testid="start-${kind}"]`).waitFor({ timeout: 120000 });
    must(/OWNER PREVIEW/.test(await p.locator('[data-testid="demo-banner"]').innerText()), "owner preview banner");
    await shot("1-start");
    await p.locator(`[data-testid="start-${kind}"]`).click();
    await p.waitForFunction(() => /\$\d/.test(document.querySelector('[data-testid="price-strip"]')?.textContent || ""), null, { timeout: 90000 });
    const price0 = await strip(p);
    await shot("2-design");
    await p.locator(card("family-finish-")).nth(1).click();
    await p.locator('[data-testid="variants-finish"] button').last().click();
    await openSec(p, "extras");
    await p.locator(card("acc-")).first().click();
    await p.waitForTimeout(1200);
    const price1 = await strip(p);
    must(price0 !== price1, `price did not change (${price0})`);
    await shot("3-changed");
    await p.getByRole("button", { name: "View design & price" }).click();
    await p.locator('[data-testid="price-card"]').waitFor({ timeout: 30000 });
    must(/DEMO PRICE/.test(await p.locator('[data-testid="price-card"]').innerText()), "DEMO PRICE on the result");
    await p.getByRole("button", { name: "Request installation" }).click();
    await p.fill('input[name="name"]', `Owner Test (${label})`);
    await p.fill('input[name="phone"]', "631-555-0142");
    await p.fill('input[name="email"]', `owner.${label}@example.com`);
    await p.fill('input[name="zip"]', "11787");
    await p.locator('[data-testid="consent"]').check();
    await p.locator('[data-testid="submit-request"]').click();
    await p.locator('[data-testid="preview-not-sent"]').waitFor({ timeout: 30000 });
    must(/DEMO-/.test(await p.locator('[data-testid="request-done"]').innerText()), "DEMO reference");
    await shot("4-done");
    const o = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    must(o <= 1, `scrolls sideways ${o}px`);
    return { seconds: Math.round((Date.now() - t0) / 100) / 10, prices: [price0, price1] };
  }

  try {
    const before = await counts();
    await step("owner on a phone: bathtub, change walls and extras, price updates, test request", async () => journey(await device(users.owner, { width: 390, height: 844 }, "phone", true), "phone", "tub"));
    await step("owner on an iPad: walk-in shower, test request", async () => journey(await device(users.owner, { width: 820, height: 1180 }, "ipad", true), "ipad", "shower"));
    await step("owner on a desktop: walk-in shower, test request", async () => journey(await device(users.owner, { width: 1440, height: 900 }, "desktop", false), "desktop", "shower"));
    await step("nothing was stored or sent: no lead, no design, no photo, no email", async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const after = await counts();
      must(JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      must(mail.length === 0, `emails: ${mail.length}`);
    });
    await step("an employee (even with Studio access) sees no preview; the API refuses them", async () => {
      const p = await device(users.seller, { width: 390, height: 844 }, "seller", true);
      await p.goto(`${FE}/shower-studio/preview`, { waitUntil: "domcontentloaded" });
      await p.getByText("This preview is for the Profixter owner account only.").waitFor({ timeout: 60000 });
      must(!(await p.locator('[data-testid="start-shower"]').count()), "no studio for employees");
      for (const u of [users.seller, users.cataloger, users.customer]) {
        const r = await fetch(`${BE}/api/studio-preview/catalog`, { headers: { Authorization: `Bearer ${u.token}` } });
        must(r.status === 403, `${u.email}: ${r.status}`);
      }
    });
    await step("a visitor (not signed in) gets nothing: the API answers 401 and the page sends them to sign in", async () => {
      must((await fetch(`${BE}/api/studio-preview/catalog`)).status === 401, "401");
      const p = await device(null, { width: 390, height: 844 }, "visitor", true);
      await p.goto(`${FE}/shower-studio/preview`, { waitUntil: "domcontentloaded" });
      await p.waitForURL(/\/signin/, { timeout: 60000 });
    });
    await step("the public Studio stays dark (coming soon) while the preview works", async () => {
      const p = await device(null, { width: 390, height: 844 }, "public", true);
      await p.goto(`${FE}/shower-studio`, { waitUntil: "domcontentloaded" });
      await p.getByText("Shower Studio is coming soon").waitFor({ timeout: 60000 });
      const r = await (await fetch(`${BE}/api/studio/catalog`)).json();
      must(r.enabled === false, "public catalog off");
    });
    await step("no browser errors", async () => { must(!errors.length, errors.join("\n")); });
  } finally {
    await browser.close();
    await demo.stop();
  }
  console.log(`\n${failed ? `${failed} step(s) failed` : "all steps passed"}. Screenshots: ${OUT}`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await demo.stop(); } catch { /* ignore */ } process.exit(1); });
