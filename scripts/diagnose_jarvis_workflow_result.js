const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs-extra");
const path = require("path");
const { execFileSync } = require("child_process");
const mongoose = require("mongoose");
const { parse } = require("csv-parse/sync");

const APP_NAME = process.env.EB_APP_NAME || "Handyman-v2";
const ENV_NAME = process.env.EB_ENV_NAME || "Handyman-v2-env";
const REGION = process.env.AWS_REGION || "us-east-1";
const PROFILE = process.env.AWS_PROFILE || "eb-cli";
const SEARCH_PAGE_LIMIT = Number(process.env.JARVIS_DIAG_SEARCH_LIMIT || 10);
const ERROR_VERIFY_LIMIT = Number(process.env.JARVIS_DIAG_ERROR_VERIFY_LIMIT || 61);
const SAMPLE_SIZE = Number(process.env.JARVIS_DIAG_SAMPLE_SIZE || 20);

function cleanString(value) {
  return String(value ?? "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadEbEnv() {
  const output = execFileSync(
    "aws",
    [
      "elasticbeanstalk",
      "describe-configuration-settings",
      "--application-name",
      APP_NAME,
      "--environment-name",
      ENV_NAME,
      "--region",
      REGION,
      "--profile",
      PROFILE,
      "--output",
      "json",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const parsed = JSON.parse(output);
  const settings = parsed.ConfigurationSettings?.[0]?.OptionSettings || [];
  const env = {};
  for (const setting of settings) {
    if (setting.Namespace === "aws:elasticbeanstalk:application:environment") {
      env[setting.OptionName] = setting.Value;
    }
  }

  for (const name of [
    "MONGO_URI",
    "GHL_AI_COMMANDER_TOKEN",
    "GHL_LOCATION_ID",
    "AI_COMMANDER_GHL_API_VERSION",
    "S3_BUCKET",
    "S3_PREFIX",
    "S3_REGION",
    "AWS_REGION",
  ]) {
    if (env[name]) process.env[name] = env[name];
  }
  process.env.AWS_PROFILE = PROFILE;
  process.env.AWS_SDK_LOAD_CONFIG = process.env.AWS_SDK_LOAD_CONFIG || "1";
  return env;
}

function collectionFrom(data, keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((current, part) => current?.[part], data);
    if (Array.isArray(value)) return value;
  }
  return [];
}

function digits(value) {
  return cleanString(value).replace(/\D/g, "");
}

function normalizePhone(value) {
  const valueDigits = digits(value);
  if (valueDigits.length === 10) return `+1${valueDigits}`;
  if (valueDigits.length === 11 && valueDigits.startsWith("1")) return `+${valueDigits}`;
  return cleanString(value);
}

function normalizeTag(value) {
  return cleanString(value).toLowerCase();
}

function normalizeContact(contact) {
  return {
    id: cleanString(contact?.id || contact?._id || contact?.contactId),
    name: cleanString(
      contact?.name ||
        contact?.fullName ||
        `${contact?.firstName || ""} ${contact?.lastName || ""}`
    ),
    phone: normalizePhone(contact?.phone || contact?.phoneNumber || contact?.mobile),
    email: cleanString(contact?.email).toLowerCase(),
    address: cleanString(
      contact?.address1 ||
        contact?.address ||
        contact?.streetAddress ||
        contact?.contact?.address1
    ).toLowerCase(),
    tags: (Array.isArray(contact?.tags)
      ? contact.tags
      : Array.isArray(contact?.contactTags)
        ? contact.contactTags
        : []
    )
      .map((tag) => (typeof tag === "string" ? tag : tag?.name || tag?.tag || tag?.label))
      .map(cleanString)
      .filter(Boolean),
  };
}

function desiredTagsForRow(row) {
  const text = [row.jobType, row.name, row.address].map(cleanString).join(" ").toLowerCase();
  const tags = ["Roofing/Siding"];
  if (/\b(roof|roofing|shingle|flashing|gutter)\b/i.test(text)) tags.push("sal-roofing");
  if (/\b(siding|vinyl|hardie|cedar shake|soffit|fascia)\b/i.test(text)) tags.push("sal-siding");
  return [...new Set(tags)];
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

async function quiet(fn) {
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

async function ghlRequest(input) {
  const { request } = require("../src/aiCommanderGhl/ghlClient");
  return quiet(() => request(input));
}

async function searchContacts(query, reason) {
  const cleanQuery = cleanString(query);
  if (!cleanQuery) return { ok: true, contacts: [], skipped: true };
  try {
    const result = await ghlRequest({
      method: "POST",
      path: "/contacts/search",
      timeoutMs: 30000,
      body: {
        page: 1,
        pageLimit: SEARCH_PAGE_LIMIT,
        query: cleanQuery,
        locationId: process.env.GHL_LOCATION_ID,
      },
    });
    await sleep(75);
    return {
      ok: true,
      contacts: collectionFrom(result.data, ["contacts", "data", "items"]).map(normalizeContact),
      status: result.status,
      reason,
    };
  } catch (error) {
    await sleep(75);
    return {
      ok: false,
      reason,
      queryPreview: cleanQuery.slice(0, 120),
      message: cleanString(error?.message || error),
      statusCode: error?.statusCode || null,
      ghlStatus: error?.ghlStatus || null,
      response: error?.response || null,
    };
  }
}

async function getContact(contactId) {
  if (!contactId) return null;
  try {
    const result = await ghlRequest({
      method: "GET",
      path: `/contacts/${encodeURIComponent(contactId)}`,
      timeoutMs: 30000,
    });
    await sleep(75);
    return normalizeContact(result.data?.contact || result.data);
  } catch {
    await sleep(75);
    return null;
  }
}

async function findContact(row) {
  const attempts = [];
  if (row.phone) {
    const byPhone = await searchContacts(row.phone, "phone");
    attempts.push(byPhone);
    if (!byPhone.ok) return { status: "error", matchMethod: "phone", attempts };
    const rowDigits = digits(row.phone);
    const result = chooseSingleMatch(byPhone.contacts, (contact) => digits(contact.phone) === rowDigits);
    if (result.status !== "missing") return { ...result, matchMethod: "phone", attempts };
  }

  if (row.email) {
    const byEmail = await searchContacts(row.email, "email");
    attempts.push(byEmail);
    if (!byEmail.ok) return { status: "error", matchMethod: "email", attempts };
    const result = chooseSingleMatch(
      byEmail.contacts,
      (contact) => cleanString(contact.email).toLowerCase() === row.email
    );
    if (result.status !== "missing") return { ...result, matchMethod: "email", attempts };
  }

  if (row.name && row.address) {
    const byNameAddress = await searchContacts(`${row.name} ${row.address}`, "name_address");
    attempts.push(byNameAddress);
    if (!byNameAddress.ok) return { status: "error", matchMethod: "name_address", attempts };
    const name = row.name.toLowerCase();
    const address = row.address.toLowerCase();
    const result = chooseSingleMatch(byNameAddress.contacts, (contact) => {
      const candidateName = contact.name.toLowerCase();
      return candidateName.includes(name) || (contact.address && contact.address.includes(address));
    });
    if (result.status !== "missing") return { ...result, matchMethod: "name_address", attempts };
  }

  return { status: "missing", matchMethod: "none", attempts };
}

function parseCsvDownload(content) {
  if (!cleanString(content)) return [];
  return parse(content, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: true,
  });
}

function getDownload(report, filename) {
  return (Array.isArray(report?.downloads) ? report.downloads : []).find((download) =>
    cleanString(download.filename).toLowerCase() === filename.toLowerCase()
  );
}

function rowKey(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function errorMessage(error) {
  return cleanString(error?.message || error?.Error || error?.error?.message || error);
}

function categorizeError(error, report) {
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  const status = cleanString(error?.ghlStatus || error?.["GHL Status"] || error?.statusCode || error?.["Status Code"]);
  const allMatching =
    Number(report?.stepStats?.contactMatching?.errors || 0) >=
    (Array.isArray(report?.errors) ? report.errors.length : 0);

  if (/timeout|timed out|etimedout|econnreset|socket hang up|network timeout/i.test(message)) {
    return "timeout";
  }
  if (/invalid.*(phone|email)|(phone|email).*invalid/i.test(message)) {
    return "invalid phone/email";
  }
  if (/report|download|audit|json|csv/i.test(message) && !/ghl api/i.test(message)) {
    return "report-generation bug";
  }
  if (/tag|\/tags|add missing/i.test(message)) {
    return "tag update error";
  }
  if (allMatching || /contact.*search|contacts\/search|search/i.test(message)) {
    return "search failure";
  }
  if (status || /ghl api|leadconnector|api request failed|429|40\d|50\d/i.test(lower)) {
    return "API error";
  }
  return "other";
}

function summarizeErrors(errors, report) {
  const categories = {
    timeout: [],
    "search failure": [],
    "invalid phone/email": [],
    "API error": [],
    "tag update error": [],
    "report-generation bug": [],
    other: [],
  };
  for (const error of errors) {
    const category = categorizeError(error, report);
    categories[category].push(error);
  }
  return Object.fromEntries(
    Object.entries(categories).map(([category, items]) => [
      category,
      {
        count: items.length,
        rowNumbers: items
          .map((item) => rowKey(item.rowNumber || item["Row Number"]))
          .filter((item) => item !== null),
        messages: [...new Set(items.map(errorMessage).filter(Boolean))].slice(0, 10),
      },
    ])
  );
}

function sampleRows(rows, size) {
  const pool = [...rows];
  const sample = [];
  while (pool.length && sample.length < size) {
    const index = crypto.randomInt(pool.length);
    sample.push(pool.splice(index, 1)[0]);
  }
  return sample.sort((a, b) => a.rowNumber - b.rowNumber);
}

function compactCsvRow(row) {
  return {
    rowNumber: row.rowNumber,
    name: row.name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    jobType: row.jobType,
    estimateAmount: row.estimateAmount,
  };
}

async function verifyRow(row, errorRowsByNumber) {
  const requiredTags = desiredTagsForRow(row);
  const match = await findContact(row);
  const contact =
    match.status === "found" && match.contact?.id
      ? (await getContact(match.contact.id)) || match.contact
      : match.contact || null;
  const tagsBeforeDiagnostic = contact?.tags || [];
  const existing = new Set(tagsBeforeDiagnostic.map(normalizeTag));
  const tagsStillMissing = requiredTags.filter((tag) => !existing.has(normalizeTag(tag)));

  return {
    csv: compactCsvRow(row),
    workflowHadRowError: errorRowsByNumber.has(row.rowNumber),
    ghlContactFound: match.status === "found",
    matchStatus: match.status,
    matchedBy: match.matchMethod,
    matchCount: match.count || (Array.isArray(match.matches) ? match.matches.length : 0),
    ghlContact: contact
      ? {
          id: contact.id,
          name: contact.name,
          phone: contact.phone,
          email: contact.email,
        }
      : null,
    tagsBeforeDiagnostic,
    requiredTags,
    tagsAddedByDiagnostic: [],
    tagsStillMissingAfterWorkflow: tagsStillMissing,
    finalTagsNow: tagsBeforeDiagnostic,
    attempts: match.attempts,
  };
}

async function debugErrorRows(errorRows, rowsByNumber) {
  const output = [];
  for (const error of errorRows.slice(0, ERROR_VERIFY_LIMIT)) {
    const rowNumber = rowKey(error.rowNumber || error["Row Number"]);
    const row = rowsByNumber.get(rowNumber);
    if (!row) {
      output.push({ rowNumber, category: "other", note: "CSV row was not available." });
      continue;
    }
    const match = await findContact(row);
    const failedAttempt = (match.attempts || []).find((attempt) => attempt.ok === false);
    output.push({
      rowNumber,
      csv: compactCsvRow(row),
      reportedError: errorMessage(error),
      statusCode: error.statusCode || error["Status Code"] || null,
      ghlStatus: error.ghlStatus || error["GHL Status"] || null,
      failedAt: failedAttempt?.reason || null,
      retryStatus: match.status,
      retryMatchedBy: match.matchMethod,
      retryFailure: failedAttempt
        ? {
            message: failedAttempt.message,
            statusCode: failedAttempt.statusCode,
            ghlStatus: failedAttempt.ghlStatus,
            response: failedAttempt.response,
          }
        : null,
    });
  }
  return output;
}

function markdownReport(diagnosis) {
  const lines = [];
  lines.push(`# Jarvis Workflow Diagnosis`);
  lines.push("");
  lines.push(`Job ID: ${diagnosis.job.jobId}`);
  lines.push(`Status: ${diagnosis.job.status}`);
  lines.push(`Completed: ${diagnosis.job.completedAt || ""}`);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  for (const [key, value] of Object.entries(diagnosis.reportStats || {})) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push("");
  lines.push(`## Error Categories`);
  lines.push("");
  for (const [category, value] of Object.entries(diagnosis.errorCategories)) {
    lines.push(`- ${category}: ${value.count}`);
  }
  lines.push("");
  lines.push(`## Random 20 Contact Verification`);
  lines.push("");
  for (const item of diagnosis.sampleVerification) {
    lines.push(`### Row ${item.csv.rowNumber}: ${item.csv.name || "(no name)"}`);
    lines.push(`- CSV phone/email/address: ${item.csv.phone || ""} | ${item.csv.email || ""} | ${item.csv.address || ""}`);
    lines.push(`- GHL contact: ${item.ghlContactFound ? "found" : item.matchStatus}`);
    lines.push(`- Matched by: ${item.matchedBy}`);
    lines.push(`- Tags before diagnostic: ${(item.tagsBeforeDiagnostic || []).join(", ") || "(none)"}`);
    lines.push(`- Required tags from CSV: ${(item.requiredTags || []).join(", ") || "(none)"}`);
    lines.push(`- Tags added by diagnostic: none`);
    lines.push(`- Tags still missing after workflow: ${(item.tagsStillMissingAfterWorkflow || []).join(", ") || "(none)"}`);
    lines.push(`- Final tags now: ${(item.finalTagsNow || []).join(", ") || "(none)"}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  loadEbEnv();
  assert(process.env.MONGO_URI, "MONGO_URI was not available from EB");
  assert(process.env.GHL_AI_COMMANDER_TOKEN, "GHL_AI_COMMANDER_TOKEN was not available from EB");
  assert(process.env.GHL_LOCATION_ID, "GHL_LOCATION_ID was not available from EB");

  const JarvisWorkflowJob = require("../src/aiCommanderGhl/jarvisWorkflowJob.model");
  const { parseCsvContext } = require("../src/aiCommanderGhl/jarvisCsvProcessor");

  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });

  const query = process.env.JARVIS_DIAG_JOB_ID
    ? { jobId: process.env.JARVIS_DIAG_JOB_ID }
    : { actionType: "sync_estimate_csv_with_ghl" };
  const job = await JarvisWorkflowJob.findOne(query).sort({ updatedAt: -1 }).lean();
  assert(job, "No Jarvis CSV workflow job was found");

  const report = job.result || job.report || {};
  const auditDownload = getDownload(report, "Audit Report.json");
  const errorDownload = getDownload(report, "Error Report.csv");
  const auditReport = auditDownload?.content ? JSON.parse(auditDownload.content) : report;
  const errorRowsFromDownload = errorDownload?.content ? parseCsvDownload(errorDownload.content) : [];
  const reportErrors = Array.isArray(auditReport.errors) ? auditReport.errors : report.errors || [];
  const normalizedErrors = reportErrors.length
    ? reportErrors
    : errorRowsFromDownload.map((row) => ({
        rowNumber: row["Row Number"],
        fileName: row.File,
        error: { message: row.Error, ghlStatus: row["GHL Status"], statusCode: row["Status Code"] },
      }));
  const flatErrors = normalizedErrors.map((item) => ({
    rowNumber: item.rowNumber,
    fileName: item.fileName,
    message: errorMessage(item.error || item),
    ghlStatus: item.error?.ghlStatus || item.ghlStatus || "",
    statusCode: item.error?.statusCode || item.statusCode || "",
    response: item.error?.response || item.response || null,
  }));
  const errorCategories = summarizeErrors(flatErrors, report);

  const parsedFiles = await parseCsvContext({
    files: job.payload?.files || [],
    uploadBatchId: job.payload?.uploadBatchId,
  });
  const rows = parsedFiles.flatMap((file) =>
    file.contacts
      .filter((contact) => contact.valid)
      .map((contact) => ({ ...contact, fileName: file.file.originalName }))
  );
  const rowsByNumber = new Map(rows.map((row) => [row.rowNumber, row]));
  const errorRowsByNumber = new Set(flatErrors.map((error) => rowKey(error.rowNumber)).filter((value) => value !== null));

  const sample = sampleRows(rows, SAMPLE_SIZE);
  const sampleVerification = [];
  for (const row of sample) {
    sampleVerification.push(await verifyRow(row, errorRowsByNumber));
  }

  const errorRowDiagnostics = await debugErrorRows(flatErrors, rowsByNumber);
  const matchedSampleMissingTags = sampleVerification.filter(
    (item) =>
      item.ghlContactFound &&
      !item.workflowHadRowError &&
      (item.tagsStillMissingAfterWorkflow || []).length > 0
  );

  const diagnosis = {
    generatedAt: new Date().toISOString(),
    job: {
      jobId: job.jobId,
      name: job.name,
      actionType: job.actionType,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      processedItems: job.processedItems,
      totalItems: job.totalItems,
      percent: job.percent,
      currentMessage: job.currentMessage,
    },
    csv: {
      files: parsedFiles.map((file) => ({
        originalName: file.file.originalName,
        totalRows: file.totalRows,
        validContacts: file.validContacts,
        invalidRows: file.invalidRows,
        sampleHeaders: file.sampleHeaders,
      })),
      validRowsLoaded: rows.length,
    },
    reportStats: report.stats || {
      foundInGhl: report.foundInGhl,
      notFoundInGhl: report.notFoundInGhl,
      newlyTagged: report.newlyTagged,
      alreadyTagged: report.alreadyTagged,
      errors: Array.isArray(report.errors) ? report.errors.length : 0,
    },
    rawCounts: {
      foundInGhl: report.foundInGhl,
      notFoundInGhl: report.notFoundInGhl,
      newlyTagged: report.newlyTagged,
      alreadyTagged: report.alreadyTagged,
      multipleMatches: report.multipleMatches,
      errors: flatErrors.length,
      processedRows: report.processedRows,
      totalRows: report.totalRows,
      validContacts: report.validContacts,
    },
    stepStats: report.stepStats || {},
    downloadsPresent: {
      auditReportJson: Boolean(auditDownload?.content),
      errorReportCsv: Boolean(errorDownload?.content),
      missingContactsCsv: Boolean(getDownload(report, "Missing Contacts.csv")?.content),
    },
    errorCategories,
    errorRowDiagnostics,
    sampleVerification,
    diagnosis: {
      matchedSampleMissingRequiredTagsAfterWorkflow: matchedSampleMissingTags.length,
      matchedSampleMissingRequiredTagRows: matchedSampleMissingTags.map((item) => ({
        rowNumber: item.csv.rowNumber,
        missingTags: item.tagsStillMissingAfterWorkflow,
      })),
      summaryMathBalances:
        Number(report.foundInGhl || 0) +
          Number(report.notFoundInGhl || 0) +
          Number(report.multipleMatches || 0) +
          flatErrors.length ===
        Number(report.processedRows || rows.length),
    },
  };

  const outputDir = path.join(process.cwd(), "tmp", "jarvis-diagnostics");
  await fs.ensureDir(outputDir);
  const base = path.join(outputDir, `${job.jobId}-diagnosis`);
  await fs.writeJson(`${base}.json`, diagnosis, { spaces: 2 });
  await fs.writeFile(`${base}.md`, markdownReport(diagnosis));

  console.log(JSON.stringify({
    jobId: diagnosis.job.jobId,
    status: diagnosis.job.status,
    reportStats: diagnosis.reportStats,
    rawCounts: diagnosis.rawCounts,
    stepStats: diagnosis.stepStats,
    downloadsPresent: diagnosis.downloadsPresent,
    errorCategories: Object.fromEntries(
      Object.entries(diagnosis.errorCategories).map(([key, value]) => [key, value.count])
    ),
    matchedSampleMissingRequiredTagsAfterWorkflow:
      diagnosis.diagnosis.matchedSampleMissingRequiredTagsAfterWorkflow,
    summaryMathBalances: diagnosis.diagnosis.summaryMathBalances,
    outputJson: `${base}.json`,
    outputMarkdown: `${base}.md`,
  }, null, 2));

  await mongoose.disconnect();
}

main().catch(async (error) => {
  try {
    await mongoose.disconnect();
  } catch {}
  console.error(error.stack || error.message);
  process.exit(1);
});
