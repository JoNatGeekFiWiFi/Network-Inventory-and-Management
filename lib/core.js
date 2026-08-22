// Small pure helpers shared across every domain module. No DB, no Express, no side effects —
// keep it that way so domains can import this freely without creating cycles.

/** Round to 2dp for money. */
export const r2 = v => Math.round(Number(v || 0) * 100) / 100;

/** Today as YYYY-MM-DD (local-ish; matches how invoice dates are stored). */
export const todayStr = () => new Date().toISOString().slice(0, 10);

/** Escape for interpolation into server-rendered HTML (pay pages, emails). */
export const esc2 = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * E.164-ish phone normalisation. Bare US 10-digit (or 11 starting with 1) gets +1 so that
 * outbound SMS/WhatsApp and inbound number→customer matching agree on one format.
 */
export const normPhone = (s) => {
  s = String(s || '').trim(); if (!s) return '';
  const p = s.replace(/[^\d+]/g, '');
  if (p.startsWith('+')) return p;
  const d = p.replace(/\D/g, ''); if (!d) return '';
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return '+' + d;
};

/**
 * Build a Content-Disposition value for a download.
 *
 * Node rejects a header containing any byte above 0x7F with ERR_INVALID_CHAR, which turns into a
 * 500 rather than a download. Filenames here come from data — a cable name, an uploaded file, a
 * template title — so a single em dash or accented letter is enough to break the route. This emits
 * an ASCII-safe `filename` for every client plus the RFC 5987 `filename*` that carries the real
 * name, which is what browsers actually use when both are present.
 */
export function contentDisposition(name, disposition = 'attachment') {
  const raw = String(name || 'download').replace(/[\r\n]/g, ' ').trim() || 'download';
  const ascii = raw.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_').slice(0, 120);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}
