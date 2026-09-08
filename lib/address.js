// Turning a typed street address into a key that matches the same building twice.
//
// The same place gets entered a dozen ways — "10738 N 75Th Ave", "10738 north 75th avenue",
// "10738 N. 75th Ave., Peoria, AZ". Without normalising, each one creates another site and the
// address has to be retyped for every subscriber in the building.
//
// This is deliberately conservative: it folds case, punctuation and the standard USPS
// abbreviations, and nothing else. It does NOT guess at typos or transpositions, because a wrong
// match silently files a customer at someone else's address — worse than a duplicate.

// USPS C1 street suffixes, collapsed to their canonical short form.
const SUFFIX = {
  avenue: 'ave', av: 'ave', avenu: 'ave', avn: 'ave', avnue: 'ave',
  boulevard: 'blvd', boul: 'blvd', boulv: 'blvd',
  circle: 'cir', circl: 'cir', crcl: 'cir',
  court: 'ct', crt: 'ct',
  drive: 'dr', driv: 'dr', drv: 'dr',
  expressway: 'expy', expr: 'expy', express: 'expy',
  freeway: 'fwy', freewy: 'fwy',
  highway: 'hwy', highwy: 'hwy', hiway: 'hwy',
  lane: 'ln',
  parkway: 'pkwy', parkwy: 'pkwy', pky: 'pkwy',
  place: 'pl',
  road: 'rd',
  square: 'sq', sqr: 'sq',
  street: 'st', str: 'st', strt: 'st',
  terrace: 'ter', terr: 'ter',
  trail: 'trl', trails: 'trl',
  way: 'way',
  loop: 'loop',
  crossing: 'xing',
  point: 'pt',
  ridge: 'rdg',
  route: 'rte'
};

// Directionals.
const DIR = {
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  ne: 'ne', nw: 'nw', se: 'se', sw: 'sw'
};

// US state names → postal codes, so "Arizona" and "AZ" agree.
const STATE = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co',
  connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id',
  illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la',
  maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn',
  mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv',
  'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny',
  'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or',
  pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd',
  tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa',
  'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy', 'district of columbia': 'dc'
};

// Secondary-unit designators. These identify a unit WITHIN a building, so they're stripped from
// the site key — the whole point is that Apt 1 and Apt 2 resolve to one building — and returned
// separately so the caller can offer them as the unit label.
// `#` is handled as its own alternative: it is not a word character, so a leading \b can never
// match before it, and "#4b" would otherwise survive into the site key and split a building.
const UNIT_WORDS = /(?:\b(?:apt|apartment|unit|ste|suite|rm|room|fl|floor|bldg|building|lot|trlr|trailer|space|spc)\b|#)\s*\.?\s*([A-Za-z0-9-]+)/i;

/**
 * Normalised key for a service address, or '' when there isn't enough to match on.
 * Two addresses with the same key are treated as the same building.
 */
export function addressKey(input) {
  let s = String(input == null ? '' : input).toLowerCase();
  if (!s.trim()) return '';
  s = s.replace(/\bunited states\b|\busa\b|\bu\.s\.a\.\b/g, ' ');
  s = s.replace(UNIT_WORDS, ' ');                    // drop the unit — it isn't part of the building
  s = s.replace(/[.,;/#]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';

  const words = s.split(' ').map(w => {
    if (SUFFIX[w]) return SUFFIX[w];
    if (DIR[w]) return DIR[w];
    return w;
  });

  // Multi-word state names, matched before the single-word pass loses them.
  let joined = words.join(' ');
  for (const [name, code] of Object.entries(STATE))
    if (name.includes(' ') && joined.includes(name)) joined = joined.replace(name, code);
  let out = joined.split(' ').map(w => STATE[w] || w)
    // 1st/2nd/3rd/4th → 1/2/3/4 so "75th ave" and "75 ave" agree
    .map(w => w.replace(/^(\d+)(st|nd|rd|th)$/, '$1'))
    .filter(Boolean);

  // Drop a trailing ZIP.
  //
  // People include it about half the time — one tech types "4100 Chain Ave, Tempe, AZ 85281" and
  // the next types "4100 chain avenue, tempe arizona". Keeping the ZIP made those two different
  // buildings, so the second tenant at an address silently got a second site, which is exactly the
  // duplication this key exists to prevent. It carries no information the street, city and state
  // do not already pin down, and only the LAST token is considered so a house number is safe.
  const last = out[out.length - 1];
  if (out.length > 2 && /^\d{5}(-\d{4})?$/.test(last)) out = out.slice(0, -1);

  // A bare number or a single word isn't enough to call two records the same place.
  if (out.length < 2) return '';
  return out.join(' ');
}

/** The unit designator found in an address, e.g. "Apt 4B" → "4B". Null when there isn't one. */
export function unitFromAddress(input) {
  const m = UNIT_WORDS.exec(String(input == null ? '' : input));
  return m && m[1] ? m[1].toUpperCase() : null;
}

/** Do these two addresses describe the same building? */
export function sameAddress(a, b) {
  const ka = addressKey(a), kb = addressKey(b);
  return !!ka && ka === kb;
}
