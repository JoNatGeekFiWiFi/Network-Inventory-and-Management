// Monitoring additions: resources, Wi-Fi sessions, speed test, CSV, topology, config templates.
//
// Pure helpers are tested directly. The rest runs through the real server against a pretend
// MikroTik answering REST on a local port, so every request the platform makes is a real one.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {
  rosUptimeSeconds, parseRosResource, parseOwResource, parseDf, restarted, diffSessions, isRandomizedMac,
  parseOuiCsv, vendorOf, mbps, parseRosFetch, parseOwFetch, toCsv
} from '../lib/monitoring.js';
import { render, parseVars, parseRouterOS, parseOpenWrt, diffRouterOS, diffOpenWrt, resolveSection, sameRosValue } from '../lib/configtemplates.js';

let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

// ---- resources ----
{
  ok(rosUptimeSeconds('1w2d3h4m5s') === 788645 && rosUptimeSeconds('2d05:04:03') === 191043 && rosUptimeSeconds('45s') === 45, 'RouterOS uptime in both formats');
  const r = parseRosResource([{ 'cpu-load': '7', 'total-memory': '1073741824', 'free-memory': '805306368', 'total-hdd-space': '134217728', 'free-hdd-space': '100663296', uptime: '3d1h', 'cpu-count': '4' }]);
  ok(r.cpu === 7 && r.mem_pct === 25 && r.disk_pct === 25 && r.uptime_s === 262800 && r.cores === 4, 'RouterOS /system/resource → CPU, memory, storage, uptime');
  const k = { uptime: 1891557, load: [3680, 6912, 5760], memory: { total: 503259136, free: 133492736, available: 276537344 } };   // the real Katalyst
  const o = parseOwResource(k, { cores: 2, dfText: 'Filesystem 1K-blocks Used Available Use% Mounted on\noverlayfs:/overlay 5120 1280 3840 25% /' });
  ok(o.cpu === 2.8 && o.mem_pct === 45.1 && o.disk_pct === 25 && o.uptime_s === 1891557, 'OpenWrt system info → load over cores, memory by "available", flash from df');
  ok(parseOwResource({ load: [65536 * 3] }, { cores: 2 }).cpu === 100, 'load beyond the cores caps at 100%');
  ok(parseDf('') === null, 'no df output → unknown, not zero');
  ok(restarted(86400, 120) && !restarted(120, 180) && !restarted(null, 5), 'a restart is uptime going backwards');
}

// ---- Wi-Fi sessions ----
{
  const d = diffSessions([{ id: 1, mac: 'aa:bb:cc:00:00:01' }, { id: 2, mac: 'AA:BB:CC:00:00:02' }],
    [{ mac: 'AA:BB:CC:00:00:01', signal: -60 }, { mac: 'AA-BB-CC-00-00-03', signal: -70 }, { mac: 'junk' }]);
  ok(d.seen.length === 1 && d.seen[0].id === 1 && d.end.join() === '2' && d.start.length === 1 && d.start[0].mac === 'AA:BB:CC:00:00:03', 'still here / gone / new, MACs normalised, junk ignored');
  ok(isRandomizedMac('DA:A1:19:00:00:01') && !isRandomizedMac('3C:22:FB:00:00:01'), 'phones\' private (randomized) addresses are recognised');
  const oui = parseOuiCsv('Registry,Assignment,Organization Name,Organization Address\nMA-L,3C22FB,"Apple, Inc.",1 Infinite Loop\nMA-L,DCA632,Raspberry Pi Trading Ltd,Cambridge\n');
  ok(vendorOf('3c:22:fb:12:34:56', oui) === 'Apple, Inc.' && vendorOf('DC:A6:32:00:00:00', oui) === 'Raspberry Pi Trading Ltd', 'vendor from the IEEE list, including quoted names with commas');
  ok(vendorOf('DA:A1:19:00:00:01', oui) === 'Private (randomized address)' && vendorOf('00:11:22:33:44:55', oui) === null, 'randomized → said so; unknown → blank');
}

// ---- speed test + CSV ----
{
  ok(mbps(25e6, 2) === 100, '25 MB in 2 s is 100 Mbps');
  const f = parseRosFetch([{ status: 'connecting' }, { status: 'downloading', downloaded: '12000', duration: '1s' }, { status: 'finished', downloaded: '24414', total: '24414', duration: '2s' }]);
  ok(f.bytes === 24414 * 1024 && f.seconds === 2, 'RouterOS fetch progress → bytes and seconds');
  let threw = false; try { parseRosFetch([{ status: 'failed', '.about': 'DNS failure' }]); } catch (e) { threw = /DNS/.test(e.message); }
  ok(threw, 'a failed fetch is an error, not zero Mbps');
  const w = parseOwFetch('25000000 1234.50 1236.50\n');
  ok(w.bytes === 25000000 && w.seconds === 2, 'OpenWrt timing line (uptime before/after) → bytes and seconds');
  const csv = toCsv([{ a: 'x,y', b: '=HYPERLINK("evil")', c: -5, d: null }], ['a', 'b', 'c', 'd']);
  ok(csv === 'a,b,c,d\r\n"x,y","\'=HYPERLINK(""evil"")",-5,\r\n', 'CSV quotes commas and neutralises formulas (negative numbers left alone)');
}

// ---- templates: parsing and diffing ----
{
  ok(render('/ip/dns set servers={{dns}}', { dns: '1.1.1.1' }).text === '/ip/dns set servers=1.1.1.1', 'variables are substituted');
  ok(render('x={{a}} y={{b}}', { a: '1' }).missing.join() === 'b', 'a missing variable is reported, not left blank on the router');
  ok(render('x={{a}}', { a: 'one\n/system reboot' }).text === 'x=one /system reboot', 'a variable cannot add a line (no command injection by newline)');
  ok(JSON.stringify(parseVars('dns = 1.1.1.1\n# nope\nntp=time.x')) === '{"dns":"1.1.1.1","ntp":"time.x"}', 'key=value variables');
  const p = parseRouterOS('# c\n/ip/dns set servers=1.1.1.1 allow-remote-requests=no\n/ip/service[name=telnet] set disabled=yes\n/ip/firewall/filter add chain=input action=drop comment="no telnet"');
  ok(p.steps.length === 3 && p.steps[1].selector.name === 'telnet' && p.steps[2].values.comment === 'no telnet', 'RouterOS lines: singleton, selector, add');
  ok(parseRouterOS('/ip/firewall/filter add chain=input action=drop').error && parseRouterOS('ip dns set x=1').error, 'add without a comment, or a malformed line, is refused with the line number');
  ok(sameRosValue('yes', 'true') && sameRosValue('no', false) && !sameRosValue('1.1.1.1', '8.8.8.8'), 'yes/no compare equal to RouterOS\'s true/false');

  const router = {
    '/ip/dns': { servers: '8.8.8.8', 'allow-remote-requests': 'false' },
    '/ip/service': [{ '.id': '*1', name: 'telnet', disabled: 'false' }, { '.id': '*2', name: 'ssh', disabled: 'false' }],
    '/ip/firewall/filter': []
  };
  const diff = await diffRouterOS(p.steps, async (path) => router[path]);
  ok(diff.length === 3 && diff[0].action === 'set' && diff[0].body.servers === '1.1.1.1' && !('allow-remote-requests' in diff[0].body), 'only what differs is changed');
  ok(diff[1].action === 'patch' && diff[1].id === '*1' && diff[2].action === 'add', 'selector items patched by id; missing rule added');
  router['/ip/dns'].servers = '1.1.1.1'; router['/ip/service'][0].disabled = 'true'; router['/ip/firewall/filter'].push({ '.id': '*9', chain: 'input', action: 'drop', comment: 'no telnet' });
  ok((await diffRouterOS(p.steps, async (path) => router[path])).length === 0, 'a router that matches has no differences — applying again changes nothing');
  ok((await diffRouterOS(parseRouterOS('/nope set a=1').steps, async () => undefined))[0].error, 'a menu the router does not have is an error, not a silent pass');

  const w = parseOpenWrt("set system.@system[0].hostname={{name}}\nset firewall.netinv_x=rule\nset firewall.netinv_x.target='DROP'\nadd_list firewall.netinv_x.proto=tcp\ndelete network.guest");
  ok(!w.error && w.steps.length === 5 && w.steps[2].value === 'DROP', 'OpenWrt UCI lines, quotes stripped');
  const cfg = { system: { cfg01: { '.type': 'system', '.index': 0, hostname: 'OpenWrt' } }, firewall: {}, network: { guest: { '.type': 'interface' } } };
  ok(resolveSection(cfg.system, '@system[0]') === 'cfg01', '@type[n] finds the anonymous section');
  const steps = parseOpenWrt(render("set system.@system[0].hostname={{name}}\nset firewall.netinv_x=rule\nset firewall.netinv_x.target=DROP\nadd_list firewall.netinv_x.proto=tcp\ndelete network.guest", { name: 'lab-wrt' }).text).steps;
  const od = diffOpenWrt(steps, cfg);
  ok(od.map(x => x.op.op).join() === 'set,add,set,set,delete', 'hostname set, section created then its options, list, delete');
  ok(od[1].op.name === 'netinv_x' && od[1].op.type === 'rule' && od[3].op.values.proto.join() === 'tcp', 'a new section exists for the lines after it');
  const synced = { system: { cfg01: { '.type': 'system', '.index': 0, hostname: 'lab-wrt' } }, firewall: { netinv_x: { '.type': 'rule', target: 'DROP', proto: ['tcp'] } }, network: {} };
  ok(diffOpenWrt(steps, synced).length === 0, 'a router that matches has no differences');
}

// ---- through the server, against a pretend MikroTik ----
{
  const B = process.env.BASE ?? 'http://localhost:3000';
  const state = {
    '/rest/system/resource': [{ 'cpu-load': '12', 'total-memory': '1000', 'free-memory': '400', 'total-hdd-space': '1000', 'free-hdd-space': '900', uptime: '2d3h' }],
    '/rest/ip/dns': { servers: '8.8.8.8' },
    '/rest/ip/firewall/filter': [],
    '/rest/interface/wifi/registration-table': [{ interface: 'wifi1', ssid: 'Lab', 'mac-address': '3C:22:FB:00:00:01', signal: '-55' }]
  };
  const fetches = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const url = req.url.split('?')[0];
      const send = (code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      if (url === '/rest/tool/fetch') { fetches.push(JSON.parse(body || '{}')); return send(200, [{ status: 'finished', downloaded: '24414', duration: '4s' }]); }
      if (url === '/rest/ip/dns/set' && req.method === 'POST') { Object.assign(state['/rest/ip/dns'], JSON.parse(body)); return send(200, []); }
      if (url === '/rest/ip/firewall/filter' && req.method === 'PUT') { const it = { '.id': '*' + (state[url].length + 1), ...JSON.parse(body) }; state[url].push(it); return send(201, it); }
      if (state[url] !== undefined && req.method === 'GET') return send(200, state[url]);
      return send(404, { error: 'no such command' });
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  let cookie = '';
  const call = async (p, { method = 'GET', body } = {}) => {
    const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; }
    if (cookie) h.cookie = cookie;
    const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, text: t, headers: r.headers };
  };
  await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });

  const dbp = process.env.TEST_DB_PATH;
  let id = null;
  if (dbp) {
    const db = new DatabaseSync(dbp);
    id = Number(db.prepare(`INSERT INTO devices (name, status, management_mode, platform, mgmt_address, admin_password, assigned_type, assigned_site_id, wifi_json)
      VALUES ('Lab MikroTik','Deployed','platform','routeros',?, 'x', 'site', 1, '{"system":"wifi","radios":[]}')`).run('127.0.0.1:' + port).lastInsertRowid);
    db.close();
  }
  if (!id) { ok(true, 'skipped: no database path'); }
  else {
    const r = await call(`/api/devices/${id}/resources/now`, { body: {} });
    ok(r.status === 200 && r.json.cpu === 12 && r.json.mem_pct === 60 && r.json.disk_pct === 10, 'resources read from the router: CPU 12%, memory 60%, storage 10%');
    ok((await call(`/api/devices/${id}/resources?range=1h`)).json.length === 1, 'and stored for the chart');
    const h = (await call(`/api/devices/${id}/health`)).json;
    ok(h.checks.find(c => c.metric === 'cpu').value === 12 && h.checks.find(c => c.metric === 'memory').rule.threshold === 95, 'the health card now carries CPU/memory/storage checks with OpenWISP defaults');

    const st = await call(`/api/devices/${id}/speedtest`, { body: {} });
    ok(st.status === 200 && st.json.mbps === 50 && fetches[0]['keep-result'] === 'no', 'speed test: the router downloads the file itself (nothing kept) → 50 Mbps');
    ok((await call(`/api/devices/${id}/speedtests`)).json[0].mbps === 50, 'and the result is kept');

    // Wi-Fi sessions through the same path the sampler uses.
    const w1 = await call(`/api/devices/${id}/wifi-sessions/now`, { body: {} });
    ok(w1.status === 200 && w1.json.started === 1 && w1.json.connected === 1, 'a connected client opens a session');
    ok((await call(`/api/devices/${id}/wifi-sessions/now`, { body: {} })).json.started === 0, 'still connected next time → the same session');
    state['/rest/interface/wifi/registration-table'] = [];
    ok((await call(`/api/devices/${id}/wifi-sessions/now`, { body: {} })).json.ended === 1, 'gone → the session ends');
    const ws = (await call(`/api/devices/${id}/wifi-sessions?range=1d`)).json;
    ok(ws.length === 1 && ws[0].ended_at && ws[0].ssid === 'Lab' && ws[0].signal_last === -55, 'the history shows the visit, the network and the signal');
    ok((await call('/api/wifi-sessions?mac=3C:22:FB')).json.length === 1, 'and the device can be found by MAC across every access point');
    const csvR = await call(`/api/devices/${id}/export/resources.csv?range=1h`);
    ok(csvR.status === 200 && /text\/csv/.test(csvR.headers.get('content-type')) && /^ts,cpu,mem_pct,disk_pct,uptime_s/.test(csvR.text), 'resources export as CSV');
    ok((await call(`/api/devices/${id}/export/nope.csv`)).status === 404, 'unknown exports are refused');
    ok(/^created_at,device,metric/.test((await call('/api/export/alerts.csv')).text), 'alert history exports as CSV');

    // Templates, end to end.
    const bad = await call('/api/config-templates', { body: { name: 'Bad', platform: 'routeros', body: '/ip/firewall/filter add chain=input' } });
    ok(bad.status === 400 && /Line 1/.test(bad.json.error), 'a template with a mistake is refused on save, with the line');
    const t = await call('/api/config-templates', { body: { name: 'Lab baseline', platform: 'routeros', body: '/ip/dns set servers={{dns}}\n/ip/firewall/filter add chain=input action=drop protocol=tcp dst-port=23 comment="netinv: no telnet"' } });
    ok(t.status === 200, 'a template is saved');
    await call('/api/config-vars', { method: 'PUT', body: { text: 'dns=1.1.1.1' } });
    await call(`/api/devices/${id}/config`, { method: 'PUT', body: { templates: [{ id: t.json.id }] } });
    const chk = await call(`/api/devices/${id}/config/check`, { body: {} });
    ok(chk.json.status === 'drifted' && chk.json.diff.length === 2, 'check: the router differs in two places');
    ok(state['/rest/ip/dns'].servers === '8.8.8.8', 'and checking changed nothing on the router');
    const ap = await call(`/api/devices/${id}/config/apply`, { body: {} });
    ok(ap.status === 200 && ap.json.changed === 2 && ap.json.status === 'in-sync', 'apply: two changes, then the router matches');
    ok(state['/rest/ip/dns'].servers === '1.1.1.1' && state['/rest/ip/firewall/filter'].length === 1, 'the router really has the DNS server and the rule');
    ok((await call(`/api/devices/${id}/config/apply`, { body: {} })).json.changed === 0 && state['/rest/ip/firewall/filter'].length === 1, 'applying again changes nothing — no duplicate rule');
    state['/rest/ip/dns'].servers = '9.9.9.9';     // someone changes it by hand
    const drift = await call(`/api/devices/${id}/config/check`, { body: {} });
    ok(drift.json.status === 'drifted' && /servers is "9.9.9.9", should be "1.1.1.1"/.test(drift.json.diff[0].what), 'drift is noticed and described');
    ok((await call(`/api/devices/${id}/health`)).json.checks.find(c => c.metric === 'config').value === 0, 'and reported to the health checks');
    await call(`/api/devices/${id}/config`, { method: 'PUT', body: { templates: [{ id: t.json.id, vars: 'dns=9.9.9.9' }] } });
    ok((await call(`/api/devices/${id}/config/check`, { body: {} })).json.status === 'in-sync', 'a device-level variable overrides the global one');
    ok((await call(`/api/config-templates/${t.json.id}`, { method: 'DELETE' })).status === 409, 'a template in use cannot be deleted');

    const topo = await call('/api/topology');
    ok(topo.status === 200 && topo.json.hub && Array.isArray(topo.json.sites) && topo.json.sites.some(s => s.routers.some(r => r.name === 'Lab MikroTik')), 'the network map includes the router under its site');
    ok(topo.json.edges.every(e => e.from && e.to && e.status), 'edges carry their status');
  }
  srv.close();
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
