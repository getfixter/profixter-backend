/**
 * Visual check of the customer Studio (owner preview, demo catalog, public
 * Studio off): walk-in shower and bathtub on phone, iPad and desktop, each
 * section opened, screenshots in the temp folder.
 *   node scripts/shot_studio_scene.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "..", "FrontEnd", "node_modules", "playwright"));
const demo = require("./studio_demo_env");
const OUT = path.join(os.tmpdir(), "studio-scene");
fs.mkdirSync(OUT, { recursive: true });

// scroll an element to just below the sticky picture (where a customer sees it), not behind it
const reveal = (p, sel) => p.evaluate((q) => {
  const el = document.querySelector(q); if (!el) return;
  const sticky = [...document.querySelectorAll("section")].find((x) => getComputedStyle(x).position === "sticky");
  const top = sticky ? sticky.getBoundingClientRect().bottom : 0;
  window.scrollBy(0, el.getBoundingClientRect().top - top - 8);
}, sel);

(async () => {
  const env = await demo.start({ publicEnabled: false });
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors = [];
  try {
    for (const [w, h, label, touch] of [[390, 844, "phone", true], [820, 1180, "ipad", true], [1440, 900, "desktop", false]]) {
      for (const kind of ["shower", "tub"]) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: touch, hasTouch: touch });
        await ctx.addInitScript(([t]) => { localStorage.setItem("token", t); }, [env.users.owner.token]);
        const p = await ctx.newPage();
        p.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
        await p.goto(`${env.FRONTEND_URL}/shower-studio/preview`, { waitUntil: "domcontentloaded", timeout: 180000 });
        await p.locator(`[data-testid="start-${kind}"]`).click({ timeout: 120000 });
        await p.waitForFunction(() => /\$\d/.test(document.querySelector('[data-testid="price-strip"]')?.textContent || ""), null, { timeout: 120000 }).catch(() => {});
        await p.waitForTimeout(2500);
        await p.screenshot({ path: path.join(OUT, `${label}-${kind}-1.png`) });
        await p.screenshot({ path: path.join(OUT, `${label}-${kind}-1-full.png`), fullPage: true });
        for (const sec of ["base", "fixture", "door", "extras"]) {
          await p.locator(`[data-testid="section-${sec}"]`).dispatchEvent("click");
          await p.waitForTimeout(1800);
          await reveal(p, `[data-testid="section-${sec}"]`);
          await p.screenshot({ path: path.join(OUT, `${label}-${kind}-${sec}.png`) });
        }
        // pick a pricier fixture: the others must then show savings ("-$") and the chosen one "Selected"
        await p.locator('[data-testid="section-fixture"]').dispatchEvent("click");
        await p.waitForTimeout(1800);
        const plus = p.locator('[data-testid^="fixture-"][data-testid$="-delta"]', { hasText: "+$" }).first();
        const pickId = (await plus.getAttribute("data-testid")).replace(/-delta$/, "");
        await p.locator(`[data-testid="${pickId}"]`).dispatchEvent("click");
        await p.waitForFunction(() => [...document.querySelectorAll('[data-testid^="fixture-"][data-testid$="-delta"]')].some((e) => /-\$/.test(e.textContent || "")), null, { timeout: 30000 }).catch(() => {});
        await p.waitForTimeout(1500);
        await reveal(p, `[data-testid="${pickId}"]`);
        await p.screenshot({ path: path.join(OUT, `${label}-${kind}-fixture-picked.png`) });
        const after = await p.locator('[data-testid^="fixture-"][data-testid$="-delta"]').allInnerTexts();
        console.log(label, kind, "after picking", pickId, "->", after.join(" | "), "| total", await p.textContent('[data-testid="price-strip"]'));
        const deltas = await p.locator('[data-testid$="-delta"]').allInnerTexts();
        const canvas = await p.locator("[data-studio-after]").boundingBox();
        const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        console.log(label, kind, "picture", canvas ? `${Math.round(canvas.width)}x${Math.round(canvas.height)}` : "none", "overflow", over, "deltas", deltas.slice(0, 8).join(" | "));
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    await demo.stop();
  }
  console.log(errors.length ? `errors: ${errors.join(" | ")}` : "no page errors", OUT);
  process.exit(0);
})();
