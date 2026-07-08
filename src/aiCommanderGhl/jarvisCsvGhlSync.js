const { executeGhlRequest } = require("./ghlUniversalExecutor");
const { redact } = require("./ghlClient");
const { executeWorkflow } = require("./jarvisWorkflowExecutor");
const { parseCsvContext, normalizePhone } = require("./jarvisCsvProcessor");

const SEARCH_PAGE_LIMIT = Number(process.env.JARVIS_CSV_GHL_SEARCH_LIMIT || 10);
const SYNC_MAX_ROWS = Number(process.env.JARVIS_CSV_SYNC_MAX_ROWS || 5000);
const MISSING_PREVIEW_LIMIT = Number(process.env.JARVIS_CSV_MISSING_PREVIEW_LIMIT || 25);
const PROGRESS_EVERY = Math.max(
  1,
  Number(process.env.JARVIS_WORKFLOW_PROGRESS_EVERY || 50)
);

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

function csvCell(value) {
  const text = cleanString(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function csvFromRows(rows, columns) {
  return [
    columns.map((column) => csvCell(column.label)).join(","),
    ...rows.map((row) =>
      columns.map((column) => csvCell(row[column.key])).join(",")
    ),
  ].join("\n");
}

function durationLabel(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function successRate(report) {
  const processed = Number(report.processedRows || 0);
  if (!processed) return "100%";
  const errors = Number(report.errors?.length || 0);
  return `${(((processed - errors) / processed) * 100).toFixed(1)}%`;
}

function workflowConcurrency() {
  const value = Number(
    process.env.JARVIS_WORKFLOW_CONCURRENCY ||
      process.env.JARVIS_CSV_GHL_SYNC_CONCURRENCY ||
      2
  );
  if (Number.isFinite(value) && value > 0) return Math.min(20, Math.floor(value));
  return 2;
}

function failedRowRetryConcurrency() {
  const value = Number(process.env.JARVIS_CSV_FAILED_ROW_RETRY_CONCURRENCY || 1);
  if (Number.isFinite(value) && value > 0) return Math.min(5, Math.floor(value));
  return 1;
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

function contactDownloadRow(row, reason) {
  return {
    rowNumber: row.rowNumber,
    name: row.name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    jobType: row.jobType,
    estimateAmount: row.estimateAmount ?? "",
    reason,
  };
}

function defaultStepStats(parsedFiles) {
  return {
    csvRead: {
      files: parsedFiles.length,
      totalRows: parsedFiles.reduce((total, file) => total + file.totalRows, 0),
      validContacts: parsedFiles.reduce((total, file) => total + file.validContacts, 0),
      invalidRows: parsedFiles.reduce((total, file) => total + file.invalidRows, 0),
    },
    contactMatching: {
      processed: 0,
      found: 0,
      missing: 0,
      multipleMatches: 0,
      errors: 0,
      resolvedAfterRetry: 0,
      resolvedAfterRetryFound: 0,
      resolvedAfterRetryMissing: 0,
    },
    tagging: {
      checked: 0,
      newlyTagged: 0,
      alreadyTagged: 0,
      failed: 0,
    },
  };
}

function mergeStepStats(parsedFiles, savedStepStats = {}) {
  const defaults = defaultStepStats(parsedFiles);
  return {
    csvRead: { ...defaults.csvRead, ...(savedStepStats.csvRead || {}) },
    contactMatching: {
      ...defaults.contactMatching,
      ...(savedStepStats.contactMatching || {}),
    },
    tagging: { ...defaults.tagging, ...(savedStepStats.tagging || {}) },
  };
}

function initializeReport(parsedFiles, rowsToProcess, limited, initialReport = null) {
  if (initialReport && typeof initialReport === "object") {
    return {
      ...initialReport,
      processedRows: rowsToProcess.length,
      limited,
      limit: SYNC_MAX_ROWS,
      errors: Array.isArray(initialReport.errors) ? initialReport.errors : [],
      missingContacts: Array.isArray(initialReport.missingContacts)
        ? initialReport.missingContacts
        : [],
      missingContactsDownload: Array.isArray(initialReport.missingContactsDownload)
        ? initialReport.missingContactsDownload
        : [],
      resolvedAfterRetry: Number(initialReport.resolvedAfterRetry || 0),
      resolvedAfterRetryFound: Number(initialReport.resolvedAfterRetryFound || 0),
      resolvedAfterRetryMissing: Number(initialReport.resolvedAfterRetryMissing || 0),
      stepStats: mergeStepStats(parsedFiles, initialReport.stepStats || {}),
    };
  }

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
    resolvedAfterRetry: 0,
    resolvedAfterRetryFound: 0,
    resolvedAfterRetryMissing: 0,
    missingContacts: [],
    missingContactsDownload: [],
    files: parsedFiles.map((file) => ({
      fileName: file.file.originalName,
      totalRows: file.totalRows,
      validContacts: file.validContacts,
      sampleHeaders: file.sampleHeaders,
    })),
    limited,
    limit: SYNC_MAX_ROWS,
    createdContacts: 0,
    stepStats: defaultStepStats(parsedFiles),
  };
}

function shouldEmitRowProgress(done, total) {
  return done === 1 || done === total || done % PROGRESS_EVERY === 0;
}

function emptyRetryReport() {
  return {
    foundInGhl: 0,
    notFoundInGhl: 0,
    alreadyTagged: 0,
    newlyTagged: 0,
    multipleMatches: 0,
    errors: [],
    missingContacts: [],
    missingContactsDownload: [],
    stepStats: {
      contactMatching: {
        processed: 0,
        found: 0,
        missing: 0,
        multipleMatches: 0,
        errors: 0,
        resolvedAfterRetry: 0,
        resolvedAfterRetryFound: 0,
        resolvedAfterRetryMissing: 0,
      },
      tagging: {
        checked: 0,
        newlyTagged: 0,
        alreadyTagged: 0,
        failed: 0,
      },
    },
  };
}

function pushLimited(target, items, limit = MISSING_PREVIEW_LIMIT) {
  for (const item of items) {
    if (target.length >= limit) break;
    target.push(item);
  }
}

function decrementStat(target, key) {
  target[key] = Math.max(0, Number(target[key] || 0) - 1);
}

function mergeRetrySuccess(report, retryReport, originalError = {}) {
  const phase = originalError.phase || "matching";
  report.resolvedAfterRetry = Number(report.resolvedAfterRetry || 0) + 1;
  report.stepStats.contactMatching.resolvedAfterRetry =
    Number(report.stepStats.contactMatching.resolvedAfterRetry || 0) + 1;

  if (retryReport.foundInGhl > 0) {
    report.resolvedAfterRetryFound = Number(report.resolvedAfterRetryFound || 0) + 1;
    report.stepStats.contactMatching.resolvedAfterRetryFound =
      Number(report.stepStats.contactMatching.resolvedAfterRetryFound || 0) + 1;
  }
  if (retryReport.notFoundInGhl > 0) {
    report.resolvedAfterRetryMissing = Number(report.resolvedAfterRetryMissing || 0) + 1;
    report.stepStats.contactMatching.resolvedAfterRetryMissing =
      Number(report.stepStats.contactMatching.resolvedAfterRetryMissing || 0) + 1;
  }

  if (phase === "tagging") {
    decrementStat(report.stepStats.tagging, "failed");
    report.alreadyTagged += retryReport.alreadyTagged;
    report.newlyTagged += retryReport.newlyTagged;
    report.stepStats.tagging.alreadyTagged += retryReport.stepStats.tagging.alreadyTagged;
    report.stepStats.tagging.newlyTagged += retryReport.stepStats.tagging.newlyTagged;
    return;
  }

  decrementStat(report.stepStats.contactMatching, "errors");
  report.foundInGhl += retryReport.foundInGhl;
  report.notFoundInGhl += retryReport.notFoundInGhl;
  report.multipleMatches += retryReport.multipleMatches;
  report.alreadyTagged += retryReport.alreadyTagged;
  report.newlyTagged += retryReport.newlyTagged;
  report.stepStats.contactMatching.found += retryReport.stepStats.contactMatching.found;
  report.stepStats.contactMatching.missing += retryReport.stepStats.contactMatching.missing;
  report.stepStats.contactMatching.multipleMatches +=
    retryReport.stepStats.contactMatching.multipleMatches;
  report.stepStats.tagging.checked += retryReport.stepStats.tagging.checked;
  report.stepStats.tagging.alreadyTagged += retryReport.stepStats.tagging.alreadyTagged;
  report.stepStats.tagging.newlyTagged += retryReport.stepStats.tagging.newlyTagged;
  report.stepStats.tagging.failed += retryReport.stepStats.tagging.failed;
  pushLimited(report.missingContacts, retryReport.missingContacts);
  report.missingContactsDownload.push(...retryReport.missingContactsDownload);
}

async function processCsvRow({ row, report, applyTags, helpers, options }) {
  let phase = "matching";
  try {
    report.stepStats.contactMatching.processed += 1;
    const match = await findContact(row, helpers, options);
    if (match.status === "multiple") {
      report.multipleMatches += 1;
      report.stepStats.contactMatching.multipleMatches += 1;
      report.missingContactsDownload.push(
        contactDownloadRow(row, `multiple ${match.matchMethod} matches`)
      );
      if (report.missingContacts.length < MISSING_PREVIEW_LIMIT) {
        report.missingContacts.push(missingPreview(row, `multiple ${match.matchMethod} matches`));
      }
      return;
    }
    if (match.status !== "found" || !match.contact?.id) {
      report.notFoundInGhl += 1;
      report.stepStats.contactMatching.missing += 1;
      report.missingContactsDownload.push(contactDownloadRow(row, "not found in GHL"));
      if (report.missingContacts.length < MISSING_PREVIEW_LIMIT) {
        report.missingContacts.push(missingPreview(row, "not found in GHL"));
      }
      return;
    }

    report.foundInGhl += 1;
    report.stepStats.contactMatching.found += 1;
    if (!applyTags) return;

    phase = "tagging";
    report.stepStats.tagging.checked += 1;
    const tagResult = await addMissingTags(
      match.contact,
      desiredTagsForRow(row),
      helpers,
      options
    );
    if (tagResult.alreadyTagged) {
      report.alreadyTagged += 1;
      report.stepStats.tagging.alreadyTagged += 1;
    } else {
      report.newlyTagged += 1;
      report.stepStats.tagging.newlyTagged += 1;
    }
  } catch (error) {
    if (phase === "tagging") {
      report.stepStats.tagging.failed += 1;
    } else {
      report.stepStats.contactMatching.errors += 1;
    }
    report.errors.push({
      rowNumber: row.rowNumber,
      fileName: row.fileName,
      phase,
      error: sanitizeError(error),
    });
  }
}

async function retryFailedRows({ report, rowsByNumber, applyTags, helpers, options }) {
  const failedRows = Array.isArray(report.errors) ? [...report.errors] : [];
  if (!failedRows.length) return;

  await helpers.emitProgress(`Retrying ${failedRows.length.toLocaleString("en-US")} failed rows...`, {
    failedRows: failedRows.length,
  });

  const remainingErrors = [];
  let resolved = 0;

  await mapWithConcurrency(
    failedRows,
    failedRowRetryConcurrency(),
    async (originalError) => {
      const row = rowsByNumber.get(Number(originalError.rowNumber));
      if (!row) {
        remainingErrors.push(originalError);
        return;
      }

      const retryReport = emptyRetryReport();
      await processCsvRow({
        row,
        report: retryReport,
        applyTags,
        helpers,
        options: {
          ...options,
          retryingFailedRow: true,
        },
      });

      if (retryReport.errors.length) {
        remainingErrors.push({
          ...retryReport.errors[0],
          retryOf: {
            rowNumber: originalError.rowNumber,
            error: originalError.error,
          },
        });
        return;
      }

      mergeRetrySuccess(report, retryReport, originalError);
      resolved += 1;
    }
  );

  report.errors = remainingErrors.sort((a, b) => Number(a.rowNumber || 0) - Number(b.rowNumber || 0));
  await helpers.emitProgress(
    `Failed-row retry resolved ${resolved.toLocaleString("en-US")} / ${failedRows.length.toLocaleString("en-US")}.`,
    {
      resolved,
      unresolved: report.errors.length,
    }
  );
}

function buildCsvWorkflowReport({ report, applyTags, executionMs }) {
  const title = applyTags ? "Roofing/Siding Sync Completed" : "CSV Audit Completed";
  const missingCount = Number(report.notFoundInGhl || 0);
  const errorCount = Number(report.errors?.length || 0);
  const resolvedAfterRetry = Number(report.resolvedAfterRetry || 0);
  const stats = {
    csvContactsProcessed: Number(report.processedRows || 0),
    contactsFoundInGhl: Number(report.foundInGhl || 0),
    missingContacts: missingCount,
    resolvedAfterRetry,
    unresolvedErrors: errorCount,
    newRoofingSidingTagsAdded: Number(report.newlyTagged || 0),
    alreadyTagged: Number(report.alreadyTagged || 0),
    multipleMatches: Number(report.multipleMatches || 0),
    errors: errorCount,
    successRate: successRate(report),
  };
  const warnings = [];

  if (!applyTags) {
    warnings.push("This was a read-only audit. No GHL records were changed.");
  } else if (report.foundInGhl > 0 && report.newlyTagged === 0) {
    warnings.push(
      `${report.foundInGhl.toLocaleString("en-US")} contacts were already tagged. No new tags were required.`
    );
  } else if (report.foundInGhl === 0) {
    warnings.push("No matching GHL contacts were found, so no tags were added.");
  }
  if (report.limited) {
    warnings.push(`The workflow processed the first ${report.limit.toLocaleString("en-US")} valid contacts due to the configured safety limit.`);
  }
  if (report.multipleMatches > 0) {
    warnings.push(`${report.multipleMatches.toLocaleString("en-US")} rows had multiple possible GHL matches and were not changed.`);
  }
  if (resolvedAfterRetry > 0) {
    warnings.push(`${resolvedAfterRetry.toLocaleString("en-US")} temporary GHL errors were resolved after retry.`);
  }

  const missingRows = Array.isArray(report.missingContactsDownload)
    ? report.missingContactsDownload
    : [];
  const errorRows = (Array.isArray(report.errors) ? report.errors : []).map((item) => ({
    rowNumber: item.rowNumber,
    fileName: item.fileName,
    message: item.error?.message || "",
    ghlStatus: item.error?.ghlStatus || "",
    statusCode: item.error?.statusCode || "",
  }));
  const auditPayload = {
    summary: title,
    stats,
    warnings,
    files: report.files,
    stepStats: report.stepStats,
    resolvedAfterRetry: report.resolvedAfterRetry || 0,
    resolvedAfterRetryFound: report.resolvedAfterRetryFound || 0,
    resolvedAfterRetryMissing: report.resolvedAfterRetryMissing || 0,
    missingContacts: missingRows,
    errors: report.errors,
  };

  const downloads = [
    {
      label: "Download Audit Report.json",
      filename: "Audit Report.json",
      contentType: "application/json",
      content: JSON.stringify(auditPayload, null, 2),
    },
  ];
  if (missingRows.length) {
    downloads.unshift({
      label: "Download Missing Contacts.csv",
      filename: "Missing Contacts.csv",
      contentType: "text/csv",
      content: csvFromRows(missingRows, [
        { key: "rowNumber", label: "Row Number" },
        { key: "name", label: "Name" },
        { key: "phone", label: "Phone" },
        { key: "email", label: "Email" },
        { key: "address", label: "Address" },
        { key: "jobType", label: "Job Type" },
        { key: "estimateAmount", label: "Estimate Amount" },
        { key: "reason", label: "Reason" },
      ]),
    });
  }
  if (errorRows.length) {
    downloads.splice(missingRows.length ? 1 : 0, 0, {
      label: "Download Error Report.csv",
      filename: "Error Report.csv",
      contentType: "text/csv",
      content: csvFromRows(errorRows, [
        { key: "rowNumber", label: "Row Number" },
        { key: "fileName", label: "File" },
        { key: "message", label: "Error" },
        { key: "ghlStatus", label: "GHL Status" },
        { key: "statusCode", label: "Status Code" },
      ]),
    });
  }

  const recommendations = [];
  if (missingCount > 0) {
    recommendations.push(`Import the ${missingCount.toLocaleString("en-US")} missing contacts into GHL.`);
    recommendations.push("Re-run the sync after import.");
  }
  if (!applyTags && report.foundInGhl > 0) {
    recommendations.push("Run the Roofing/Siding tag sync for the matched contacts.");
  }
  if (applyTags && report.foundInGhl > 0) {
    recommendations.push("Create Opportunities for these leads.");
    recommendations.push("Launch the Roofing/Siding campaign.");
  }
  if (!recommendations.length) {
    recommendations.push("No follow-up action is required right now.");
  }

  const aiSummary = applyTags
    ? `I checked all ${stats.csvContactsProcessed.toLocaleString("en-US")} estimate contacts. ${stats.contactsFoundInGhl.toLocaleString("en-US")} already existed in GHL. ${stats.resolvedAfterRetry.toLocaleString("en-US")} temporary GHL errors were resolved after retry. ${stats.newRoofingSidingTagsAdded.toLocaleString("en-US")} required new Roofing/Siding tags. ${stats.missingContacts.toLocaleString("en-US")} contacts were not found and were prepared for import. ${stats.unresolvedErrors === 0 ? "No unresolved API errors occurred." : `${stats.unresolvedErrors.toLocaleString("en-US")} unresolved API errors were prepared for review.`}`
    : `I checked all ${stats.csvContactsProcessed.toLocaleString("en-US")} CSV contacts against GHL. ${stats.contactsFoundInGhl.toLocaleString("en-US")} were found, ${stats.missingContacts.toLocaleString("en-US")} were missing, ${stats.resolvedAfterRetry.toLocaleString("en-US")} temporary GHL errors were resolved after retry, and ${stats.multipleMatches.toLocaleString("en-US")} had multiple possible matches. No GHL records were changed.`;

  return {
    summary: {
      title,
      status: "completed",
      aiSummary,
    },
    stats,
    warnings,
    downloads,
    recommendations,
    executionTime: {
      ms: executionMs,
      label: durationLabel(executionMs),
    },
    developerDetails: {
      stepStats: report.stepStats,
      apiCalls: [
        {
          method: "POST",
          path: "/contacts/search",
          purpose: "Search contacts by phone, email, then name and address.",
          mutating: false,
        },
        ...(applyTags
          ? [
              {
                method: "POST",
                path: "/contacts/:contactId/tags",
                purpose: "Add missing Roofing/Siding tags to matched contacts.",
                mutating: true,
              },
            ]
          : []),
      ],
      workflowLog: report.workflow?.progress || [],
      executionTimeline: report.workflow?.progress || [],
      files: report.files,
    },
  };
}

async function executeCsvGhlWorkflow(context = {}, { applyTags = false } = {}) {
  const startedAtMs = context.startedAt
    ? new Date(context.startedAt).getTime()
    : Date.now();
  const parsedFiles = await parseCsvContext(context);
  const rows = parsedFiles.flatMap((file) =>
    file.contacts.filter((contact) => contact.valid).map((contact) => ({
      ...contact,
      fileName: file.file.originalName,
    }))
  );
  const limited = rows.length > SYNC_MAX_ROWS;
  const rowsToProcess = rows.slice(0, SYNC_MAX_ROWS);
  const completedIndexes = new Set(
    Array.isArray(context.completedIndexes)
      ? context.completedIndexes.map((value) => Number(value)).filter(Number.isFinite)
      : []
  );
  const report = initializeReport(parsedFiles, rowsToProcess, limited, context.initialReport);
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
        type: "transform",
        continueOnError: true,
        handler: async (helpers) => {
          const pendingRows = rowsToProcess
            .map((row, index) => ({ row, index }))
            .filter((item) => !completedIndexes.has(item.index));
          const total = rowsToProcess.length;
          let completedCount = completedIndexes.size;

          await mapWithConcurrency(pendingRows, workflowConcurrency(), async ({ row, index }) => {
            await processCsvRow({
              row,
              report: helpers.variables.report,
              applyTags,
              helpers,
              options: {
                approved,
                adminUserId: context.adminUserId,
                userRequest: context.userRequest,
              },
            });

            completedIndexes.add(index);
            completedCount = completedIndexes.size;
            const progressMessage = shouldEmitRowProgress(completedCount, total)
              ? `Processing ${completedCount.toLocaleString("en-US")} / ${total.toLocaleString("en-US")}...`
              : "";
            if (progressMessage) await helpers.emitProgress(progressMessage, {
              processed: completedCount,
              total,
            });
            if (typeof context.onRowComplete === "function") {
              await context.onRowComplete({
                index,
                row,
                report: helpers.variables.report,
                completedIndexes: [...completedIndexes].sort((a, b) => a - b),
                processedItems: completedCount,
                totalItems: total,
                percent: total ? Math.round((completedCount / total) * 100) : 100,
                message: progressMessage || `Processed ${completedCount} / ${total}`,
              });
            }
          });
        },
      },
      {
        type: "transform",
        continueOnError: true,
        handler: async (helpers) => {
          await retryFailedRows({
            report: helpers.variables.report,
            rowsByNumber: new Map(rowsToProcess.map((row) => [row.rowNumber, row])),
            applyTags,
            helpers,
            options: {
              approved,
              adminUserId: context.adminUserId,
              userRequest: context.userRequest,
            },
          });
        },
      },
      { type: "progress", message: applyTags ? "Applying tags complete." : "Audit complete." },
      { type: "progress", message: "Finished." },
      { type: "report", value: "$.report" },
    ],
  });
  const executionMs = Date.now() - (Number.isFinite(startedAtMs) ? startedAtMs : Date.now());

  const finalReport = {
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
  const structuredReport = buildCsvWorkflowReport({
    report: finalReport,
    applyTags,
    executionMs,
  });

  return {
    ...finalReport,
    ...structuredReport,
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
