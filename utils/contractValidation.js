const path = require("path");
const {
  CONTRACT_STATUSES,
  WORK_TYPES,
} = require("../config/premiumIslandHomesContract");

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FULL_DEPOSIT_WARNING =
  "The entered deposit equals 100% of the adjusted contract price. Confirm that full payment is intentionally due before work begins.";
const ZERO_ADJUSTED_PRICE_WARNING =
  "Discounts reduce the adjusted contract price to $0. Confirm that this contract is intentionally being generated at no charge.";
const HIGH_DISCOUNT_WARNING =
  "Total discounts exceed 30% of the original contract price. Review before generating.";
const DISCOUNT_TYPES = Object.freeze(["fixed", "percentage"]);

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

function parseBasisPoints(value, field, errors) {
  if (value === "" || value === null || value === undefined) return 0;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      errors.push(`${field} must be a non-negative percentage`);
      return 0;
    }
    return value;
  }

  const normalized = String(value).replace(/[%\s]/g, "").trim();
  if (!normalized) return 0;
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    errors.push(`${field} must be a percentage with no more than two decimal places`);
    return 0;
  }
  const [wholePart, decimalPart = ""] = normalized.split(".");
  return Number(wholePart) * 100 + Number(decimalPart.padEnd(2, "0"));
}

function calculatePercentageDiscountCents(originalContractPriceCents, basisPoints) {
  return Math.floor((Number(originalContractPriceCents || 0) * Number(basisPoints || 0) + 5000) / 10000);
}

function isBlankDiscountRow(row) {
  const name = cleanString(row?.name, 160);
  const note = cleanString(row?.note, 1000);
  const value = row?.value ?? row?.valueCents ?? row?.valueBasisPoints ?? row?.amountCents ?? row?.amount;
  return !name && !note && (value === "" || value === null || value === undefined);
}

function normalizeDiscounts(rows, originalContractPriceCents, errors, warnings) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const seenNames = new Map();
  const duplicateNames = new Set();
  const discounts = sourceRows
    .slice(0, 40)
    .map((row, index) => {
      if (isBlankDiscountRow(row)) return null;

      const name = cleanString(row?.name, 160);
      const type = cleanString(row?.type || "fixed", 40).toLowerCase();
      const note = cleanString(row?.note, 1000);

      if (!name) errors.push(`discounts[${index}].name is required`);
      if (!DISCOUNT_TYPES.includes(type)) {
        errors.push(`discounts[${index}].type must be fixed or percentage`);
      }

      const comparableName = name.toLowerCase();
      if (comparableName) {
        if (seenNames.has(comparableName)) duplicateNames.add(name);
        seenNames.set(comparableName, true);
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
        calculatedAmountCents = calculatePercentageDiscountCents(originalContractPriceCents, value);
      } else {
        value = parseCents(
          row?.valueCents ?? row?.amountCents ?? row?.amount ?? row?.value,
          `discounts[${index}].value`,
          errors
        );
        if (value <= 0) errors.push(`discounts[${index}].value must be greater than zero`);
        if (value > originalContractPriceCents) {
          errors.push(`discounts[${index}].value cannot exceed original contract price`);
        }
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

  const totalDiscountAmountCents = discounts.reduce(
    (sum, discount) => sum + Number(discount.calculatedAmountCents || 0),
    0
  );

  if (totalDiscountAmountCents > originalContractPriceCents) {
    errors.push("Total discounts cannot exceed original contract price");
  }

  duplicateNames.forEach((name) => {
    warnings.push({
      code: "duplicate_discount_name",
      severity: "warning",
      message: `Discount name "${name}" is used more than once. Duplicate names are allowed, but review them before generating.`,
    });
  });

  return { discounts, totalDiscountAmountCents };
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

function customerContractNumber(value) {
  const input = typeof value === "object" && value !== null ? value.contractNumber : value;
  const text = cleanString(input, 120);
  const match = text.match(/(\d+)\D*$/);
  const sequence = match ? match[1] : text.replace(/\D/g, "");
  return (sequence || "0").padStart(6, "0");
}

function contractDisplayLabel(contractOrNumber) {
  return `Contract #${customerContractNumber(contractOrNumber)}`;
}

function customerLastName(customerName) {
  const parts = cleanString(customerName, 160).split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "Customer";
}

function normalizeComparableText(value) {
  return cleanString(value, 30000)
    .toLowerCase()
    .replace(/[^\w\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addressHasStateAndZip(address) {
  const value = cleanString(address, 500);
  return /\b[A-Z]{2}\b/i.test(value) && /\b\d{5}(?:-\d{4})?\b/.test(value);
}

function buildContractWarnings(update) {
  const warnings = [];
  const total = Number(update.adjustedContractPriceCents ?? update.totalPriceCents ?? 0);
  const original = Number(update.originalContractPriceCents ?? update.totalPriceCents ?? 0);
  const totalDiscount = Number(update.totalDiscountAmountCents || 0);
  const deposit = Number(update.depositAmountCents || 0);
  const descriptionText = normalizeComparableText(update.projectDescription);
  const scopeText = normalizeComparableText(update.scopeText);

  if (total > 0 && deposit === total) {
    warnings.push({
      code: "full_deposit",
      severity: "confirmation_required",
      message: FULL_DEPOSIT_WARNING,
    });
  }

  if (original > 0 && totalDiscount > Math.floor((original * 30) / 100)) {
    warnings.push({
      code: "high_discount_total",
      severity: "warning",
      message: HIGH_DISCOUNT_WARNING,
    });
  }

  if (original > 0 && total === 0) {
    warnings.push({
      code: "zero_adjusted_price",
      severity: "confirmation_required",
      message: ZERO_ADJUSTED_PRICE_WARNING,
    });
  }

  if (descriptionText && scopeText && descriptionText === scopeText) {
    warnings.push({
      code: "duplicate_description_scope",
      severity: "warning",
      message: "Project Description and Scope of Work are identical. The PDF will avoid repeating the same text twice.",
    });
  }

  if (!update.dates?.estimatedCompletionDate) {
    warnings.push({
      code: "missing_estimated_completion_date",
      severity: "warning",
      message: "Estimated completion date is missing.",
    });
  }

  if (!addressHasStateAndZip(update.propertySnapshot?.address)) {
    warnings.push({
      code: "missing_customer_state_or_zip",
      severity: "warning",
      message: "Customer address may be missing a state or ZIP code.",
    });
  }

  if (scopeText && scopeText.length < 80) {
    warnings.push({
      code: "scope_unusually_short",
      severity: "warning",
      message: "Scope of Work is unusually short. Add enough detail for the customer to understand what is included.",
    });
  }

  return warnings;
}

function buildContractFilename(contract) {
  const workType =
    contract.workType === "Other"
      ? contract.otherWorkType || "Project"
      : contract.workType || "Project";
  return `${sanitizeFilenamePart(contractDisplayLabel(contract), "Contract")}-${sanitizeFilenamePart(
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
    errors.push("Payment schedule total cannot exceed the adjusted contract price");
  }

  return paymentSchedule;
}

function validateContractInput(body = {}, project = null) {
  const errors = [];
  const warnings = [];
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

  const originalContractPriceCents = parseCents(
    body.originalContractPriceCents ?? body.totalPriceCents ?? body.totalContractPrice,
    "Original contract price",
    errors
  );
  const { discounts, totalDiscountAmountCents } = normalizeDiscounts(
    body.discounts,
    originalContractPriceCents,
    errors,
    warnings
  );
  const adjustedContractPriceCents = Math.max(
    originalContractPriceCents - totalDiscountAmountCents,
    0
  );
  const depositAmountCents = parseCents(
    body.depositAmountCents ?? body.depositRequired,
    "Deposit required",
    errors
  );
  if (originalContractPriceCents <= 0) {
    errors.push("Original contract price must be greater than zero");
  }
  if (adjustedContractPriceCents < 0) {
    errors.push("Adjusted contract price cannot be negative");
  }
  if (depositAmountCents > adjustedContractPriceCents) {
    errors.push("Deposit cannot exceed adjusted contract price");
  }

  const paymentSchedule = normalizePaymentSchedule(
    body.paymentSchedule,
    adjustedContractPriceCents,
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
    originalContractPriceCents,
    totalPriceCents: originalContractPriceCents,
    discounts,
    totalDiscountAmountCents,
    adjustedContractPriceCents,
    depositAmountCents,
    fullDepositConfirmed:
      body.fullDepositConfirmed === true ||
      body.fullDepositConfirmed === "true",
    zeroAdjustedPriceConfirmed:
      body.zeroAdjustedPriceConfirmed === true ||
      body.zeroAdjustedPriceConfirmed === "true",
    remainingBalanceCents: Math.max(adjustedContractPriceCents - depositAmountCents, 0),
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
      cancellationDeadline: null,
    },
    optionalDetails,
  };

  return { errors, update, warnings: [...warnings, ...buildContractWarnings(update)] };
}

function fileExtension(name) {
  return path.extname(String(name || "")).toLowerCase();
}

module.exports = {
  buildContractFilename,
  buildContractWarnings,
  calculatePercentageDiscountCents,
  centsToDollars,
  cleanString,
  contractDisplayLabel,
  customerContractNumber,
  customerLastName,
  fileExtension,
  formatMoney,
  FULL_DEPOSIT_WARNING,
  HIGH_DISCOUNT_WARNING,
  normalizeComparableText,
  normalizeDiscounts,
  parseBasisPoints,
  sanitizeFilenamePart,
  validateContractInput,
  ZERO_ADJUSTED_PRICE_WARNING,
};
