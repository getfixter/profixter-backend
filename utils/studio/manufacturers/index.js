/**
 * Manufacturer catalogs the Studio can import. To add a manufacturer (e.g.
 * MAAX), write an adapter like ./swan.js - sheet names, series naming,
 * colours, patterns and what the designer can draw - and register it here.
 * Adapters for the same file format share its parser (./abgEpf.js for
 * American Bath Group's Electronic Product File).
 */
const { readWorkbook } = require("./workbook");
const { normalizeEpf } = require("./abgEpf");

const ADAPTERS = Object.freeze({ swan: require("./swan") });
const PARSERS = Object.freeze({ "abg-epf": normalizeEpf });

function adapterFor(key) {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, key) ? ADAPTERS[key] : null;
}

/** Read and normalize a manufacturer's workbook. */
async function parseCatalogFile(key, buffer) {
  const adapter = adapterFor(key);
  if (!adapter) throw Object.assign(new Error("Unknown manufacturer."), { userMessage: "Unknown manufacturer." });
  const wb = await readWorkbook(buffer);
  return PARSERS[adapter.format](wb, adapter);
}

module.exports = { ADAPTERS, adapterFor, parseCatalogFile };
