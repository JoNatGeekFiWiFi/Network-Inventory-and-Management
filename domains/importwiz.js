// Spreadsheet import wizard: upload → see what we think each row means → approve or correct → apply.
//
// The design principle is that nothing is guessed silently. Analysis produces a PLAN — for every
// row, which records would be created, which existing ones matched, and what would change — and
// the plan is shown before anything is written. Bulk-loading years of hand-kept spreadsheets is
// where one bad assumption becomes several hundred wrong records in a single click.
//
// Everything an import writes is tagged with its batch, so a run can be undone.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { loadTable } from '../lib/tabular.js';
import { detectColumns, FIELDS, SECRET_FIELDS, maskSecret } from '../lib/colmap.js';
import { addressKey, unitFromAddress } from '../lib/address.js';
import { excelDateToISO } from '../lib/xlsx.js';
import { normalizeMac, normalizeDueDay, normalizeBool, normalizeMoney, normalizePlan, normalizeName } from '../lib/normalize.js';
import { TEMPLATES, buildTemplate } from '../lib/templates.js';
import { contentDisposition } from '../lib/core.js';

const MAX_BYTES = 24 * 1024 * 1024;
const MAX_ROWS = 5000;
// Staged uploads live in memory between analyse and commit, so the file isn't re-sent and the
// plan the user approved is exactly the one applied.
const STAGE_TTL_MS = 45 * 60 * 1000;
const staged = new Map();

function stash(data) {
  const token = randomUUID();
  staged.set(token, { ...data, at: Date.now() });
  const now = Date.now();
  for (const [k, v] of staged) if (now - v.at > STAGE_TTL_MS) staged.delete(k);
  return token;
}
export default function registerImportWizard(app, ctx) {
  const { db, N, requireNoc, audit, normPhone } = ctx;

  const low = v => String(v ?? '').trim().toLowerCase();
  const macKey = v => String(v ?? '').trim().toUpperCase().replace(/-/g, ':');

  /**
   * Identity keys, shared by the preview and the commit so they can never disagree.
   *
   * These also drive the within-run memo. Resolving only against the database as it stood before
   * the import means row 2 cannot see what row 1 just created — so a sheet listing the same
   * building or account on twenty rows produces twenty of them. That is the single most likely
   * way a bulk import goes wrong, and it is exactly the duplication the address matching exists
   * to prevent.
   */
  const K = {
    carrier: v => 'carrier|' + low(v),
    account: (name, num) => 'account|' + (num ? '#' + low(num) : low(name)),
    sub: (acctKey, name) => 'sub|' + acctKey + '|' + low(name),
    site: (addr, name) => 'site|' + (addressKey(addr) || 'name:' + low(name)),
    unit: (siteKey, label) => 'unit|' + siteKey + '|' + low(label),
    customer: v => 'customer|' + low(v),
    device: (serial, mac) => 'device|' + (serial ? 'sn:' + low(serial) : 'mac:' + macKey(mac))
  };

  // Reference data shared by every row. Two rows naming "Cox" always mean one Cox, so these are
  // never duplicated even when a row is explicitly set to "create".
  const SHARED = new Set(['carrier', 'account', 'subaccount']);


  /** Pull the mapped fields out of one row. */
  function extract(row, mapping) {
    const out = {};
    for (const [colIndex, field] of Object.entries(mapping)) {
      if (!field) continue;
      const v = String(row[Number(colIndex)] ?? '').trim();
      if (v !== '') out[field] = v;
    }
    // A single address column often carries the city/state too; if they're separate, join them
    // so address matching sees the same string a person would type.
    if (out.service_address) {
      const extra = [out.city, out.state, out.postal].filter(Boolean).join(' ');
      if (extra && !out.service_address.toLowerCase().includes(String(out.city || '').toLowerCase()))
        out.service_address = out.service_address + ', ' + extra;
    }
    // Tidy the values people actually type, so the same thing spelled two ways lands once.
    if (out.mac) out.mac = normalizeMac(out.mac);
    if (out.customer_name) out.customer_name = normalizeName(out.customer_name);
    if (out.bandwidth) out.bandwidth = normalizePlan(out.bandwidth);
    // Excel hands dates over as day counts.
    if (out.install_date && /^\d{5}$/.test(out.install_date))
      out.install_date = excelDateToISO(out.install_date) || out.install_date;
    // A unit spelled inside the address counts, when there's no column of its own.
    if (!out.unit && out.service_address) {
      const u = unitFromAddress(out.service_address);
      if (u) out.unit = u;
    }
    return out;
  }

  // ---- resolvers: what does this value already correspond to? ----
  const findCarrier = name => name ? db.prepare('SELECT id, name FROM upstream_providers WHERE LOWER(name)=LOWER(TRIM(?))').get(name) : null;
  const findAccount = (name, number) => {
    if (number) { const a = db.prepare('SELECT * FROM accounts WHERE account_number IS NOT NULL AND TRIM(account_number)=TRIM(?)').get(number); if (a) return a; }
    return name ? db.prepare('SELECT * FROM accounts WHERE LOWER(name)=LOWER(TRIM(?))').get(name) : null;
  };
  const findSub = (accountId, name) => (accountId && name)
    ? db.prepare('SELECT * FROM account_subaccounts WHERE account_id=? AND LOWER(name)=LOWER(TRIM(?))').get(accountId, name) : null;
  const findSiteByAddr = addr => {
    const key = addressKey(addr);
    return key ? db.prepare('SELECT * FROM sites WHERE addr_key=? ORDER BY id LIMIT 1').get(key) : null;
  };
  const findSiteByName = name => name ? db.prepare('SELECT * FROM sites WHERE LOWER(name)=LOWER(TRIM(?)) ORDER BY id LIMIT 1').get(name) : null;
  const findUnit = (siteId, label) => (siteId && label)
    ? db.prepare('SELECT * FROM site_units WHERE site_id=? AND LOWER(label)=LOWER(TRIM(?))').get(siteId, label) : null;
  const findCustomer = name => name ? db.prepare('SELECT * FROM customers WHERE LOWER(name)=LOWER(TRIM(?)) ORDER BY id LIMIT 1').get(name) : null;
  const findDevice = (serial, mac) => {
    if (serial) { const d = db.prepare('SELECT * FROM devices WHERE serial IS NOT NULL AND UPPER(TRIM(serial))=UPPER(TRIM(?))').get(serial); if (d) return d; }
    if (mac) { const d = db.prepare('SELECT * FROM devices WHERE mac IS NOT NULL AND UPPER(REPLACE(mac,\'-\',\':\'))=UPPER(REPLACE(TRIM(?),\'-\',\':\'))').get(mac); if (d) return d; }
    return null;
  };
  const findModel = name => name
    ? db.prepare("SELECT id, manufacturer, model FROM device_models WHERE LOWER(manufacturer || ' ' || model)=LOWER(TRIM(?)) OR LOWER(model)=LOWER(TRIM(?)) LIMIT 1").get(name, name) : null;

  /**
   * Work out what one row would do.
   *
   * `matches` is what already exists; `plan` is what each entity would become. Rows that match
   * something are flagged so the person can decide, rather than the importer deciding for them.
   */
  function planRow(vals, memo, seenInFile) {
    const p = { entities: [], matched: false, issues: [] };
    // state: 'existing' (already in the system) | 'run' (made by an earlier row of this file) | 'new'
    const push = (entity, label, state, existingId, extra) =>
      p.entities.push({ entity, label, state, existing_id: existingId || null, ...extra });

    const resolve = (entity, key, label, lookup, extra) => {
      if (memo.has(key)) { push(entity, label, 'run', null, extra); return { key, state: 'run' }; }
      const hit = lookup();
      if (hit) { push(entity, label, 'existing', hit.id, extra); if (!SHARED.has(entity)) p.matched = true; return { key, state: 'existing', row: hit }; }
      memo.set(key, true);
      push(entity, label, 'new', null, extra);
      return { key, state: 'new' };
    };

    let carrierKey = null;
    if (vals.carrier) carrierKey = resolve('carrier', K.carrier(vals.carrier), vals.carrier, () => findCarrier(vals.carrier)).key;

    let accountKey = null, account = null;
    if (vals.account_name || vals.account_number) {
      const r = resolve('account', K.account(vals.account_name, vals.account_number),
        vals.account_name || ('#' + vals.account_number), () => findAccount(vals.account_name, vals.account_number));
      accountKey = r.key; account = r.row || null;
    }
    if (vals.subaccount && accountKey)
      resolve('subaccount', K.sub(accountKey, vals.subaccount), vals.subaccount, () => account ? findSub(account.id, vals.subaccount) : null);

    let siteKey = null;
    if (vals.service_address || vals.site_name) {
      let matchedOn = null;
      const r = resolve('site', K.site(vals.service_address, vals.site_name), vals.site_name || vals.service_address, () => {
        const byAddr = findSiteByAddr(vals.service_address);
        if (byAddr) { matchedOn = 'address'; return byAddr; }
        const byName = findSiteByName(vals.site_name);
        if (byName) { matchedOn = 'name'; return byName; }
        return null;
      });
      siteKey = r.key;
      if (matchedOn) p.entities[p.entities.length - 1].matched_on = matchedOn;
      if (!vals.service_address) p.issues.push('no address — this site can only be matched by name');
    }

    if (vals.unit && siteKey) {
      const site = memo.has(siteKey) ? null : findSiteByAddr(vals.service_address) || findSiteByName(vals.site_name);
      resolve('unit', K.unit(siteKey, vals.unit), vals.unit, () => site ? findUnit(site.id, vals.unit) : null);
    }

    if (vals.customer_name) {
      resolve('customer', K.customer(vals.customer_name), vals.customer_name, () => findCustomer(vals.customer_name));
      const k = low(vals.customer_name);
      if (seenInFile.customer.has(k)) p.issues.push('this customer name appears earlier in the file');
      seenInFile.customer.add(k);
    }

    if (vals.serial || vals.mac || vals.device_name) {
      resolve('device', K.device(vals.serial, vals.mac), vals.device_name || vals.serial || vals.mac,
        () => findDevice(vals.serial, vals.mac));
      if (vals.device_model && !findModel(vals.device_model))
        p.issues.push(`model "${vals.device_model}" isn't in the catalogue — the device will be created without one`);
    }

    if (vals.monthly_revenue && vals.customer_name)
      p.entities.push({ entity: 'billing', label: '$' + vals.monthly_revenue + '/mo', state: 'new', existing_id: null });
    if (vals.monthly_cost && !vals.monthly_revenue)
      p.issues.push('cost but no sell price — P&L will show this account at a full loss');
    if (!p.entities.length) p.issues.push('nothing recognised in this row');
    if (vals.customer_name && !vals.service_address && !vals.site_name)
      p.issues.push('customer has no address, so no site will be created');
    return p;
  }

  // ---- templates ----
  app.get('/api/import/templates', requireNoc, (req, res) =>
    res.json(TEMPLATES.map(t => ({ key: t.key, label: t.label, columns: t.headers.length }))));

  app.get('/api/import/template/:key', requireNoc, (req, res) => {
    const t = buildTemplate(String(req.params.key));
    if (!t) return res.status(404).json({ error: 'No such template' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', contentDisposition(t.filename));
    res.send(t.buffer);
  });

  // ---- analyse ----
  const rawUpload = express.raw({ type: () => true, limit: MAX_BYTES });
  app.post('/api/import/analyze', requireNoc, rawUpload, (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length)
      return res.status(400).json({ error: 'No file content received' });

    let table;
    try {
      table = loadTable(req.body, {
        sheet: req.query.sheet,
        headerRow: req.query.headerRow !== undefined && req.query.headerRow !== '' ? Number(req.query.headerRow) : undefined,
        delimiter: req.query.delimiter || undefined,
        maxRows: MAX_ROWS + 50
      });
    } catch (e) { return res.status(400).json({ error: e.message }); }

    if (!table.rows.length) return res.status(400).json({ error: 'That file has headers but no data rows' });
    if (table.rows.length > MAX_ROWS)
      return res.status(413).json({ error: `That file has ${table.rows.length} rows; the wizard handles up to ${MAX_ROWS}. Split it and import in parts.` });

    // Either the mapping the user has corrected, or our guess.
    let mapping = {};
    let columns = detectColumns(table.headers, table.rows);
    if (req.query.mapping) {
      try { mapping = JSON.parse(req.query.mapping); } catch {}
      columns = columns.map(c => ({ ...c, field: mapping[c.index] !== undefined ? mapping[c.index] : c.field }));
    }
    for (const c of columns) mapping[c.index] = c.field || null;

    // Columns holding credentials, so their values can be masked everywhere they'd be displayed.
    const secretCols = new Set(Object.entries(mapping)
      .filter(([, f]) => SECRET_FIELDS.has(f)).map(([i]) => Number(i)));
    const redactRow = r => secretCols.size ? r.map((v, i) => secretCols.has(i) ? maskSecret(v) : v) : r;
    const redactVals = v => {
      if (!secretCols.size) return v;
      const o = { ...v };
      for (const f of SECRET_FIELDS) if (o[f]) o[f] = maskSecret(o[f]);
      return o;
    };

    const seen = { customer: new Set(), device: new Set() };
    const memo = new Map();          // what earlier rows of THIS file already account for
    const rows = table.rows.map((r, i) => {
      const vals = extract(r, mapping);
      const plan = planRow(vals, memo, seen);
      return {
        index: i, raw: r, values: vals,
        entities: plan.entities, matched: plan.matched, issues: plan.issues,
        // Matched rows default to attaching, which never overwrites. Anything else is a choice
        // the person has to make deliberately.
        action: plan.entities.length ? (plan.matched ? 'attach' : 'create') : 'skip'
      };
    });

    // The stash keeps the true values — it is what the commit applies. Only the response is
    // masked. Redacting before stashing would write "••••••••" into the password field, which is
    // worse than not importing it at all: it looks set, and nobody can sign in.
    const token = stash({ filename: String(req.query.filename || '').slice(0, 200), table, mapping, rows });
    const safeRows = rows.slice(0, 500).map(r => ({ ...r, raw: redactRow(r.raw), values: redactVals(r.values) }));
    res.json({
      token,
      filename: String(req.query.filename || '') || null,
      format: table.format, sheets: table.sheets, sheet: table.sheet,
      headerRow: table.headerRow, headers: table.headers,
      columns: columns.map(c => secretCols.has(c.index) || SECRET_FIELDS.has(c.field)
        ? { ...c, samples: (c.samples || []).map(maskSecret), secret: true } : c),
      fields: FIELDS.map(f => ({ key: f.key, label: f.label, group: f.group })),
      total: rows.length,
      summary: {
        matched: rows.filter(r => r.matched).length,
        clean: rows.filter(r => !r.matched && r.entities.length).length,
        issues: rows.filter(r => r.issues.length).length,
        unusable: rows.filter(r => !r.entities.length).length
      },
      rows: safeRows               // the UI pages; the full set stays staged server-side
    });
  });

  // ---- commit ----
  app.post('/api/import/commit', requireNoc, (req, res) => {
    const b = req.body || {};
    const st = staged.get(String(b.token || ''));
    if (!st) return res.status(410).json({ error: 'That preview has expired — upload the file again.' });

    // Per-row decisions from the UI, defaulting to what analysis proposed.
    const actions = b.actions || {};
    const counts = { created: 0, attached: 0, updated: 0, skipped: 0 };
    const tally = { carrier: 0, account: 0, subaccount: 0, site: 0, unit: 0, customer: 0, device: 0, billing: 0 };

    let batchId;
    db.exec('BEGIN');
    try {
      batchId = db.prepare(`INSERT INTO import_batches (filename, format, sheet, row_count, mapping_json, actor)
        VALUES (?,?,?,?,?,?)`).run(st.filename || null, st.table.format, st.table.sheet || null,
        st.rows.length, JSON.stringify(st.mapping), (req.user && req.user.email) || null).lastInsertRowid;

      const track = db.prepare('INSERT INTO import_records (batch_id, entity, entity_id, action, before_json) VALUES (?,?,?,?,?)');
      const created = (entity, id) => { track.run(batchId, entity, id, 'created', null); tally[entity]++; counts.created++; };
      const updated = (entity, id, before) => { track.run(batchId, entity, id, 'updated', JSON.stringify(before)); counts.updated++; };

      // What this run has already made, keyed exactly as the preview keyed it.
      const made = new Map();

      /**
       * Resolve one entity for one row.
       *
       * The memo always wins: an import never duplicates itself, even on a row set to "create" —
       * that decision is about records which existed *before* the run, not about the file. And
       * shared reference data is never forced, because twenty rows naming Cox mean one Cox.
       */
      const ensure = (entity, key, force, lookup, create) => {
        if (made.has(key)) return { id: made.get(key), row: null, fresh: false };
        const hit = (force && !SHARED.has(entity)) ? null : lookup();
        if (hit) { made.set(key, hit.id); return { id: hit.id, row: hit, fresh: false }; }
        const id = create();
        made.set(key, id); created(entity, id);
        return { id, row: null, fresh: true };
      };

      for (const row of st.rows) {
        const action = actions[row.index] || row.action;
        if (action === 'skip' || !row.entities.length) { counts.skipped++; continue; }
        const v = row.values;
        const force = action === 'create';
        const overwrite = action === 'update';

        // carrier
        let carrierId = null;
        if (v.carrier) {
          carrierId = ensure('carrier', K.carrier(v.carrier), force,
            () => findCarrier(v.carrier),
            () => db.prepare('INSERT INTO upstream_providers (name, provider_type) VALUES (?,?)')
              .run(v.carrier.slice(0, 80), 'Carrier').lastInsertRowid).id;
        }

        // account
        let accountId = null, accountKey = null;
        if (v.account_name || v.account_number) {
          accountKey = K.account(v.account_name, v.account_number);
          const r = ensure('account', accountKey, force,
            () => findAccount(v.account_name, v.account_number),
            () => db.prepare(`INSERT INTO accounts (name, account_number, status, carrier_id, billing_address,
                due_day, autopay, payment_method, plan, portal_username, portal_password, pin, monthly_cost)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
              .run((v.account_name || v.account_number).slice(0, 160), v.account_number || null, 'Active', carrierId,
                v.billing_address || null, normalizeDueDay(v.due_day), normalizeBool(v.autopay),
                v.payment_method || null, v.bandwidth || null,
                v.portal_username || null, v.portal_password || null, v.account_pin || null,
                normalizeMoney(v.monthly_cost)).lastInsertRowid);
          accountId = r.id;
          const ex = r.row;
          if (ex && overwrite) {
            updated('account', ex.id, { name: ex.name, account_number: ex.account_number, carrier_id: ex.carrier_id });
            db.prepare('UPDATE accounts SET name=?, account_number=?, carrier_id=? WHERE id=?')
              .run(v.account_name || ex.name, v.account_number || ex.account_number, carrierId || ex.carrier_id, ex.id);
          } else if (ex && carrierId && !ex.carrier_id) {
            // Filling a blank is not overwriting, and it is the whole point of the import.
            updated('account', ex.id, { carrier_id: ex.carrier_id });
            db.prepare('UPDATE accounts SET carrier_id=? WHERE id=?').run(carrierId, ex.id);
          }

          // The carrier-account detail: portal login, billing day, plan and so on.
          //
          // On "update" the sheet wins; otherwise only blanks are filled. Credentials are held to
          // the stricter rule either way — silently replacing a password that someone has since
          // rotated in the portal would lock the team out of the account with no trace of why.
          if (ex) {
            const DETAIL = { billing_address: v.billing_address, payment_method: v.payment_method,
              plan: v.bandwidth, portal_username: v.portal_username,
              due_day: normalizeDueDay(v.due_day), autopay: normalizeBool(v.autopay) };
            const SECRET = { portal_password: v.portal_password, pin: v.account_pin };
            const before = {}, sets = [], args = [];
            for (const [col, val] of Object.entries(DETAIL))
              if (val != null && val !== '' && (overwrite || ex[col] == null || ex[col] === '')) { before[col] = ex[col]; sets.push(col + '=?'); args.push(val); }
            for (const [col, val] of Object.entries(SECRET))
              if (val != null && val !== '' && (ex[col] == null || ex[col] === '')) { before[col] = ex[col]; sets.push(col + '=?'); args.push(val); }
            if (sets.length) {
              updated('account', ex.id, before);
              db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id=?`).run(...args, ex.id);
            }
          }
        }

        // sub-account
        let subId = null;
        if (v.subaccount && accountId) {
          subId = ensure('subaccount', K.sub(accountKey, v.subaccount), force,
            () => findSub(accountId, v.subaccount),
            () => db.prepare('INSERT INTO account_subaccounts (account_id, name, status) VALUES (?,?,?)')
              .run(accountId, v.subaccount.slice(0, 80), 'active').lastInsertRowid).id;
        }

        // customer
        let customerId = null;
        if (v.customer_name) {
          const r = ensure('customer', K.customer(v.customer_name), force,
            () => findCustomer(v.customer_name),
            () => db.prepare('INSERT INTO customers (account_id,name,status,billing_email,sms_number,notes) VALUES (?,?,?,?,?,?)')
              .run(accountId || null, v.customer_name.slice(0, 160), v.status || 'Active',
                v.customer_email || null, (v.customer_phone && normPhone(v.customer_phone)) || null, v.notes || null).lastInsertRowid);
          customerId = r.id;
          const ex = r.row;
          if (ex && overwrite) {
            updated('customer', ex.id, { name: ex.name, billing_email: ex.billing_email, sms_number: ex.sms_number, status: ex.status });
            db.prepare('UPDATE customers SET name=?, billing_email=?, sms_number=?, status=? WHERE id=?')
              .run(v.customer_name, v.customer_email || ex.billing_email,
                (v.customer_phone && normPhone(v.customer_phone)) || ex.sms_number, v.status || ex.status, ex.id);
          }
          if (accountId) db.prepare('INSERT OR IGNORE INTO account_customers (account_id, customer_id, subaccount_id) VALUES (?,?,?)').run(accountId, customerId, subId);
        }

        // site
        let siteId = null, siteKey = null;
        if (v.service_address || v.site_name) {
          siteKey = K.site(v.service_address, v.site_name);
          const acct = accountId || (customerId && db.prepare('SELECT account_id FROM account_customers WHERE customer_id=? LIMIT 1').get(customerId)?.account_id) || null;
          const addr = v.service_address || null;
          const r = acct ? ensure('site', siteKey, force,
            () => findSiteByAddr(v.service_address) || findSiteByName(v.site_name),
            () => db.prepare('INSERT INTO sites (account_id,customer_id,name,service_address,lat,lng,status,subaccount_id,addr_key) VALUES (?,?,?,?,?,?,?,?,?)')
              .run(acct, v.unit ? null : customerId, (v.site_name || addr || 'Imported site').slice(0, 160), addr,
                v.lat ? Number(v.lat) : null, v.lng ? Number(v.lng) : null, 'Active',
                // A tenant's sub-account belongs to their unit, not to the building. Stamping it on
                // the site makes every later tenant look like they're on the first one's sub-account.
                v.unit ? null : subId, addressKey(addr) || null).lastInsertRowid)
            : { id: null, row: null };
          siteId = r.id;
          const ex = r.row;
          if (ex && overwrite) {
            updated('site', ex.id, { name: ex.name, service_address: ex.service_address, customer_id: ex.customer_id, subaccount_id: ex.subaccount_id, addr_key: ex.addr_key });
            db.prepare('UPDATE sites SET name=?, service_address=?, addr_key=?, customer_id=?, subaccount_id=? WHERE id=?')
              .run(v.site_name || ex.name, addr || ex.service_address,
                addressKey(addr || ex.service_address) || null,
                (v.unit ? ex.customer_id : (customerId || ex.customer_id)),
                (v.unit ? ex.subaccount_id : (subId || ex.subaccount_id)), ex.id);
          }
        }

        // unit — the building belongs to no single customer, the unit does
        let unitId = null;
        if (v.unit && siteId) {
          const r = ensure('unit', K.unit(siteKey, v.unit), force,
            () => findUnit(siteId, v.unit),
            () => {
              const id = db.prepare('INSERT INTO site_units (site_id,label,customer_id,status) VALUES (?,?,?,?)')
                .run(siteId, v.unit.slice(0, 60), customerId || null, 'Active').lastInsertRowid;
              db.prepare('UPDATE sites SET is_mdu=1 WHERE id=?').run(siteId);
              return id;
            });
          unitId = r.id;
          const ex = r.row;
          if (ex && customerId && (overwrite || !ex.customer_id)) {
            updated('unit', ex.id, { customer_id: ex.customer_id });
            db.prepare('UPDATE site_units SET customer_id=? WHERE id=?').run(customerId, ex.id);
          }
          // A second tenant makes the building an MDU even if the site already existed.
          if (siteId) db.prepare('UPDATE sites SET is_mdu=1 WHERE id=? AND (SELECT COUNT(*) FROM site_units WHERE site_id=?)>0').run(siteId, siteId);
        }

        // device
        if (v.serial || v.mac || v.device_name) {
          const model = v.device_model ? findModel(v.device_model) : null;
          const r = ensure('device', K.device(v.serial, v.mac), force,
            () => findDevice(v.serial, v.mac),
            () => db.prepare(`INSERT INTO devices (name, model_id, serial, mac, status, online, management_mode, assigned_type, assigned_site_id, unit_id, ownership, owner_org, carrier_id, owner_subaccount_id, account_number, owner_account)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
              .run((v.device_name || v.serial || v.mac).slice(0, 160), model ? model.id : null,
                v.serial || null, v.mac || null, 'Deployed', 0, 'platform',
                siteId ? 'site' : 'stock', siteId || null, unitId || null,
                carrierId ? 'carrier' : 'us', v.carrier || null, carrierId, subId,
                v.account_number || null, v.account_name || v.account_number || null).lastInsertRowid);
          const ex = r.row;
          if (ex && overwrite) {
            updated('device', ex.id, { name: ex.name, serial: ex.serial, mac: ex.mac, assigned_type: ex.assigned_type, assigned_site_id: ex.assigned_site_id, unit_id: ex.unit_id, carrier_id: ex.carrier_id, owner_subaccount_id: ex.owner_subaccount_id });
            db.prepare('UPDATE devices SET name=?, serial=?, mac=?, assigned_type=?, assigned_site_id=?, unit_id=?, carrier_id=?, owner_subaccount_id=? WHERE id=?')
              .run(v.device_name || ex.name, v.serial || ex.serial, v.mac || ex.mac,
                siteId ? 'site' : ex.assigned_type, siteId || ex.assigned_site_id, unitId || ex.unit_id,
                carrierId || ex.carrier_id, subId || ex.owner_subaccount_id, ex.id);
          } else if (ex && siteId && !ex.assigned_site_id) {
            updated('device', ex.id, { assigned_type: ex.assigned_type, assigned_site_id: ex.assigned_site_id, unit_id: ex.unit_id });
            db.prepare("UPDATE devices SET assigned_type='site', assigned_site_id=?, unit_id=? WHERE id=?").run(siteId, unitId, ex.id);
          }
        }

        // What it costs us — on the account, which is where P&L reads cost from.
        if (accountId && v.monthly_cost != null) {
          const c = normalizeMoney(v.monthly_cost);
          const ex = db.prepare('SELECT monthly_cost FROM accounts WHERE id=?').get(accountId);
          if (c != null && ex && (overwrite || ex.monthly_cost == null)) {
            updated('account', accountId, { monthly_cost: ex.monthly_cost });
            db.prepare('UPDATE accounts SET monthly_cost=? WHERE id=?').run(c, accountId);
          }
        }

        // What we bill them. P&L derives revenue from recurring billing lines, not from a column,
        // so a sell price has to become one or the margin silently reads as -100%.
        if (customerId && v.monthly_revenue != null) {
          const price = normalizeMoney(v.monthly_revenue);
          const existing = db.prepare('SELECT id FROM bill_recurring WHERE customer_id=? AND active=1').get(customerId);
          if (price != null && price > 0 && !existing) {
            const items = JSON.stringify([{ description: v.bandwidth || 'Monthly internet service', quantity: 1, unit_price: price, taxable: 1 }]);
            const id = db.prepare(`INSERT INTO bill_recurring (customer_id, frequency, next_date, tax_rate, items_json, auto_send, active)
              VALUES (?, 'monthly', date('now','start of month','+1 month'), 0, ?, 0, 1)`).run(customerId, items).lastInsertRowid;
            created('billing', id);
          }
        }

        if (row.matched && action === 'attach') counts.attached++;
      }

      db.prepare('UPDATE import_batches SET created_count=?, attached_count=?, updated_count=?, skipped_count=? WHERE id=?')
        .run(counts.created, counts.attached, counts.updated, counts.skipped, batchId);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      return res.status(500).json({ error: 'Import failed and nothing was written: ' + e.message });
    }

    staged.delete(String(b.token));
    audit(req, 'import', 'import_batch#' + batchId, st.filename || '');
    res.json({ batch_id: batchId, counts, tally });
  });

  // ---- history + undo ----
  app.get('/api/imports', requireNoc, (req, res) => {
    res.json(db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM import_records r WHERE r.batch_id=b.id) AS record_count
      FROM import_batches b ORDER BY datetime(b.created_at) DESC, b.id DESC LIMIT 100`).all());
  });

  app.get('/api/imports/:id', requireNoc, (req, res) => {
    const b = db.prepare('SELECT * FROM import_batches WHERE id=?').get(req.params.id);
    if (!b) return res.status(404).json({ error: 'not found' });
    b.records = db.prepare('SELECT entity, entity_id, action FROM import_records WHERE batch_id=? ORDER BY id').all(b.id);
    res.json(b);
  });

  /**
   * Reverse a batch.
   *
   * Created records are deleted; updated ones are put back. Deletion runs child-first so a
   * foreign key never blocks it, and anything since referenced by a record the import did NOT
   * create is left alone and reported — quietly deleting a site someone has since attached live
   * service to would be far worse than a partial undo.
   */
  app.post('/api/imports/:id/undo', requireNoc, (req, res) => {
    const b = db.prepare('SELECT * FROM import_batches WHERE id=?').get(req.params.id);
    if (!b) return res.status(404).json({ error: 'not found' });
    if (b.status === 'undone') return res.status(409).json({ error: 'That import has already been undone' });

    const recs = db.prepare('SELECT * FROM import_records WHERE batch_id=? ORDER BY id DESC').all(b.id);
    const mine = new Set(recs.filter(r => r.action === 'created').map(r => r.entity + '#' + r.entity_id));
    const kept = [];
    let removed = 0, restored = 0;

    db.exec('BEGIN');
    try {
      // Undo updates first, so a restored value isn't lost with a row we then delete.
      for (const r of recs.filter(x => x.action === 'updated')) {
        let before = null; try { before = JSON.parse(r.before_json); } catch {}
        if (!before) continue;
        const table = { account: 'accounts', customer: 'customers', site: 'sites', unit: 'site_units', device: 'devices' }[r.entity];
        if (!table) continue;
        const cols = Object.keys(before);
        if (!cols.length) continue;
        db.prepare(`UPDATE ${table} SET ${cols.map(c => c + '=?').join(', ')} WHERE id=?`).run(...cols.map(c => before[c]), r.entity_id);
        restored++;
      }

      // Then deletions, children before parents.
      //
      // Because children go first, a plain count of what still references a record is the whole
      // blocker test: anything left is either older than the import or was deliberately kept.
      // Excluding this batch's own rows (the obvious way to write it) is wrong — it would delete
      // an account whose site we had just chosen to keep, and the site would go with it.
      const order = ['billing', 'device', 'unit', 'site', 'customer', 'subaccount', 'account', 'carrier'];
      const BLOCKERS = {
        site: [['site_units', 'site_id', 'units'], ['devices', 'assigned_site_id', 'devices']],
        unit: [['devices', 'unit_id', 'devices']],
        customer: [['sites', 'customer_id', 'sites'], ['site_units', 'customer_id', 'units']],
        subaccount: [['sites', 'subaccount_id', 'sites'], ['devices', 'owner_subaccount_id', 'devices'],
                     ['account_customers', 'subaccount_id', 'customers']],
        account: [['sites', 'account_id', 'sites'], ['customers', 'account_id', 'customers'],
                  ['account_subaccounts', 'account_id', 'sub-accounts']],
        carrier: [['accounts', 'carrier_id', 'accounts'], ['devices', 'carrier_id', 'devices']]
      };
      const TABLE = { carrier: 'upstream_providers', account: 'accounts', subaccount: 'account_subaccounts',
        customer: 'customers', site: 'sites', unit: 'site_units', device: 'devices', billing: 'bill_recurring' };

      for (const e of order) {
        for (const r of recs.filter(x => x.action === 'created' && x.entity === e)) {
          const id = r.entity_id;
          const still = [];
          for (const [table, col, noun] of (BLOCKERS[e] || [])) {
            const n = db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${col}=?`).get(id).n;
            if (n) still.push(`${n} ${noun}`);
          }
          if (still.length) { kept.push({ entity: e, id, why: 'still has ' + still.join(' and ') }); continue; }

          const table = TABLE[e];
          if (!table) continue;
          if (e === 'customer') db.prepare('DELETE FROM account_customers WHERE customer_id=?').run(id);
          try { db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id); removed++; }
          catch { kept.push({ entity: e, id, why: 'still referenced elsewhere' }); }
        }
      }

      db.prepare("UPDATE import_batches SET status='undone', undone_at=datetime('now') WHERE id=?").run(b.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      return res.status(500).json({ error: 'Undo failed and nothing was changed: ' + e.message });
    }

    audit(req, 'import_undo', 'import_batch#' + b.id, b.filename || '');
    res.json({ ok: true, removed, restored, kept });
  });
}
