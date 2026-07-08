const { getLocationId, request, redact } = require("./ghlClient");
const { parseCsvContext, normalizePhone } = require("./jarvisCsvProcessor");

const SEARCH_PAGE_LIMIT = Number(process.env.JARVIS_CSV_GHL_SEARCH_LIMIT || 10);
const SYNC_MAX_ROWS = Number(process.env.JARVIS_CSV_SYNC_MAX_ROWS || 5000);
const SYNC_CONCURRENCY = Math.max(
  1,
  Math.min(10, Number(process.env.JARVIS_CSV_GHL_SYNC_CONCURRENCY || 3))
);
const MISSING_PREVIEW_LIMIT = Number(process.env.JARVIS_CSV_MISSING_PREVIEW_LIMIT || 25);

function cleanString(value) {
  return String(value ?? "").trim();
}

function digits(value) {
  return cleanString(value).replace(/\D/g, "");
}

function normalizeTag(value) {
  return cleanString(value).toLowerCase();
}

function collectionFrom(data, keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((current, part) => current?.[part], data);
    if (Array.isArray(value)) return value;
  }
  return [];
}

function contactId(contact) {
  return cleanString(contact?.id || contact?._id || contact?.contactId);
}

function contactName(contact) {
  return cleanString(
    contact?.name ||
      contact?.fullName ||
      `${contact?.firstName || ""} ${contact?.lastName || ""}`
  );
}

function contactAddress(contact) {
  return cleanString(
    contact?.address1 ||
      contact?.address ||
      contact?.streetAddress ||
      contact?.contact?.address1
  ).toLowerCase();
}

function contactTags(contact) {
  const tags = Array.isArray(contact?.tags)
    ? contact.tags
    : Array.isArray(contact?.contactTags)
      ? contact.contactTags
      : [];
  return tags
    .map((tag) => (typeof tag === "string" ? tag : tag?.name || tag?.tag || tag?.label))
    .map(cleanString)
    .filter(Boolean);
}

function normalizeContact(contact) {
  return {
    id: contactId(contact),
    name: contactName(contact),
    phone: normalizePhone(contact?.phone || contact?.phoneNumber || contact?.mobile),
    email: cleanString(contact?.email).toLowerCase(),
    address: contactAddress(contact),
    tags: contactTags(contact),
  };
}

function rowSearchText(row) {
  return [row.jobType, row.name, row.address].map(cleanString).join(" ").toLowerCase();
}

function desiredTagsForRow(row) {
  const text = rowSearchText(row);
  const tags = ["Roofing/Siding"];
  if (/\b(roof|roofing|shingle|flashing|gutter)\b/i.test(text)) tags.push("sal-roofing");
  if (/\b(siding|vinyl|hardie|cedar shake|soffit|fascia)\b/i.test(text)) tags.push("sal-siding");
  return [...new Set(tags)];
}

function sanitizeError(error) {
  return redact({
    statusCode: error?.statusCode || null,
    ghlStatus: error?.ghlStatus || null,
    message: error?.message || String(error || "GHL CSV sync failed"),
    response: error?.response || null,
  });
}

async function searchContacts(query) {
  const cleanQuery = cleanString(query);
  if (!cleanQuery) return [];
  const result = await request({
    method: "POST",
    path: "/contacts/search",
    timeoutMs: Number(process.env.JARVIS_GHL_CONTACT_READ_TIMEOUT_MS || 20000),
    logResponseBody: false,
    body: {
      locationId: getLocationId(),
      page: 1,
      pageLimit: SEARCH_PAGE_LIMIT,
      query: cleanQuery,
    },
  });
  return collectionFrom(result.data, ["contacts", "data", "items"]).map(normalizeContact);
}

function chooseSingleMatch(candidates, predicate) {
  const exact = candidates.filter(predicate).filter((contact) => contact.id);
  if (exact.length === 1) return { status: "found", contact: exact[0], count: 1 };
  if (exact.length > 1) return { status: "multiple", matches: exact, count: exact.length };
  const usable = candidates.filter((contact) => contact.id);
  if (usable.length === 1) return { status: "found", contact: usable[0], count: 1 };
  if (usable.length > 1) return { status: "multiple", matches: usable, count: usable.length };
  return { status: "missing", count: 0 };
}

async function findContact(row) {
  if (row.phone) {
    const rowDigits = digits(row.phone);
    const byPhone = await searchContacts(row.phone);
    const result = chooseSingleMatch(byPhone, (contact) => digits(contact.phone) === rowDigits);
    if (result.status !== "missing") return { ...result, matchMethod: "phone" };
  }

  if (row.email) {
    const byEmail = await searchContacts(row.email);
    const result = chooseSingleMatch(
      byEmail,
      (contact) => cleanString(contact.email).toLowerCase() === row.email
    );
    if (result.status !== "missing") return { ...result, matchMethod: "email" };
  }

  if (row.name && row.address) {
    const byNameAddress = await searchContacts(`${row.name} ${row.address}`);
    const name = row.name.toLowerCase();
    const address = row.address.toLowerCase();
    const result = chooseSingleMatch(byNameAddress, (contact) => {
      const candidateName = contact.name.toLowerCase();
      return candidateName.includes(name) || (contact.address && contact.address.includes(address));
    });
    if (result.status !== "missing") return { ...result, matchMethod: "name_address" };
  }

  return { status: "missing", matchMethod: "none", count: 0 };
}

async function addMissingTags(contact, tags) {
  const existing = new Set(contact.tags.map(normalizeTag));
  const missing = tags.filter((tag) => !existing.has(normalizeTag(tag)));
  if (!missing.length) return { alreadyTagged: true, addedTags: [] };

  await request({
    method: "POST",
    path: `/contacts/${encodeURIComponent(contact.id)}/tags`,
    timeoutMs: Number(process.env.JARVIS_GHL_WRITE_TIMEOUT_MS || 20000),
    logResponseBody: false,
    body: { tags: missing },
  });
  return { alreadyTagged: false, addedTags: missing };
}

async function mapWithConcurrency(items, limit, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}

function missingPreview(row, reason) {
  return {
    rowNumber: row.rowNumber,
    name: row.name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    jobType: row.jobType,
    reason,
  };
}

async function syncEstimateCsvWithGhl(context = {}) {
  const parsedFiles = await parseCsvContext(context);
  const rows = parsedFiles.flatMap((file) =>
    file.contacts.filter((contact) => contact.valid).map((contact) => ({
      ...contact,
      fileName: file.file.originalName,
    }))
  );
  const limited = rows.length > SYNC_MAX_ROWS;
  const rowsToProcess = rows.slice(0, SYNC_MAX_ROWS);
  const report = {
    totalRows: parsedFiles.reduce((total, file) => total + file.totalRows, 0),
    validContacts: rows.length,
    processedRows: rowsToProcess.length,
    foundInGhl: 0,
    notFoundInGhl: 0,
    alreadyTagged: 0,
    newlyTagged: 0,
    multipleMatches: 0,
    errors: [],
    missingContacts: [],
    files: parsedFiles.map((file) => ({
      fileName: file.file.originalName,
      totalRows: file.totalRows,
      validContacts: file.validContacts,
      sampleHeaders: file.sampleHeaders,
    })),
    limited,
    limit: SYNC_MAX_ROWS,
    createdContacts: 0,
  };

  await mapWithConcurrency(rowsToProcess, SYNC_CONCURRENCY, async (row) => {
    try {
      const match = await findContact(row);
      if (match.status === "multiple") {
        report.multipleMatches += 1;
        if (report.missingContacts.length < MISSING_PREVIEW_LIMIT) {
          report.missingContacts.push(missingPreview(row, `multiple ${match.matchMethod} matches`));
        }
        return;
      }
      if (match.status !== "found" || !match.contact?.id) {
        report.notFoundInGhl += 1;
        if (report.missingContacts.length < MISSING_PREVIEW_LIMIT) {
          report.missingContacts.push(missingPreview(row, "not found in GHL"));
        }
        return;
      }

      report.foundInGhl += 1;
      const tagResult = await addMissingTags(match.contact, desiredTagsForRow(row));
      if (tagResult.alreadyTagged) {
        report.alreadyTagged += 1;
      } else {
        report.newlyTagged += 1;
      }
    } catch (error) {
      report.errors.push({
        rowNumber: row.rowNumber,
        fileName: row.fileName,
        error: sanitizeError(error),
      });
    }
  });

  return report;
}

module.exports = {
  desiredTagsForRow,
  findContact,
  syncEstimateCsvWithGhl,
};
