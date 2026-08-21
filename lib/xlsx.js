// Minimal .xlsx reader — enough to get a spreadsheet's cells out, with no dependency.
//
// An .xlsx is a ZIP of XML, and we already have a ZIP reader for KMZ, so this is a small XML
// walk rather than a library. Deliberately partial: it reads values, not formatting, formulas,
// charts or merged-cell geometry. That's all an import wizard needs, and pulling in a full
// spreadsheet library to get it would be a poor trade.
//
// Cell types handled:
//   t="s"          shared-string index  → xl/sharedStrings.xml
//   t="inlineStr"  <is><t>text</t></is>
//   t="str"        formula result, already a string
//   t="b"          boolean
//   (none)         number, which may be an Excel date serial — see excelDateToISO
import { listZipEntries, readZipEntry, looksLikeZip } from './unzip.js';

const decode = s => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&amp;/g, '&');    // last, so "&amp;lt;" doesn't become "<"

/** Does this look like an xlsx rather than some other zip? */
export function looksLikeXlsx(buf) {
  if (!looksLikeZip(buf)) return false;
  try { return listZipEntries(buf).some(e => e.name === 'xl/workbook.xml'); }
  catch { return false; }
}

/** "BC12" → 54 (0-based column index). */
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(String(ref || '').toUpperCase());
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Shared strings, in order. Runs (<r><t>) are concatenated, which is how Excel shows them. */
function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const si of xml.match(/<si\b[\s\S]*?<\/si>/g) || []) {
    const parts = [...si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => decode(m[1]));
    out.push(parts.join(''));
  }
  return out;
}

/**
 * Excel stores dates as a day count from 1899-12-30 (the 1900 leap-year bug is baked in).
 * Only called when a column is being read as a date — a bare number is otherwise left alone,
 * because an account number that happens to look like a serial must not become a date.
 */
export function excelDateToISO(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0 || n > 60000) return null;
  const ms = Math.round((n - 25569) * 86400 * 1000);   // 25569 = days from 1970 epoch
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Sheet names in workbook order, each with the zip path of its XML. */
function sheetIndex(buf, entries) {
  const wbEntry = entries.find(e => e.name === 'xl/workbook.xml');
  if (!wbEntry) return [];
  const wb = readZipEntry(buf, wbEntry).toString('utf8');
  const relsEntry = entries.find(e => e.name === 'xl/_rels/workbook.xml.rels');
  const rels = new Map();
  if (relsEntry) {
    const rx = readZipEntry(buf, relsEntry).toString('utf8');
    for (const m of rx.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      let t = m[2].replace(/^\/?xl\//, '').replace(/^\//, '');
      rels.set(m[1], 'xl/' + t);
    }
  }
  const out = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const tag = m[0];
    const name = decode((/name="([^"]*)"/.exec(tag) || [])[1] || '');
    const rid = (/r:id="([^"]*)"/.exec(tag) || [])[1];
    const path = rid && rels.get(rid);
    if (path && entries.some(e => e.name === path)) out.push({ name, path });
  }
  // Some writers omit the rels; fall back to whatever worksheets exist.
  if (!out.length) {
    for (const e of entries.filter(x => /^xl\/worksheets\/sheet\d+\.xml$/.test(x.name)).sort((a, b) => a.name.localeCompare(b.name)))
      out.push({ name: e.name.replace(/^.*\//, '').replace('.xml', ''), path: e.name });
  }
  return out;
}

/**
 * Read one sheet into a rectangular array of strings.
 *
 * @param buf    the .xlsx bytes
 * @param opts   { sheet: name or index, maxRows }
 * @returns { sheets: [names], sheet: name, rows: [[cell,…],…] }
 */
export function readXlsx(buf, opts = {}) {
  const entries = listZipEntries(buf).filter(e => !e.name.endsWith('/'));
  const sheets = sheetIndex(buf, entries);
  if (!sheets.length) throw new Error('That .xlsx has no readable worksheets');

  let pick = sheets[0];
  if (opts.sheet != null && opts.sheet !== '') {
    const byName = sheets.find(s => s.name === opts.sheet);
    const idx = Number(opts.sheet);
    pick = byName || (Number.isInteger(idx) && sheets[idx]) || sheets[0];
  }

  const ssEntry = entries.find(e => e.name === 'xl/sharedStrings.xml');
  const strings = sharedStrings(ssEntry ? readZipEntry(buf, ssEntry).toString('utf8') : null);

  const xml = readZipEntry(buf, entries.find(e => e.name === pick.path)).toString('utf8');
  const maxRows = opts.maxRows || 20000;
  const rows = [];

  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= maxRows) break;
    const cells = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] || '', body = cm[2] || '';
      const ref = (/r="([A-Z]+\d+)"/.exec(attrs) || [])[1];
      const type = (/t="([^"]+)"/.exec(attrs) || [])[1] || 'n';
      let val = '';
      if (type === 's') {
        const i = Number((/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1]);
        val = Number.isInteger(i) ? (strings[i] ?? '') : '';
      } else if (type === 'inlineStr') {
        val = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => decode(m[1])).join('');
      } else {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        val = v == null ? '' : decode(v);
        if (type === 'b') val = val === '1' ? 'TRUE' : 'FALSE';
      }
      // Honour the cell reference, so a sparse row keeps its columns aligned.
      const at = ref ? colIndex(ref) : cells.length;
      while (cells.length < at) cells.push('');
      cells[at] = val;
    }
    rows.push(cells);
  }

  // Pad every row to the widest, so callers can index by column without guarding.
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of rows) while (r.length < width) r.push('');

  return { sheets: sheets.map(s => s.name), sheet: pick.name, rows };
}
