/**
 * Document date semantics.
 *
 * Every date on a Premium Island Homes document is one of two things, and the
 * difference decides who owns it:
 *
 *   SYSTEM EVENT   something happened at a moment the server witnessed - a PDF
 *                  was generated, a document was issued, a signature was
 *                  applied. Nobody types these. They are stamped once, from the
 *                  server clock, and then they are history.
 *
 *   BUSINESS CHOICE  a decision a person made - when work starts, when payment
 *                  is due, when a cheque dated last Tuesday actually arrived.
 *                  These stay selectable, because only a person knows them.
 *
 * The failure this module exists to prevent is a system-event date behaving
 * like a business choice: recomputed on every render, so a document quietly
 * says something different each time it is produced. A date printed on a PDF a
 * customer holds must come from a stored field, never from `new Date()` at
 * render time.
 *
 * STAMP ONCE, THEN FREEZE
 * An issue date tracks "today" only while the document is still an unissued
 * draft. The moment it is issued the date is fixed, and no later regeneration
 * may move it.
 */

/**
 * When the company executed this document.
 *
 * The company signs when the document is ISSUED - before the customer ever
 * sees it - so this is stamped at the first generation that actually applied
 * the signature, and reused verbatim from then on. Contracts keep it under
 * `dates`, change orders at the top level; both are read through here so no
 * caller has to know which.
 */
function readCompanySignedAt(document) {
  return document?.dates?.companySignedAt || document?.companySignedAt || null;
}

function writeCompanySignedAt(document, when) {
  if (!document || !when) return;
  if (document.dates && typeof document.dates === "object") {
    document.dates.companySignedAt = when;
    // Mongoose does not always notice a mutation inside a nested path.
    if (typeof document.markModified === "function") document.markModified("dates");
    return;
  }
  document.companySignedAt = when;
}

/**
 * The company execution date to print, stamping it the first time.
 *
 * @param {object} document      Contract or ChangeOrder (a Mongoose document).
 * @param {boolean} applied      Whether the signature image was actually drawn.
 * @param {Date} now             Server clock.
 * @returns {Date|null} the date to render, or null when nothing was signed.
 *
 * Returns null when no signature was applied, so the document shows an empty
 * signature rule rather than a date for a signature that is not there.
 */
function resolveCompanySignedAt(document, applied, now = new Date()) {
  if (!applied) return null;
  const existing = readCompanySignedAt(document);
  if (existing) return existing;
  writeCompanySignedAt(document, now);
  return now;
}

/**
 * Has this document been issued - that is, does anyone outside the office have
 * it? Once true, its issue date is history and must not move.
 */
function contractIsIssued(contract) {
  if (!contract) return false;
  if (contract.generatedPdf?.key) return true;
  return String(contract.status || "") !== "Draft";
}

function invoiceIsIssued(invoice) {
  if (!invoice) return false;
  if (invoice.sentAt) return true;
  const status = String(invoice.status || "");
  return status !== "Draft";
}

/**
 * Roll an unissued draft's issue date forward to today.
 *
 * A draft written on Monday and issued on Friday is a Friday document: it is
 * dated Friday, and terms counted from it start on Friday. Leaving Monday on it
 * would misdate the paperwork and, for an invoice on net terms, hand the
 * customer an invoice that is already part-way to overdue.
 *
 * Skipped entirely when the admin set the date deliberately - backdating a
 * paper agreement or entering an invoice raised last week are real needs, and a
 * deliberate choice outranks the convenience default.
 *
 * @returns {Date|null} the new date, or null when nothing should change.
 */
function autoIssueDate({ isIssued, isManual, currentDate, now = new Date() }) {
  if (isIssued) return null;
  if (isManual) return null;
  if (!currentDate) return now;
  return sameCalendarDay(currentDate, now) ? null : now;
}

/** Two instants on the same day in the company's timezone. */
function sameCalendarDay(a, b, timeZone = "America/New_York") {
  const format = (value) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(value));
  return format(a) === format(b);
}

module.exports = {
  readCompanySignedAt,
  writeCompanySignedAt,
  resolveCompanySignedAt,
  contractIsIssued,
  invoiceIsIssued,
  autoIssueDate,
  sameCalendarDay,
};
