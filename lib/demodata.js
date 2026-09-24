// The demo's pretend company: customers, sites, POPs, routers, tickets, invoices and bills.
//
// Every name is made up, assembled at random from the pools below, so each nightly reset shows a
// slightly different fleet. Nothing here is copied from production — not a customer, an address, a
// circuit id or a fiber route. The only thing the demo borrows from the real system is the SHAPE of
// its traffic (lib/trafficshape.js), and that arrives later, over loopback, already anonymised.
//
// Addresses are real Phoenix-area street names with invented numbers, so the map looks right; the
// coordinates are scattered around each city's centre rather than geocoded, so no pin lands on a
// real building on purpose. Public IPs come from the documentation ranges (RFC 5737), which are
// never routed on the internet: 198.51.100.0/24 for customers, 203.0.113.0/24 for POPs, and
// 192.0.2.0/24 for the "attackers" on the blocklist.
import { randomBytes } from 'node:crypto';
import { mulberry32 } from './trafficshape.js';

export const DEMO_EMAIL = (process.env.DEMO_EMAIL || 'demo@example.com').toLowerCase();
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo';

const PLACES = ['Saguaro', 'Camelback', 'Sonoran', 'Ironwood', 'Palo Verde', 'Mesquite', 'Copper Canyon', 'Red Rock',
  'Agave', 'Ocotillo', 'Desert Willow', 'Superstition', 'Estrella', 'Cholla', 'Cactus Wren', 'Gila', 'Salt River',
  'Arroyo', 'Canyon Vista', 'Dry Creek', 'Sunridge', 'Quail Run', 'Coyote Pass', 'Tumbleweed', 'Pinnacle Peak'];
const TRADES = [['Dental', 'Office'], ['Veterinary Clinic', 'Clinic'], ['Law Group', 'Office'], ['Coffee Co.', 'Café'],
  ['Auto Care', 'Shop'], ['Apartments', 'Leasing office'], ['Brewing', 'Taproom'], ['Fitness', 'Gym'],
  ['Logistics', 'Warehouse'], ['Pediatrics', 'Clinic'], ['Realty', 'Office'], ['Montessori', 'School'],
  ['Print & Sign', 'Shop'], ['Self Storage', 'Office'], ['Animal Hospital', 'Hospital'], ['Physical Therapy', 'Clinic'],
  ['Credit Union', 'Branch'], ['Architects', 'Studio'], ['Urgent Care', 'Clinic'], ['Tile & Stone', 'Showroom']];
const FIRST = ['Maria', 'James', 'Priya', 'Luis', 'Hannah', 'Marcus', 'Elena', 'Dev', 'Tasha', 'Owen', 'Rosa', 'Ken',
  'Aisha', 'Grant', 'Mei', 'Carlos', 'Nora', 'Sam', 'Imani', 'Tyler', 'Lena', 'Victor', 'Jade', 'Rafael'];
const LAST = ['Alvarez', 'Nguyen', 'Patel', 'Brooks', 'Okafor', 'Reyes', 'Kowalski', 'Hart', 'Delgado', 'Chen', 'Morgan',
  'Ibarra', 'Singh', 'Walsh', 'Tran', 'Ellis', 'Romero', 'Fischer', 'Baker', 'Lopez', 'Yazzie', 'Castillo'];
const CITIES = [
  ['Phoenix', 'AZ', '850', 33.4484, -112.0740, ['E Camelback Rd', 'N Central Ave', 'W Indian School Rd', 'N 7th St', 'E Thomas Rd']],
  ['Tempe', 'AZ', '852', 33.4255, -111.9400, ['S Mill Ave', 'E University Dr', 'S Rural Rd', 'W Southern Ave']],
  ['Mesa', 'AZ', '852', 33.4152, -111.8315, ['E Main St', 'W Baseline Rd', 'N Country Club Dr', 'E Brown Rd']],
  ['Scottsdale', 'AZ', '852', 33.4942, -111.9261, ['N Scottsdale Rd', 'E Shea Blvd', 'N Hayden Rd']],
  ['Chandler', 'AZ', '852', 33.3062, -111.8413, ['W Chandler Blvd', 'S Arizona Ave', 'W Ray Rd']],
  ['Glendale', 'AZ', '853', 33.5387, -112.1860, ['W Bell Rd', 'N 59th Ave', 'W Glendale Ave']],
  ['Gilbert', 'AZ', '852', 33.3528, -111.7890, ['E Williams Field Rd', 'N Gilbert Rd', 'E Warner Rd']]
];
const TICKET_SUBJECTS = [
  ['Internet slow in the afternoons', 'normal', 'Speeds drop a lot after lunch. Video calls keep freezing.'],
  ['Guest Wi-Fi password change', 'low', 'Can you change the guest Wi-Fi password? A former employee still has it.'],
  ['Printer can\'t reach the network', 'normal', 'The front desk printer shows offline since this morning.'],
  ['Add a static IP for our camera system', 'normal', 'Our security vendor needs a static public IP for remote viewing.'],
  ['Total outage — nothing is working', 'high', 'No internet at all at the office. Lights on the router are orange.'],
  ['Wi-Fi dead spot in the back room', 'low', 'Signal is very weak in the storage room at the back.'],
  ['Invoice question', 'low', 'We were billed twice for last month I think — can you check?']
];

function makeRand(seed) {
  const r = mulberry32(seed);
  const api = {
    r,
    int: (a, b) => a + Math.floor(r() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    chance: (p) => r() < p,
    person: () => `${api.pick(FIRST)} ${api.pick(LAST)}`,
    mac: () => Array.from({ length: 6 }, (_, i) => (i === 0 ? 0x48 : api.int(0, 255)).toString(16).padStart(2, '0').toUpperCase()).join(':'),
    serial: () => Array.from({ length: 12 }, () => '0123456789ABCDEF'[api.int(0, 15)]).join(''),
    phone: (area = '480') => `(${area}) 555-01${String(api.int(0, 99)).padStart(2, '0')}`
  };
  return api;
}

const isoDate = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n, now = Date.now()) => new Date(now - n * 86400000);
const sqlTs = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

/**
 * Fill an empty database with the demo company.
 *
 * Runs once, on first start of a fresh demo database; the nightly reset deletes the database, so it
 * runs again the next morning with a new seed. Returns the ids the traffic simulator needs.
 */
export function populateDemo(db, { hashPassword, seed = Date.now() % 2147483647, now = Date.now() } = {}) {
  const R = makeRand(seed);
  const q = (sql) => db.prepare(sql);
  const one = (sql, ...a) => q(sql).get(...a);
  const run = (sql, ...a) => q(sql).run(...a);
  const id = (sql, ...a) => Number(q(sql).run(...a).lastInsertRowid);
  const setting = (k, v) => run('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);

  db.exec('BEGIN');
  try {
    // ---- people ----
    // The visitor signs in as an admin so every menu is visible; the demo gate is what stops them
    // changing users, settings or mail. The other staff exist to populate "assigned to" and notes,
    // and have random passwords nobody knows.
    const unusable = () => hashPassword(randomBytes(24).toString('hex'));
    run('INSERT INTO users (name,email,password_hash,role,active) VALUES (?,?,?,?,1)', 'Demo Visitor', DEMO_EMAIL, hashPassword(DEMO_PASSWORD), 'admin');
    const staff = [['noc', 'NOC'], ['field', 'Field tech'], ['support', 'Support']].map(([role, label]) => {
      const name = R.person();
      run('INSERT INTO users (name,email,password_hash,role,active) VALUES (?,?,?,?,1)', name, `${name.split(' ')[0].toLowerCase()}.${role}@example.com`, unusable(), role);
      return { name, role, label };
    });
    const staffOf = (role) => staff.find(s => s.role === role);

    setting('company_name', process.env.DEMO_COMPANY || 'Demo Networks');
    setting('company_address', '100 N Example Ave, Phoenix AZ 85004');
    setting('bill_prefix', 'INV-'); setting('bill_next', '2001');

    // ---- models ----
    const model = (m) => (one('SELECT id FROM device_models WHERE model=? COLLATE NOCASE', m) || {}).id || null;
    const M = {
      ccr: model('CCR2004-16G-2S+'), rb5009: model('RB5009UG+S+IN'), hapax3: model('hAP ax³') || model('hAP ax lite'),
      capax: model('cAP ax'), wapax: model('wAP ax'), crs326: model('CRS326-24G-2S+IN'), crs328: model('CRS328-24P-4S+RM')
    };

    // ---- carriers and vendors ----
    const carrier = (name) => (one('SELECT id FROM upstream_providers WHERE LOWER(name)=LOWER(?)', name) || {}).id
      || id("INSERT INTO upstream_providers (name, provider_type, vendor_kind) VALUES (?, 'Carrier', 'carrier')", name);
    const cox = carrier('Cox'), lumen = carrier('Lumen'), verizon = carrier('Verizon'), att = carrier('AT&T');
    for (const [cid, dom] of [[cox, 'cox'], [lumen, 'lumen'], [verizon, 'verizon'], [att, 'att']]) {
      run(`UPDATE upstream_providers SET vendor_kind='carrier', email=?, payment_terms='Net 30', our_account_number=? WHERE id=?`,
        `billing@${dom}.example.com`, String(R.int(100000000, 999999999)), cid);
    }
    const vendor = (name, kind, extra = {}) => {
      const v = id(`INSERT INTO upstream_providers (name, provider_type, vendor_kind, email, phone, payment_terms, is_1099, notes)
        VALUES (?,?,?,?,?,?,?,?)`, name, null, kind, extra.email || null, R.phone('602'), extra.terms || 'Net 30', extra.is1099 ? 1 : 0, extra.notes || null);
      if (extra.contact) run('INSERT INTO vendor_contacts (vendor_id,name,role,email,phone) VALUES (?,?,?,?,?)', v, R.person(), extra.contact, extra.email || null, R.phone('602'));
      if (extra.w9) run("UPDATE upstream_providers SET w9_received_at=?, tin_type='ein', tin_last4=?, tax_classification='llc', legal_name=? WHERE id=?",
        sqlTs(daysAgo(R.int(20, 200), now)), String(R.int(1000, 9999)), name, v);
      return v;
    };
    const colo = vendor(`${R.pick(PLACES)} Data Center`, 'colocation', { email: 'ar@colo.example.com', contact: 'Account manager', notes: 'Cage 14, two racks.' });
    const splicer = vendor(`${R.pick(LAST)} Fiber & Low Voltage`, 'contractor', { email: 'office@splice.example.com', contact: 'Owner', is1099: true, w9: true });
    const tech2 = vendor(`${R.pick(PLACES)} Cabling`, 'contractor', { email: 'jobs@cabling.example.com', is1099: true });
    const dist = vendor('Example Networks Supply', 'distributor', { email: 'orders@supply.example.com', contact: 'Sales rep' });
    const power = vendor('Valley Power & Light', 'utility', { email: 'billing@power.example.com', terms: 'Due on receipt' });
    const saas = vendor('Cloudpager', 'software', { email: 'billing@cloudpager.example.com', terms: 'Card on file' });

    // ---- POPs ----
    const popDefs = [
      ['Phoenix Core', 'POP-PHX01', CITIES[0]], ['Tempe Hub', 'POP-TMP02', CITIES[1]], ['Mesa East', 'POP-MSA03', CITIES[2]]
    ];
    const pops = popDefs.map(([name, code, c], i) => {
      const addr = `${R.int(100, 4999)} ${R.pick(c[5])}, ${c[0]} ${c[1]} ${c[2]}${R.int(10, 99)}`;
      const pid = id("INSERT INTO pops (name, code, address, lat, lng, status, current_public_ip) VALUES (?,?,?,?,?,'Active',?)",
        name, code, addr, c[3] + (R.r() - 0.5) * 0.02, c[4] + (R.r() - 0.5) * 0.02, `203.0.113.${10 + i}`);
      run('INSERT INTO pop_notes (pop_id,author,author_role,body) VALUES (?,?,?,?)', pid, staffOf('field').name, 'Field tech',
        R.pick(['Replaced the UPS batteries. Runtime tested at 42 minutes.', 'Labelled every patch cable in rack 2.', 'Cleaned the dust filters; intake temp down 3°F.']));
      return { id: pid, name, code, city: c };
    });

    // ---- accounts (what we buy from carriers) ----
    const accounts = [];
    const account = (name, carrierId, cost, extra = {}) => {
      const aid = id(`INSERT INTO accounts (name, account_number, status, carrier_id, monthly_cost, email, due_day, autopay, notes)
        VALUES (?,?, 'Active', ?,?,?,?,?,?)`, name, String(R.int(10000000, 99999999)), carrierId, cost,
        extra.email || null, R.int(1, 28), R.chance(0.6) ? 1 : 0, extra.notes || null);
      accounts.push({ id: aid, name, carrierId });
      return aid;
    };
    const aLumen = account('Lumen — Phoenix transit', lumen, 1600, { notes: '10G transit at Phoenix Core.' });
    const aCoxT = account('Cox Business — Tempe', cox, 850);
    const aCoxM = account('Cox Business — Mesa', cox, 620);
    const aAtt = account('AT&T Dedicated — Scottsdale', att, 1100);
    const aVz = account('Verizon Wireless — failover pool', verizon, 340, { notes: 'Pooled data plan for the 5G failover routers.' });
    run('INSERT INTO account_subaccounts (account_id,name,status,monthly_cost) VALUES (?,?,?,?)', aVz, 'Line group A', 'active', 45);
    run('INSERT INTO account_subaccounts (account_id,name,status,monthly_cost) VALUES (?,?,?,?)', aVz, 'Line group B', 'active', 45);

    // POP upstreams
    run("INSERT INTO pop_circuits (pop_id,source_type,source_account_id,circuit_id,bandwidth,status) VALUES (?,'account',?,?,?,'Up')", pops[0].id, aLumen, `LMN-${R.int(10000, 99999)}`, '10G');
    run("INSERT INTO pop_circuits (pop_id,source_type,source_pop_id,circuit_id,bandwidth,status) VALUES (?,'pop',?,?,?,'Up')", pops[1].id, pops[0].id, 'XC-PHX-TMP', '10G');
    run("INSERT INTO pop_circuits (pop_id,source_type,source_pop_id,circuit_id,bandwidth,status) VALUES (?,'pop',?,?,?,'Up')", pops[2].id, pops[0].id, 'XC-PHX-MSA', '10G');

    // ---- devices ----
    const DCOLS = ['name', 'model_id', 'serial', 'mac', 'status', 'online', 'assigned_type', 'assigned_site_id', 'assigned_pop_id',
      'management_mode', 'platform', 'mgmt_overlay', 'mgmt_address', 'ownership', 'owner_org', 'carrier_id', 'associated_connection_id',
      'admin_username', 'admin_password', 'tech_username', 'tech_password', 'interfaces_json', 'iface_roles_json', 'wifi_json',
      'ros_version', 'fw_version', 'last_polled', 'cell_carrier', 'cell_phone', 'cell_imei'];
    const devStmt = q(`INSERT INTO devices (${DCOLS.join(',')}) VALUES (${DCOLS.map(() => '?').join(',')})`);
    const routers = [];         // what the traffic simulator drives
    let mgmtN = 10;
    const pw = () => randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, 'x');
    const dev = (o) => {
      const row = { status: 'Deployed', online: 1, management_mode: 'platform', platform: 'routeros', ownership: 'us',
        admin_username: 'admin', admin_password: pw(), tech_username: 'fieldtech', tech_password: pw(), ros_version: R.pick(['7.15.3', '7.16.2', '7.18.2']),
        last_polled: new Date(now - R.int(1, 50) * 60000).toISOString(), ...o };
      if (row.status === 'Deployed' && !row.mgmt_address) { row.mgmt_overlay = R.chance(0.5) ? 'WireGuard' : 'ZeroTier'; row.mgmt_address = `10.147.${Math.floor(mgmtN / 250)}.${(mgmtN++ % 250) + 2}`; }
      if (!row.serial) row.serial = R.serial();
      if (!row.mac) row.mac = R.mac();
      return Number(devStmt.run(...DCOLS.map(c => (row[c] === undefined ? null : row[c]))).lastInsertRowid);
    };
    const ports = (list) => JSON.stringify(list.map(([name, type, extra = {}]) => ({
      name, type, running: extra.running ?? true, disabled: false, mac: R.mac(), comment: extra.comment || '', ips: extra.ips || [], speed: extra.speed || (type === 'ether' ? '1Gbps' : '')
    })));

    // POP core routers
    pops.forEach((p, i) => {
      const wan = i === 0 ? 'sfp-sfpplus1' : 'sfp-sfpplus2';
      const did = dev({ name: `${p.code} core`, model_id: M.ccr, assigned_type: 'pop', assigned_pop_id: p.id,
        interfaces_json: ports([['sfp-sfpplus1', 'ether', { speed: '10Gbps', comment: i === 0 ? 'Lumen transit' : 'to PHX core', ips: [`203.0.113.${10 + i}`] }],
          ['sfp-sfpplus2', 'ether', { speed: '10Gbps', comment: 'customer aggregation' }], ['ether1', 'ether', { comment: 'OOB mgmt' }], ['bridge-cust', 'bridge']]),
        iface_roles_json: JSON.stringify({ [wan]: 'WAN1', 'bridge-cust': 'LAN', ether1: 'MGMT' }) });
      routers.push({ id: did, ifaces: [{ name: wan, peak: i === 0 ? 3.2e9 : 1.1e9 }], latency: 3 + i });
      dev({ name: `${p.code} aggregation switch`, model_id: M.crs326, assigned_type: 'pop', assigned_pop_id: p.id,
        interfaces_json: ports([['ether1', 'ether'], ['ether2', 'ether'], ['sfp-sfpplus1', 'ether', { speed: '10Gbps' }]]) });
    });

    // ---- customers, sites and their gear ----
    const usedNames = new Set();
    const customers = [];
    const services = [
      // [served type, account, pop index, bandwidth, monthly price]
      ['pop', null, 0, '1G', 899], ['pop', null, 1, '500M', 549], ['pop', null, 2, '300M', 379], ['brokered', aCoxT, null, '300M', 329],
      ['brokered', aCoxM, null, '500M', 429], ['brokered', aAtt, null, '1G', 799]
    ];
    const nCustomers = R.int(11, 14);
    let ipN = 20;
    for (let i = 0; i < nCustomers; i++) {
      let name, trade;
      do { const place = R.pick(PLACES); trade = R.pick(TRADES); name = `${place} ${trade[0]}`; } while (usedNames.has(name));
      usedNames.add(name);
      const svc = services[i % services.length];
      const acct = svc[1] || aLumen;
      const status = i === nCustomers - 1 ? 'Prospect' : 'Active';
      const contact = R.person();
      const dom = name.toLowerCase().replace(/[^a-z]+/g, '') + '.example.com';
      const cid = id("INSERT INTO customers (account_id, name, status, billing_email, sms_number, notes) VALUES (?,?,?,?,?,?)",
        acct, name, status, `billing@${dom}`, R.phone(), `Main contact: ${contact}`);
      run('INSERT OR IGNORE INTO account_customers (account_id, customer_id) VALUES (?,?)', acct, cid);
      const failover = R.chance(0.35);
      if (failover) run('INSERT OR IGNORE INTO account_customers (account_id, customer_id) VALUES (?,?)', aVz, cid);
      customers.push({ id: cid, name, contact, email: `${contact.split(' ')[0].toLowerCase()}@${dom}`, price: svc[4], status });

      const nSites = R.chance(0.2) ? 2 : 1;
      for (let s = 0; s < nSites; s++) {
        const c = svc[2] != null ? pops[svc[2]].city : R.pick(CITIES);
        const addr = `${R.int(100, 9899)} ${R.pick(c[5])}${R.chance(0.4) ? ' Suite ' + R.int(100, 450) : ''}, ${c[0]} ${c[1]} ${c[2]}${R.int(10, 99)}`;
        const pub = `198.51.100.${ipN++}`;
        const siteName = nSites > 1 ? `${name} — ${s === 0 ? 'Main' : trade[1]}` : `${name} ${trade[1]}`;
        const siteStatus = status === 'Prospect' ? 'Planned' : 'Active';
        const sid = id(`INSERT INTO sites (account_id, customer_id, name, service_address, lat, lng, status, current_public_ip, notes) VALUES (?,?,?,?,?,?,?,?,?)`,
          acct, cid, siteName, addr, c[3] + (R.r() - 0.5) * 0.06, c[4] + (R.r() - 0.5) * 0.06, siteStatus, pub, null);
        if (status === 'Prospect') continue;
        run('INSERT INTO site_access (site_id, details_json) VALUES (?,?)', sid, JSON.stringify({
          gate_code: `${R.int(1000, 9999)}#`, access_hours: R.pick(['Mon–Fri 8a–5p', 'Mon–Sat 7a–7p', '24/7 with escort']),
          contacts: [{ name: `${contact} · Office manager`, phone: R.phone() }]
        }));
        if (R.chance(0.6)) run('INSERT INTO site_notes (site_id,author,author_role,body,created_at) VALUES (?,?,?,?,?)', sid, staffOf('field').name, 'Field tech',
          R.pick(['Router is in the IT closet behind reception, top shelf.', 'AP mounted above the drop ceiling in the hallway — ladder needed.',
            'Customer asked us to schedule visits before 10am.', 'Replaced a bad patch cable to the switch; link now negotiates 1G.']), sqlTs(daysAgo(R.int(2, 90), now)));

        const down = i === 3 && s === 0;             // one site with a problem, so the dashboard has something to show
        const primary = id(`INSERT INTO connections (site_id, role, priority, served_type, served_pop_id, served_provider_id, circuit_id, wan_port, ip_type, static_ip, bandwidth, status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, sid, 'Primary', 1, svc[0], svc[2] != null ? pops[svc[2]].id : null, svc[0] === 'brokered' ? accounts.find(a => a.id === acct).carrierId : null,
          svc[0] === 'brokered' ? `${svc[1] === aAtt ? 'ATT' : 'COX'}-${R.int(10000, 99999)}` : null, 'ether1', 'Static', pub, svc[3], down ? 'Down' : 'Up');
        let fo = null;
        if (failover) fo = id(`INSERT INTO connections (site_id, role, priority, served_type, served_provider_id, wan_port, ip_type, bandwidth, status)
          VALUES (?,?,?,?,?,?,?,?,?)`, sid, 'Failover', 2, 'brokered', verizon, 'lte1', 'Dynamic', '5G', down ? 'Up' : 'Standby');

        const big = svc[3] === '1G';
        const peak = { '1G': 6e8, '500M': 3e8, '300M': 1.8e8 }[svc[3]] * (0.5 + R.r() * 0.5);
        const ifList = [['ether1', 'ether', { comment: 'WAN', ips: [pub] }], ['ether2', 'ether'], ['ether3', 'ether'], ['ether4', 'ether', { running: false }],
          ['bridge', 'bridge', { ips: ['192.168.88.1'] }]];
        if (failover) ifList.push(['lte1', 'lte', { comment: '5G failover' }]);
        const roles = { ether1: 'WAN1', bridge: 'LAN' }; if (failover) roles.lte1 = 'WAN2';
        const rid = dev({ name: 'Edge router', model_id: big ? M.ccr : M.rb5009, assigned_type: 'site', assigned_site_id: sid, associated_connection_id: primary,
          online: down ? 0 : 1, interfaces_json: ports(ifList), iface_roles_json: JSON.stringify(roles) });
        if (!down) routers.push({ id: rid, ifaces: [{ name: 'ether1', peak }, ...(failover ? [{ name: 'lte1', peak: peak * 0.01 }] : [])], latency: R.int(6, 18), dhcp: true, site: siteName });
        if (fo) run('UPDATE devices SET cell_carrier=?, cell_phone=?, cell_imei=? WHERE id=?', 'Verizon', R.phone('602'), String(R.int(350000000, 359999999)) + String(R.int(100000, 999999)), rid);

        const nAps = R.int(1, big ? 3 : 2);
        for (let a = 0; a < nAps; a++) {
          const ssid = name.split(' ').slice(0, 2).join('') + (a === 0 ? '' : '-Guest');
          dev({ name: nAps > 1 ? `AP ${a + 1}` : 'Wi-Fi AP', model_id: R.pick([M.capax, M.wapax, M.hapax3].filter(Boolean)), assigned_type: 'site', assigned_site_id: sid,
            online: down ? 0 : (R.chance(0.93) ? 1 : 0),
            interfaces_json: ports([['ether1', 'ether'], ['wifi1', 'wifi'], ['wifi2', 'wifi']]),
            wifi_json: JSON.stringify({ system: 'wifi', radios: [{ iface: 'wifi1', ssid, disabled: false, band: '5ghz-ax', hasPassword: true }, { iface: 'wifi2', ssid, disabled: false, band: '2ghz-ax', hasPassword: true }] }) });
        }
        if (big) dev({ name: 'Office switch', model_id: M.crs328, assigned_type: 'site', assigned_site_id: sid, interfaces_json: ports([['ether1', 'ether'], ['ether2', 'ether'], ['sfp-sfpplus1', 'ether', { speed: '10Gbps' }]]) });
      }
    }
    // Spares on the shelf.
    for (const [n, m] of [['Spare router', M.rb5009], ['Spare router', M.rb5009], ['Spare AP', M.capax], ['5G failover kit', M.hapax3]]) {
      dev({ name: n, model_id: m, status: 'In stock', online: 0, mgmt_overlay: null, mgmt_address: null, last_polled: null });
    }

    // ---- billing ----
    const invStmt = q(`INSERT INTO bill_invoices (number, customer_id, email, date, due_date, status, subtotal, tax, total, balance, sent_at, terms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const itemStmt = q('INSERT INTO bill_items (invoice_id, description, quantity, unit_price, amount, taxable) VALUES (?,?,?,?,?,0)');
    let invN = 2001;
    const active = customers.filter(c => c.status === 'Active');
    for (const c of active) {
      const items = [{ description: 'Managed internet service', quantity: 1, unit_price: c.price, taxable: 0 }];
      if (R.chance(0.5)) items.push({ description: 'Managed Wi-Fi', quantity: 1, unit_price: 79, taxable: 0 });
      const total = items.reduce((t, x) => t + x.quantity * x.unit_price, 0);
      const next = new Date(now); next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth() + 1);
      run('INSERT INTO bill_recurring (customer_id, frequency, next_date, tax_rate, items_json, auto_send, active) VALUES (?,?,?,?,?,1,1)',
        c.id, 'monthly', isoDate(next), 0, JSON.stringify(items));
      for (let m = 3; m >= 0; m--) {
        const d = new Date(now); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - m);
        const due = new Date(d.getTime() + 15 * 86400000);
        const late = m === 1 && c === active[2];
        const status = m === 0 ? 'sent' : (late ? 'sent' : 'paid');
        const inv = Number(invStmt.run(`INV-${invN++}`, c.id, c.email, isoDate(d), isoDate(due), status, total, 0, total, status === 'paid' ? 0 : total, sqlTs(d), 'Net 15').lastInsertRowid);
        for (const it of items) itemStmt.run(inv, it.description, it.quantity, it.unit_price, it.quantity * it.unit_price);
        if (status === 'paid') run("INSERT INTO bill_payments (invoice_id, date, amount, method, reference) VALUES (?,?,?,?,?)", inv,
          isoDate(new Date(d.getTime() + R.int(1, 14) * 86400000)), total, R.pick(['ach', 'card', 'check']), `DEMO-${R.int(1000, 9999)}`);
      }
    }
    setting('bill_next', String(invN));

    // ---- expenses ----
    const exp = (vendorId, daysBack, dollars, category, description, status, extra = {}) => {
      const d = daysAgo(daysBack, now);
      run(`INSERT INTO expenses (vendor_id, date, due_date, amount_cents, category, description, reference, status, paid_at, paid_method, parent_type, parent_id, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, vendorId, isoDate(d), isoDate(new Date(d.getTime() + 30 * 86400000)), Math.round(dollars * 100), category, description,
      `${R.int(100000, 999999)}`, status, status === 'paid' ? sqlTs(new Date(d.getTime() + 5 * 86400000)) : null, status === 'paid' ? 'ach' : null,
      extra.parent_type || null, extra.parent_id || null, DEMO_EMAIL);
    };
    const nextMonth = () => { const d = new Date(now); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); return isoDate(d); };
    const rec = (vendorId, description, category, dollars, extra = {}) => run(`INSERT INTO expense_recurring (vendor_id, description, category, amount_cents, frequency, anchor_day, next_date, due_days, autopay, parent_type, parent_id, active, created_by)
      VALUES (?,?,?,?, 'monthly', 1, ?, ?, ?, ?, ?, 1, ?)`, vendorId, description, category, Math.round(dollars * 100), nextMonth(), extra.due ?? 30, extra.autopay ? 1 : 0, extra.parent_type || null, extra.parent_id || null, DEMO_EMAIL);
    rec(colo, 'Two racks + cross-connects', 'colocation', 1850, { parent_type: 'pop', parent_id: pops[0].id });
    rec(power, 'Metered power — Tempe Hub', 'power', 310, { parent_type: 'pop', parent_id: pops[1].id });
    rec(saas, 'Paging & on-call', 'software', 29, { autopay: true, due: 0 });
    for (let m = 1; m <= 3; m++) {
      exp(colo, m * 30, 1850, 'colocation', 'Two racks + cross-connects', 'paid', { parent_type: 'pop', parent_id: pops[0].id });
      exp(power, m * 30 + 2, 280 + R.int(0, 60), 'power', 'Metered power — Tempe Hub', 'paid', { parent_type: 'pop', parent_id: pops[1].id });
    }
    exp(dist, 12, 2340.5, 'hardware', '6 × RB5009, 10 × cAP ax', 'paid');
    exp(dist, 3, 612.4, 'hardware', 'SFP+ modules and patch cables', 'unpaid');
    exp(splicer, 8, 1450, 'install', `Fiber drop — ${active[0] ? active[0].name : 'new customer'}`, 'unpaid', active[0] ? { parent_type: 'customer', parent_id: active[0].id } : {});
    exp(tech2, 21, 780, 'install', 'Cable runs for two APs', 'paid', active[1] ? { parent_type: 'customer', parent_id: active[1].id } : {});

    // ---- tickets ----
    const tk = active.slice(0, Math.min(active.length, TICKET_SUBJECTS.length));
    tk.forEach((c, i) => {
      const [subject, priority, body] = TICKET_SUBJECTS[i];
      const opened = daysAgo(R.int(0, 12), now);
      const status = i < 3 ? 'open' : (i < 5 ? 'pending' : 'closed');
      const tid = id(`INSERT INTO tickets (customer_id, subject, status, priority, opened_by, channel, last_channel, contact_email, assigned_to, created_at, updated_at, closed_at)
        VALUES (?,?,?,?, 'customer', ?, ?, ?, ?, ?, ?, ?)`, c.id, subject, status, priority, i % 2 ? 'email' : 'portal', i % 2 ? 'email' : 'portal', c.email,
      staffOf(i % 2 ? 'support' : 'noc').name, sqlTs(opened), sqlTs(opened), status === 'closed' ? sqlTs(new Date(opened.getTime() + 86400000)) : null);
      run('UPDATE tickets SET number=? WHERE id=?', 'TKT-' + (1000 + tid), tid);
      run("INSERT INTO ticket_messages (ticket_id, author_type, author, body, channel, direction, created_at) VALUES (?, 'customer', ?, ?, ?, 'in', ?)",
        tid, c.contact, body, i % 2 ? 'email' : 'portal', sqlTs(opened));
      if (status !== 'open' || i === 0) run("INSERT INTO ticket_messages (ticket_id, author_type, author, body, channel, direction, created_at) VALUES (?, 'staff', ?, ?, ?, 'out', ?)",
        tid, staffOf('support').name, R.pick(['Thanks — we\'re looking into it now and will update you shortly.', 'We can see the issue on our side and have a fix scheduled.',
          'Done! Let us know if anything else comes up.']), i % 2 ? 'email' : 'portal', sqlTs(new Date(opened.getTime() + 3600000)));
    });

    // ---- blocklist ----
    const reasons = ['SSH brute force', 'Winbox login failures', 'Port scan', 'DNS amplification probe'];
    for (let i = 0; i < 18; i++) {
      run('INSERT OR IGNORE INTO blocklist (ip, reason, hits, source, active, first_seen, last_seen) VALUES (?,?,?,?,?,?,?)',
        `192.0.2.${R.int(1, 254)}`, R.pick(reasons), R.int(3, 400), 'harvest', R.chance(0.85) ? 1 : 0, sqlTs(daysAgo(R.int(5, 40), now)), sqlTs(daysAgo(R.int(0, 4), now)));
    }

    run("INSERT INTO audit_log (actor, role, action, target, details) VALUES ('system','system','seed','database','Demo data generated')");
    db.exec('COMMIT');
    return { routers, seed };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** The routers the simulator should drive, read back from the database (after a restart, say). */
export function demoRouters(db) {
  const out = [];
  const rows = db.prepare("SELECT id, iface_roles_json, interfaces_json, assigned_type FROM devices WHERE archived_at IS NULL AND status='Deployed' AND online=1 AND iface_roles_json IS NOT NULL").all();
  for (const d of rows) {
    let roles = {}; try { roles = JSON.parse(d.iface_roles_json || '{}'); } catch {}
    const wan = Object.entries(roles).filter(([, r]) => r === 'WAN1' || r === 'WAN2').map(([n, r]) => ({ name: n, role: r }));
    if (!wan.length) continue;
    // Peak from a stable hash of the id, so a restart does not change a router's scale.
    const h = ((d.id * 2654435761) >>> 0) / 4294967296;
    const base = d.assigned_type === 'pop' ? 1.5e9 : 1.5e8 + h * 4e8;
    out.push({ id: d.id, ifaces: wan.map(w => ({ name: w.name, peak: w.role === 'WAN2' ? base * 0.01 : base })), latency: d.assigned_type === 'pop' ? 3 : 6 + Math.round(h * 12) });
  }
  return out;
}
