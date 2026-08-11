/**
 * Electronic Signature Certificate.
 *
 * The evidence document. It exists so the Agreement itself stays clean: no
 * hashes, no IP addresses, no audit metadata scattered across a document a
 * homeowner has to read. Everything that supports "this person signed this
 * exact version, at this time, having consented" lives here instead.
 *
 * Stored privately alongside the frozen original and the executed document.
 *
 * It states what the record shows and no more. An IP address is presented as
 * supporting evidence, not as identification, and nothing here is described as
 * legally conclusive.
 */

const PDFDocument = require("pdfkit");
const { COMPANY_INFO } = require("../../config/premiumIslandHomesContract");

const PAGE = { width: 612, height: 792, marginX: 54, top: 54, bottom: 62 };
const CONTENT_WIDTH = PAGE.width - PAGE.marginX * 2;

function formatStamp(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function ensureRoom(doc, height = 80) {
  if (doc.y + height > PAGE.height - PAGE.bottom) doc.addPage();
}

function sectionTitle(doc, title) {
  ensureRoom(doc, 44);
  doc.moveDown(0.7);
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("#111827")
    .text(title.toUpperCase(), PAGE.marginX, doc.y, { width: CONTENT_WIDTH, characterSpacing: 0.6 });
  doc.moveDown(0.3);
  const y = doc.y;
  doc.save().strokeColor("#e5e7eb").lineWidth(0.6).moveTo(PAGE.marginX, y).lineTo(PAGE.width - PAGE.marginX, y).stroke().restore();
  doc.y = y + 10;
}

function row(doc, label, value, { mono = false } = {}) {
  ensureRoom(doc, 26);
  const y = doc.y;
  doc.font("Helvetica").fontSize(8.5).fillColor("#6b7280").text(String(label), PAGE.marginX, y, {
    width: 170,
  });
  doc
    .font(mono ? "Courier" : "Helvetica")
    .fontSize(mono ? 8 : 9.5)
    .fillColor("#111827")
    .text(String(value ?? "—"), PAGE.marginX + 178, y, { width: CONTENT_WIDTH - 178, lineGap: 1.2 });
  doc.y = Math.max(doc.y, y + 16);
}

/** One line of the signing timeline. */
function timelineRow(doc, label, at, detail = "") {
  ensureRoom(doc, 22);
  const y = doc.y;
  doc.font("Helvetica").fontSize(9).fillColor("#111827").text(label, PAGE.marginX, y, { width: 190 });
  doc.font("Helvetica").fontSize(9).fillColor("#374151").text(formatStamp(at), PAGE.marginX + 195, y, {
    width: 190,
  });
  if (detail) {
    doc.font("Helvetica").fontSize(8.5).fillColor("#6b7280").text(detail, PAGE.marginX + 390, y, {
      width: CONTENT_WIDTH - 390,
    });
  }
  doc.y = y + 15;
}

/**
 * Build the certificate.
 *
 * `signature` is the ESignature record; `document` supplies the human-facing
 * numbers. Nothing is recomputed here - the certificate reports stored values
 * so it can never disagree with the record it describes.
 */
async function generateSignatureCertificateBuffer({ signature, documentLabel, customerName, propertyAddress }) {
  const doc = new PDFDocument({
    size: [PAGE.width, PAGE.height],
    margins: { top: PAGE.top, bottom: PAGE.bottom, left: PAGE.marginX, right: PAGE.marginX },
    bufferPages: true,
    info: {
      Title: `Electronic Signature Certificate - ${documentLabel}`,
      Author: COMPANY_INFO.legalName,
    },
  });

  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  /* header */
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111827").text(COMPANY_INFO.legalName, PAGE.marginX, PAGE.top, {
    width: CONTENT_WIDTH,
  });
  doc.font("Helvetica").fontSize(9).fillColor("#4b5563");
  COMPANY_INFO.addressLines.forEach((line) => doc.text(line, { width: CONTENT_WIDTH }));
  doc.text(`${COMPANY_INFO.phone} · ${COMPANY_INFO.email}`, { width: CONTENT_WIDTH });

  doc.moveDown(1.1);
  doc
    .font("Helvetica-Bold")
    .fontSize(19)
    .fillColor("#111827")
    .text("ELECTRONIC SIGNATURE CERTIFICATE", PAGE.marginX, doc.y, {
      width: CONTENT_WIDTH,
      characterSpacing: 0.8,
    });
  doc.font("Helvetica").fontSize(10.5).fillColor("#374151").text(documentLabel, { width: CONTENT_WIDTH });
  doc.moveDown(0.5);
  const ruleY = doc.y;
  doc.save().strokeColor("#111827").lineWidth(0.8).moveTo(PAGE.marginX, ruleY).lineTo(PAGE.width - PAGE.marginX, ruleY).stroke().restore();
  doc.y = ruleY + 12;

  /* document */
  sectionTitle(doc, "Document");
  row(doc, "Document", documentLabel);
  row(doc, "Version signed", signature.frozenDocument?.documentVersion ?? "—");
  row(doc, "Property", propertyAddress || "—");
  row(doc, "ProFixter record ID", String(signature._id));

  /* signer */
  sectionTitle(doc, "Signer");
  row(doc, "Name", customerName || "—");
  row(doc, "Email", (signature.signers || []).find((s) => s.role === "CUSTOMER")?.email || "—");
  row(doc, "Signing method", signature.signingMode === "IN_PERSON" ? "In person, on a device provided by Premium Island Homes Inc." : "Remote, via a secure emailed link");

  /* consent */
  sectionTitle(doc, "Electronic records consent");
  row(doc, "Consent accepted", formatStamp(signature.consent?.acceptedAt));
  row(doc, "Disclosure version", signature.consent?.disclosureVersion || "—");
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(8.5).fillColor("#4b5563").text(
    "The signer was shown the electronic records and signature disclosure identified above, and " +
      "affirmatively agreed to it before signing. The disclosure covered the right to a paper copy " +
      "at no charge and the right to withdraw consent before signing without fee or penalty.",
    PAGE.marginX,
    doc.y,
    { width: CONTENT_WIDTH, lineGap: 1.8 }
  );
  doc.moveDown(0.4);

  /* timeline */
  sectionTitle(doc, "Signing timeline");
  const events = [...(signature.auditEvents || [])].sort((a, b) => new Date(a.at) - new Date(b.at));
  const LABELS = {
    SIGNATURE_REQUEST_CREATED: "Request created",
    SIGNATURE_EMAIL_SENT: "Email sent to signer",
    SIGNATURE_LINK_OPENED: "Document opened",
    ELECTRONIC_CONSENT_ACCEPTED: "Consent accepted",
    SIGNATURE_SUBMITTED: "Signature submitted",
    DOCUMENT_EXECUTED: "Document executed",
  };
  for (const event of events) {
    const label = LABELS[event.event];
    if (!label) continue;
    timelineRow(doc, label, event.at, event.ip ? `IP ${event.ip}` : "");
  }
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text(
    "Times are recorded by the ProFixter server. IP addresses are retained as supporting evidence " +
      "of the connection used; they do not by themselves identify a person.",
    PAGE.marginX,
    doc.y,
    { width: CONTENT_WIDTH, lineGap: 1.6 }
  );

  /* integrity */
  sectionTitle(doc, "Document integrity");
  row(doc, "Signed document SHA-256", signature.frozenDocument?.sha256 || "—", { mono: true });
  row(doc, "Executed document SHA-256", signature.executedSha256 || "—", { mono: true });
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(8.5).fillColor("#4b5563").text(
    "The first hash identifies the exact document presented to the signer. The second identifies " +
      "the completed document, which is the same version with the signatures applied. Both files " +
      "are retained by Premium Island Homes Inc.; recomputing either hash will detect any change.",
    PAGE.marginX,
    doc.y,
    { width: CONTENT_WIDTH, lineGap: 1.8 }
  );

  /* device */
  sectionTitle(doc, "Device");
  row(doc, "Browser reported", signature.consent?.userAgent || "—");

  /* footer */
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.save();
    const margins = { ...doc.page.margins };
    doc.page.margins.top = 0;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(7.5).fillColor("#9ca3af").text(
      `${COMPANY_INFO.legalName} · Electronic Signature Certificate · Page ${i + 1} of ${range.count}`,
      PAGE.marginX,
      PAGE.height - 32,
      { width: CONTENT_WIDTH, align: "center", lineBreak: false }
    );
    doc.page.margins.top = margins.top;
    doc.page.margins.bottom = margins.bottom;
    doc.restore();
  }

  doc.end();
  return done;
}

module.exports = { generateSignatureCertificateBuffer, formatStamp };
