const PDFDocument = require("pdfkit");
const { COMPANY_INFO } = require("../config/premiumIslandHomesContract");
const {
  buildInvoiceFilename,
  formatMoney,
  invoiceDisplayLabel,
} = require("./invoiceValidation");

const PAGE = {
  width: 612,
  height: 792,
  marginX: 54,
  top: 54,
  bottom: 58,
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

function compactDate(value) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const normalized = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (normalized.length !== 10) return value || "Not specified";
  return `(${normalized.slice(0, 3)}) ${normalized.slice(3, 6)}-${normalized.slice(6)}`;
}

function workTypeLabel(invoice) {
  return invoice.projectSnapshot?.workType || "Project";
}

function cleanLines(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function ensureRoom(doc, height = 80) {
  if (doc.y + height > PAGE.height - PAGE.bottom) {
    doc.addPage();
  }
}

function textHeight(doc, text, width, options = {}) {
  doc.font(options.font || "Helvetica").fontSize(options.size || 9.2);
  return doc.heightOfString(text || " ", {
    width,
    lineGap: options.lineGap ?? 1.4,
  });
}

function rule(doc, color = "#d1d5db") {
  doc
    .moveTo(PAGE.marginX, doc.y)
    .lineTo(PAGE.width - PAGE.marginX, doc.y)
    .strokeColor(color)
    .lineWidth(0.75)
    .stroke()
    .strokeColor("#111827");
}

function sectionTitle(doc, title, options = {}) {
  ensureRoom(doc, options.keepWith || 56);
  doc.moveDown(options.topGap ?? 0.65);
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text(title.toUpperCase(), PAGE.marginX, doc.y, {
    characterSpacing: 0.15,
  });
  doc.moveDown(0.25);
  rule(doc);
  doc.moveDown(0.38);
}

function drawParagraph(doc, text, options = {}) {
  const width = options.width || PAGE.width - PAGE.marginX * 2;
  const x = options.x || PAGE.marginX;
  const size = options.size || 9.2;
  const lineGap = options.lineGap ?? 1.6;
  const height = textHeight(doc, text, width, { size, lineGap, font: options.font || "Helvetica" }) + 4;
  ensureRoom(doc, height);
  doc.font(options.font || "Helvetica").fontSize(size).fillColor(options.color || "#374151").text(text || "Not specified", x, doc.y, {
    width,
    lineGap,
  });
  doc.moveDown(options.after ?? 0.35);
}

function drawStatusBadge(doc, invoice) {
  const paid = invoice.status === "Paid in Full" ||
    (Number(invoice.invoiceTotalCents || 0) > 0 && Number(invoice.remainingBalanceCents || 0) === 0);
  const voided = invoice.status === "Voided";
  if (!paid && !voided) return;
  const label = voided ? "VOID" : "PAID IN FULL";
  const color = voided ? "#b91c1c" : "#047857";
  const bg = voided ? "#fef2f2" : "#ecfdf5";
  const border = voided ? "#fecaca" : "#a7f3d0";
  const x = PAGE.marginX;
  const y = doc.y;
  const width = 176;
  const height = 36;
  ensureRoom(height + 8);
  doc.roundedRect(x, y, width, height, 4).fillAndStroke(bg, border);
  doc.font("Helvetica-Bold").fontSize(13).fillColor(color).text(label, x + 10, y + 10, {
    width: width - 20,
    align: "center",
  });
  if (paid && invoice.dates?.paidInFullAt) {
    doc.font("Helvetica").fontSize(8.2).fillColor("#065f46").text(`Paid in Full on ${compactDate(invoice.dates.paidInFullAt)}`, x + width + 12, y + 12, {
      width: 250,
    });
  }
  doc.y = y + height + 8;
}

function drawFirstPageHeader(doc, invoice) {
  const rightWidth = 165;
  const leftWidth = PAGE.width - PAGE.marginX * 2 - rightWidth - 24;
  doc.font("Helvetica-Bold").fontSize(25).fillColor("#111827").text("INVOICE", PAGE.marginX, PAGE.top, {
    width: leftWidth,
  });
  doc.moveDown(0.18);
  doc.font("Helvetica-Bold").fontSize(10.6).fillColor("#111827").text(COMPANY_INFO.legalName, {
    width: leftWidth,
  });
  doc.moveDown(0.16);
  doc.font("Helvetica").fontSize(8.4).fillColor("#4b5563").text(COMPANY_INFO.addressLines.join(" | "), {
    width: leftWidth,
    lineGap: 1,
  });
  doc.font("Helvetica").fontSize(8.4).fillColor("#4b5563").text(
    `${COMPANY_INFO.phone} | ${COMPANY_INFO.email} | ${COMPANY_INFO.website} | License ${COMPANY_INFO.homeImprovementLicense}`,
    {
      width: leftWidth,
      lineGap: 1,
    }
  );
  const companyBottomY = doc.y;

  const rightX = PAGE.width - PAGE.marginX - rightWidth;
  const summaryRows = [
    [invoiceDisplayLabel(invoice), ""],
    ["Invoice Date", formatDate(invoice.dates?.invoiceDate)],
    ["Due Date", formatDate(invoice.dates?.dueDate)],
    ["Status", invoice.status || "Draft"],
  ];
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827").text(summaryRows[0][0], rightX, PAGE.top + 2, {
    width: rightWidth,
    align: "right",
  });
  let y = PAGE.top + 24;
  summaryRows.slice(1).forEach(([label, value]) => {
    doc.font("Helvetica").fontSize(7.7).fillColor("#6b7280").text(label, rightX, y, {
      width: rightWidth,
      align: "right",
    });
    doc.font("Helvetica-Bold").fontSize(8.8).fillColor("#111827").text(value, rightX, y + 10, {
      width: rightWidth,
      align: "right",
      lineGap: 0.8,
    });
    y += 26;
  });
  const summaryBottomY = y;

  const dividerPadding = 9;
  doc.y = Math.max(companyBottomY, summaryBottomY, PAGE.top + 82) + dividerPadding;
  rule(doc, "#cbd5e1");
  doc.y += dividerPadding;
}

function drawInfoBlocks(doc, invoice) {
  const gap = 20;
  const width = (PAGE.width - PAGE.marginX * 2 - gap) / 2;
  const startY = doc.y;

  function block(x, title, rows) {
    doc.font("Helvetica-Bold").fontSize(8.4).fillColor("#64748b").text(title.toUpperCase(), x, startY, {
      width,
    });
    let y = startY + 16;
    rows.forEach(([label, value]) => {
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#6b7280").text(label.toUpperCase(), x, y, {
        width,
      });
      doc.font("Helvetica").fontSize(9.1).fillColor("#111827").text(value || "Not specified", x, y + 10, {
        width,
        lineGap: 1.1,
      });
      y += Math.max(30, textHeight(doc, value || "Not specified", width, { size: 9.1 }) + 16);
    });
    return y;
  }

  const billToBottom = block(PAGE.marginX, "Bill To", [
    ["Customer", invoice.customerSnapshot?.fullName],
    ["Email", invoice.customerSnapshot?.email || "Not specified"],
    ["Phone", formatPhone(invoice.customerSnapshot?.phone)],
    ["Property", invoice.propertySnapshot?.formattedAddress || invoice.propertySnapshot?.address],
  ]);
  const projectBottom = block(PAGE.marginX + width + gap, "Project", [
    ["Work Type", workTypeLabel(invoice)],
    ["Project", invoice.projectSnapshot?.projectNumber],
    ["Contract", invoice.contractSnapshot?.contractNumber ? `Contract #${invoice.contractSnapshot.contractNumber}` : "Not specified"],
    ["Description", invoice.projectSnapshot?.projectDescription || "Not specified"],
  ]);
  doc.y = Math.max(billToBottom, projectBottom) + 2;
}

function drawLineItemTable(doc, invoice) {
  const tableWidth = PAGE.width - PAGE.marginX * 2;
  const widths = [tableWidth - 238, 50, 88, 100];
  const headerHeight = 24;

  function drawHeader() {
    const y = doc.y;
    doc.rect(PAGE.marginX, y, tableWidth, headerHeight).fill("#0f172a");
    doc.font("Helvetica-Bold").fontSize(7.8).fillColor("#ffffff");
    doc.text("Description", PAGE.marginX + 8, y + 8, { width: widths[0] - 16 });
    doc.text("Qty", PAGE.marginX + widths[0] + 6, y + 8, { width: widths[1] - 12, align: "right" });
    doc.text("Rate", PAGE.marginX + widths[0] + widths[1] + 6, y + 8, { width: widths[2] - 12, align: "right" });
    doc.text("Amount", PAGE.marginX + widths[0] + widths[1] + widths[2] + 6, y + 8, { width: widths[3] - 12, align: "right" });
    doc.y = y + headerHeight;
  }

  const first = invoice.lineItems?.[0] || {};
  const firstHeight = Math.max(34, textHeight(doc, first.description || "Line item", widths[0] - 16, { size: 8.8 }) + 16);
  ensureRoom(doc, headerHeight + firstHeight + 8);
  drawHeader();

  (invoice.lineItems || []).forEach((item, index) => {
    const description = item.category && item.category !== "Other"
      ? `${item.description}\n${item.category}`
      : item.description;
    const height = Math.max(34, textHeight(doc, description, widths[0] - 16, { size: 8.8, lineGap: 1 }) + 16);
    if (doc.y + height > PAGE.height - PAGE.bottom) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    doc.rect(PAGE.marginX, y, tableWidth, height).fill(index % 2 ? "#ffffff" : "#f8fafc");
    doc.font("Helvetica").fontSize(8.8).fillColor("#111827").text(description, PAGE.marginX + 8, y + 8, {
      width: widths[0] - 16,
      lineGap: 1,
    });
    doc.font("Helvetica").fontSize(8.8).text(String(item.quantity || 0), PAGE.marginX + widths[0] + 6, y + 8, {
      width: widths[1] - 12,
      align: "right",
    });
    doc.text(formatMoney(item.unitPriceCents), PAGE.marginX + widths[0] + widths[1] + 6, y + 8, {
      width: widths[2] - 12,
      align: "right",
    });
    doc.font("Helvetica-Bold").text(formatMoney(item.amountCents), PAGE.marginX + widths[0] + widths[1] + widths[2] + 6, y + 8, {
      width: widths[3] - 12,
      align: "right",
    });
    doc.y = y + height;
  });
  doc.moveDown(0.6);
}

function discountLabel(discount) {
  const name = discount.name || (discount.type === "credit" ? "Credit" : "Discount");
  if (discount.type !== "percentage") return name;
  const basisPoints = Number(discount.value || 0);
  const percent = basisPoints / 100;
  return `${name} (${percent.toFixed(3).replace(/0+$/g, "").replace(/\.$/, "")}%)`;
}

function drawSummary(doc, invoice) {
  const width = 250;
  const x = PAGE.width - PAGE.marginX - width;
  const discountTextWidth = PAGE.width - PAGE.marginX * 2 - width - 24;
  const rows = [
    ["Subtotal", formatMoney(invoice.subtotalCents)],
    ["Discounts/Credits", invoice.totalDiscountCents ? `-${formatMoney(invoice.totalDiscountCents).replace("-", "")}` : formatMoney(0)],
  ];
  if (Number(invoice.taxAmountCents || 0) > 0 || invoice.taxTreatment === "Taxable Repair / Maintenance") {
    rows.push(["Sales Tax", formatMoney(invoice.taxAmountCents)]);
  }
  rows.push(["Invoice Total", formatMoney(invoice.invoiceTotalCents)]);
  rows.push(["Payments Received", `-${formatMoney(invoice.totalPaidCents).replace("-", "")}`]);

  const discounts = (invoice.discounts || []).filter((discount) => Number(discount.calculatedAmountCents || 0) > 0);
  const discountRows = discounts.slice(0, 5).map((discount) => ({
    discount,
    text: `${discountLabel(discount)}: -${formatMoney(discount.calculatedAmountCents).replace("-", "")}`,
  }));
  const discountHeights = discountRows.map((row) =>
    Math.max(16, textHeight(doc, row.text, discountTextWidth, { size: 8.4, lineGap: 1 }) + 3)
  );
  const discountBlockHeight = discountRows.length
    ? 16 + discountHeights.reduce((sum, itemHeight) => sum + itemHeight, 0) + 8
    : 0;
  const height = 34 + rows.length * 24 + discountBlockHeight + 52;
  ensureRoom(doc, height);
  const startY = doc.y;

  if (discountRows.length) {
    doc.font("Helvetica-Bold").fontSize(8.3).fillColor("#64748b").text("Discounts and credits", PAGE.marginX, startY, {
      width: discountTextWidth,
    });
    let y = startY + 14;
    discountRows.forEach((row, index) => {
      doc.font("Helvetica").fontSize(8.4).fillColor("#374151").text(
        row.text,
        PAGE.marginX,
        y,
        { width: discountTextWidth, lineGap: 1 }
      );
      y += discountHeights[index];
    });
  }

  doc.roundedRect(x, startY, width, height - 6, 5).fillAndStroke("#f8fafc", "#dbe3ee");
  let y = startY + 14;
  rows.forEach(([label, value], index) => {
    const strong = label === "Invoice Total";
    doc.font(strong ? "Helvetica-Bold" : "Helvetica").fontSize(strong ? 9.6 : 9).fillColor("#475569").text(label, x + 14, y, {
      width: 116,
    });
    doc.font("Helvetica-Bold").fontSize(strong ? 10.4 : 9.2).fillColor("#111827").text(value, x + 128, y, {
      width: width - 142,
      align: "right",
    });
    y += index === rows.length - 1 ? 27 : 23;
  });
  doc.moveTo(x + 14, y).lineTo(x + width - 14, y).strokeColor("#cbd5e1").lineWidth(0.75).stroke();
  y += 12;
  doc.font("Helvetica-Bold").fontSize(8.3).fillColor("#64748b").text("Remaining Balance", x + 14, y, {
    width: width - 28,
  });
  doc.font("Helvetica-Bold").fontSize(Number(invoice.remainingBalanceCents || 0) > 0 ? 21 : 17).fillColor(
    Number(invoice.remainingBalanceCents || 0) > 0 ? "#111827" : "#047857"
  ).text(formatMoney(invoice.remainingBalanceCents), x + 14, y + 14, {
    width: width - 28,
    align: "right",
  });
  doc.y = startY + height;
}

function drawPaymentHistory(doc, invoice) {
  const payments = [...(invoice.payments || [])].sort((a, b) => new Date(a.paymentDate || 0) - new Date(b.paymentDate || 0));
  if (!payments.length) return;
  const tableWidth = PAGE.width - PAGE.marginX * 2;
  const widths = [95, 120, tableWidth - 315, 100];
  const headerHeight = 22;
  sectionTitle(doc, "Payment History", {
    keepWith: 52 + headerHeight + Math.min(payments.length, 3) * 29,
  });

  function drawHeader() {
    const y = doc.y;
    doc.rect(PAGE.marginX, y, tableWidth, headerHeight).fill("#eef2f7");
    doc.font("Helvetica-Bold").fontSize(7.8).fillColor("#111827");
    doc.text("Date", PAGE.marginX + 7, y + 7, { width: widths[0] - 14 });
    doc.text("Method", PAGE.marginX + widths[0] + 7, y + 7, { width: widths[1] - 14 });
    doc.text("Reference", PAGE.marginX + widths[0] + widths[1] + 7, y + 7, { width: widths[2] - 14 });
    doc.text("Amount", PAGE.marginX + widths[0] + widths[1] + widths[2] + 7, y + 7, { width: widths[3] - 14, align: "right" });
    doc.y = y + headerHeight;
  }

  drawHeader();
  payments.forEach((payment, index) => {
    const reference = payment.reference || "Not specified";
    const method = payment.method || "Other";
    const height = Math.max(
      29,
      textHeight(doc, method, widths[1] - 14, { size: 8.4, lineGap: 1 }) + 16,
      textHeight(doc, reference, widths[2] - 14, { size: 8.4, lineGap: 1 }) + 16
    );
    if (doc.y + height > PAGE.height - PAGE.bottom) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    doc.rect(PAGE.marginX, y, tableWidth, height).fill(index % 2 ? "#ffffff" : "#fafafa");
    doc.font("Helvetica").fontSize(8.4).fillColor("#111827");
    doc.text(compactDate(payment.paymentDate), PAGE.marginX + 7, y + 8, { width: widths[0] - 14 });
    doc.text(method, PAGE.marginX + widths[0] + 7, y + 8, { width: widths[1] - 14, lineGap: 1 });
    doc.text(reference, PAGE.marginX + widths[0] + widths[1] + 7, y + 8, { width: widths[2] - 14, lineGap: 1 });
    doc.font("Helvetica-Bold").text(formatMoney(payment.amountCents), PAGE.marginX + widths[0] + widths[1] + widths[2] + 7, y + 8, {
      width: widths[3] - 14,
      align: "right",
    });
    doc.y = y + height;
  });
  doc.moveDown(0.55);
}

function drawNotesAndInstructions(doc, invoice) {
  if (invoice.publicNote) {
    sectionTitle(doc, "Note", { keepWith: 64 });
    drawParagraph(doc, cleanLines(invoice.publicNote), { size: 9.1, lineGap: 1.6 });
  }
  if (invoice.paymentInstructions) {
    sectionTitle(doc, "Payment Instructions", { keepWith: 64 });
    drawParagraph(doc, cleanLines(invoice.paymentInstructions), { size: 9.1, lineGap: 1.6 });
  }
}

function addFooter(doc, invoice) {
  const range = doc.bufferedPageRange();
  const label = invoiceDisplayLabel(invoice);
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.save();
    const originalMargins = { ...doc.page.margins };
    doc.page.margins.top = 0;
    doc.page.margins.bottom = 0;
    doc
      .moveTo(PAGE.marginX, PAGE.height - 43)
      .lineTo(PAGE.width - PAGE.marginX, PAGE.height - 43)
      .strokeColor("#e5e7eb")
      .lineWidth(0.75)
      .stroke();
    doc.font("Helvetica").fontSize(8).fillColor("#6b7280");
    doc.text(COMPANY_INFO.legalName, PAGE.marginX, PAGE.height - 31, {
      width: 190,
      lineBreak: false,
    });
    doc.text(label, PAGE.marginX + 200, PAGE.height - 31, {
      width: 120,
      align: "center",
      lineBreak: false,
    });
    doc.text(`Page ${i + 1} of ${range.count}`, PAGE.width - PAGE.marginX - 100, PAGE.height - 31, {
      width: 100,
      align: "right",
      lineBreak: false,
    });
    doc.page.margins.top = originalMargins.top;
    doc.page.margins.bottom = originalMargins.bottom;
    doc.page.margins.left = originalMargins.left;
    doc.page.margins.right = originalMargins.right;
    doc.restore();
  }
}

async function generateInvoicePdfBuffer(invoice) {
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
        Title: `${invoiceDisplayLabel(invoice)} Premium Island Homes Invoice`,
        Author: COMPANY_INFO.legalName,
        Subject: "Invoice",
      },
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    drawFirstPageHeader(doc, invoice);
    drawStatusBadge(doc, invoice);
    sectionTitle(doc, "Customer and Project", { topGap: 0, keepWith: 118 });
    drawInfoBlocks(doc, invoice);
    sectionTitle(doc, "Invoice Items", { keepWith: 96 });
    drawLineItemTable(doc, invoice);
    drawSummary(doc, invoice);
    drawPaymentHistory(doc, invoice);
    drawNotesAndInstructions(doc, invoice);
    addFooter(doc, invoice);
    doc.end();
  });
}

module.exports = {
  buildInvoiceFilename,
  generateInvoicePdfBuffer,
};
