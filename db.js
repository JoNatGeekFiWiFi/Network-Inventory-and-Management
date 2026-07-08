// Database bootstrap + seed for the Network Inventory & Management Platform
// Uses Node's built-in SQLite (node:sqlite) — no native build step required.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hashPassword } from './hash.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dirname, 'data.db');
// Uploaded note attachments live next to the DB (so they ride the same data volume)
export const UPLOADS_DIR = process.env.UPLOADS_DIR || join(dirname(DB_PATH), 'uploads');
try { mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}
// Router config backups (.rsc) also ride the data volume
export const BACKUPS_DIR = process.env.BACKUPS_DIR || join(dirname(DB_PATH), 'backups');
try { mkdirSync(BACKUPS_DIR, { recursive: true }); } catch {}
// RouterOS package files (.npk) for zero-touch provisioning
export const PACKAGES_DIR = process.env.PACKAGES_DIR || join(dirname(DB_PATH), 'packages');
try { mkdirSync(PACKAGES_DIR, { recursive: true }); } catch {}

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export function initSchema() {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
}

export function isEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM accounts').get();
  return row.n === 0;
}

// Lightweight migrations: add columns to existing tables if missing (preserves data)
export function migrate() {
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(col => col.name === c);
  const ensure = (t, c, def) => { if (!has(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  ensure('accounts', 'sub_account', 'TEXT');
  ensure('accounts', 'pin', 'TEXT');
  ensure('accounts', 'email', 'TEXT');
  ensure('accounts', 'portal_url', 'TEXT');
  ensure('accounts', 'portal_password', 'TEXT');
  ensure('accounts', 'security_questions', 'TEXT');
  ensure('devices', 'zt_node_id', 'TEXT');
  ensure('devices', 'wg_public_key', 'TEXT');
  ensure('devices', 'wg_private_key', 'TEXT');
  ensure('devices', 'admin_username', 'TEXT');
  ensure('devices', 'interfaces_json', 'TEXT');
  ensure('devices', 'iface_roles_json', 'TEXT');
  ensure('devices', 'wifi_json', 'TEXT');
  ensure('devices', 'ros_version', 'TEXT');
  ensure('devices', 'fw_version', 'TEXT');
  ensure('devices', 'fw_upgrade', 'TEXT');
  ensure('devices', 'enroll_pending', 'INTEGER DEFAULT 0');
  ensure('devices', 'enrolled_at', 'TEXT');
  ensure('devices', 'last_polled', 'TEXT');
  ensure('pops', 'current_mgmt_ip', 'TEXT');
  ensure('pops', 'current_public_ip', 'TEXT');
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
  db.exec('CREATE TABLE IF NOT EXISTS pop_access (pop_id INTEGER PRIMARY KEY, body TEXT)');
  db.exec('CREATE TABLE IF NOT EXISTS pop_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, pop_id INTEGER NOT NULL, author TEXT, author_role TEXT, body TEXT, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  db.exec('CREATE TABLE IF NOT EXISTS iface_traffic (device_id INTEGER, iface TEXT, ts TEXT, rx_bps INTEGER, tx_bps INTEGER)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_iftr ON iface_traffic(device_id, iface, ts)');
  db.exec('CREATE TABLE IF NOT EXISTS dev_latency (device_id INTEGER, ts TEXT, ms REAL)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_lat ON dev_latency(device_id, ts)');
  db.exec("CREATE TABLE IF NOT EXISTS blocklist (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT UNIQUE NOT NULL, reason TEXT, hits INTEGER DEFAULT 1, source TEXT, active INTEGER DEFAULT 1, first_seen TEXT DEFAULT (datetime('now')), last_seen TEXT DEFAULT (datetime('now')))");
  // Customer entity between Account and Site
  db.exec("CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, name TEXT NOT NULL, status TEXT DEFAULT 'Active', notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  ensure('sites', 'customer_id', 'INTEGER');
  // Accounts <-> Customers is many-to-many (an account serves many customers; a customer can be served by many accounts)
  db.exec("CREATE TABLE IF NOT EXISTS account_customers (account_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, PRIMARY KEY (account_id, customer_id))");
  // POP upstream/bandwidth circuits — source is another POP or an account (carrier)
  db.exec("CREATE TABLE IF NOT EXISTS pop_circuits (id INTEGER PRIMARY KEY AUTOINCREMENT, pop_id INTEGER NOT NULL, source_type TEXT NOT NULL, source_pop_id INTEGER, source_account_id INTEGER, circuit_id TEXT, bandwidth TEXT, status TEXT DEFAULT 'Up', notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  // Note attachments (pictures + PDFs) — files stored on disk, metadata here
  db.exec("CREATE TABLE IF NOT EXISTS note_attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_type TEXT NOT NULL, parent_id INTEGER NOT NULL, note_id INTEGER, filename TEXT, mime TEXT, size INTEGER, stored_name TEXT NOT NULL, author TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  db.exec("CREATE INDEX IF NOT EXISTS idx_note_att ON note_attachments(note_id)");
  // Weekly router config backups (.rsc exports); files on disk, metadata here
  db.exec("CREATE TABLE IF NOT EXISTS router_backups (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'ok', error TEXT, size INTEGER, stored_name TEXT, format TEXT DEFAULT 'rsc', source TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  db.exec("CREATE INDEX IF NOT EXISTS idx_rbak ON router_backups(device_id, created_at)");
  // Batch config jobs (fleet-wide changes) + per-device results
  db.exec("CREATE TABLE IF NOT EXISTS batch_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT, summary TEXT, actor TEXT, total INTEGER, ok INTEGER, fail INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  db.exec("CREATE TABLE IF NOT EXISTS batch_results (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL, device_id INTEGER, device_name TEXT, status TEXT, detail TEXT)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_batchres ON batch_results(job_id)");
  // RouterOS package files (.npk) + per-device assignment for zero-touch provisioning
  db.exec("CREATE TABLE IF NOT EXISTS packages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, filename TEXT, arch TEXT, version TEXT, size INTEGER, stored_name TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  db.exec("CREATE TABLE IF NOT EXISTS device_packages (device_id INTEGER NOT NULL, package_id INTEGER NOT NULL, PRIMARY KEY (device_id, package_id))");
  // Provisioning bench nodes (netinstall benches) — token-authenticated
  db.exec("CREATE TABLE IF NOT EXISTS prov_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, token TEXT UNIQUE, location TEXT, last_seen TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  // Public site-access requests (visitor check-in: name/contact/ID photo) + site links
  db.exec("CREATE TABLE IF NOT EXISTS access_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, first_name TEXT, last_name TEXT, email TEXT, phone TEXT, id_photo TEXT, status TEXT NOT NULL DEFAULT 'pending', reviewed_by TEXT, reviewed_at TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  db.exec("CREATE TABLE IF NOT EXISTS access_request_sites (request_id INTEGER NOT NULL, site_id INTEGER NOT NULL, PRIMARY KEY (request_id, site_id))");
  // Visitor check-in / check-out log (comings and goings)
  db.exec("CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL, check_in_at TEXT, check_in_by TEXT, check_out_at TEXT, check_out_by TEXT)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_visits ON visits(request_id)");
  // Standalone billing (invoices live here; Stripe only processes card/ACH payments)
  for (const t of ['inv_clients', 'inv_invoices', 'inv_payments', 'inv_products', 'inv_recurring']) db.exec(`DROP TABLE IF EXISTS ${t}`); // remove abandoned Invoice Ninja mirror
  ensure('customers', 'billing_email', 'TEXT');
  db.exec("CREATE TABLE IF NOT EXISTS bill_products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, price REAL NOT NULL DEFAULT 0, taxable INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  db.exec(`CREATE TABLE IF NOT EXISTS bill_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL,
    email TEXT, date TEXT NOT NULL, due_date TEXT, status TEXT NOT NULL DEFAULT 'draft',  -- draft|sent|partial|paid|void
    tax_rate REAL NOT NULL DEFAULT 0, subtotal REAL NOT NULL DEFAULT 0, tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0, balance REAL NOT NULL DEFAULT 0, notes TEXT,
    pay_token TEXT UNIQUE, sent_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_billinv ON bill_invoices(customer_id, status)');
  db.exec("CREATE TABLE IF NOT EXISTS bill_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL, description TEXT, quantity REAL NOT NULL DEFAULT 1, unit_price REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0, taxable INTEGER NOT NULL DEFAULT 1)");
  db.exec('CREATE INDEX IF NOT EXISTS idx_billitem ON bill_items(invoice_id)');
  ensure('bill_items', 'taxable', 'INTEGER NOT NULL DEFAULT 1');
  ensure('bill_products', 'taxable', 'INTEGER NOT NULL DEFAULT 1');
  ensure('bill_invoices', 'terms', 'TEXT'); // billing agreement snapshotted at creation
  db.exec("CREATE TABLE IF NOT EXISTS bill_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL, date TEXT NOT NULL, amount REAL NOT NULL, method TEXT NOT NULL DEFAULT 'other', reference TEXT, stripe_pi TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  db.exec('CREATE INDEX IF NOT EXISTS idx_billpay ON bill_payments(invoice_id)');
  db.exec("CREATE TABLE IF NOT EXISTS bill_recurring (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, frequency TEXT NOT NULL DEFAULT 'monthly', next_date TEXT NOT NULL, tax_rate REAL NOT NULL DEFAULT 0, items_json TEXT NOT NULL DEFAULT '[]', auto_send INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  // Quotes (mirror invoices; can convert to an invoice)
  db.exec(`CREATE TABLE IF NOT EXISTS bill_quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL,
    email TEXT, date TEXT NOT NULL, expiry_date TEXT, status TEXT NOT NULL DEFAULT 'draft',  -- draft|sent|accepted|declined|expired|converted
    tax_rate REAL NOT NULL DEFAULT 0, subtotal REAL NOT NULL DEFAULT 0, tax REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
    notes TEXT, terms TEXT, view_token TEXT UNIQUE, converted_invoice_id INTEGER, sent_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_billquote ON bill_quotes(customer_id, status)');
  db.exec("CREATE TABLE IF NOT EXISTS bill_quote_items (id INTEGER PRIMARY KEY AUTOINCREMENT, quote_id INTEGER NOT NULL, description TEXT, quantity REAL NOT NULL DEFAULT 1, unit_price REAL NOT NULL DEFAULT 0, amount REAL NOT NULL DEFAULT 0, taxable INTEGER NOT NULL DEFAULT 1)");
  db.exec('CREATE INDEX IF NOT EXISTS idx_billqitem ON bill_quote_items(quote_id)');
  // Customer portal auth
  ensure('customers', 'portal_password', 'TEXT');   // scrypt hash
  ensure('customers', 'portal_enabled', 'INTEGER NOT NULL DEFAULT 0');
  db.exec("CREATE TABLE IF NOT EXISTS portal_sessions (token TEXT PRIMARY KEY, customer_id INTEGER NOT NULL, expires_at TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS portal_login_tokens (token TEXT PRIMARY KEY, customer_id INTEGER NOT NULL, expires_at TEXT NOT NULL)");
  // Support / trouble tickets (customers open from the portal; staff reply)
  db.exec(`CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT, customer_id INTEGER NOT NULL, site_id INTEGER,
    subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'normal',
    opened_by TEXT NOT NULL DEFAULT 'customer', assigned_to TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets ON tickets(customer_id, status)');
  db.exec("CREATE TABLE IF NOT EXISTS ticket_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, author_type TEXT NOT NULL, author TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  db.exec('CREATE INDEX IF NOT EXISTS idx_ticketmsg ON ticket_messages(ticket_id)');
  // Omnichannel tickets: every message carries a channel + direction so email/SMS/WhatsApp all thread into one ticket
  ensure('ticket_messages', 'channel', "TEXT NOT NULL DEFAULT 'portal'");   // portal|email|sms|whatsapp|note
  ensure('ticket_messages', 'direction', "TEXT NOT NULL DEFAULT 'out'");    // in|out
  ensure('ticket_messages', 'external_id', 'TEXT');                          // provider msg id / email Message-ID (dedupe)
  ensure('ticket_messages', 'delivery_status', 'TEXT');                      // queued|sent|delivered|failed
  ensure('ticket_messages', 'to_addr', 'TEXT');
  ensure('ticket_messages', 'from_addr', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ticketmsg_ext ON ticket_messages(external_id)');
  ensure('tickets', 'channel', "TEXT NOT NULL DEFAULT 'portal'");            // origin channel
  ensure('tickets', 'last_channel', 'TEXT');                                 // channel of the most recent inbound
  ensure('tickets', 'contact_email', 'TEXT');
  ensure('tickets', 'contact_phone', 'TEXT');
  ensure('tickets', 'reply_token', 'TEXT');                                  // opaque token woven into email Reply-To for threading
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_reply ON tickets(reply_token)');
  // Customer contact points for outbound SMS/WhatsApp + inbound number->customer matching
  ensure('customers', 'sms_number', 'TEXT');
  ensure('customers', 'whatsapp_number', 'TEXT');
  ensure('customers', 'preferred_channel', 'TEXT');                          // email|sms|whatsapp (fallback for staff-initiated)
}

// One-time data backfill: give each existing account a matching customer and attach its sites.
// Idempotent: only runs while there are zero customers.
export function backfillCustomers() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  if (n > 0) return;
  const accts = db.prepare('SELECT id, name FROM accounts').all();
  for (const a of accts) {
    const cid = db.prepare('INSERT INTO customers (account_id, name) VALUES (?,?)').run(a.id, a.name).lastInsertRowid;
    db.prepare('UPDATE sites SET customer_id=? WHERE account_id=? AND customer_id IS NULL').run(cid, a.id);
  }
}

// One-time: seed the M:N join from each customer's legacy single account_id. Idempotent (only when join empty).
export function backfillAccountCustomers() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM account_customers').get().n;
  if (n > 0) return;
  db.prepare('INSERT OR IGNORE INTO account_customers (account_id, customer_id) SELECT account_id, id FROM customers WHERE account_id IS NOT NULL').run();
}

export function seed() {
  db.exec('BEGIN');
  try {
    // Users (team accounts) — change these passwords after first deploy
    const u = (name, email, pw, role) => db.prepare('INSERT INTO users (name,email,password_hash,role,active) VALUES (?,?,?,?,1)').run(name, email, hashPassword(pw), role);
    u('Admin', 'admin@geekitek.test', 'admin123', 'admin');
    u('NOC User', 'noc@geekitek.test', 'noc123', 'noc');
    u('Field Tech', 'field@geekitek.test', 'field123', 'field');
    u('Support Tech', 'support@geekitek.test', 'support123', 'support');

    // Providers
    const cox = db.prepare("INSERT INTO upstream_providers (name, provider_type) VALUES ('Cox','Wholesale')").run().lastInsertRowid;
    const lumen = db.prepare("INSERT INTO upstream_providers (name, provider_type) VALUES ('Lumen','Transit')").run().lastInsertRowid;
    db.prepare("INSERT INTO upstream_providers (name, provider_type) VALUES ('Cogent','Transit')").run();

    // POPs
    const dal01 = db.prepare("INSERT INTO pops (name, code, address, lat, lng, status) VALUES ('Dallas 01','POP-DAL01','1101 Bryan St, Dallas TX',32.7820,-96.7975,'Active')").run().lastInsertRowid;
    const den02 = db.prepare("INSERT INTO pops (name, code, address, lat, lng, status) VALUES ('Denton 02','POP-DEN02',NULL,33.2148,-97.1331,'Active')").run().lastInsertRowid;

    // Controllers
    db.prepare("INSERT INTO controllers (name, type, endpoint, status, sync_enabled) VALUES ('UniFi — Main','UniFi','https://unifi.example.com','Reachable',1)").run();
    db.prepare("INSERT INTO controllers (name, type, endpoint, status, sync_enabled) VALUES ('UISP — Wireless','UISP','https://uisp.example.com','Reachable',1)").run();

    // Device models
    const m = (mf, mo, t, w=0, c=0) => db.prepare("INSERT INTO device_models (manufacturer, model, device_type, has_wifi, has_cellular) VALUES (?,?,?,?,?)").run(mf, mo, t, w, c).lastInsertRowid;
    const ccr2004 = m('MikroTik','CCR2004','Router');
    const rb5009 = m('MikroTik','RB5009','Router');
    const hapax3 = m('MikroTik','hAP ax3','Access point',1,0);
    const hapax2 = m('MikroTik','hAP ax2','Access point',1,0);
    const crs328 = m('MikroTik','CRS328-24P','Switch');
    const usw24 = m('Ubiquiti UniFi','UniFi Switch 24 PoE','Switch');
    const u6pro = m('Ubiquiti UniFi','U6-Pro','Access point');
    const chateau = m('MikroTik','Chateau 5G ax','Router',1,1);
    const sb8200 = m('Arris','SB8200','Modem');

    // Account: Acme Logistics
    const acme = db.prepare("INSERT INTO accounts (name, account_number, status, billing_address, notes) VALUES ('Acme Logistics','ACME-0297','Active','500 Commerce St, Dallas TX','Logistics customer, multi-site.')").run().lastInsertRowid;
    db.prepare("INSERT INTO account_contacts (account_id,name,role,email,phone,is_primary,is_billing) VALUES (?,?,?,?,?,1,0)").run(acme,'Rick Alvarez','Facilities','rick@acmelogistics.com','(214) 555-0142');
    db.prepare("INSERT INTO account_contacts (account_id,name,role,email,phone,is_primary,is_billing) VALUES (?,?,?,?,?,0,1)").run(acme,'Acme IT','Billing · 24/7','billing@acmelogistics.com','(800) 555-0199');
    db.prepare("INSERT INTO previous_isps (account_id,provider,until_label,reason) VALUES (?,?,?,?)").run(acme,'Spectrum Business','until 2024','Frequent daytime outages and slow support response on a business SLA.');
    db.prepare("INSERT INTO previous_isps (account_id,provider,until_label,reason) VALUES (?,?,?,?)").run(acme,'AT&T Fiber','until 2022','Large price increase at renewal; no static IP option on their plan.');

    // Second account
    const mercy = db.prepare("INSERT INTO accounts (name, account_number, status) VALUES ('Mercy Health','MERCY-0145','Active')").run().lastInsertRowid;
    db.prepare("INSERT INTO account_contacts (account_id,name,role,email,phone,is_primary,is_billing) VALUES (?,?,?,?,?,1,1)").run(mercy,'Dana Okafor','IT Manager','dana@mercyhealth.org','(972) 555-0110');

    // Sites for Acme
    const riverside = db.prepare("INSERT INTO sites (account_id,name,service_address,lat,lng,status,current_mgmt_ip,current_public_ip,notes) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(acme,'Riverside Office','4120 Riverside Dr, Dallas TX',32.8090,-96.8120,'Active','10.20.1.1','198.51.100.24',null).lastInsertRowid;
    const northgate = db.prepare("INSERT INTO sites (account_id,name,service_address,status,current_mgmt_ip,current_public_ip) VALUES (?,?,?,?,?,?)")
      .run(acme,'Northgate Warehouse','2200 Northgate Blvd, Fort Worth TX','Active','10.20.2.1','198.51.100.88').lastInsertRowid;
    const pinevalley = db.prepare("INSERT INTO sites (account_id,name,service_address,status,current_mgmt_ip,current_public_ip) VALUES (?,?,?,?,?,?)")
      .run(acme,'Pine Valley Depot','905 Pine Valley Rd, Denton TX','Active','10.30.4.1','198.51.100.140').lastInsertRowid;
    // Mercy site (down)
    const lakeside = db.prepare("INSERT INTO sites (account_id,name,service_address,status,current_mgmt_ip,current_public_ip) VALUES (?,?,?,?,?,?)")
      .run(mercy,'Lakeside Clinic','77 Parkwood Dr, Plano TX','Active','10.50.3.1','198.51.100.201').lastInsertRowid;

    // Site access (pinned) for Riverside
    db.prepare("INSERT INTO site_access (site_id, details_json) VALUES (?,?)").run(riverside, JSON.stringify({
      gate_code:'4471#', front_door:'Suite 200, keypad 8123', lockbox:'north entrance 5590',
      access_hours:'Mon-Fri 7a-7p',
      contacts:[{name:'Rick Alvarez · Facilities', phone:'(214) 555-0142'},{name:'Acme IT · 24/7', phone:'(800) 555-0199'}]
    }));
    // Notes
    db.prepare("INSERT INTO site_notes (site_id,author,author_role,body) VALUES (?,?,?,?)").run(riverside,'Jon F.','NOC','Replaced WAN2 SFP module — link stable since. Spare module left in the rack.');
    db.prepare("INSERT INTO site_notes (site_id,author,author_role,body) VALUES (?,?,?,?)").run(riverside,'Maria S.','Support','Customer requested a static IP on the guest VLAN — pending approval.');
    db.prepare("INSERT INTO site_notes (site_id,author,author_role,body) VALUES (?,?,?,?)").run(riverside,'Dani T.','Field tech','Installed warehouse AP on the north wall, ~18 ft up. Conduit runs to the IDF closet.');

    // Connections
    // Riverside: primary POP Dallas01 (WAN1, static), failover brokered Lumen (WAN2, dynamic)
    db.prepare(`INSERT INTO connections (site_id,role,priority,served_type,served_pop_id,wan_port,ip_type,static_ip,bandwidth,status)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(riverside,'Primary',1,'pop',dal01,'ether1','Static','198.51.100.24','1G','Up');
    db.prepare(`INSERT INTO connections (site_id,role,priority,served_type,served_provider_id,circuit_id,wan_port,ip_type,current_ip,bandwidth,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(riverside,'Failover',2,'brokered',lumen,'LMN-44821','sfp-sfpplus1','Dynamic','203.0.113.58','500M','Standby');
    // Pine Valley: single primary POP Denton02
    db.prepare(`INSERT INTO connections (site_id,role,priority,served_type,served_pop_id,wan_port,ip_type,static_ip,bandwidth,status)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(pinevalley,'Primary',1,'pop',den02,'ether1','Static','198.51.100.140','500M','Up');
    // Northgate: primary POP Dallas01
    db.prepare(`INSERT INTO connections (site_id,role,priority,served_type,served_pop_id,wan_port,ip_type,static_ip,bandwidth,status)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(northgate,'Primary',1,'pop',dal01,'ether1','Static','198.51.100.88','1G','Up');
    // Lakeside: brokered Cox (down)
    const lakeCox = db.prepare(`INSERT INTO connections (site_id,role,priority,served_type,served_provider_id,circuit_id,wan_port,ip_type,current_ip,bandwidth,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(lakeside,'Primary',1,'brokered',cox,'COX-90112','ether1','Dynamic','198.51.100.201','300M','Down').lastInsertRowid;

    // Devices
    const DCOLS = ['name','model_id','serial','mac','status','online','assigned_type','assigned_site_id','assigned_pop_id','management_mode','mgmt_overlay','mgmt_address','controller_id','ownership','owner_org','account_number','owner_account','owner_sub_account','account_status','hfc_mac','purchased_from','associated_connection_id','cell_carrier','cell_phone','cell_imei','cell_sim','cell_sku','factory_password','admin_password','tech_username','tech_password','factory_wifi_ssid','factory_wifi_password','acct_pin','acct_portal_username','acct_portal_password','acct_passphrase'];
    const DDEFAULTS = { status:'Deployed', online:1, management_mode:'platform', ownership:'us', account_status:'active' };
    const devStmt = db.prepare(`INSERT INTO devices (${DCOLS.join(',')}) VALUES (${DCOLS.map(()=>'?').join(',')})`);
    const dev = (o) => {
      const row = Object.assign({}, DDEFAULTS, o);
      const vals = DCOLS.map(c => (row[c] === undefined ? null : row[c]));
      return devStmt.run(...vals).lastInsertRowid;
    };

    // Riverside devices
    dev({name:'Edge Router',model_id:ccr2004,serial:'8A2F1147',mac:'E4:8D:8C:1C:90:E4',online:1,assigned_type:'site',assigned_site_id:riverside,
      mgmt_overlay:'ZeroTier',mgmt_address:'10.20.1.1',
      admin_password:'Kp7$mvR2qZ',factory_password:'rGq7-K2pX9',tech_username:'fieldtech',tech_password:'onsite-2026'});
    dev({name:'Main Switch',model_id:usw24,serial:'7C19D004',mac:'FC:EC:DA:22:18:7C',online:1,assigned_type:'site',assigned_site_id:riverside,
      mgmt_overlay:'ZeroTier',mgmt_address:'10.20.1.2',admin_password:'Sw!22x8Q',tech_username:'fieldtech',tech_password:'onsite-2026'});
    dev({name:'Warehouse AP',model_id:hapax3,serial:'9F61C228',mac:'2C:C8:1B:9F:61:C2',online:0,assigned_type:'site',assigned_site_id:riverside,
      mgmt_overlay:'WireGuard',mgmt_address:'10.20.1.35',admin_password:'Ap!9912k',factory_password:'tan-9920-zip',
      factory_wifi_ssid:'MikroTik-9F61C2',factory_wifi_password:'84watt-paint',tech_username:'fieldtech',tech_password:'onsite-2026'});

    // Pine Valley devices
    dev({name:'Edge Router',model_id:rb5009,serial:'48A98A330C71',mac:'48:A9:8A:33:0C:71',online:1,assigned_type:'site',assigned_site_id:pinevalley,
      mgmt_overlay:'WireGuard',mgmt_address:'10.30.4.1',admin_password:'Pv!4471q',tech_username:'fieldtech',tech_password:'onsite-2026'});
    dev({name:'Yard AP',model_id:hapax2,serial:'48A98A330C72',mac:'48:A9:8A:33:0C:72',online:1,assigned_type:'site',assigned_site_id:pinevalley,
      mgmt_overlay:'WireGuard',mgmt_address:'10.30.4.10',admin_password:'Yp!8820z',factory_wifi_ssid:'MikroTik-330C72',factory_wifi_password:'green-mile-77',
      tech_username:'fieldtech',tech_password:'onsite-2026'});

    // Cox coax modem at Lakeside (provider-managed)
    dev({name:'Cox modem',model_id:sb8200,serial:'AB12CD34EF',status:'Deployed',online:1,assigned_type:'site',assigned_site_id:lakeside,
      management_mode:'provider',hfc_mac:'00:1A:DE:55:0A:91',purchased_from:'Cox',associated_connection_id:lakeCox,
      ownership:'carrier',owner_org:'Cox',account_number:'COX-558820',owner_account:'Acct 8820',owner_sub_account:'Sub 002',account_status:'active',
      acct_pin:'2280',acct_portal_username:'geekitek',acct_portal_password:'Cox!4471x'});

    // 5G modem router (platform-managed, distributor-owned) at Lakeside as failover spare (in stock)
    dev({name:'5G failover',model_id:chateau,serial:'CHT55AX01',mac:'74:4D:28:11:0C:5A',status:'In stock',online:0,assigned_type:null,
      mgmt_overlay:'WireGuard',mgmt_address:null,
      ownership:'distributor',owner_org:'Granite',account_number:'920184477-00001',owner_account:'Acct 4471',owner_sub_account:'Sub 001',account_status:'active',
      cell_carrier:'Verizon',cell_phone:'(214) 555-0190',cell_imei:'356938035643809',cell_sim:'89014103211118510720',cell_sku:'VZ-BIZ-UNL',
      admin_password:'5g!Granite22',tech_username:'fieldtech',tech_password:'onsite-2026',
      acct_pin:'4471',acct_portal_username:'geekitek-noc',acct_portal_password:'Vz!9k2-Lmq',acct_passphrase:'bluefalcon'});

    db.prepare("INSERT INTO audit_log (actor,role,action,target,details) VALUES ('system','admin','seed','database','Seeded sample data')").run();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// CLI: node db.js --seed | --reset
const arg = process.argv[2];
if (arg === '--reset') {
  for (const t of ['audit_log','devices','connections','site_notes','site_access','sites','previous_isps','account_contacts','accounts','controllers','device_models','upstream_providers','pops']) {
    try { db.exec(`DROP TABLE IF EXISTS ${t}`); } catch {}
  }
  initSchema(); seed();
  console.log('Database reset and reseeded.');
} else if (arg === '--seed') {
  initSchema();
  if (isEmpty()) { seed(); console.log('Seeded.'); } else { console.log('Already has data; skipping seed.'); }
}
