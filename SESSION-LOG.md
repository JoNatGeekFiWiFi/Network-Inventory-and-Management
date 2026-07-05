# Build session log — Network Inventory & Management Platform

A chronological record of the work done in this build session (requests + what was implemented).
Reconstructed from the task list and change history — not a verbatim chat transcript.

Stack: Node.js + Express + `node:sqlite` (Node ≥ 22.5). Vanilla-JS SPA in `public/`.
Deploy target: Hetzner Linux VPS, systemd service `netinv`, nginx reverse proxy, live at management.geekitek.com.
Standard deploy after any change:
```
./push-to-github.sh
# on the VPS:
cd /opt/netinv && git pull && npm install && chown -R netinv:netinv /opt/netinv && sudo systemctl restart netinv
```

---

## Foundation (earlier in the project)
- Requirements/data-model spec (`platform-spec.md`); POP vs customer sites modeled separately; connections served by a POP or brokered carrier.
- Node + Express + SQLite app with real auth (scrypt, DB-backed sessions, httpOnly cookie), role-based access (admin/noc/field/support) and server-side credential masking.
- Web SPA (hash router) + login + admin Users management.
- Management overlays: ZeroTier (Central API) + WireGuard (keygen + no-overlap IPAM, per-device config, hub config).
- Live RouterOS polling over the overlay (REST): interfaces, IPs, negotiated speed, serial, port-1 MAC.
- Telemetry sampler (60s): per-port traffic (bps from byte counters), WAN latency; expandable Chart.js graphs; WAN role tagging (WAN1/WAN2/LAN/MGMT).
- Threat blocklist: harvest failed-login IPs from RouterOS logs → `netinv-blocklist` address-list + input drop rule, auto-pushed fleet-wide.
- Deploy tooling: GitHub (SSH deploy key), cloud-init, systemd + nginx, data volume.

## This session (in order)

1. **Customer entity refactor (Account → Customers → Sites).** Site form picks a customer (searchable "Customer · Account") with inline new-customer/new-account; sites list + detail show customer.

2. **Address autocomplete.** Chose OpenStreetMap/Nominatim (free). Server proxy `/api/geocode` (User-Agent, caching, US-biased) auto-fills address + lat/lng on site, POP, and account forms.

3. **DHCP lease management.** Per-device page → later moved to its own page (`#/device/:id/dhcp`). View live leases; per-lease actions: make-static, block/unblock, disable/enable, remove (auto make-static first where needed).

4. **WiFi view/edit + own page.** Poll detects WiFi (legacy `/interface/wireless` + v7 `/interface/wifi`); reveal/edit SSID + password; dedicated WiFi page with **connected clients + signal (dBm)** for diagnostics.

5. **Blocklist hit threshold.** Setting for minimum failed-login hits before an IP is pushed to routers (manual adds always block); rows show blocked / below-threshold.

6. **Account portal fields.** Added email, portal URL, account/portal password, security Q&A (sensitive → NOC/Admin only) to accounts.

7. **POP upstream circuits.** Record where a POP gets bandwidth: another POP or an account (carrier), with circuit ID, bandwidth, status.

8. **Note attachments.** Pictures + PDFs on site & POP notes (base64 upload, stored on the data volume, image thumbnails + PDF chips, NOC delete).

9. **Inline new-site on the device form.** "New site" option (name + customer) when assigning hardware.

10. **Router config backups.** Weekly automatic RouterOS config exports, kept 6 months, per-device page with download / Back up now / Diagnose.
    - Iterated on retrieval: this RouterOS returns `[]` for inline export and won't return file contents over REST and rejects HTTP fetch-upload ("only [s]ftp modes support upload") → final solution: platform **pulls the `.rsc` via a built-in FTP client** over the overlay.

11. **Zero-touch provisioning / default config.** Per-device default-config `.rsc` for Netinstall (survives reset button) with users, overlay/firewall, full standalone config incl. WiFi (wifiwave2), and a **phone-home script** that identifies by serial and restores the latest backup. Settings: public URL + provision token.

12. **Batch config (fleet-wide).** Operations: change password, add user, remove user, set WiFi, add firewall rule, **update packages (RouterOS)**, **update RouterBOOT firmware**. Multi-select targets with filters, per-device success/fail reporting, job history. Target rows show **RouterOS + firmware version** with an "FW↑" flag; **Poll all** button.

13. **Package library + per-device assignment.** Upload `.npk` by architecture; the default-config installs assigned packages on boot.

14. **Provisioning node (netinstall bench).** `provision-node/` — script + config + README for a Raspberry Pi/mini-PC running MikroTik netinstall-cli, powered/cabled via a netPower 16P. Auto-enroll: netinstalled routers phone home and are added to inventory (**Pending enrollments** view). Provisioning-nodes registry with per-node tokens.

15. **Account ⇄ Customer many-to-many.** Fixed the conflation: an account serves many customers and a customer can be served by many accounts (join table + multi-account picker; each site served by one of the customer's accounts). Routes relabeled: accounts `/accounts` + `/account/:id`, customers `/customer/:id`. Added a **Customers** sidebar item.

16. **Site Access system (visitor check-in).** Public no-login form at `/access` (name, email, phone, site autocomplete, **ID photo** — converted to JPEG in-browser to fix iPhone HEIC). Staff **Site Access** page with approve/deny.
    - **Email notifications** (nodemailer + SMTP settings): new-request → notify mailbox; approve/deny → requester. Test-email button.
    - **Check-in / check-out** log with "on site now" count and full visit history.
    - **Search** to find returning visitors and check them in fast.
    - **Add visitor** (staff): register + check in without the public form, reusing a returning visitor's details and **ID photo** (no re-scan).
    - **Check-out email** on manual checkout; **auto check-out** at a configurable end-of-day time.

---

## Key files
- `server.js` — Express API + telemetry/backup/auto-checkout sampler.
- `db.js` — schema bootstrap, migrations, seed, backfills. `schema.sql` — fresh-install schema.
- `public/app.js` / `public/index.html` / `public/styles.css` — the SPA.
- `public/access.html` — public visitor check-in form.
- `provision-node/` — netinstall bench agent + setup guide.
- `wg.js`, `hash.js`, `auth.js` — WireGuard keygen/IPAM, scrypt, sessions.
- `README.md`, `cloud-init.yaml`, `push-to-github.sh`, `deploy/` — deploy tooling.

## Session 2026-07-01 → 07-02

17. **Project review.** Full code + session-log review; findings logged (role-gating gaps on device/site writes, plaintext secrets, login rate limiting, nginx `client_max_body_size`, broken `npm run reset`) — security fixes deferred while testing.
18. **Theme control.** Light/Dark/Auto segmented slider in the top bar (saved per device, pre-paint apply, works on the login screen).
19. **Button labels.** Every icon-only button/anchor got visible text + explanatory hover titles (Delete/Edit/Download/History/Mark set up); dangerous actions warn in their tooltip.
20. **Deploy tooling.** `deploy/deploy.sh` (DB backup → pull → install → chown → restart → health-check, prints rollback commands); `push-to-github.sh` now prompts for a commit message so each deploy is identifiable.
21. **Model catalog.** `model-catalog.js` — 283 MikroTik + Ubiquiti models (routers, switches, APs, CPE, LTE/5G; antennas skipped) imported idempotently at startup; Models page got a filter box; "Ubiquiti UniFi" manufacturer normalized to "Ubiquiti".
22. **Delete/management options.** Delete buttons (NOC/Admin) on sites, accounts, customers, POPs, devices, connections and notes. New endpoints: `DELETE /api/connections/:id`, site-note + pop-note deletes. Site delete unassigns hardware instead of orphaning it; account delete refuses while customers/sites depend on it.
23. **Standalone billing (replaces the brief Invoice Ninja-mirror approach — decided against connecting to IN).** Invoices live in the platform (`bill_*` tables); Stripe only processes card + ACH payments. Products catalog, invoice create/edit (line items, tax, due dates, sequential numbering), send via SMTP with a public tokenized pay page (`/pay/<token>` → Stripe Checkout, card + `us_bank_account`), signature-verified `/stripe/webhook` marks invoices paid (idempotent per payment-intent; handles async ACH settlement), manual payments (check/cash), void/delete lifecycle, recurring schedules generated hourly by the sampler (auto-email or draft), customers got a `billing_email`, customer pages show their invoices, one-click JSON backup + restore. Setup: Settings → Billing & Stripe (company name, numbering, `sk_` key, `whsec_` secret; webhook endpoint `<public URL>/stripe/webhook` with the 3 checkout events).

## Notes / caveats
- Backups, provisioning phone-home, DHCP/WiFi/version polling, and batch ops were verified for plumbing/logic in a sandbox but the live RouterOS calls require the VPS to be on the management overlay (they can't reach real routers from the build sandbox).
- Email requires a working SMTP server configured in Settings.
- Auto check-out uses the server's local timezone.
