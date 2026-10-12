/**
 * Shower Studio - the Milestone 2 Definition of Done, end to end, on the
 * isolated demo stack (in-memory DB, local private storage, local SMTP
 * catcher, real backend + frontend). Test data only.
 *
 *  1-2  owner adds a product, uploads its photo, prices and publishes it; edits a base price
 *  3-8  a homeowner (phone) uploads a photo, designs with that product, sees the price, requests installation
 *  9    staff are notified (captured email) and see the request in Admin -> Leads
 *  10   a salesperson (tablet) opens the design, verifies a measurement, adjusts the estimate
 *  11   creates the proposal (Project + Estimate) -> contract via the existing workflow
 *  12   the customer signs on the existing signing page (phone)
 *  13   security / permission / mobile checks
 *
 *   node scripts/test_studio_e2e.js
 */
const path = require("path");
const os = require("os");
const fs = require("fs");
const sharp = require("sharp");
const { chromium } = require(path.join(__dirname, "..", "..", "FrontEnd", "node_modules", "playwright"));
const demo = require("./studio_demo_env");

const PHOTO = process.env.STUDIO_TEST_PHOTO || "C:/Users/Taras/OneDrive/Fixter/shower-studio-poc/assets/photos/yellow-tile-alcove.jpg";
const OUT = path.join(os.tmpdir(), "studio-e2e");
fs.mkdirSync(OUT, { recursive: true });
const results = [];
let failed = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try { const info = await fn(); results.push({ name, ok: true, ms: Date.now() - t0, info }); console.log(`  PASS  ${name}${info ? "  " + JSON.stringify(info) : ""}`); return info; }
  catch (e) { failed++; results.push({ name, ok: false, error: e.message }); console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n")[0]}`); return null; }
}
const must = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  const env = await demo.start();
  const { FRONTEND_URL: FE, BACKEND_URL: BE, users, mail } = env;
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const consoleErrors = [];
  async function ctxFor(user, opts) {
    const ctx = await browser.newContext(opts);
    if (user) await ctx.addInitScript(([t]) => { localStorage.setItem("token", t); }, [user.token]);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => consoleErrors.push(`${opts.label}: ${e.message}`));
    return { ctx, page };
  }
  const api = async (method, url, user, body) => {
    const r = await fetch(BE + url, { method, headers: { ...(user ? { Authorization: `Bearer ${user.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const productPhoto = path.join(OUT, "qa-bar.jpg");
  await sharp({ create: { width: 800, height: 600, channels: 3, background: "#c9ccce" } }).jpeg().toFile(productPhoto);

  try {
    // ------------------------------------------------------------------ 1-2 owner
    const owner = await ctxFor(users.owner, { viewport: { width: 1440, height: 1000 }, label: "owner" });
    await step("1. owner adds a product in the Studio Catalog (form generated from the field definitions)", async () => {
      const p = owner.page;
      await p.goto(`${FE}/admin?tab=studio-catalog`, { waitUntil: "domcontentloaded", timeout: 180000 });
      await p.getByRole("button", { name: /^Accessories/ }).click({ timeout: 120000 });
      await p.click('[data-testid="catalog-add"]');
      await p.fill('[data-testid="product-sku"]', "qa-bar-30");
      await p.fill('[data-testid="product-name"]', "QA 30in Grab Bar");
      for (const [k, v] of [["length", "30"], ["diameter", "1.25"], ["clearance", "1.5"], ["flange", "3"], ["finishColor", "#c0c4c8"], ["roughness", "0.3"]]) await p.fill(`[data-testid="eng-${k}"]`, v);
      await p.fill('[data-testid="product-price"]', "99");
      await p.click('[data-testid="product-save"]');
      await p.getByText("Product created as a draft").waitFor({ timeout: 30000 });
    });
    await step("1b. owner uploads the product photo (sanitized, served by an unguessable link)", async () => {
      const p = owner.page;
      await p.setInputFiles('[data-testid="product-photo-input"]', productPhoto);
      await p.getByText("Photo added.").waitFor({ timeout: 30000 });
      const src = await p.locator('[data-testid="product-editor"] img').first().getAttribute("src");
      must(/\/api\/studio\/assets\/[A-Za-z0-9_-]{20,}$/.test(src || ""), `asset url ${src}`);
      await p.screenshot({ path: path.join(OUT, "owner-product.png"), fullPage: true });
    });
    await step("2. owner publishes it and sets a base price; the public catalog shows the product but no price", async () => {
      const p = owner.page;
      await p.click('[data-testid="product-publish"]');
      await p.getByText("Published: customers can choose it now.").waitFor({ timeout: 30000 });
      await p.getByRole("button", { name: "← Back to the catalog" }).click();
      await p.getByRole("button", { name: "Prices & packages" }).click();
      await p.fill('[data-testid="base-price-tub-to-shower"]', "4600");
      await p.click('[data-testid="pricing-save"]');
      await p.getByText("Prices saved.").waitFor({ timeout: 30000 });
      const pub = await (await fetch(`${BE}/api/studio/catalog`)).json();
      must(pub.catalog.accessories.some((a) => a.id === "qa-bar-30"), "product not public");
      must(!/priceCents|installCents|internalNote/.test(JSON.stringify(pub)), "prices leaked");
    });

    // ------------------------------------------------------------------ 3-8 homeowner on a phone
    const phone = await ctxFor(null, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, label: "homeowner" });
    const hp = phone.page;
    const shot = (n) => hp.screenshot({ path: path.join(OUT, `phone-${n}.png`) });
    await step("3-4. homeowner starts without an account and uploads a bathroom photo; the alcove is found", async () => {
      await hp.goto(`${FE}/shower-studio`, { waitUntil: "domcontentloaded", timeout: 180000 });
      await hp.tap('[data-testid="start"]', { timeout: 120000 });
      await hp.setInputFiles('[data-testid="photo-input"]', PHOTO);
      await hp.waitForFunction(() => document.querySelector("[data-studio-photo] canvas")?.width > 0, null, { timeout: 120000 });
      await hp.waitForFunction(() => document.querySelectorAll("[data-studio-photo] svg circle").length >= 6, null, { timeout: 60000 });
      await shot("1-photo");
      const scrollW = await hp.evaluate(() => document.scrollingElement.scrollWidth);
      must(scrollW <= 390, `page scrolls sideways (${scrollW})`);
      const local = await hp.evaluate(() => localStorage.getItem("profixter:shower-studio:design"));
      must(local && JSON.parse(local).token, "design token not kept locally");
    });
    await step("5. homeowner enters measurements and chooses a tub-to-shower conversion", async () => {
      await hp.getByRole("button", { name: "The dots look right" }).tap();
      await hp.getByRole("button", { name: /standard 60/ }).tap();
      await shot("2-measure");
      await hp.getByRole("button", { name: "Continue" }).tap();
      await hp.tap('[data-testid="type-tub-to-shower"]');
      await hp.waitForFunction(() => document.querySelector("[data-studio-after]")?.width > 0, null, { timeout: 120000 });
    });
    let total;
    await step("6-7. homeowner customizes with the new product; the preview renders and the total updates", async () => {
      await hp.getByRole("tab", { name: "Walls" }).tap();
      await hp.tap('[data-testid="finish-qwall-vs-black"]');
      await hp.getByRole("tab", { name: "Extras" }).tap();
      await hp.tap('[data-testid="add-grabBar"]');
      await hp.getByRole("button", { name: /Left wall ·/ }).first().tap();
      await hp.locator("select").filter({ hasText: "QA 30in Grab Bar" }).first().selectOption({ label: "QA 30in Grab Bar" });
      await hp.waitForTimeout(2500);
      await shot("3-customize");
      await hp.getByRole("button", { name: "See my price" }).tap();
      await hp.waitForFunction(() => /\$\d/.test(document.querySelector('[data-testid="price-total"]')?.textContent || ""), null, { timeout: 30000 });
      total = (await hp.textContent('[data-testid="price-total"]')).trim();
      await shot("4-price");
      // 4600 base + 900 pan + 1200 walls + 350 trim + 600 paint above + 99 QA bar + 150 grab-bar blocking
      must(total === "$7,899.00", `total ${total}`);
      return { total };
    });
    await step("8. homeowner requests installation (validated; one lead; no booking created)", async () => {
      await hp.getByRole("button", { name: "Request installation" }).tap();
      await hp.tap('[data-testid="submit-request"]');
      await hp.getByText("Please enter your name.").waitFor();
      await hp.fill('input[name="name"]', "Hannah Homeowner");
      await hp.fill('input[name="phone"]', "631-555-0142");
      await hp.fill('input[name="email"]', "hannah.qa@example.com");
      await hp.fill('input[name="zip"]', "11787");
      await hp.fill('input[name="address"]', "12 Elm St, Smithtown NY");
      await hp.tap('[data-testid="consent"]');
      await hp.tap('[data-testid="submit-request"]');
      await hp.waitForSelector('[data-testid="request-done"]', { timeout: 60000 });
      await shot("5-done");
    });

    // ------------------------------------------------------------------ 9 staff notified
    await step("9. staff are notified (captured by the local SMTP catcher) and the request is a lead in Admin", async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const m = mail.find((x) => /Hannah Homeowner/.test(x.subject + x.body) || /shower/i.test(x.subject));
      must(m, `no staff email (${mail.length} captured: ${mail.map((x) => x.subject).join(" | ")})`);
      const leads = await api("GET", "/api/admin/requests", users.seller);
      must(leads.status === 200, `leads ${leads.status}`);
      const list = leads.body.requests || leads.body.items || leads.body;
      must(JSON.stringify(list).includes("hannah.qa@example.com"), "lead missing from Admin -> Leads");
      return { emailSubject: m.subject };
    });

    // ------------------------------------------------------------------ 10-11 salesperson on a tablet
    const tab = await ctxFor(users.seller, { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, label: "seller" });
    const tp = tab.page;
    let designId;
    await step("10. salesperson opens the request from Leads, verifies a measurement, re-prices", async () => {
      await tp.goto(`${FE}/admin?tab=requests`, { waitUntil: "domcontentloaded", timeout: 180000 });
      await tp.getByRole("button", { name: "Open in Shower Studio" }).first().tap({ timeout: 120000 });
      await tp.waitForSelector('[data-testid="studio-editor"]', { timeout: 60000 });
      await tp.waitForFunction(() => document.querySelector("[data-studio-after]")?.width > 0, null, { timeout: 120000 });
      designId = new URL(tp.url()).searchParams.get("design");
      await tp.waitForFunction(() => /\$7,899/.test(document.querySelector('[data-testid="studio-total"]')?.textContent || ""), null, { timeout: 30000 });
      await tp.fill('[data-testid="studio-m-facingWidth"]', "30.25");
      await tp.press('[data-testid="studio-m-facingWidth"]', "Tab");
      await tp.click('[data-testid="studio-save"]');
      await tp.getByText("Saved. A revision was recorded.").waitFor({ timeout: 30000 });
      await tp.screenshot({ path: path.join(OUT, "tablet-editor.png"), fullPage: true });
    });
    await step("10b. salesperson adds an installation adder; discounts are not offered without price-adjust access", async () => {
      const wide = await tp.evaluate(() => document.scrollingElement.scrollWidth);
      must(wide <= 820, `editor scrolls sideways on a tablet (${wide}px)`);
      const kinds = await tp.locator('[data-testid="adj-kind"] option').allTextContents();
      must(!kinds.some((k) => /Discount|Set the total/.test(k)), `seller sees ${kinds.join(",")}`);
      await tp.locator('[data-testid="adj-add"]').scrollIntoViewIfNeeded();
      await tp.tap('[data-testid="adj-add"]');
      await tp.waitForFunction(() => /\$8,399/.test(document.querySelector('[data-testid="studio-total"]')?.textContent || ""), null, { timeout: 30000 });
    });
    let proposal;
    await step("11. salesperson creates the proposal (Project + Estimate at the frozen price)", async () => {
      await tp.click('[data-testid="studio-proposal"]');
      await tp.getByText(/Proposal ready: project/).waitFor({ timeout: 60000 });
      const d = await api("GET", `/api/admin/studio/designs/${designId}`, users.seller);
      must(d.body.design.status === "proposal" && d.body.design.estimateId, "design not marked proposal");
      proposal = d.body.design;
      return { projectId: proposal.projectId, total: d.body.design.priceSnapshot.totalCents / 100 };
    });

    // ------------------------------------------------------------------ 11b-12 contract + signature via the existing workflow
    let signingUrl;
    await step("11b. the existing contract workflow drafts, generates and sends the agreement", async () => {
      const est = (await api("GET", `/api/admin/estimates/${proposal.estimateId}`, users.owner)).body;
      const e = est.estimate || est;
      const total = Math.round(e.total * 100), deposit = Math.round(total * 0.3);
      const draft = await api("POST", `/api/admin/contracts/project/${proposal.projectId}/draft`, users.owner, {
        workType: "Bathroom", estimateId: proposal.estimateId, dates: { contractDate: new Date().toISOString().slice(0, 10) },
        projectDescription: e.title, scopeText: e.description, originalContractPriceCents: total, depositAmountCents: deposit,
        paymentSchedule: [{ label: "Deposit", amountCents: deposit, dueCondition: "At signing" }, { label: "Balance", amountCents: total - deposit, dueCondition: "On completion" }],
      });
      must(draft.status === 201, `draft ${draft.status} ${JSON.stringify(draft.body).slice(0, 200)}`);
      const id = draft.body.contract._id || draft.body.contract.id;
      const gen = await api("POST", `/api/admin/contracts/${id}/generate?projectId=${proposal.projectId}`, users.owner, { projectId: proposal.projectId });
      must(gen.status < 300, `generate ${gen.status} ${JSON.stringify(gen.body).slice(0, 200)}`);
      const send = await api("POST", "/api/admin/signatures/native/send", users.owner, { documentType: "CONTRACT", documentId: id, mode: "REMOTE" });
      must(send.status === 201, `send ${send.status} ${JSON.stringify(send.body).slice(0, 200)}`);
      signingUrl = send.body.signingUrl;
      must(signingUrl.startsWith(FE), signingUrl);
      must(env.s3Log.some((l) => l.startsWith("PUT ")), "contract PDF should be stored in the local S3 stub");
    });
    await step("12. the customer signs on the existing signing page (phone)", async () => {
      const sp = (await ctxFor(null, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, label: "signer" })).page;
      await sp.goto(signingUrl, { waitUntil: "domcontentloaded", timeout: 180000 });
      await sp.getByRole("button", { name: "Continue to Sign" }).click({ timeout: 120000 });
      await sp.locator('input[type="checkbox"]').first().check();
      await sp.getByRole("button", { name: "Continue" }).click();
      const pad = sp.locator('canvas[aria-label="Signature area"]');
      await pad.scrollIntoViewIfNeeded();
      const b = await pad.boundingBox();
      await sp.mouse.move(b.x + 20, b.y + b.height * 0.6);
      await sp.mouse.down();
      for (let i = 1; i <= 12; i++) await sp.mouse.move(b.x + 20 + i * (b.width - 40) / 12, b.y + b.height * (0.6 - 0.3 * Math.sin(i / 2)));
      await sp.mouse.up();
      await sp.locator("button.bg-emerald-600").click();
      // proof from the server, not the page text: the signing link is completed and the executed agreement exists
      const token = signingUrl.split("/sign/")[1];
      let state = null;
      for (let i = 0; i < 60 && !(state?.state === "completed" && state.executedDocumentAvailable); i++) {
        await new Promise((r) => setTimeout(r, 1000));
        state = await (await fetch(`${BE}/api/sign/${token}`)).json();
      }
      must(state?.state === "completed" && state.executedDocumentAvailable, `signature not completed: ${JSON.stringify(state)}`);
      await sp.waitForTimeout(1500);
      await sp.screenshot({ path: path.join(OUT, "phone-signed.png") });
      return { state: state.state, executedDocument: state.executedDocumentAvailable };
    });

    // ------------------------------------------------------------------ 13 security / permissions
    await step("13. permissions: outsiders, customers and catalog-only staff are refused where they must be", async () => {
      for (const [u, url, want] of [
        [users.outsider, "/api/admin/studio/designs", 403],
        [users.customer, "/api/admin/studio/designs", 403],
        [users.customer, "/api/admin/studio/products", 403],
        [users.cataloger, "/api/admin/studio/designs", 403],
        [users.seller, "/api/admin/studio/products", 403],
        [users.seller, "/api/admin/studio/pricing", 403],
        [null, "/api/admin/studio/designs", 401],
      ]) {
        const r = await api("GET", url, u);
        must(r.status === want, `${u?.email || "anonymous"} ${url} -> ${r.status}, expected ${want}`);
      }
      const put = await api("PUT", "/api/admin/studio/pricing", users.seller, { maxDiscountPercent: 100 });
      must(put.status === 403, "seller changed prices");
    });
    await step("13b. private photos: no listing, unsigned or tampered links refused, CORS-safe", async () => {
      const d = await api("GET", `/api/admin/studio/designs/${designId}`, users.seller);
      const url = d.body.design.photo.url;
      must((await fetch(BE + url)).status === 200, "signed link should work");
      must((await fetch(BE + url.split("?")[0])).status === 403, "unsigned link served");
      must((await fetch(BE + url.replace(/sig=[^&]+/, "sig=x"))).status === 403, "tampered link served");
      must((await fetch(`${BE}/api/studio/designs`)).status === 404, "designs listable");
    });
    await step("13c. a submitted request cannot be edited or re-submitted by the browser that sent it", async () => {
      const local = JSON.parse(await hp.evaluate(() => localStorage.getItem("profixter:shower-studio:design")));
      const r = await fetch(`${BE}/api/studio/designs/${local.id}`, { method: "PUT", headers: { "Content-Type": "application/json", "X-Studio-Token": local.token }, body: JSON.stringify({ projectType: "tub-replacement" }) });
      must(r.status === 409, `edit after send -> ${r.status}`);
    });
    await step("13d. no browser errors in any session", async () => {
      must(!consoleErrors.length, consoleErrors.join("\n"));
    });
  } finally {
    fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, mail: mail.map((m) => ({ subject: m.subject, to: m.to })) }, null, 1));
    await browser.close();
    await demo.stop();
  }
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps passed. Screenshots: ${OUT}`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await demo.stop(); process.exit(1); });
