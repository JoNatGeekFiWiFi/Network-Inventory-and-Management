# Network Inventory & Management Platform

Hardware inventory and remote management platform. Hardware is assigned to **customer sites** or **network POP sites**. This repository contains an early **testing build** for the team to click through and give feedback on.

- Full requirements & data model: [`platform-spec.md`](./platform-spec.md)
- Stack: **Node.js + Express + SQLite** (uses Node's built-in `node:sqlite` — no native build step)
- Frontend: a single-page app (vanilla JS) served by the same process

## What works in this build

- **User accounts & login** — email/password sign-in with hashed passwords (Node scrypt) and server-side sessions. Admin-only **Users** page to create/edit/deactivate team members and assign roles.
- Customers (accounts) → sites → connections → devices, all persisted to SQLite
- Sites list, site detail (management/public IP, connections with WAN ports, hardware, notes), customer/account pages (rollups, contacts, previous-ISP)
- Device detail with credential reveal and a (sample-data) traffic graph
- Add / edit forms for customers, sites, and hardware — including the device classes we designed: platform-managed (MikroTik/UniFi/UISP), provider-managed (Cox coax modems), and 5G modem routers; ownership (us / carrier / distributor) + account info
- **Role-based credential masking** driven by the signed-in user's role (NOC / Admin / Field tech / Support). NOC/Admin see admin/factory/account credentials and site-access codes; field/support see only the limited tech account. Reveals are written to the activity log.
- **Management overlays** — ZeroTier (reads member IP assignments via the Central API) and WireGuard (generates keypairs, assigns non-overlapping IPs, produces device + hub configs to apply). See below.
- Activity (audit) log

> Not yet in this build (by design): configuration/provisioning, live device polling (telemetry is stubbed with sample data), per-port graphs, controller sync.

## Accounts & roles

Sign-in is required. The seed creates four test accounts (the login screen lists them):

| Email | Password | Role |
|---|---|---|
| admin@geekitek.test | admin123 | admin — manages users + full access |
| noc@geekitek.test | noc123 | noc — full detail incl. credentials |
| field@geekitek.test | field123 | field — simplified, tech account only |
| support@geekitek.test | support123 | support — simplified, tech account only |

**Before exposing this to the team / VPS:** sign in as admin → **Users** → change the admin password and create real accounts for each person (then deactivate or delete the test ones). Passwords are stored as salted scrypt hashes; sessions are httpOnly cookies (14-day expiry).

## Management overlays (ZeroTier & WireGuard)

Configure these under **Settings** (NOC/Admin only). Tokens and keys are stored server-side and never shown to other roles.

### ZeroTier (reads assignments from ZeroTier Central)

1. Create a network at my.zerotier.com and copy its **Network ID**.
2. Create an **API token** (ZeroTier account → API Access Tokens).
3. In **Settings → ZeroTier**, paste the Network ID + API token and Save.
4. On each device, set its **ZeroTier node ID** (Device → Edit, or the Management overlay card).
5. Click **Sync ZeroTier now** — the platform pulls each member's assigned IP into the device's management IP. ZeroTier owns the IP range ("let it decide").

### WireGuard (platform assigns IPs, you apply configs)

1. In **Settings → WireGuard**, set the **Hub endpoint** (`your-vps-host:51820`) and a **managed subnet** (e.g. `10.200.0.0/16`), then Save — this generates the hub keypair.
2. On a device → **Management overlay → Provision on WireGuard**: assigns a non-overlapping IP + keypair.
3. **WireGuard config** → download the device `.conf` (load it on the device).
4. Stand up the hub on the VPS (one time, then re-apply when peers change):

```bash
sudo apt-get install -y wireguard
# Settings → Download hub wg0.conf, then put it here:
sudo tee /etc/wireguard/wg0.conf < downloaded-wg0.conf
sudo chmod 600 /etc/wireguard/wg0.conf
sudo sysctl -w net.ipv4.ip_forward=1            # if you route between peers
sudo wg-quick up wg0
sudo systemctl enable wg-quick@wg0
```

Open the WireGuard UDP port (e.g. `51820/udp`) in your Hetzner Cloud Firewall. After provisioning more devices, re-download the hub config and `sudo wg syncconf wg0 <(wg-quick strip wg0)` (or `wg-quick down/up wg0`).

The app stays non-root and never touches host networking — it generates and tracks configs; you apply them. The hub `wg0.conf` and device configs contain private keys, so their downloads are NOC/Admin-only and logged to Activity.

## Requirements

- **Node.js 22.5 or newer** (the built-in SQLite module requires it). Node 22 LTS is recommended.

Check your version: `node --version`

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

On first run the database (`data.db`) is created and seeded with sample data (Acme Logistics + sites, a Cox modem, a 5G router, etc.).

Useful scripts:

```bash
npm run reset    # drop everything and reseed sample data
```

Environment variables:

- `PORT` — HTTP port (default `3000`)
- `DB_PATH` — path to the SQLite file (default `./data.db`)

## Provisioning on Hetzner Cloud

Recommended for production: **CX32** (4 vCPU / 8 GB / 80 GB, x86) — or **CAX21** (4 ARM vCPU / 8 GB) for better value, since Node, `node:sqlite`, WireGuard and ZeroTier all run on ARM. Scale up to CX42 (8 vCPU / 16 GB) as device count and telemetry grow. Hetzner prices change periodically — check the live rate when ordering.

### 1. Create the server

In the Hetzner Cloud console:

- **Image:** Ubuntu 26.04 LTS (supported to 2031). 24.04 LTS is also fine if you prefer a more battle-tested release.
- **Type:** CX32 (or CAX21 for ARM)
- **SSH key:** add your public key (so you log in without a password)
- **Backups:** enable (≈20% surcharge — worth it for a server holding device data)
- **Volume:** add a Volume (e.g. 10–20 GB) — the database and future telemetry live here, separate from the OS disk so it can grow and be snapshotted independently. Choose **automount + format (ext4)** if offered.
- **Cloud config (cloud-init):** paste the contents of [`cloud-init.yaml`](./cloud-init.yaml) into the **Cloud config** field. It updates packages, creates a key-only sudo `deploy` user and the app's `netinv` user, hardens SSH (keys only, no root password login), installs nginx + fail2ban, enables a host firewall and automatic security updates. **Edit it first** to put your own SSH public key in `ssh_authorized_keys` and set the timezone. (Optional but recommended — it does the first-boot hardening for you.)

### 2. Cloud Firewall

Create a Hetzner Cloud Firewall and attach it to the server. This build has no public-grade auth hardening yet, so don't expose it broadly:

- **Inbound** allow `22/tcp` (SSH) **only from your office/VPN IPs**
- **Inbound** allow `80/tcp` and `443/tcp` (ideally also restricted to your IPs/VPN while testing)
- If devices reach the platform over the management overlay (WireGuard `51820/udp`), allow that port as needed
- Deny everything else (default)

### 3. First-boot setup

SSH in as root, then:

```bash
apt update && apt -y upgrade

# Non-root user to run the app
adduser --system --group --home /opt/netinv netinv

# Mount the Volume for the database (if you did NOT pick automount).
# Find the device:
lsblk
# Hetzner volumes appear as /dev/sdb (or /dev/disk/by-id/scsi-0HC_Volume_XXXXXX). Format + mount:
mkfs.ext4 -F /dev/sdb
mkdir -p /mnt/netinv-data
echo '/dev/sdb /mnt/netinv-data ext4 defaults,nofail 0 0' >> /etc/fstab
mount -a
chown netinv:netinv /mnt/netinv-data
```

If you chose automount, the Volume is already mounted at `/mnt/HC_Volume_XXXXXX` — use that path for `DB_PATH` below instead of `/mnt/netinv-data`.

Then follow **Deploy on a Linux VPS** below, with two tweaks:

- In the systemd unit, set `Environment=DB_PATH=/mnt/netinv-data/data.db` (your Volume path) so the database lives on the Volume, not the OS disk.
- Set the unit's `User=` / `Group=` to `netinv` (the user created above) and `chown -R netinv:netinv` the app directory and the Volume mount.

## Deploy on a Linux VPS

These steps assume Ubuntu/Debian. Adjust for your distro.

### 1. Install Node (need v22.5+)

On Ubuntu 26.04 the distro repos already ship a recent Node — try that first:

```bash
sudo apt-get update
sudo apt-get install -y nodejs
node --version   # need v22.5 or newer
```

If that's older than 22.5, use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

If NodeSource doesn't have a build for your Ubuntu release yet (can happen right after a new release), install via fnm instead:

```bash
curl -fsSL https://fnm.vercel.app/install | bash
exec "$SHELL"          # reload shell so fnm is on PATH
fnm install 22 && fnm default 22
node --version
```

### 2. Get the code onto the server (deploy key)

The repo is private, so the server needs its own read-only credential to GitHub. Use a **deploy key** (scoped to this one repo, not your personal account).

On the server, generate a dedicated key and print the public half:

```bash
ssh-keygen -t ed25519 -C "netinv-vps deploy" -f ~/.ssh/id_deploy -N ""
cat ~/.ssh/id_deploy.pub
```

In GitHub → the repo → **Settings → Deploy keys → Add deploy key** → paste it, and leave **"Allow write access" unchecked** (read-only).

Tell git to use that key for github.com, then clone over SSH:

```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/id_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
sudo mkdir -p /opt/netinv && sudo chown $USER /opt/netinv
git clone git@github.com:JoNatGeekFiWiFi/Network-Inventory-and-Management.git /opt/netinv
cd /opt/netinv
npm install --omit=dev
```

Updates later are just `git pull` (no token prompts, read-only).

### 3. One-command setup

Instead of the manual steps below, run the bundled setup script — it installs Node (if needed), creates the service user, installs dependencies, and writes + starts the systemd service and nginx config:

```bash
sudo DOMAIN=netinv.example.com DB_PATH=/mnt/netinv-data/data.db bash /opt/netinv/deploy/setup.sh
```

(Drop `DOMAIN`/`DB_PATH` to use defaults — `_` and `/opt/netinv/data.db`.) When it finishes, add TLS with `sudo certbot --nginx`, then open the site, sign in as admin, change the password, and create real users. The manual steps in the next sections are equivalent if you'd rather do them by hand.

### 3. Run it as a service (systemd)

Create `/etc/systemd/system/netinv.service`:

```ini
[Unit]
Description=Network Inventory & Management Platform
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/netinv
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Environment=DB_PATH=/opt/netinv/data.db
Restart=on-failure
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

Make the directory writable by the service user, then enable it:

```bash
sudo chown -R www-data:www-data /opt/netinv
sudo systemctl daemon-reload
sudo systemctl enable --now netinv
sudo systemctl status netinv
```

### 4. (Recommended) Put nginx in front

Install nginx and create `/etc/nginx/sites-available/netinv`:

```nginx
server {
    listen 80;
    server_name your-test-domain.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/netinv /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Then add TLS with Let's Encrypt (`sudo certbot --nginx`) and restrict access (firewall / VPN / basic auth) — this build has no login yet, so don't expose it openly with real credentials in it.

### Updating

```bash
cd /opt/netinv && git pull && npm install --omit=dev && sudo systemctl restart netinv
```

## Backups

Everything lives in the single SQLite file (`DB_PATH`). To back up: `sqlite3 data.db ".backup backup.db"` (or stop the service and copy the file).

## Project layout

```
server.js          Express API + serves the frontend
db.js              SQLite bootstrap + sample-data seed
schema.sql         Database schema
public/            Frontend (index.html, app.js, styles.css)
platform-spec.md   Requirements & data model
```
