/*
 * Build the static ZIP geography table from the US Census TIGERweb service.
 *
 * Run once, by hand, to produce utils/membershipMap/zipGeography.json. Nothing
 * at runtime talks to the Census - the output is committed and read from disk,
 * so the map has no external dependency, no API key and no per-request cost.
 *
 * Only public census geography is fetched. No ProFixter data is sent anywhere.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { SERVICE_AREA_ZIPS } = require("../utils/serviceArea");

const LAYER =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1/query";
const BATCH = 30;
/* ~55m of simplification: far finer than the pin displacement it constrains. */
const OFFSET = "0.0005";
/* 4dp ~= 11m. The polygon is a containment test, not a survey. */
const PRECISION = 4;

function round(n) {
  return Number(Number(n).toFixed(PRECISION));
}

function fetchBatch(zips) {
  const where = `GEOID IN (${zips.map((z) => `'${z}'`).join(",")})`;
  const args = [
    "-s", "-m", "180", "-G", LAYER,
    "--data-urlencode", `where=${where}`,
    "--data-urlencode", "outFields=GEOID,AREALAND,INTPTLAT,INTPTLON",
    "--data-urlencode", "returnGeometry=true",
    "--data-urlencode", "outSR=4326",
    "--data-urlencode", `maxAllowableOffset=${OFFSET}`,
    "--data-urlencode", "f=json",
  ];
  const out = execFileSync("curl", args, { maxBuffer: 64 * 1024 * 1024 }).toString();
  const data = JSON.parse(out);
  if (!data.features) throw new Error("no features: " + out.slice(0, 200));
  return data.features;
}

const zips = [...SERVICE_AREA_ZIPS].map(String).sort();
console.log("service-area ZIPs:", zips.length);

const table = {};
let missing = [];

for (let i = 0; i < zips.length; i += BATCH) {
  const batch = zips.slice(i, i + BATCH);
  const features = fetchBatch(batch);
  for (const f of features) {
    const zip = String(f.attributes.GEOID);
    const rings = f.geometry?.rings || [];
    if (!rings.length) continue;

    /*
     * EVERY ring, not just the biggest.
     *
     * Picking one was wrong twice over. A ZCTA can be genuinely multi-part -
     * 11772 covers Patchogue village and a separate stretch to the south, and
     * the Census internal point sits in the smaller half - so keeping one part
     * threw away the only position guaranteed to be inside the area. And the
     * ring kept was chosen by VERTEX COUNT, which is not size: a crenellated
     * shoreline fragment carries far more points than a plain inland block.
     *
     * Holes are kept too. The containment test toggles across all rings, so an
     * inner ring subtracts itself the way it should rather than being treated
     * as more land.
     */
    const keptRings = rings.filter((r) => Array.isArray(r) && r.length >= 4);

    table[zip] = {
      /* The Census internal point: guaranteed to lie inside the polygon. */
      lat: round(f.attributes.INTPTLAT),
      lng: round(f.attributes.INTPTLON),
      /* Land only. Water area is excluded so a bay cannot inflate the radius. */
      landM2: Number(f.attributes.AREALAND) || 0,
      rings: keptRings.map((r) => r.map(([x, y]) => [round(x), round(y)])),
    };
  }
  const got = features.length;
  console.log(`  batch ${i / BATCH + 1}: asked ${batch.length}, got ${got}`);
  for (const z of batch) if (!table[z]) missing.push(z);
}

console.log("\nZIPs with geography :", Object.keys(table).length);
console.log("ZIPs missing        :", missing.length, missing.length ? JSON.stringify(missing) : "");

const OUT = path.join(__dirname, "..", "utils", "membershipMap", "zipGeography.json");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(table));
console.log("wrote", OUT, (fs.statSync(OUT).size / 1024).toFixed(0) + " KB");
