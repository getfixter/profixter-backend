const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  CANCELLATION_NOTICE_CONFIG,
  CANCELLATION_NOTICE_TERMS_VERSION,
  CONTRACT_TERMS_SECTIONS,
  CONTRACT_TERMS_VERSION,
} = require("../config/premiumIslandHomesContract");
const {
  buildContractFilename,
  FULL_DEPOSIT_WARNING,
  validateContractInput,
} = require("../utils/contractValidation");
const { generateContractPdfBuffer } = require("../utils/contractPdf");

const project = {
  _id: "64f000000000000000000001",
  projectNumber: "PRJ-2026-00001",
  customerName: "Anne Grant",
  email: "anne.grant@example.com",
  phone: "6315550101",
  address: "123 Main Street, Lindenhurst, NY 11757",
  projectType: "Bathroom",
  notes: "Bathroom vanity and finish repair",
};

function validBody(overrides = {}) {
  return {
    workType: "Bathroom",
    otherWorkType: "",
    projectDescription: "Bathroom vanity replacement and finish repair.",
    scopeText: [
      "Remove two existing bathroom vanities, sinks, and faucets.",
      "Install two new vanities, sinks, and faucets supplied for the project.",
      "Repair affected sheetrock around the vanity areas.",
      "Prepare patched areas for paint and paint the repaired wall surfaces.",
    ].join("\n"),
    totalPriceCents: 299900,
    depositAmountCents: 299900,
    fullDepositConfirmed: true,
    paymentSchedule: [
      {
        label: "Full payment at signing",
        amountCents: 299900,
        dueCondition: "Due before work begins as confirmed by the admin.",
      },
    ],
    dates: {
      contractDate: "2026-07-15",
      estimatedStartDate: "2026-08-01",
      estimatedCompletionDate: "2026-08-15",
    },
    optionalDetails: {
      materialsAllowances: "",
      exclusions: "",
      permitResponsibility: "",
      specialInstructions: "",
      additionalNotes: "",
    },
    ...overrides,
  };
}

function pdfPageCount(pdf) {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
}

async function main() {
  assert.strictEqual(CANCELLATION_NOTICE_CONFIG.includeCancellationNotice, true);
  assert.strictEqual(CANCELLATION_NOTICE_CONFIG.termsVersion, CANCELLATION_NOTICE_TERMS_VERSION);
  assert(
    CONTRACT_TERMS_SECTIONS.length >= 25,
    "expanded central contract terms should remain configured"
  );

  const result = validateContractInput(validBody(), project);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.update.originalContractPriceCents, 299900);
  assert.strictEqual(result.update.totalPriceCents, 299900);
  assert.strictEqual(result.update.totalDiscountAmountCents, 0);
  assert.strictEqual(result.update.adjustedContractPriceCents, 299900);
  assert.deepStrictEqual(result.update.discounts, []);
  assert.strictEqual(result.update.depositAmountCents, 299900);
  assert.strictEqual(result.update.remainingBalanceCents, 0);
  assert.strictEqual(result.update.fullDepositConfirmed, true);
  assert.strictEqual(result.update.dates.cancellationDeadline, null);
  assert(
    result.warnings.some((warning) => warning.code === "full_deposit"),
    "100% deposit warning should be returned even when confirmed"
  );

  const unconfirmedDeposit = validateContractInput(
    validBody({ fullDepositConfirmed: false }),
    project
  );
  assert(
    unconfirmedDeposit.warnings.some(
      (warning) => warning.code === "full_deposit" && warning.message === FULL_DEPOSIT_WARNING
    ),
    "100% deposit warning text should match"
  );

  const duplicateText = validateContractInput(
    validBody({
      projectDescription: "Install two vanities.",
      scopeText: "Install two vanities.",
    }),
    project
  );
  assert(
    duplicateText.warnings.some((warning) => warning.code === "duplicate_description_scope"),
    "duplicate description/scope warning failed"
  );

  const shortScope = validateContractInput(
    validBody({
      scopeText: "Install vanity.",
      dates: {
        contractDate: "2026-07-15",
        estimatedStartDate: "2026-08-01",
        estimatedCompletionDate: null,
      },
    }),
    { ...project, address: "123 Main Street" }
  );
  assert(
    shortScope.warnings.some((warning) => warning.code === "scope_unusually_short"),
    "short scope warning failed"
  );
  assert(
    shortScope.warnings.some((warning) => warning.code === "missing_estimated_completion_date"),
    "missing estimated completion warning failed"
  );
  assert(
    shortScope.warnings.some((warning) => warning.code === "missing_customer_state_or_zip"),
    "missing state/ZIP warning failed"
  );

  const depositTooHigh = validateContractInput(
    validBody({ totalPriceCents: 100000, depositAmountCents: 200000 }),
    project
  );
  assert(
    depositTooHigh.errors.includes("Deposit cannot exceed adjusted contract price"),
    "deposit validation failed"
  );

  const scheduleTooHigh = validateContractInput(
    validBody({
      totalPriceCents: 100000,
      depositAmountCents: 10000,
      paymentSchedule: [
        { label: "Too much", amountCents: 200000, dueCondition: "Never" },
      ],
    }),
    project
  );
  assert(
    scheduleTooHigh.errors.includes("Payment schedule total cannot exceed the adjusted contract price"),
    "payment schedule validation failed"
  );

  const mixedDiscount = validateContractInput(
    validBody({
      totalPriceCents: 1000000,
      depositAmountCents: 250000,
      fullDepositConfirmed: false,
      discounts: [
        { name: "Returning customer", type: "percentage", valueBasisPoints: 1000 },
        { name: "Referral credit", type: "fixed", valueCents: 50000 },
      ],
      paymentSchedule: [
        { label: "Deposit", amountCents: 250000, dueCondition: "Due at signing" },
        { label: "Final payment", amountCents: 600000, dueCondition: "Due at completion" },
      ],
    }),
    project
  );
  assert.deepStrictEqual(mixedDiscount.errors, []);
  assert.strictEqual(mixedDiscount.update.originalContractPriceCents, 1000000);
  assert.strictEqual(mixedDiscount.update.discounts[0].value, 1000);
  assert.strictEqual(mixedDiscount.update.discounts[0].calculatedAmountCents, 100000);
  assert.strictEqual(mixedDiscount.update.discounts[1].value, 50000);
  assert.strictEqual(mixedDiscount.update.totalDiscountAmountCents, 150000);
  assert.strictEqual(mixedDiscount.update.adjustedContractPriceCents, 850000);
  assert.strictEqual(mixedDiscount.update.depositAmountCents, 250000);
  assert.strictEqual(mixedDiscount.update.remainingBalanceCents, 600000);

  const decimalPercentage = validateContractInput(
    validBody({
      totalPriceCents: 1000000,
      depositAmountCents: 0,
      discounts: [{ name: "Seasonal", type: "percentage", value: "7.5" }],
      paymentSchedule: [],
    }),
    project
  );
  assert.deepStrictEqual(decimalPercentage.errors, []);
  assert.strictEqual(decimalPercentage.update.discounts[0].value, 750);
  assert.strictEqual(decimalPercentage.update.discounts[0].calculatedAmountCents, 75000);
  assert.strictEqual(decimalPercentage.update.adjustedContractPriceCents, 925000);

  const fullDiscount = validateContractInput(
    validBody({
      totalPriceCents: 100000,
      depositAmountCents: 0,
      zeroAdjustedPriceConfirmed: true,
      discounts: [{ name: "Courtesy", type: "fixed", valueCents: 100000 }],
      paymentSchedule: [],
    }),
    project
  );
  assert.deepStrictEqual(fullDiscount.errors, []);
  assert.strictEqual(fullDiscount.update.adjustedContractPriceCents, 0);
  assert.strictEqual(fullDiscount.update.zeroAdjustedPriceConfirmed, true);
  assert.strictEqual(fullDiscount.update.remainingBalanceCents, 0);
  assert(
    fullDiscount.warnings.some((warning) => warning.code === "zero_adjusted_price"),
    "zero adjusted price confirmation warning failed"
  );
  assert(
    fullDiscount.warnings.some((warning) => warning.code === "high_discount_total"),
    "high discount warning should trigger above 30%"
  );

  const excessiveDiscounts = validateContractInput(
    validBody({
      totalPriceCents: 100000,
      depositAmountCents: 0,
      discounts: [
        { name: "Discount A", type: "fixed", valueCents: 80000 },
        { name: "Discount B", type: "fixed", valueCents: 30000 },
      ],
      paymentSchedule: [],
    }),
    project
  );
  assert(
    excessiveDiscounts.errors.includes("Total discounts cannot exceed original contract price"),
    "total discount cap validation failed"
  );

  const fixedExceedsOriginal = validateContractInput(
    validBody({
      totalPriceCents: 100000,
      depositAmountCents: 0,
      discounts: [{ name: "Bad fixed", type: "fixed", valueCents: 100001 }],
      paymentSchedule: [],
    }),
    project
  );
  assert(
    fixedExceedsOriginal.errors.includes("discounts[0].value cannot exceed original contract price"),
    "fixed discount cap validation failed"
  );

  const percentTooHigh = validateContractInput(
    validBody({
      totalPriceCents: 100000,
      depositAmountCents: 0,
      discounts: [{ name: "Bad percent", type: "percentage", valueBasisPoints: 10001 }],
      paymentSchedule: [],
    }),
    project
  );
  assert(
    percentTooHigh.errors.includes("discounts[0].value cannot exceed 100%"),
    "percentage discount cap validation failed"
  );

  const negativeDiscount = validateContractInput(
    validBody({
      totalPriceCents: 100000,
      depositAmountCents: 0,
      discounts: [{ name: "Bad negative", type: "fixed", valueCents: -100 }],
      paymentSchedule: [],
    }),
    project
  );
  assert(
    negativeDiscount.errors.some((message) => message.includes("non-negative amount")),
    "negative discount validation failed"
  );

  const missingDiscountName = validateContractInput(
    validBody({
      totalPriceCents: 100000,
      depositAmountCents: 0,
      discounts: [{ name: "", type: "fixed", valueCents: 1000 }],
      paymentSchedule: [],
    }),
    project
  );
  assert(
    missingDiscountName.errors.includes("discounts[0].name is required"),
    "missing discount name validation failed"
  );

  const duplicateDiscountName = validateContractInput(
    validBody({
      totalPriceCents: 100000,
      depositAmountCents: 0,
      discounts: [
        { name: "VIP", type: "fixed", valueCents: 1000 },
        { name: "VIP", type: "fixed", valueCents: 2000 },
      ],
      paymentSchedule: [],
    }),
    project
  );
  assert.deepStrictEqual(duplicateDiscountName.errors, []);
  assert(
    duplicateDiscountName.warnings.some((warning) => warning.code === "duplicate_discount_name"),
    "duplicate discount name warning failed"
  );

  const depositExceedsAdjusted = validateContractInput(
    validBody({
      totalPriceCents: 100000,
      depositAmountCents: 90000,
      discounts: [{ name: "Discount", type: "fixed", valueCents: 20000 }],
      paymentSchedule: [],
    }),
    project
  );
  assert(
    depositExceedsAdjusted.errors.includes("Deposit cannot exceed adjusted contract price"),
    "deposit must be checked against adjusted price"
  );

  const scheduleExceedsAdjusted = validateContractInput(
    validBody({
      totalPriceCents: 100000,
      depositAmountCents: 10000,
      discounts: [{ name: "Discount", type: "fixed", valueCents: 20000 }],
      paymentSchedule: [
        { label: "Too much", amountCents: 90000, dueCondition: "Due later" },
      ],
    }),
    project
  );
  assert(
    scheduleExceedsAdjusted.errors.includes("Payment schedule total cannot exceed the adjusted contract price"),
    "payment schedule must be checked against adjusted price"
  );

  const adjustedFullDeposit = validateContractInput(
    validBody({
      totalPriceCents: 100000,
      depositAmountCents: 80000,
      fullDepositConfirmed: false,
      discounts: [{ name: "Discount", type: "fixed", valueCents: 20000 }],
      paymentSchedule: [
        { label: "Full payment at signing", amountCents: 80000, dueCondition: "Due at signing" },
      ],
    }),
    project
  );
  assert.deepStrictEqual(adjustedFullDeposit.errors, []);
  assert(
    adjustedFullDeposit.warnings.some(
      (warning) => warning.code === "full_deposit" && warning.message === FULL_DEPOSIT_WARNING
    ),
    "100% deposit warning must compare against adjusted price"
  );

  const otherMissing = validateContractInput(
    validBody({ workType: "Other", otherWorkType: "" }),
    project
  );
  assert(
    otherMissing.errors.includes("Other work type is required"),
    "Other work type validation failed"
  );

  const contract = {
    _id: "650000000000000000000001",
    contractNumber: "PIH-2026-0001",
    version: 2,
    projectId: project._id,
    ...result.update,
    termsVersion: CONTRACT_TERMS_VERSION,
    legalNoticeVersion: CANCELLATION_NOTICE_TERMS_VERSION,
    addAuditEvent() {},
  };

  const filename = buildContractFilename(contract);
  assert.strictEqual(filename, "PIH-2026-0001-Grant-Bathroom-Contract.pdf");

  const pdf = await generateContractPdfBuffer(contract);
  assert(pdf.length > 1000, "PDF should not be empty");
  assert.strictEqual(pdf.subarray(0, 4).toString(), "%PDF");
  assert(pdfPageCount(pdf) >= 4, "PDF should include flowing terms and a signature page");
  assert(pdfPageCount(pdf) <= 8, "PDF should not create excessive blank/footer pages");

  const discountedContract = {
    ...contract,
    ...mixedDiscount.update,
    contractNumber: "PIH-2026-0002",
    version: 1,
  };
  const discountedPdf = await generateContractPdfBuffer(discountedContract);
  assert(discountedPdf.length > 1000, "discounted PDF should not be empty");
  assert.strictEqual(discountedPdf.subarray(0, 4).toString(), "%PDF");
  assert(
    pdfPageCount(discountedPdf) >= 4 && pdfPageCount(discountedPdf) <= 8,
    "discounted PDF should keep a reasonable page count"
  );

  const noNoticePdf = await generateContractPdfBuffer(contract, {
    includeCancellationNotice: false,
  });
  assert(noNoticePdf.length > 1000, "PDF without notice should still render");
  assert(
    pdfPageCount(noNoticePdf) <= pdfPageCount(pdf),
    "disabled cancellation notice should not increase page count"
  );

  const routeSource = fs.readFileSync(
    path.join(__dirname, "..", "routes", "adminContracts.js"),
    "utf8"
  );
  assert(routeSource.includes("putPrivateObject"), "contracts must use private S3 writes");
  assert(!routeSource.includes("putPublicObject"), "contracts must not use public S3 writes");
  assert(
    routeSource.includes("getContractForProjectOr404"),
    "contract file/action routes must be project scoped"
  );
  assert(
    routeSource.includes("FULL_DEPOSIT_WARNING"),
    "contract routes must enforce full deposit confirmation"
  );

  const pdfSource = fs.readFileSync(
    path.join(__dirname, "..", "utils", "contractPdf.js"),
    "utf8"
  );
  assert(
    !/ATTORNEY_REVIEW_NOTE|attorneyReviewNote|Developer note/i.test(pdfSource),
    "customer PDF renderer must not include developer/legal-review notes"
  );
  assert(
    !/Terms version|CONTRACT_TERMS_VERSION|Cancellation deadline|Cancellation Notice Appendix|attached cancellation notice|Customer Right to Cancel/i.test(pdfSource),
    "customer PDF renderer must not include old terms identifiers or cancellation deadline appendix"
  );
  assert(
    pdfSource.includes("Customer 2 - Optional"),
    "signature page must include optional second customer"
  );
  assert(
    pdfSource.includes("descriptionShouldRender"),
    "renderer must avoid duplicate description/scope rendering"
  );
  assert(
    pdfSource.includes("Page ${i + 1} of ${range.count}"),
    "footer page count must be rendered"
  );
  assert(
    pdfSource.includes("Discount Breakdown") && pdfSource.includes("if (!discounts.length) return"),
    "discount breakdown should render only when discounts exist"
  );
  assert(
    pdfSource.includes("Final Contract Price"),
    "PDF must label adjusted pricing as Final Contract Price"
  );

  console.log("Premium Island Homes contract tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
