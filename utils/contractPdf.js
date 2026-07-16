const PDFDocument = require("pdfkit");
const {
  CANCELLATION_NOTICE_CONFIG,
  COMPANY_INFO,
  CONTRACT_TERMS_SECTIONS,
} = require("../config/premiumIslandHomesContract");
const {
  buildContractFilename,
  contractDisplayLabel,
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

function formatPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const normalized =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (normalized.length !== 10) return value || "Not specified";
  return `(${normalized.slice(0, 3)}) ${normalized.slice(3, 6)}-${normalized.slice(6)}`;
}

function originalContractPriceCents(contract) {
  return Number(contract.originalContractPriceCents ?? contract.totalPriceCents ?? 0);
}

function discountRowsForContract(contract) {
  return Array.isArray(contract.discounts)
    ? contract.discounts
        .filter((discount) => Number(discount.calculatedAmountCents || 0) > 0)
        .slice()
        .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    : [];
}

function totalDiscountAmountCents(contract) {
  const configured = Number(contract.totalDiscountAmountCents || 0);
  if (configured > 0) return configured;
  return discountRowsForContract(contract).reduce(
    (sum, discount) => sum + Number(discount.calculatedAmountCents || 0),
    0
  );
}

function adjustedContractPriceCents(contract) {
  if (contract.adjustedContractPriceCents !== undefined && contract.adjustedContractPriceCents !== null) {
    return Number(contract.adjustedContractPriceCents || 0);
  }
  return Math.max(originalContractPriceCents(contract) - totalDiscountAmountCents(contract), 0);
}

function formatBasisPoints(value) {
  const basisPoints = Number(value || 0);
  const whole = Math.floor(basisPoints / 100);
  const fraction = basisPoints % 100;
  if (!fraction) return `${whole}%`;
  return `${whole}.${String(fraction).padStart(2, "0").replace(/0+$/g, "")}%`;
}

function discountDisplayName(discount) {
  const name = String(discount.name || "Discount").trim() || "Discount";
  if (discount.type === "percentage") {
    return `${name} (${formatBasisPoints(discount.value)})`;
  }
  return name;
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

function parseListLine(line) {
  const match = String(line || "").match(/^([-*]|\u2022|\d+[.)])\s+(.*)$/);
  if (!match) return null;
  const rawMarker = match[1];
  const marker = /^[-*]$/.test(rawMarker) || rawMarker === "\u2022"
    ? "\u2022"
    : rawMarker.replace(/\)$/, ".");
  return { marker, body: match[2] || "" };
}

function drawListItem(doc, marker, body, options = {}) {
  const width = options.width || PAGE.width - PAGE.marginX * 2;
  const baseX = options.x || PAGE.marginX;
  const size = options.size || 9.5;
  const color = options.color || "#374151";
  const markerWidth = /^\d/.test(marker) ? 26 : 20;
  const bodyWidth = width - markerWidth;
  const height = Math.max(
    16,
    textHeight(doc, body, bodyWidth, { size, lineGap: options.lineGap ?? 2 })
  ) + 4;
  ensureRoom(doc, height);
  const y = doc.y;
  doc.font("Helvetica").fontSize(size).fillColor(color).text(marker, baseX, y, {
    width: markerWidth - 4,
  });
  doc.font("Helvetica").fontSize(size).fillColor(color).text(body, baseX + markerWidth, y, {
    width: bodyWidth,
    lineGap: options.lineGap ?? 2,
  });
  doc.y = y + height;
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
    let paragraphLines = [];

    function flushParagraph() {
      if (!paragraphLines.length) return;
      drawParagraph(doc, paragraphLines.join("\n"), {
        ...options,
        width,
        x: baseX,
        size,
        color,
      });
      paragraphLines = [];
    }

    for (const line of lines) {
      const listLine = parseListLine(line);
      if (!listLine) {
        paragraphLines.push(line);
        continue;
      }
      flushParagraph();
      drawListItem(doc, listLine.marker, listLine.body, { ...options, width, x: baseX, size, color });
    }
    flushParagraph();
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

function drawCompactInfoGrid(doc, rows) {
  const colGap = 14;
  const columns = 3;
  const colWidth = (PAGE.width - PAGE.marginX * 2 - colGap * (columns - 1)) / columns;

  for (let index = 0; index < rows.length; index += columns) {
    const group = rows.slice(index, index + columns);
    const groupHeight = Math.max(
      36,
      ...group.map((row) =>
        textHeight(doc, row.value || "Not specified", colWidth, {
          size: 9.3,
          lineGap: 1.2,
        }) + 16
      )
    );
    ensureRoom(doc, groupHeight + 6);
    const y = doc.y;
    group.forEach((row, groupIndex) => {
      const x = PAGE.marginX + groupIndex * (colWidth + colGap);
      doc.font("Helvetica-Bold").fontSize(7.4).fillColor("#6b7280").text(row.label.toUpperCase(), x, y, {
        width: colWidth,
      });
      doc.font("Helvetica").fontSize(9.3).fillColor("#111827").text(row.value || "Not specified", x, y + 11, {
        width: colWidth,
        lineGap: 1.2,
      });
    });
    doc.y = y + groupHeight;
    doc.moveDown(0.2);
  }
}

function drawFirstPageHeader(doc, contract) {
  const rightWidth = 145;
  const leftWidth = PAGE.width - PAGE.marginX * 2 - rightWidth - 24;

  doc.font("Helvetica-Bold").fontSize(24).fillColor("#111827").text("HOME IMPROVEMENT AGREEMENT", PAGE.marginX, PAGE.top, {
    width: leftWidth,
    lineGap: 1,
  });
  doc.moveDown(0.22);
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#111827").text(COMPANY_INFO.legalName, {
    width: leftWidth,
  });
  doc.moveDown(0.18);
  doc.font("Helvetica").fontSize(8.3).fillColor("#4b5563").text(
    `${COMPANY_INFO.addressLines.join(" | ")} | ${COMPANY_INFO.phone}`,
    {
      width: leftWidth,
      lineGap: 1,
    }
  );
  doc.font("Helvetica").fontSize(8.3).fillColor("#4b5563").text(
    `${COMPANY_INFO.email} | ${COMPANY_INFO.website} | ${COMPANY_INFO.homeImprovementLicense}`,
    {
      width: leftWidth,
      lineGap: 1,
    }
  );
  const companyInfoBottomY = doc.y;

  const rightX = PAGE.width - PAGE.marginX - rightWidth;
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827").text(contractDisplayLabel(contract), rightX, PAGE.top + 2, {
    width: rightWidth,
    align: "right",
  });
  doc.font("Helvetica").fontSize(8.5).fillColor("#6b7280").text("Contract Date", rightX, PAGE.top + 24, {
    width: rightWidth,
    align: "right",
  });
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#111827").text(formatDate(contract.dates?.contractDate), rightX, PAGE.top + 36, {
    width: rightWidth,
    align: "right",
    lineGap: 1,
  });
  const contractMetaBottomY = doc.y;

  const dividerPadding = 8;
  doc.y = Math.max(companyInfoBottomY, contractMetaBottomY, PAGE.top + 76) + dividerPadding;
  rule(doc, "#cbd5e1");
  doc.y += dividerPadding;
}

function drawPriceSummary(doc, contract) {
  const cardWidth = PAGE.width - PAGE.marginX * 2;
  const original = originalContractPriceCents(contract);
  const discounts = discountRowsForContract(contract);
  const totalDiscount = totalDiscountAmountCents(contract);
  const adjusted = adjustedContractPriceCents(contract);
  const deposit = Number(contract.depositAmountCents || 0);
  const remaining = Math.max(adjusted - deposit, 0);

  ensureRoom(doc, discounts.length ? 150 : 112);
  const startY = doc.y;
  const cardHeight = 106;
  doc.roundedRect(PAGE.marginX, startY, cardWidth, cardHeight, 5).fillAndStroke("#f8fafc", "#dbe3ee");
  doc.fillColor("#64748b").font("Helvetica-Bold").fontSize(8.5).text(
    "Final Contract Price",
    PAGE.marginX + 14,
    startY + 14,
    {
      width: 190,
    }
  );
  doc.font("Helvetica-Bold").fontSize(27).fillColor("#111827").text(formatMoney(adjusted), PAGE.marginX + 14, startY + 29, {
    width: 205,
  });

  const rows = [
    ["Original Price", formatMoney(original)],
    ["Discounts", totalDiscount > 0 ? `-${formatMoney(totalDiscount).replace("-", "")}` : formatMoney(0)],
    ["Deposit", formatMoney(deposit)],
    ["Remaining Balance", formatMoney(remaining)],
  ];
  rows.forEach(([label, value], index) => {
    const x = PAGE.marginX + 250 + (index % 2) * 118;
    const y = startY + 18 + Math.floor(index / 2) * 40;
    doc.font("Helvetica-Bold").fontSize(7.8).fillColor("#64748b").text(label.toUpperCase(), x, y, {
      width: 110,
    });
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827").text(value, x, y + 14, {
      width: 110,
    });
  });
  doc.y = startY + cardHeight + 14;

  if (!discounts.length) return;

  if (discounts.length === 1) {
    const discount = discounts[0];
    const rowHeight = Math.max(
      34,
      textHeight(doc, discountDisplayName(discount), cardWidth - 130, { size: 9 }) + 16
    );
    ensureRoom(doc, rowHeight + 24);
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#111827").text("Discount", PAGE.marginX, doc.y, {
      width: cardWidth,
    });
    doc.moveDown(0.25);
    const rowY = doc.y;
    doc.rect(PAGE.marginX, rowY, cardWidth, rowHeight).fill("#ffffff");
    doc.moveTo(PAGE.marginX, rowY).lineTo(PAGE.marginX + cardWidth, rowY).strokeColor("#e5e7eb").lineWidth(0.75).stroke();
    doc.moveTo(PAGE.marginX, rowY + rowHeight).lineTo(PAGE.marginX + cardWidth, rowY + rowHeight).stroke();
    doc.font("Helvetica").fontSize(9).fillColor("#111827").text(discountDisplayName(discount), PAGE.marginX + 8, rowY + 10, {
      width: cardWidth - 130,
      lineGap: 1.2,
    });
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#111827").text(
      `-${formatMoney(discount.calculatedAmountCents).replace("-", "")}`,
      PAGE.marginX + cardWidth - 112,
      rowY + 10,
      {
        width: 104,
        align: "right",
      }
    );
    doc.y = rowY + rowHeight + 14;
    return;
  }

  const widths = [cardWidth - 220, 95, 125];
  const headerHeight = 22;
  const firstDiscount = discounts[0] || {};
  const firstRowHeight = Math.max(
    30,
    textHeight(doc, discountDisplayName(firstDiscount), widths[0] - 14, { size: 8.7 }) + 14,
    textHeight(doc, String(firstDiscount.note || "") || " ", widths[2] - 14, { size: 8.4 }) + 14
  );
  ensureRoom(doc, headerHeight + firstRowHeight + 32);

  doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#111827").text("Discount Breakdown", PAGE.marginX, doc.y, {
    width: cardWidth,
  });
  doc.moveDown(0.25);

  ensureRoom(doc, headerHeight + 36);
  const headerY = doc.y;
  doc.rect(PAGE.marginX, headerY, cardWidth, headerHeight).fill("#eef2f7");
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#111827");
  doc.text("Discount", PAGE.marginX + 7, headerY + 6, { width: widths[0] - 14 });
  doc.text("Amount", PAGE.marginX + widths[0] + 7, headerY + 6, { width: widths[1] - 14 });
  doc.text("Note", PAGE.marginX + widths[0] + widths[1] + 7, headerY + 6, {
    width: widths[2] - 14,
  });
  doc.y = headerY + headerHeight;

  discounts.forEach((discount, index) => {
    const note = String(discount.note || "");
    const height = Math.max(
      30,
      textHeight(doc, discountDisplayName(discount), widths[0] - 14, { size: 8.7 }) + 14,
      textHeight(doc, note || " ", widths[2] - 14, { size: 8.4 }) + 14
    );
    if (doc.y + height > PAGE.height - PAGE.bottom) {
      doc.addPage();
    }
    const rowY = doc.y;
    doc.rect(PAGE.marginX, rowY, cardWidth, height).fill(index % 2 ? "#ffffff" : "#fafafa");
    doc.font("Helvetica").fontSize(8.7).fillColor("#111827").text(discountDisplayName(discount), PAGE.marginX + 7, rowY + 7, {
      width: widths[0] - 14,
      lineGap: 1.2,
    });
    doc.font("Helvetica-Bold").text(`-${formatMoney(discount.calculatedAmountCents).replace("-", "")}`, PAGE.marginX + widths[0] + 7, rowY + 7, {
      width: widths[1] - 14,
      align: "right",
    });
    doc.font("Helvetica").fontSize(8.4).text(note, PAGE.marginX + widths[0] + widths[1] + 7, rowY + 7, {
      width: widths[2] - 14,
      lineGap: 1.2,
    });
    doc.y = rowY + height;
  });

  ensureRoom(doc, 52);
  const totalY = doc.y;
  doc.rect(PAGE.marginX, totalY, cardWidth, 42).fill("#f8fafc");
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#64748b").text("TOTAL DISCOUNTS", PAGE.marginX + 7, totalY + 8, {
    width: 150,
  });
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827").text(`-${formatMoney(totalDiscount).replace("-", "")}`, PAGE.marginX + 7, totalY + 22, {
    width: 150,
  });
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#64748b").text("REMAINING BALANCE", PAGE.marginX + 210, totalY + 8, {
    width: 140,
  });
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827").text(formatMoney(remaining), PAGE.marginX + 210, totalY + 22, {
    width: 140,
  });
  doc.y = totalY + 56;
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
      amountCents: Math.max(adjustedContractPriceCents(contract) - Number(contract.depositAmountCents || 0), 0),
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
  sectionTitle(doc, "Terms", { keepWith: 92 });
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
      size: 8.4,
    });
    const bodyPreview = String(section.body || "").split(/\s+/).slice(0, 18).join(" ");
    const previewHeight = textHeight(doc, bodyPreview, bodyWidth, { size: 7.7 });
    ensureRoom(doc, headingHeight + previewHeight + 18);
    doc.font("Helvetica-Bold").fontSize(8.4).fillColor("#111827").text(section.title, PAGE.marginX, doc.y, {
      width: bodyWidth,
      lineGap: 0.4,
    });
    doc.moveDown(0.05);
    drawParagraph(doc, section.body, {
      size: 7.7,
      color: "#374151",
      after: 0.08,
      lineGap: 0.6,
    });
  });
}

function secondCustomerName(contract) {
  const snapshot = contract.customerSnapshot || {};
  return (
    snapshot.secondFullName ||
    snapshot.secondaryFullName ||
    snapshot.customer2Name ||
    snapshot.coCustomerName ||
    contract.secondCustomerName ||
    contract.secondaryCustomerName ||
    ""
  );
}

function drawSignatureBlock(doc, title, printedName = "") {
  const blockWidth = PAGE.width - PAGE.marginX * 2;
  const startY = doc.y;
  const lineWidth = blockWidth;
  const printedHeight = printedName
    ? textHeight(doc, printedName, lineWidth, { font: "Helvetica", size: 10.5, lineGap: 1.3 })
    : 0;
  const blockHeight = 142 + Math.max(0, printedHeight - 14);
  ensureRoom(doc, blockHeight + 12);

  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111827").text(title, PAGE.marginX, startY, {
    width: blockWidth,
  });

  const printedLineY = startY + 48 + Math.max(0, printedHeight - 14);
  if (printedName) {
    doc.font("Helvetica").fontSize(10.5).fillColor("#111827").text(printedName, PAGE.marginX, printedLineY - printedHeight - 7, {
      width: lineWidth,
      lineGap: 1.3,
    });
  }
  doc.moveTo(PAGE.marginX, printedLineY).lineTo(PAGE.marginX + lineWidth, printedLineY).strokeColor("#9ca3af").lineWidth(0.8).stroke();
  doc.font("Helvetica").fontSize(8.7).fillColor("#6b7280").text("Printed Name", PAGE.marginX, printedLineY + 7, {
    width: lineWidth,
  });

  const signatureLineY = printedLineY + 48;
  doc.moveTo(PAGE.marginX, signatureLineY).lineTo(PAGE.marginX + lineWidth, signatureLineY).strokeColor("#9ca3af").lineWidth(0.8).stroke();
  doc.font("Helvetica").fontSize(8.7).fillColor("#6b7280").text("Signature", PAGE.marginX, signatureLineY + 7, {
    width: lineWidth,
  });

  const dateLineWidth = 190;
  const dateLineY = signatureLineY + 48;
  doc.moveTo(PAGE.marginX, dateLineY).lineTo(PAGE.marginX + dateLineWidth, dateLineY).strokeColor("#9ca3af").lineWidth(0.8).stroke();
  doc.font("Helvetica").fontSize(8.7).fillColor("#6b7280").text("Date", PAGE.marginX, dateLineY + 7, {
    width: dateLineWidth,
  });

  doc.y = dateLineY + 38;
}

function drawSignaturePage(doc, contract) {
  doc.addPage();
  doc.font("Helvetica-Bold").fontSize(22).fillColor("#111827").text("Accepted and Agreed", PAGE.marginX, PAGE.top, {
    width: PAGE.width - PAGE.marginX * 2,
  });
  doc.y = PAGE.top + 36;
  rule(doc, "#cbd5e1");
  doc.moveDown(0.8);
  drawParagraph(
    doc,
    "By signing below, the parties acknowledge that they have reviewed and accepted the project description, scope of work, pricing, listed discounts if any, payment schedule, and terms of this agreement, and that the customer has received a copy of the agreement.",
    { size: 10, color: "#374151", lineGap: 2.4, after: 1.2 }
  );
  drawSignatureBlock(doc, "Customer", contract.customerSnapshot?.fullName || "");
  const secondaryName = secondCustomerName(contract);
  if (secondaryName) {
    doc.moveDown(0.25);
    drawSignatureBlock(doc, "Customer 2", secondaryName);
  }
  doc.moveDown(0.45);
  drawSignatureBlock(doc, COMPANY_INFO.legalName, `${COMPANY_INFO.projectManager}\nProject Manager`);
}

function addFooter(doc, contract) {
  const range = doc.bufferedPageRange();
  const label = contractDisplayLabel(contract);
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
    doc.text(COMPANY_INFO.legalName, PAGE.marginX, PAGE.height - 32, {
      width: 180,
      lineBreak: false,
    });
    doc.text(label, PAGE.marginX + 185, PAGE.height - 32, {
      width: 160,
      align: "center",
      lineBreak: false,
    });
    doc.text(`Page ${i + 1} of ${range.count}`, PAGE.width - PAGE.marginX - 120, PAGE.height - 32, {
      width: 120,
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
        Title: `${contractDisplayLabel(contract)} Premium Island Homes Agreement`,
        Author: COMPANY_INFO.legalName,
        Subject: "Home improvement agreement",
      },
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    drawFirstPageHeader(doc, contract);

    sectionTitle(doc, "Customer Information", { topGap: 0, keepWith: 82 });
    drawCompactInfoGrid(doc, [
      { label: "Customer", value: contract.customerSnapshot?.fullName },
      { label: "Phone", value: formatPhone(contract.customerSnapshot?.phone) },
      { label: "Email", value: contract.customerSnapshot?.email || "Not specified" },
      { label: "Property", value: contract.propertySnapshot?.address },
      { label: "Work type", value: workTypeLabel(contract) },
      { label: "Contract date", value: formatDate(contract.dates?.contractDate) },
    ]);

    if (descriptionShouldRender(contract)) {
      sectionTitle(doc, "Project Description", { keepWith: 85 });
      drawStructuredText(doc, truncatedDescription(contract.projectDescription), {
        size: 10.7,
        color: "#1f2937",
        lineGap: 2.8,
      });
    }

    sectionTitle(doc, "Scope of Work", { keepWith: 95 });
    drawStructuredText(doc, contract.scopeText, {
      size: 10,
      color: "#1f2937",
      lineGap: 2.3,
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
