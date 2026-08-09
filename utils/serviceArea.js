/**
 * ProFixter service area — single source of truth.
 *
 * Gates the First Visit Free acquisition offer only. Account creation and
 * member booking are deliberately NOT gated: out-of-area accounts stay valid,
 * we simply do not extend the introductory offer to them.
 *
 * Matching is by an EXPLICIT ZIP allowlist, not numeric ranges. Long Island
 * ZIPs interleave with Queens and ranges also accept ZIPs that do not exist,
 * which is unacceptable for a rule that gives away free labor.
 *
 * The user-entered `county` string is advisory only and is never trusted.
 *
 * The BACKEND is authoritative. Any frontend messaging is convenience only.
 */

/**
 * Nassau County, NY — residential delivery ZIPs.
 */
const NASSAU_ZIPS = [
  "11001", // Floral Park
  "11003", // Elmont
  "11010", // Franklin Square
  "11020", "11021", "11023", "11024", // Great Neck
  "11030", // Manhasset
  "11040", "11042", // New Hyde Park
  "11050", // Port Washington
  "11096", // Inwood
  "11501", // Mineola
  "11507", // Albertson
  "11509", // Atlantic Beach
  "11510", // Baldwin
  "11514", // Carle Place
  "11516", // Cedarhurst
  "11518", // East Rockaway
  "11520", // Freeport
  "11530", // Garden City
  "11542", // Glen Cove
  "11545", // Glen Head
  "11547", // Glenwood Landing
  "11548", // Greenvale
  "11550", // Hempstead
  "11552", // West Hempstead
  "11553", // Uniondale
  "11554", // East Meadow
  "11556", // Uniondale
  "11557", // Hewlett
  "11558", // Island Park
  "11559", // Lawrence
  "11560", // Locust Valley
  "11561", // Long Beach
  "11563", // Lynbrook
  "11565", // Malverne
  "11566", // Merrick
  "11568", // Old Westbury
  "11569", // Point Lookout
  "11570", // Rockville Centre
  "11572", // Oceanside
  "11575", // Roosevelt
  "11576", // Roslyn
  "11577", // Roslyn Heights
  "11579", // Sea Cliff
  "11580", "11581", // Valley Stream
  "11590", // Westbury
  "11596", // Williston Park
  "11598", // Woodmere
  "11710", // Bellmore
  "11714", // Bethpage
  "11732", // East Norwich
  "11735", // Farmingdale
  "11753", // Jericho
  "11756", // Levittown
  "11758", // Massapequa
  "11762", // Massapequa Park
  "11765", // Mill Neck
  "11771", // Oyster Bay
  "11783", // Seaford
  "11791", // Syosset
  "11793", // Wantagh
  "11797", // Woodbury
  "11801", // Hicksville
  "11803", // Plainview
  "11804", // Old Bethpage
];

/**
 * Suffolk County, NY — residential delivery ZIPs.
 */
const SUFFOLK_ZIPS = [
  "11701", // Amityville
  "11702", // Babylon
  "11703", // North Babylon
  "11704", // West Babylon
  "11705", // Bayport
  "11706", // Bay Shore
  "11713", // Bellport
  "11715", // Blue Point
  "11716", // Bohemia
  "11717", // Brentwood
  "11718", // Brightwaters
  "11719", // Brookhaven
  "11720", // Centereach
  "11721", // Centerport
  "11722", // Central Islip
  "11724", // Cold Spring Harbor
  "11725", // Commack
  "11726", // Copiague
  "11727", // Coram
  "11729", // Deer Park
  "11730", // East Islip
  "11731", // East Northport
  "11733", // East Setauket
  "11738", // Farmingville
  "11739", // Great River
  "11740", // Greenlawn
  "11741", // Holbrook
  "11742", // Holtsville
  "11743", // Huntington
  "11746", // Huntington Station
  "11747", // Melville
  "11749", // Islandia
  "11751", // Islip
  "11752", // Islip Terrace
  "11754", // Kings Park
  "11755", // Lake Grove
  "11757", // Lindenhurst
  "11763", // Medford
  "11764", // Miller Place
  "11766", // Mount Sinai
  "11767", // Nesconset
  "11768", // Northport
  "11769", // Oakdale
  "11772", // Patchogue
  "11776", // Port Jefferson Station
  "11777", // Port Jefferson
  "11778", // Rocky Point
  "11779", // Ronkonkoma
  "11780", // Saint James
  "11782", // Sayville
  "11784", // Selden
  "11786", // Shoreham
  "11787", // Smithtown
  "11788", // Hauppauge
  "11789", // Sound Beach
  "11790", // Stony Brook
  "11792", // Wading River
  "11795", // West Islip
  "11796", // West Sayville
  "11798", // Wyandanch
  "11901", // Riverhead
  "11930", // Amagansett
  "11931", // Aquebogue
  "11932", // Bridgehampton
  "11933", // Calverton
  "11934", // Center Moriches
  "11935", // Cutchogue
  "11937", // East Hampton
  "11939", // East Marion
  "11940", // East Moriches
  "11941", // Eastport
  "11942", // East Quogue
  "11944", // Greenport
  "11946", // Hampton Bays
  "11947", // Jamesport
  "11948", // Laurel
  "11949", // Manorville
  "11950", // Mastic
  "11951", // Mastic Beach
  "11952", // Mattituck
  "11953", // Middle Island
  "11954", // Montauk
  "11955", // Moriches
  "11956", // New Suffolk
  "11957", // Orient
  "11958", // Peconic
  "11959", // Quogue
  "11960", // Remsenburg
  "11961", // Ridge
  "11962", // Sagaponack
  "11963", // Sag Harbor
  "11967", // Shirley
  "11968", // Southampton
  "11970", // South Jamesport
  "11971", // Southold
  "11972", // Speonk
  "11975", // Wainscott
  "11976", // Water Mill
  "11977", // Westhampton
  "11978", // Westhampton Beach
  "11980", // Yaphank
];

/**
 * Real Nassau/Suffolk ZIPs deliberately EXCLUDED, with the reason.
 * Move an entry into the lists above if the business decides to serve it.
 *
 *   11964, 11965  Shelter Island / Shelter Island Heights — ferry access only
 *   11770         Ocean Beach (Fire Island) — ferry access, no vehicle access
 *   11930-adjacent Fire Island communities share mainland ZIPs; not separable here
 *   11794         Stony Brook University campus — institutional, not residential
 *   11973         Upton (Brookhaven National Laboratory) — institutional
 *   06390         Fishers Island — Suffolk County but CT ZIP, ferry from New London
 *   11025, 11026, 11027, 11736, 11902  PO Box-only ZIPs — no physical dwelling
 */
const KNOWN_EXCLUSIONS = new Set([
  "11964", "11965", "11770", "11794", "11973", "06390",
  "11025", "11026", "11027", "11736", "11902",
]);

const SERVICE_AREA_ZIPS = new Set([...NASSAU_ZIPS, ...SUFFOLK_ZIPS]);

/** Human-readable description used in customer-facing copy. */
const SERVICE_AREA_LABEL = "Nassau and Suffolk Counties";

/**
 * Normalize a raw ZIP into its 5-digit base form.
 * Returns "" when the value is not a usable US ZIP.
 */
function normalizeZip(value) {
  const digits = String(value || "").trim().split("-")[0].replace(/\D/g, "");
  return digits.length === 5 ? digits : "";
}

/**
 * Is this ZIP inside the ProFixter service area?
 *
 * Fails closed: anything not explicitly listed is rejected, including unknown,
 * malformed and non-existent ZIPs.
 */
function isZipInServiceArea(value) {
  const zip = normalizeZip(value);
  if (!zip) return false;
  if (KNOWN_EXCLUSIONS.has(zip)) return false;
  return SERVICE_AREA_ZIPS.has(zip);
}

/**
 * Is this address serviceable for the introductory offer?
 * Accepts an address subdocument or any object with a `zip`.
 */
function isAddressInServiceArea(address) {
  return isZipInServiceArea(address?.zip);
}

/** Which county a serviceable ZIP belongs to, or null. */
function countyForZip(value) {
  const zip = normalizeZip(value);
  if (!zip || KNOWN_EXCLUSIONS.has(zip)) return null;
  if (NASSAU_ZIPS.includes(zip)) return "Nassau";
  if (SUFFOLK_ZIPS.includes(zip)) return "Suffolk";
  return null;
}

/** Customer-facing message when a property falls outside the area. */
function outOfServiceAreaMessage() {
  return `We currently offer First Visit Free for homes in ${SERVICE_AREA_LABEL}.`;
}

module.exports = {
  NASSAU_ZIPS,
  SUFFOLK_ZIPS,
  SERVICE_AREA_ZIPS,
  KNOWN_EXCLUSIONS,
  SERVICE_AREA_LABEL,
  normalizeZip,
  isZipInServiceArea,
  isAddressInServiceArea,
  countyForZip,
  outOfServiceAreaMessage,
};
