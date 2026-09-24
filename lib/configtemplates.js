// Configuration templates: write a setting once, apply it to many routers, and notice when a router
// no longer matches.
//
// Templates are DECLARATIVE — each line states how something should be, not a command to run — so
// the same line serves three purposes: it can be applied, it can be checked against the router
// (drift), and applying it twice changes nothing the second time.
//
// RouterOS lines address the REST API:
//
//   /ip/dns set servers={{dns}} allow-remote-requests=no      a singleton menu
//   /ip/service[name=telnet] set disabled=yes                 existing items matching a selector
//   /ip/firewall/filter add chain=input action=drop protocol=tcp dst-port=23 comment="netinv: no telnet"
//                                                             an item that must exist; identified
//                                                             by its comment, which is required
// OpenWrt lines are UCI:
//
//   set system.@system[0].hostname={{name}}                   an option (anonymous section by index)
//   set firewall.netinv_ssh=rule                              a named section of a type
//   set firewall.netinv_ssh.src=wan
//   add_list firewall.netinv_ssh.proto=tcp                    a value that must be in a list
//   delete network.guest                                      a section (or option) that must not exist
//
// Variables are {{name}}. Precedence, lowest first: template defaults < global variables < the
// device's own facts (name, management address, site, customer) < variables set on the device.

export const PLATFORMS = ['routeros', 'openwrt'];

// ---- variables ------------------------------------------------------------------------------------

/** Substitute {{var}}. Returns { text, missing }. Values may not contain newlines (a new line is a new command). */
export function render(body, vars) {
  const missing = new Set();
  const text = String(body || '').replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, k) => {
    const v = vars[k];
    if (v === undefined || v === null || v === '') { missing.add(k); return ''; }
    return String(v).replace(/[\r\n]+/g, ' ');
  });
  return { text, missing: [...missing] };
}

/** "key=value" lines ↔ object, for the variable boxes in the UI. */
export function parseVars(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function systemVars(d, extra = {}) {
  return {
    name: d.name, device_id: d.id, mgmt_address: d.mgmt_address || '', mac: d.mac || '', serial: d.serial || '',
    site: extra.site || '', customer: extra.customer || '', pop: extra.pop || '', company: extra.company || ''
  };
}

// ---- parsing lines -----------------------------------------------------------------------------------

/** k=v pairs, where v may be "quoted with spaces". */
function parsePairs(s) {
  const out = {};
  const re = /([a-zA-Z0-9.-]+)=("((?:[^"\\]|\\.)*)"|\S*)/g;
  let m, consumed = '';
  while ((m = re.exec(s))) { out[m[1]] = m[3] != null ? m[3].replace(/\\"/g, '"') : m[2]; consumed += m[0]; }
  if (s.replace(re, '').trim()) return null;           // leftovers mean a typo, not an empty value
  return out;
}

/** One RouterOS template into steps, or { error, line }. */
export function parseRouterOS(text) {
  const steps = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#')) continue;
    const m = raw.match(/^(\/[a-zA-Z0-9/_-]+?)(?:\[([^\]]*)\])?\s+(set|add)\s+(.*)$/);
    if (!m) return { error: 'Expected: /menu/path [selector] set|add key=value …', line: i + 1 };
    const [, path, sel, verb, rest] = m;
    const values = parsePairs(rest);
    if (!values || !Object.keys(values).length) return { error: 'Could not read the key=value pairs', line: i + 1 };
    const selector = sel ? parsePairs(sel.replace(/,/g, ' ')) : null;
    if (sel && !selector) return { error: 'Could not read the [selector]', line: i + 1 };
    if (verb === 'add' && !values.comment) return { error: '"add" lines need a comment=… so the item can be found again', line: i + 1 };
    if (verb === 'add' && selector) return { error: '"add" lines do not take a selector', line: i + 1 };
    steps.push({ line: i + 1, path, selector, verb, values });
  }
  return { steps };
}

/** One OpenWrt template into steps, or { error, line }. */
export function parseOpenWrt(text) {
  const steps = [];
  const lines = String(text || '').split('\n');
  const NAME = '[a-zA-Z0-9_-]+';
  const SEC = `(?:${NAME}|@${NAME}\\[-?\\d+\\])`;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#')) continue;
    let m;
    if ((m = raw.match(new RegExp(`^set\\s+(${NAME})\\.(${SEC})=(${NAME})$`)))) steps.push({ line: i + 1, op: 'section', config: m[1], section: m[2], type: m[3] });
    else if ((m = raw.match(new RegExp(`^set\\s+(${NAME})\\.(${SEC})\\.(${NAME})=(.*)$`)))) steps.push({ line: i + 1, op: 'option', config: m[1], section: m[2], option: m[3], value: unquote(m[4]) });
    else if ((m = raw.match(new RegExp(`^add_list\\s+(${NAME})\\.(${SEC})\\.(${NAME})=(.*)$`)))) steps.push({ line: i + 1, op: 'list', config: m[1], section: m[2], option: m[3], value: unquote(m[4]) });
    else if ((m = raw.match(new RegExp(`^delete\\s+(${NAME})\\.(${SEC})(?:\\.(${NAME}))?$`)))) steps.push({ line: i + 1, op: 'delete', config: m[1], section: m[2], option: m[3] || null });
    else return { error: 'Expected: set config.section.option=value · set config.section=type · add_list … · delete …', line: i + 1 };
  }
  return { steps };
}
const unquote = (v) => { const s = String(v).trim(); return /^'.*'$|^".*"$/.test(s) ? s.slice(1, -1) : s; };

// ---- comparing with the router -----------------------------------------------------------------------

/** RouterOS reports yes/no as true/false and lists in its own order; compare like with like. */
export function sameRosValue(want, have) {
  const norm = (v) => {
    const s = String(v ?? '').trim().toLowerCase();
    if (s === 'yes' || s === 'true') return 'true';
    if (s === 'no' || s === 'false') return 'false';
    return s;
  };
  return norm(want) === norm(have);
}
const matches = (item, selector) => Object.entries(selector).every(([k, v]) => sameRosValue(v, item[k]));

/**
 * What a RouterOS step needs, given what the router has. `read(path)` resolves to the menu's JSON.
 * Returns [{ line, what, action, path, id?, body }] — empty when the router already matches.
 */
export async function diffRouterOS(steps, read) {
  const out = [];
  for (const s of steps) {
    const cur = await read(s.path);
    if (cur === undefined) { out.push({ line: s.line, what: `${s.path} is not on this router`, error: true }); continue; }
    if (s.verb === 'set' && !s.selector) {
      const obj = Array.isArray(cur) ? cur[0] || {} : cur || {};
      const diff = Object.fromEntries(Object.entries(s.values).filter(([k, v]) => !sameRosValue(v, obj[k])));
      if (Object.keys(diff).length) out.push({ line: s.line, what: `${s.path}: ${Object.keys(diff).map(k => `${k} is "${obj[k] ?? ''}", should be "${diff[k]}"`).join('; ')}`, action: 'set', path: s.path, body: diff });
    } else if (s.verb === 'set') {
      const hits = (Array.isArray(cur) ? cur : []).filter(x => matches(x, s.selector));
      if (!hits.length) { out.push({ line: s.line, what: `${s.path}: nothing matches [${Object.entries(s.selector).map(([k, v]) => k + '=' + v).join(',')}]`, error: true }); continue; }
      for (const h of hits) {
        const diff = Object.fromEntries(Object.entries(s.values).filter(([k, v]) => !sameRosValue(v, h[k])));
        if (Object.keys(diff).length) out.push({ line: s.line, what: `${s.path} ${h.name || h['.id']}: ${Object.keys(diff).map(k => `${k} should be "${diff[k]}"`).join('; ')}`, action: 'patch', path: s.path, id: h['.id'], body: diff });
      }
    } else {
      const hit = (Array.isArray(cur) ? cur : []).find(x => x.comment === s.values.comment);
      if (!hit) out.push({ line: s.line, what: `${s.path}: missing "${s.values.comment}"`, action: 'add', path: s.path, body: s.values });
      else {
        const diff = Object.fromEntries(Object.entries(s.values).filter(([k, v]) => !sameRosValue(v, hit[k])));
        if (Object.keys(diff).length) out.push({ line: s.line, what: `${s.path} "${s.values.comment}": ${Object.keys(diff).map(k => `${k} should be "${diff[k]}"`).join('; ')}`, action: 'patch', path: s.path, id: hit['.id'], body: diff });
      }
    }
  }
  return out;
}

/** Resolve "@type[n]" to the real section name, using UCI's .index ordering. */
export function resolveSection(values, section) {
  const m = String(section).match(/^@([a-zA-Z0-9_-]+)\[(-?\d+)\]$/);
  if (!m) return section;
  const list = Object.entries(values || {}).filter(([, s]) => s['.type'] === m[1]).sort((a, b) => (a[1]['.index'] ?? 0) - (b[1]['.index'] ?? 0));
  const i = Number(m[2]);
  const hit = list[i < 0 ? list.length + i : i];
  return hit ? hit[0] : null;
}

/**
 * What OpenWrt steps need, given `configs` = { firewall: {…uci values…}, … }.
 * Returns [{ line, what, op }] where op is ready for the driver's stageApply.
 */
export function diffOpenWrt(steps, configs) {
  const out = [];
  const listOf = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [String(v)]);
  // A working copy, so a section created by an earlier line exists for the lines after it.
  const work = JSON.parse(JSON.stringify(configs || {}));
  for (const s of steps) {
    const vals = work[s.config];
    if (!vals) { out.push({ line: s.line, what: `config "${s.config}" is not on this router`, error: true }); continue; }
    const name = resolveSection(vals, s.section);
    if (!name) { out.push({ line: s.line, what: `${s.config}.${s.section} does not exist`, error: true }); continue; }
    const sec = vals[name];
    if (s.op === 'section') {
      if (!sec) {
        out.push({ line: s.line, what: `${s.config}.${name} missing`, op: { op: 'add', config: s.config, type: s.type, name, values: {} } });
        vals[name] = { '.type': s.type };
      } else if (sec['.type'] !== s.type) out.push({ line: s.line, what: `${s.config}.${name} is a ${sec['.type']}, should be a ${s.type}`, error: true });
    } else if (s.op === 'option') {
      if (!sec) { out.push({ line: s.line, what: `${s.config}.${name} does not exist — add "set ${s.config}.${name}=<type>" above this line`, error: true }); continue; }
      const have = sec[s.option];
      if (String(Array.isArray(have) ? have.join(' ') : have ?? '') !== s.value) {
        out.push({ line: s.line, what: `${s.config}.${name}.${s.option} is "${have ?? ''}", should be "${s.value}"`, op: { op: 'set', config: s.config, section: name, values: { [s.option]: s.value } } });
        sec[s.option] = s.value;
      }
    } else if (s.op === 'list') {
      if (!sec) { out.push({ line: s.line, what: `${s.config}.${name} does not exist`, error: true }); continue; }
      const have = listOf(sec[s.option]);
      if (!have.includes(s.value)) {
        out.push({ line: s.line, what: `${s.config}.${name}.${s.option} lacks "${s.value}"`, op: { op: 'set', config: s.config, section: name, values: { [s.option]: [...have, s.value] } } });
        sec[s.option] = [...have, s.value];
      }
    } else if (s.op === 'delete') {
      if (s.option ? (sec && sec[s.option] !== undefined) : !!sec) {
        out.push({ line: s.line, what: `${s.config}.${name}${s.option ? '.' + s.option : ''} should not exist`,
          op: { op: 'delete', config: s.config, section: name, ...(s.option ? { option: s.option } : {}) } });
        if (s.option) delete sec[s.option]; else delete vals[name];
      }
    }
  }
  return out;
}
