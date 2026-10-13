/**
 * Example bathrooms the public Studio can start from (no photo needed).
 * The image itself is a public site asset (FrontEnd/public/studio/...); the
 * server only needs to know which ids exist and their pixel size, to validate
 * designs that are based on them.
 */
const EXAMPLE_SCENES = Object.freeze({
  // drawn by the engine (FrontEnd/lib/studio/engine/room.js) for the design's alcove size
  "studio-room-1": { width: 1080, height: 1350, label: "Example bathroom (3D illustration)", model: true },
  "example-alcove-1": { width: 1080, height: 1350, label: "Example bathroom (illustrated 60″ × 30″ tub alcove)" },
  "example-bathroom-1": { width: 681, height: 1023, label: "Example bathroom (60″ tub alcove)" },
});

const isExampleScene = (id) => Object.prototype.hasOwnProperty.call(EXAMPLE_SCENES, String(id || ""));

/** Where the alcove size came from: never present a standard size as measured. */
const MEASURE_SOURCES = ["standard", "customer", "verified"];
const MEASURE_LABEL = {
  standard: "Standard example size (not measured)",
  customer: "Measured by the customer",
  verified: "Verified on site by Profixter",
};

module.exports = { EXAMPLE_SCENES, isExampleScene, MEASURE_SOURCES, MEASURE_LABEL };
