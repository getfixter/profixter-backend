// Quick visual smoke run of the public Studio (phone). Screenshots to the temp folder.
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "..", "FrontEnd", "node_modules", "playwright"));
const demo = require("./studio_demo_env");

const PHOTO = process.env.STUDIO_TEST_PHOTO || "C:/Users/Taras/OneDrive/Fixter/shower-studio-poc/assets/photos/yellow-tile-alcove.jpg";
const OUT = path.join(os.tmpdir(), "studio-smoke");
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const env = await demo.start();
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push("pageerror " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console " + m.text().slice(0, 200)); });
    const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`), fullPage: false });
    await page.goto(`${env.FRONTEND_URL}/shower-studio`, { waitUntil: "networkidle", timeout: 180000 });
    await page.waitForSelector('[data-testid="start"]', { timeout: 120000 });
    await shot("1-start");
    await page.tap('[data-testid="start"]');
    await page.setInputFiles('[data-testid="photo-input"]', PHOTO);
    await page.waitForFunction(() => document.querySelector("[data-studio-photo] canvas")?.width > 0, null, { timeout: 120000 });
    await page.waitForTimeout(2500);
    await shot("2-photo");
    await page.getByRole("button", { name: "The dots look right" }).tap();
    await shot("3-measure");
    await page.getByRole("button", { name: "Continue" }).tap();
    await page.tap('[data-testid="type-tub-to-shower"]');
    await page.waitForTimeout(4000);
    await shot("4-customize");
    await page.getByRole("button", { name: "See my price" }).tap();
    await page.waitForTimeout(1500);
    await shot("5-price");
    console.log(JSON.stringify({ price: await page.textContent('[data-testid="price-total"]').catch(() => null), errors }, null, 1));
  } catch (e) {
    console.log("FAILED:", e.message, errors);
  } finally {
    await browser.close();
    await demo.stop();
  }
  console.log("screenshots in", OUT);
  process.exit(0);
})();
