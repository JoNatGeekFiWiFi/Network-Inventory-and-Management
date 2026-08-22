// Import templates, value normalisation, and the xlsx writer.
//
// The load-bearing assertion in this file is that every header shipped in a template is one the
// column detector recognises. Templates and lib/colmap.js are two halves of one contract: ship a
// template with a header the detector doesn't know and the person filling it in gets a wizard
// full of "unmapped", which is worse than having no template at all. That has to be checked, not
// assumed, because the two files are edited months apart.
import { writeXlsx, colName } from '../lib/xlsxwrite.js';
import { readXlsx, looksLikeXlsx } from '../lib/xlsx.js';
import { loadTable } from '../lib/tabular.js';
import { detectColumns } from '../lib/colmap.js';
import { TEMPLATES, buildTemplate, templateByKey } from '../lib/templates.js';
import { normalizeMac, normalizeDueDay, normalizeBool, normalizeMoney, normalizePlan, normalizeName } from '../lib/normalize.js';
import { contentDisposition } from '../lib/core.js';

const B = process.env.BASE ?? 'http://localhost:3000'; let cookie = '';
async function call(p, { method = 'GET', body } = {}) { const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; } if (cookie) h.cookie = cookie; const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, t }; }
async function upload(p, buf) { const h = { 'content-type': 'application/octet-stream' }; if (cookie) h.cookie = cookie; const r = await fetch(B + p, { method: 'POST', headers: h, body: buf }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, t }; }
async function download(p) { const h = {}; if (cookie) h.cookie = cookie; const r = await fetch(B + p, { headers: h }); return { status: r.status, disp: r.headers.get('content-disposition'), type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) }; }
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

// ---- normalisation (pure) ----
{
  ok(normalizeMac('1C937CF4A003') === '1C:93:7C:F4:A0:03', 'a bare 12-hex MAC gains its separators');
  ok(normalizeMac('1c-93-7c-f4-a0-03') === '1C:93:7C:F4:A0:03', 'dashes and lowercase are folded');
  ok(normalizeMac('1c93.7cf4.a003') === '1C:93:7C:F4:A0:03', 'Cisco dotted notation is folded');
  ok(normalizeMac('not a mac') === 'not a mac', 'something that is not a MAC is handed back untouched');
  ok(normalizeMac('') === null, 'a blank MAC is null');

  ok(normalizeDueDay('17th') === 17 && normalizeDueDay('2nd') === 2 && normalizeDueDay('the 21st') === 21,
    'ordinal billing days become numbers');
  ok(normalizeDueDay('32nd') === null && normalizeDueDay('0') === null, 'an impossible day of the month is rejected');
  ok(normalizeDueDay('') === null, 'a blank due day is null, not zero');

  ok(normalizeBool('Yes') === 1 && normalizeBool('n') === 0 && normalizeBool('TRUE') === 1, 'yes/no reads as a flag');
  ok(normalizeBool('') === null && normalizeBool('sometimes') === null,
    'blank and unrecognised autopay stay unknown rather than becoming "no"');

  ok(normalizeMoney('$1,234.50') === 1234.5 && normalizeMoney('50.0') === 50, 'money parses with symbols and separators');
  ok(normalizeMoney('') === null && normalizeMoney('n/a') === null, 'junk money is null, not zero');

  // The 13 spellings on the real Cox sheet.
  const plans = ['straight up 50', 'straightup 50', 'StraightUp 50'].map(normalizePlan);
  ok(new Set(plans).size === 1, 'three spellings of StraightUp 50 fold to one plan');
  ok(new Set(['1 gig', '1gig', 'gigablast'].map(normalizePlan)).size === 1, 'and three spellings of gigabit');
  ok(new Set(['500 mbps', '500mbps', '500 Mbps'].map(normalizePlan)).size === 1, 'and three of 500 Mbps');
  ok(normalizePlan('fiber 250/25') === 'Fiber 250/25 Mbps', 'an asymmetric fibre plan keeps both numbers');
  ok(normalizePlan('Some Bespoke Thing') === 'Some Bespoke Thing', 'an unrecognised plan is kept verbatim, not discarded');

  ok(normalizeName('Yanet Perchez home') === 'Yanet Perchez', 'trailing "home" is trimmed off a name');
  ok(normalizeName('Homer Homes') === 'Homer Homes', 'but a name that merely contains "home" is left alone');
}

// ---- the xlsx writer ----
{
  const buf = writeXlsx([
    { name: 'Data', headerRow: true, freezeHeader: true, widths: [20, 30], rows: [['Name', 'Cost'], ['R&D <Ltd> "q"', 50], ['Ünïcode', 0]] },
    { name: 'Notes', rows: [[{ v: 'Title', style: 'title' }], ['body']] }
  ]);
  ok(looksLikeXlsx(buf), 'what the writer produces is recognisably an xlsx');
  const back = readXlsx(buf);
  ok(back.sheets.length === 2 && back.sheets[0] === 'Data', 'both sheets survive a round trip');
  ok(back.rows[1][0] === 'R&D <Ltd> "q"', 'XML-special characters survive');
  ok(back.rows[2][0] === 'Ünïcode', 'non-ASCII survives');
  ok(back.rows[1][1] === '50' && back.rows[2][1] === '0', 'numbers are written as numbers, including zero');
  ok(readXlsx(buf, { sheet: 'Notes' }).rows[0][0] === 'Title', 'the second sheet reads by name');
  ok(colName(0) === 'A' && colName(25) === 'Z' && colName(26) === 'AA' && colName(701) === 'ZZ', 'column letters carry past Z');
  let threw = false; try { writeXlsx([]); } catch { threw = true; }
  ok(threw, 'an empty workbook is refused rather than written as a corrupt file');
}

// ---- Content-Disposition (the em dash in a template name once 500'd this route) ----
{
  const d = contentDisposition('Cox accounts — import template.xlsx');
  ok(!/[^\x00-\x7F]/.test(d), 'the header value is pure ASCII, which is all Node will send');
  ok(d.includes('filename="Cox accounts _ import template.xlsx"'), 'there is a plain fallback filename');
  ok(d.includes("filename*=UTF-8''"), 'and an RFC 5987 form carrying the real name');
  ok(!contentDisposition('a\r\nX-Evil: 1').includes('\n'), 'newlines cannot be smuggled into the header');
}

// ---- templates match what the detector understands ----
{
  ok(TEMPLATES.length >= 3, 'there is a template per carrier shape');
  ok(!!templateByKey('cox') && !!templateByKey('verizon') && !templateByKey('nope'), 'templates look up by key');

  for (const t of TEMPLATES) {
    const built = buildTemplate(t.key);
    ok(!!built && built.buffer.length > 0, `${t.key}: builds`);
    const table = loadTable(built.buffer, { maxRows: 50 });
    ok(table.headers.length === t.headers.length, `${t.key}: every column is written`);
    ok(table.rows.length === t.examples.length, `${t.key}: the example rows are there to copy`);
    ok(table.headerRow === 0, `${t.key}: the header is found on the first row`);

    const cols = detectColumns(table.headers, table.rows);
    const unmapped = cols.filter(c => !c.field).map(c => c.header);
    ok(unmapped.length === 0, `${t.key}: every shipped header is understood${unmapped.length ? ' — ' + unmapped.join(', ') : ''}`);
    const weak = cols.filter(c => c.confidence < 0.5).map(c => `${c.header}@${c.confidence}`);
    ok(weak.length === 0, `${t.key}: no header maps only weakly${weak.length ? ' — ' + weak.join(', ') : ''}`);
    ok(new Set(cols.map(c => c.field)).size === cols.length, `${t.key}: no two columns claim the same field`);

    const sheets = readXlsx(built.buffer).sheets;
    ok(sheets.includes('How to use'), `${t.key}: ships an instructions sheet`);
  }

  // The shapes the two carriers actually have.
  const cox = templateByKey('cox'), vz = templateByKey('verizon');
  ok(!cox.headers.includes('Sub-Account'), 'the Cox template has no sub-account column — Cox does not use them');
  ok(vz.headers.includes('Sub-Account'), 'the Verizon template does');
  ok(cox.headers.includes('Account Address') && cox.headers.includes('Service Address'),
    'Cox keeps the carrier address separate from the service address');
  for (const t of [cox, vz]) ok(t.headers.includes('Monthly Cost') && t.headers.includes('Monthly Price'),
    `${t.key}: both sides of the margin are present`);
}

// ---- API ----
await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });

{
  const list = await call('/api/import/templates');
  ok(list.status === 200 && list.json.length >= 3, 'the wizard can list the templates');
  ok(list.json.every(t => t.key && t.label && t.columns > 0), 'each is listed with a key, a label and a column count');
  ok((await call('/api/import/template/nope')).status === 404, 'an unknown template is a 404');
}

// Download each template and put it straight back through the wizard: the round trip is the
// promise the template makes.
for (const key of ['cox', 'verizon', 'generic']) {
  const d = await download('/api/import/template/' + key);
  ok(d.status === 200, `${key}: downloads`);
  ok(d.type.includes('spreadsheetml'), `${key}: is served as a spreadsheet`);
  ok(looksLikeXlsx(d.buf), `${key}: the bytes are a real xlsx`);

  const a = (await upload('/api/import/analyze?filename=' + key + '.xlsx', d.buf)).json;
  ok(a && a.total > 0, `${key}: the wizard reads its own template back`);
  ok(a.columns.filter(c => !c.field).length === 0, `${key}: nothing needs correcting by hand`);
  ok(a.rows.every(r => r.entities.length > 0), `${key}: every example row would create something`);
  const c = await call('/api/import/commit', { body: { token: a.token } });
  ok(c.status === 200, `${key}: the filled template imports`);
  ok(c.json.tally.customer > 0 && c.json.tally.site > 0, `${key}: customers and sites are created`);
  ok(c.json.tally.billing > 0, `${key}: a sell price becomes a recurring billing line`);
}

// ---- the Verizon shape: a sub-account grouping several customers ----
{
  const acct = (await call('/api/accounts')).json.find(a => a.account_number === '942797643');
  ok(!!acct, 'the Verizon master account exists');
  const d = (await call('/api/accounts/' + acct.id)).json;
  ok(d.carrier_name === 'Verizon', 'the account detail carries the carrier name, like the list does');
  ok(d.subaccounts.length === 2, 'the master account has both sub-accounts, not one per row');

  const bldg = d.sites.find(s => /elliot/i.test(s.name || s.service_address || ''));
  ok(!!bldg && bldg.unit_count === 2, 'the two tenants at one address are units of one building');

  const names = ['Sunrise Dental', 'Elliot Rd Chiropractic'];
  for (const n of names) {
    const c = (await call('/api/customers')).json.find(x => x.name === n);
    const cd = (await call('/api/customers/' + c.id)).json;
    ok(cd.service.length === 1, `${n}: one service line, not one per source`);
    ok(cd.service[0].subaccount === 'Elliot Rd building', `${n}: grouped under the right sub-account`);
    ok(cd.service[0].sources.length >= 2, `${n}: and the line cites more than one source`);
  }
  // Different sub-account, same master account.
  const v = (await call('/api/customers')).json.find(x => x.name === 'Vista Property Mgmt');
  const vd = (await call('/api/customers/' + v.id)).json;
  ok(vd.service[0].subaccount === 'Tower Rd building', 'a customer on the other sub-account is separated');
  ok(vd.service[0].account_id === acct.id, 'while still sitting under the same master account');
}

// ---- P&L sees the imported prices ----
{
  const pnl = (await call('/api/pnl')).json;
  const vz = pnl.rows.find(r => r.name === 'GEEKFILTE LLC');
  ok(!!vz && vz.revenue > 0, 'the imported sell prices show up as revenue');
  ok(vz.margin === Math.round((vz.revenue - vz.cost) * 100) / 100, 'and margin is revenue less cost');
}

// ---- credentials ----
{
  const csv = ['Customer / Business Name,Service Address,Carrier,Account Number,Portal Username,Portal Password,Account PIN,Monthly Cost',
    'Credential Test LLC,88 Secret St Tempe AZ,Cox,CRED-9001,portaluser,SuperSecret123,0501,50'].join('\n');
  const a = (await upload('/api/import/analyze?filename=creds.csv', Buffer.from(csv))).json;

  // The preview must not carry the secret anywhere — not in samples, not in the row values, not
  // in the raw row. It is rendered into the page and would end up in any screenshot of it.
  const blob = JSON.stringify(a);
  ok(!blob.includes('SuperSecret123'), 'the analysis response never contains the password');
  ok(!blob.includes('"0501"'), 'nor the PIN');
  ok(blob.includes('portaluser'), 'the username is shown, since it identifies which login this is');
  const pwCol = a.columns.find(c => c.field === 'portal_password');
  ok(pwCol && pwCol.secret === true, 'the password column is marked so the page can say it is hidden');
  ok(pwCol.samples.every(s => /^•+$/.test(s)), 'and its samples are masked');

  await call('/api/import/commit', { body: { token: a.token } });

  // ...but the real value must reach the database, or the account is unusable.
  const acct = (await call('/api/accounts')).json.find(x => x.account_number === 'CRED-9001');
  const full = (await call('/api/accounts/' + acct.id)).json;
  ok(full.portal_password === 'SuperSecret123', 'the true password is stored, not the mask');
  ok(full.pin === '0501', 'and the true PIN');
  ok(full.portal_username === 'portaluser', 'and the username');

  // And it must be invisible below NOC.
  const saved = cookie;
  await call('/api/logout', { body: {} }); cookie = '';
  await call('/api/login', { body: { email: 'support@geekitek.test', password: 'support123' } });
  const asSupport = (await call('/api/accounts/' + acct.id)).json;
  for (const k of ['pin', 'portal_password', 'portal_username', 'security_questions'])
    ok(!(k in asSupport), `support cannot see ${k}`);
  ok(asSupport.has_portal_password === true && asSupport.has_portal_username === true,
    'support is told the credentials exist without being shown them');
  const listed = (await call('/api/accounts')).json;
  ok(listed.every(a2 => !('portal_password' in a2) && !('portal_username' in a2) && !('pin' in a2)),
    'and the account list carries no credentials at all');
  ok((await download('/api/import/template/cox')).status === 403, 'support cannot download templates either');
  cookie = saved;
  await call('/api/logout', { body: {} }); cookie = '';
  await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });
}

// ---- the real-world column names from Jon's own Cox export ----
{
  // These are the exact headers on the sheet this feature was built from. Every one of them was
  // read wrongly at some point, so each is pinned.
  const headers = ['User Name', 'Password', 'Pin:', 'Account Address', 'Account Number', 'Due Date',
    'Monthly Cost', 'Plan', 'Serial Number', 'MAC address', 'Customer Address', 'Customer / Business Name',
    'Autopay', 'NOTES: OR HOP INFO'];
  const rows = [['gtek616', 'GT8k@221', '0501', '2929 E Main St Lot 616 Mesa, AZ 85213', '8502065851706',
    '2nd', '50.0', 'straight up 50', '2CG5J1699600741', '1C937CF4A003', '4356 East grove st Phoenix, AZ 85040',
    'Alex Canales', 'No', 'on privacy card'],
  ['17621gtek', 'GeekFi@222', '0501', '17621 N Lindner Dr Glendale, AZ 85308', '8501214372309',
    '3rd', '50.0', 'straightup 50', '1AK541334700985', 'C09435045C47', '17621 N Lindner Dr Glendale, AZ 85308',
    'Sara Lee', '', 'on privacy card']];
  const got = Object.fromEntries(detectColumns(headers, rows).map(c => [c.header, c.field]));
  const want = {
    'User Name': 'portal_username',            // not the customer
    'Password': 'portal_password',
    'Pin:': 'account_pin',                     // not a monthly charge
    'Account Address': 'billing_address',      // not the service address
    'Customer Address': 'service_address',     // this is where the equipment is
    'Customer / Business Name': 'customer_name',
    'Account Number': 'account_number',
    'Due Date': 'due_day',                     // not a unit number
    'Monthly Cost': 'monthly_cost',
    'Serial Number': 'serial',
    'MAC address': 'mac',
    'Autopay': 'autopay',
    'Plan': 'bandwidth'
  };
  for (const [h, f] of Object.entries(want))
    ok(got[h] === f, `real sheet: "${h}" reads as ${f}${got[h] === f ? '' : ` (got ${got[h]})`}`);
}

// ---- a Cox-shaped file end to end ----
{
  const csv = ['COX ACCOUNTS: RESIDENTAL', '',
    'User Name,Password,Pin:,Account Address,Account Number,Due Date,Monthly Cost,Plan,Serial Number,MAC address,Customer Address,Customer / Business Name,Autopay',
    'e2euser,pw1,0501,"1 Billing Way Mesa, AZ 85213",E2E-77001,17th,50.0,straight up 50,E2ESN001,AA11BB22CC33,"400 E2E Grove St Apt 5 Phoenix, AZ 85040",E2E Tenant One home,Yes',
    'e2euser2,pw2,0501,"1 Billing Way Mesa, AZ 85213",E2E-77002,3rd,60.0,1gig,E2ESN002,AA11BB22CC44,"400 E2E Grove St Apt 9 Phoenix, AZ 85040",E2E Tenant Two,No'].join('\n');
  const a = (await upload('/api/import/analyze?filename=coxlike.csv', Buffer.from(csv))).json;
  ok(a.headerRow === 2, 'the "COX ACCOUNTS: RESIDENTAL" title row is skipped');
  await call('/api/import/commit', { body: { token: a.token } });

  const site = (await call('/api/sites')).json.find(s => /e2e grove/i.test(s.service_address || ''));
  ok(!!site, 'a site was created from the customer address, not the billing address');
  ok(!/billing way/i.test(site.service_address), 'the carrier billing address did not become the site');
  ok(site.unit_count === 2, 'both apartments became units of the one building');

  const acct = (await call('/api/accounts')).json.find(x => x.account_number === 'E2E-77001');
  const full = (await call('/api/accounts/' + acct.id)).json;
  ok(full.due_day === 17, '"17th" was stored as the number 17');
  ok(full.billing_address && /billing way/i.test(full.billing_address), 'the carrier address is kept on the account');
  ok(full.autopay === 1, 'autopay "Yes" became a flag');
  ok(full.plan === 'StraightUp 50 Mbps', 'the plan spelling was normalised');
  ok(full.monthly_cost === 50, 'the cost was read');

  const dev = (await call('/api/devices')).json.find(d => d.serial === 'E2ESN001');
  ok(dev && dev.mac === 'AA:11:BB:22:CC:33', 'the separator-less MAC was normalised on the way in');

  const cust = (await call('/api/customers')).json.find(c => c.name === 'E2E Tenant One');
  ok(!!cust, 'the trailing "home" was trimmed from the customer name');

  const acct2 = (await call('/api/accounts')).json.find(x => x.account_number === 'E2E-77002');
  ok((await call('/api/accounts/' + acct2.id)).json.plan === 'Gigablast (1 Gbps)', '"1gig" folded to the gigabit plan');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
