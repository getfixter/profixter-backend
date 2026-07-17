const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sharp = require("sharp");
const { validateInvoiceDraftInput } = require("../utils/invoiceValidation");
const { generateInvoicePdfBuffer } = require("../utils/invoicePdf");

const OUT_DIR = path.join(__dirname, "..", "tmp", "invoice-samples");
const PNG_DIR = path.join(OUT_DIR, "png");

const project = {
  _id: "64f000000000000000000301",
  projectNumber: "PRJ-2026-SAMPLE",
  customerId: "64f000000000000000000401",
  customerName: "Ava Campfield",
  email: "ava@example.com",
  phone: "6315551111",
  address: "63 Lee Avenue, Babylon, NY 11702",
  projectType: "Bathroom",
  estimateAmount: 15000,
  depositAmount: 0,
  balanceDue: 15000,
  notes: "Sample invoice project.",
  customerSnapshot: {
    fullName: "Ava Campfield",
    email: "ava@example.com",
    phone: "6315551111",
  },
  propertySnapshot: {
    formattedAddress: "63 Lee Avenue, Babylon, NY 11702",
  },
};

function pageCount(pdf) {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
}

function baseBody(overrides = {}) {
  return {
    customerSnapshot: {
      fullName: project.customerName,
      email: project.email,
      phone: project.phone,
      customerId: String(project.customerId),
    },
    propertySnapshot: {
      address: project.address,
      formattedAddress: project.address,
    },
    projectSnapshot: {
      projectId: project._id,
      projectNumber: project.projectNumber,
      workType: project.projectType,
      projectDescription: "Premium Island Homes project invoice.",
    },
    lineItems: [
      {
        description: "Contract work",
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
    internalNote: "Internal sample note. This must not render in the customer PDF.",
    paymentInstructions: "Checks payable to Premium Island Homes Inc.\nContact 631-599-1363 for payment arrangements.",
    ...overrides,
  };
}

const samples = [
  {
    slug: "01-unpaid-15000",
    invoiceNumber: "000001",
    label: "Unpaid $15,000 invoice",
    body: baseBody({
      projectSnapshot: {
        projectId: project._id,
        projectNumber: project.projectNumber,
        workType: "Bathroom",
        projectDescription: "Final invoice for bathroom renovation work.",
      },
    }),
  },
  {
    slug: "02-partially-paid-discounts",
    invoiceNumber: "000002",
    label: "Partially paid invoice with discounts",
    body: baseBody({
      lineItems: [
        { description: "Kitchen repair labor", quantity: 1, unitPriceCents: 950000, category: "Labor" },
        { description: "Finish materials", quantity: 1, unitPriceCents: 225000, category: "Materials" },
      ],
      discounts: [
        { name: "Returning customer", type: "percentage", value: "7.5" },
        { name: "Material credit", type: "credit", valueCents: 50000 },
      ],
      payments: [
        { amountCents: 300000, paymentDate: "2026-07-16", method: "Check", reference: "1042" },
      ],
      projectSnapshot: {
        projectId: project._id,
        projectNumber: project.projectNumber,
        workType: "Kitchen",
        projectDescription: "Kitchen repair and finish material invoice.",
      },
    }),
  },
  {
    slug: "03-paid-in-full-multiple-payments",
    invoiceNumber: "000003",
    label: "Paid-in-full invoice with multiple payments",
    body: baseBody({
      lineItems: [
        { description: "Roofing project balance", quantity: 1, unitPriceCents: 1250000, category: "Contract work" },
      ],
      payments: [
        { amountCents: 500000, paymentDate: "2026-07-15", method: "Check", reference: "Deposit" },
        { amountCents: 750000, paymentDate: "2026-07-20", method: "ACH / Bank Transfer", reference: "Final" },
      ],
      projectSnapshot: {
        projectId: project._id,
        projectNumber: project.projectNumber,
        workType: "Roofing",
        projectDescription: "Paid receipt for completed roofing project.",
      },
      publicNote: "Final invoice following project completion.",
    }),
  },
  {
    slug: "04-taxable-repair",
    invoiceNumber: "000004",
    label: "Taxable repair invoice",
    body: baseBody({
      lineItems: [
        { description: "Taxable repair labor", quantity: 4, unitPriceCents: 17500, category: "Labor" },
        { description: "Repair materials", quantity: 1, unitPriceCents: 32500, category: "Materials" },
      ],
      taxTreatment: "Taxable Repair / Maintenance",
      taxRateBasisPoints: 862.5,
      projectSnapshot: {
        projectId: project._id,
        projectNumber: project.projectNumber,
        workType: "Handyman",
        projectDescription: "Taxable repair and maintenance invoice.",
      },
    }),
  },
];

async function renderPdfPages(pdfPath, slug) {
  const rendered = [];
  const buffer = fs.readFileSync(pdfPath);
  let metadata;
  try {
    metadata = await sharp(buffer, { density: 144 }).metadata();
  } catch (error) {
    const repoRoot = path.join(__dirname, "..");
    const relativeOutput = path.relative(repoRoot, PNG_DIR);
    const relativePdf = path.relative(repoRoot, pdfPath);
    try {
      if (process.platform === "win32") {
        execFileSync("cmd.exe", ["/c", "npx", "--yes", "pdf-to-img", "-s", "2", "-o", relativeOutput, relativePdf], {
          cwd: repoRoot,
          stdio: "pipe",
        });
      } else {
        execFileSync("npx", ["--yes", "pdf-to-img", "-s", "2", "-o", relativeOutput, relativePdf], {
          cwd: repoRoot,
          stdio: "pipe",
        });
      }
      const files = fs
        .readdirSync(PNG_DIR)
        .filter((file) => file.startsWith(`${slug}-`) && file.endsWith(".png"))
        .sort();
      return { rendered: files.map((file) => path.join(PNG_DIR, file)), error: "" };
    } catch (fallbackError) {
      return {
        rendered,
        error: `PDF rasterization unavailable through sharp (${error.message}) and pdf-to-img (${fallbackError.message})`,
      };
    }
  }
  const pages = Math.max(Number(metadata.pages || 1), 1);
  for (let page = 0; page < pages; page += 1) {
    const pngPath = path.join(PNG_DIR, `${slug}-page-${String(page + 1).padStart(2, "0")}.png`);
    await sharp(buffer, { density: 144, page })
      .png()
      .toFile(pngPath);
    rendered.push(pngPath);
  }
  return { rendered, error: "" };
}

async function createContactSheet(renderedPages) {
  if (!renderedPages.length) return "";
  const thumbs = [];
  for (const page of renderedPages) {
    const image = await sharp(page.path)
      .resize({ width: 360, withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    thumbs.push({ ...page, buffer: image.data, width: image.info.width, height: image.info.height });
  }

  const cellWidth = 450;
  const cellHeight = Math.max(...thumbs.map((thumb) => thumb.height)) + 58;
  const cols = Math.min(2, thumbs.length);
  const rows = Math.ceil(thumbs.length / cols);
  const width = cols * cellWidth;
  const height = rows * cellHeight;
  const composites = thumbs.flatMap((thumb, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const left = col * cellWidth + Math.floor((cellWidth - thumb.width) / 2);
    const top = row * cellHeight + 42;
    const label = `${thumb.sampleLabel} - page ${thumb.page}`;
    const labelSvg = Buffer.from(`
      <svg width="${cellWidth}" height="36" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#ffffff"/>
        <text x="12" y="23" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#0f172a">${label.replace(/&/g, "&amp;")}</text>
      </svg>
    `);
    return [
      { input: labelSvg, left: col * cellWidth, top: row * cellHeight },
      { input: thumb.buffer, left, top },
    ];
  });

  const contactSheet = path.join(OUT_DIR, "invoice-contact-sheet.png");
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: "#ffffff",
    },
  })
    .composite(composites)
    .png()
    .toFile(contactSheet);
  return contactSheet;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(PNG_DIR, { recursive: true });

  const summary = [];
  const renderedPages = [];
  const renderErrors = [];

  for (const sample of samples) {
    const result = validateInvoiceDraftInput(sample.body, project);
    if (result.errors.length) {
      throw new Error(`${sample.slug}: ${result.errors.join("; ")}`);
    }
    const invoice = {
      _id: `650000000000000000000${summary.length + 301}`,
      invoiceNumber: sample.invoiceNumber,
      version: 1,
      projectId: project._id,
      ...result.update,
    };
    const pdf = await generateInvoicePdfBuffer(invoice);
    const pdfPath = path.join(OUT_DIR, `${sample.slug}.pdf`);
    fs.writeFileSync(pdfPath, pdf);

    const renderResult = await renderPdfPages(pdfPath, sample.slug);
    if (renderResult.error) renderErrors.push({ slug: sample.slug, error: renderResult.error });
    renderResult.rendered.forEach((pngPath, index) => {
      renderedPages.push({
        path: pngPath,
        page: index + 1,
        sampleLabel: sample.label,
      });
    });

    summary.push({
      slug: sample.slug,
      label: sample.label,
      pdfPath,
      pageCount: pageCount(pdf),
      bytes: pdf.length,
      invoiceTotalCents: result.update.invoiceTotalCents,
      totalPaidCents: result.update.totalPaidCents,
      remainingBalanceCents: result.update.remainingBalanceCents,
      taxAmountCents: result.update.taxAmountCents,
      status: result.update.status,
      renderedPngs: renderResult.rendered,
    });
  }

  const contactSheet = await createContactSheet(renderedPages);
  const summaryPath = path.join(OUT_DIR, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify({
    outDir: OUT_DIR,
    pngDir: PNG_DIR,
    contactSheet,
    renderErrors,
    samples: summary,
  }, null, 2));

  if (renderErrors.length) {
    fs.writeFileSync(path.join(OUT_DIR, "rendering-notes.txt"), renderErrors.map((item) => `${item.slug}: ${item.error}`).join("\n"));
  }

  console.log(JSON.stringify({ outDir: OUT_DIR, pngDir: PNG_DIR, contactSheet, renderErrors, samples: summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
