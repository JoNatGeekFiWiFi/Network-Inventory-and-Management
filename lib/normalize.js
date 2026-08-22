// Turning what people actually type into what the database should hold.
//
// These exist because the carrier spreadsheets are written by hand over years: the same plan has
// five spellings, MACs come with and without separators, and a billing day is "17th". Normalising
// on the way in is what makes an account findable later — a MAC stored as `1C937CF4A003` will
// never match a search for `1c:93:7c:f4:a0:03`, and neither will ever match the other.

/** `1C937CF4A003`, `1c-93-7c-f4-a0-03`, `1c93.7cf4.a003` → `1C:93:7C:F4:A0:03`. */
export function normalizeMac(v) {
  if (v == null) return null;
  const hex = String(v).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (hex.length !== 12) return String(v).trim() || null;   // not a MAC; hand it back untouched
  return hex.match(/.{2}/g).join(':');
}

/** `17th`, `17`, `the 17th`, `17th of the month` → 17. Anything outside 1-31 is rejected. */
export function normalizeDueDay(v) {
  if (v == null || v === '') return null;
  const m = String(v).match(/(\d{1,2})\s*(?:st|nd|rd|th)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 31 ? n : null;
}

/**
 * Yes / no / true / 1 / on / enrolled → 1 or 0.
 *
 * Returns null for anything unrecognised rather than guessing. On Jon's Cox sheet only 1 of 51
 * rows had an autopay value, and reading the 50 blanks as "not on autopay" would be inventing
 * an answer to a question the sheet never asked.
 */
export function normalizeBool(v) {
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).trim().toLowerCase();
  if (/^(y|yes|true|1|on|enrolled|active|auto)$/.test(s)) return 1;
  if (/^(n|no|false|0|off|none|manual)$/.test(s)) return 0;
  return null;
}

/** `$1,234.50`, `1234.5`, `50.0` → 1234.5. Returns null rather than 0 for junk. */
export function normalizeMoney(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[$£€,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Fold the many spellings of one carrier plan into a single label.
 *
 * "straight up 50", "straightup 50" and "StraightUp 50" are one plan; so are "1 gig", "1gig" and
 * "gigablast". Left as free text they become three plans in every report and filter. The speed is
 * the reliable part, so the label is rebuilt from it where one can be read.
 */
export function normalizePlan(v) {
  if (v == null || String(v).trim() === '') return null;
  const raw = String(v).trim();
  const s = raw.toLowerCase().replace(/\s+/g, ' ');

  // Gigabit, however it's spelled.
  if (/\b(1\s*gig|gigablast|gigabit|1000\s*m)\b/.test(s)) return 'Gigablast (1 Gbps)';

  // A speed in Mbps, with an optional upload.
  const m = s.match(/(\d{2,4})\s*(?:mbps|mb|m)?\s*(?:\/\s*(\d{1,4}))?/);
  if (m) {
    const down = Number(m[1]), up = m[2] ? Number(m[2]) : null;
    if (down >= 10 && down <= 10000) {
      const family = /straight\s*up/.test(s) ? 'StraightUp'
        : /fiber/.test(s) ? 'Fiber'
        : /cable|coax/.test(s) ? 'Cable' : null;
      const speed = up ? `${down}/${up} Mbps` : `${down} Mbps`;
      return family ? `${family} ${speed}` : speed;
    }
  }
  // Unrecognised: keep what they wrote, just tidied. Better a stray label than a wrong one.
  return raw.replace(/\s+/g, ' ');
}

/** Strip the trailing noise people add to names: "Yanet Perchez home" → "Yanet Perchez". */
export function normalizeName(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/\s+/g, ' ').replace(/\s+(home|house|res|residential|cell|mobile)$/i, '');
  return s || null;
}
