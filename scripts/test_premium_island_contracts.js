const assert = require("assert");
const {
  buildContractFilename,
  validateContractInput,
} = require("../utils/contractValidation");
const { generateContractPdfBuffer } = require("../utils/contractPdf");

const project = {
  _id: "64f000000000000000000001",
  projectNumber: "PRJ-2026-00001",
  customerName: "Alex Smith",
  email: "alex@example.com",
  phone: "6315550101",
  address: "123 Main Street, Lindenhurst, NY",
  projectType: "Bathroom",
  notes: "Primary bathroom remodel",
};

function validBody(overrides = {}) {
  return {
    workType: "Bathroom",
    otherWorkType: "",
    projectDescription: "Bathroom remodel",
    scopeText: "Remove existing vanity.\nInstall new tile and fixtures.",
    totalPriceCents: 1250000,
    depositAmountCents: 250000,
    paymentSchedule: [
      {
        label: "Deposit",
        amountCents: 250000,
        dueCondition: "Due at signing",
      },
      {
        label: "Final",
        amountCents: 1000000,
        dueCondition: "Due at substantial completion",
      },
    ],
    dates: {
      contractDate: "2026-07-15",
      estimatedStartDate: "2026-08-01",
      estimatedCompletionDate: "2026-08-15",
      cancellationDeadline: "2026-07-18",
    },
    optionalDetails: {
      materialsAllowances: "Tile allowance included.",
      exclusions: "",
      permitResponsibility: "Premium Island Homes Inc.",
      specialInstructions: "",
      additionalNotes: "",
    },
    ...overrides,
  };
}

async function main() {
  const result = validateContractInput(validBody(), project);
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.update.totalPriceCents, 1250000);
  assert.strictEqual(result.update.depositAmountCents, 250000);
  assert.strictEqual(result.update.remainingBalanceCents, 1000000);
  assert.strictEqual(result.update.paymentSchedule.length, 2);

  const depositTooHigh = validateContractInput(
    validBody({ totalPriceCents: 100000, depositAmountCents: 200000 }),
    project
  );
  assert(
    depositTooHigh.errors.includes("Deposit cannot exceed total contract price"),
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
    scheduleTooHigh.errors.includes("Payment schedule total cannot exceed the contract price"),
    "payment schedule validation failed"
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
    version: 1,
    projectId: project._id,
    ...result.update,
    termsVersion: "PIH-NY-HI-2026-001",
    addAuditEvent() {},
  };

  const filename = buildContractFilename(contract);
  assert.strictEqual(filename, "PIH-2026-0001-Smith-Bathroom-Contract.pdf");

  const pdf = await generateContractPdfBuffer(contract);
  assert(pdf.length > 1000, "PDF should not be empty");
  assert.strictEqual(pdf.subarray(0, 4).toString(), "%PDF");

  console.log("Premium Island Homes contract tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
