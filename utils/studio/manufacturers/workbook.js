/**
 * Reading a manufacturer's Excel price file (.xlsx) into plain rows.
 *
 * The file is untrusted input from an upload: size, sheet and row counts are
 * capped, only the workbook's cell values are read (no formulas are run, no
 * external links followed), and every value becomes a trimmed string.
 * Headers named "ColumnNN" (Excel's placeholder for an unnamed column) and
 * empty cells are dropped.
 */
const ExcelJS = require("exceljs");

const LIMITS = Object.freeze({ bytes: 20 * 1024 * 1024, sheets: 30, rowsPerSheet: 60_000, totalRows: 150_000, columns: 400 });

function cellText(v) {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text || "").join("").trim();
    if (v.text != null) return String(typeof v.text === "object" ? cellText(v.text) : v.text).trim();
    if (v.result != null) return cellText(v.result);
    if (v.hyperlink) return String(v.hyperlink).trim();
    if (v.error) return "";
    return "";
  }
  return String(v).trim();
}

const PLACEHOLDER = /^Column\d+$/i;

/**
 * @returns {Promise<{ sheets: { name: string, headers: string[], rows: { _row: number, [header: string]: string }[] }[] }>}
 * Throws an Error with `userMessage` for files that cannot be read.
 */
async function readWorkbook(buffer) {
  const bad = (m) => Object.assign(new Error(m), { userMessage: m });
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw bad("The file is empty.");
  if (buffer.length > LIMITS.bytes) throw bad("The file is larger than 20 MB.");
  // .xlsx is a zip archive: "PK\x03\x04"
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw bad("This is not an .xlsx workbook. Save the file as Excel Workbook (.xlsx) and try again.");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw bad("The workbook could not be read. Open it in Excel, save it as .xlsx, and try again.");
  }
  if (wb.worksheets.length > LIMITS.sheets) throw bad(`The workbook has more than ${LIMITS.sheets} sheets.`);
  const sheets = [];
  let total = 0;
  for (const ws of wb.worksheets) {
    if (ws.rowCount > LIMITS.rowsPerSheet + 1) throw bad(`Sheet "${ws.name}" has more than ${LIMITS.rowsPerSheet.toLocaleString()} rows.`);
    if (ws.columnCount > LIMITS.columns) throw bad(`Sheet "${ws.name}" has more than ${LIMITS.columns} columns.`);
    const headerCells = ws.getRow(1).values || [];
    const headers = [];
    for (let i = 1; i < headerCells.length; i++) headers[i] = cellText(headerCells[i]);
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return;
      const out = { _row: n };
      let filled = 0;
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const h = headers[col];
        if (!h || PLACEHOLDER.test(h)) return;
        const v = cellText(cell.value);
        if (v === "" || v === "null" || v === "undefined") return;
        out[h] = v.slice(0, 2000);
        filled++;
      });
      if (filled) rows.push(out);
    });
    total += rows.length;
    if (total > LIMITS.totalRows) throw bad(`The workbook has more than ${LIMITS.totalRows.toLocaleString()} rows.`);
    sheets.push({ name: ws.name, headers: headers.filter((h) => h && !PLACEHOLDER.test(h)), rows });
  }
  return { sheets };
}

module.exports = { readWorkbook, cellText, LIMITS };
