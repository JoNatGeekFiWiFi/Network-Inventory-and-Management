// Load a spreadsheet or delimited file into headers + rows.
//
// The awkward part is CSV, not xlsx. Real exports contain quoted fields with embedded commas,
// escaped quotes, and newlines inside a cell — a naive split(',') silently shreds those into
// extra columns, and the damage only shows up as a customer called `"Smith` three screens later.
// So this is a character-level parser rather than a regex.
import { readXlsx, looksLikeXlsx } from './xlsx.js';

/** Split delimited text into rows, honouring quotes. */
export function parseDelimited(text, delim) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text).replace(/^﻿/, '');   // strip a UTF-8 BOM from Excel exports

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }   // "" is a literal quote
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // Drop wholly blank trailing rows, which exports are full of.
  while (rows.length && rows[rows.length - 1].every(c => !String(c).trim())) rows.pop();
  return rows;
}

/**
 * Guess the delimiter by which one yields the most consistent column count.
 * Counting occurrences alone picks the wrong one whenever addresses contain commas.
 */
export function sniffDelimiter(text) {
  const sample = String(text).split(/\r?\n/).slice(0, 20).join('\n');
  let best = ',', bestScore = -1;
  for (const d of [',', '\t', ';', '|']) {
    const rows = parseDelimited(sample, d).filter(r => r.length);
    if (rows.length < 1) continue;
    const widths = rows.map(r => r.length);
    const mode = widths.sort((a, b) => a - b)[Math.floor(widths.length / 2)];
    if (mode < 2) continue;
    const consistent = rows.filter(r => r.length === mode).length / rows.length;
    const score = consistent * 10 + Math.min(mode, 20) / 20;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/**
 * Where does the table actually start?
 *
 * Spreadsheets people maintain by hand often open with a title row, a blank, then the headers.
 * Taking row 0 blindly would map every column to garbage. The header row is the first one that
 * is mostly non-empty, mostly distinct, and mostly text.
 */
export function findHeaderRow(rows) {
  // Values that no one uses as a column title. Their presence is much stronger evidence that a
  // row is data than any amount of width or distinctness is that it's a header — without this,
  // a two-line file whose header repeats a name loses its first customer to the header row.
  const DATALIKE = [
    /^-?[\d,]*\.?\d+$/,                          // 4, 45.00, 1,200
    /^[$\u20ac\u00a3]\s*-?[\d,]*\.?\d+$/,          // $45.00
    /^-?\d+(\.\d+)?%$/,                          // 13%
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/,                // an email
    /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/,    // a MAC
    /^\d{4}-\d{2}-\d{2}/, /^\d{1,2}\/\d{1,2}\/\d{2,4}$/   // a date
  ];
  const isData = v => DATALIKE.some(re => re.test(v));

  const limit = Math.min(rows.length, 15);
  let best = 0, bestScore = -Infinity;
  for (let i = 0; i < limit; i++) {
    const r = rows[i] || [];
    const filled = r.map(c => String(c).trim()).filter(c => c !== '');
    if (filled.length < 2) continue;
    const distinct = new Set(filled.map(c => c.toLowerCase())).size;
    const datalike = filled.filter(isData).length;
    // Wide and distinct is good; data-shaped values are disqualifying; further down is worse.
    const score = filled.length * 2 + distinct - datalike * 4 - i * 3;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/**
 * Load any supported tabular file.
 * @returns { format, sheets, sheet, headers, rows, headerRow, totalRows }
 */
export function loadTable(buf, opts = {}) {
  let grid, format, sheets = null, sheet = null;

  if (Buffer.isBuffer(buf) && looksLikeXlsx(buf)) {
    const x = readXlsx(buf, { sheet: opts.sheet, maxRows: opts.maxRows });
    grid = x.rows; format = 'xlsx'; sheets = x.sheets; sheet = x.sheet;
  } else {
    const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    if (!text.trim()) throw new Error('That file is empty');
    const delim = opts.delimiter || sniffDelimiter(text);
    grid = parseDelimited(text, delim);
    format = delim === '\t' ? 'tsv' : 'csv';
  }
  if (!grid.length) throw new Error('No rows found in that file');

  // headerRow === -1 means the file has no header row at all: every line is data, and columns
  // get positional names. Without this the first customer silently becomes the column titles.
  const headerRow = opts.headerRow != null ? Number(opts.headerRow) : findHeaderRow(grid);
  const noHeader = headerRow < 0;
  const width0 = grid.reduce((w, r) => Math.max(w, r.length), 0);
  const rawHeaders = noHeader
    ? Array.from({ length: width0 }, (_, i) => `Column ${i + 1}`)
    : (grid[headerRow] || []).map(h => String(h).trim());

  // Name the unnamed, and disambiguate repeats, so a mapping can always address a column.
  const seen = new Map();
  const headers = rawHeaders.map((h, i) => {
    let name = h || `Column ${i + 1}`;
    if (seen.has(name.toLowerCase())) {
      const n = seen.get(name.toLowerCase()) + 1;
      seen.set(name.toLowerCase(), n);
      name = `${name} (${n})`;
    } else seen.set(name.toLowerCase(), 1);
    return name;
  });

  const rows = grid.slice(noHeader ? 0 : headerRow + 1)
    .map(r => { const o = []; for (let i = 0; i < headers.length; i++) o.push(String(r[i] ?? '').trim()); return o; })
    .filter(r => r.some(c => c !== ''));

  return { format, sheets, sheet, headers, rows, headerRow, totalRows: rows.length };
}
