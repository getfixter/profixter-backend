const path = require("path");

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const INVOICE_STATUSES = Object.freeze([
  "Draft",
  "Sent",
  "Partially Paid",
  "Paid in Full",
  "Overdue",
  "Voided",
  "Superseded",
]);

const LINE_ITEM_CATEGORIES = Object.freeze([
  "Contract work",
  "Change order",
  "Materials",
  "Labor",
  "Permit/fee",
  "Credit",
  "Other",
]);

const DISCOUNT_TYPES = Object.freeze(["fixed", "percentage", "credit"]);

const PAYMENT_METHODS = Object.freeze([
  "Cash",
  "Check",
  "Credit Card",
  "ACH / Bank Transfer",
  "Zelle",
  "Financing",
  "Other",
]);

const TAX_TREATMENTS = Object.freeze([
  "Capital Improvement - No Sales Tax",
  "Taxable Repair / Maintenance",
  "Tax Exempt",
  "Not Determined",
]);

const TAXABLE_TREATMENT = "Taxable Repair / Maintenance";
const CAPITAL_IMPROVEMENT_TREATMENT = "Capital Improvement - No Sales Tax";
const TAX_REVIEW_NOTE =
  "Developer note: invoice sales-tax handling should be reviewed by the company accountant before production tax decisions are relied on.";

const DUE_TERMS = Object.freeze([
  "due_on_receipt",
  "net_7",
  "net_15",
  "net_30",
  "custom",
]);

function cleanString(value, maxLength = 10000) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function dateOnlyString(value) {
  if (!value) return "";
  if (typeof value === "string" && DATE_ONLY_RE.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function todayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

function parseDate(value, field, errors, { required = false, defaultToday = false } = {}) {
  if (value === "" || value === null || value === undefined) {
    if (defaultToday) return parseDate(todayDateOnly(), field, errors, { required: true });
    if (required) errors.push(`${field} is required`);
    return null;
  }
  const input = cleanString(value, 40);
  const date = DATE_ONLY_RE.test(input)
    ? new Date(`${input}T12:00:00.000Z`)
    : new Date(input);
  if (Number.isNaN(date.getTime())) {
    errors.push(`${field} is invalid`);
    return null;
  }
  return date;
}

function addDays(date, days) {
  if (!date) return null;
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + Number(days || 0),
    12,
    0,
    0,
    0
  ));
}

function dueDateForTerm(invoiceDate, dueTerm, suppliedDueDate, errors) {
  const term = DUE_TERMS.includes(dueTerm) ? dueTerm : "due_on_receipt";
  if (term === "custom") {
    return parseDate(suppliedDueDate, "Due date", errors, { required: true });
  }
  if (term === "net_7") return addDays(invoiceDate, 7);
  if (term === "net_15") return addDays(invoiceDate, 15);
  if (term === "net_30") return addDays(invoiceDate, 30);
  return invoiceDate;
}

function parseMoneyToCents(value, field, errors, { integerIsCents = true, required = false } = {}) {
  if (value === "" || value === null || value === undefined) {
    if (required) errors.push(`${field} is required`);
    return 0;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`${field} must be a non-negative amount`);
      return 0;
    }
    return integerIsCents && Number.isInteger(value)
      ? value
      : Math.round(value * 100);
  }
  const normalized = String(value).replace(/[$,\s]/g, "");
  if (!normalized) {
    if (required) errors.push(`${field} is required`);
    return 0;
  }
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 0) {
    errors.push(`${field} must be a non-negative amount`);
    return 0;
  }
  return Math.round(number * 100);
}

function parseQuantity(value, field, errors) {
  if (value === "" || value === null || value === undefined) {
    errors.push(`${field} is required`);
    return 0;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    errors.push(`${field} must be greater than zero`);
    return 0;
  }
  if (number > 100000) {
    errors.push(`${field} is too large`);
    return 0;
  }
  return Math.round(number * 1000) / 1000;
}

function parseBasisPoints(value, field, errors, { required = false } = {}) {
  if (value === "" || value === null || value === undefined) {
    if (required) errors.push(`${field} is required`);
    return 0;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`${field} must be a non-negative percentage`);
      return 0;
    }
    return value;
  }
  const normalized = String(value).replace(/[%\s]/g, "").trim();
  if (!normalized) {
    if (required) errors.push(`${field} is required`);
    return 0;
  }
  if (!/^\d+(?:\.\d{1,3})?$/.test(normalized)) {
    errors.push(`${field} must be a percentage with no more than three decimal places`);
    return 0;
  }
  return Number(normalized) * 100;
}

function calculatePercentageCents(baseCents, basisPoints) {
  return Math.floor((Number(baseCents || 0) * Number(basisPoints || 0) + 5000) / 10000);
}

function centsToDollars(cents) {
  return Math.round(Number(cents || 0)) / 100;
}

function formatMoney(cents) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(centsToDollars(cents));
}

function sanitizeFilenamePart(value, fallback = "invoice") {
  const cleaned = cleanString(value, 120)
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || fallback;
}

function customerInvoiceNumber(value) {
  const input = typeof value === "object" && value !== null ? value.invoiceNumber : value;
  const text = cleanString(input, 120);
  const sequence = text.replace(/\D/g, "") || text;
  return String(sequence || "0").padStart(6, "0");
}

function invoiceDisplayLabel(invoiceOrNumber) {
  return `Invoice #${customerInvoiceNumber(invoiceOrNumber)}`;
}

function customerLastName(customerName) {
  const parts = cleanString(customerName, 160).split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "Customer";
}

function buildInvoiceFilename(invoice) {
  const workType = invoice.projectSnapshot?.workType || "Project";
  return `${sanitizeFilenamePart(invoiceDisplayLabel(invoice), "Invoice")}-${sanitizeFilenamePart(
    customerLastName(invoice.customerSnapshot?.fullName),
    "Customer"
  )}-${sanitizeFilenamePart(workType, "Project")}-Invoice.pdf`;
}

function isBlankLineItem(row) {
  return !cleanString(row?.description, 500) &&
    (row?.quantity === "" || row?.quantity === null || row?.quantity === undefined) &&
    (row?.unitPriceCents === "" || row?.unitPriceCents === null || row?.unitPriceCents === undefined) &&
    (row?.unitPrice === "" || row?.unitPrice === null || row?.unitPrice === undefined);
}

function normalizeLineItems(rows, errors) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (!sourceRows.length) errors.push("At least one invoice line item is required");
  if (sourceRows.length > 200) errors.push("An invoice cannot exceed 200 line items");

  return sourceRows
    .slice(0, 200)
    .map((row, index) => {
      if (isBlankLineItem(row)) return null;
      const description = cleanString(row?.description, 500);
      const category = LINE_ITEM_CATEGORIES.includes(cleanString(row?.category, 80))
        ? cleanString(row?.category, 80)
        : "Other";
      const quantity = parseQuantity(row?.quantity, `lineItems[${index}].quantity`, errors);
      const hasUnitPriceCents = row?.unitPriceCents !== undefined && row?.unitPriceCents !== null && row?.unitPriceCents !== "";
      const unitPriceCents = parseMoneyToCents(
        hasUnitPriceCents ? row.unitPriceCents : row?.unitPrice,
        `lineItems[${index}].unitPrice`,
        errors,
        { integerIsCents: hasUnitPriceCents, required: true }
      );
      if (!description) errors.push(`lineItems[${index}].description is required`);
      return {
        description,
        quantity,
        unitPriceCents,
        amountCents: Math.round(quantity * unitPriceCents),
        category,
        order: index,
      };
    })
    .filter(Boolean);
}

function isBlankDiscount(row) {
  const value = row?.valueCents ?? row?.amountCents ?? row?.valueBasisPoints ?? row?.basisPoints ?? row?.value;
  return !cleanString(row?.name, 160) &&
    !cleanString(row?.note, 1000) &&
    (value === "" || value === null || value === undefined);
}

function normalizeDiscounts(rows, subtotalCents, errors) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (sourceRows.length > 100) errors.push("An invoice cannot exceed 100 discounts or credits");

  const discounts = sourceRows
    .slice(0, 100)
    .map((row, index) => {
      if (isBlankDiscount(row)) return null;
      const name = cleanString(row?.name, 160);
      const type = cleanString(row?.type || "fixed", 40).toLowerCase();
      const note = cleanString(row?.note, 1000);
      if (!name) errors.push(`discounts[${index}].name is required`);
      if (!DISCOUNT_TYPES.includes(type)) {
        errors.push(`discounts[${index}].type must be fixed, percentage, or credit`);
      }
      let value = 0;
      let calculatedAmountCents = 0;
      if (type === "percentage") {
        value = parseBasisPoints(
          row?.valueBasisPoints ?? row?.basisPoints ?? row?.value,
          `discounts[${index}].value`,
          errors
        );
        if (value <= 0) errors.push(`discounts[${index}].value must be greater than zero`);
        if (value > 10000) errors.push(`discounts[${index}].value cannot exceed 100%`);
        calculatedAmountCents = calculatePercentageCents(subtotalCents, value);
      } else {
        const hasCents =
          row?.valueCents !== undefined ||
          row?.amountCents !== undefined ||
          typeof row?.value === "number";
        value = parseMoneyToCents(
          row?.valueCents ?? row?.amountCents ?? row?.amount ?? row?.value,
          `discounts[${index}].value`,
          errors,
          { integerIsCents: hasCents }
        );
        if (value <= 0) errors.push(`discounts[${index}].value must be greater than zero`);
        calculatedAmountCents = value;
      }
      return {
        name,
        type: DISCOUNT_TYPES.includes(type) ? type : "fixed",
        value,
        calculatedAmountCents,
        note,
        order: index,
      };
    })
    .filter(Boolean);

  const totalDiscountCents = discounts.reduce(
    (sum, discount) => sum + Number(discount.calculatedAmountCents || 0),
    0
  );
  if (totalDiscountCents > subtotalCents) {
    errors.push("Total discounts and credits cannot exceed invoice subtotal");
  }
  return { discounts, totalDiscountCents };
}

function normalizePaymentInput(body = {}, errors, existing = null) {
  const source = body && typeof body === "object" ? body : {};
  const current = existing || {};
  const hasAmountCents = source.amountCents !== undefined && source.amountCents !== null && source.amountCents !== "";
  const amountSource = hasAmountCents ? source.amountCents : source.amount;
  const amountCents = amountSource === undefined && existing
    ? Number(current.amountCents || 0)
    : parseMoneyToCents(amountSource, "Payment amount", errors, {
        integerIsCents: hasAmountCents,
        required: true,
      });
  const paymentDate = source.paymentDate === undefined && existing
    ? current.paymentDate || new Date()
    : parseDate(source.paymentDate || todayDateOnly(), "Payment date", errors, { required: true });
  const method = cleanString(source.method ?? current.method ?? "Other", 80);
  if (!PAYMENT_METHODS.includes(method)) errors.push("Invalid payment method");
  if (amountCents <= 0) errors.push("Payment amount must be greater than zero");
  return {
    amountCents,
    paymentDate,
    method: PAYMENT_METHODS.includes(method) ? method : "Other",
    reference: cleanString(source.reference ?? current.reference, 120),
    note: cleanString(source.note ?? current.note, 1000),
  };
}

function normalizePayments(rows, errors) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (sourceRows.length > 200) errors.push("An invoice cannot exceed 200 payments");
  return sourceRows.slice(0, 200).map((row) => ({
    ...normalizePaymentInput(row, errors),
    recordedBy: row?.recordedBy || null,
    recordedByEmail: cleanString(row?.recordedByEmail, 254).toLowerCase(),
    createdAt: row?.createdAt || new Date(),
    updatedAt: row?.updatedAt || row?.createdAt || new Date(),
  }));
}

function normalizeTaxTreatment(value) {
  const treatment = cleanString(value || "Not Determined", 80);
  return TAX_TREATMENTS.includes(treatment) ? treatment : "Not Determined";
}

function isPastDue(dueDate, now = new Date()) {
  if (!dueDate) return false;
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return false;
  due.setUTCHours(23, 59, 59, 999);
  return due.getTime() < now.getTime();
}

function calculatePaidInFullAt(payments, invoiceTotalCents, remainingBalanceCents) {
  if (invoiceTotalCents <= 0 || remainingBalanceCents !== 0) return null;
  const sorted = [...(payments || [])].sort((a, b) => {
    const aDate = new Date(a.paymentDate || a.createdAt || 0).getTime();
    const bDate = new Date(b.paymentDate || b.createdAt || 0).getTime();
    return aDate - bDate;
  });
  let runningTotal = 0;
  for (const payment of sorted) {
    runningTotal += Number(payment.amountCents || 0);
    if (runningTotal >= invoiceTotalCents) {
      return payment.paymentDate || payment.createdAt || new Date();
    }
  }
  return null;
}

function deriveInvoiceStatus(invoiceLike, totals, { now = new Date() } = {}) {
  const previousStatus = cleanString(invoiceLike.status, 80);
  if (previousStatus === "Voided" || previousStatus === "Superseded") return previousStatus;
  if (totals.invoiceTotalCents > 0 && totals.remainingBalanceCents === 0) return "Paid in Full";
  if (totals.totalPaidCents > 0 && totals.remainingBalanceCents > 0) return "Partially Paid";
  if (totals.remainingBalanceCents > 0 && isPastDue(invoiceLike.dates?.dueDate, now)) return "Overdue";
  if (invoiceLike.sentAt || invoiceLike.lastEmailedAt || (invoiceLike.emailHistory || []).length || previousStatus === "Sent") {
    return "Sent";
  }
  return "Draft";
}

function calculateInvoiceFinancials(invoiceLike, options = {}) {
  const errors = [];
  const lineItems = normalizeLineItems(invoiceLike.lineItems || [], errors);
  const subtotalCents = lineItems.reduce((sum, item) => sum + Number(item.amountCents || 0), 0);
  const { discounts, totalDiscountCents } = normalizeDiscounts(invoiceLike.discounts || [], subtotalCents, errors);
  const netSubtotalCents = Math.max(subtotalCents - totalDiscountCents, 0);
  const taxTreatment = normalizeTaxTreatment(invoiceLike.taxTreatment);
  let taxRateBasisPoints = Number(invoiceLike.taxRateBasisPoints || 0);
  if (taxTreatment !== TAXABLE_TREATMENT) taxRateBasisPoints = 0;
  if (taxTreatment === TAXABLE_TREATMENT && taxRateBasisPoints <= 0) {
    errors.push("Tax rate is required for taxable invoices");
  }
  if (taxRateBasisPoints > 2000) errors.push("Tax rate cannot exceed 20%");
  const taxableAmountCents = taxTreatment === TAXABLE_TREATMENT ? netSubtotalCents : 0;
  const taxAmountCents = calculatePercentageCents(taxableAmountCents, taxRateBasisPoints);
  const invoiceTotalCents = Math.max(netSubtotalCents + taxAmountCents, 0);
  const payments = Array.isArray(invoiceLike.payments) ? invoiceLike.payments : [];
  const totalPaidCents = payments.reduce((sum, payment) => sum + Number(payment.amountCents || 0), 0);
  if (totalPaidCents > invoiceTotalCents) {
    errors.push("Total payments cannot exceed invoice total");
  }
  const remainingBalanceCents = Math.max(invoiceTotalCents - totalPaidCents, 0);
  const totals = {
    subtotalCents,
    totalDiscountCents,
    taxableAmountCents,
    taxAmountCents,
    invoiceTotalCents,
    totalPaidCents,
    remainingBalanceCents,
  };
  return {
    errors,
    lineItems,
    discounts,
    taxTreatment,
    taxRateBasisPoints,
    paidInFullAt: calculatePaidInFullAt(payments, invoiceTotalCents, remainingBalanceCents),
    status: deriveInvoiceStatus(invoiceLike, totals, options),
    ...totals,
  };
}

function applyInvoiceCalculations(target, options = {}) {
  const financials = calculateInvoiceFinancials(target, options);
  target.lineItems = financials.lineItems;
  target.discounts = financials.discounts;
  target.taxTreatment = financials.taxTreatment;
  target.taxRateBasisPoints = financials.taxRateBasisPoints;
  target.subtotalCents = financials.subtotalCents;
  target.totalDiscountCents = financials.totalDiscountCents;
  target.taxableAmountCents = financials.taxableAmountCents;
  target.taxAmountCents = financials.taxAmountCents;
  target.invoiceTotalCents = financials.invoiceTotalCents;
  target.totalPaidCents = financials.totalPaidCents;
  target.remainingBalanceCents = financials.remainingBalanceCents;
  target.status = financials.status;
  target.dates = {
    ...(target.dates || {}),
    paidInFullAt: financials.paidInFullAt,
  };
  return financials;
}

function propertyAddressFromProject(project) {
  return cleanString(
    project?.propertySnapshot?.formattedAddress ||
      project?.address ||
      [
        project?.propertySnapshot?.addressLine1,
        project?.propertySnapshot?.addressLine2,
        project?.propertySnapshot?.city,
        project?.propertySnapshot?.state,
        project?.propertySnapshot?.postalCode,
      ]
        .filter(Boolean)
        .join(", "),
    500
  );
}

function projectSnapshots(project) {
  return {
    customerSnapshot: {
      fullName: cleanString(project?.customerSnapshot?.fullName || project?.customerName, 160),
      email: cleanString(project?.customerSnapshot?.email || project?.email, 254).toLowerCase(),
      phone: cleanString(project?.customerSnapshot?.phone || project?.phone, 40),
      customerId: cleanString(project?.customerId, 120),
    },
    propertySnapshot: {
      address: propertyAddressFromProject(project),
      addressLine1: cleanString(project?.propertySnapshot?.addressLine1 || project?.address, 240),
      addressLine2: cleanString(project?.propertySnapshot?.addressLine2, 120),
      city: cleanString(project?.propertySnapshot?.city, 120),
      state: cleanString(project?.propertySnapshot?.state, 40),
      postalCode: cleanString(project?.propertySnapshot?.postalCode, 40),
      formattedAddress: propertyAddressFromProject(project),
    },
    projectSnapshot: {
      projectId: cleanString(project?._id, 80),
      projectNumber: cleanString(project?.projectNumber, 80),
      workType: cleanString(project?.projectType || "Other", 120),
      projectDescription: cleanString(project?.notes || `${project?.projectType || "Project"} project`, 10000),
    },
  };
}

function mergeSnapshot(source, fallback, fields) {
  return fields.reduce((snapshot, [key, maxLength, lower]) => {
    const value = cleanString(source?.[key] ?? fallback?.[key], maxLength);
    snapshot[key] = lower ? value.toLowerCase() : value;
    return snapshot;
  }, {});
}

function validateInvoiceDraftInput(body = {}, project = null, existingInvoice = null) {
  const request = body && typeof body === "object" ? body : {};
  const errors = [];
  const defaults = projectSnapshots(project);
  const fallback = existingInvoice || {};
  const invoiceDate = parseDate(
    request.dates?.invoiceDate ?? request.invoiceDate ?? fallback.dates?.invoiceDate,
    "Invoice date",
    errors,
    { defaultToday: true }
  );
  const dueTerm = DUE_TERMS.includes(cleanString(request.dueTerm ?? fallback.dueTerm, 40))
    ? cleanString(request.dueTerm ?? fallback.dueTerm, 40)
    : "due_on_receipt";
  const dueDate = dueDateForTerm(
    invoiceDate,
    dueTerm,
    request.dates?.dueDate ?? request.dueDate ?? fallback.dates?.dueDate,
    errors
  );
  const serviceDate = parseDate(
    request.dates?.serviceDate ?? request.serviceDate ?? fallback.dates?.serviceDate,
    "Service/project date",
    errors
  );
  const customerSnapshot = mergeSnapshot(request.customerSnapshot, fallback.customerSnapshot || defaults.customerSnapshot, [
    ["fullName", 160, false],
    ["email", 254, true],
    ["phone", 40, false],
    ["customerId", 120, false],
  ]);
  const propertySnapshot = mergeSnapshot(request.propertySnapshot, fallback.propertySnapshot || defaults.propertySnapshot, [
    ["address", 500, false],
    ["addressLine1", 240, false],
    ["addressLine2", 120, false],
    ["city", 120, false],
    ["state", 40, false],
    ["postalCode", 40, false],
    ["formattedAddress", 500, false],
  ]);
  if (!propertySnapshot.address && propertySnapshot.formattedAddress) {
    propertySnapshot.address = propertySnapshot.formattedAddress;
  }
  if (!propertySnapshot.formattedAddress && propertySnapshot.address) {
    propertySnapshot.formattedAddress = propertySnapshot.address;
  }
  const projectSnapshot = mergeSnapshot(request.projectSnapshot, fallback.projectSnapshot || defaults.projectSnapshot, [
    ["projectId", 80, false],
    ["projectNumber", 80, false],
    ["workType", 120, false],
    ["projectDescription", 10000, false],
  ]);

  if (!customerSnapshot.fullName) errors.push("Customer name is required");
  if (customerSnapshot.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerSnapshot.email)) {
    errors.push("Customer email is invalid");
  }
  if (!propertySnapshot.address) errors.push("Property address is required");
  if (!projectSnapshot.projectNumber) errors.push("Project number is required");

  const lineItems = normalizeLineItems(request.lineItems ?? fallback.lineItems ?? [], errors);
  const subtotalCents = lineItems.reduce((sum, item) => sum + Number(item.amountCents || 0), 0);
  const { discounts } = normalizeDiscounts(request.discounts ?? fallback.discounts ?? [], subtotalCents, errors);
  const taxTreatment = normalizeTaxTreatment(request.taxTreatment ?? fallback.taxTreatment);
  const taxRateBasisPoints = taxTreatment === TAXABLE_TREATMENT
    ? parseBasisPoints(
        request.taxRateBasisPoints ?? request.taxRate ?? fallback.taxRateBasisPoints,
        "Tax rate",
        errors,
        { required: true }
      )
    : 0;
  const payments = Array.isArray(request.payments)
    ? normalizePayments(request.payments, errors)
    : (fallback.payments || []);

  const update = {
    customerId: request.customerId ?? fallback.customerId ?? project?.customerId ?? null,
    contractId: request.contractId ?? fallback.contractId ?? null,
    source: cleanString(request.source || fallback.source || "manual", 40),
    customerSnapshot,
    propertySnapshot,
    projectSnapshot,
    contractSnapshot: {
      contractId: cleanString(request.contractSnapshot?.contractId ?? fallback.contractSnapshot?.contractId, 80),
      contractNumber: cleanString(request.contractSnapshot?.contractNumber ?? fallback.contractSnapshot?.contractNumber, 80),
      finalContractPriceCents: Number(request.contractSnapshot?.finalContractPriceCents ?? fallback.contractSnapshot?.finalContractPriceCents ?? 0),
      importedAt: request.contractSnapshot?.importedAt ?? fallback.contractSnapshot?.importedAt ?? null,
    },
    lineItems,
    discounts,
    taxTreatment,
    taxRateBasisPoints,
    dueTerm,
    dates: {
      invoiceDate,
      dueDate,
      serviceDate,
      paidInFullAt: fallback.dates?.paidInFullAt || null,
    },
    publicNote: cleanString(request.publicNote ?? fallback.publicNote, 10000),
    internalNote: cleanString(request.internalNote ?? fallback.internalNote, 10000),
    paymentInstructions: cleanString(
      request.paymentInstructions ?? fallback.paymentInstructions,
      2000
    ),
    payments,
    sentAt: fallback.sentAt || null,
    lastEmailedAt: fallback.lastEmailedAt || null,
    emailHistory: fallback.emailHistory || [],
  };

  const financials = calculateInvoiceFinancials(update);
  errors.push(...financials.errors);
  Object.assign(update, {
    lineItems: financials.lineItems,
    discounts: financials.discounts,
    taxTreatment: financials.taxTreatment,
    taxRateBasisPoints: financials.taxRateBasisPoints,
    subtotalCents: financials.subtotalCents,
    totalDiscountCents: financials.totalDiscountCents,
    taxableAmountCents: financials.taxableAmountCents,
    taxAmountCents: financials.taxAmountCents,
    invoiceTotalCents: financials.invoiceTotalCents,
    totalPaidCents: financials.totalPaidCents,
    remainingBalanceCents: financials.remainingBalanceCents,
    status: financials.status,
    dates: {
      ...update.dates,
      paidInFullAt: financials.paidInFullAt,
    },
  });

  return { errors, update };
}

function fileExtension(name) {
  return path.extname(String(name || "")).toLowerCase();
}

module.exports = {
  CAPITAL_IMPROVEMENT_TREATMENT,
  DATE_ONLY_RE,
  DISCOUNT_TYPES,
  DUE_TERMS,
  INVOICE_STATUSES,
  LINE_ITEM_CATEGORIES,
  PAYMENT_METHODS,
  TAX_REVIEW_NOTE,
  TAX_TREATMENTS,
  TAXABLE_TREATMENT,
  applyInvoiceCalculations,
  buildInvoiceFilename,
  calculateInvoiceFinancials,
  calculatePercentageCents,
  centsToDollars,
  cleanString,
  customerInvoiceNumber,
  dateOnlyString,
  fileExtension,
  formatMoney,
  invoiceDisplayLabel,
  normalizePaymentInput,
  parseBasisPoints,
  parseMoneyToCents,
  projectSnapshots,
  sanitizeFilenamePart,
  todayDateOnly,
  validateInvoiceDraftInput,
};
