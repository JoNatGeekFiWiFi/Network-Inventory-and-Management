// The spreadsheet import wizard: reading a file, planning each row, applying it, undoing it.
//
// The cases that matter most here are the quiet ones. A bulk import that duplicates a building,
// overwrites a good record with a blank, or can't be reversed does its damage silently and at
// scale, so those are tested harder than the happy path.
import { loadTable, parseDelimited, sniffDelimiter, findHeaderRow } from '../lib/tabular.js';
import { detectColumns } from '../lib/colmap.js';
import { readXlsx, looksLikeXlsx, excelDateToISO } from '../lib/xlsx.js';
import { deflateRawSync } from 'node:zlib';

const B = process.env.BASE ?? 'http://localhost:3000'; let cookie = '';
async function call(p, { method = 'GET', body } = {}) { const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; } if (cookie) h.cookie = cookie; const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, t }; }
async function upload(p, buf) { const h = { 'content-type': 'application/octet-stream' }; if (cookie) h.cookie = cookie; const r = await fetch(B + p, { method: 'POST', headers: h, body: buf }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, t }; }
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

// ---- parsing (pure) ----
{
  const r = parseDelimited('a,"b,c",d\n1,"say ""hi""",3\n', ',');
  ok(r[0].length === 3 && r[0][1] === 'b,c', 'a quoted comma stays inside one field');
  ok(r[1][1] === 'say "hi"', 'a doubled quote becomes one literal quote');

  const nl = parseDelimited('name,addr\nBob,"12 Oak\nTempe AZ"\n', ',');
  ok(nl.length === 2 && nl[1][1].includes('\n'), 'a newline inside quotes does not start a new row');

  // Counting commas would pick "," here even though the file is tab-separated.
  ok(sniffDelimiter('a\tb\tc\n"x, y"\tz, w\tq\n') === '\t', 'delimiter sniffing is not fooled by commas inside fields');
  ok(sniffDelimiter('name,addr\nBob,"1 Oak St, Tempe, AZ"\n') === ',', 'and still picks the comma for a normal CSV');

  ok(findHeaderRow([['My sheet'], [], ['Name', 'Email', 'Phone'], ['a', 'b', 'c']]) === 2, 'a title row and a blank are skipped');

  const t = loadTable(Buffer.from('Name,Name,,Age\nA,B,C,4\n'));
  ok(t.headers[1] === 'Name (2)' && t.headers[2] === 'Column 3', 'duplicate and empty headers are given usable names');

  const nh = loadTable(Buffer.from('Bob,1 Oak St\nSue,2 Elm St\n'), { headerRow: -1 });
  ok(nh.rows.length === 2 && nh.headers[0] === 'Column 1', 'headerRow -1 keeps the first line as data');
}

// ---- xlsx (pure) ----
{
  // Build a two-sheet workbook by hand rather than depend on a writer.
  const zip = (files) => {
    const locals = [], central = []; let off = 0;
    const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    const crc32 = b => { let c = 0xFFFFFFFF; for (const x of b) c = crcTable[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    for (const [name, content] of files) {
      const raw = Buffer.from(content), comp = deflateRawSync(raw), nb = Buffer.from(name);
      const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
      h.writeUInt32LE(crc32(raw), 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nb.length, 26);
      locals.push(h, nb, comp);
      const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
      c.writeUInt32LE(crc32(raw), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
      central.push(c, nb); off += 30 + nb.length + comp.length;
    }
    const cd = Buffer.concat(central), lo = Buffer.concat(locals);
    const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10);
    e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(lo.length, 16);
    return Buffer.concat([lo, cd, e]);
  };
  const sheet = rows => `<worksheet><sheetData>${rows.map((r, i) =>
    `<row r="${i + 1}">${r.map((c, j) => c == null ? '' :
      `<c r="${String.fromCharCode(65 + j)}${i + 1}"${typeof c === 'number' ? '' : ' t="inlineStr"'}>${typeof c === 'number' ? `<v>${c}</v>` : `<is><t>${c}</t></is>`}</c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const book = zip([
    ['[Content_Types].xml', '<Types/>'],
    ['xl/workbook.xml', '<workbook><sheets><sheet name="Clients" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', sheet([['Name', 'Rate'], ['Tempe R&D <Ltd>', 45]])],
    ['xl/worksheets/sheet2.xml', sheet([['just notes']])]
  ]);
  ok(looksLikeXlsx(book), 'an xlsx is recognised by its signature, not its extension');
  const x = readXlsx(book);
  ok(x.sheets.length === 2 && x.sheet === 'Clients', 'both sheets are listed and the first is used by default');
  ok(x.rows[1][0] === 'Tempe R&D <Ltd>', 'XML entities are decoded back to their characters');
  ok(readXlsx(book, { sheet: 'Notes' }).rows[0][0] === 'just notes', 'a sheet can be chosen by name');
  ok(excelDateToISO(45000) === '2023-03-15', 'an Excel day count converts to a date');
}

// ---- column detection (pure) ----
{
  const headers = ['Client Name', 'Street', 'Apt', 'Underlying Carrier', 'Acct No', 'Sub', 'MAC ADDR', 'Model', 'Buy Rate', 'Email'];
  const rows = [['Sushi Bar LLC', '1400 W Elliot Rd', 'Apt 12', 'Cox', '0018501214337808', '00001', 'DC:2C:6E:DD:6E:67', 'hAP ax2', '45.00', 'a@x.com']];
  const got = Object.fromEntries(detectColumns(headers, rows).map(c => [c.header, c.field]));
  const want = { 'Client Name': 'customer_name', Street: 'service_address', Apt: 'unit', 'Underlying Carrier': 'carrier',
    'Acct No': 'account_number', Sub: 'subaccount', 'MAC ADDR': 'mac', Model: 'device_model', 'Buy Rate': 'monthly_cost', Email: 'customer_email' };
  for (const [h, f] of Object.entries(want)) ok(got[h] === f, `"${h}" is read as ${f}${got[h] === f ? '' : ` (got ${got[h]})`}`);

  // A header that lies about its contents: the values must win.
  const lying = detectColumns(['Account'], [['DC:2C:6E:DD:6E:67'], ['AA:BB:CC:DD:EE:FF']]);
  ok(lying[0].field === 'mac', 'a column of MAC addresses is read as MAC even when headed "Account"');

  // Long digit strings are account numbers, not money.
  const acct = detectColumns(['Number'], [['0018501214337808'], ['0018501214337809']]);
  ok(acct[0].field !== 'monthly_cost' && acct[0].field !== 'monthly_revenue', 'a long account number is not mistaken for money');

  ok(detectColumns(['Comments'], [['called them back'], ['no answer']])[0].field !== 'customer_name',
    'a free-text column is left unmapped rather than guessed at');
}

// ---- API ----
await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });

const CSV = ['GeekiTek brokered clients', '',
  'Client Name,Street,Apt,Underlying Carrier,Acct No,Sub,MAC ADDR,Model,Buy Rate,Email',
  '"Wizard Sushi, LLC",1400 W Wizard Rd Tempe AZ,Apt 12,Cox,WIZ-900100,00001,DC:2C:6E:00:00:01,hAP ax2,45.00,a@wiz.test',
  'Wizard Bob LLC,1400 w. wizard road tempe arizona,Ste B,Cox,WIZ-900100,00002,DC:2C:6E:00:00:02,hAP ax2,60.00,bob@wiz.test',
  'Wizard Vista Mgmt,900 Wizard Tower Rd Tempe AZ,,Verizon,WIZ-900200,,,,250.00,vm@wiz.test'].join('\n');

const before = {
  sites: (await call('/api/sites')).json.length,
  accounts: (await call('/api/accounts')).json.length,
  customers: (await call('/api/customers')).json.length,
  carriers: (await call('/api/carriers')).json.length
};

const an = await upload('/api/import/analyze?filename=wizard.csv', Buffer.from(CSV, 'utf8'));
ok(an.status === 200, 'the file is analysed');
const A = an.json;
ok(A.headerRow === 2, 'the header row is found past the title and the blank');
ok(A.total === 3, 'three data rows are read');
ok(!!A.token, 'a token is issued so the approved plan is the one applied');

// The heart of it: row 2 must recognise what row 1 is about to create.
const st = i => Object.fromEntries(A.rows[i].entities.map(e => [e.entity, e.state]));
ok(st(0).site === 'new' && st(0).account === 'new', 'the first row creates the building and the account');
ok(st(1).site === 'run', 'the second row reuses the same building despite a differently spelled address');
ok(st(1).account === 'run', 'and reuses the account it shares');
ok(st(1).subaccount === 'new', 'but gets its own sub-account');
ok(st(0).carrier === 'existing', 'a carrier already on file is matched, not recreated');
ok(A.rows.every(r => r.action === 'create'), 'nothing matched an existing record, so every row defaults to create');

const cm = await call('/api/import/commit', { body: { token: A.token } });
ok(cm.status === 200, 'the import commits');
const batch1 = cm.json.batch_id;
ok(cm.json.tally.carrier === 0, 'no carrier was duplicated');
ok(cm.json.tally.account === 2, 'two accounts, not three, for three rows sharing one account number');
ok(cm.json.tally.site === 2, 'two buildings, not three');
ok(cm.json.tally.unit === 2, 'two units inside the shared building');
ok(cm.json.tally.customer === 3, 'all three customers are created');
ok((await call('/api/carriers')).json.length === before.carriers, 'the carrier list is unchanged');

// The staged plan is single-use, so a double-submit can't import twice.
ok((await call('/api/import/commit', { body: { token: A.token } })).status === 410, 'the same token cannot be committed twice');

// ---- what actually landed ----
const sites = (await call('/api/sites')).json;
const bldg = sites.find(s => /wizard rd/i.test(s.service_address || s.name || ''));
ok(!!bldg && bldg.is_mdu === 1, 'the shared building is flagged as an MDU');
const units = (await call(`/api/sites/${bldg.id}/units`)).json;
ok(units.length === 2, 'both tenants are units of the one building, not two sites');

// A tenant's sub-account must not be stamped on the building they share.
const bd = (await call(`/api/sites/${bldg.id}`)).json;
ok(!bd.subaccount_id, "the building carries no tenant's sub-account");

for (const [name, sub] of [['Wizard Sushi, LLC', '00001'], ['Wizard Bob LLC', '00002']]) {
  const c = (await call('/api/customers')).json.find(x => x.name === name);
  const d = (await call('/api/customers/' + c.id)).json;
  ok((d.service || []).length > 0 && (d.service || []).every(l => l.subaccount === sub),
    `${name} rolls up to sub-account ${sub} everywhere`);
}

// ---- re-importing the same file changes nothing ----
const A2 = (await upload('/api/import/analyze?filename=wizard.csv', Buffer.from(CSV, 'utf8'))).json;
ok(A2.summary.matched === 3, 'on a second run every row is recognised as already present');
ok(A2.rows.every(r => r.action === 'attach'), 'and defaults to linking rather than creating');
const cm2 = await call('/api/import/commit', { body: { token: A2.token } });
ok(cm2.json.counts.created === 0, 're-importing creates nothing');
ok((await call('/api/sites')).json.length === before.sites + 2, 'the site count is unchanged by the second run');

// ---- skip and update ----
const A3 = (await upload('/api/import/analyze?filename=wizard.csv', Buffer.from(CSV, 'utf8'))).json;
const cm3 = await call('/api/import/commit', { body: { token: A3.token, actions: { 0: 'skip', 1: 'skip', 2: 'skip' } } });
ok(cm3.json.counts.skipped === 3 && cm3.json.counts.created === 0, 'rows set to skip write nothing');

// A blank in the sheet must not wipe a value that is already recorded.
const acct = (await call('/api/accounts')).json.find(a => a.account_number === 'WIZ-900200');
await call('/api/accounts/' + acct.id, { method: 'PUT', body: { ...acct, notes: 'KEEP ME' } });
const CSV2 = ['Client Name,Street,Acct No,Underlying Carrier,Buy Rate',
  'Wizard Vista Mgmt,900 Wizard Tower Rd Tempe AZ,WIZ-900200,Verizon,275.00'].join('\n');
const A4 = (await upload('/api/import/analyze?filename=upd.csv', Buffer.from(CSV2, 'utf8'))).json;
await call('/api/import/commit', { body: { token: A4.token, actions: { 0: 'update' } } });
const acct2 = (await call('/api/accounts')).json.find(a => a.account_number === 'WIZ-900200');
ok(acct2.notes === 'KEEP ME', 'a field the sheet does not mention is left alone by an update');
ok(Number(acct2.monthly_cost) === 275, 'a field the sheet does mention is updated');

// ---- history and undo ----
const hist = (await call('/api/imports')).json;
ok(hist.length >= 4 && hist[0].filename === 'upd.csv', 'every run is listed, newest first');
ok(hist.some(b => b.actor), 'the person who ran it is recorded');

const un = await call(`/api/imports/${batch1}/undo`, { body: {} });
ok(un.status === 200, 'the first batch can be undone');
ok(un.json.restored > 0 || un.json.removed > 0, 'undo reports what it changed');
ok((await call(`/api/imports/${batch1}/undo`, { body: {} })).status === 409, 'a batch cannot be undone twice');

// Undo the rest, then everything should be back where it started.
for (const b of (await call('/api/imports')).json) if (b.status !== 'undone') await call(`/api/imports/${b.id}/undo`, { body: {} });
const after = {
  sites: (await call('/api/sites')).json.length,
  accounts: (await call('/api/accounts')).json.length,
  customers: (await call('/api/customers')).json.length,
  carriers: (await call('/api/carriers')).json.length
};
ok(after.sites === before.sites, 'every imported site is gone again');
ok(after.accounts === before.accounts, 'every imported account is gone again');
ok(after.customers === before.customers, 'every imported customer is gone again');
ok(after.carriers === before.carriers, 'no carrier was harmed');

// ---- undo must not take records that have since been used ----
{
  const csv = 'Client Name,Street,Acct No,Underlying Carrier\nUndo Guard LLC,77 Guard Ave Tempe AZ,WIZ-GUARD,Cox';
  const a = (await upload('/api/import/analyze?filename=guard.csv', Buffer.from(csv, 'utf8'))).json;
  const b = (await call('/api/import/commit', { body: { token: a.token } })).json.batch_id;
  const site = (await call('/api/sites')).json.find(s => /guard ave/i.test(s.service_address || ''));
  ok(!!site, 'the guarded site was imported');
  // Someone attaches live service to it afterwards.
  await call(`/api/sites/${site.id}/units`, { body: { label: 'Added later' } });
  const u = await call(`/api/imports/${b}/undo`, { body: {} });
  ok(u.json.kept.some(k => k.entity === 'site'), 'undo keeps a site that has been built on since, and says so');
  ok((await call('/api/sites')).json.some(s => s.id === site.id), 'the site is still there');
  // Clean up behind the test.
  for (const un2 of (await call(`/api/sites/${site.id}/units`)).json) await call(`/api/units/${un2.id}`, { method: 'DELETE' });
  await call(`/api/sites/${site.id}`, { method: 'DELETE' });
}

// ---- refusals ----
ok((await upload('/api/import/analyze', Buffer.alloc(0))).status === 400, 'an empty upload is refused');
ok((await upload('/api/import/analyze', Buffer.from('Name,Email\n'))).status === 400, 'a file with headers but no rows is refused');
{
  const saved = cookie; cookie = '';
  ok((await upload('/api/import/analyze', Buffer.from('a,b\n1,2'))).status === 401, 'analysis needs a login');
  ok((await call('/api/imports')).status === 401, 'the history needs a login');
  cookie = saved;
}
{
  await call('/api/logout', { body: {} }); cookie = '';
  await call('/api/login', { body: { email: 'support@geekitek.test', password: 'support123' } });
  ok((await upload('/api/import/analyze', Buffer.from('a,b\n1,2'))).status === 403, 'support cannot import');
  ok((await call('/api/imports')).status === 403, 'support cannot see the import history');
}

// ---- the page and the API agree ----
//
// Nothing else catches a UI that reads a field the server doesn't send: the page just renders
// "undefined" and looks plausible. So assert the shape the wizard actually consumes.
{
  await call('/api/logout', { body: {} }); cookie = '';
  await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });
  const a = (await upload('/api/import/analyze?filename=shape.csv',
    Buffer.from('Client Name,Street,Buy Rate\nShape Co,5 Shape St Tempe AZ,10.00'))).json;

  for (const k of ['token', 'format', 'headerRow', 'headers', 'columns', 'fields', 'total', 'summary', 'rows'])
    ok(a[k] !== undefined, `analyze returns "${k}"`);
  for (const k of ['index', 'header', 'field', 'confidence', 'why', 'samples'])
    ok(a.columns[0][k] !== undefined, `each column carries "${k}"`);
  for (const k of ['key', 'label', 'group'])
    ok(a.fields[0][k] !== undefined, `each mappable field carries "${k}"`);
  for (const k of ['index', 'action', 'entities', 'issues', 'matched'])
    ok(a.rows[0][k] !== undefined, `each row carries "${k}"`);
  for (const k of ['entity', 'label', 'state'])
    ok(a.rows[0].entities[0][k] !== undefined, `each planned entity carries "${k}"`);
  ok(['create', 'attach', 'update', 'skip'].includes(a.rows[0].action), 'the suggested action is one the page offers');
  ok(a.rows[0].entities.every(e => ['new', 'run', 'existing'].includes(e.state)), 'every entity state is one the page can label');

  const c = (await call('/api/import/commit', { body: { token: a.token } })).json;
  for (const k of ['batch_id', 'counts', 'tally']) ok(c[k] !== undefined, `commit returns "${k}"`);
  const h = (await call('/api/imports')).json[0];
  for (const k of ['id', 'filename', 'format', 'created_at', 'row_count', 'created_count', 'attached_count', 'updated_count', 'skipped_count', 'status'])
    ok(h[k] !== undefined, `the history row carries "${k}"`);
  const un = (await call(`/api/imports/${c.batch_id}/undo`, { body: {} })).json;
  for (const k of ['removed', 'restored', 'kept']) ok(un[k] !== undefined, `undo returns "${k}"`);

  // The page and its stylesheet are actually being served with the wizard in them.
  const js = (await call('/app.js')).t;
  ok(js.includes('renderImportWiz'), 'app.js contains the wizard page');
  ok(js.includes("p[0] === 'importwiz'"), 'the wizard is routed');
  ok(js.includes("location.hash='#/importwiz'"), 'Settings links to the wizard');
  const css = (await call('/styles.css')).t;
  for (const cls of ['.tablewrap', '.tbl', '.btn.danger', '.err'])
    ok(css.includes(cls), `the stylesheet defines ${cls}`);
  // Every class the wizard markup uses must exist, or the page renders unstyled and confusing.
  for (const cls of ['pill s-up', 'pill s-warn', 'pill s-down'])
    ok(js.includes(cls) && cls.split(' ').every(c => css.includes('.' + c)), `"${cls}" is defined in the stylesheet`);
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
