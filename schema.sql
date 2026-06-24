-- Network Inventory & Management Platform — schema (testing build)
PRAGMA foreign_keys = ON;

-- Users (team accounts) + sessions
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'support',   -- admin | noc | field | support
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- Key/value app settings (overlay config, etc.)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Customer / account (no on-net/brokered type; that lives on connections)
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  account_number TEXT,
  sub_account TEXT,
  pin TEXT,                                 -- sensitive: NOC/Admin only
  email TEXT,
  portal_url TEXT,
  portal_password TEXT,                      -- sensitive: NOC/Admin only
  security_questions TEXT,                   -- sensitive: NOC/Admin only
  status TEXT NOT NULL DEFAULT 'Active',
  billing_address TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Customers live under an account; a customer can own many sites
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'Active',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT,
  role TEXT,
  email TEXT,
  phone TEXT,
  is_primary INTEGER DEFAULT 0,
  is_billing INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS previous_isps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT,
  until_label TEXT,
  reason TEXT
);

-- Network POP sites (owned infrastructure). Address optional; may be GPS only.
CREATE TABLE IF NOT EXISTS pops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT,
  address TEXT,
  lat REAL,
  lng REAL,
  status TEXT NOT NULL DEFAULT 'Active',
  current_mgmt_ip TEXT,
  current_public_ip TEXT
);

-- POP upstream/bandwidth circuits — source is another POP or an account (carrier)
CREATE TABLE IF NOT EXISTS pop_circuits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pop_id INTEGER NOT NULL REFERENCES pops(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,                   -- 'pop' | 'account'
  source_pop_id INTEGER REFERENCES pops(id),
  source_account_id INTEGER REFERENCES accounts(id),
  circuit_id TEXT,
  bandwidth TEXT,
  status TEXT DEFAULT 'Up',                     -- Up / Standby / Down
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Upstream providers (carriers / transit / wholesale)
CREATE TABLE IF NOT EXISTS upstream_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider_type TEXT
);

-- Customer sites. Address optional; falls back to GPS.
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id),
  name TEXT NOT NULL,
  service_address TEXT,
  lat REAL,
  lng REAL,
  status TEXT NOT NULL DEFAULT 'Active',
  current_mgmt_ip TEXT,
  current_public_ip TEXT,
  notes TEXT
);

-- Pinned site access (codes/contacts). Sensitive.
CREATE TABLE IF NOT EXISTS site_access (
  site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  details_json TEXT
);

-- Site notes (timeline)
CREATE TABLE IF NOT EXISTS site_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  author TEXT,
  author_role TEXT,
  body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- POP access notes (sensitive, NOC/Admin) + POP notes timeline
CREATE TABLE IF NOT EXISTS pop_access (
  pop_id INTEGER PRIMARY KEY REFERENCES pops(id) ON DELETE CASCADE,
  body TEXT
);
CREATE TABLE IF NOT EXISTS pop_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pop_id INTEGER NOT NULL REFERENCES pops(id) ON DELETE CASCADE,
  author TEXT,
  author_role TEXT,
  body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Connections (primary/failover) served by a POP or a brokered carrier
CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'Primary',       -- Primary / Failover
  priority INTEGER DEFAULT 1,
  served_type TEXT,                            -- 'pop' | 'brokered'
  served_pop_id INTEGER REFERENCES pops(id),
  served_provider_id INTEGER REFERENCES upstream_providers(id),
  circuit_id TEXT,
  wan_port TEXT,
  ip_type TEXT DEFAULT 'Static',               -- Static / Dynamic
  static_ip TEXT,
  current_ip TEXT,
  bandwidth TEXT,
  status TEXT DEFAULT 'Up'                      -- Up / Standby / Down
);

-- Device model catalog (admin/NOC managed)
CREATE TABLE IF NOT EXISTS device_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  manufacturer TEXT NOT NULL,
  model TEXT NOT NULL,
  device_type TEXT,
  has_wifi INTEGER DEFAULT 0,
  has_cellular INTEGER DEFAULT 0
);

-- Controllers (UniFi / UISP)
CREATE TABLE IF NOT EXISTS controllers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT,                                    -- UniFi / UISP
  endpoint TEXT,
  status TEXT DEFAULT 'Reachable',
  sync_enabled INTEGER DEFAULT 1
);

-- Devices / hardware (assets)
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  model_id INTEGER REFERENCES device_models(id),
  serial TEXT,
  mac TEXT,
  status TEXT NOT NULL DEFAULT 'Deployed',      -- Deployed / In stock / Spare / RMA / Retired
  online INTEGER DEFAULT 1,
  -- assignment (polymorphic): pop | site | none
  assigned_type TEXT,
  assigned_site_id INTEGER REFERENCES sites(id),
  assigned_pop_id INTEGER REFERENCES pops(id),
  -- management
  management_mode TEXT NOT NULL DEFAULT 'platform',  -- platform | provider
  mgmt_overlay TEXT,                                  -- WireGuard | ZeroTier
  mgmt_address TEXT,
  controller_id INTEGER REFERENCES controllers(id),
  -- ownership + account
  ownership TEXT DEFAULT 'us',                         -- us | carrier | distributor
  owner_org TEXT,
  account_number TEXT,
  owner_account TEXT,
  owner_sub_account TEXT,
  account_status TEXT DEFAULT 'active',                -- active | none
  -- provider-managed (coax modem) extras
  hfc_mac TEXT,
  purchased_from TEXT,
  associated_connection_id INTEGER REFERENCES connections(id),
  -- cellular (5G)
  cell_carrier TEXT,
  cell_phone TEXT,
  cell_imei TEXT,
  cell_sim TEXT,
  cell_sku TEXT,
  -- credentials (NOC/Admin only at API layer)
  factory_password TEXT,
  admin_password TEXT,
  tech_username TEXT,
  tech_password TEXT,
  factory_wifi_ssid TEXT,
  factory_wifi_password TEXT,
  -- account access creds (NOC/Admin only)
  acct_pin TEXT,
  acct_portal_username TEXT,
  acct_portal_password TEXT,
  acct_passphrase TEXT,
  -- management overlay identifiers
  zt_node_id TEXT,
  wg_public_key TEXT,
  wg_private_key TEXT,
  -- live polling (RouterOS etc.)
  admin_username TEXT,
  interfaces_json TEXT,
  iface_roles_json TEXT,
  wifi_json TEXT,
  last_polled TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Note attachments (pictures + PDFs); files on disk, metadata here
CREATE TABLE IF NOT EXISTS note_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_type TEXT NOT NULL,                  -- 'site' | 'pop'
  parent_id INTEGER NOT NULL,
  note_id INTEGER,
  filename TEXT,
  mime TEXT,
  size INTEGER,
  stored_name TEXT NOT NULL,
  author TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Weekly router config backups (.rsc exports); files on disk, metadata here
CREATE TABLE IF NOT EXISTS router_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ok',           -- ok | error
  error TEXT,
  size INTEGER,
  stored_name TEXT,
  format TEXT DEFAULT 'rsc',
  source TEXT,                                  -- auto | manual
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit log (immutable trail)
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT,
  role TEXT,
  action TEXT,
  target TEXT,
  details TEXT
);
