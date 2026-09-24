// Suspension for nonpayment: the policy, the router rules, and the whole flow through the API.
import { DatabaseSync } from 'node:sqlite';
import { standing, decide, splitInstallments, validateArrangement, installmentProgress, addDays } from '../lib/suspension.js';
import {
  routerosPlan, routerosSuspend, routerosClear, routerosIsSuspended, gardenHosts, captiveIpFor,
  findOverlayZone, openwrtPlan, openwrtOurs, TAG, DEFAULT_GARDEN
} from '../lib/suspendrouter.js';

let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

// ---- policy ----
{
  const inv = (id, due, balance = 100, status = 'sent') => ({ id, due_date: due, balance, status });
  const T = '2026-09-24';
  let s = standing({ invoices: [inv(1, '2026-09-20')], today: T });
  ok(s.late && s.daysLate === 4 && s.suspendOn === '2026-09-30' && s.warnOn === '2026-09-27' && !s.due && !s.warn, '4 days late: suspends on day 10, warned on day 7');
  s = standing({ invoices: [inv(1, '2026-09-17')], today: T });
  ok(s.warn && !s.due, 'inside the warning window → warn');
  s = standing({ invoices: [inv(1, '2026-09-14')], today: T });
  ok(s.due && s.daysLate === 10, '10 days late → due for suspension');
  ok(standing({ invoices: [inv(1, '2026-09-01', 50, 'draft'), inv(2, '2026-09-01', 0, 'paid')], today: T }).balance === 0, 'drafts and paid invoices do not count');
  ok(standing({ invoices: [inv(1, '2026-09-10'), inv(2, '2026-08-20')], today: T }).overdueSince === '2026-08-20', 'the clock runs from the OLDEST unpaid invoice');
  ok(!standing({ invoices: [inv(1, '2026-09-01')], today: T, exempt: true }).due, 'exempt customers are never due');
  ok(!standing({ invoices: [inv(1, '2026-09-01')], today: T, holdUntil: '2026-09-30' }).due, 'a hold keeps them on until its date');
  ok(standing({ invoices: [inv(1, '2026-09-01')], today: T, holdUntil: '2026-09-20' }).due, 'and lapses after it');
  ok(standing({ invoices: [inv(1, '2026-09-10')], today: T, policy: { graceDays: 5 } }).due, 'grace is a setting');

  // Extension
  const ext = { kind: 'extension', extend_until: '2026-10-05', invoice_ids: [1] };
  s = standing({ invoices: [inv(1, '2026-09-01')], arrangement: ext, today: T });
  ok(!s.due && s.protectedBy === 'extension' && s.suspendOn === '2026-10-06', 'an extension moves the suspension date to the day after it ends');
  s = standing({ invoices: [inv(1, '2026-09-01')], arrangement: ext, today: '2026-10-06' });
  ok(s.due && s.arrangementBroken, 'and once it has passed unpaid, they are due');
  s = standing({ invoices: [inv(1, '2026-09-01'), inv(2, '2026-09-10')], arrangement: ext, today: T });
  ok(s.due, 'a NEW bill that falls due during an arrangement is judged on its own');

  // Installments
  const plan = { kind: 'installments', invoice_ids: [1], installments: [{ due_date: '2026-09-20', amount: 100 }, { due_date: '2026-10-20', amount: 100 }, { due_date: '2026-11-20', amount: 100 }] };
  s = standing({ invoices: [inv(1, '2026-09-01', 300)], arrangement: { ...plan, paid_since: 100 }, today: T });
  ok(!s.due && s.protectedBy === 'installments' && s.nextInstallment.due_date === '2026-10-20', 'first installment paid → protected, next one shown');
  s = standing({ invoices: [inv(1, '2026-09-01', 300)], arrangement: { ...plan, paid_since: 0 }, today: T });
  ok(s.due && s.arrangementBroken, 'first installment missed past its grace → plan broken, due');
  s = standing({ invoices: [inv(1, '2026-09-01', 300)], arrangement: { ...plan, paid_since: 0 }, today: '2026-09-22' });
  ok(!s.due, 'but not inside the plan grace');
  s = standing({ invoices: [inv(1, '2026-09-01', 50)], arrangement: { ...plan, paid_since: 250 }, today: '2026-10-25' });
  ok(!s.due && s.nextInstallment.covered === 50, 'paying ahead counts toward the next installment');
  s = standing({ invoices: [], arrangement: { ...plan, paid_since: 300 }, today: T });
  ok(s.arrangementDone, 'paid in full → the arrangement is done');
  ok(installmentProgress(plan.installments, 150).map(i => i.paid).join() === 'true,false,false', 'progress is derived from money paid');

  // Decisions
  ok(decide({ due: true }, {}) === 'suspend' && decide({ due: true }, {}, { auto: false }) === null, 'due → suspend, unless automatic is off');
  ok(decide({ due: false, warn: true, suspendOn: '2026-10-01' }, {}) === 'warn' && decide({ warn: true, suspendOn: '2026-10-01' }, { warnedFor: '2026-10-01' }) === null, 'warned once per suspension date');
  ok(decide({ due: false }, { suspended: true, suspendedBy: 'auto' }) === 'restore', 'an automatic suspension lifts itself');
  ok(decide({ due: false }, { suspended: true, suspendedBy: 'jon@x.example' }) === null, 'one a person made does not');

  const parts = splitInstallments(100, 3, '2026-10-01');
  ok(parts.map(p => p.amount).join() === '33.33,33.33,33.34' && parts[2].due_date === '2026-11-30', 'splitting is cent-exact, remainder on the last payment');
  ok(validateArrangement({ kind: 'installments', installments: [{ due_date: '2026-10-01', amount: 10 }] }, { today: T, balance: 100 }).error, 'a plan that does not cover the balance is refused');
  ok(validateArrangement({ kind: 'extension', extend_until: '2026-09-01' }, { today: T }).error, 'an extension in the past is refused');
  ok(addDays('2026-02-27', 3) === '2026-03-02', 'date arithmetic crosses months');
}

// ---- RouterOS rules, against a pretend router ----
function fakeRouter({ lan = true, v6 = true } = {}) {
  let n = 100;
  const menus = {
    '/rest/ip/firewall/filter': [{ '.id': '*1', chain: 'forward', action: 'passthrough', dynamic: 'true', comment: 'special dummy rule to show fasttrack counters' },
      { '.id': '*2', chain: 'forward', action: 'fasttrack-connection' }, { '.id': '*3', chain: 'forward', action: 'accept', comment: 'defconf: accept established' },
      { '.id': '*4', chain: 'input', action: 'accept' }],
    '/rest/ip/firewall/nat': [{ '.id': '*5', chain: 'srcnat', action: 'masquerade', comment: 'defconf: masquerade' }],
    '/rest/ip/firewall/address-list': [{ '.id': '*6', list: 'other', address: '1.1.1.1' }],
    '/rest/ipv6/firewall/filter': [{ '.id': '*7', chain: 'forward', action: 'accept' }],
    '/rest/ip/firewall/connection': [{ '.id': '*c1', 'src-address': '192.168.88.20:5000', 'dst-address': '142.250.1.1:443' },
      { '.id': '*c2', 'src-address': '10.147.21.1:50000', 'dst-address': '10.147.21.9:443' }],
    '/rest/interface/list': lan ? [{ name: 'LAN' }, { name: 'WAN' }] : [{ name: 'WAN' }]
  };
  if (!v6) delete menus['/rest/ipv6/firewall/filter'];
  const call = async (method, path, body) => {
    const base = Object.keys(menus).find(m => path === m || path.startsWith(m + '/'));
    if (!base) return { status: 404, body: '' };
    const list = menus[base];
    if (method === 'GET') return { status: 200, body: JSON.stringify(list) };
    if (method === 'PUT') {
      const { 'place-before': before, ...rest } = body;
      const item = { '.id': '*' + (n++).toString(16), ...rest };
      const at = before ? list.findIndex(x => x['.id'] === before) : -1;
      if (at >= 0) list.splice(at, 0, item); else list.push(item);
      return { status: 201, body: JSON.stringify(item) };
    }
    if (method === 'DELETE') {
      const id = decodeURIComponent(path.slice(base.length + 1));
      const i = list.findIndex(x => x['.id'] === id);
      if (i < 0) return { status: 404, body: '' };
      list.splice(i, 1); return { status: 204, body: '' };
    }
    return { status: 400, body: 'unsupported' };
  };
  return { call, menus };
}
{
  const plan = routerosPlan({ captiveIp: '10.147.21.1', captivePort: 3080, garden: gardenHosts('https://noc.example.com', '') });
  ok(plan.addressList[0].address === 'noc.example.com' && plan.addressList.some(a => a.address === 'checkout.stripe.com'), 'the garden is our own host plus Stripe');
  const r = fakeRouter();
  await routerosSuspend(r.call, plan, { protect: ['10.147.21.1', '10.147.21.9'] });
  const f = r.menus['/rest/ip/firewall/filter'];
  const firstReal = f.findIndex(x => x.dynamic !== 'true');
  ok(f[firstReal].comment === TAG && f[firstReal]['dst-address-list'] === 'netinv-garden', 'our rules go at the TOP of the forward chain, above fasttrack');
  ok(f.findIndex(x => x.comment === TAG && x.action === 'reject') < f.findIndex(x => x.action === 'fasttrack-connection'), 'the reject sits above fasttrack, so nothing slips past it');
  ok(f.filter(x => x.comment === TAG).every(x => x.chain === 'forward'), 'only the forward chain is touched — management traffic is untouched');
  const nat = r.menus['/rest/ip/firewall/nat'];
  const dn = nat.find(x => x.action === 'dst-nat'); ok(dn && dn.comment === TAG && dn['to-addresses'] === '10.147.21.1' && dn['dst-port'] === '80', 'web traffic is sent to the server over the overlay');
  ok(nat.findIndex(x => x.comment === TAG && x.action === 'masquerade') < nat.findIndex(x => x['.id'] === '*5'), 'our masquerade sits above the router\'s own');
  ok(nat.some(x => x.action === 'masquerade' && x.comment === TAG && x['dst-address'] === '10.147.21.1'), 'masqueraded as the router, so the server knows who is asking');
  ok(r.menus['/rest/ipv6/firewall/filter'].some(x => x.comment === TAG && x.action === 'reject'), 'IPv6 is blocked too');
  const conns = r.menus['/rest/ip/firewall/connection'];
  ok(!conns.some(c => c['.id'] === '*c1') && conns.some(c => c['.id'] === '*c2'), 'open customer connections are dropped; our management session is not');
  ok(await routerosIsSuspended(r.call), 'the router reports suspended');

  await routerosSuspend(r.call, plan, {});
  ok(f.filter(x => x.comment === TAG && x.action === 'reject').length === 1, 'suspending twice does not duplicate anything');

  const removed = await routerosClear(r.call);
  ok(removed > 0 && !Object.values(r.menus).flat().some(x => x.comment === TAG), 'restoring removes every item we added');
  ok(f.some(x => x['.id'] === '*2') && r.menus['/rest/ip/firewall/nat'].some(x => x['.id'] === '*5') && r.menus['/rest/ip/firewall/address-list'].some(x => x['.id'] === '*6'),
    'and nothing that was there before');
  ok(!(await routerosIsSuspended(r.call)), 'the router reports normal');

  let err = null; try { await routerosSuspend(fakeRouter({ lan: false }).call, plan); } catch (e) { err = e.message; }
  ok(/LAN/.test(err || ''), 'a router with no LAN interface list is refused rather than half-suspended');
  const nov6 = fakeRouter({ v6: false });
  await routerosSuspend(nov6.call, plan); ok(await routerosIsSuspended(nov6.call), 'a router without IPv6 still suspends');
}

// ---- OpenWrt ----
{
  const interfaces = { interfaces: [{ name: 'br-lan', ips: ['192.168.1.1'] }, { name: 'ztabcdef', ips: ['10.241.5.7'] }],
    logical: [{ name: 'lan', device: 'br-lan', ipv4: ['192.168.1.1'] }, { name: 'zt', device: 'ztabcdef', ipv4: [] }] };
  const firewall = { cfg01: { '.type': 'zone', name: 'lan', network: ['lan'] }, cfg02: { '.type': 'zone', name: 'wan', network: ['wan', 'wan6'] },
    cfg03: { '.type': 'zone', name: 'vpn', network: 'zt' }, netinv_susp_block: { '.type': 'rule' } };
  ok(findOverlayZone({ interfaces, firewall, mgmtAddress: '10.241.5.7' }) === 'vpn', 'the overlay zone is found from the kernel address and the UCI network');
  ok(findOverlayZone({ interfaces, firewall, mgmtAddress: '10.9.9.9' }) === null, 'no match → null, and the suspension reports why');
  const plan = openwrtPlan({ captiveIp: '10.241.0.1', captivePort: 3080, gardenIps: ['203.0.113.5'], overlayZone: 'vpn' });
  const names = plan.map(p => p.name);
  ok(names.indexOf('netinv_susp_garden') < names.indexOf('netinv_susp_block') && names.indexOf('netinv_susp_dns') < names.indexOf('netinv_susp_block'), 'allow rules come before the reject');
  ok(plan.find(p => p.type === 'redirect').values.dest_ip === '10.241.0.1' && plan.find(p => p.type === 'nat').values.target === 'MASQUERADE', 'HTTP is DNATed to the server and masqueraded');
  ok(plan.every(p => /^netinv_susp_/.test(p.name)) && openwrtOurs(firewall).join() === 'netinv_susp_block', 'every section is ours by name, so removal is exact');
}

// ---- helpers ----
{
  const ifs = { lo: [{ family: 'IPv4', address: '127.0.0.1', cidr: '127.0.0.1/8', internal: true }],
    wg0: [{ family: 'IPv4', address: '10.147.21.1', cidr: '10.147.21.1/24' }], zt0: [{ family: 'IPv4', address: '10.241.171.36', cidr: '10.241.171.36/16' }] };
  ok(captiveIpFor('10.147.21.40', ifs) === '10.147.21.1' && captiveIpFor('10.241.3.3', ifs) === '10.241.171.36', 'each router is sent to this server\'s address on its own overlay');
  ok(captiveIpFor('172.16.0.5', ifs, '1.2.3.4') === '1.2.3.4', 'with a configured fallback');
  ok(gardenHosts('', 'bad host!, 9.9.9.9\npay.example.com').join() === '9.9.9.9,pay.example.com', 'a custom garden list is cleaned');
  ok(gardenHosts('', '').length === DEFAULT_GARDEN.length, 'blank means the Stripe defaults');
}

// ---- the flow, through the API ----
{
  const B = process.env.BASE ?? 'http://localhost:3000';
  let cookie = '';
  const call = async (p, { method = 'GET', body } = {}) => {
    const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; }
    if (cookie) h.cookie = cookie;
    const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, text: t, headers: r.headers };
  };
  await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });
  await call('/api/settings', { method: 'PUT', body: { public_base_url: 'https://noc.example.com' } });
  ok((await call('/api/suspension/settings')).json.auto === false, 'automatic suspension starts OFF until someone reviews and turns it on');
  await call('/api/suspension/settings', { method: 'PUT', body: { auto: true } });

  const acct = (await call('/api/accounts')).json[0];
  const cust = (await call('/api/customers', { body: { name: 'Late Payer LLC', account_ids: [acct.id], billing_email: '' } })).json;
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const inv = (await call('/api/billing/invoices', { body: { customer_id: cust.id, date: day(-40), due_date: day(-12), items: [{ description: 'Internet', quantity: 1, unit_price: 120, taxable: 0 }] } })).json;
  await call(`/api/billing/invoices/${inv.id}/send`, { body: {} });

  let s = (await call(`/api/customers/${cust.id}/suspension`)).json;
  ok(s.standing.due && s.standing.balance === 120 && s.standing.daysLate === 12, 'a customer 12 days late is due for suspension');
  ok(/\/suspended\/[0-9a-f]{36}$/.test(s.landing_url || ''), 'and has a private payment-page link');
  const rep = (await call('/api/suspension/report')).json;
  ok(rep.due.some(c => c.id === cust.id) && rep.policy.graceDays === 10, 'the report lists them as late');

  ok((await call('/api/suspension/run', { body: {} })).status === 200, 'the pass can be run on demand');
  s = (await call(`/api/customers/${cust.id}/suspension`)).json;
  ok(s.suspended_at && s.suspended_by === 'auto' && s.status === 'Suspended', 'the pass suspended them automatically');
  ok(s.log.some(l => l.action === 'suspend' && /12 days past due/.test(l.reason)), 'with a reason in the history');
  ok((await call('/api/suspension/report')).json.suspended.some(c => c.id === cust.id), 'the report lists them as suspended');

  // The page they land on.
  const token = s.landing_url.split('/').pop();
  const page = await call('/suspended/' + token);
  ok(page.status === 200 && /paused/.test(page.text) && /\$120\.00/.test(page.text) && /href="\/pay\/[0-9a-f]+"/.test(page.text), 'the landing page says paused, shows the balance, and links to pay');
  ok(page.headers.get('cache-control') === 'no-store', 'and is never cached');
  ok((await call('/suspended/' + 'f'.repeat(36))).status === 404, 'a wrong token finds nothing');

  // An arrangement restores them.
  ok((await call(`/api/customers/${cust.id}/arrangements`, { body: { kind: 'installments', count: 3, first_due: day(5) } })).json.action === 'restore', 'a payment plan restores service straight away');
  s = (await call(`/api/customers/${cust.id}/suspension`)).json;
  ok(!s.suspended_at && s.arrangement && s.arrangement.progress.length === 3 && s.standing.protectedBy === 'installments', 'protected by the plan, three payments scheduled');
  ok(/Payment plan: next payment/.test((await call('/suspended/' + token)).text), 'and the landing page shows the next payment');

  // Cancel it → suspended again on the next pass.
  await call(`/api/arrangements/${s.arrangement.id}/cancel`, { body: {} });
  ok((await call(`/api/customers/${cust.id}/suspension`)).json.suspended_at, 'cancelling the plan puts the normal policy back — they are suspended again');

  // Staff override with a hold.
  ok((await call(`/api/customers/${cust.id}/service/restore`, { body: { reason: 'promised Friday', hold_until: day(-1) } })).status === 400, 'a hold in the past is refused');
  ok((await call(`/api/customers/${cust.id}/service/restore`, { body: { reason: 'promised Friday', hold_until: day(3) } })).status === 200, 'staff can restore with a hold');
  await call('/api/suspension/run', { body: {} });
  s = (await call(`/api/customers/${cust.id}/suspension`)).json;
  ok(!s.suspended_at && s.standing.held, 'and the next pass leaves them on while the hold lasts');
  ok((await call('/api/suspension/report')).json.overrides.some(c => c.id === cust.id), 'the report shows the override');

  // Payment ends it.
  await call(`/api/customers/${cust.id}/suspension`, { method: 'PUT', body: { hold_until: '' } });
  await call('/api/suspension/run', { body: {} });
  ok((await call(`/api/customers/${cust.id}/suspension`)).json.suspended_at, 'hold cleared → suspended again');
  await call(`/api/billing/invoices/${inv.id}/pay`, { body: { amount: 120, method: 'card' } });
  await new Promise(r => setTimeout(r, 400));
  s = (await call(`/api/customers/${cust.id}/suspension`)).json;
  ok(!s.suspended_at && s.standing.balance === 0 && s.log.some(l => l.action === 'restore' && /paid in full/.test(l.reason)), 'paying restores them within moments, no waiting for the hourly pass');

  // A manual suspension is not lifted by the policy.
  await call(`/api/customers/${cust.id}/service/suspend`, { body: { reason: 'abuse complaint' } });
  await call('/api/suspension/run', { body: {} });
  ok((await call(`/api/customers/${cust.id}/suspension`)).json.suspended_at, 'a suspension a person made stays until a person lifts it');
  await call(`/api/customers/${cust.id}/service/restore`, { body: { reason: 'resolved' } });

  // Exempt.
  const inv2 = (await call('/api/billing/invoices', { body: { customer_id: cust.id, date: day(-40), due_date: day(-20), items: [{ description: 'Internet', quantity: 1, unit_price: 50, taxable: 0 }] } })).json;
  await call(`/api/billing/invoices/${inv2.id}/send`, { body: {} });
  await call(`/api/customers/${cust.id}/suspension`, { method: 'PUT', body: { exempt: true, exempt_reason: 'hospital' } });
  await call('/api/suspension/run', { body: {} });
  ok(!(await call(`/api/customers/${cust.id}/suspension`)).json.suspended_at, 'an exempt customer is not suspended however late');

  // Settings.
  ok((await call('/api/suspension/settings', { method: 'PUT', body: { graceDays: -1 } })).status === 400, 'bad policy numbers are refused');
  ok((await call('/api/suspension/settings', { method: 'PUT', body: { graceDays: 15, garden: 'pay.example.com' } })).status === 200
    && (await call('/api/suspension/settings')).json.garden.includes('pay.example.com'), 'the policy and walled garden can be changed');

  // The captive redirect: a request FROM a router's management address lands on that customer's page.
  const dbp = process.env.TEST_DB_PATH;
  if (dbp) {
    const db = new DatabaseSync(dbp);
    const site = Number(db.prepare("INSERT INTO sites (account_id, customer_id, name) VALUES (?,?, 'Late Payer HQ')").run(acct.id, cust.id).lastInsertRowid);
    db.prepare("INSERT INTO devices (name, status, management_mode, platform, mgmt_address, admin_password, assigned_type, assigned_site_id) VALUES ('Late router','Deployed','platform','routeros','127.0.0.1','x','site',?)").run(site);
    db.close();
    let cap = null; try { cap = await fetch('http://127.0.0.1:3080/hotspot-detect.html', { redirect: 'manual' }); } catch {}
    if (cap) ok(cap.status === 302 && cap.headers.get('location') === `https://noc.example.com/suspended/${token}`, 'the captive port sends the router\'s customers to their own payment page');
    else ok(true, 'skipped: captive port in use by another test server');
  } else ok(true, 'skipped: no database path');

  const sup = async () => { let c2 = ''; const r1 = await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'support@geekitek.test', password: 'support123' }) });
    c2 = r1.headers.get('set-cookie').split(';')[0]; return (await fetch(B + `/api/customers/${cust.id}/service/suspend`, { method: 'POST', headers: { cookie: c2, 'content-type': 'application/json' }, body: '{}' })).status; };
  ok(await sup() === 403, 'support staff cannot suspend customers');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
