/**
 * Change Order PDF.
 *
 * Deliberately uses the same page geometry, type scale, palette and section
 * grammar as utils/contractPdf.js so the two documents read as one family.
 * The contract generator is untouched.
 */

const PDFDocument = require("pdfkit");
const {
  COMPANY_INFO,
  CHANGE_ORDER_SURVIVAL_CLAUSE,
  CHANGE_ORDER_AUTHORIZATION_CLAUSE,
} = require("../config/changeOrderTerms");
const { formatMoney } = require("./contractValidation");
const { lineAmountCents, formatSignedCents } = require("./changeOrderTotals");
const { placeInkInBox } = require("./pngInkBox");

const PAGE = { width: 612, height: 792, marginX: 54, top: 54, bottom: 62 };
const CONTENT_WIDTH = PAGE.width - PAGE.marginX * 2;

function formatDate(value) {
  if (!value) return "Not specified";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(value));
}

function ensureRoom(doc, height = 80) {
  if (doc.y + height > PAGE.height - PAGE.bottom) doc.addPage();
}

function rule(doc, color = "#d1d5db") {
  const y = doc.y;
  doc
    .save()
    .strokeColor(color)
    .lineWidth(0.6)
    .moveTo(PAGE.marginX, y)
    .lineTo(PAGE.width - PAGE.marginX, y)
    .stroke()
    .restore();
  doc.y = y + 10;
}

function sectionTitle(doc, title) {
  ensureRoom(doc, 46);
  doc.moveDown(0.6);
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#111827").text(title.toUpperCase(), PAGE.marginX, doc.y, {
    width: CONTENT_WIDTH,
    characterSpacing: 0.6,
  });
  doc.moveDown(0.35);
  rule(doc, "#e5e7eb");
}

function keyValueRow(doc, label, value) {
  ensureRoom(doc, 34);
  const y = doc.y;
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#6b7280").text(String(label).toUpperCase(), PAGE.marginX, y, {
    width: CONTENT_WIDTH,
  });
  doc.font("Helvetica").fontSize(10).fillColor("#111827").text(value || "Not specified", PAGE.marginX, y + 12, {
    width: CONTENT_WIDTH,
    lineGap: 1.5,
  });
  doc.moveDown(0.8);
}

/**
 * Two-up label/value grid. Row height is measured rather than assumed, so a
 * value that wraps (a long address, a long name) can never overlap the row
 * beneath it.
 */
function twoColumnRows(doc, rows) {
  const colGap = 18;
  const colWidth = (CONTENT_WIDTH - colGap) / 2;
  const valueOptions = { width: colWidth, lineGap: 1.5 };

  for (let index = 0; index < rows.length; index += 2) {
    const pair = rows.slice(index, index + 2);

    doc.font("Helvetica").fontSize(10);
    const valueHeight = Math.max(
      ...pair.map((row) => doc.heightOfString(row.value || "Not specified", valueOptions))
    );
    const rowHeight = 12 + valueHeight + 10;

    ensureRoom(doc, rowHeight);
    const y = doc.y;

    pair.forEach((row, pairIndex) => {
      const x = PAGE.marginX + pairIndex * (colWidth + colGap);
      doc
        .font("Helvetica-Bold")
        .fontSize(8)
        .fillColor("#6b7280")
        .text(row.label.toUpperCase(), x, y, { width: colWidth });
      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor("#111827")
        .text(row.value || "Not specified", x, y + 12, valueOptions);
    });

    doc.y = y + rowHeight;
  }
}

function scheduleImpactText(changeOrder) {
  const impact = changeOrder.scheduleImpact || {};
  const days = Number(impact.days || 0);
  switch (impact.type) {
    case "add_days":
      return `Estimated completion extended by ${days} calendar day${days === 1 ? "" : "s"}.`;
    case "reduce_days":
      return `Estimated completion reduced by ${days} calendar day${days === 1 ? "" : "s"}.`;
    case "custom":
      return impact.note || "See description.";
    default:
      return "No change to the current project schedule.";
  }
}

function buildChangeOrderFilename(changeOrder) {
  const number = String(changeOrder.changeOrderNumber || "change-order").replace(/[^\w.-]+/g, "-");
  return `${number}.pdf`;
}

/** Renders the document and resolves with a Buffer. */
async function generateChangeOrderPdfBuffer(changeOrder, options = {}) {
  const doc = new PDFDocument({
    size: [PAGE.width, PAGE.height],
    margins: { top: PAGE.top, bottom: PAGE.bottom, left: PAGE.marginX, right: PAGE.marginX },
    bufferPages: true,
    info: {
      // Pinned so the same inputs render byte-identical output.
      ...(options.pinnedDate ? { CreationDate: new Date(options.pinnedDate) } : {}),
      Title: `Change Order ${changeOrder.changeOrderNumber}`,
      Author: COMPANY_INFO.legalName,
      Subject: `Change Order to Contract ${changeOrder.contractSnapshot?.contractNumber || ""}`,
    },
  });

  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  /* ---------------- header ---------------- */
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111827").text(COMPANY_INFO.legalName, PAGE.marginX, PAGE.top, {
    width: CONTENT_WIDTH,
  });
  doc.font("Helvetica").fontSize(9).fillColor("#4b5563");
  COMPANY_INFO.addressLines.forEach((line) => doc.text(line, { width: CONTENT_WIDTH }));
  doc.text(`${COMPANY_INFO.phone} · ${COMPANY_INFO.email}`, { width: CONTENT_WIDTH });
  doc.text(`NY Home Improvement License ${COMPANY_INFO.homeImprovementLicense}`, {
    width: CONTENT_WIDTH,
  });

  doc.moveDown(1.1);
  doc.font("Helvetica-Bold").fontSize(20).fillColor("#111827").text("CHANGE ORDER", PAGE.marginX, doc.y, {
    width: CONTENT_WIDTH,
    characterSpacing: 1.1,
  });
  doc.font("Helvetica").fontSize(11).fillColor("#374151").text(changeOrder.changeOrderNumber, {
    width: CONTENT_WIDTH,
  });
  doc.moveDown(0.6);
  rule(doc, "#111827");

  /* ---------------- parties & reference ---------------- */
  sectionTitle(doc, "Project and Agreement Reference");
  twoColumnRows(doc, [
    { label: "Customer", value: changeOrder.customerSnapshot?.fullName },
    { label: "Property Address", value: changeOrder.propertySnapshot?.address },
    { label: "Project Number", value: changeOrder.propertySnapshot?.projectNumber },
    { label: "Original Agreement", value: changeOrder.contractSnapshot?.contractNumber },
    { label: "Original Agreement Date", value: formatDate(changeOrder.contractSnapshot?.contractDate) },
    { label: "Change Order Date", value: formatDate(changeOrder.createdAt || new Date()) },
  ]);

  /* ---------------- title ---------------- */
  sectionTitle(doc, "Description of Change");
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111827").text(changeOrder.title, PAGE.marginX, doc.y, {
    width: CONTENT_WIDTH,
  });
  doc.moveDown(0.7);

  /* ---------------- change lines ---------------- */
  const lines = Array.isArray(changeOrder.lines) ? changeOrder.lines : [];
  lines.forEach((line, index) => {
    ensureRoom(doc, 60);
    const signed = lineAmountCents(line);
    const amountLabel = signed === 0 ? "NO COST CHANGE" : formatSignedCents(signed);
    const amountColor = signed > 0 ? "#166534" : signed < 0 ? "#991b1b" : "#4b5563";

    const y = doc.y;
    // Amount sits right-aligned so add/deduct is obvious at a glance.
    doc.font("Helvetica-Bold").fontSize(10).fillColor(amountColor).text(amountLabel, PAGE.marginX, y, {
      width: CONTENT_WIDTH,
      align: "right",
    });
    doc.font("Helvetica").fontSize(10).fillColor("#111827").text(`${index + 1}. ${line.description}`, PAGE.marginX, y, {
      width: CONTENT_WIDTH - 120,
      lineGap: 1.6,
    });
    doc.moveDown(0.7);
  });

  if (!lines.length) {
    doc.font("Helvetica-Oblique").fontSize(10).fillColor("#6b7280").text("No changes listed.", {
      width: CONTENT_WIDTH,
    });
    doc.moveDown(0.7);
  }

  /* ---------------- financial summary ---------------- */
  sectionTitle(doc, "Contract Price Adjustment");

  const summaryRows = [
    ["Original Agreement Amount", formatMoney(changeOrder.contractSnapshot?.originalContractAmountCents || 0)],
    [
      "Previous Approved Change Orders",
      formatSignedCents(changeOrder.previousChangeOrderAdjustmentCents || 0),
    ],
    ["Current Agreement Amount", formatMoney(changeOrder.contractAmountBeforeChangeCents || 0)],
    ["This Change Order", formatSignedCents(changeOrder.netAdjustmentCents || 0)],
  ];

  summaryRows.forEach(([label, value]) => {
    ensureRoom(doc, 22);
    const y = doc.y;
    doc.font("Helvetica").fontSize(10).fillColor("#374151").text(label, PAGE.marginX, y, {
      width: CONTENT_WIDTH - 150,
    });
    doc.font("Helvetica").fontSize(10).fillColor("#111827").text(value, PAGE.marginX, y, {
      width: CONTENT_WIDTH,
      align: "right",
    });
    doc.y = y + 16;
  });

  doc.moveDown(0.3);
  rule(doc, "#111827");
  ensureRoom(doc, 30);
  const totalY = doc.y;
  doc.font("Helvetica-Bold").fontSize(11.5).fillColor("#111827").text("NEW AGREEMENT TOTAL", PAGE.marginX, totalY, {
    width: CONTENT_WIDTH - 150,
  });
  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor("#111827")
    .text(formatMoney(changeOrder.newContractAmountCents || 0), PAGE.marginX, totalY - 1, {
      width: CONTENT_WIDTH,
      align: "right",
    });
  doc.y = totalY + 24;

  /* ---------------- schedule ---------------- */
  sectionTitle(doc, "Schedule Impact");
  doc.font("Helvetica").fontSize(10).fillColor("#111827").text(scheduleImpactText(changeOrder), PAGE.marginX, doc.y, {
    width: CONTENT_WIDTH,
    lineGap: 1.6,
  });
  doc.moveDown(0.7);

  if (changeOrder.notes) {
    sectionTitle(doc, "Additional Notes");
    doc.font("Helvetica").fontSize(10).fillColor("#111827").text(changeOrder.notes, PAGE.marginX, doc.y, {
      width: CONTENT_WIDTH,
      lineGap: 1.6,
    });
    doc.moveDown(0.7);
  }

  /* ---------------- legal ---------------- */
  sectionTitle(doc, "Terms");
  doc.font("Helvetica").fontSize(9).fillColor("#374151").text(CHANGE_ORDER_SURVIVAL_CLAUSE, PAGE.marginX, doc.y, {
    width: CONTENT_WIDTH,
    lineGap: 2,
  });
  doc.moveDown(0.5);
  doc.text(CHANGE_ORDER_AUTHORIZATION_CLAUSE, { width: CONTENT_WIDTH, lineGap: 2 });
  doc.moveDown(0.8);

  /* ---------------- signatures ---------------- */
  sectionTitle(doc, "Authorization");
  // The whole block must stay together: a signature line orphaned onto its own
  // page is how documents get signed in the wrong place.
  ensureRoom(doc, 156);

  const colGap = 28;
  const colWidth = (CONTENT_WIDTH - colGap) / 2;
  const blockY = doc.y + 6;

  [
    { title: "CUSTOMER", name: changeOrder.customerSnapshot?.fullName || "" },
    { title: COMPANY_INFO.legalName.toUpperCase(), name: COMPANY_INFO.projectManager || "" },
  ].forEach((party, index) => {
    const x = PAGE.marginX + index * (colWidth + colGap);
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#6b7280").text(party.title, x, blockY, {
      width: colWidth,
    });

    const lineY = blockY + 46;
    doc.save().strokeColor("#9ca3af").lineWidth(0.7).moveTo(x, lineY).lineTo(x + colWidth, lineY).stroke().restore();
    doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text("Signature", x, lineY + 4, { width: colWidth });

    const nameY = lineY + 40;
    doc.save().strokeColor("#9ca3af").lineWidth(0.7).moveTo(x, nameY).lineTo(x + colWidth, nameY).stroke().restore();
    doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text("Print name", x, nameY + 4, { width: colWidth });
    if (party.name) {
      doc.font("Helvetica").fontSize(9.5).fillColor("#111827").text(party.name, x, nameY - 13, { width: colWidth });
    }

    if (options.collectAnchors && index === 0) {
      options.collectAnchors.push({
        field: "customer",
        pageIndex: Math.max(0, doc.bufferedPageRange().count - 1),
        x: x + 2,
        topY: lineY,
        width: colWidth - 8,
        height: 34,
      });
      options.collectAnchors.push({
        field: "customerDate",
        pageIndex: Math.max(0, doc.bufferedPageRange().count - 1),
        x: x + 2,
        topY: nameY + 40,
        width: colWidth,
        height: 13,
      });
    }

    // Signatures are drawn onto the rule: the company's when the change order
    // is issued, the customer's when it is executed.
    const image = index === 0 ? options.customerSignatureImage : options.companySignatureImage;
    const inkBox = index === 0 ? options.customerSignatureInkBox : options.companySignatureInkBox;
    if (image) {
      try {
        // Place the ink rather than the canvas, so a stroke floating in a large
        // transparent field still fills the signature rule. See pngInkBox.
        const placement = placeInkInBox(inkBox, {
          x: x + 2,
          y: lineY - 30,
          width: colWidth - 8,
          height: 26,
        });
        if (placement) {
          doc.image(image, placement.x, placement.y, {
            width: placement.width,
            height: placement.height,
          });
        } else {
          doc.image(image, x + 2, lineY - 34, { fit: [colWidth - 8, 30], align: "left" });
        }
      } catch (error) {
        console.error("changeOrderPdf: signature image could not be drawn:", error?.message);
      }
    }

    const dateY = nameY + 40;
    doc.save().strokeColor("#9ca3af").lineWidth(0.7).moveTo(x, dateY).lineTo(x + colWidth, dateY).stroke().restore();
    doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text("Date", x, dateY + 4, { width: colWidth });

    // Authoritative server timestamps, never typed by the signer.
    const signedDate = index === 0 ? options.customerSignedDate : options.companySignedDate;
    if (signedDate) {
      doc.font("Helvetica").fontSize(9.5).fillColor("#111827").text(signedDate, x + 2, dateY - 13, {
        width: colWidth,
        lineBreak: false,
      });
    }
  });

  doc.y = blockY + 150;

  /* ---------------- footer on every page ---------------- */
  // Margins are zeroed and line breaking disabled while writing into the
  // footer strip, so placing text below the text area cannot spawn a new page.
  const range = doc.bufferedPageRange();
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
      width: 190,
      lineBreak: false,
    });
    doc.text(changeOrder.changeOrderNumber, PAGE.marginX + 195, PAGE.height - 32, {
      width: 150,
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

  doc.end();
  return done;
}

module.exports = {
  buildChangeOrderFilename,
  generateChangeOrderPdfBuffer,
  scheduleImpactText,
};
