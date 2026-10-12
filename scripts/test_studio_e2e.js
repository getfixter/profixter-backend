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

    // ------------------------------------------------------------------ 3-8 homeowner on a phone: NO photo, NO measurements
    const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
    const phone = await ctxFor(null, { ...mobile, label: "homeowner" });
    const hp = phone.page;
    const shot = (n) => hp.screenshot({ path: path.join(OUT, `phone-${n}.png`) });
    const strip = () => hp.textContent('[data-testid="price-strip"]').then((t) => (t || "").trim());
    const waitStrip = async (want) => {
      await hp.waitForFunction((w) => (document.querySelector('[data-testid="price-strip"]')?.textContent || "").trim() === w, want, { timeout: 30000 })
        .catch(async () => { throw new Error(`price strip "${await strip()}", expected "${want}"`); });
    };
    // a real render: the badge shows (engine ready) and the preview canvas has the photo's size (a blank canvas is 300 px wide)
    const rendered = (p) => p.waitForFunction(() => { const c = document.querySelector("[data-studio-after]"); return document.querySelector('[data-testid="picture-badge"]') && c && c.width !== 300 && c.width > 0 && !document.querySelector('[role="status"].absolute'); }, null, { timeout: 120000 });

    await step("3. starting from an example SHOWER: no photo, no measurements, no account - the design appears right away", async () => {
      await hp.goto(`${FE}/shower-studio`, { waitUntil: "domcontentloaded", timeout: 180000 });
      await hp.waitForSelector('[data-testid="start-shower"]', { timeout: 120000 });
      await shot("0-start");
      const t0 = Date.now();
      await hp.tap('[data-testid="start-shower"]');
      await rendered(hp);
      const ms = Date.now() - t0;
      const badge = await hp.textContent('[data-testid="picture-badge"]');
      must(/Example bathroom/.test(badge) && /standard 60″ × 30″ size/.test(badge), `badge "${badge}"`);
      must(await hp.locator('[data-testid="photo-input"]').count() === 0, "no photo upload is shown up front");
      must(!(await hp.locator('[data-testid="m-facingWidth"]').count()), "no measurement form is shown up front");
      const scrollW = await hp.evaluate(() => document.scrollingElement.scrollWidth);
      must(scrollW <= 390, `page scrolls sideways (${scrollW})`);
      await waitStrip("$7,650.00"); // 4600 base + 900 pan + 1200 white walls + 350 trim + 600 paint above, all TEST prices
      await shot("1-customize");
      return { firstPictureMs: ms };
    });

    let total;
    await step("6-7. editing selections (walls, door, the owner's new grab bar) updates the picture and the total", async () => {
      await hp.getByRole("tab", { name: "Walls" }).tap();
      await hp.tap('[data-testid="finish-qwall-vs-black"]');
      await waitStrip("$7,650.00"); // black and white kits are the same TEST price
      await hp.getByRole("tab", { name: "Door" }).tap();
      await hp.tap('[data-testid="enclosure-duet-6072"]');
      await waitStrip("$8,850.00"); // + 950 door + 250 door installation
      await hp.getByRole("tab", { name: "Extras" }).tap();
      await hp.tap('[data-testid="add-grabBar"]');
      await hp.getByRole("button", { name: /Left wall ·/ }).first().tap();
      await hp.locator("select").filter({ hasText: "QA 30in Grab Bar" }).first().selectOption({ label: "QA 30in Grab Bar" });
      await waitStrip("$9,099.00"); // + 99 QA bar + 150 grab-bar blocking
      await rendered(hp);
      await shot("2-edited");
      total = await strip();
      return { total };
    });

    await step("7b. design & price: labelled an ESTIMATE on a standard example size, the example clearly marked", async () => {
      await hp.getByRole("button", { name: "View design & price" }).tap();
      await hp.waitForSelector('[data-testid="price-card"]');
      const label = (await hp.textContent('[data-testid="price-label"]')).trim();
      const amount = (await hp.textContent('[data-testid="price-total"]')).trim();
      const basis = (await hp.textContent('[data-testid="price-basis"]')).trim();
      must(/estimated total/i.test(label), `label "${label}"`);
      must(amount === "$9,099.00", `amount ${amount}`);
      must(/standard 60″ × 30″ example size, not your measurements/.test(basis), `basis "${basis}"`);
      must(await hp.locator('[data-testid="example-note"]').isVisible(), "example note missing");
      must(!/verified/i.test(await hp.textContent('[data-testid="price-card"]')), "public price called verified");
      await hp.waitForTimeout(900); // let the smooth scroll settle before the screenshot
      await shot("3-price");
    });

    await step("8. a complete request WITHOUT a photo (validated; one lead; nothing booked)", async () => {
      await hp.getByRole("button", { name: "Request installation" }).tap();
      await hp.tap('[data-testid="submit-request"]');
      await hp.getByText("Please enter your name.").waitFor();
      await hp.fill('input[name="name"]', "Hannah Homeowner");
      await hp.fill('input[name="phone"]', "631-555-0142");
      await hp.fill('input[name="email"]', "hannah.qa@example.com");
      await hp.fill('input[name="zip"]', "11787");
      await hp.tap('[data-testid="consent"]');
      await hp.tap('[data-testid="submit-request"]');
      await hp.waitForSelector('[data-testid="request-done"]', { timeout: 60000 });
      await shot("4-done");
      const local = JSON.parse(await hp.evaluate(() => localStorage.getItem("profixter:shower-studio:design")));
      const d = await (await fetch(`${BE}/api/studio/designs/${local.id}`, { headers: { "X-Studio-Token": local.token } })).json();
      must(d.status === "submitted" && !d.photo && d.exampleScene === "example-bathroom-1" && d.measureSource === "standard", JSON.stringify({ s: d.status, p: d.photo, e: d.exampleScene, m: d.measureSource }));
    });

    await step("3b. starting from an example BATHTUB: a tub is chosen, priced as a bathtub replacement", async () => {
      const p = (await ctxFor(null, { ...mobile, label: "tub" })).page;
      await p.goto(`${FE}/shower-studio`, { waitUntil: "domcontentloaded", timeout: 180000 });
      await p.tap('[data-testid="start-tub"]', { timeout: 120000 });
      await rendered(p);
      await p.getByRole("tab", { name: "Base" }).tap();
      const tubPicked = await p.locator('[data-testid^="base-"][aria-pressed="true"]').getAttribute("data-testid");
      must(/prism|studio/.test(tubPicked || ""), `selected base ${tubPicked}`);
      must((await p.locator('[data-testid="kind-tub"]').getAttribute("aria-pressed")) === "true", "bathtub not selected");
      await p.waitForFunction(() => /\$/.test(document.querySelector('[data-testid="price-strip"]')?.textContent || ""), null, { timeout: 30000 });
      const t = (await p.textContent('[data-testid="price-strip"]')).trim();
      must(t === "$6,850.00", `tub total ${t}`); // 3800 base + 900 tub + 1200 tub walls + 350 trim + 600 paint above (TEST prices)
      await p.getByRole("tab", { name: "Walls" }).tap();
      must(await p.locator('[data-testid="finish-qwall-tub-white"]').count() === 1, "tub wall kit offered");
      await p.screenshot({ path: path.join(OUT, "phone-tub.png") });
      return { total: t, base: tubPicked };
    });

    await step("5b. optional: the customer's own measurements change the price basis (still an estimate)", async () => {
      const p = (await ctxFor(null, { ...mobile, label: "measure" })).page;
      await p.goto(`${FE}/shower-studio`, { waitUntil: "domcontentloaded", timeout: 180000 });
      await p.tap('[data-testid="start-shower"]', { timeout: 120000 });
      await rendered(p);
      await p.tap('[data-testid="open-measure"]');
      await p.fill('[data-testid="m-facingWidth"]', "30");
      await p.fill('[data-testid="m-sideLength"]', "60");
      await p.fill('[data-testid="m-rimHeight"]', "16");
      await p.tap('[data-testid="apply-measure"]');
      await p.waitForFunction(() => /your measurements/.test(document.querySelector('[data-testid="picture-badge"]')?.textContent || ""), null, { timeout: 30000 });
      await p.getByRole("button", { name: "View design & price" }).tap();
      await p.waitForFunction(() => /measurements you entered/.test(document.querySelector('[data-testid="price-basis"]')?.textContent || ""), null, { timeout: 30000 });
      must(/estimated total/i.test(await p.textContent('[data-testid="price-label"]')), "still an estimate");
    });

    let photoDesign;
    await step("4. optional: the photo path still works (upload, alcove found, design kept, private photo)", async () => {
      const p = (await ctxFor(null, { ...mobile, label: "photo" })).page;
      await p.goto(`${FE}/shower-studio`, { waitUntil: "domcontentloaded", timeout: 180000 });
      await p.tap('[data-testid="start-shower"]', { timeout: 120000 });
      await rendered(p);
      await p.tap('[data-testid="open-photo"]');
      await p.setInputFiles('[data-testid="photo-input"]', PHOTO);
      await p.waitForFunction(() => document.querySelectorAll("[data-studio-photo] svg circle").length >= 6, null, { timeout: 120000 });
      await p.screenshot({ path: path.join(OUT, "phone-photo-dots.png") });
      await p.tap('[data-testid="photo-done"]');
      await p.waitForFunction(() => /Your photo/.test(document.querySelector('[data-testid="picture-badge"]')?.textContent || ""), null, { timeout: 30000 });
      photoDesign = JSON.parse(await p.evaluate(() => localStorage.getItem("profixter:shower-studio:design")));
      const d = await (await fetch(`${BE}/api/studio/designs/${photoDesign.id}`, { headers: { "X-Studio-Token": photoDesign.token } })).json();
      must(d.photo?.url && d.exampleScene === null, JSON.stringify({ photo: Boolean(d.photo), ex: d.exampleScene }));
      photoDesign.photoUrl = d.photo.url;
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
      await tp.waitForFunction(() => /\$9,099/.test(document.querySelector('[data-testid="studio-total"]')?.textContent || ""), null, { timeout: 30000 });
      const before = await tp.textContent('[data-testid="studio-measure-source"]');
      must(/Standard example size \(not measured\)/.test(before), `staff label "${before}"`);
      await tp.fill('[data-testid="studio-m-facingWidth"]', "30.25");
      await tp.press('[data-testid="studio-m-facingWidth"]', "Tab");
      await tp.check('[data-testid="studio-verified"]');
      await tp.click('[data-testid="studio-save"]');
      await tp.getByText("Saved. A revision was recorded.").waitFor({ timeout: 30000 });
      await tp.waitForFunction(() => /Verified on site/.test(document.querySelector('[data-testid="studio-measure-source"]')?.textContent || ""), null, { timeout: 30000 });
      await tp.screenshot({ path: path.join(OUT, "tablet-editor.png"), fullPage: true });
    });
    await step("10b. salesperson adds an installation adder; discounts are not offered without price-adjust access", async () => {
      const wide = await tp.evaluate(() => document.scrollingElement.scrollWidth);
      must(wide <= 820, `editor scrolls sideways on a tablet (${wide}px)`);
      const kinds = await tp.locator('[data-testid="adj-kind"] option').allTextContents();
      must(!kinds.some((k) => /Discount|Set the total/.test(k)), `seller sees ${kinds.join(",")}`);
      await tp.locator('[data-testid="adj-add"]').scrollIntoViewIfNeeded();
      await tp.tap('[data-testid="adj-add"]');
      await tp.waitForFunction(() => /\$9,599/.test(document.querySelector('[data-testid="studio-total"]')?.textContent || ""), null, { timeout: 30000 });
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
      must(photoDesign?.photoUrl, "no photo design to check");
      const url = photoDesign.photoUrl;
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
    await step("14. incomplete prices: the public sees 'Price confirmed after review.' and never a number", async () => {
      const list = await api("GET", "/api/admin/studio/products?status=published", users.owner);
      const white = list.body.products.find((p) => p.sku === "qwall-vs-white");
      const cleared = await api("PUT", `/api/admin/studio/products/${white._id}`, users.owner, { pricing: { priceCents: null, installCents: 0 } });
      must(cleared.status === 200, `clear price ${cleared.status}`);
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const p = (await ctxFor(null, { ...mobile, label: "pending" })).page;
        await p.goto(`${FE}/shower-studio`, { waitUntil: "domcontentloaded", timeout: 180000 });
        await p.tap('[data-testid="start-shower"]', { timeout: 120000 });
        await rendered(p);
        await p.waitForFunction(() => (document.querySelector('[data-testid="price-strip"]')?.textContent || "").trim() === "Price confirmed after review.", null, { timeout: 30000 });
        await p.getByRole("button", { name: "View design & price" }).tap();
        const card = await p.textContent('[data-testid="price-card"]');
        must(card.includes("Price confirmed after review.") && !/\$\d/.test(card), `price card "${card}"`);
        await p.getByRole("button", { name: "Request installation" }).tap();
        must((await p.textContent('[data-testid="request-price"]')).trim() === "Price confirmed after review.", "request form shows a number");
        await p.screenshot({ path: path.join(OUT, "phone-price-pending.png") });
      } finally {
        await api("PUT", `/api/admin/studio/products/${white._id}`, users.owner, { pricing: { priceCents: 120000, installCents: 0 } });
      }
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
