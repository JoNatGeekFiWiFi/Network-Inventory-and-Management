# Network Inventory & Management Platform — Requirements & Data Model

**Status:** Draft v0.1 · **Date:** 2026-06-09 · **Owner:** Jon

## 1. Vision

A network hardware inventory and remote management platform where hardware is tracked through its full lifecycle and assigned to either **customer sites** or **network POP sites**. The platform blends the strengths of two existing tools:

- **Snipe-IT** — simple asset/inventory model: assign hardware to a location, checkout/checkin, custom fields, status, warranty/EOL. The layer everyone uses.
- **NetBox** — config and provisioning depth: racks, device roles, interfaces, IPAM, circuits/uplinks. The layer NOC uses.

Different departments see different layouts over the **same underlying data**. NOC gets full NetBox-style detail; other roles get a simplified Snipe-IT-style view.

## 2. Core Principles

1. **Separate site models.** Customer sites and POP sites are distinct entities, not one object with a type flag. They have different depth, lifecycle, and audiences.
2. **One shared asset model.** A piece of hardware is a single asset record regardless of where it lives; it points to whatever it's assigned to.
3. **Role-based layouts.** UI complexity adapts to the user's role. Default to simple; expose advanced (NOC) mode where the depth is needed.
4. **Traceability.** From any POP or carrier you can answer "which customers does this affect?"

## 3. Entities

### 3.1 POP Site (full depth — NOC surface)

A point-of-presence: owned network infrastructure.

| Field | Notes |
|---|---|
| `id`, `name`, `code` | Short code (e.g. `POP-DAL01`) |
| `address` *(optional)* / `geo` (lat,long) | Location — POPs may have **GPS only, no address** |
| `status` | Planned / Active / Decommissioned |
| `racks[]` | Rack units, positions |
| `devices[]` | Assets installed here (→ Asset) |
| `ipam` | Prefixes, IP ranges, VLANs |
| `circuits[]` | Uplinks / transit / peering (→ Circuit) |
| `power` / `notes` | Optional facility detail |

### 3.2 Customer Site (lighter — field/support surface)

Where a customer receives service.

| Field | Notes |
|---|---|
| `id`, `name` | |
| `account` | Owning Customer/Account (→ §3.7) |
| `service_address` *(optional)* / `geo` (lat,long) | Location — falls back to GPS if no address |
| `status` | Provisioning / Active / Suspended / Cancelled |
| `assigned_hardware[]` | Assets deployed here (→ Asset) |
| `connections[]` | **One or more** (→ Connection). Supports primary + failover |
| `current_mgmt_ip` | Edge/gateway device's management-overlay address (reach the site) |
| `current_public_ip` | Active WAN public IP (whichever connection is live) |
| `handoff` | Demarc / handoff reference (port, circuit ID) |

### 3.3 Brokered Carrier (third-party connectivity)

A wholesale/third-party carrier circuit used to serve a customer when not on owned POP infrastructure. A specific service instance supplied by an Upstream Provider.

| Field | Notes |
|---|---|
| `id` | |
| `provider` | Supplying Upstream Provider (→ §3.8) |
| `circuit_id` | Carrier's circuit identifier |
| `service_type` | Type/speed of service |
| `contract_ref` / `support_contact` | Service-instance specifics |
| `served_sites[]` | Customer sites on this carrier |

### 3.4 Asset / Hardware (shared model — Snipe-IT style)

| Field | Notes |
|---|---|
| `id`, `asset_tag`, `serial` | Identity |
| `model_ref` | Picked from the Device Model catalog (§3.10) — sets manufacturer/model/type |
| `management_mode` | **platform-managed** (default) or **provider-managed** (e.g. Cox coax modem — inventory only, see §3.4a) |
| `ownership` | **Us** / **Carrier** / **Third-party distributor** |
| `owner_org` / `account_number` / `owner_account` / `owner_sub_account` | The org + account number + account & sub-account — **always captured** (even for our own gear, there's a carrier/distributor account) (→ §3.8a) |
| `status` | In stock / Deployed / Spare / RMA / Retired |
| `assigned_to` | **Polymorphic:** POP Site **or** Customer Site |
| `serial` | Captured on add; stored, not shown in simple list |
| `factory_password` | Factory randomized password (encrypted, masked) — **NOC only** |
| `admin_password` | Privileged login, platform-managed (encrypted, masked) — **NOC only** |
| `tech_username` / `tech_password` | Limited on-site account — **visible to field & support techs** |
| `factory_wifi_ssid` / `factory_wifi_password` | Only for `has_wifi` models (e.g. MikroTik WiFi) |
| `cellular.{carrier,imei,sim_iccid,sku,phone_number}` | Only for `has_cellular` models (5G/LTE modem-routers); platform-managed, 5G is the WAN |
| `purchase` / `warranty` / `eol` | Lifecycle |
| `custom_fields` | Per device-type |
| `checkout_history[]` | Assignment/movement log |
| `interfaces[]` / `ip_assignments[]` | NOC/NetBox layer (optional, shown in advanced mode) |
| `interfaces[].role` | WAN1 / WAN2 / LAN / MGMT — **WAN roles shown in simple/tech view** |
| `interfaces[].traffic` | Live in/out throughput + historical series (graphed on device page) |
| `interfaces[].events[]` | Port activity log: link up/down, errors, timestamps |
| `mgmt_overlay` | **ZeroTier** or **WireGuard** (out-of-band mgmt — see §6) |
| `mgmt_address` | Device's IP on the management overlay |
| `mgmt_supported[]` | Which overlays this hardware can run |

### 3.4a Provider-managed devices (e.g. Cox coax modems)

Some hardware is **inventoried but never configured by the platform** — the carrier owns all provisioning. The prime case: coax/DOCSIS modems on **brokered Cox circuits**. `management_mode = provider-managed`.

For these the platform tracks only:

| Field | Notes |
|---|---|
| `manufacturer` / `model` | From the catalog (§3.10) |
| `serial` | Unit serial |
| `purchased_from` | Where it was bought (vendor/source) |
| `hfc_mac` | HFC/DOCSIS MAC — the address Cox uses to provision the modem |
| `associated_connection` | The brokered carrier connection it serves (→ §3.5) |

Provider-managed devices have **no management overlay, no admin/tech credentials, and no config build/push** — those fields and flows are suppressed in the UI. They still appear in inventory, status, and the brokered connection's record. When **Deployed**, they're still assigned to a POP or client site (`assigned_to`) so location is tracked — but **without** management-IP allocation.

### 3.5 Connection (customer site connectivity)

A single link serving a customer site. A site has one or more; this is how primary + failover is modeled.

| Field | Notes |
|---|---|
| `id` | |
| `customer_site` | Owning site (→ Customer Site) |
| `role` | **Primary / Failover / Load-balanced** |
| `served_by` | **Polymorphic:** POP Site **or** Brokered Carrier |
| `priority` | Order for failover (1 = primary) |
| `service_type` / `bandwidth` | Speed/type of this link |
| `circuit_id` | Carrier circuit ID if brokered |
| `status` | Active / Standby / Down |
| `wan_port` | Physical WAN port/interface on the device (WAN1→ether1, etc.) |
| `ip_type` | **Static** or **Dynamic** |
| `static_ip` | Set when `ip_type = Static` |
| `current_ip` | Last-known IP when `ip_type = Dynamic` |
| `ip_last_checked` | Timestamp of last dynamic check |
| `ip_history[]` | Log of observed IP changes (value + timestamp) |

Valid combinations include: 2 POPs, 1 POP + 1 brokered carrier, or 2 brokered carriers.

#### Dynamic IP checking

For connections with `ip_type = Dynamic`, the platform refreshes `current_ip` automatically:

- **Scheduled:** every 6 hours.
- **Event-driven:** immediately whenever the connection's hardware is rebooted.

On each check, if the observed IP differs from `current_ip`, update it and append the old value to `ip_history`. Static connections are not polled; their `static_ip` is authoritative. The IP check should fall back gracefully (mark stale / alert) if the device is unreachable.

### 3.6 Circuit (POP uplinks — NOC)

Type, speed, A/Z endpoints, status. Belongs to a POP. `provider` → Upstream Provider (§3.8).

### 3.7 Customer / Account (top of the customer hierarchy)

The billing/relationship entity that owns one or more customer sites. No on-net/brokered type — that lives on connections (POP vs brokered carrier).

| Field | Notes |
|---|---|
| `id`, `name` | |
| `account_ref` / `billing` | Account number, billing contact |
| `contacts[]` | Account contacts |
| `previous_isps[]` | Prior provider(s) + **reason they left** (sales/retention context) |
| `sites[]` | Customer sites under this account (→ §3.2) |
| `status` | Active / Suspended / Closed |

One account → many customer sites. Lets you roll up "everything for this customer" and treat your own company as just another account.

### 3.8 Upstream Provider (carrier/transit list)

Master list of the carriers, transit, and wholesale companies that supply connectivity. Referenced by POP circuits and brokered carriers.

| Field | Notes |
|---|---|
| `id`, `name` | Provider company |
| `provider_type` | Transit / Wholesale / Peering / Last-mile |
| `asn` | Provider ASN, if applicable |
| `account_ref` / `support_contact` | Our account # and NOC/support contact |
| `contract` / `notes` | Master agreement |
| `circuits[]` / `brokered_carriers[]` | What we buy from them |

Maintained as a managed list so circuits and brokered connections pick from known providers rather than free-text.

### 3.8a Owner accounts (carrier / distributor)

When hardware is **carrier-** or **distributor-owned**, we hold accounts with that owner — often **many accounts and sub-accounts** per owner. Modeled as a hierarchy so a device points at exactly one sub-account.

```
Owner (carrier or 3rd-party distributor)
  └─< Account (one of several we hold)
        └─< Sub-account (device points here)
```

| Field | Notes |
|---|---|
| `owner` | Carrier or distributor org (a distributor resells a carrier) |
| `owner_type` | Carrier / Distributor |
| `account` | Master account we hold with the owner |
| `sub_account` | Sub-account under that account |
| `status` | **Active** or **No account** |
| `access.{pin, portal_username, portal_password, security_passphrase?}` | Account access creds for NOC to manage the account — **NOC/Admin only**, masked, reads logged. Field set is provider-specific (e.g. **Cox = PIN, username, password; no passphrase**). Only populated when status = Active |

A device's `owner_account` / `owner_sub_account` reference into this hierarchy. (Distributors may also link to the underlying carrier.) The account number and account info are **always recorded**, regardless of whether the hardware itself is owned by us, the carrier, or a distributor.

### 3.9 Controller (managed integration endpoint)

A first-class managed object representing a UniFi Network or UISP instance the platform connects to. Devices behind it are managed through it.

| Field | Notes |
|---|---|
| `id`, `name` | |
| `type` | UniFi Network / UISP |
| `endpoint` / `credentials` | API URL + stored credentials |
| `status` / `health` | Reachable, last sync time, errors |
| `sync_enabled` | Whether auto-import is on |
| `managed_devices[]` | Assets associated with this controller |

Assets reference their managing controller (`controller_ref` on the Asset, for controller-mediated gear). MikroTik gear has no controller and is managed direct-to-device.

### 3.10 Device Model (managed catalog)

A managed catalog of manufacturer + model entries that assets are classified against — not free-text. Keeps inventory consistent and gives the automation layer a reliable hook (driver, default config) per model.

| Field | Notes |
|---|---|
| `id` | |
| `manufacturer` | MikroTik / Ubiquiti UniFi / Ubiquiti UISP / … |
| `model` | e.g. CCR2004, RB5009, U6-Pro |
| `device_type` | Router / Switch / Access point / … |
| `has_wifi` | If true, asset form captures factory WiFi SSID + password |
| `has_cellular` | If true (5G/LTE modem-router), asset form captures cellular fields |
| `default_overlay` / `driver` | Hints for provisioning (optional) |
| `notes` | |

**Permissions:** catalog entries are **added/edited only by Admin and NOC** roles. All other roles select from the existing list when adding hardware — they cannot create new manufacturer/model entries.

### 3.11 Activity Log (audit trail)

Immutable record of user actions, surfaced in the NOC/Admin historical-activity view.

| Field | Notes |
|---|---|
| `id`, `timestamp` | |
| `actor` | User who performed the action |
| `action` | add / edit / deploy / reassign / credential_read / config_push / login / catalog_change |
| `target` | What was acted on (asset, site, account, controller, catalog entry…) |
| `details` | Before/after or context |
| `ip` / `role` | Origin and actor's role at the time |

Append-only (immutable); filterable by actor, target, action, and date.

## 4. Key Relationships

```
Customer/Account 1 ──< many Customer Sites
Customer Site    1 ──< many Connections
Connection ──served_by──> POP Site  OR  Brokered Carrier   (per connection)

POP Site         1 ──< many Connections ──> many Customer Sites
Brokered Carrier 1 ──< many Connections ──> many Customer Sites

Upstream Provider 1 ──< many Circuits          (POP uplinks)
Upstream Provider 1 ──< many Brokered Carriers  (third-party last-mile)

Asset ──assigned_to──> POP Site  OR  Customer Site
POP Site 1 ──< many Racks ──< many Devices(Assets)
POP Site 1 ──< many Circuits
```

A customer site has one or more Connections (e.g. a Primary and a Failover), each of which can point to a different POP or brokered carrier. This is the only place the served-by link lives.

**Impact query (NOC value):** Given a POP or a Brokered Carrier → find all Connections that reference it → list affected customer sites/customers. Because failover is explicit (`role`/`priority`), the query can distinguish sites that will **go down** (no surviving connection) from those that will **fail over** (another connection still up).

## 5. Role-Based Layouts

| Role | Sees | Hidden |
|---|---|---|
| **NOC (advanced)** | Everything: racks, IPAM, interfaces, circuits, config/provisioning, impact analysis | — |
| **Field tech** | Customer site → assigned hardware + status; handoff info | IPAM internals, racks, config |
| **Sales / Support** | Customer/account → sites, service status | All NOC infrastructure detail |
| **Asset/Procurement** | Asset list, lifecycle, warranty/EOL, stock | Network topology depth |

Same data, filtered views. A "NOC mode" toggle reveals the NetBox-depth fields on shared records.

**Catalog/admin permissions:** the Device Model catalog (§3.10) is editable only by **Admin and NOC** roles; everyone else selects from it. Other managed lists (Upstream Providers, etc.) follow the same Admin/NOC-edit pattern.

**Credential visibility:** device admin/factory passwords are visible **only to NOC/Admin**. Field techs and support techs see only the limited **tech account** (`tech_username`/`tech_password`). Credential fields are masked with show-on-demand, and access is logged.

### NOC/Admin-only features

Beyond everything in the simple view, NOC and Admin roles get:

1. **Catalog management** — add/edit hardware manufacturers, vendors, and models (the Device Model catalog, §3.10) and other managed lists.
2. **Full credential visibility** — view all device credentials (admin/factory passwords, WiFi creds), masked with show-on-demand.
3. **Historical user activity (audit log)** — a record of who did what and when across the platform: hardware add/edit, deploys/reassignments, credential reads, config builds/pushes, logins, catalog changes. Filterable by user, site, device, and action type; entries are immutable. Credential reads in particular are always logged here.

## 6. Management Network (Out-of-Band Access)

The platform reaches devices over a management overlay, **independent of the customer WAN connection**. This is how the platform polls, monitors, provisions, and — critically — discovers the dynamic WAN IP of a connection by querying the device directly over the overlay.

**Two overlays — one per device (not both):**

- **ZeroTier** — current management network. Used where supported.
- **WireGuard** — being added because **not all network equipment supports ZeroTier**. Used for devices that can't run ZeroTier.

Each device runs **exactly one** overlay (ZeroTier *or* WireGuard), chosen by what the hardware supports.

**Implications for the data model:**

- Each Asset records its management overlay (`mgmt_overlay`: ZeroTier *or* WireGuard — single value), its address on that overlay (`mgmt_address`), and which overlays the hardware is capable of (`mgmt_supported[]`).
- Reachability/monitoring uses `mgmt_address`, not the device's WAN IP — so it works even when the WAN IP is dynamic or the device sits behind a brokered carrier's NAT.
- Dynamic-IP checks (every 6h + on reboot) are performed **over the management overlay**: poll the device, read its current WAN IP, update the Connection.

### 6.1 No-overlap management IPAM (mandatory)

**All networks route through the management network**, so the management address space must be **globally unique — no duplicate or overlapping subnets** across any site or device. Overlapping ranges would break routing and make devices unreachable through NAT. This is the guarantee that the platform can *always* reach every device.

Requirements:

- The platform runs **IPAM for the management network**: it owns the allocation of management subnets and addresses.
- On every assignment it **detects and rejects overlaps/duplicates** — a new site/device subnet cannot collide with any existing one.
- Management addresses are allocated from the platform (suggest next free block), not entered free-hand, to prevent human error.
- This applies regardless of overlay (ZeroTier or WireGuard) — the uniqueness rule spans the whole management plane.

Note: deep customer-side IPAM remains a NOC-only feature, but **management-network IPAM is foundational** and always on.

### 6.2 Device telemetry — port traffic & activity

Opening a device (on a client or POP site) shows **live and historical port activity**:

- **Live throughput** per port (in/out) and a device-level total.
- **Peak download and peak upload** (shown separately) for the selected range.
- **Historical traffic graph** with a selectable time range (1h / 24h / 7d / custom).
- **Per-port graphs** as expandable dropdowns, each with its **own independent range and resolution** selectors (separate per port and from the device-level graph).
- **Port activity log** — link up/down events, errors, and resets with timestamps.

**Retention:** telemetry is stored at **1-minute resolution for 60 days** by default; **NOC users can select a longer retention** per device or globally.

Telemetry is collected by polling the device over the **management overlay** (SNMP/REST/API per vendor) and stored as time series. Available for both client-site and POP-site devices; richer detail (per-queue, per-VLAN) is NOC-side.

## 7. Config Building & Provisioning

The platform is the **source of truth for device config** and actively pushes changes — not just a template store.

- **Build in-platform:** configs (including the ZeroTier/WireGuard management overlay setup) are generated by the platform from the device's data model and role.
- **Push via network automation:** config changes are submitted to the hardware through a network-automation layer (e.g. SSH/NETCONF/API drivers, vendor-appropriate). This covers initial provisioning and ongoing changes.
- **Intended config vs. running config:** platform holds the intended state; automation reconciles it onto the device. (Drift detection / config backup is a natural follow-on.)

This sets v1 provisioning scope to **active config push**, not templates-only.

### 7.1 Vendor support

The automation layer is driver-based so vendors can be added over time, but v1 targets the most common gear:

**MikroTik RouterOS v7 — primary / v1 vendor.**

- **Automation path:** RouterOS v7 **REST API** (HTTPS/JSON) is the preferred driver; legacy binary API (8728/8729) and SSH CLI as fallbacks. No NETCONF on RouterOS.
- **Management overlay fit:** WireGuard is **built into RouterOS v7** (native config) — the default overlay for MikroTik. ZeroTier is only available as a package on certain architectures, so it's used selectively; this is a concrete reason the platform supports both with one-per-device selection.
- **Config build:** generate RouterOS config (overlay, interfaces, addressing, firewall) from the device's data model and push via the REST API.

**Ubiquiti — also in use (v1 / early).** Two distinct platforms, both **controller-mediated** (the platform talks to a controller/cloud API, not each device directly):

- **UniFi Network** — managed via the **UniFi Network controller API** (switches, APs, gateways).
- **UISP** — Ubiquiti's ISP platform (formerly UNMS), via the **UISP API**; covers airMAX / airFiber / EdgeRouter / UFiber.

**Driver model implication:** the automation layer must support two integration patterns — **direct-to-device** (MikroTik RouterOS REST API) and **controller-mediated** (UniFi / UISP APIs). A device's record should note which controller manages it (and the controller becomes a managed object the platform connects to). Overlay support differs by Ubiquiti line (e.g. EdgeRouter/UISP gear can run WireGuard; UniFi varies), so the one-overlay-per-device field still applies per `mgmt_supported[]`.

Additional vendors will be added as further drivers behind the same build/push interface.

### 7.2 Device entry & controller sync

Devices can enter inventory **two ways, and both coexist:**

- **Manual:** a user adds the device directly (asset tag, serial, model, assignment).
- **Auto-sync:** the platform pulls the device list from each controller (UniFi/UISP) and imports anything not already present.

**Reconciliation (no duplicates):** sync matches incoming devices against existing records on a stable key — **serial number, falling back to MAC**. If a match exists (e.g. a device you already added manually), the sync **links and enriches** that record (marks it controller-managed, fills in controller data) rather than creating a new one. Only genuinely new devices are created.

Each controller has a `sync_enabled` flag and records last-sync time/result. Sync is read-from-controller for inventory; config push still goes back out through the controller's API.

## 8. Open Questions

1. ~~Can a site be served by both a POP and a brokered carrier?~~ **Resolved 2026-06-09:** Yes — sites can have multiple connections (primary + failover) in any combination of POPs and brokered carriers. Modeled via the Connection entity.
2. ~~Do brokered carriers need their own IPAM/handoff detail?~~ **Resolved 2026-06-09:** Per-connection IP now modeled (static vs. dynamic). Dynamic IPs are discovered by polling the device **over the management overlay** (§6), every 6h + on reboot.
3. ~~Config/provisioning scope for v1?~~ **Resolved 2026-06-09:** Active config push — platform builds config and submits changes via network automation (§7).
4. ~~Overlay policy — both at once?~~ **Resolved 2026-06-09:** One overlay per device (ZeroTier *or* WireGuard), based on hardware support.
5. ~~Separate Customer entity above sites?~~ **Resolved 2026-06-09:** Yes — Customer/Account entity (§3.7), internal or external, owns many sites. Plus an Upstream Provider list (§3.8) referenced by circuits and brokered carriers.
6. How are WireGuard peer configs/keys (and ZeroTier membership) provisioned and rotated by the platform?
7. ~~Which vendors/drivers must v1 support?~~ **Resolved 2026-06-09:** MikroTik RouterOS v7 (primary, direct REST API) plus Ubiquiti **UniFi Network** and **UISP** (controller-mediated). See §7.1.
8. ~~Controllers as managed objects + manual vs. auto-import?~~ **Resolved 2026-06-09:** Controller is a first-class object (§3.9); devices added manually AND auto-synced, reconciled by serial/MAC to avoid duplicates (§7.2).
9. Sync direction/conflict handling: when controller data and platform data disagree on a synced field, which wins? How often does sync run?

## 9. Suggested Build Phases

- **Phase 1 — Inventory core:** Asset model, POP + Customer site entities, assignment, status, custom fields. (Snipe-IT parity)
- **Phase 2 — Connectivity:** Connection model, Brokered Carrier, circuits, impact query.
- **Phase 3 — NOC depth:** Racks, IPAM, interfaces, config context. (NetBox parity)
- **Phase 4 — Roles & layouts:** Role-based views, advanced/NOC mode toggle, credential visibility rules, catalog management, **activity/audit log**.
- **Phase 5 — Management overlay:** ZeroTier + WireGuard integration (one per device), **no-overlap management IPAM** (unique address allocation, overlap detection), `mgmt_address` reachability, dynamic-IP polling over overlay.
- **Phase 6 — Config automation:** MikroTik RouterOS v7 driver (REST API) first; Ubiquiti UniFi + UISP controller drivers; build configs in-platform, push, intended-vs-running reconciliation.
- **Phase 7 — Remote management:** Monitoring, drift detection, config backup (RMM features).
