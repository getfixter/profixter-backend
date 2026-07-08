const { executeGhlRequest } = require("./ghlUniversalExecutor");
const { redact } = require("./ghlClient");
const { executeWorkflow } = require("./jarvisWorkflowExecutor");
const { parseCsvContext, normalizePhone } = require("./jarvisCsvProcessor");

const SEARCH_PAGE_LIMIT = Number(process.env.JARVIS_CSV_GHL_SEARCH_LIMIT || 10);
const SYNC_MAX_ROWS = Number(process.env.JARVIS_CSV_SYNC_MAX_ROWS || 5000);
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
    message: error?.message || String(error || "GHL CSV workflow failed"),
    response: error?.response || null,
  });
}

function responseData(result) {
  return result?.response || result?.data || {};
}

async function searchContacts(query, helpers = null, options = {}) {
  const cleanQuery = cleanString(query);
  if (!cleanQuery) return [];
  const apiCall =
    helpers?.apiCall ||
    ((requestShape) =>
      executeGhlRequest({
        ...requestShape,
        approved: options.approved === true,
        adminUserId: options.adminUserId,
        userRequest: options.userRequest,
      }));
  const result = await apiCall({
    method: "POST",
    path: "/contacts/search",
    body: {
      page: 1,
      pageLimit: SEARCH_PAGE_LIMIT,
      query: cleanQuery,
    },
    reason: `Search GHL contact by ${options.reason || "CSV row value"}`,
  });
  return collectionFrom(responseData(result), ["contacts", "data", "items"]).map(normalizeContact);
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

async function findContact(row, helpers = null, options = {}) {
  if (row.phone) {
    const rowDigits = digits(row.phone);
    const byPhone = await searchContacts(row.phone, helpers, { ...options, reason: "phone" });
    const result = chooseSingleMatch(byPhone, (contact) => digits(contact.phone) === rowDigits);
    if (result.status !== "missing") return { ...result, matchMethod: "phone" };
  }

  if (row.email) {
    const byEmail = await searchContacts(row.email, helpers, { ...options, reason: "email" });
    const result = chooseSingleMatch(
      byEmail,
      (contact) => cleanString(contact.email).toLowerCase() === row.email
    );
    if (result.status !== "missing") return { ...result, matchMethod: "email" };
  }

  if (row.name && row.address) {
    const byNameAddress = await searchContacts(`${row.name} ${row.address}`, helpers, {
      ...options,
      reason: "name and address",
    });
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

async function addMissingTags(contact, tags, helpers = null, options = {}) {
  const existing = new Set(contact.tags.map(normalizeTag));
  const missing = tags.filter((tag) => !existing.has(normalizeTag(tag)));
  if (!missing.length) return { alreadyTagged: true, addedTags: [] };

  const apiCall =
    helpers?.apiCall ||
    ((requestShape) =>
      executeGhlRequest({
        ...requestShape,
        approved: options.approved === true,
        adminUserId: options.adminUserId,
        userRequest: options.userRequest,
      }));
  await apiCall({
    method: "POST",
    path: `/contacts/${encodeURIComponent(contact.id)}/tags`,
    body: { tags: missing },
    reason: "Add missing CSV workflow tags to matched GHL contact",
  });
  return { alreadyTagged: false, addedTags: missing };
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

function initializeReport(parsedFiles, rowsToProcess, limited) {
  return {
    totalRows: parsedFiles.reduce((total, file) => total + file.totalRows, 0),
    validContacts: parsedFiles.reduce((total, file) => total + file.validContacts, 0),
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
}

async function processCsvRow({ row, report, applyTags, helpers, options }) {
  try {
    const match = await findContact(row, helpers, options);
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
    if (!applyTags) return;

    const tagResult = await addMissingTags(
      match.contact,
      desiredTagsForRow(row),
      helpers,
      options
    );
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
}

async function executeCsvGhlWorkflow(context = {}, { applyTags = false } = {}) {
  const parsedFiles = await parseCsvContext(context);
  const rows = parsedFiles.flatMap((file) =>
    file.contacts.filter((contact) => contact.valid).map((contact) => ({
      ...contact,
      fileName: file.file.originalName,
    }))
  );
  const limited = rows.length > SYNC_MAX_ROWS;
  const rowsToProcess = rows.slice(0, SYNC_MAX_ROWS);
  const report = initializeReport(parsedFiles, rowsToProcess, limited);
  const name = applyTags ? "csv_ghl_tag_sync" : "csv_ghl_audit";
  const approved = applyTags ? context.approved === true : false;

  const workflow = await executeWorkflow({
    name,
    approvalRequired: applyTags,
    approved,
    adminUserId: context.adminUserId,
    userRequest: context.userRequest,
    context: {
      report,
      rows: rowsToProcess,
    },
    steps: [
      { type: "progress", message: "Reading CSV..." },
      {
        type: "progress",
        message: `${rowsToProcess.length.toLocaleString("en-US")} valid contacts ready.`,
      },
      {
        type: "loop",
        items: "$.rows",
        itemVar: "row",
        indexVar: "rowIndex",
        progressEvery: 50,
        progressMessage: "Searching contact ${rowIndexDisplay} / ${loopLength}...",
        continueOnError: true,
        steps: [
          {
            type: "transform",
            continueOnError: true,
            handler: async (helpers) =>
              processCsvRow({
                row: helpers.variables.row,
                report: helpers.variables.report,
                applyTags,
                helpers,
                options: {
                  approved,
                  adminUserId: context.adminUserId,
                  userRequest: context.userRequest,
                },
              }),
          },
        ],
      },
      { type: "progress", message: applyTags ? "Applying tags complete." : "Audit complete." },
      { type: "progress", message: "Finished." },
      { type: "report", value: "$.report" },
    ],
  });

  return {
    ...report,
    workflow: {
      name: workflow.name,
      status: workflow.status,
      progress: workflow.progress,
      errors: workflow.errors,
      stepCount: workflow.stepCount,
      approvalRequired: workflow.approvalRequired,
    },
  };
}

async function auditEstimateCsvAgainstGhl(context = {}) {
  return executeCsvGhlWorkflow(context, { applyTags: false });
}

async function syncEstimateCsvWithGhl(context = {}) {
  return executeCsvGhlWorkflow(context, { applyTags: true });
}

module.exports = {
  auditEstimateCsvAgainstGhl,
  desiredTagsForRow,
  findContact,
  syncEstimateCsvWithGhl,
};
