const assert = require("assert");
const fs = require("fs");
const path = require("path");

const Counter = require("../models/Counter");
const Invoice = require("../models/Invoice");
const {
  CAPITAL_IMPROVEMENT_TREATMENT,
  TAX_REVIEW_NOTE,
  TAXABLE_TREATMENT,
  calculateInvoiceFinancials,
  validateInvoiceDraftInput,
} = require("../utils/invoiceValidation");
const { generateInvoicePdfBuffer } = require("../utils/invoicePdf");

const project = {
  _id: "64f000000000000000000101",
  projectNumber: "PRJ-2026-00015",
  customerId: "64f000000000000000000201",
  customerName: "Anne Grant",
  email: "anne.grant@example.com",
  phone: "6315550101",
  address: "123 Main Street, Lindenhurst, NY 11757",
  projectType: "Bathroom",
  estimateAmount: 15000,
  depositAmount: 2500,
  balanceDue: 12500,
  notes: "Bathroom renovation completion invoice.",
  customerSnapshot: {
    fullName: "Anne Grant",
    email: "anne.grant@example.com",
    phone: "6315550101",
  },
  propertySnapshot: {
    formattedAddress: "123 Main Street, Lindenhurst, NY 11757",
  },
};

function validBody(overrides = {}) {
  return {
    customerSnapshot: {
      fullName: "Anne Grant",
      email: "anne.grant@example.com",
      phone: "6315550101",
      customerId: String(project.customerId),
    },
    propertySnapshot: {
      address: "123 Main Street, Lindenhurst, NY 11757",
      formattedAddress: "123 Main Street, Lindenhurst, NY 11757",
    },
    projectSnapshot: {
      projectId: project._id,
      projectNumber: project.projectNumber,
      workType: "Bathroom",
      projectDescription: "Bathroom renovation completion invoice.",
    },
    lineItems: [
      {
        description: "Final bathroom contract work",
        quantity: 1,
        unitPriceCents: 1500000,
        category: "Contract work",
      },
    ],
    discounts: [],
    taxTreatment: "Not Determined",
    taxRateBasisPoints: 0,
    dueTerm: "net_15",
    dates: {
      invoiceDate: "2026-07-15",
      dueDate: "2026-07-30",
      serviceDate: "2026-07-14",
    },
    publicNote: "Thank you for your business.",
    internalNote: "Internal notes must not appear on customer PDFs.",
    paymentInstructions: "Checks payable to Premium Island Homes Inc.",
    ...overrides,
  };
}

function pdfPageCount(pdf) {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
}

function invoiceForPdf(update, overrides = {}) {
  return {
    _id: "650000000000000000000101",
    invoiceNumber: "000001",
    version: 1,
    projectId: project._id,
    status: update.status,
    ...update,
    ...overrides,
  };
}

async function testNumbering() {
  const original = Counter.findOneAndUpdate;
  let value = 0;
  Counter.findOneAndUpdate = async (query) => {
    assert.deepStrictEqual(query, { key: "pih-invoice" });
    value += 1;
    return { value };
  };
  try {
    assert.strictEqual(await Invoice.nextInvoiceNumber(), "000001");
    assert.strictEqual(await Invoice.nextInvoiceNumber(), "000002");
  } finally {
    Counter.findOneAndUpdate = original;
  }
}

async function main() {
  await testNumbering();

  const manual = validateInvoiceDraftInput(validBody(), project);
  assert.deepStrictEqual(manual.errors, []);
  assert.strictEqual(manual.update.subtotalCents, 1500000);
  assert.strictEqual(manual.update.invoiceTotalCents, 1500000);
  assert.strictEqual(manual.update.remainingBalanceCents, 1500000);
  assert.strictEqual(manual.update.status, "Draft");

  const multipleLines = validateInvoiceDraftInput(
    validBody({
      lineItems: [
        { description: "Labor", quantity: 2.5, unitPriceCents: 10000, category: "Labor" },
        { description: "Materials", quantity: 3, unitPriceCents: 5000, category: "Materials" },
      ],
    }),
    project
  );
  assert.deepStrictEqual(multipleLines.errors, []);
  assert.strictEqual(multipleLines.update.subtotalCents, 40000);

  const fixedDiscount = validateInvoiceDraftInput(
    validBody({ discounts: [{ name: "Courtesy", type: "fixed", valueCents: 50000 }] }),
    project
  );
  assert.deepStrictEqual(fixedDiscount.errors, []);
  assert.strictEqual(fixedDiscount.update.totalDiscountCents, 50000);
  assert.strictEqual(fixedDiscount.update.invoiceTotalCents, 1450000);

  const percentageDiscount = validateInvoiceDraftInput(
    validBody({ discounts: [{ name: "Seasonal", type: "percentage", value: "10" }] }),
    project
  );
  assert.deepStrictEqual(percentageDiscount.errors, []);
  assert.strictEqual(percentageDiscount.update.discounts[0].value, 1000);
  assert.strictEqual(percentageDiscount.update.totalDiscountCents, 150000);
  assert.strictEqual(percentageDiscount.update.invoiceTotalCents, 1350000);

  const multipleDiscounts = validateInvoiceDraftInput(
    validBody({
      discounts: [
        { name: "Seasonal", type: "percentage", value: "10" },
        { name: "Project credit", type: "credit", valueCents: 25000 },
      ],
    }),
    project
  );
  assert.deepStrictEqual(multipleDiscounts.errors, []);
  assert.strictEqual(multipleDiscounts.update.totalDiscountCents, 175000);

  const excessiveDiscount = validateInvoiceDraftInput(
    validBody({ discounts: [{ name: "Too much", type: "fixed", valueCents: 1600000 }] }),
    project
  );
  assert(
    excessiveDiscount.errors.includes("Total discounts and credits cannot exceed invoice subtotal"),
    "discounts must not reduce invoice total below zero"
  );

  const taxable = validateInvoiceDraftInput(
    validBody({
      lineItems: [{ description: "Repair work", quantity: 1, unitPriceCents: 100000, category: "Labor" }],
      taxTreatment: TAXABLE_TREATMENT,
      taxRateBasisPoints: 862.5,
    }),
    project
  );
  assert.deepStrictEqual(taxable.errors, []);
  assert.strictEqual(taxable.update.taxableAmountCents, 100000);
  assert.strictEqual(taxable.update.taxAmountCents, 8625);
  assert.strictEqual(taxable.update.invoiceTotalCents, 108625);

  const capitalImprovement = validateInvoiceDraftInput(
    validBody({
      taxTreatment: CAPITAL_IMPROVEMENT_TREATMENT,
      taxRateBasisPoints: 862.5,
    }),
    project
  );
  assert.deepStrictEqual(capitalImprovement.errors, []);
  assert.strictEqual(capitalImprovement.update.taxAmountCents, 0);
  assert.strictEqual(TAX_REVIEW_NOTE.includes("accountant"), true);

  const partialPayment = validateInvoiceDraftInput(
    validBody({
      payments: [{ amountCents: 500000, paymentDate: "2026-07-16", method: "Check" }],
    }),
    project
  );
  assert.deepStrictEqual(partialPayment.errors, []);
  assert.strictEqual(partialPayment.update.totalPaidCents, 500000);
  assert.strictEqual(partialPayment.update.remainingBalanceCents, 1000000);
  assert.strictEqual(partialPayment.update.status, "Partially Paid");

  const paid = validateInvoiceDraftInput(
    validBody({
      payments: [
        { amountCents: 500000, paymentDate: "2026-07-16", method: "Check" },
        { amountCents: 1000000, paymentDate: "2026-07-18", method: "ACH / Bank Transfer" },
      ],
    }),
    project
  );
  assert.deepStrictEqual(paid.errors, []);
  assert.strictEqual(paid.update.status, "Paid in Full");
  assert.strictEqual(paid.update.remainingBalanceCents, 0);
  assert.strictEqual(paid.update.dates.paidInFullAt.toISOString().slice(0, 10), "2026-07-18");

  const reopened = calculateInvoiceFinancials({
    ...paid.update,
    status: "Paid in Full",
    payments: [{ amountCents: 500000, paymentDate: new Date("2026-07-16T12:00:00.000Z"), method: "Check" }],
  });
  assert.deepStrictEqual(reopened.errors, []);
  assert.strictEqual(reopened.status, "Partially Paid");
  assert.strictEqual(reopened.paidInFullAt, null);

  const overpaid = validateInvoiceDraftInput(
    validBody({
      payments: [{ amountCents: 1600000, paymentDate: "2026-07-16", method: "Check" }],
    }),
    project
  );
  assert(
    overpaid.errors.includes("Total payments cannot exceed invoice total"),
    "overpayments must be prevented"
  );

  const overdue = validateInvoiceDraftInput(
    validBody({
      dueTerm: "custom",
      dates: {
        invoiceDate: "2026-01-01",
        dueDate: "2026-01-10",
      },
    }),
    project
  );
  assert.deepStrictEqual(overdue.errors, []);
  assert.strictEqual(overdue.update.status, "Overdue");

  const unpaidPdf = await generateInvoicePdfBuffer(invoiceForPdf(manual.update));
  assert(unpaidPdf.length > 1000, "unpaid invoice PDF should not be empty");
  assert.strictEqual(unpaidPdf.subarray(0, 4).toString(), "%PDF");
  assert(pdfPageCount(unpaidPdf) >= 1 && pdfPageCount(unpaidPdf) <= 2, "simple invoice should stay compact");

  const paidPdf = await generateInvoicePdfBuffer(invoiceForPdf(paid.update));
  assert(paidPdf.length > 1000, "paid invoice PDF should render");
  assert.strictEqual(paidPdf.subarray(0, 4).toString(), "%PDF");

  const manyLineItems = validateInvoiceDraftInput(
    validBody({
      lineItems: Array.from({ length: 45 }, (_, index) => ({
        description: `Detailed change order line ${index + 1}`,
        quantity: 1,
        unitPriceCents: 10000 + index,
        category: "Change order",
      })),
    }),
    project
  );
  assert.deepStrictEqual(manyLineItems.errors, []);
  const multipagePdf = await generateInvoicePdfBuffer(invoiceForPdf(manyLineItems.update, { invoiceNumber: "000004" }));
  assert(pdfPageCount(multipagePdf) > 1, "large invoices should flow to multiple pages");

  const routeSource = fs.readFileSync(path.join(__dirname, "..", "routes", "adminInvoices.js"), "utf8");
  assert(routeSource.includes("putPrivateObject"), "invoices must use private S3 writes");
  assert(!routeSource.includes("putPublicObject"), "invoice PDFs must not be public S3 objects");
  assert(routeSource.includes("getInvoiceForProjectOr404"), "invoice actions must be project scoped");
  assert(routeSource.includes("Invoice not found for this project"), "cross-project invoice access must fail closed");
  assert(routeSource.includes("requirePermission(PERMISSIONS.ADMIN)"), "invoice management must be admin-only");
  assert(routeSource.includes("assertNoActiveContractImport"), "contract invoice imports must prevent double import");
  assert(routeSource.includes("Generate a current invoice PDF before emailing"), "stale PDFs must not be emailed");
  assert(routeSource.indexOf("sendRaw") < routeSource.indexOf("invoice.emailHistory.push"), "email history must be written only after send succeeds");
  assert(routeSource.includes("Failed to generate invoice PDF"), "S3/PDF generation failures must be handled");
  assert(routeSource.includes("Failed to email invoice"), "email failures must be handled");
  assert(routeSource.includes('confirmation !== "VOID"'), "voiding must require explicit confirmation");

  const modelSource = fs.readFileSync(path.join(__dirname, "..", "models", "Invoice.js"), "utf8");
  assert(modelSource.includes('key: "pih-invoice"') && modelSource.includes('padStart(6, "0")'), "invoice numbers must use a global six-digit sequence");
  assert(modelSource.includes("generatedPdfs"), "PDF versions must be preserved");
  assert(modelSource.includes("eventHistory"), "invoice audit history must be tracked");

  const pdfSource = fs.readFileSync(path.join(__dirname, "..", "utils", "invoicePdf.js"), "utf8");
  assert(pdfSource.includes("PAID IN FULL"), "paid-in-full badge must render in PDF");
  assert(pdfSource.includes("Payment History"), "payment history must render in PDF");
  assert(pdfSource.includes("VOID"), "voided invoices must be visible on generated PDFs");
  assert(!/internalNote|TAX_REVIEW_NOTE|Developer note|generatedPdfs|version label/i.test(pdfSource), "customer PDF must not expose internal metadata");

  console.log("Premium Island Homes invoice tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
