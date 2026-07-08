const fs = require("fs-extra");
const path = require("path");
const { parse } = require("csv-parse/sync");

const LOCAL_UPLOAD_ROOT =
  process.env.JARVIS_UPLOAD_TMP_DIR ||
  path.join(process.cwd(), "tmp", "jarvis-uploads");
const MAX_CSV_BYTES = Number(process.env.JARVIS_CSV_MAX_BYTES || 50 * 1024 * 1024);
const MAX_PREVIEW_ROWS = 10;

function cleanString(value) {
  return String(value ?? "").trim();
}

function normalizeKey(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/^\uFEFF/, "")
    .replace(/[^a-z0-9]+/g, "");
}

function isCsvFile(file) {
  const extension = cleanString(file?.extension || path.extname(file?.originalName || ""))
    .replace(/^\./, "")
    .toLowerCase();
  const mimeType = cleanString(file?.mimeType).toLowerCase();
  return extension === "csv" || mimeType.includes("csv");
}

function safeLocalPath(tempRef) {
  const relative = cleanString(tempRef).replace(/^local:/, "");
  if (!relative || path.isAbsolute(relative) || relative.includes("..")) {
    const error = new Error("Invalid Jarvis local attachment reference.");
    error.statusCode = 400;
    throw error;
  }
  const root = path.resolve(LOCAL_UPLOAD_ROOT);
  const absolute = path.resolve(root, relative);
  const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolute !== root && !absolute.startsWith(rootWithSeparator)) {
    const error = new Error("Jarvis attachment path is outside the upload directory.");
    error.statusCode = 400;
    throw error;
  }
  return absolute;
}

async function readS3Attachment(tempRef) {
  const key = cleanString(tempRef).replace(/^s3:/, "");
  const expectedPrefix = cleanString(process.env.S3_PREFIX || "uploads").replace(/^\/+|\/+$/g, "");
  if (!key || !key.startsWith(`${expectedPrefix}/jarvis-temp/`)) {
    const error = new Error("Invalid Jarvis S3 attachment reference.");
    error.statusCode = 400;
    throw error;
  }
  const { getObjectBuffer } = require("../../utils/s3");
  return getObjectBuffer({ Key: key });
}

async function readAttachmentBuffer(file) {
  const tempRef = cleanString(file?.tempRef);
  if (!tempRef) {
    const error = new Error("Jarvis attachment is missing a temporary reference.");
    error.statusCode = 400;
    throw error;
  }

  let buffer;
  if (tempRef.startsWith("local:")) {
    const absolute = safeLocalPath(tempRef);
    const stat = await fs.stat(absolute);
    if (stat.size > MAX_CSV_BYTES) {
      const error = new Error("CSV attachment is larger than the supported Jarvis limit.");
      error.statusCode = 413;
      throw error;
    }
    buffer = await fs.readFile(absolute);
  } else if (tempRef.startsWith("s3:")) {
    buffer = await readS3Attachment(tempRef);
  } else {
    const error = new Error("Unsupported Jarvis attachment storage reference.");
    error.statusCode = 400;
    throw error;
  }

  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || "");
  if (buffer.length > MAX_CSV_BYTES) {
    const error = new Error("CSV attachment is larger than the supported Jarvis limit.");
    error.statusCode = 413;
    throw error;
  }
  return buffer;
}

function mapHeaders(headers) {
  const mapped = new Map();
  for (const header of headers) {
    const key = normalizeKey(header);
    if (key && !mapped.has(key)) mapped.set(key, header);
  }
  return mapped;
}

function pick(record, headerMap, aliases) {
  for (const alias of aliases) {
    const header = headerMap.get(normalizeKey(alias));
    const value = header ? cleanString(record[header]) : "";
    if (value) return value;
  }
  return "";
}

function normalizePhone(value) {
  const digits = cleanString(value).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return cleanString(value);
}

function normalizeEmail(value) {
  return cleanString(value).toLowerCase();
}

function normalizeAmount(value) {
  const number = Number(cleanString(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function joinAddress(parts) {
  return parts.map(cleanString).filter(Boolean).join(", ");
}

function normalizeRow(record, headers, index) {
  const headerMap = mapHeaders(headers);
  const firstName = pick(record, headerMap, ["first name", "firstname", "first"]);
  const lastName = pick(record, headerMap, ["last name", "lastname", "last"]);
  const name =
    pick(record, headerMap, [
      "name",
      "customer name",
      "customer",
      "client name",
      "contact name",
      "full name",
      "homeowner",
    ]) || joinAddress([firstName, lastName]).replace(",", "");
  const phone = normalizePhone(
    pick(record, headerMap, [
      "phone",
      "phone number",
      "mobile",
      "mobile phone",
      "cell",
      "cell phone",
      "primary phone",
      "customer phone",
    ])
  );
  const email = normalizeEmail(
    pick(record, headerMap, [
      "email",
      "email address",
      "customer email",
      "client email",
      "primary email",
    ])
  );
  const address =
    pick(record, headerMap, [
      "address",
      "customer address",
      "service address",
      "property address",
      "street address",
      "address 1",
      "address1",
    ]) ||
    joinAddress([
      pick(record, headerMap, ["street", "line 1", "line1"]),
      pick(record, headerMap, ["city"]),
      pick(record, headerMap, ["state"]),
      pick(record, headerMap, ["zip", "zipcode", "postal code", "postalcode"]),
    ]);
  const jobType = pick(record, headerMap, [
    "job type",
    "jobtype",
    "category",
    "service",
    "project type",
    "trade",
    "work type",
    "work requested",
    "description",
  ]);
  const estimateAmount = normalizeAmount(
    pick(record, headerMap, [
      "estimate amount",
      "estimate",
      "amount",
      "total",
      "price",
      "value",
      "proposal amount",
      "quote amount",
    ])
  );

  return {
    rowNumber: index + 2,
    name,
    phone,
    email,
    address,
    jobType,
    estimateAmount,
    valid: Boolean(phone || email || name),
  };
}

function parseCsvBuffer(buffer, file) {
  const text = buffer.toString("utf8");
  const records = parse(text, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: true,
  });
  const headers = records.length ? Object.keys(records[0]) : [];
  const contacts = records.map((record, index) => normalizeRow(record, headers, index));
  const validContacts = contacts.filter((contact) => contact.valid);

  return {
    file: {
      uploadId: cleanString(file?.uploadId),
      originalName: cleanString(file?.originalName || file?.displayName || "CSV attachment"),
      size: Number(file?.size || buffer.length),
      tempRef: cleanString(file?.tempRef),
      storage: cleanString(file?.storage),
    },
    headers,
    sampleHeaders: headers.slice(0, 20),
    totalRows: records.length,
    validContacts: validContacts.length,
    invalidRows: contacts.length - validContacts.length,
    contacts,
    preview: validContacts.slice(0, MAX_PREVIEW_ROWS),
  };
}

async function parseCsvAttachment(file) {
  if (!isCsvFile(file)) {
    const error = new Error("The selected Jarvis attachment is not a CSV file.");
    error.statusCode = 400;
    throw error;
  }
  const buffer = await readAttachmentBuffer(file);
  return parseCsvBuffer(buffer, file);
}

function csvFilesFromContext(context = {}) {
  return (Array.isArray(context.files) ? context.files : []).filter(isCsvFile);
}

async function parseCsvContext(context = {}) {
  const files = csvFilesFromContext(context);
  if (!files.length) {
    const error = new Error("Attach a CSV file for Jarvis to process.");
    error.statusCode = 400;
    throw error;
  }
  const parsed = [];
  for (const file of files) {
    parsed.push(await parseCsvAttachment(file));
  }
  return parsed;
}

async function countCsvContacts(context = {}) {
  const files = await parseCsvContext(context);
  const totalRows = files.reduce((total, file) => total + file.totalRows, 0);
  const validContacts = files.reduce((total, file) => total + file.validContacts, 0);
  const invalidRows = files.reduce((total, file) => total + file.invalidRows, 0);

  return {
    totalRows,
    validContacts,
    invalidRows,
    files: files.map((file) => ({
      file: file.file,
      totalRows: file.totalRows,
      validContacts: file.validContacts,
      invalidRows: file.invalidRows,
      sampleHeaders: file.sampleHeaders,
      preview: file.preview,
    })),
  };
}

module.exports = {
  countCsvContacts,
  csvFilesFromContext,
  normalizePhone,
  parseCsvAttachment,
  parseCsvBuffer,
  parseCsvContext,
};
