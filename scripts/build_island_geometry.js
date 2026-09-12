/**
 * Build the Long Island landmass path the homepage draws.
 *
 * Run by hand when MAP_BOUNDS changes or the service-area ZIP list does. Pulls
 * ZCTA polygons for every service-area ZIP from the US Census TIGERweb service
 * at display resolution, projects them with the SAME module the server uses to
 * place markers, and writes the result as a single SVG path.
 *
 * Public census geography only. No ProFixter data is sent anywhere, and nothing
 * at runtime depends on the Census - the output is committed.
 *
 *   node scripts/build_island_geometry.js [maxAllowableOffset]
 */
const fs = require("fs");
const { execFileSync } = require("child_process");
const { SERVICE_AREA_ZIPS } = require("../utils/serviceArea");
const LAYER = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1/query";
const OFFSET = process.argv[2] || "0.002";
const zips = [...SERVICE_AREA_ZIPS].map(String).sort();
const out = {};
for (let i = 0; i < zips.length; i += 30) {
  const batch = zips.slice(i, i + 30);
  const res = execFileSync("curl", ["-s","-m","180","-G",LAYER,
    "--data-urlencode", `where=GEOID IN (${batch.map(z=>`'${z}'`).join(",")})`,
    "--data-urlencode","outFields=GEOID",
    "--data-urlencode","returnGeometry=true",
    "--data-urlencode","outSR=4326",
    "--data-urlencode",`maxAllowableOffset=${OFFSET}`,
    "--data-urlencode","f=json"], {maxBuffer:64*1024*1024}).toString();
  const d = JSON.parse(res);
  for (const f of d.features || []) out[f.attributes.GEOID] = f.geometry.rings || [];
}
const total = Object.values(out).reduce((a,rings)=>a+rings.reduce((b,r)=>b+r.length,0),0);
console.log("offset", OFFSET, "| zips", Object.keys(out).length, "| total points", total);
fs.writeFileSync(`zcta_display_${OFFSET}.json`, JSON.stringify(out));

/* ---- project and emit the SVG path ---- */
const { MAP_BOUNDS, VIEWBOX } = require("../utils/membershipMap/projection");
const P = (lat, lng) => [
  Math.round(((lng - MAP_BOUNDS.west) / (MAP_BOUNDS.east - MAP_BOUNDS.west)) * VIEWBOX.width * 10) / 10,
  Math.round(((MAP_BOUNDS.north - lat) / (MAP_BOUNDS.north - MAP_BOUNDS.south)) * VIEWBOX.height * 10) / 10,
];
let d = "";
for (const rings of Object.values(out)) {
  for (const r of rings) {
    if (r.length < 4) continue;
    const pts = r.map(([lng, lat]) => P(lat, lng));
    d += "M" + pts[0][0] + " " + pts[0][1] + pts.slice(1).map((p) => "L" + p[0] + " " + p[1]).join("") + "Z";
  }
}
console.log("path chars:", d.length);
console.log("Paste into app/components/home/MembershipMap/island-geometry.ts (ISLAND_PATH).");
fs.writeFileSync("island-path.txt", d);
