/**
 * Turning a priced Studio design into an existing-Profixter proposal: a
 * Bathroom Project and an Estimate whose line items reproduce the design's
 * frozen price exactly. The contract, its deposit and payment schedule, and
 * the customer's signature then follow the existing Projects workflow
 * (contract editor -> PDF -> native e-signature), unchanged.
 */

const TYPE_LABEL = {
  "tub-to-shower": "Tub-to-shower conversion",
  "shower-replacement": "Shower replacement",
  "tub-replacement": "Bathtub replacement",
};

const dollars = (cents) => Math.round(cents) / 100;

/**
 * Snapshot lines -> Estimate { lineItems, discount, total } in dollars.
 * Estimate line items cannot be negative: discounts and downward price
 * adjustments go to the estimate's discount; upward adjustments are a line.
 */
function estimateFromSnapshot(snapshot) {
  if (!snapshot?.complete || snapshot.totalCents == null) throw Object.assign(new Error("This design has no complete price yet."), { status: 400 });
  const lineItems = [];
  let discountCents = 0;
  for (const l of snapshot.lines) {
    if (l.totalCents === 0 && l.kind === "product") {
      lineItems.push({ description: l.label, quantity: l.quantity || 1, unitPrice: 0 });
      continue;
    }
    if (l.totalCents < 0) { discountCents += -l.totalCents; continue; }
    const qty = l.quantity || 1;
    const unit = l.unitCents || Math.round(l.totalCents / qty);
    if (unit * qty !== l.totalCents) lineItems.push({ description: l.label, quantity: 1, unitPrice: dollars(l.totalCents) });
    else lineItems.push({ description: qty > 1 ? `${l.label}` : l.label, quantity: qty, unitPrice: dollars(unit) });
  }
  const subtotalCents = lineItems.reduce((s, li) => s + Math.round(li.unitPrice * 100) * li.quantity, 0);
  const totalCents = subtotalCents - discountCents;
  if (totalCents !== snapshot.totalCents) throw Object.assign(new Error(`Estimate total ${totalCents} does not match the design price ${snapshot.totalCents}.`), { status: 500 });
  return { lineItems, discount: dollars(discountCents), totalCents };
}

/** The scope description that travels with the estimate (and into the contract editor). */
function scopeText(design) {
  const sel = design.selections || [];
  const m = design.state?.design?.measure || {};
  const by = (cat) => sel.filter((s) => s.category === cat);
  const lines = [
    `${TYPE_LABEL[design.projectType] || "Shower/tub project"} - designed in the Profixter Shower Studio (design ${design.publicId}).`,
    `Alcove ${design.measureSource === "verified" ? "as measured on site" : design.measureSource === "customer" ? "as measured by the customer" : "at the standard example size (NOT measured)"}: ${m.facingWidth}" × ${m.sideLength}", ${m.leftWall && m.rightWall ? "three walls" : m.leftWall ? "wall on the left" : "wall on the right"}.`,
    ...by("base").map((s) => `Base: ${s.name}${s.model ? ` (${s.manufacturer} ${s.model})` : ""}.`),
    ...by("wall").map((s) => `Wall system: ${s.name}${s.model ? ` (${s.manufacturer} ${s.model})` : ""}.`),
    ...by("fixture").map((s) => `Valve trim: ${s.name}.`),
    ...by("enclosure").map((s) => `${s.type === "door" ? "Door" : "Rod"}: ${s.name}.`),
    ...by("accessory").map((s) => `Accessory: ${s.name}${s.quantity > 1 ? ` × ${s.quantity}` : ""}.`),
    m.aboveMode === "paint" ? "Remove the old tile above the new walls, patch and paint." : "",
    "Final dimensions, plumbing and wall conditions to be verified on site before installation.",
  ];
  return lines.filter(Boolean).join("\n");
}

module.exports = { estimateFromSnapshot, scopeText, TYPE_LABEL };
