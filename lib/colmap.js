// Work out what each spreadsheet column is.
//
// Two signals, deliberately combined rather than either alone:
//   HEADER  — what the column is called. Strong when present, but real sheets have headers like
//             "Acct", "MAC ADDR", "$/mo", or nothing at all.
//   VALUES  — what the data looks like. A column of "DC:2C:6E:DD:6E:67" is a MAC whatever the
//             header says, and a column headed "Account" full of email addresses is not one.
//
// Every guess carries a confidence and the reason for it, because the wizard shows this to a
// person for approval. A silent wrong guess is the failure mode worth engineering against: it
// files a serial number as an account number and nobody notices until billing does.

/** Fields an import can populate. `group` drives how the preview is laid out. */
export const FIELDS = [
  // Deliberately no bare 'name': with substring matching it makes every "<something> Name" column
  // a customer name, which is how "User Name" on a real Cox sheet became the customer.
  { key: 'customer_name',   label: 'Customer name',    group: 'customer', names: ['customer', 'customer name', 'client', 'client name', 'business', 'business name', 'company', 'account holder', 'subscriber', 'tenant'] },
  { key: 'customer_email',  label: 'Customer email',   group: 'customer', names: ['email', 'e-mail', 'billing email', 'contact email', 'customer email'] },
  { key: 'customer_phone',  label: 'Customer phone',   group: 'customer', names: ['phone', 'telephone', 'mobile', 'cell', 'contact number', 'phone number'] },
  { key: 'status',          label: 'Status',           group: 'customer', names: ['status', 'state', 'active'] },

  { key: 'site_name',       label: 'Site name',        group: 'site',     names: ['site', 'site name', 'location', 'location name', 'property', 'building', 'building name', 'complex'] },
  // The address the equipment is at. On brokered sheets this is the CUSTOMER's address — the
  // carrier's own "account address" is often somewhere else entirely and belongs on the account.
  { key: 'service_address', label: 'Service address',  group: 'site',     names: ['address', 'service address', 'customer address', 'street', 'street address', 'install address', 'site address', 'location address', 'premise', 'premise address', 'addr'] },
  { key: 'unit',            label: 'Unit / apt',       group: 'site',     names: ['unit', 'apt', 'apartment', 'suite', 'ste', 'unit #', 'unit number', 'apt #', 'room', 'space'] },
  { key: 'city',            label: 'City',             group: 'site',     names: ['city', 'town'] },
  { key: 'state',           label: 'State',            group: 'site',     names: ['state', 'st', 'province'] },
  { key: 'postal',          label: 'ZIP / postcode',   group: 'site',     names: ['zip', 'zipcode', 'zip code', 'postal', 'postal code', 'postcode'] },
  { key: 'lat',             label: 'Latitude',         group: 'site',     names: ['lat', 'latitude'] },
  { key: 'lng',             label: 'Longitude',        group: 'site',     names: ['lng', 'lon', 'long', 'longitude'] },

  { key: 'carrier',         label: 'Carrier',          group: 'account',  names: ['carrier', 'provider', 'isp', 'vendor', 'underlying carrier', 'broker', 'brokered through'] },
  { key: 'account_name',    label: 'Account name',     group: 'account',  names: ['account', 'account name', 'billing account', 'master account', 'parent account'] },
  { key: 'account_number',  label: 'Account number',   group: 'account',  names: ['account #', 'account no', 'account number', 'acct', 'acct #', 'acct no', 'acct number', 'an'] },
  { key: 'subaccount',      label: 'Sub-account',      group: 'account',  names: ['sub account', 'sub-account', 'subaccount', 'sub acct', 'sub', 'child account'] },
  { key: 'circuit_id',      label: 'Circuit ID',       group: 'account',  names: ['circuit', 'circuit id', 'cid', 'circuit #', 'ckt'] },
  { key: 'bandwidth',       label: 'Plan / speed',     group: 'account',  names: ['bandwidth', 'speed', 'plan', 'package', 'tier', 'service', 'service plan'] },
  { key: 'install_date',    label: 'Install date',     group: 'account',  names: ['install', 'install date', 'installed', 'start date', 'activation', 'activated', 'live date'] },
  { key: 'billing_address', label: 'Account address (carrier)', group: 'account', names: ['account address', 'billing address', 'mailing address', 'bill to', 'bill to address', 'statement address'] },
  { key: 'due_day',         label: 'Bill due day',     group: 'account',  names: ['due date', 'due day', 'due', 'bill date', 'billing date', 'bill day', 'statement date'] },
  { key: 'autopay',         label: 'Autopay',          group: 'account',  names: ['autopay', 'auto pay', 'auto-pay', 'autopayment', 'automatic payment'] },
  { key: 'payment_method',  label: 'Payment method',   group: 'account',  names: ['payment method', 'pay method', 'payment', 'card', 'payment card', 'paid with', 'funding source'] },

  // Portal credentials. Grouped separately so the wizard can redact them on screen, and written
  // into the account's existing NOC/admin-only fields rather than anywhere searchable.
  { key: 'portal_username', label: 'Portal username',  group: 'login',    names: ['user name', 'username', 'user id', 'userid', 'login', 'login name', 'portal user', 'portal username', 'user'] },
  { key: 'portal_password', label: 'Portal password',  group: 'login',    names: ['password', 'portal password', 'passwd', 'pw', 'pass'] },
  { key: 'account_pin',     label: 'Account PIN',      group: 'login',    names: ['pin', 'pin code', 'account pin', 'security pin', 'passcode'] },

  { key: 'device_name',     label: 'Device name',      group: 'device',   names: ['device', 'device name', 'hostname', 'router', 'equipment', 'cpe'] },
  { key: 'device_model',    label: 'Model',            group: 'device',   names: ['model', 'device model', 'hardware', 'equipment model'] },
  { key: 'serial',          label: 'Serial number',    group: 'device',   names: ['serial', 'serial #', 'serial no', 'serial number', 's/n', 'sn'] },
  { key: 'mac',             label: 'MAC address',      group: 'device',   names: ['mac', 'mac address', 'mac addr', 'hw addr', 'ethernet address'] },

  { key: 'monthly_cost',    label: 'Monthly cost',     group: 'money',    names: ['cost', 'monthly cost', 'our cost', 'wholesale', 'wholesale cost', 'carrier cost', 'buy', 'buy rate', 'cost/mo'] },
  { key: 'monthly_revenue', label: 'Monthly price (what you bill)', group: 'money', names: ['revenue', 'charge', 'monthly charge', 'monthly price', 'monthly', 'mrc', 'price', 'sell', 'sell rate', 'sell price', 'retail', 'billed', 'amount', '$/mo'] },

  { key: 'notes',           label: 'Notes',            group: 'other',    names: ['notes', 'note', 'comment', 'comments', 'remarks', 'description'] }
];

const FIELD_BY_KEY = new Map(FIELDS.map(f => [f.key, f]));
export const fieldLabel = k => (FIELD_BY_KEY.get(k) || {}).label || k;

/**
 * Fields whose values must not be sent back to the browser for preview.
 *
 * The wizard shows sample values so a person can check the mapping — which would put every Cox
 * portal password on screen, in the page source, and in any screenshot of it. The mapping can be
 * checked perfectly well against a masked sample.
 */
export const SECRET_FIELDS = new Set(['portal_password', 'account_pin']);
export const maskSecret = v => {
  const s = String(v ?? '');
  return s ? '•'.repeat(Math.min(10, Math.max(4, s.length))) : '';
};

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---- value shape tests, used both to confirm and to veto a header guess ----
const RE = {
  email: /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i,
  mac: /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$|^[0-9a-f]{12}$/i,
  phone: /^\+?[\d][\d\s().-]{6,}$/,
  money: /^\$?\s*-?[\d,]+(\.\d{1,2})?$/,
  intish: /^\d{3,}$/,
  latlng: /^-?\d{1,3}\.\d{3,}$/,
  zip: /^\d{5}(-\d{4})?$/,
  state: /^[A-Z]{2}$/,
  date: /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})$/,
  // A street address: leading number then words. Deliberately loose — the point is to tell it
  // apart from a name or an account number, not to validate it.
  address: /^\d+\s+[A-Za-z0-9].*[A-Za-z]/,
  unit: /^(#?\s*[\w-]{1,8}|(apt|unit|ste|suite|rm|bldg)\.?\s*[\w-]{1,8})$/i,
  speed: /\b\d+\s?(k|m|g)b?(ps|it)?\b/i
};

const frac = (vals, test) => vals.length ? vals.filter(test).length / vals.length : 0;

/**
 * Is this value an amount of money?
 *
 * A bare run of digits is not enough. "0501" is a PIN and "8501214372309" is an account number;
 * both parse as numbers and both were being read as a monthly charge. Real money either carries a
 * currency symbol or decimals, and never has a leading zero before another digit.
 */
const isMoney = v => {
  const s = String(v).trim();
  if (!/^\$?\s*-?[\d,]+(\.\d{1,2})?$/.test(s)) return false;
  const digits = s.replace(/[^\d.]/g, '');
  if (/^0\d/.test(digits)) return false;                       // 0501
  if (!/[$.]/.test(s)) { const n = Number(digits); return n > 0 && n < 100000; }
  return true;
};

/**
 * A column whose values are overwhelmingly one recognisable thing.
 *
 * Without this, only fields that happen to define a value test get vetoed — so a column headed
 * "Account" full of MAC addresses dodges account_name and account_number, then lands on
 * sub-account instead, which has no test. A wrong answer with a plausible confidence is worse
 * than no answer, so a strong class rules out every field it can't be.
 *
 * The money test deliberately requires a currency symbol or exactly two decimals: a long account
 * number is a run of digits, and treating that as money would veto the field it really is.
 */
const MONEY_STRICT = /^\$\s*-?[\d,]+(\.\d{2})?$|^-?[\d,]+\.\d{2}$/;
function strongClass(vals) {
  if (vals.length < 2) return null;
  if (frac(vals, v => RE.mac.test(v)) > 0.6) return 'mac';
  if (frac(vals, v => RE.email.test(v)) > 0.6) return 'email';
  if (frac(vals, v => RE.latlng.test(v)) > 0.7) return 'latlng';
  if (frac(vals, v => MONEY_STRICT.test(v)) > 0.7) return 'money';
  return null;
}
const CLASS_FIELDS = {
  mac: ['mac'],
  email: ['customer_email'],
  latlng: ['lat', 'lng'],
  money: ['monthly_cost', 'monthly_revenue']
};

/** How well do this column's values look like `key`? -1 vetoes, 0 neutral, up to 1 confirms. */
function valueScore(key, vals) {
  if (!vals.length) return 0;
  const f = t => frac(vals, t);
  switch (key) {
    case 'customer_email':  return f(v => RE.email.test(v)) > 0.6 ? 1 : -1;
    case 'mac':             return f(v => RE.mac.test(v)) > 0.6 ? 1 : -1;
    case 'customer_phone':  return f(v => RE.phone.test(v)) > 0.6 ? 0.8 : -0.5;
    case 'service_address': return f(v => RE.address.test(v)) > 0.5 ? 1 : -0.6;
    case 'lat':             return f(v => RE.latlng.test(v) && Math.abs(+v) <= 90) > 0.7 ? 1 : -1;
    case 'lng':             return f(v => RE.latlng.test(v) && Math.abs(+v) <= 180) > 0.7 ? 1 : -1;
    case 'postal':          return f(v => RE.zip.test(v)) > 0.7 ? 1 : -0.8;
    case 'state':           return f(v => RE.state.test(v)) > 0.7 ? 1 : -0.8;
    case 'install_date':    return f(v => RE.date.test(v)) > 0.6 ? 1 : -0.6;
    case 'monthly_cost':
    case 'monthly_revenue': return f(isMoney) > 0.7 ? 0.7 : -1;
    case 'account_number':  return f(v => RE.intish.test(v) || /^[A-Z0-9-]{5,}$/i.test(v)) > 0.6 ? 0.6 : -0.3;
    case 'unit':            return f(v => RE.unit.test(v)) > 0.6 ? 0.6 : -0.3;
    case 'bandwidth':       return f(v => RE.speed.test(v)) > 0.5 ? 0.8 : 0;
    case 'billing_address': return f(v => RE.address.test(v)) > 0.5 ? 1 : -0.6;
    case 'due_day':         return f(v => /^(the\s+)?\d{1,2}(st|nd|rd|th)?$/i.test(v) && +String(v).replace(/\D/g, '') <= 31) > 0.7 ? 0.9 : -0.5;
    case 'autopay':         return f(v => /^(y|n|yes|no|true|false|1|0|on|off|enrolled)$/i.test(v)) > 0.7 ? 0.9 : -0.4;
    case 'account_pin':     return f(v => /^\d{3,8}$/.test(v)) > 0.7 ? 0.6 : -0.4;
    // A username or password is any short token; there is no shape to test, so the header decides.
    case 'portal_username':
    case 'portal_password': return f(v => /\s/.test(v)) > 0.5 ? -0.5 : 0;
    // Serials carry hyphens and underscores as often as not: VZ-SN-000121, 2CG5J1699600741.
    case 'serial':          return f(v => /^[A-Z0-9][A-Z0-9_-]{4,}$/i.test(v)) > 0.6 ? 0.5 : -0.3;
    // Names are just text; the only useful signal is that they are NOT something else.
    case 'customer_name':
    case 'site_name':
    case 'account_name':
    case 'carrier':
      if (f(v => RE.email.test(v) || RE.mac.test(v) || RE.money.test(v)) > 0.5) return -1;
      return f(v => /[A-Za-z]/.test(v)) > 0.7 ? 0.3 : -0.5;
    default: return 0;
  }
}

/** Header similarity: exact synonym, then containment, then token overlap. */
function headerScore(field, header) {
  const h = norm(header);
  if (!h) return 0;
  for (const n of field.names) {
    const nn = norm(n);
    if (h === nn) return 1;
  }
  for (const n of field.names) {
    const nn = norm(n);
    if (nn.length >= 3 && (h.includes(nn) || nn.includes(h))) return 0.7;
  }
  const ht = new Set(h.split(' '));
  let best = 0;
  for (const n of field.names) {
    const nt = norm(n).split(' ');
    const hit = nt.filter(t => ht.has(t)).length;
    if (hit) best = Math.max(best, 0.45 * (hit / nt.length));
  }
  return best;
}

/**
 * Guess a field for every column.
 *
 * Assignment is greedy over the best-scoring pairs, and each field is used once — otherwise
 * "Address" and "Site Address" both claim service_address and one of them silently wins.
 *
 * @returns [{ index, header, samples, field, confidence, why }]
 */
export function detectColumns(headers, rows) {
  const sampleFor = i => rows.slice(0, 60).map(r => String(r[i] ?? '').trim()).filter(Boolean);

  const cand = [];
  headers.forEach((header, index) => {
    const vals = sampleFor(index);
    const cls = strongClass(vals);
    for (const f of FIELDS) {
      // A column that is plainly one thing can only be the fields that thing can be, whatever
      // its header claims.
      if (cls && !CLASS_FIELDS[cls].includes(f.key)) continue;
      const hs = headerScore(f, header);
      const vs = valueScore(f.key, vals);
      if (hs === 0 && vs <= 0) continue;
      // A value veto outranks a header match: a column called "Account" full of MACs is not one.
      if (vs < 0 && hs < 1) continue;
      const score = hs * 0.65 + Math.max(0, vs) * 0.35 + (vs < 0 ? -0.4 : 0);
      if (score <= 0.15) continue;
      cand.push({
        index, field: f.key, score,
        why: hs >= 1 ? 'header matches exactly' : hs > 0 ? 'header looks like it' : 'values look like it'
      });
    }
  });

  cand.sort((a, b) => b.score - a.score);
  const takenCol = new Set(), takenField = new Set();
  const chosen = new Map();
  for (const c of cand) {
    if (takenCol.has(c.index) || takenField.has(c.field)) continue;
    takenCol.add(c.index); takenField.add(c.field);
    chosen.set(c.index, c);
  }

  return headers.map((header, index) => {
    const c = chosen.get(index);
    return {
      index, header, samples: sampleFor(index).slice(0, 3),
      field: c ? c.field : null,
      confidence: c ? Math.min(1, Math.round(c.score * 100) / 100) : 0,
      why: c ? c.why : 'no confident match — set it by hand if this column matters'
    };
  });
}
