/**
 * The customer Shower Studio experience in a real browser (owner preview,
 * demo catalog, public Studio OFF as in production):
 *   - drag-and-drop extras (move, refused spot, undo, nudge), plumbing side,
 *     full-screen preview (zoom, close), reload + continue;
 *   - the photo flow (camera vs library inputs, bad file, "is this the area?",
 *     corner-by-corner adjustment with magnifier and undo, faucet wall, back to
 *     the example);
 *   - layouts on 7 screen sizes (nothing scrolls sideways, picture and total visible);
 *   - photo detection on synthetic bathrooms with known corners (development
 *     build only: lib/studio/engine/lab.js);
 *   - measured timings, normal and with the CPU slowed 4x.
 *
 *   node scripts/test_studio_experience.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "..", "FrontEnd", "node_modules", "playwright"));
const demo = require("./studio_demo_env");

const OUT = path.join(os.tmpdir(), "studio-experience");
fs.mkdirSync(OUT, { recursive: true });
const PHOTO = process.env.STUDIO_TEST_PHOTO || "C:/Users/Taras/OneDrive/Fixter/shower-studio-poc/assets/photos/yellow-tile-alcove.jpg";
let failed = 0;
const timings = {};
async function step(name, fn) {
  const t0 = Date.now();
  try { const info = await fn(); console.log(`  PASS  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)${info ? "  " + JSON.stringify(info) : ""}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n").slice(0, 3).join("\n        ")}`); }
}
const must = (c, m) => { if (!c) throw new Error(m); };
const DEVICES = {
  "small iPhone (375×667)": { viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  "iPhone (390×844)": { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  "large iPhone (430×932)": { viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  "Android (412×915)": { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true },
  "iPad portrait (820×1180)": { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  "iPad landscape (1180×820)": { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  "desktop (1440×900)": { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};

(async () => {
  const env = await demo.start({ publicEnabled: false });
  const FE = env.FRONTEND_URL;
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors = [];
  const open = async (dev, label) => {
    const ctx = await browser.newContext(DEVICES[dev]);
    await ctx.addInitScript(([t]) => { localStorage.setItem("token", t); }, [env.users.owner.token]);
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
    return { ctx, p };
  };
  const ready = (p) => p.waitForFunction(() => window.__studioEngine?.S?.ready && window.__studioEngine.pipeline.sel && !window.__studioEngine.S.busy, null, { timeout: 180000 });
  const start = async (p, kind) => {
    await p.goto(`${FE}/shower-studio/preview`, { waitUntil: "domcontentloaded", timeout: 300000 });
    await p.locator(`[data-testid="start-${kind}"]`).click({ timeout: 300000 });
    await ready(p);
    await p.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  };

  // ---------------------------------------------------------------- interactions (phone)
  const { p } = await open("iPhone (390×844)", "phone");
  const E = (fn, arg) => p.evaluate(fn, arg);
  const toPage = async (x, y) => {
    const b = await p.locator('[data-testid="stage-surface"]').boundingBox();
    const img = await E(() => ({ w: window.__studioEngine.els.after.width, h: window.__studioEngine.els.after.height }));
    return [b.x + (x / img.w) * b.width, b.y + (y / img.h) * b.height];
  };
  await start(p, "shower");

  await step("extras: add a grab bar; it is drawn and gets a handle on the picture", async () => {
    await p.locator('[data-testid="tab-extras"]').click();
    await p.locator('[data-testid^="acc-"]:not([data-testid$="-delta"])').first().click();
    await p.waitForFunction(() => window.__studioEngine.S.design.accessories.length === 1, null, { timeout: 10000 });
    await ready(p);
    must((await E(() => window.__studioEngine.accessoryHandles())).length === 1, "no handle");
  });
  await step("extras: dragging on the picture moves the bar in the saved design and the rendering", async () => {
    const before = await E(() => ({ ...window.__studioEngine.S.design.accessories[0] }));
    const h = (await E(() => window.__studioEngine.accessoryHandles()))[0];
    const [x0, y0] = await toPage(h.x, h.y);
    const pix0 = await E(() => window.__studioEngine.els.after.toDataURL().length);
    const t0 = Date.now(); let frames = 0;
    await p.mouse.move(x0, y0); await p.mouse.down();
    for (let i = 1; i <= 12; i++) { await p.mouse.move(x0 + i * 4, y0 - i * 3); await p.waitForTimeout(40); frames++; }
    await p.mouse.up();
    timings.dragFrameMs = Math.round((Date.now() - t0) / frames);
    await p.waitForTimeout(800);
    const after = await E(() => ({ ...window.__studioEngine.S.design.accessories[0] }));
    must(after.u !== before.u || after.y !== before.y, "did not move");
    must((await E(() => window.__studioEngine.els.after.toDataURL().length)) !== pix0, "picture unchanged");
    return { from: [before.u, before.y], to: [after.u, after.y] };
  });
  await step("extras: a spot on the faucet is refused with a reason; the bar stays valid", async () => {
    const v = await E(() => { const e = window.__studioEngine, pw = e.plumbingWorld(); const P = e.wallPoint(pw.wall, pw.valve[0], pw.valve[1], 2); const c = e.pipeline.cam, R = c.R, t = c.t; const x = R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + t[0], y = R[3] * P[0] + R[4] * P[1] + R[5] * P[2] + t[1], z = R[6] * P[0] + R[7] * P[1] + R[8] * P[2] + t[2]; return [c.f * x / z + c.cx, c.f * y / z + c.cy]; });
    const h = (await E(() => window.__studioEngine.accessoryHandles()))[0];
    const [x0, y0] = await toPage(h.x, h.y), [x1, y1] = await toPage(v[0], v[1]);
    await p.mouse.move(x0, y0); await p.mouse.down();
    let saw = false;
    for (let i = 1; i <= 16; i++) { await p.mouse.move(x0 + ((x1 - x0) * i) / 16, y0 + ((y1 - y0) * i) / 16); await p.waitForTimeout(50); if (await p.locator("text=/Too close to/").count()) saw = true; }
    await p.mouse.up(); await p.waitForTimeout(500);
    const errs = await E(() => (window.__studioEngine.S.check?.errors || []).filter((x) => String(x.field).startsWith("accessory")).length);
    must(saw, "no 'too close' message");
    must(errs === 0, "left in an invalid spot");
  });
  await step("extras: undo, and the button alternative (nudge up 1\")", async () => {
    const cur = await E(() => ({ ...window.__studioEngine.S.design.accessories[0] }));
    await p.locator('[data-testid="undo-move"]').click(); await p.waitForTimeout(400);
    const back = await E(() => ({ ...window.__studioEngine.S.design.accessories[0] }));
    must(back.u !== cur.u || back.y !== cur.y, "undo did nothing");
    if (!(await p.getByRole("button", { name: "Move up" }).count())) await p.locator('[data-testid^="added-"] button').first().click();
    await p.getByRole("button", { name: "Move up" }).click(); await p.waitForTimeout(400);
    const up = await E(() => window.__studioEngine.S.design.accessories[0].y);
    must(Math.abs(up - back.y - 1) < 0.01, `nudge ${back.y} -> ${up}`);
  });
  await step("plumbing on the right: faucet on the right wall, drain and base follow, extras stay", async () => {
    await p.locator('[data-testid="tab-layout"]').click();
    await p.locator('[data-testid="plumbing-right"]').click();
    await ready(p);
    const d = await E(() => ({ w: window.__studioEngine.S.design.plumbing.wall, drain: window.__studioEngine.S.design.drainId, valve: window.__studioEngine.pipeline.valveWall.wall, acc: window.__studioEngine.S.design.accessories.length }));
    must(d.w === "right" && d.drain === "right" && d.valve === "right" && d.acc === 1, JSON.stringify(d));
    await p.screenshot({ path: path.join(OUT, "phone-plumbing-right.png") });
  });
  await step("full-screen preview: opens, double-tap zoom, Esc closes, no scrolling behind", async () => {
    await p.locator('[data-testid="open-preview"]').click();
    await p.locator('[data-testid="full-preview"]').waitFor();
    must(await E(() => document.body.style.overflow === "hidden"), "page scroll not locked");
    const b = await p.locator('[data-testid="preview-surface"]').boundingBox();
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await p.waitForTimeout(80); await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await p.waitForTimeout(300);
    must((await p.locator('[data-testid="zoom-level"]').innerText()) === "250%", "no zoom");
    await p.screenshot({ path: path.join(OUT, "phone-preview-zoomed.png") });
    await p.keyboard.press("Escape"); await p.waitForTimeout(300);
    must(!(await p.locator('[data-testid="full-preview"]').count()), "did not close");
  });
  await step("reload: Continue restores plumbing, base and the extra's position", async () => {
    const want = await E(() => JSON.stringify([window.__studioEngine.S.design.plumbing, window.__studioEngine.S.design.baseId, window.__studioEngine.S.design.accessories.map((x) => [x.productId, x.wall, x.u, x.y])]));
    await p.waitForTimeout(1600);
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.locator('[data-testid="resume"]').click({ timeout: 120000 });
    await ready(p);
    const got = await E(() => JSON.stringify([window.__studioEngine.S.design.plumbing, window.__studioEngine.S.design.baseId, window.__studioEngine.S.design.accessories.map((x) => [x.productId, x.wall, x.u, x.y])]));
    must(got === want, `${got} != ${want}`);
  });

  // ---------------------------------------------------------------- photo flow
  await step("photo: 'Take a photo' asks for the camera; 'Choose from your photos' does not", async () => {
    await p.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
    await p.locator('[data-testid="tab-layout"]').click();
    await p.locator('[data-testid="open-photo"]').click();
    const cam = await p.locator('[data-testid="photo-camera-input"]').getAttribute("capture");
    const lib = await p.locator('[data-testid="photo-input"]').getAttribute("capture");
    must(cam === "environment" && lib === null, `camera ${cam} library ${lib}`);
  });
  await step("photo: a file that is not a photo is refused in plain words", async () => {
    await p.setInputFiles('[data-testid="photo-input"]', { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello ".repeat(800)) });
    await p.locator('[role="dialog"] [role="alert"]').waitFor({ timeout: 20000 });
    must(/isn.t a photo/i.test(await p.locator('[role="dialog"] [role="alert"]').innerText()), "message");
  });
  const havePhoto = fs.existsSync(PHOTO);
  if (havePhoto) {
    await step("photo: library photo -> 'Is this the area?' with a 4-corner outline", async () => {
      await p.setInputFiles('[data-testid="photo-input"]', PHOTO);
      await p.locator('[data-testid="photo-confirm"]').waitFor({ timeout: 120000 });
      await p.waitForFunction(() => document.querySelectorAll("[data-studio-photo] svg circle[data-k]").length === 4, null, { timeout: 30000 });
      await p.screenshot({ path: path.join(OUT, "phone-photo-confirm.png") });
      return await E(() => ({ confidence: window.__studioEngine.S.suggestion?.confidence, believable: window.__studioEngine.photoCheck().ok }));
    });
    await step("photo: corner-by-corner adjustment (magnifier, undo), then it lines up", async () => {
      await p.locator('[data-testid="photo-adjust"]').click();
      const box = async () => { const b = await p.locator("[data-studio-photo]").boundingBox(); const [w, h] = await E(() => [window.__studioEngine.els.before.width, window.__studioEngine.els.before.height]); return (q) => [b.x + (q[0] / w) * b.width, b.y + (q[1] / h) * b.height]; };
      const at = await box();
      const m0 = await E(() => window.__studioEngine.S.marks.wallBL.slice());
      const [x, y] = at(m0);
      await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x + 14, y + 6, { steps: 6 });
      const loupe = await E(() => [...document.querySelectorAll("canvas")].some((c) => c.width === 128 && c.parentElement?.style.display === "block"));
      await p.mouse.up(); await p.waitForTimeout(400);
      must(loupe, "no magnifier while dragging");
      await p.getByRole("button", { name: "Undo" }).click();
      const m2 = await E(() => window.__studioEngine.S.marks.wallBL.slice());
      must(Math.hypot(m2[0] - m0[0], m2[1] - m0[1]) < 0.01, "undo did not restore the corner");
      // this photo's true corners, as a person would place them
      const target = { wallBL: [221, 703], wallBR: [412, 748], wallTR: [444, 140], wallTL: [220, 160] };
      for (const key of ["wallBL", "wallBR", "wallTR", "wallTL"]) {
        const to = await box();
        const cur = await E((k) => window.__studioEngine.S.marks[k].slice(), key);
        const [sx, sy] = to(cur), [tx, ty] = to(target[key]);
        await p.mouse.move(sx, sy); await p.mouse.down(); await p.mouse.move(tx, ty, { steps: 8 }); await p.mouse.up();
        await p.waitForTimeout(300);
        if (key !== "wallTL") await p.locator('[data-testid="corner-next"]').click();
      }
      const chk = await E(() => window.__studioEngine.photoCheck());
      must(chk.ok, "not believable after adjusting: " + JSON.stringify(chk));
      await p.locator('[data-testid="corner-done"]').click();
      await p.locator('[data-testid="photo-plumbing"]').waitFor();
    });
    await step("photo: faucet wall, then the new bathroom on the photo (the rest of the room unchanged)", async () => {
      await p.locator('[data-testid="photo-plumbing-facing"]').click();
      await p.locator('[data-testid="photo-finish"]').click();
      await ready(p);
      const r = await E(() => {
        const e = window.__studioEngine, a = e.els.after.getContext("2d").getImageData(0, 0, e.els.after.width, e.els.after.height).data, b = e.pipeline.photo.data;
        // the top-right corner of the photo (window, outside the tub area) must be the original pixels
        let diff = 0, n = 0;
        for (let y = 10; y < 120; y += 3) for (let x = e.els.after.width - 120; x < e.els.after.width - 10; x += 3) { const i = (y * e.els.after.width + x) * 4; diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n++; }
        return { model: Boolean(e.S.model), wall: e.S.design.plumbing?.wall, outsideDiff: diff / n };
      });
      must(!r.model && r.wall === "facing", JSON.stringify(r));
      must(r.outsideDiff < 1, `room outside the tub area changed (${r.outsideDiff})`);
      await p.screenshot({ path: path.join(OUT, "phone-photo-result.png") });
      return r;
    });
    await step("photo: back to the example keeps the product choices", async () => {
      const before = await E(() => [window.__studioEngine.S.design.finishId, window.__studioEngine.S.design.fixtureId]);
      await p.locator('[data-testid="tab-layout"]').click();
      await p.locator('[data-testid="open-photo"]').click();
      await p.locator('[data-testid="photo-use-example"]').click();
      await ready(p);
      const after = await E(() => [window.__studioEngine.S.design.finishId, window.__studioEngine.S.design.fixtureId, Boolean(window.__studioEngine.S.model)]);
      must(after[2] && after[0] === before[0] && after[1] === before[1], JSON.stringify({ before, after }));
    });
  } else console.log(`  SKIP  real-photo steps (no test photo at ${PHOTO})`);

  // ---------------------------------------------------------------- photo detection on synthetic bathrooms
  await step("photo detection: synthetic bathrooms with known corners (12 views must line up)", async () => {
    await p.waitForFunction(() => window.__studioLab, null, { timeout: 60000 });
    const D = 30;
    const cases = [
      ["front, centre", { camera: { x: 30, y: 55, z: D + 95, fovY: 62 } }], ["front, from the left", { camera: { x: 8, y: 55, z: D + 95, fovY: 62 } }],
      ["front, from the right", { camera: { x: 52, y: 55, z: D + 95, fovY: 62 } }], ["low camera", { camera: { x: 30, y: 38, z: D + 90, fovY: 62, ty: 46 } }],
      ["high camera", { camera: { x: 30, y: 68, z: D + 90, fovY: 62, ty: 38 } }], ["close, wide lens", { camera: { x: 30, y: 52, z: D + 55, fovY: 76 } }],
      ["far, narrow lens", { camera: { x: 30, y: 55, z: D + 140, fovY: 46 } }], ["turned camera", { camera: { x: 20, y: 55, z: D + 90, fovY: 62, tx: 42 } }],
      ["glass doors", { camera: { x: 30, y: 55, z: D + 95, fovY: 62 }, door: true }],
      ["end wall (plumbing) view", { measure: { facingWidth: 30, sideLength: 60, leftWall: true, rightWall: false }, camera: { x: 34, y: 56, z: 115, fovY: 66, tx: 15, tz: 0 } }],
      ["white tile", { camera: { x: 30, y: 55, z: D + 95, fovY: 62 }, tileColor: "#f4f3ef" }], ["blue tile", { camera: { x: 30, y: 55, z: D + 95, fovY: 62 }, tileColor: "#9fb7c9" }],
      ["curtain (corner hidden)", { camera: { x: 30, y: 55, z: D + 95, fovY: 62 }, curtain: "right" }],
    ];
    const rows = [];
    for (const [name, c] of cases) {
      const r = await E((c) => { const L = window.__studioLab, ph = L.syntheticPhoto(c), ev = L.evaluate(ph); delete ev.marks; return ev; }, c);
      const ok = r.found && r.errBottom < 0.015 && r.cam && r.cam.fovY > 22 && r.cam.fovY < 105;
      rows.push({ name, ok, bottomErrPct: r.errBottom != null ? +(r.errBottom * 100).toFixed(1) : null, camErrIn: r.posErr != null ? Math.round(r.posErr) : null, ms: Math.round(r.ms) });
    }
    console.table(rows);
    const required = rows.filter((x) => !/curtain/.test(x.name));
    must(required.every((x) => x.ok), "missed: " + required.filter((x) => !x.ok).map((x) => x.name).join(", "));
    return { lineUp: `${rows.filter((x) => x.ok).length}/${rows.length}`, knownLimit: "a curtain hiding a corner" };
  });

  // ---------------------------------------------------------------- layouts
  for (const dev of Object.keys(DEVICES)) {
    await step(`layout: ${dev} - picture, choices and total visible, nothing scrolls sideways`, async () => {
      const { ctx, p: q } = await open(dev, dev);
      await start(q, dev.includes("Android") ? "tub" : "shower");
      const vw = DEVICES[dev].viewport;
      const over = await q.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const pic = await q.locator("[data-studio-after]").boundingBox();
      const total = await q.locator('[data-testid="price-strip"]').boundingBox();
      const card = await q.locator('[data-testid^="family-finish-"]:not([data-testid$="-delta"]), [data-testid^="finish-"]:not([data-testid$="-delta"])').first().boundingBox();
      await q.screenshot({ path: path.join(OUT, `layout-${dev.replace(/\W+/g, "-")}.png`) });
      await ctx.close();
      must(over <= 1, `scrolls sideways ${over}px`);
      must(pic && pic.width > 150 && pic.y >= 0 && pic.y + pic.height <= vw.height + 1, "picture not fully visible");
      must(total && total.y + total.height <= vw.height + 1, "total not visible");
      must(card && card.y < vw.height, "no choice visible");
      return { picture: `${Math.round(pic.width)}×${Math.round(pic.height)}` };
    });
  }

  // ---------------------------------------------------------------- measured timings
  await step("timings (software WebGL in this test browser; real phones use their GPU)", async () => {
    const { ctx, p: q } = await open("iPhone (390×844)", "timing");
    const cdp = await ctx.newCDPSession(q);
    const measure = async (label) => {
      const t0 = Date.now();
      await q.goto(`${FE}/shower-studio/preview`, { waitUntil: "domcontentloaded", timeout: 300000 });
      await q.locator('[data-testid="start-shower"]').waitFor({ timeout: 300000 });
      const tStart = Date.now() - t0;
      const t1 = Date.now();
      await q.locator('[data-testid="start-shower"]').click();
      await ready(q);
      const firstPicture = Date.now() - t1;
      const change = await q.evaluate(async () => {
        const e = window.__studioEngine, list = e.catalog.finishes.filter((f) => f.kits.some((k) => k.for === "pan"));
        const out = [];
        for (const f of list.slice(0, 6)) { const t = performance.now(); e.applyChange((d) => { d.finishId = f.id; }, { finishOnly: true }); out.push(performance.now() - t); }
        const t = performance.now(); e.setPlumbing("right"); const plumbing = performance.now() - t;
        return { finish: Math.round(out.reduce((a, b) => a + b, 0) / out.length), plumbing: Math.round(plumbing), room: Math.round(e.S.lastRoomMs) };
      });
      timings[label] = { startScreenMs: tStart, firstPictureMs: firstPicture, finishChangeMs: change.finish, plumbingChangeMs: change.plumbing, roomDrawMs: change.room };
    };
    await measure("normal CPU");
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await measure("CPU slowed 4x");
    await ctx.close();
    return timings;
  });

  await step("no browser errors", async () => { must(!errors.length, [...new Set(errors)].slice(0, 5).join(" | ")); });
  await browser.close();
  await demo.stop();
  fs.writeFileSync(path.join(OUT, "timings.json"), JSON.stringify(timings, null, 1));
  console.log(failed ? `\n${failed} step(s) failed. Screenshots: ${OUT}` : `\nall steps passed. Screenshots: ${OUT}`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await demo.stop().catch(() => {}); process.exit(1); });
