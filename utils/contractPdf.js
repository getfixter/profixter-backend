const PDFDocument = require("pdfkit");
const {
  COMPANY_INFO,
  CONTRACT_TERMS_SECTIONS,
  CONTRACT_TERMS_VERSION,
} = require("../config/premiumIslandHomesContract");
const {
  buildContractFilename,
  formatMoney,
} = require("./contractValidation");

const PAGE = {
  width: 612,
  height: 792,
  marginX: 54,
  top: 72,
  bottom: 72,
};

function formatDate(value) {
  if (!value) return "Not specified";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function workTypeLabel(contract) {
  return contract.workType === "Other"
    ? contract.otherWorkType || "Other"
    : contract.workType;
}

function ensureRoom(doc, height = 80) {
  if (doc.y + height > PAGE.height - PAGE.bottom) {
    doc.addPage();
  }
}

function rule(doc) {
  doc
    .moveTo(PAGE.marginX, doc.y)
    .lineTo(PAGE.width - PAGE.marginX, doc.y)
    .strokeColor("#d1d5db")
    .lineWidth(0.75)
    .stroke()
    .strokeColor("#111827");
  doc.moveDown(0.7);
}

function sectionTitle(doc, title) {
  ensureRoom(doc, 60);
  doc.moveDown(0.5);
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827").text(title.toUpperCase());
  doc.moveDown(0.35);
  rule(doc);
}

function labelValue(doc, label, value, options = {}) {
  const labelWidth = options.labelWidth || 130;
  const valueX = options.valueX || PAGE.marginX + 150;
  const valueWidth = options.width || PAGE.width - PAGE.marginX * 2 - 150;
  doc.font("Helvetica-Bold").fontSize(9);
  const labelHeight = doc.heightOfString(label, { width: labelWidth });
  doc.font("Helvetica").fontSize(10);
  const valueHeight = doc.heightOfString(value || "Not specified", { width: valueWidth });
  const rowHeight = Math.max(18, labelHeight, valueHeight) + 4;
  ensureRoom(doc, rowHeight);
  const y = doc.y;
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#6b7280").text(label, PAGE.marginX, y, {
    continued: false,
    width: labelWidth,
  });
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#111827")
    .text(value || "Not specified", valueX, y, {
      width: valueWidth,
    });
  doc.y = y + rowHeight;
}

function paragraph(doc, text, options = {}) {
  const lines = String(text || "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!lines.length) {
    doc.font("Helvetica").fontSize(10).fillColor("#4b5563").text("Not specified");
    doc.moveDown(0.4);
    return;
  }
  for (const block of lines) {
    ensureRoom(doc, 55);
    doc
      .font(options.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(options.size || 10)
      .fillColor(options.color || "#374151")
      .text(block, {
        width: PAGE.width - PAGE.marginX * 2,
        lineGap: 3,
      });
    doc.moveDown(0.55);
  }
}

function drawPaymentRows(doc, rows) {
  const x = PAGE.marginX;
  const widths = [160, 110, PAGE.width - PAGE.marginX * 2 - 270];
  const tableWidth = PAGE.width - PAGE.marginX * 2;
  const headerHeight = 24;

  function rowHeight(row) {
    doc.fillColor("#111827").font("Helvetica").fontSize(9.5);
    return Math.max(
      34,
      doc.heightOfString(row.label || "", {
        width: widths[0] - 16,
      }) + 18,
      doc.heightOfString(formatMoney(row.amountCents), {
        width: widths[1] - 16,
      }) + 18,
      doc.heightOfString(row.dueCondition || "", {
        width: widths[2] - 16,
      }) + 18
    );
  }

  function drawHeader() {
    const headerY = doc.y;
    doc.rect(x, headerY, tableWidth, headerHeight).fill("#f3f4f6");
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(9);
    doc.text("Milestone", x + 8, headerY + 8, { width: widths[0] - 16 });
    doc.text("Amount", x + widths[0] + 8, headerY + 8, { width: widths[1] - 16 });
    doc.text("Due condition", x + widths[0] + widths[1] + 8, headerY + 8, {
      width: widths[2] - 16,
    });
    doc.y = headerY + headerHeight;
  }

  const firstRowHeight = rows.length ? rowHeight(rows[0]) : 0;
  ensureRoom(doc, headerHeight + firstRowHeight + 8);
  drawHeader();

  rows.forEach((row, index) => {
    const height = rowHeight(row);
    if (doc.y + height > PAGE.height - PAGE.bottom) {
      doc.addPage();
      ensureRoom(doc, headerHeight + height + 8);
      drawHeader();
    }
    const rowY = doc.y;
    doc.rect(x, rowY, tableWidth, height).fill(index % 2 ? "#ffffff" : "#f9fafb");
    doc.fillColor("#111827").font("Helvetica").fontSize(9.5);
    doc.text(row.label, x + 8, rowY + 9, { width: widths[0] - 16 });
    doc.font("Helvetica-Bold").text(formatMoney(row.amountCents), x + widths[0] + 8, rowY + 9, {
      width: widths[1] - 16,
    });
    doc.font("Helvetica").text(row.dueCondition, x + widths[0] + widths[1] + 8, rowY + 9, {
      width: widths[2] - 16,
      lineGap: 2,
    });
    doc.y = rowY + height;
  });
  doc.moveDown(0.7);
}

function paymentScheduleForContract(contract) {
  if (contract.paymentSchedule?.length) {
    return contract.paymentSchedule
      .slice()
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  }
  return [
    {
      label: "Deposit",
      amountCents: contract.depositAmountCents,
      dueCondition: "Due when contract is signed.",
    },
    {
      label: "Remaining Balance",
      amountCents: contract.remainingBalanceCents,
      dueCondition: "Due upon substantial completion unless otherwise agreed in writing.",
    },
  ].filter((row) => Number(row.amountCents || 0) > 0);
}

function addHeaderFooter(doc, contract) {
  const range = doc.bufferedPageRange();
  const customerLast = String(contract.customerSnapshot?.fullName || "")
    .trim()
    .split(/\s+/)
    .pop() || "Customer";
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.save();
    const originalMargins = { ...doc.page.margins };
    doc.page.margins.top = 0;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(8).fillColor("#6b7280");
    doc.text(`${contract.contractNumber} v${contract.version}`, PAGE.marginX, 28, {
      width: 180,
    });
    doc.text(`${customerLast} - ${contract.propertySnapshot?.projectNumber || "Project"}`, PAGE.marginX, 40, {
      width: PAGE.width - PAGE.marginX * 2,
      align: "right",
    });
    doc
      .moveTo(PAGE.marginX, 58)
      .lineTo(PAGE.width - PAGE.marginX, 58)
      .strokeColor("#e5e7eb")
      .lineWidth(0.75)
      .stroke();
    doc
      .moveTo(PAGE.marginX, PAGE.height - 50)
      .lineTo(PAGE.width - PAGE.marginX, PAGE.height - 50)
      .strokeColor("#e5e7eb")
      .lineWidth(0.75)
      .stroke();
    doc.font("Helvetica").fontSize(8).fillColor("#6b7280");
    doc.text(`Page ${i + 1} of ${range.count}`, PAGE.marginX, PAGE.height - 38, {
      width: PAGE.width - PAGE.marginX * 2,
      align: "center",
      lineBreak: false,
    });
    doc.page.margins.top = originalMargins.top;
    doc.page.margins.bottom = originalMargins.bottom;
    doc.page.margins.left = originalMargins.left;
    doc.page.margins.right = originalMargins.right;
    doc.restore();
  }
}

async function generateContractPdfBuffer(contract) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margins: {
        top: PAGE.top,
        bottom: PAGE.bottom,
        left: PAGE.marginX,
        right: PAGE.marginX,
      },
      bufferPages: true,
      info: {
        Title: `${contract.contractNumber} Premium Island Homes Contract`,
        Author: COMPANY_INFO.legalName,
        Subject: "Home improvement contract",
      },
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.font("Helvetica-Bold").fontSize(22).fillColor("#111827").text("Home Improvement Contract");
    doc.moveDown(0.4);
    doc.font("Helvetica").fontSize(10).fillColor("#4b5563");
    doc.text(`${COMPANY_INFO.legalName} | License ${COMPANY_INFO.homeImprovementLicense}`);
    doc.text(`${COMPANY_INFO.addressLines.join(", ")} | ${COMPANY_INFO.phone} | ${COMPANY_INFO.email}`);
    doc.text(`${COMPANY_INFO.website} | Project Manager: ${COMPANY_INFO.projectManager}`);
    doc.moveDown(1.1);
    rule(doc);

    labelValue(doc, "Contract number", `${contract.contractNumber} v${contract.version}`);
    labelValue(doc, "Terms version", CONTRACT_TERMS_VERSION);
    labelValue(doc, "Contract date", formatDate(contract.dates?.contractDate));
    labelValue(doc, "Work type", workTypeLabel(contract));

    sectionTitle(doc, "Customer and Property");
    labelValue(doc, "Customer", contract.customerSnapshot?.fullName);
    labelValue(doc, "Email", contract.customerSnapshot?.email || "Not specified");
    labelValue(doc, "Phone", contract.customerSnapshot?.phone || "Not specified");
    labelValue(doc, "Property", contract.propertySnapshot?.address);
    labelValue(doc, "Project", contract.propertySnapshot?.projectNumber || String(contract.projectId || ""));

    sectionTitle(doc, "Project Description");
    paragraph(doc, contract.projectDescription);

    sectionTitle(doc, "Scope of Work");
    paragraph(doc, contract.scopeText);

    sectionTitle(doc, "Price and Payment");
    labelValue(doc, "Contract price", formatMoney(contract.totalPriceCents));
    labelValue(doc, "Deposit required", formatMoney(contract.depositAmountCents));
    labelValue(doc, "Remaining balance", formatMoney(contract.remainingBalanceCents));
    drawPaymentRows(doc, paymentScheduleForContract(contract));

    sectionTitle(doc, "Project Dates");
    labelValue(doc, "Estimated start", formatDate(contract.dates?.estimatedStartDate));
    labelValue(doc, "Estimated completion", formatDate(contract.dates?.estimatedCompletionDate));
    labelValue(doc, "Cancellation deadline", formatDate(contract.dates?.cancellationDeadline));

    const details = contract.optionalDetails || {};
    if (
      details.materialsAllowances ||
      details.exclusions ||
      details.permitResponsibility ||
      details.specialInstructions ||
      details.additionalNotes
    ) {
      sectionTitle(doc, "Additional Details");
      if (details.materialsAllowances) {
        doc.font("Helvetica-Bold").fontSize(10).text("Materials and Allowances");
        paragraph(doc, details.materialsAllowances);
      }
      if (details.exclusions) {
        doc.font("Helvetica-Bold").fontSize(10).text("Exclusions");
        paragraph(doc, details.exclusions);
      }
      if (details.permitResponsibility) {
        doc.font("Helvetica-Bold").fontSize(10).text("Permit Responsibility");
        paragraph(doc, details.permitResponsibility);
      }
      if (details.specialInstructions) {
        doc.font("Helvetica-Bold").fontSize(10).text("Special Customer Instructions");
        paragraph(doc, details.specialInstructions);
      }
      if (details.additionalNotes) {
        doc.font("Helvetica-Bold").fontSize(10).text("Notes");
        paragraph(doc, details.additionalNotes);
      }
    }

    sectionTitle(doc, "Terms and Notices");
    CONTRACT_TERMS_SECTIONS.forEach((section) => {
      ensureRoom(doc, 80);
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#111827").text(section.title);
      doc.moveDown(0.2);
      paragraph(doc, section.body, { size: 9.5, color: "#374151" });
    });

    doc.addPage();
    sectionTitle(doc, "Signature Page");
    paragraph(
      doc,
      "By signing below, the customer and Premium Island Homes Inc. acknowledge receipt and review of this contract, including the cancellation notice appendix."
    );
    doc.moveDown(2);
    doc.font("Helvetica").fontSize(10).fillColor("#111827");
    const sigY = doc.y;
    doc.moveTo(PAGE.marginX, sigY).lineTo(PAGE.marginX + 210, sigY).stroke();
    doc.text("Customer signature", PAGE.marginX, sigY + 8, { width: 210 });
    doc.moveTo(PAGE.marginX + 280, sigY).lineTo(PAGE.marginX + 490, sigY).stroke();
    doc.text("Date", PAGE.marginX + 280, sigY + 8, { width: 210 });
    doc.moveDown(4);
    const sigY2 = doc.y;
    doc.moveTo(PAGE.marginX, sigY2).lineTo(PAGE.marginX + 210, sigY2).stroke();
    doc.text("Premium Island Homes Inc.", PAGE.marginX, sigY2 + 8, { width: 210 });
    doc.moveTo(PAGE.marginX + 280, sigY2).lineTo(PAGE.marginX + 490, sigY2).stroke();
    doc.text("Date", PAGE.marginX + 280, sigY2 + 8, { width: 210 });

    doc.addPage();
    sectionTitle(doc, "Cancellation Notice Appendix");
    labelValue(doc, "Transaction", `${contract.contractNumber} - ${workTypeLabel(contract)}`);
    labelValue(doc, "Company", COMPANY_INFO.legalName);
    labelValue(doc, "Customer", contract.customerSnapshot?.fullName);
    labelValue(doc, "Property", contract.propertySnapshot?.address);
    labelValue(doc, "Cancellation deadline", formatDate(contract.dates?.cancellationDeadline));
    paragraph(
      doc,
      "You may cancel this contract in writing until midnight of the cancellation deadline shown above. To cancel, deliver or mail a written notice to Premium Island Homes Inc. at the address or email listed in this contract. Keep a copy of your cancellation notice for your records."
    );
    doc.moveDown(2);
    const cancelY = doc.y;
    doc.moveTo(PAGE.marginX, cancelY).lineTo(PAGE.marginX + 210, cancelY).stroke();
    doc.text("Customer signature", PAGE.marginX, cancelY + 8, { width: 210 });
    doc.moveTo(PAGE.marginX + 280, cancelY).lineTo(PAGE.marginX + 490, cancelY).stroke();
    doc.text("Date", PAGE.marginX + 280, cancelY + 8, { width: 210 });

    addHeaderFooter(doc, contract);
    doc.end();
  });
}

module.exports = {
  buildContractFilename,
  generateContractPdfBuffer,
};
