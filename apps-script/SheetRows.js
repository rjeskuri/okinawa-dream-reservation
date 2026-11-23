// Row helpers for the staff Dashboard: read and append rows of a tab by header, never by column position. Headers match
// as the Worker matches them (src/lib/catalog/sheet-schema.ts), in any order, and columns staff added are left alone.
// Apps Script files share one global scope and have no modules. Helpers end in `_`, which keeps them off the Run list.

/** A header as it is matched: NFKC, trimmed, lower case. Same as headerKey in src/lib/catalog/sheet-schema.ts. */
function headerKey_(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase() : "";
}

/** The tab's header row as key -> 1-based column, a repeated header keeping its first column, as the Worker does. */
function headerColumns_(sheet) {
  const width = sheet.getLastColumn();
  const columns = new Map();
  if (sheet.getLastRow() < 1 || width < 1) return columns;
  sheet.getRange(1, 1, 1, width).getValues()[0].forEach((name, index) => {
    const key = headerKey_(name);
    if (key !== "" && !columns.has(key)) columns.set(key, index + 1);
  });
  return columns;
}

function tabOrThrow_(tabName) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(tabName);
  if (sheet === null) throw new Error(`${tabName}: the tab is missing, use Set up tabs`);
  return sheet;
}

function columnOrThrow_(tabName, columns, header) {
  const key = headerKey_(header);
  const column = columns.get(key);
  if (column === undefined) throw new Error(`${tabName}: the header ${key} is missing`);
  return column;
}

/**
 * What a row helper hands to setValues. setValues parses a string as typed input, so `2002`, `0123`, `2027-07-15`,
 * `09:30`, `TRUE` or `=1` would become a number, date, time, boolean or formula. Every non-empty string is written with
 * a leading apostrophe, which Sheets drops and which keeps the rest as the exact text; the cell's format is not changed.
 * A number, boolean or Date is written as it is, so a value meant as one must reach the helpers as that type.
 */
function storedValue_(value) {
  return typeof value === "string" && value !== "" ? `'${value}` : value;
}

function isBlankCell_(value) {
  return value === false || (typeof value === "string" ? value.trim() === "" : value === null || value === undefined);
}

/**
 * Null for a missing tab. Otherwise the header keys in column order and each row that holds something, with its real
 * 1-based sheet row. A cell is keyed by its header; a repeated header is its first column.
 */
function readRecords_(tabName) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(tabName);
  if (sheet === null) return null;
  const columns = headerColumns_(sheet);
  const headers = Array.from(columns.keys());
  const records = [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { headers, records };
  const values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  values.forEach((cells, index) => {
    if (cells.every(isBlankCell_)) return;
    const record = {};
    columns.forEach((column, key) => {
      record[key] = cells[column - 1];
    });
    records.push({ row: index + 2, cells: record });
  });
  return { headers, records };
}

/**
 * Writes one row below the last one, each value under the column whose header matches its key and '' elsewhere, and
 * answers the row number. Every key is checked before anything is written.
 */
function appendRecord_(tabName, cells) {
  const sheet = tabOrThrow_(tabName);
  const columns = headerColumns_(sheet);
  const width = sheet.getLastColumn();
  const row = new Array(width).fill("");
  Object.keys(cells).forEach((header) => {
    row[columnOrThrow_(tabName, columns, header) - 1] = storedValue_(cells[header]);
  });
  const target = sheet.getLastRow() + 1;
  sheet.getRange(target, 1, 1, width).setValues([row]);
  return target;
}

function cellValue_(tabName, row, header) {
  const sheet = tabOrThrow_(tabName);
  return sheet.getRange(row, columnOrThrow_(tabName, headerColumns_(sheet), header)).getValue();
}

function setCellValue_(tabName, row, header, value) {
  const sheet = tabOrThrow_(tabName);
  sheet.getRange(row, columnOrThrow_(tabName, headerColumns_(sheet), header)).setValue(storedValue_(value));
}
