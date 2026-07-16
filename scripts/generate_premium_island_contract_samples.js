const fs = require("fs");
const path = require("path");
const {
  CANCELLATION_NOTICE_TERMS_VERSION,
  CONTRACT_TERMS_VERSION,
} = require("../config/premiumIslandHomesContract");
const { validateContractInput } = require("../utils/contractValidation");
const { generateContractPdfBuffer } = require("../utils/contractPdf");

const OUT_DIR = path.join(__dirname, "..", "tmp", "contract-samples");

const project = {
  _id: "64f000000000000000000123",
  projectNumber: "PRJ-2026-SAMPLE",
  customerName: "Ava Campfield",
  email: "avasarafina@gmail.com",
  phone: "6315551111",
  address: "63 Lee Avenue, Babylon, NY 11702",
  projectType: "Bathroom",
  notes: "Sample contract",
};

function pageCount(pdf) {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
}

function baseBody(overrides = {}) {
  return {
    workType: "Bathroom",
    otherWorkType: "",
    projectDescription: "Residential home improvement project for the selected property.",
    scopeText:
      "Prepare the work area, protect adjacent surfaces, complete the agreed installation, and remove ordinary construction debris from the work area.",
    totalPriceCents: 450000,
    depositAmountCents: 150000,
    discounts: [],
    paymentSchedule: [
      { label: "Deposit", amountCents: 150000, dueCondition: "Due when contract is signed." },
      { label: "Remaining Balance", amountCents: 300000, dueCondition: "Due upon substantial completion." },
    ],
    dates: {
      contractDate: "2026-07-15",
      estimatedStartDate: "2026-08-03",
      estimatedCompletionDate: "2026-08-07",
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

const samples = [
  {
    slug: "small-bathroom-no-discount",
    contractNumber: "PIH-2026-SAMPLE-001",
    body: baseBody({
      workType: "Bathroom",
      projectDescription: "Small bathroom refresh for vanity, fixtures, and finish repairs.",
      scopeText: [
        "- Remove existing vanity, faucet, and mirror.",
        "- Install customer-selected vanity, faucet, and mirror.",
        "- Repair small sheetrock areas disturbed by the removal.",
        "- Touch up the repaired wall area with matching paint supplied for the project.",
        "- Clean the work area and remove ordinary debris.",
      ].join("\n"),
      totalPriceCents: 425000,
      depositAmountCents: 150000,
      paymentSchedule: [
        { label: "Deposit", amountCents: 150000, dueCondition: "Due when contract is signed." },
        { label: "Final Payment", amountCents: 275000, dueCondition: "Due upon substantial completion." },
      ],
      optionalDetails: {
        exclusions: "Tile replacement, plumbing relocation, electrical relocation, and fixture purchases are excluded unless added by written change order.",
      },
    }),
  },
  {
    slug: "standard-remodel-two-discounts",
    contractNumber: "PIH-2026-SAMPLE-002",
    body: baseBody({
      workType: "Kitchen",
      projectDescription: "Kitchen and dining-area remodeling work for a registered customer at the selected property.",
      scopeText: [
        "1. Protect adjacent flooring, entry areas, and work paths before demolition begins.",
        "2. Remove selected cabinets, countertops, backsplash, and non-structural finishes.",
        "3. Install new stock cabinetry, new quartz countertop, tile backsplash, sink, faucet, and finish trim.",
        "4. Patch and paint affected wall areas in the kitchen and adjacent dining area.",
        "5. Coordinate ordinary debris removal and final broom-clean condition.",
      ].join("\n"),
      totalPriceCents: 2850000,
      depositAmountCents: 800000,
      discounts: [
        { name: "Returning Customer Courtesy Adjustment", type: "percentage", valueBasisPoints: 750 },
        { name: "Material Coordination Credit", type: "fixed", valueCents: 125000, note: "Applied to the original scope only." },
      ],
      paymentSchedule: [
        { label: "Deposit", amountCents: 800000, dueCondition: "Due when contract is signed." },
        { label: "Rough-In / Material Milestone", amountCents: 900000, dueCondition: "Due after demolition and delivery of primary materials." },
        { label: "Final Payment", amountCents: 811250, dueCondition: "Due upon substantial completion." },
      ],
      optionalDetails: {
        materialsAllowances: "Cabinetry, countertop, sink, faucet, tile, grout, and finish trim are included as described in the written scope and selections.",
        exclusions: "Appliances, structural framing changes, concealed-condition repairs, and permit fees are excluded unless added by written change order.",
      },
    }),
  },
  {
    slug: "large-long-scope-multiple-milestones",
    contractNumber: "PIH-2026-SAMPLE-003",
    body: baseBody({
      workType: "Home Remodeling",
      projectDescription:
        "Large first-floor remodeling project with long customer name and property details for page-break and wrapping review.",
      scopeText: [
        "Project areas include the kitchen, dining room, hallway, powder room, and selected adjacent finish surfaces.",
        "",
        "- Protect existing finished areas, set up dust-control measures, and coordinate access with the homeowner.",
        "- Remove selected cabinets, countertops, backsplash, trim, damaged sheetrock, and finish materials listed in the project notes.",
        "- Perform ordinary carpentry modifications needed for the new layout, excluding structural beam or bearing-wall changes unless added in writing.",
        "- Coordinate licensed trade work where required for plumbing, electrical, and fixture connections within the agreed scope.",
        "- Install new cabinetry, countertop, backsplash, powder-room vanity, interior trim, doors, and selected finish materials.",
        "- Patch, sand, prime, and paint affected wall and ceiling areas within the described work zones.",
        "- Maintain reasonable daily cleanup and remove ordinary construction debris generated by Premium Island Homes Inc.",
        "- Complete a final walkthrough and address valid punch-list items related to the agreed scope.",
        "",
        "The customer acknowledges that concealed water damage, mold, rot, pest damage, code violations, framing defects, electrical defects, plumbing defects, and conditions hidden behind existing finishes are not included unless specifically listed above or added by written change order.",
      ].join("\n"),
      totalPriceCents: 8750000,
      depositAmountCents: 2000000,
      discounts: [
        { name: "Multi-Room Project Adjustment", type: "percentage", valueBasisPoints: 500 },
        { name: "Previously Purchased Material Credit", type: "fixed", valueCents: 350000, note: "Credit reflects usable customer-supplied finish materials accepted before signing." },
        { name: "Scheduling Coordination Credit", type: "fixed", valueCents: 150000, note: "Applied only to the original schedule and scope." },
      ],
      paymentSchedule: [
        { label: "Deposit", amountCents: 2000000, dueCondition: "Due when contract is signed." },
        { label: "Demolition and Mobilization", amountCents: 1500000, dueCondition: "Due after site protection, mobilization, and initial demolition." },
        { label: "Rough Work / Material Delivery", amountCents: 1500000, dueCondition: "Due after primary rough work and delivery of major materials." },
        { label: "Cabinetry / Finish Installation", amountCents: 1500000, dueCondition: "Due after installation of major finish components." },
        { label: "Final Payment", amountCents: 1312500, dueCondition: "Due upon substantial completion and final walkthrough." },
      ],
      dates: {
        contractDate: "2026-07-15",
        estimatedStartDate: "2026-09-08",
        estimatedCompletionDate: "2026-11-20",
      },
      optionalDetails: {
        materialsAllowances: "Finish selections must be confirmed in writing before ordering. Customer-supplied materials are accepted only after inspection for completeness and compatibility.",
        exclusions: "Major structural changes, architectural plans, permit fees, hazardous material remediation, appliance purchase, hidden-condition repairs, and work outside the listed rooms are excluded unless added by written change order.",
        permitResponsibility: "Permit responsibility will be confirmed before work begins if the municipality requires a permit for the final approved scope.",
        specialInstructions: "Customer will clear personal belongings from work zones before the start date and provide reasonable parking or delivery access when available.",
      },
    }),
  },
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const summary = [];

  for (const sample of samples) {
    const result = validateContractInput(sample.body, project);
    if (result.errors.length) {
      throw new Error(`${sample.slug}: ${result.errors.join("; ")}`);
    }
    const contract = {
      _id: `650000000000000000000${summary.length + 10}`,
      contractNumber: sample.contractNumber,
      version: 1,
      projectId: project._id,
      ...result.update,
      customerSnapshot: {
        fullName:
          sample.slug === "large-long-scope-multiple-milestones"
            ? "Ava Elizabeth Campfield-Sarafina"
            : project.customerName,
        email: project.email,
        phone: project.phone,
        customerId: String(project._id),
      },
      propertySnapshot: {
        address:
          sample.slug === "large-long-scope-multiple-milestones"
            ? "63 Lee Avenue, Unit 2B, Babylon, NY 11702"
            : project.address,
        projectNumber: project.projectNumber,
      },
      membershipSummary: {
        selectedAddressStatus: "active",
        selectedAddressPlanName: "Premium",
      },
      termsVersion: CONTRACT_TERMS_VERSION,
      legalNoticeVersion: CANCELLATION_NOTICE_TERMS_VERSION,
      addAuditEvent() {},
    };
    const pdf = await generateContractPdfBuffer(contract);
    const pdfPath = path.join(OUT_DIR, `${sample.slug}.pdf`);
    fs.writeFileSync(pdfPath, pdf);
    summary.push({
      slug: sample.slug,
      pdfPath,
      pageCount: pageCount(pdf),
      bytes: pdf.length,
      originalContractPriceCents: result.update.originalContractPriceCents,
      totalDiscountAmountCents: result.update.totalDiscountAmountCents,
      adjustedContractPriceCents: result.update.adjustedContractPriceCents,
      depositAmountCents: result.update.depositAmountCents,
      remainingBalanceCents: result.update.remainingBalanceCents,
      discounts: result.update.discounts,
      warnings: result.warnings.map((warning) => warning.code),
    });
  }

  const summaryPath = path.join(OUT_DIR, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ outDir: OUT_DIR, summaryPath, samples: summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
