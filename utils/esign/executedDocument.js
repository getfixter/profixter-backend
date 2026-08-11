/**
 * Executed document production.
 *
 * INTEGRITY CHAIN - the whole point of this module:
 *
 *   frozen PDF bytes           exactly what the customer reviewed
 *     -> frozenDocument.sha256
 *   overlay ONLY execution fields onto those exact bytes
 *     -> executed PDF
 *     -> executedSha256
 *
 * The executed document is the frozen document. It is not re-rendered, so the
 * substantive contents - scope, price, payment schedule, terms - are not
 * regenerated and cannot drift by even a byte. pdf-lib opens the frozen file
 * and draws onto it; everything already on the page is carried through
 * untouched.
 *
 * The only additions permitted here are execution information: the customer's
 * signature and the authoritative signing date. The company signature is
 * already present in the frozen document, because the company signs when the
 * agreement is issued, before the customer ever reviews it.
 *
 * Placement is not guessed. The generator records an anchor for each execution
 * field as it draws the signature rule, so the overlay writes to the exact spot
 * the layout intended, on the exact page.
 */

const { PDFDocument } = require("pdf-lib");

const { generateContractPdfBuffer } = require("../contractPdf");
const { generateChangeOrderPdfBuffer } = require("../changeOrderPdf");
const { getCompanySignatureImage } = require("../companySignature");
const { sha256 } = require("./nativeSigning");

/** Dates on documents are formatted identically everywhere. */
function formatSigningDate(value) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(value));
}

/**
 * Render the document that will be frozen and shown to the signer.
 *
 * The company signature is applied here, so what the customer reviews is the
 * document as the company has already executed it. Returns the bytes, their
 * hash, and the anchors the overlay will need later.
 */
async function renderFrozenDocument({ documentType, document, pinnedDate = null }) {
  const companySignatureImage = await getCompanySignatureImage();
  const collectAnchors = [];

  const options = {
    companySignatureImage,
    companySignedDate: companySignatureImage
      ? formatSigningDate(pinnedDate || document.createdAt || new Date())
      : "",
    collectAnchors,
    pinnedDate,
  };

  const buffer =
    documentType === "CHANGE_ORDER"
      ? await generateChangeOrderPdfBuffer(document, options)
      : await generateContractPdfBuffer(document, options);

  return {
    buffer,
    sha256: sha256(buffer),
    anchors: collectAnchors,
    companySignatureApplied: Boolean(companySignatureImage),
  };
}

function findAnchor(anchors, field) {
  return (Array.isArray(anchors) ? anchors : []).find((anchor) => anchor.field === field) || null;
}

/**
 * Produce the executed document by overlaying onto the frozen bytes.
 *
 * `frozenBuffer` must be the exact bytes that were hashed and shown. Nothing
 * here re-reads the Contract or Change Order, so a later draft edit cannot
 * influence the executed output.
 */
async function overlayExecution({ frozenBuffer, anchors, signatureImage, signedAt }) {
  if (!frozenBuffer || !frozenBuffer.length) {
    throw new Error("The frozen document is required to produce the executed document");
  }
  if (!signatureImage || !signatureImage.length) {
    throw new Error("An executed document requires the customer signature");
  }

  const pdf = await PDFDocument.load(frozenBuffer);
  const pages = pdf.getPages();

  const signatureAnchor = findAnchor(anchors, "customer");
  const dateAnchor = findAnchor(anchors, "customerDate");
  if (!signatureAnchor) {
    throw new Error("The frozen document has no recorded customer signature position");
  }

  /* --- signature --- */
  const page = pages[Math.min(signatureAnchor.pageIndex, pages.length - 1)];
  const pageHeight = page.getHeight();
  const png = await pdf.embedPng(signatureImage);

  // Fit inside the anchor box while preserving aspect ratio, so a wide or tall
  // signature is never stretched.
  const box = { width: signatureAnchor.width, height: signatureAnchor.height };
  const scale = Math.min(box.width / png.width, box.height / png.height, 1);
  const drawWidth = png.width * scale;
  const drawHeight = png.height * scale;

  // pdfkit measured from the top of the page; pdf-lib measures from the bottom.
  // Sit the signature on the rule rather than through it.
  page.drawImage(png, {
    x: signatureAnchor.x,
    y: pageHeight - signatureAnchor.topY + 2,
    width: drawWidth,
    height: drawHeight,
  });

  /* --- signing date --- */
  if (dateAnchor && signedAt) {
    const datePage = pages[Math.min(dateAnchor.pageIndex, pages.length - 1)];
    const datePageHeight = datePage.getHeight();
    // Helvetica is already embedded by the generator; pdf-lib's standard font
    // reference resolves without adding a new font program.
    datePage.drawText(formatSigningDate(signedAt), {
      x: dateAnchor.x,
      y: datePageHeight - dateAnchor.topY + 5,
      size: 10.5,
    });
  }

  const bytes = await pdf.save({ useObjectStreams: false });
  const buffer = Buffer.from(bytes);
  return { buffer, sha256: sha256(buffer) };
}

module.exports = {
  formatSigningDate,
  renderFrozenDocument,
  overlayExecution,
  findAnchor,
};
