const PDFDocument = require("pdfkit");
const {
  CANCELLATION_NOTICE_CONFIG,
  COMPANY_INFO,
  CONTRACT_TERMS_SECTIONS,
} = require("../config/premiumIslandHomesContract");
const {
  buildContractFilename,
  formatMoney,
  normalizeComparableText,
} = require("./contractValidation");

const PAGE = {
  width: 612,
  height: 792,
  marginX: 54,
  top: 54,
  bottom: 62,
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

function customerLastName(contract) {
  const parts = String(contract.customerSnapshot?.fullName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "Customer";
}

function formatPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const normalized =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (normalized.length !== 10) return value || "Not specified";
  return `(${normalized.slice(0, 3)}) ${normalized.slice(3, 6)}-${normalized.slice(6)}`;
}

function cleanLines(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function ensureRoom(doc, height = 80) {
  if (doc.y + height > PAGE.height - PAGE.bottom) {
    doc.addPage();
  }
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
  ensureRoom(doc, options.keepWith || 62);
  doc.moveDown(options.topGap ?? 0.7);
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#111827").text(title.toUpperCase(), {
    characterSpacing: 0.2,
  });
  doc.moveDown(0.25);
  rule(doc);
  doc.moveDown(0.45);
}

function textHeight(doc, text, width, options = {}) {
  doc.font(options.font || "Helvetica").fontSize(options.size || 9.5);
  return doc.heightOfString(text || " ", {
    width,
    lineGap: options.lineGap ?? 2,
  });
}

function drawParagraph(doc, text, options = {}) {
  const width = options.width || PAGE.width - PAGE.marginX * 2;
  const x = options.x || PAGE.marginX;
  const size = options.size || 9.5;
  const lineGap = options.lineGap ?? 2;
  const font = options.font || "Helvetica";
  const color = options.color || "#374151";
  const height = textHeight(doc, text, width, { font, size, lineGap }) + 4;
  ensureRoom(doc, height);
  doc.font(font).fontSize(size).fillColor(color).text(text || "Not specified", x, doc.y, {
    width,
    lineGap,
  });
  doc.moveDown(options.after ?? 0.35);
}

function drawStructuredText(doc, text, options = {}) {
  const width = options.width || PAGE.width - PAGE.marginX * 2;
  const baseX = options.x || PAGE.marginX;
  const size = options.size || 9.5;
  const color = options.color || "#374151";
  const blocks = cleanLines(text)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (!blocks.length) {
    drawParagraph(doc, "Not specified", options);
    return;
  }

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const allListItems = lines.length > 1 && lines.every((line) => /^([-*]|\d+[.)])\s+/.test(line));
    if (!allListItems) {
      drawParagraph(doc, block.replace(/\n/g, "\n"), { ...options, width, x: baseX, size, color });
      continue;
    }

    for (const line of lines) {
      const match = line.match(/^([-*]|\d+[.)])\s+(.*)$/);
      const marker = match?.[1] || "-";
      const body = match?.[2] || line;
      const markerWidth = 22;
      const bodyWidth = width - markerWidth;
      const height = Math.max(
        14,
        textHeight(doc, body, bodyWidth, { size, lineGap: 2 })
      ) + 4;
      ensureRoom(doc, height);
      const y = doc.y;
      doc.font("Helvetica").fontSize(size).fillColor(color).text(marker, baseX, y, {
        width: markerWidth - 4,
      });
      doc.font("Helvetica").fontSize(size).fillColor(color).text(body, baseX + markerWidth, y, {
        width: bodyWidth,
        lineGap: 2,
      });
      doc.y = y + height;
    }
    doc.moveDown(0.15);
  }
}

function drawKeyValueTable(doc, rows) {
  const colGap = 18;
  const colWidth = (PAGE.width - PAGE.marginX * 2 - colGap) / 2;
  rows.forEach((row, index) => {
    if (index % 2 === 0) ensureRoom(doc, 42);
    const pairIndex = index % 2;
    const x = PAGE.marginX + pairIndex * (colWidth + colGap);
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#6b7280").text(row.label.toUpperCase(), x, y, {
      width: colWidth,
    });
    doc.font("Helvetica").fontSize(10).fillColor("#111827").text(row.value || "Not specified", x, y + 12, {
      width: colWidth,
      lineGap: 1.5,
    });
    if (pairIndex === 1 || index === rows.length - 1) {
      doc.y = y + Math.max(34, doc.heightOfString(row.value || "Not specified", { width: colWidth }) + 16);
      doc.moveDown(0.35);
    }
  });
}

function drawFirstPageHeader(doc, contract) {
  const leftWidth = 320;
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111827").text("PREMIUM ISLAND HOMES INC.", PAGE.marginX, PAGE.top, {
    width: leftWidth,
  });
  doc.moveDown(0.25);
  doc.font("Helvetica-Bold").fontSize(19).fillColor("#111827").text("HOME IMPROVEMENT AGREEMENT", {
    width: leftWidth,
  });
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(8.7).fillColor("#4b5563").text(
    `${COMPANY_INFO.addressLines.join(", ")} | ${COMPANY_INFO.phone} | ${COMPANY_INFO.email} | ${COMPANY_INFO.website} | License ${COMPANY_INFO.homeImprovementLicense}`,
    {
      width: PAGE.width - PAGE.marginX * 2,
      lineGap: 1.5,
    }
  );

  const boxX = PAGE.width - PAGE.marginX - 170;
  const boxY = PAGE.top;
  doc.roundedRect(boxX, boxY, 170, 70, 4).strokeColor("#d1d5db").lineWidth(0.75).stroke();
  doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text("Contract No.", boxX + 12, boxY + 10, {
    width: 70,
  });
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#111827").text(contract.contractNumber, boxX + 82, boxY + 10, {
    width: 76,
    align: "right",
  });
  doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text("Version", boxX + 12, boxY + 30, {
    width: 70,
  });
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#111827").text(String(contract.version || 1), boxX + 82, boxY + 30, {
    width: 76,
    align: "right",
  });
  doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text("Contract date", boxX + 12, boxY + 50, {
    width: 70,
  });
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#111827").text(formatDate(contract.dates?.contractDate), boxX + 82, boxY + 50, {
    width: 76,
    align: "right",
  });

  doc.y = PAGE.top + 98;
  rule(doc, "#cbd5e1");
  doc.moveDown(0.6);
}

function drawPriceSummary(doc, contract) {
  const cardWidth = PAGE.width - PAGE.marginX * 2;
  ensureRoom(doc, 95);
  const startY = doc.y;
  doc.roundedRect(PAGE.marginX, startY, cardWidth, 82, 5).fill("#f8fafc");
  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(8.5).text("TOTAL CONTRACT PRICE", PAGE.marginX + 14, startY + 14, {
    width: 170,
  });
  doc.font("Helvetica-Bold").fontSize(18).text(formatMoney(contract.totalPriceCents), PAGE.marginX + 14, startY + 30, {
    width: 170,
  });

  const columns = [
    ["Deposit", formatMoney(contract.depositAmountCents)],
    ["Remaining balance", formatMoney(contract.remainingBalanceCents)],
  ];
  columns.forEach(([label, value], index) => {
    const x = PAGE.marginX + 220 + index * 135;
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#64748b").text(label.toUpperCase(), x, startY + 22, {
      width: 120,
    });
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#111827").text(value, x, startY + 39, {
      width: 120,
    });
  });
  doc.y = startY + 95;
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

function drawPaymentRows(doc, rows) {
  const x = PAGE.marginX;
  const widths = [160, 100, PAGE.width - PAGE.marginX * 2 - 260];
  const tableWidth = PAGE.width - PAGE.marginX * 2;
  const headerHeight = 22;

  function rowHeight(row) {
    return Math.max(
      32,
      textHeight(doc, row.label || "", widths[0] - 14, { size: 8.8 }) + 16,
      textHeight(doc, formatMoney(row.amountCents), widths[1] - 14, { size: 8.8, font: "Helvetica-Bold" }) + 16,
      textHeight(doc, row.dueCondition || "", widths[2] - 14, { size: 8.8 }) + 16
    );
  }

  function drawHeader() {
    const headerY = doc.y;
    doc.rect(x, headerY, tableWidth, headerHeight).fill("#eef2f7");
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(8.3);
    doc.text("Milestone", x + 7, headerY + 7, { width: widths[0] - 14 });
    doc.text("Amount", x + widths[0] + 7, headerY + 7, { width: widths[1] - 14 });
    doc.text("Due condition", x + widths[0] + widths[1] + 7, headerY + 7, {
      width: widths[2] - 14,
    });
    doc.y = headerY + headerHeight;
  }

  const firstHeight = rows.length ? rowHeight(rows[0]) : 0;
  ensureRoom(doc, headerHeight + firstHeight + 8);
  drawHeader();

  rows.forEach((row, index) => {
    const height = rowHeight(row);
    if (doc.y + height > PAGE.height - PAGE.bottom) {
      doc.addPage();
      drawHeader();
    }
    const rowY = doc.y;
    doc.rect(x, rowY, tableWidth, height).fill(index % 2 ? "#ffffff" : "#fafafa");
    doc.fillColor("#111827").font("Helvetica").fontSize(8.8);
    doc.text(row.label, x + 7, rowY + 8, { width: widths[0] - 14, lineGap: 1.5 });
    doc.font("Helvetica-Bold").text(formatMoney(row.amountCents), x + widths[0] + 7, rowY + 8, {
      width: widths[1] - 14,
    });
    doc.font("Helvetica").text(row.dueCondition, x + widths[0] + widths[1] + 7, rowY + 8, {
      width: widths[2] - 14,
      lineGap: 1.5,
    });
    doc.y = rowY + height;
  });
  doc.moveDown(0.8);
}

function descriptionShouldRender(contract) {
  const description = normalizeComparableText(contract.projectDescription);
  const scope = normalizeComparableText(contract.scopeText);
  return description && description !== scope;
}

function truncatedDescription(text) {
  const blocks = cleanLines(text)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .slice(0, 2);
  return blocks.join("\n\n");
}

function drawTerms(doc, options = {}) {
  sectionTitle(doc, "Terms and Notices", { keepWith: 92 });
  const notice = {
    ...CANCELLATION_NOTICE_CONFIG,
    ...(options.cancellationNoticeConfig || {}),
  };
  if (typeof options.includeCancellationNotice === "boolean") {
    notice.includeCancellationNotice = options.includeCancellationNotice;
  }
  const sections = [
    ...CONTRACT_TERMS_SECTIONS,
    ...(notice.includeCancellationNotice ? [{ title: notice.title, body: notice.body }] : []),
  ];

  sections.forEach((section) => {
    const bodyWidth = PAGE.width - PAGE.marginX * 2;
    const headingHeight = textHeight(doc, section.title, bodyWidth, {
      font: "Helvetica-Bold",
      size: 8,
    });
    const bodyPreview = String(section.body || "").split(/\s+/).slice(0, 18).join(" ");
    const previewHeight = textHeight(doc, bodyPreview, bodyWidth, { size: 7.4 });
    ensureRoom(doc, headingHeight + previewHeight + 18);
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#111827").text(section.title, PAGE.marginX, doc.y, {
      width: bodyWidth,
      lineGap: 0.4,
    });
    doc.moveDown(0.05);
    drawParagraph(doc, section.body, {
      size: 7.4,
      color: "#374151",
      after: 0.08,
      lineGap: 0.35,
    });
  });
}

function drawSignatureLine(doc, label, nameText = "") {
  const startY = doc.y;
  const colWidth = 150;
  const gap = 22;
  const columns = [
    ["Printed name", nameText],
    ["Signature", ""],
    ["Date", ""],
  ];
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#111827").text(label, PAGE.marginX, startY, {
    width: PAGE.width - PAGE.marginX * 2,
  });
  const lineY = startY + 42;
  columns.forEach(([caption, value], index) => {
    const x = PAGE.marginX + index * (colWidth + gap);
    if (value) {
      doc.font("Helvetica").fontSize(10).fillColor("#111827").text(value, x, lineY - 18, {
        width: colWidth,
      });
    }
    doc.moveTo(x, lineY).lineTo(x + colWidth, lineY).strokeColor("#9ca3af").lineWidth(0.75).stroke();
    doc.font("Helvetica").fontSize(8.5).fillColor("#6b7280").text(caption, x, lineY + 7, {
      width: colWidth,
    });
  });
  doc.y = lineY + 48;
}

function drawSignaturePage(doc, contract) {
  doc.addPage();
  sectionTitle(doc, "Signature Page", { topGap: 0, keepWith: 120 });
  drawParagraph(
    doc,
    "By signing below, the parties acknowledge that they have reviewed and accepted the project description, scope of work, contract price, payment schedule, and terms of this agreement, and that the customer has received a copy of the agreement.",
    { size: 10, color: "#374151", lineGap: 2.5, after: 1.4 }
  );
  drawSignatureLine(doc, "Customer 1", contract.customerSnapshot?.fullName || "");
  doc.moveDown(0.85);
  drawSignatureLine(doc, "Customer 2 - Optional");
  doc.moveDown(0.85);
  drawSignatureLine(doc, "Contractor", `${COMPANY_INFO.legalName}\n${COMPANY_INFO.projectManager}, Project Manager`);
}

function addFooter(doc, contract) {
  const range = doc.bufferedPageRange();
  const last = customerLastName(contract);
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.save();
    const originalMargins = { ...doc.page.margins };
    doc.page.margins.top = 0;
    doc.page.margins.bottom = 0;
    doc
      .moveTo(PAGE.marginX, PAGE.height - 45)
      .lineTo(PAGE.width - PAGE.marginX, PAGE.height - 45)
      .strokeColor("#e5e7eb")
      .lineWidth(0.75)
      .stroke();
    doc.font("Helvetica").fontSize(8).fillColor("#6b7280");
    doc.text(`Contract ${contract.contractNumber} | ${last}`, PAGE.marginX, PAGE.height - 32, {
      width: 260,
      lineBreak: false,
    });
    doc.text(`Page ${i + 1} of ${range.count}`, PAGE.marginX, PAGE.height - 32, {
      width: PAGE.width - PAGE.marginX * 2,
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

async function generateContractPdfBuffer(contract, options = {}) {
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
        Title: `${contract.contractNumber} Premium Island Homes Agreement`,
        Author: COMPANY_INFO.legalName,
        Subject: "Home improvement agreement",
      },
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    drawFirstPageHeader(doc, contract);

    sectionTitle(doc, "Customer and Property", { topGap: 0, keepWith: 95 });
    drawKeyValueTable(doc, [
      { label: "Customer", value: contract.customerSnapshot?.fullName },
      { label: "Email", value: contract.customerSnapshot?.email || "Not specified" },
      { label: "Phone", value: formatPhone(contract.customerSnapshot?.phone) },
      { label: "Property address", value: contract.propertySnapshot?.address },
      { label: "Work type", value: workTypeLabel(contract) },
      { label: "Contract date", value: formatDate(contract.dates?.contractDate) },
    ]);

    if (descriptionShouldRender(contract)) {
      sectionTitle(doc, "Project Description", { keepWith: 85 });
      drawStructuredText(doc, truncatedDescription(contract.projectDescription), {
        size: 9.7,
        color: "#374151",
      });
    }

    sectionTitle(doc, "Scope of Work", { keepWith: 95 });
    drawStructuredText(doc, contract.scopeText, {
      size: 9.5,
      color: "#374151",
    });

    sectionTitle(doc, "Price and Payment", { keepWith: 140 });
    drawPriceSummary(doc, contract);
    doc.font("Helvetica-Bold").fontSize(9.8).fillColor("#111827").text("Payment Schedule", PAGE.marginX, doc.y, {
      width: PAGE.width - PAGE.marginX * 2,
    });
    doc.moveDown(0.35);
    drawPaymentRows(doc, paymentScheduleForContract(contract));

    sectionTitle(doc, "Project Dates", { keepWith: 70 });
    drawKeyValueTable(doc, [
      { label: "Estimated start", value: formatDate(contract.dates?.estimatedStartDate) },
      { label: "Estimated completion", value: formatDate(contract.dates?.estimatedCompletionDate) },
    ]);

    const details = contract.optionalDetails || {};
    if (
      details.materialsAllowances ||
      details.exclusions ||
      details.permitResponsibility ||
      details.specialInstructions ||
      details.additionalNotes
    ) {
      sectionTitle(doc, "Additional Details", { keepWith: 90 });
      [
        ["Materials and Allowances", details.materialsAllowances],
        ["Exclusions", details.exclusions],
        ["Permit Responsibility", details.permitResponsibility],
        ["Special Customer Instructions", details.specialInstructions],
        ["Notes", details.additionalNotes],
      ].forEach(([title, body]) => {
        if (!body) return;
        ensureRoom(doc, 55);
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#111827").text(title, PAGE.marginX, doc.y, {
          width: PAGE.width - PAGE.marginX * 2,
        });
        doc.moveDown(0.15);
        drawStructuredText(doc, body, { size: 8.9, color: "#374151" });
      });
    }

    drawTerms(doc, options);
    drawSignaturePage(doc, contract);
    addFooter(doc, contract);
    doc.end();
  });
}

module.exports = {
  buildContractFilename,
  generateContractPdfBuffer,
};
