/**
 * The compatibility rules and the design format run in two places: the
 * browser (FrontEnd/lib/studio/engine) and here (utils/studio/engine). They
 * must be identical, or the server could refuse what the page allowed.
 * Skips (passes) when the FrontEnd checkout is not beside this one.
 */
const fs = require("fs");
const path = require("path");
const pairs = [["compat.mjs", "compat.js"], ["design.mjs", "design.js"]];
const fe = path.join(__dirname, "..", "..", "FrontEnd", "lib", "studio", "engine");
if (!fs.existsSync(fe)) { console.log("FrontEnd not beside BackEnd - skipped"); process.exit(0); }
const norm = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
let bad = 0;
for (const [be, f] of pairs) {
  const same = norm(path.join(__dirname, "..", "utils", "studio", "engine", be)) === norm(path.join(fe, f));
  console.log(`  ${same ? "PASS" : "FAIL"}  ${be} matches FrontEnd ${f}`);
  if (!same) bad++;
}
process.exit(bad ? 1 : 0);
