// Database bootstrap + seed for the Network Inventory & Management Platform
// Uses Node's built-in SQLite (node:sqlite) — no native build step required.
import { addressKey } from './lib/address.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hashPassword } from './hash.js';
import { bboxOf as bbox } from './lib/geo.js';

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
  // Which operating system a device runs, which decides how the platform talks to it. The default
  // is deliberately routeros: every device that existed before this column was a MikroTik, and a
  // NULL here must not stop any of them being polled.
  ensure('devices', 'platform', "TEXT DEFAULT 'routeros'");
  db.exec("UPDATE devices SET platform='routeros' WHERE platform IS NULL OR platform=''");
  // How to reach it: auto | http | ssh. Only meaningful for OpenWrt, which has two ways in. Stored
  // rather than rediscovered because a device that only answers over SSH would otherwise sit
  // through an HTTP timeout on every poll — once a minute, for as long as it is deployed.
  ensure('devices', 'mgmt_transport', "TEXT DEFAULT 'auto'");
  // WireGuard peers that are NOT inventory hardware: a technician's laptop, a phone, an office
  // machine that needs to reach the management overlay. Kept in its own table rather than as fake
  // device rows, because a laptop has no site, no model and no customer, and every report that
  // counts devices would start counting people.
  //
  // Addresses here come out of the SAME pool as device addresses. That is the whole reason this
  // table has to be visible to the allocator: two peers handed the same overlay IP do not fail
  // loudly, they intermittently steal each other's traffic.
  db.exec(`CREATE TABLE IF NOT EXISTS wg_peers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner TEXT,
    kind TEXT NOT NULL DEFAULT 'laptop',
    address TEXT,
    public_key TEXT,
    private_key TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_wgpeer_addr ON wg_peers(address) WHERE address IS NOT NULL');
  // Cellular signal history for 5G/LTE CPE.
  //
  // The device keeps its own ring buffer at ten-second resolution — finer than this platform polls —
  // so samples are ingested wholesale rather than reduced to one reading per poll. The PRIMARY KEY
  // on (device_id, ts) is what makes that safe: successive polls overlap heavily, and the conflict
  // clause turns a re-read of the same half hour into a no-op instead of thirty duplicate rows.
  db.exec(`CREATE TABLE IF NOT EXISTS cell_signal (
    device_id INTEGER NOT NULL,
    ts TEXT NOT NULL,
    rsrp REAL, rsrq REAL, sinr REAL, rssi REAL,
    bars INTEGER, network_type TEXT, slot INTEGER,
    PRIMARY KEY (device_id, ts)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_cellsig ON cell_signal(device_id, ts)');
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
  ensure('note_attachments', 'caption', 'TEXT');   // short description shown under the thumbnail
  db.exec('CREATE INDEX IF NOT EXISTS idx_note_att_parent ON note_attachments(parent_type, parent_id)');
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
  ensure('ticket_messages', 'channel', "TEXT NOT NULL DEFAULT 'portal'");   // portal|email|sms|whatsapp|imessage|facetime|rcs|note
  ensure('ticket_messages', 'direction', "TEXT NOT NULL DEFAULT 'out'");    // in|out
  ensure('ticket_messages', 'external_id', 'TEXT');                          // provider msg id / email Message-ID (dedupe)
  ensure('ticket_messages', 'delivery_status', 'TEXT');                      // queued|sent|delivered|failed
  // Which transport actually carried an SMS-channel message: rcs | sms | null (not yet known).
  // RCS is not a separate channel — it is an upgrade Twilio applies per recipient, and the customer
  // sees one thread either way — so it is RECORDED here rather than chosen by staff.
  ensure('ticket_messages', 'delivery_transport', 'TEXT');
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
  ensure('customers', 'preferred_channel', 'TEXT');                          // email|sms|whatsapp|imessage (default on the customer Messages page)
  ensure('customers', 'comm_reply_token', 'TEXT');                           // Reply-To token so email replies land on the customer timeline
  db.exec('CREATE INDEX IF NOT EXISTS idx_cust_comm_reply ON customers(comm_reply_token)');
  db.exec(`CREATE TABLE IF NOT EXISTS customer_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL,
    channel TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'out', author TEXT, body TEXT NOT NULL, subject TEXT,
    external_id TEXT, to_addr TEXT, from_addr TEXT, delivery_status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_custmsg ON customer_messages(customer_id, id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_custmsg_ext ON customer_messages(external_id)');
  // Patch panel documentation — opt-in per site/POP, one+ panels each with labelled ports
  ensure('sites', 'patch_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensure('pops', 'patch_enabled', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS patch_panels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, parent_type TEXT NOT NULL, parent_id INTEGER NOT NULL,
    name TEXT NOT NULL, location TEXT, ports INTEGER NOT NULL DEFAULT 24, notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_patch_panels ON patch_panels(parent_type, parent_id)');
  // one row per USED port (upsert by panel_id+port_no); blank ports have no row
  db.exec(`CREATE TABLE IF NOT EXISTS patch_ports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, panel_id INTEGER NOT NULL, port_no INTEGER NOT NULL,
    label TEXT, device_id INTEGER, device_text TEXT, circuit_id INTEGER, circuit_text TEXT,
    far_end TEXT, status TEXT NOT NULL DEFAULT 'free', note TEXT,
    UNIQUE(panel_id, port_no))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_patch_ports ON patch_ports(panel_id)');
  // Standalone circuit inventory: a circuit connects two endpoints, each a site | pop | carrier (>=1 internal).
  // a_ref_id / z_ref_id point into sites, pops, or upstream_providers depending on the paired *_type.
  db.exec(`CREATE TABLE IF NOT EXISTS circuits (
    id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT,
    a_type TEXT NOT NULL, a_ref_id INTEGER,
    z_type TEXT NOT NULL, z_ref_id INTEGER,
    provider_id INTEGER, circuit_id TEXT, ctype TEXT, bandwidth TEXT,
    status TEXT NOT NULL DEFAULT 'Up', monthly_cost REAL, install_date TEXT, notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_circuits_a ON circuits(a_type, a_ref_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_circuits_z ON circuits(z_type, z_ref_id)');
  ensure('circuits', 'ext_ref', 'TEXT');   // e.g. IQGeo CID, so re-import updates in place
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_circuits_ext ON circuits(ext_ref) WHERE ext_ref IS NOT NULL');
  // Multiple sub-accounts per account (each with its own PIN, status, monthly bill, notes)
  db.exec(`CREATE TABLE IF NOT EXISTS account_subaccounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL,
    name TEXT NOT NULL, pin TEXT, status TEXT NOT NULL DEFAULT 'active',
    monthly_cost REAL, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_subaccounts ON account_subaccounts(account_id)');
  ensure('sites', 'subaccount_id', 'INTEGER');
  ensure('devices', 'owner_subaccount_id', 'INTEGER');
  ensure('accounts', 'monthly_cost', 'REAL'); // account base monthly cost (P&L); total cost = this + sub-accounts
  // ---- Fiber plant (GIS): routes → cables → strands, with structures + splices ----
  // Geometry is stored as GeoJSON text (SQLite has no spatial type); routes are LineStrings,
  // structures are Points. Modelled on how OSP tools (VETRO/3-GIS/OSPInsight) separate the
  // physical PATH from the CABLE riding it from the individual STRAND.
  db.exec(`CREATE TABLE IF NOT EXISTS fiber_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'as_built',      -- planned|permitted|under_construction|as_built|retired
    placement TEXT,                                -- aerial|buried|conduit|underground|other
    owner TEXT, length_m REAL, geom_json TEXT NOT NULL, notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_fiber_routes ON fiber_routes(status)');
  db.exec(`CREATE TABLE IF NOT EXISTS fiber_structures (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'handhole',         -- handhole|vault|pole|cabinet|pedestal|building|splice_case
    lat REAL, lng REAL, site_id INTEGER, pop_id INTEGER,
    status TEXT NOT NULL DEFAULT 'as_built', notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_fiber_structures ON fiber_structures(kind)');
  db.exec(`CREATE TABLE IF NOT EXISTS fiber_cables (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, route_id INTEGER,
    strand_count INTEGER NOT NULL DEFAULT 12, cable_type TEXT,
    a_structure_id INTEGER, z_structure_id INTEGER,
    status TEXT NOT NULL DEFAULT 'as_built', notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_fiber_cables ON fiber_cables(route_id)');
  // One row per physical fiber, generated when the cable is created. position is 1-based across
  // the whole cable; tube/colour are derived per TIA-598-C (12-colour sequence, repeating).
  db.exec(`CREATE TABLE IF NOT EXISTS fiber_strands (
    id INTEGER PRIMARY KEY AUTOINCREMENT, cable_id INTEGER NOT NULL,
    position INTEGER NOT NULL, tube INTEGER NOT NULL, tube_color TEXT, color TEXT,
    status TEXT NOT NULL DEFAULT 'free',           -- free|reserved|assigned|dark|damaged|abandoned
    assigned_type TEXT, assigned_id INTEGER,       -- circuit|customer|site|pop (soft ref)
    label TEXT, notes TEXT,
    UNIQUE(cable_id, position))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_fiber_strands ON fiber_strands(cable_id, status)');
  db.exec(`CREATE TABLE IF NOT EXISTS fiber_splices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, structure_id INTEGER,
    a_strand_id INTEGER NOT NULL, z_strand_id INTEGER,
    splice_type TEXT NOT NULL DEFAULT 'fusion',    -- fusion|mechanical|splitter|termination
    tray TEXT, loss_db REAL, notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_fiber_splices_a ON fiber_splices(a_strand_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_fiber_splices_z ON fiber_splices(z_strand_id)');
  // External system reference (e.g. IQGeo/myWorld feature id) so re-importing updates in place
  ensure('fiber_routes', 'ext_ref', 'TEXT');
  ensure('fiber_structures', 'ext_ref', 'TEXT');
  ensure('fiber_cables', 'ext_ref', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_fiber_routes_ext ON fiber_routes(ext_ref) WHERE ext_ref IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_fiber_struct_ext ON fiber_structures(ext_ref) WHERE ext_ref IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_fiber_cables_ext ON fiber_cables(ext_ref) WHERE ext_ref IS NOT NULL');
  // Cached bounding box per route. "What plant is near this address?" would otherwise have to
  // JSON.parse every geometry in the table on every query — ~11 MB of it after the Arizona import.
  // These let SQL discard almost everything first, so only a handful of geometries get parsed.
  ensure('fiber_routes', 'min_lat', 'REAL');
  ensure('fiber_routes', 'min_lng', 'REAL');
  ensure('fiber_routes', 'max_lat', 'REAL');
  ensure('fiber_routes', 'max_lng', 'REAL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_fiber_routes_bbox ON fiber_routes(min_lat, max_lat)');
  // Slack allowance for this route, as a percentage. NULL means "use the system default" (13%).
  // An OTDR measures fibre, which is longer than the ground route because of slack loops and
  // coils; a coil-heavy aerial run and a straight bore are not the same, so it's per route.
  ensure('fiber_routes', 'slack_pct', 'REAL');
  // Measured fibre length from the source system, where it supplied one. Together with the ground
  // length computed from the geometry this gives a REAL slack ratio per route, which beats a flat
  // assumption. NULL means the source had nothing to say and the default applies.
  ensure('fiber_routes', 'fibre_m', 'REAL');
  // Ledger of every file put through the fault locator.
  //
  // Signed-in uploads keep the file (stored_name set) so an investigation can be revisited.
  // Public anonymous uploads record metadata ONLY — filename, size, hash, source address — and
  // the bytes are discarded. Retaining arbitrary files from anyone with the URL would mean
  // hosting third-party content of unknown provenance on the data volume, which is not a
  // trade worth making for a convenience feature.
  db.exec(`CREATE TABLE IF NOT EXISTS locator_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT, format TEXT, size INTEGER, sha256 TEXT,
    segments INTEGER, vertices INTEGER, total_m REAL, faults INTEGER,
    source TEXT NOT NULL DEFAULT 'public',   -- 'public' | 'staff'
    actor TEXT,                              -- email, for staff uploads
    ip TEXT,                                 -- for public uploads
    stored_name TEXT,                        -- NULL when the file was not retained
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_locup ON locator_uploads(created_at)');

  // Units within a site — an apartment block, business park or strip mall is ONE site with many
  // subscribers, not many sites. Without this, a 100-unit building put 100 near-identical rows in
  // the sites list and the address had to be retyped for each one.
  db.exec(`CREATE TABLE IF NOT EXISTS site_units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    label TEXT NOT NULL,                    -- "Unit 101", "Suite B", "Bldg 3 Apt 12"
    customer_id INTEGER,                    -- who is served there; NULL means vacant
    status TEXT NOT NULL DEFAULT 'Active',
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_units_site ON site_units(site_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_units_cust ON site_units(customer_id)');
  // One "Unit 101" per site. Case-insensitive so "unit 101" doesn't slip past.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_units_uniq ON site_units(site_id, LOWER(label))');
  ensure('sites', 'is_mdu', 'INTEGER DEFAULT 0');
  // Normalised service address, so "10738 N 75Th Ave" and "10738 n 75th ave." resolve to the same
  // site instead of quietly creating a second one. Maintained by the API on write.
  ensure('sites', 'addr_key', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sites_addrkey ON sites(addr_key)');

  // Recompute every site's address key whenever the keying rules change.
  //
  // The key is a cached derivation, so a change to how it is built silently orphans every row
  // computed under the old rules — two records for one building, which is the failure this whole
  // mechanism exists to stop. Cheap to redo (one pass, a few thousand rows), and always correct,
  // so it runs on every start rather than being versioned and forgotten.
  {
    const rows = db.prepare("SELECT id, service_address, addr_key FROM sites WHERE service_address IS NOT NULL AND TRIM(service_address) <> ''").all();
    const upd = db.prepare('UPDATE sites SET addr_key=? WHERE id=?');
    let changed = 0;
    for (const r of rows) {
      const key = addressKey(r.service_address) || null;
      if (key !== r.addr_key) { upd.run(key, r.id); changed++; }
    }
    if (changed) console.log(`Recomputed address keys for ${changed} site(s).`);
  }
  // Devices can belong to a unit rather than just the building.
  ensure('devices', 'unit_id', 'INTEGER');

  // Accounts sit under a carrier — Cox, Verizon, AT&T, T-Mobile. The carrier is the company;
  // the account is the specific billing relationship with them, so one carrier has many accounts.
  //
  // Deliberately reuses upstream_providers rather than adding a `carriers` table: that table is
  // already "carriers / transit / wholesale", circuits already resolve their `carrier` endpoint
  // against it, and Cox is already in it. A second table would mean the same company existing
  // twice with no link between the two.
  ensure('accounts', 'carrier_id', 'INTEGER');
  // Hardware sits on a carrier's account too. owner_org was free text, so the same company was
  // spelled differently on different devices and none of it joined to the carrier list.
  ensure('devices', 'carrier_id', 'INTEGER');
  // Which sub-account of that account the customer is served on. Nullable: an account with no
  // sub-accounts, or one not yet chosen, is still a valid link.
  ensure('account_customers', 'subaccount_id', 'INTEGER');

  // What the carrier-account spreadsheets actually carry, beyond a number and a cost.
  //
  // portal_username joins the existing pin / portal_password / security_questions group, which is
  // stripped for anyone below NOC. It belongs with them: a login name is half a credential, and
  // it identifies which of several logins opens a given account.
  ensure('accounts', 'portal_username', 'TEXT');
  // Day of the month the carrier bills, 1-31. Stored as a number, not the "17th" the sheets use,
  // so it can be sorted and compared.
  ensure('accounts', 'due_day', 'INTEGER');
  ensure('accounts', 'autopay', 'INTEGER');       // 1 / 0 / NULL for unknown
  ensure('accounts', 'payment_method', 'TEXT');   // "on angela BOA card" — which card pays this
  ensure('accounts', 'plan', 'TEXT');             // the carrier's plan name, normalised on import

  // Spreadsheet imports, and everything each one created.
  //
  // Every record an import makes is tagged with its batch so the run can be reversed. Bulk-loading
  // years of hand-kept spreadsheets is exactly where a mistake lands hundreds of wrong rows at
  // once, and "restore last night's backup" also throws away the day's real work.
  db.exec(`CREATE TABLE IF NOT EXISTS import_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT, format TEXT, sheet TEXT, row_count INTEGER,
    mapping_json TEXT,
    created_count INTEGER DEFAULT 0, attached_count INTEGER DEFAULT 0,
    updated_count INTEGER DEFAULT 0, skipped_count INTEGER DEFAULT 0,
    actor TEXT, status TEXT NOT NULL DEFAULT 'committed',   -- committed | undone
    created_at TEXT NOT NULL DEFAULT (datetime('now')), undone_at TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS import_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    entity TEXT NOT NULL,        -- customer | site | unit | device | account | subaccount | carrier
    entity_id INTEGER NOT NULL,
    action TEXT NOT NULL,        -- created | updated
    before_json TEXT,            -- prior values, so an update can be put back
    FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_imprec ON import_records(batch_id)');

  // Per-device API tokens, for the phone and tablet apps.
  //
  // Deliberately NOT the sessions table. A session cookie is short-lived, browser-scoped and
  // interchangeable; a device token lives on a phone for months, travels in a header, and has to
  // be killable on its own when that phone is lost — which means it needs an identity, a name a
  // person recognises, and a revocation of its own.
  //
  // Only a hash is stored. The token is high-entropy random, so a single SHA-256 is the right
  // choice: it cannot be reversed, and unlike scrypt it is cheap enough to run on every request.
  // Password hashing is slow on purpose because passwords are guessable; a 256-bit random token
  // is not, and paying scrypt per API call would just make the app slow.
  db.exec(`CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,              -- "Jon's iPhone" — what the person sees when revoking
    token_hash TEXT NOT NULL UNIQUE, -- sha256 of the token; the token itself is shown once
    prefix TEXT NOT NULL,            -- first few characters, so a token can be identified in a list
    platform TEXT,                   -- ios | ipados | web | other
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT, last_ip TEXT, -- so a forgotten or suspicious device stands out
    expires_at TEXT,                 -- null = no expiry
    revoked_at TEXT)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_devices_carrier ON devices(carrier_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_accounts_carrier ON accounts(carrier_id)');
  // The carriers most US accounts sit under. Added only when absent, so renames and deletions
  // stick and nothing is duplicated on restart.
  {
    const ins = db.prepare('INSERT INTO upstream_providers (name, provider_type) VALUES (?,?)');
    const seen = db.prepare('SELECT id FROM upstream_providers WHERE LOWER(name)=LOWER(?)');
    for (const n of ['Cox', 'Verizon', 'AT&T', 'T-Mobile', 'Lumen', 'Comcast', 'CenturyLink', 'Spectrum'])
      if (!seen.get(n)) ins.run(n, 'Carrier');
  }
  // Link devices whose typed owner_org matches a known carrier by name. Deliberately match-only:
  // auto-creating a carrier from every typed string would turn typos into permanent entries.
  {
    const rows = db.prepare("SELECT id, owner_org FROM devices WHERE carrier_id IS NULL AND owner_org IS NOT NULL AND TRIM(owner_org) <> ''").all();
    if (rows.length) {
      const find = db.prepare('SELECT id FROM upstream_providers WHERE LOWER(name)=LOWER(TRIM(?))');
      const upd = db.prepare('UPDATE devices SET carrier_id=? WHERE id=?');
      let n = 0;
      for (const r of rows) { const c = find.get(r.owner_org); if (c) { upd.run(c.id, r.id); n++; } }
      if (n) console.log(`Linked ${n} device(s) to a carrier by name`);
    }
  }
  // Earlier builds stored IQGeo's fibre distance in length_m, conflating it with ground length.
  // Move it to its proper column and recompute length_m from the geometry. Implausible ratios are
  // rejected later at read time, so a value that was really a ground length does no harm here.
  {
    const mixed = db.prepare("SELECT id, length_m, geom_json FROM fiber_routes WHERE ext_ref LIKE 'span-route/%' AND length_m IS NOT NULL AND fibre_m IS NULL").all();
    if (mixed.length) {
      const upd = db.prepare('UPDATE fiber_routes SET fibre_m=?, length_m=? WHERE id=?');
      let moved = 0;
      for (const r of mixed) {
        let coords = null;
        try { const g = JSON.parse(r.geom_json); coords = g && g.type === 'LineString' ? g.coordinates : null; } catch {}
        if (!coords || coords.length < 2) continue;
        let ground = 0;
        for (let i = 1; i < coords.length; i++) {
          const [o1, a1] = coords[i - 1], [o2, a2] = coords[i];
          const rad = d => d * Math.PI / 180;
          const dLat = rad(a2 - a1), dLon = rad(o2 - o1);
          const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a1)) * Math.cos(rad(a2)) * Math.sin(dLon / 2) ** 2;
          ground += 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
        }
        upd.run(r.length_m, Math.round(ground), r.id);
        moved++;
      }
      if (moved) console.log(`Separated measured fibre length from ground length on ${moved} route(s)`);
    }
  }
  // Backfill any route written before this column existed (or by an older build).
  {
    const stale = db.prepare('SELECT id, geom_json FROM fiber_routes WHERE min_lat IS NULL AND geom_json IS NOT NULL').all();
    if (stale.length) {
      const upd = db.prepare('UPDATE fiber_routes SET min_lat=?, min_lng=?, max_lat=?, max_lng=? WHERE id=?');
      let done = 0;
      for (const r of stale) {
        let coords = null;
        try { const g = JSON.parse(r.geom_json); coords = g && g.type === 'LineString' ? g.coordinates : null; } catch {}
        const b = bbox(coords);
        if (b) { upd.run(b.minLat, b.minLng, b.maxLat, b.maxLng, r.id); done++; }
      }
      if (done) console.log(`Backfilled bounding boxes for ${done} fiber route(s)`);
    }
  }
  // Consolidation: POP upstream feeds (pop_circuits) fold into the single `circuits` inventory.
  // A-end = the upstream source (pop|account), Z-end = the POP being fed. Runs once.
  ensure('connections', 'circuit_ref_id', 'INTEGER'); // optional link from a site WAN uplink to a circuit record
  const popcMigrated = db.prepare("SELECT value FROM settings WHERE key='popcircuits_merged'").get();
  if (!popcMigrated) {
    let moved = 0;
    const hasPopc = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pop_circuits'").get();
    if (hasPopc) {
      for (const c of db.prepare('SELECT * FROM pop_circuits').all()) {
        const zId = c.pop_id;
        const aType = c.source_type === 'account' ? 'account' : 'pop';
        const aId = c.source_type === 'account' ? c.source_account_id : c.source_pop_id;
        if (!aId || !zId) continue;                                   // broken ref — leave the old row in place
        if (aType === 'pop' && Number(aId) === Number(zId)) continue; // self-loop — not a valid circuit
        const dup = db.prepare('SELECT id FROM circuits WHERE a_type=? AND a_ref_id=? AND z_type=? AND z_ref_id=? AND IFNULL(circuit_id,\'\')=IFNULL(?,\'\')').get(aType, aId, 'pop', zId, c.circuit_id || '');
        if (dup) continue;
        db.prepare(`INSERT INTO circuits (label,a_type,a_ref_id,z_type,z_ref_id,circuit_id,bandwidth,status,notes,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(null, aType, aId, 'pop', zId, c.circuit_id || null, c.bandwidth || null,
          c.status || 'Up', c.notes || null, c.created_at || new Date().toISOString());
        moved++;
      }
      if (moved) console.log(`Merged ${moved} POP upstream circuit(s) into the circuits inventory.`);
    }
    db.prepare("INSERT INTO settings (key,value) VALUES ('popcircuits_merged','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  }
  // one-time: fold each account's legacy single sub_account into the new list
  const migrated = db.prepare("SELECT value FROM settings WHERE key='subaccount_migrated'").get();
  if (!migrated) {
    for (const a of db.prepare("SELECT id, sub_account FROM accounts WHERE sub_account IS NOT NULL AND sub_account<>''").all()) {
      const has = db.prepare('SELECT COUNT(*) AS n FROM account_subaccounts WHERE account_id=?').get(a.id).n;
      if (!has) db.prepare('INSERT INTO account_subaccounts (account_id, name) VALUES (?,?)').run(a.id, a.sub_account);
    }
    db.prepare("INSERT INTO settings (key,value) VALUES ('subaccount_migrated','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  }

  // ---- Documents and signatures -----------------------------------------------------------------
  //
  // A signed agreement is evidence, and that changes what the schema has to do. Ordinary records
  // answer "what is true now"; these have to answer "what did this person see, when, and how do we
  // know nobody has touched it since" — possibly years later, possibly to someone hostile.
  //
  // Three decisions follow from that, and all three are much harder to add afterwards:
  //
  //  1. THE DOCUMENT IS FROZEN WHEN IT IS SENT. `content_sha256` is the hash of the exact PDF bytes
  //     the signer was shown. A signature is bound to that hash, not to a template or a row that
  //     might be edited later. Change a template afterwards and existing signatures still refer to
  //     what was actually signed.
  //  2. TOKENS ARE STORED HASHED. A signing link is a bearer credential that reaches a document
  //     without a login. Anyone with read access to this table would otherwise be able to sign as
  //     the customer.
  //  3. THE AUDIT LOG IS HASH-CHAINED. Each event carries the previous event's hash, so altering or
  //     removing an event breaks every hash after it. Without this, a self-hosted trail is only as
  //     credible as "we promise we did not edit our own database" — which is exactly the thing a
  //     dispute would be about.

  // A reusable document with {{merge_fields}}. Uploaded one-off documents have no template.
  db.exec(`CREATE TABLE IF NOT EXISTS doc_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'agreement',   -- agreement | lease | consent | work_order | other
    body TEXT NOT NULL DEFAULT '',            -- plain text with {{merge}} placeholders
    signer_roles_json TEXT NOT NULL DEFAULT '["customer"]',
    active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);

  db.exec(`CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    template_id INTEGER REFERENCES doc_templates(id) ON DELETE SET NULL,
    source TEXT NOT NULL DEFAULT 'generated',  -- generated | uploaded
    -- What it belongs to. Customer for service agreements, site or pop for leases and access
    -- agreements — a rooftop lease belongs to the structure, not to whoever is served from it.
    parent_type TEXT NOT NULL,                 -- customer | site | pop
    parent_id INTEGER NOT NULL,
    body TEXT,                                 -- the merged text, kept so the document is readable
                                               -- without re-rendering a PDF
    stored_name TEXT,                          -- the PDF exactly as sent
    content_sha256 TEXT,                       -- hash of those bytes; a signature binds to THIS
    signed_stored_name TEXT,                   -- the completed PDF, signatures and certificate
    signed_sha256 TEXT,
    status TEXT NOT NULL DEFAULT 'draft',      -- draft|sent|viewed|partially_signed|signed|declined|voided|expired
    expires_at TEXT,
    voided_reason TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at TEXT, completed_at TEXT)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents(parent_type, parent_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status)');

  // One row per person who must sign. Separate from `documents` because a lease has a lessor AND a
  // countersigning officer, and each needs their own link, their own evidence and their own status.
  db.exec(`CREATE TABLE IF NOT EXISTS doc_signers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'customer',     -- customer | lessor | witness | countersign
    name TEXT NOT NULL,
    email TEXT, phone TEXT,
    delivery TEXT NOT NULL DEFAULT 'email',    -- email | sms | whatsapp | portal | in_person
    order_index INTEGER NOT NULL DEFAULT 0,    -- sequential signing; same number means parallel
    -- Only the hash. The raw token exists in the emailed URL and nowhere else.
    token_hash TEXT UNIQUE,
    token_expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending',    -- pending | viewed | signed | declined
    -- Evidence. Under ESIGN/UETA what matters is intent to sign, consent to transact
    -- electronically, and attribution to a person; these columns are that record.
    consent_at TEXT,                           -- agreed to sign electronically, separately recorded
    signed_at TEXT,
    signature_kind TEXT,                       -- drawn | typed
    signature_strokes TEXT,                    -- JSON stroke paths: order and shape of the pen
    signature_typed TEXT,                      -- the name as typed
    signed_ip TEXT, signed_user_agent TEXT,
    signed_lat REAL, signed_lng REAL, signed_accuracy REAL,
    signed_geo TEXT,                          -- captured | denied | unavailable | timeout | unsupported
    signed_tz TEXT, signed_client_at TEXT,    -- what the device clock showed, beside the server time
    viewed_at TEXT, declined_at TEXT, declined_reason TEXT)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_docsigners_doc ON doc_signers(document_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_docsigners_token ON doc_signers(token_hash)');
  ensure('doc_signers', 'signed_lat', 'REAL');
  ensure('doc_signers', 'signed_lng', 'REAL');
  ensure('doc_signers', 'signed_accuracy', 'REAL');
  ensure('doc_signers', 'signed_geo', 'TEXT');
  ensure('doc_signers', 'signed_tz', 'TEXT');
  ensure('doc_signers', 'signed_client_at', 'TEXT');
  // Documents that are an EXISTING PDF form (IRS W-9) filled in by the signer, rather than text we
  // render. form_prefill holds what staff already knew — never a taxpayer ID; see lib/w9.js.
  ensure('documents', 'form_kind', 'TEXT');
  ensure('documents', 'form_prefill', 'TEXT');
  // Form documents keep the official form untouched as the signed file, so the certificate of
  // completion is filed beside it rather than appended as a page.
  ensure('documents', 'certificate_stored_name', 'TEXT');
  ensure('documents', 'certificate_sha256', 'TEXT');
  // What a signer's form answers amounted to, minus anything sensitive (for a W-9: name,
  // classification, last four of the TIN). JSON.
  ensure('doc_signers', 'form_summary', 'TEXT');

  // The tamper-evident trail. Append-only by convention and by hash: `hash` covers this row's
  // contents AND `prev_hash`, so the chain can be recomputed end to end and any edit, insertion or
  // deletion shows up as the first row where the recomputation diverges.
  db.exec(`CREATE TABLE IF NOT EXISTS doc_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    signer_id INTEGER REFERENCES doc_signers(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,                        -- created|sent|delivered|viewed|consented|signed|declined|completed|voided|downloaded
    detail TEXT,                               -- human-readable; this is what a certificate prints
    actor TEXT,                                -- staff email, or the signer's name
    ip TEXT, user_agent TEXT,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    prev_hash TEXT NOT NULL DEFAULT '',
    hash TEXT NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_docevents_doc ON doc_events(document_id, id)');

  // ---- Google Workspace mailboxes -------------------------------------------------------------
  //
  // TWO ADDRESSES, NOT ONE, and conflating them is the mistake this table exists to prevent.
  //
  //   impersonate_as — the account Google issues a token for. It MUST be the user's primary
  //                    address. Domain-wide delegation rejects an alias, and the resulting error
  //                    ("account not found") reads like a broken credential rather than the wrong
  //                    address, which is how it costs an afternoon.
  //   send_as        — what goes in the From header. On a Workspace account with several domains
  //                    these often differ: sign in as support@primary.com, correspond as
  //                    support@brand.com.
  //
  // They are stored separately because Gmail's failure mode when send_as is not permitted is to
  // silently REWRITE the From to the account's own address. The mail goes out under the wrong
  // identity, the API returns success, and nothing anywhere reports a problem. Recording both, and
  // verifying send_as against Gmail's own sendAs list at setup, is what turns that into an error
  // somebody sees.
  db.exec(`CREATE TABLE IF NOT EXISTS mailboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,                       -- "Support", "Carriers" — what staff see
    impersonate_as TEXT NOT NULL UNIQUE,       -- the primary address; the JWT 'sub'
    send_as TEXT,                              -- From header; NULL means use impersonate_as
    purpose TEXT NOT NULL DEFAULT 'customer',  -- customer | vendor | billing | other
    enabled INTEGER NOT NULL DEFAULT 1,
    -- Incremental sync state. history_id is Gmail's cursor; when it ages out (about a week) the
    -- sync falls back to a full pass rather than stalling.
    history_id TEXT,
    last_sync_at TEXT, last_sync_error TEXT, last_sync_count INTEGER DEFAULT 0,
    -- What the connection test actually found, kept so a later failure can be compared against a
    -- known-good baseline instead of guessed at.
    verified_at TEXT, verified_send_as TEXT,   -- JSON array of addresses Google says it may send as
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_mailboxes_enabled ON mailboxes(enabled)');

  // ---- Vendors ----------------------------------------------------------------------------------
  //
  // CARRIERS ARE VENDORS. Cox and Zayo are companies we pay, exactly like the distributor we buy
  // radios from or the electrician who wires a cabinet, so they live in one list. That list is the
  // existing upstream_providers table rather than a new `vendors` table: accounts, devices, circuits
  // and connections already point into it by id, and a second table would mean the same company on
  // record twice with nothing joining the two — the problem the carrier link was built to remove.
  //
  // `vendor_kind` is what separates them. Every row that existed before this is a carrier (that is
  // all the table held), so the backfill is safe. Carrier pickers filter on it; the Vendors page
  // shows everything.
  ensure('upstream_providers', 'vendor_kind', 'TEXT');
  db.prepare("UPDATE upstream_providers SET vendor_kind='carrier' WHERE vendor_kind IS NULL").run();
  ensure('upstream_providers', 'email', 'TEXT');           // the general / accounts-payable address
  ensure('upstream_providers', 'phone', 'TEXT');
  ensure('upstream_providers', 'website', 'TEXT');
  ensure('upstream_providers', 'address', 'TEXT');
  ensure('upstream_providers', 'our_account_number', 'TEXT'); // what they call us, for their invoices
  ensure('upstream_providers', 'payment_terms', 'TEXT');   // Net 30, due on receipt, autopay…
  ensure('upstream_providers', 'notes', 'TEXT');
  // Tax. Only the LAST FOUR of the TIN is kept in a column: the full number is on the W-9 itself,
  // which is filed as a document, and a table column is the thing that ends up in an export, a
  // screenshot or a support ticket. Four digits is enough to tell two W-9s apart.
  ensure('upstream_providers', 'tax_classification', 'TEXT'); // individual, llc, c_corp, s_corp, partnership, other
  ensure('upstream_providers', 'tin_type', 'TEXT');            // ein | ssn
  ensure('upstream_providers', 'tin_last4', 'TEXT');
  ensure('upstream_providers', 'is_1099', 'INTEGER NOT NULL DEFAULT 0');
  ensure('upstream_providers', 'w9_received_at', 'TEXT');
  ensure('upstream_providers', 'w9_attachment_id', 'INTEGER');
  ensure('upstream_providers', 'w9_document_id', 'INTEGER');   // the signed W-9 completed through /sign
  ensure('upstream_providers', 'legal_name', 'TEXT');          // line 1 of their W-9
  ensure('upstream_providers', 'backup_withholding', 'INTEGER NOT NULL DEFAULT 0');
  ensure('upstream_providers', 'created_at', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_providers_kind ON upstream_providers(vendor_kind)');

  db.exec(`CREATE TABLE IF NOT EXISTS vendor_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER NOT NULL,
    name TEXT NOT NULL, role TEXT, email TEXT, phone TEXT, notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_contacts ON vendor_contacts(vendor_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_contacts_email ON vendor_contacts(lower(email))');

  // ---- Expenses ---------------------------------------------------------------------------------
  //
  // One row per bill or purchase. Money is stored in CENTS as an integer: floating-point dollars
  // turn $0.10 + $0.20 into $0.30000000000000004, and a ledger that does not add up to the penny is
  // a ledger nobody trusts.
  //
  // Nothing is deleted. A mistaken expense is VOIDED — it stays, marked, with who voided it and why,
  // and drops out of every total. Same rule as the rest of the platform, and the one an accountant
  // will ask about first.
  //
  // `parent_type/parent_id` optionally says where the money went (customer, site or POP), which is
  // what lets Profit & Loss charge it against the right account.
  db.exec(`CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER NOT NULL,
    date TEXT NOT NULL,                     -- when it was incurred / billed (YYYY-MM-DD)
    due_date TEXT,                          -- when it must be paid; NULL for things paid on the spot
    amount_cents INTEGER NOT NULL,          -- the total, tax included
    category TEXT NOT NULL DEFAULT 'other',
    description TEXT,
    reference TEXT,                         -- their invoice / bill / order number
    status TEXT NOT NULL DEFAULT 'unpaid',  -- unpaid | paid | void
    paid_at TEXT, paid_method TEXT, paid_reference TEXT,
    parent_type TEXT, parent_id INTEGER,    -- optional: customer | site | pop
    receipt_stored TEXT, receipt_name TEXT, receipt_mime TEXT, receipt_size INTEGER,
    recurring_id INTEGER, period TEXT,      -- set when generated from a schedule
    void_reason TEXT, voided_at TEXT, voided_by TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_vendor ON expenses(vendor_id, date)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status, due_date)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_parent ON expenses(parent_type, parent_id)');
  // The idempotency key for generated bills. However many times the generator runs — a restart, two
  // ticks racing, a clock change — one schedule produces at most one expense per period.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_recurring_period ON expenses(recurring_id, period) WHERE recurring_id IS NOT NULL');

  db.exec(`CREATE TABLE IF NOT EXISTS expense_recurring (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER NOT NULL,
    description TEXT, category TEXT NOT NULL DEFAULT 'other',
    amount_cents INTEGER NOT NULL,
    frequency TEXT NOT NULL DEFAULT 'monthly', -- weekly | monthly | quarterly | semiannual | yearly
    anchor_day INTEGER,                     -- day of month it falls on; kept so Jan 31 → Feb 28 → Mar 31
    next_date TEXT NOT NULL,
    due_days INTEGER NOT NULL DEFAULT 0,    -- how long after the bill date it is due
    autopay INTEGER NOT NULL DEFAULT 0,     -- generated as already paid (card on file, bank draft)
    parent_type TEXT, parent_id INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_expense_recurring_vendor ON expense_recurring(vendor_id)');

  // Mail to and from a vendor, filed on their page. Kept apart from customer_messages on purpose:
  // that table feeds tickets, the customer portal and the customer's own history, and a supplier's
  // quote must never be one join away from appearing in any of those.
  db.exec(`CREATE TABLE IF NOT EXISTS vendor_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER NOT NULL,
    direction TEXT NOT NULL,                -- in | out
    from_addr TEXT, to_addr TEXT, subject TEXT, body TEXT,
    external_id TEXT,                       -- RFC 822 Message-ID, for de-duplication
    author TEXT, delivery TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_vendor_messages ON vendor_messages(vendor_id, id)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_messages_ext ON vendor_messages(vendor_id, external_id) WHERE external_id IS NOT NULL');

  // ---- Archiving: records are deactivated, never destroyed --------------------------------------
  //
  // A customer who leaves does not stop having existed. Their signed agreements, the sites they
  // were served at, the tickets they raised and the invoices they were sent are the company's
  // record of what happened, and they are wanted years later — for a dispute, an audit, a tax
  // question, or simply "did we ever serve this address?".
  //
  // So the destructive deletes are gone. Archiving sets these three columns; nothing is removed.
  //
  // A DEDICATED COLUMN, not a status value. `status` already means the operational state — Active,
  // Planned, Decommissioned — and those are different questions. A site can be Decommissioned and
  // still very much on the books; a customer can be archived while their last site reads Active
  // because nobody updated it. Overloading one column would make "show me everything still live"
  // unanswerable without knowing which meaning was intended on each row.
  //
  // One exception, for customers only: archiving also sets status='Closed', and reactivating sets it
  // back to Active, because for a customer the two really are the same fact and the pill on every
  // screen should say so. archived_at stays the thing every query checks.
  for (const t of ['customers', 'sites', 'pops', 'accounts', 'devices', 'circuits', 'upstream_providers']) {
    ensure(t, 'archived_at', 'TEXT');        // when; NULL means active
    ensure(t, 'archived_by', 'TEXT');        // who
    ensure(t, 'archived_reason', 'TEXT');    // why, in their words
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_customers_archived ON customers(archived_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sites_archived ON sites(archived_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_devices_archived ON devices(archived_at)');

  // Customers closed by the earlier version of this feature were marked status='Closed' and nothing
  // else. Give them an archived_at so they drop out of the lists and stay locked out of the portal
  // under the same rule as everything archived since. `archived_by` says where the stamp came from
  // rather than inventing a person; the real who/when is in the audit log. Idempotent: rows that
  // already have archived_at are untouched.
  db.prepare(`UPDATE customers SET archived_at=datetime('now'), archived_by='migration: status was Closed'
    WHERE COALESCE(status,'')='Closed' AND archived_at IS NULL`).run();
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
    // migrate() already seeds the common carriers and runs first, so reuse those rows rather than
    // inserting a second Cox and a second Lumen on a fresh database.
    const provider = (name, type) => {
      const ex = db.prepare('SELECT id FROM upstream_providers WHERE LOWER(name)=LOWER(?)').get(name);
      return ex ? ex.id : db.prepare('INSERT INTO upstream_providers (name, provider_type) VALUES (?,?)').run(name, type).lastInsertRowid;
    };
    const cox = provider('Cox', 'Wholesale');
    const lumen = provider('Lumen', 'Transit');
    provider('Cogent', 'Transit');

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
  for (const t of ['audit_log','devices','connections','circuits','site_notes','site_access','sites','previous_isps','account_contacts','accounts','controllers','device_models','upstream_providers','pops']) {
    try { db.exec(`DROP TABLE IF EXISTS ${t}`); } catch {}
  }
  initSchema(); seed();
  console.log('Database reset and reseeded.');
} else if (arg === '--seed') {
  initSchema();
  if (isEmpty()) { seed(); console.log('Seeded.'); } else { console.log('Already has data; skipping seed.'); }
}
