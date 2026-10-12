/**
 * Shower Studio pricing - computed on the server only, from the owner's
 * prices. The browser never sends a price; it sends a design and gets a total.
 *
 * Total = project base price
 *       + each selected product's price (+ its installation adder)
 *       + automatic adders (paint above the panels, door install, per grab bar...)
 *       + manual adders and adjustments added by authorized staff
 *       - discounts (capped for employees)
 * A package replaces the prices of the products it contains when the design
 * includes all of them.
 *
 * If ANY price the design needs is not set, the estimate is incomplete: no
 * total is produced, and the list of what is missing is returned (internal).
 * Customers then see "we'll confirm your price" instead of a wrong number.
 */

function selectedSkus(design) {
  const out = [];
  const add = (sku, quantity = 1) => { if (sku) out.push({ sku, quantity }); };
  add(design.baseId);
  add(design.finishId);
  add(design.fixtureId);
  if (design.enclosureId && design.enclosureId !== "none") add(design.enclosureId);
  for (const a of design.accessories || []) add(a.productId);
  // merge duplicates (two identical grab bars -> quantity 2)
  const merged = new Map();
  for (const x of out) merged.set(x.sku, (merged.get(x.sku) || 0) + x.quantity);
  return [...merged].map(([sku, quantity]) => ({ sku, quantity }));
}

const money = (c) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * @param design       engine design: { baseId, finishId, fixtureId, enclosureId, accessories, measure }
 * @param projectType  "tub-to-shower" | "shower-replacement" | "tub-replacement"
 * @param products     Map sku -> product (with pricing), including archived ones
 * @param pricing      StudioPricing document (plain object ok)
 * @param adjustments  staff adjustments [{kind: adder|override|discount, key, label, amountCents, percent, reason}]
 */
function priceDesign({ design, projectType, products, pricing, adjustments = [] }) {
  const lines = [];
  const missing = [];
  const pt = (pricing.projectTypes || []).find((t) => t.key === projectType);
  if (!pt || pt.enabled === false) missing.push(`Project type "${projectType}" is not offered`);
  else if (pt.basePriceCents == null) missing.push(`Base price for ${pt.label}`);
  else lines.push({ kind: "base", label: pt.label, quantity: 1, unitCents: pt.basePriceCents, totalCents: pt.basePriceCents });

  const sel = selectedSkus(design);
  const selSet = new Set(sel.map((s) => s.sku));
  // packages: all SKUs present -> package price replaces theirs
  const inPackage = new Set();
  for (const pkg of pricing.packages || []) {
    if (pkg.enabled === false || pkg.priceCents == null || !pkg.skus?.length) continue;
    if (!pkg.skus.every((s) => selSet.has(s)) || pkg.skus.some((s) => inPackage.has(s))) continue;
    pkg.skus.forEach((s) => inPackage.add(s));
    lines.push({ kind: "package", label: pkg.name, quantity: 1, unitCents: pkg.priceCents, totalCents: pkg.priceCents });
  }
  for (const { sku, quantity } of sel) {
    const p = products.get(sku);
    if (!p) { missing.push(`Product ${sku} is no longer in the catalog`); continue; }
    if (inPackage.has(sku)) {
      lines.push({ kind: "product", label: `${p.name} (in package)`, sku, quantity, unitCents: 0, totalCents: 0 });
    } else if (p.pricing?.priceCents == null) {
      missing.push(`Price for ${p.name}`);
    } else {
      lines.push({ kind: "product", label: p.name, sku, quantity, unitCents: p.pricing.priceCents, totalCents: p.pricing.priceCents * quantity });
    }
    const install = p.pricing?.installCents || 0;
    if (install > 0) lines.push({ kind: "install", label: `Installation: ${p.name}`, sku, quantity, unitCents: install, totalCents: install * quantity });
  }

  // automatic adders
  const accCount = (type) => (design.accessories || []).reduce((n, a) => n + (products.get(a.productId)?.type === type ? 1 : 0), 0);
  const enc = design.enclosureId && design.enclosureId !== "none" ? products.get(design.enclosureId) : null;
  const triggered = {
    paintAbove: design.measure?.aboveMode === "paint" ? 1 : 0,
    door: enc?.type === "door" ? 1 : 0,
    perGrabBar: accCount("grabBar"),
    perSeat: accCount("seat"),
    perShelf: accCount("shelf"),
  };
  for (const a of pricing.adders || []) {
    if (a.enabled === false || a.trigger === "manual") continue;
    const q = triggered[a.trigger] || 0;
    if (!q) continue;
    if (a.priceCents == null) { missing.push(`Price for "${a.label}"`); continue; }
    lines.push({ kind: "adder", label: a.label, quantity: q, unitCents: a.priceCents, totalCents: a.priceCents * q });
  }

  // staff: manual adders
  for (const adj of adjustments.filter((x) => x.kind === "adder")) {
    const a = (pricing.adders || []).find((x) => x.key === adj.key);
    const cents = Number.isFinite(adj.amountCents) && adj.amountCents > 0 ? adj.amountCents : a?.priceCents;
    if (cents == null) { missing.push(`Price for "${a?.label || adj.label || adj.key}"`); continue; }
    lines.push({ kind: "adder", label: adj.label || a?.label || "Additional work", quantity: 1, unitCents: cents, totalCents: cents, reason: adj.reason || "" });
  }

  const subtotal = lines.reduce((s, l) => s + l.totalCents, 0);
  let total = subtotal;
  // staff: override (sets the total), then discounts
  const override = [...adjustments].reverse().find((x) => x.kind === "override" && Number.isFinite(x.amountCents) && x.amountCents >= 0);
  if (override) {
    const delta = override.amountCents - total;
    lines.push({ kind: "adjustment", label: "Price adjustment", quantity: 1, unitCents: delta, totalCents: delta, reason: override.reason || "" });
    total = override.amountCents;
  }
  for (const d of adjustments.filter((x) => x.kind === "discount")) {
    const amount = Number.isFinite(d.percent) && d.percent > 0 ? Math.round((total * d.percent) / 100) : Math.max(0, Math.round(d.amountCents || 0));
    if (!amount) continue;
    lines.push({ kind: "discount", label: d.label || (d.percent ? `Discount (${d.percent}%)` : "Discount"), quantity: 1, unitCents: -amount, totalCents: -amount, reason: d.reason || "" });
    total -= amount;
  }
  total = Math.max(0, total);
  const complete = missing.length === 0;
  return {
    complete,
    missing,
    lines,
    subtotalCents: subtotal,
    totalCents: complete ? total : null,
    pricingVersion: pricing.version || 0,
    selections: sel.map(({ sku, quantity }) => {
      const p = products.get(sku);
      return { sku, quantity, category: p?.category || "", type: p?.type || "", name: p?.name || sku, manufacturer: p?.manufacturer || "", model: p?.model || "" };
    }),
  };
}

/** The ONLY pricing information a public visitor receives. */
function publicQuote(result, pricing) {
  return {
    complete: result.complete,
    totalCents: result.complete ? result.totalCents : null,
    display: result.complete ? money(result.totalCents) : null,
    message: result.complete ? pricing.disclaimer : "We'll confirm the price for this design after a quick review.",
    includes: result.lines.filter((l) => l.kind !== "adjustment" && l.kind !== "discount").map((l) => l.label),
  };
}

/** Largest discount an employee may give, in cents (the owner is not limited). */
function discountAllowed({ subtotalCents, percent, amountCents, pricing, isOwner }) {
  if (isOwner) return true;
  const cap = Math.round((subtotalCents * (pricing.maxDiscountPercent ?? 15)) / 100);
  const ask = Number.isFinite(percent) && percent > 0 ? Math.round((subtotalCents * percent) / 100) : amountCents || 0;
  return ask <= cap;
}

module.exports = { priceDesign, publicQuote, selectedSkus, discountAllowed, money };
