const path = require("path");
const {
  CONTRACT_STATUSES,
  WORK_TYPES,
} = require("../config/premiumIslandHomesContract");

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanString(value, maxLength = 10000) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function parseDate(value, field, errors, { required = false } = {}) {
  if (value === "" || value === null || value === undefined) {
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

function parseCents(value, field, errors) {
  if (value === "" || value === null || value === undefined) return 0;
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value < 0) {
      errors.push(`${field} must be a non-negative amount`);
      return 0;
    }
    return value;
  }
  const normalized = String(value).replace(/[$,\s]/g, "");
  if (!normalized) return 0;
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 0) {
    errors.push(`${field} must be a non-negative amount`);
    return 0;
  }
  return Math.round(number * 100);
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

function sanitizeFilenamePart(value, fallback = "contract") {
  const cleaned = cleanString(value, 120)
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || fallback;
}

function customerLastName(customerName) {
  const parts = cleanString(customerName, 160).split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "Customer";
}

function buildContractFilename(contract) {
  const workType =
    contract.workType === "Other"
      ? contract.otherWorkType || "Project"
      : contract.workType || "Project";
  return `${sanitizeFilenamePart(contract.contractNumber, "PIH")}-${sanitizeFilenamePart(
    customerLastName(contract.customerSnapshot?.fullName),
    "Customer"
  )}-${sanitizeFilenamePart(workType, "Project")}-Contract.pdf`;
}

function normalizePaymentSchedule(rows, totalPriceCents, errors) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const paymentSchedule = sourceRows
    .slice(0, 40)
    .map((row, index) => {
      const label = cleanString(row?.label, 160);
      const dueCondition = cleanString(row?.dueCondition, 500);
      const amountCents = parseCents(row?.amountCents ?? row?.amount, `paymentSchedule[${index}].amount`, errors);
      if (!label && !dueCondition && !amountCents) return null;
      if (!label) errors.push(`paymentSchedule[${index}].label is required`);
      if (!dueCondition) errors.push(`paymentSchedule[${index}].dueCondition is required`);
      return {
        label,
        dueCondition,
        amountCents,
        order: index,
      };
    })
    .filter(Boolean);

  const paymentTotal = paymentSchedule.reduce(
    (sum, row) => sum + Number(row.amountCents || 0),
    0
  );
  if (paymentTotal > totalPriceCents) {
    errors.push("Payment schedule total cannot exceed the contract price");
  }

  return paymentSchedule;
}

function validateContractInput(body = {}, project = null) {
  const errors = [];
  const workType = cleanString(body.workType || project?.projectType || "", 80);
  const otherWorkType = cleanString(body.otherWorkType, 120);
  const status = cleanString(body.status || "Draft", 40);

  if (!WORK_TYPES.includes(workType)) errors.push("Invalid work type");
  if (workType === "Other" && !otherWorkType) {
    errors.push("Other work type is required");
  }
  if (status && !CONTRACT_STATUSES.includes(status)) {
    errors.push("Invalid contract status");
  }

  const projectDescription = cleanString(body.projectDescription, 10000);
  const scopeText = cleanString(body.scopeText, 30000);
  if (!projectDescription) errors.push("Project description is required");
  if (!scopeText) errors.push("Scope of work is required");

  const totalPriceCents = parseCents(
    body.totalPriceCents ?? body.totalContractPrice,
    "Total contract price",
    errors
  );
  const depositAmountCents = parseCents(
    body.depositAmountCents ?? body.depositRequired,
    "Deposit required",
    errors
  );
  if (totalPriceCents <= 0) errors.push("Total contract price must be greater than zero");
  if (depositAmountCents > totalPriceCents) {
    errors.push("Deposit cannot exceed total contract price");
  }

  const paymentSchedule = normalizePaymentSchedule(
    body.paymentSchedule,
    totalPriceCents,
    errors
  );

  const customerSnapshot = {
    fullName: cleanString(
      body.customerSnapshot?.fullName || project?.customerName || "",
      160
    ),
    email: cleanString(body.customerSnapshot?.email || project?.email || "", 254).toLowerCase(),
    phone: cleanString(body.customerSnapshot?.phone || project?.phone || "", 40),
    customerId: cleanString(body.customerSnapshot?.customerId || "", 120),
  };
  const propertySnapshot = {
    address: cleanString(body.propertySnapshot?.address || project?.address || "", 500),
    projectId: cleanString(body.propertySnapshot?.projectId || project?._id || "", 80),
    projectNumber: cleanString(
      body.propertySnapshot?.projectNumber || project?.projectNumber || "",
      80
    ),
  };

  if (!customerSnapshot.fullName) errors.push("Customer name is required");
  if (!propertySnapshot.address) errors.push("Property address is required");
  if (customerSnapshot.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerSnapshot.email)) {
    errors.push("Customer email is invalid");
  }

  const optionalDetails = {
    materialsAllowances: cleanString(body.optionalDetails?.materialsAllowances, 12000),
    exclusions: cleanString(body.optionalDetails?.exclusions, 12000),
    permitResponsibility: cleanString(body.optionalDetails?.permitResponsibility, 5000),
    specialInstructions: cleanString(body.optionalDetails?.specialInstructions, 12000),
    additionalNotes: cleanString(body.optionalDetails?.additionalNotes, 12000),
  };

  const update = {
    status: status || "Draft",
    customerSnapshot,
    propertySnapshot,
    workType,
    otherWorkType,
    projectDescription,
    scopeText,
    totalPriceCents,
    depositAmountCents,
    remainingBalanceCents: Math.max(totalPriceCents - depositAmountCents, 0),
    paymentSchedule,
    dates: {
      contractDate: parseDate(body.dates?.contractDate || body.contractDate, "Contract date", errors, {
        required: true,
      }),
      estimatedStartDate: parseDate(
        body.dates?.estimatedStartDate || body.estimatedStartDate,
        "Estimated start date",
        errors
      ),
      estimatedCompletionDate: parseDate(
        body.dates?.estimatedCompletionDate || body.estimatedCompletionDate,
        "Estimated completion date",
        errors
      ),
      cancellationDeadline: parseDate(
        body.dates?.cancellationDeadline || body.cancellationDeadline,
        "Cancellation deadline",
        errors,
        { required: true }
      ),
    },
    optionalDetails,
  };

  return { errors, update };
}

function fileExtension(name) {
  return path.extname(String(name || "")).toLowerCase();
}

module.exports = {
  buildContractFilename,
  centsToDollars,
  cleanString,
  customerLastName,
  fileExtension,
  formatMoney,
  sanitizeFilenamePart,
  validateContractInput,
};
