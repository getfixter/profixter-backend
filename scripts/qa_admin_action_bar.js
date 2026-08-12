/**
 * Admin contextual action bar — rendered viewport QA.
 *
 * Reuses the authenticated Admin QA environment: in-memory MongoDB, seeded
 * fixtures, the real backend, a frontend built against it, and Playwright with
 * a minted admin JWT. Nothing here touches production.
 *
 * What it is actually checking is occlusion. A fixed bottom bar is easy to
 * build and easy to get wrong: it covers the last field on a long form, it
 * sits on top of the keyboard, it fights a modal, or it appears on desktop
 * where nobody wanted it. Every assertion below is a measurement of live
 * geometry, never a screenshot comparison.
 *
 *   node scripts/qa_admin_action_bar.js
 */

const path = require("path");
const { runAdminQaEnvironment } = require("./qa_admin_env");

const VIEWPORTS = [
  { name: "phone-375", width: 375, height: 667, bar: true },
  { name: "phone-390", width: 390, height: 844, bar: true },
  { name: "phone-430", width: 430, height: 932, bar: true },
  { name: "tablet-768-portrait", width: 768, height: 1024, bar: true },
  { name: "tablet-1024-landscape", width: 1024, height: 768, bar: true },
  { name: "desktop-1440", width: 1440, height: 900, bar: false },
];

const TABS = [
  { key: "contract", label: "Agreement" },
  { key: "changeOrders", label: "Change Order" },
  { key: "invoice", label: "Invoice", opensList: true, rowSelector: 'button:has-text("#0")' },
  { key: "estimate", label: "Estimate", opensList: true, rowSelector: 'button:has-text("EST-")' },
];

const results = [];
function record(viewport, scope, ok, detail) {
  results.push({ viewport, scope, ok, detail });
  if (!ok) console.log(`  DEFECT  [${viewport}] ${scope}: ${detail}`);
}

/** Nothing interactive may sit underneath the fixed bar. */
async function checkNoOcclusion(page, viewport, scope) {
  const bar = await page.locator('[data-testid="admin-action-bar"]').first();
  if (!(await bar.count()) || !(await bar.isVisible())) return null;
  const barBox = await bar.boundingBox();
  if (!barBox) return null;

  /*
   * Scroll to the TRUE bottom. Content passing under a fixed bar mid-page is
   * normal and expected; the requirement is that everything can be scrolled
   * clear of it, which is only observable at the end of the page.
   */
  const reachedBottom = await page.evaluate(async () => {
    for (let i = 0; i < 40; i += 1) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((r) => setTimeout(r, 60));
    }
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return { scrollY: Math.round(window.scrollY), max: Math.round(max) };
  });
  await page.waitForTimeout(300);
  record(
    viewport,
    `${scope}/scrolls-to-bottom`,
    reachedBottom.scrollY >= reachedBottom.max - 2,
    `stopped at ${reachedBottom.scrollY} of ${reachedBottom.max}`
  );

  const covered = await page.evaluate((barTop) => {
    const hits = [];
    const selector = "button, a, input, textarea, select, label[class*=cursor-pointer]";
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (el.closest('[data-testid="admin-action-bar"]')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
      // Overlapping the bar's band while still on screen means it is covered.
      if (rect.bottom > barTop + 2) {
        // Report enough to diagnose: a sticky ancestor and a non-scrolling
        // container are the two usual causes, and they need different fixes.
        let sticky = "";
        for (let node = el; node && node !== document.body; node = node.parentElement) {
          const position = getComputedStyle(node).position;
          if (position === "sticky" || position === "fixed") {
            sticky = `${position}:${node.className.toString().slice(0, 40)}`;
            break;
          }
        }
        hits.push(
          `${el.tagName.toLowerCase()}[${(el.textContent || "").trim().slice(0, 20)}]` +
            ` bottom=${Math.round(rect.bottom)} barTop=${Math.round(barTop)}` +
            ` scrollY=${Math.round(window.scrollY)} maxScroll=${Math.round(
              document.documentElement.scrollHeight - window.innerHeight
            )}${sticky ? ` ${sticky}` : ""}`
        );
      }
    }
    return hits;
  }, barBox.y);

  record(viewport, `${scope}/occlusion`, covered.length === 0, `covered: ${covered.slice(0, 2).join(" || ")}`);
  return barBox;
}

async function checkNoHorizontalOverflow(page, viewport, scope) {
  const overflow = await page.evaluate(() => {
    const client = document.documentElement.clientWidth;
    // An element inside a horizontally scrollable container is meant to extend
    // past the viewport - that is not page overflow, and reporting it hides the
    // real culprit.
    const inScroller = (el) => {
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        const overflowX = getComputedStyle(node).overflowX;
        if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") return true;
      }
      return false;
    };
    let worst = null;
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (inScroller(el)) continue;
      if (rect.right > client + 1 && (!worst || rect.right > worst.right)) {
        worst = {
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || "").slice(0, 70),
        };
      }
    }
    return { scroll: document.documentElement.scrollWidth, client, worst };
  });
  record(
    viewport,
    `${scope}/overflow`,
    overflow.scroll <= overflow.client + 1,
    `scrollWidth ${overflow.scroll} > ${overflow.client}; widest: ${JSON.stringify(overflow.worst)}`
  );
}

async function run({ page, frontendUrl, projectId }) {
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });

    for (const tab of TABS) {
      await page.goto(`${frontendUrl}/admin?tab=projects`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2200);
      // Open the seeded project, then the section under test.
      // The list renders as a table on desktop and as cards on phones, so the
      // same text exists in both a hidden cell and a visible card. Pick whatever
      // is actually on screen at this viewport.
      const projectRow = page.locator("text=P-QA-0001").locator("visible=true").first();
      if (await projectRow.count()) await projectRow.click({ timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1800);
      const tabButton = page
        .getByRole("button", { name: new RegExp(`^${tab.label}`, "i") })
        .locator("visible=true")
        .first();
      if (await tabButton.count()) await tabButton.click({ timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2800);

      /*
       * Invoices and Estimates open on a list; the bar belongs to a document,
       * so one has to be opened before the bar is expected. Agreements and
       * Change Orders already land on the document itself.
       */
      if (tab.opensList) {
        const firstDoc = page.locator(tab.rowSelector).locator("visible=true").first();
        if (await firstDoc.count()) {
          await firstDoc.click({ timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(2200);
        } else {
          const visibleText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 220));
          record(vp.name, `${tab.key}/fixture`, false, `no document to open. Page says: ${visibleText}`);
          continue;
        }
      }

      const bar = page.locator('[data-testid="admin-action-bar"]').first();
      const visible = (await bar.count()) > 0 && (await bar.isVisible());

      // Desktop must not get the bar; mobile and tablet must.
      record(
        vp.name,
        `${tab.key}/presence`,
        visible === vp.bar,
        vp.bar ? "expected the bar and it is absent" : "the bar must not appear on desktop"
      );

      await checkNoHorizontalOverflow(page, vp.name, tab.key);

      if (visible) {
        const barBox = await checkNoOcclusion(page, vp.name, tab.key);

        // Touch targets must be tappable, not decorative.
        const small = await page.evaluate(() => {
          const nodes = Array.from(
            document.querySelectorAll('[data-testid="admin-action-bar"] [data-action]')
          );
          return nodes
            .map((el) => ({ key: el.getAttribute("data-action"), h: el.getBoundingClientRect().height }))
            .filter((item) => item.h < 40);
        });
        record(vp.name, `${tab.key}/touch-targets`, small.length === 0, `too small: ${JSON.stringify(small)}`);

        // The bar must sit at the bottom edge, not float mid-screen.
        if (barBox) {
          const gap = vp.height - (barBox.y + barBox.height);
          record(vp.name, `${tab.key}/anchored`, gap <= 2, `bar bottom is ${Math.round(gap)}px above the viewport edge`);
        }

        // Actions must be distinct: no duplicate keys in one bar.
        const keys = await page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-testid="admin-action-bar"] [data-action]')).map((el) =>
            el.getAttribute("data-action")
          )
        );
        record(
          vp.name,
          `${tab.key}/no-duplicate-actions`,
          new Set(keys).size === keys.length,
          `duplicate action keys: ${keys.join(",")}`
        );

        /*
         * No action may be prominently duplicated outside the bar. The bar is
         * meant to REPLACE the scattered buttons on a phone, not add a fifth
         * copy of them.
         */
        const duplicates = await page.evaluate(() => {
          const barLabels = new Set(
            Array.from(document.querySelectorAll('[data-testid="admin-action-bar"] [data-action]'))
              .map((el) => (el.textContent || "").trim().toLowerCase())
              .filter(Boolean)
          );
          const outside = [];
          for (const el of Array.from(document.querySelectorAll("button, label"))) {
            if (el.closest('[data-testid="admin-action-bar"]')) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const text = (el.textContent || "").trim().toLowerCase();
            if (text && barLabels.has(text)) outside.push(text);
          }
          return outside;
        });
        record(
          vp.name,
          `${tab.key}/no-duplicate-outside-bar`,
          duplicates.length === 0,
          `also visible outside the bar: ${[...new Set(duplicates)].join(", ")}`
        );

        // A focused field must hide the bar, standing in for the keyboard.
        const field = page.locator("input:visible, textarea:visible").first();
        if (await field.count()) {
          await field.focus();
          await page.waitForTimeout(400);
          const hiddenWhileTyping = !(await bar.isVisible());
          record(vp.name, `${tab.key}/keyboard`, hiddenWhileTyping, "the bar stays over a focused field");
          await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
          await page.waitForTimeout(400);
        }
      }
    }

    if (process.env.QA_SHOTS && vp.name === "phone-390") {
      await page.screenshot({ path: `${process.env.QA_SHOTS}/action-bar-390.png` });
      console.log("  screenshot written");
    }
    console.log(`  viewport ${vp.name} inspected`);
  }

  const defects = results.filter((item) => !item.ok);
  console.log(`\n${results.length} action-bar checks, ${defects.length} defects.`);
  if (defects.length) {
    for (const d of defects.slice(0, 20)) console.log(`  - [${d.viewport}] ${d.scope}: ${d.detail}`);
    throw new Error(`${defects.length} action-bar defects`);
  }
}

module.exports = { run, VIEWPORTS, TABS };

if (require.main === module) {
  runAdminQaEnvironment({ afterReady: run })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`\n  FAILED: ${error.message}\n`);
      process.exit(1);
    });
}
void path;
