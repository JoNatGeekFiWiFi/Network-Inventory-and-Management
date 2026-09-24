#!/usr/bin/env bash
#
# Set up the public demo on the SAME server as production, as a second, locked-down service.
# Run ON THE SERVER as root, after DNS for the demo name points at this server:
#
#   sudo DEMO_DOMAIN=demo.geekitek.com bash /opt/netinv/deploy/demo-setup.sh
#
# Safe to run again: every step checks before it changes anything.
#
# What you get:
#   * netinv-demo.service — the same code as production, DEMO_MODE=1, on 127.0.0.1:3001, running as
#     its own user with its own database in /var/lib/netinv-demo. It cannot read production's data,
#     and it cannot open a connection to anything but localhost: once in the app (lib/demoguard.js)
#     and once in the kernel (IPAddressDeny=any / IPAddressAllow=localhost below).
#   * The demo's traffic graphs follow the SHAPE of production's real WAN traffic. Production
#     publishes anonymised curves on a loopback-only route protected by a shared token; the demo
#     fetches them at start. No names, addresses or rates cross over — see lib/trafficshape.js.
#   * nginx + a Let's Encrypt certificate for the demo name.
#   * A nightly reset at 04:00 Phoenix time: the demo database is deleted and regenerated.
#   * Production's data files tightened so no other local user (including the demo) can read them.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Please run with sudo/root." >&2; exit 1; fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE="${SERVICE:-netinv}"
DEMO_SERVICE="netinv-demo"
DEMO_USER="netinv-demo"
DEMO_DIR="/var/lib/netinv-demo"
DEMO_PORT="${DEMO_PORT:-3001}"
DEMO_DOMAIN="${DEMO_DOMAIN:-demo.geekitek.com}"
ETC_DIR="/etc/netinv"
TOKEN_FILE="$ETC_DIR/demo-shape.env"

unit_env() { systemctl show "$SERVICE" -p Environment --value 2>/dev/null | tr ' ' '\n' | grep "^$1=" | head -1 | cut -d= -f2-; }
PROD_PORT="$(unit_env PORT)"; PROD_PORT="${PROD_PORT:-3000}"
DB_PATH="$(unit_env DB_PATH)"; DB_PATH="${DB_PATH:-$APP_DIR/data.db}"
DATA_DIR="$(dirname "$DB_PATH")"
PROD_USER="$(systemctl show "$SERVICE" -p User --value 2>/dev/null)"; PROD_USER="${PROD_USER:-netinv}"
NODE="$(command -v node)"

echo ">> App dir:        $APP_DIR (shared, read-only for the demo)"
echo ">> Production:     $SERVICE on port $PROD_PORT, data in $DATA_DIR"
echo ">> Demo:           $DEMO_SERVICE on 127.0.0.1:$DEMO_PORT, data in $DEMO_DIR"
echo ">> Demo domain:    $DEMO_DOMAIN"
echo

# 1. The demo's own user and data directory
id -u "$DEMO_USER" >/dev/null 2>&1 || adduser --system --group --no-create-home --home "$DEMO_DIR" "$DEMO_USER"
mkdir -p "$DEMO_DIR"
chown "$DEMO_USER":"$DEMO_USER" "$DEMO_DIR"
chmod 750 "$DEMO_DIR"

# 2. Production's data: readable by production only.
#    The demo runs the same checkout, so the code must stay readable — but the database, uploads,
#    router backups and packages must not be, and neither must anything git ignores in the app
#    directory (that is where a stray database or export would sit).
echo ">> Tightening permissions on production data…"
for f in "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"; do [ -e "$f" ] && chmod o-rwx "$f"; done
for d in uploads backups packages deploy-backups; do [ -d "$DATA_DIR/$d" ] && chmod -R o-rwx "$DATA_DIR/$d"; done
if [ "$DATA_DIR" != "$APP_DIR" ]; then chmod o-rwx "$DATA_DIR"; fi
( cd "$APP_DIR" && git -c safe.directory="$APP_DIR" ls-files --others --ignored --exclude-standard --directory 2>/dev/null \
    | grep -v '^node_modules/' | while read -r p; do [ -e "$p" ] && chmod -R o-rwx "$p"; done ) || true
chmod o+rx "$APP_DIR"

# 3. The shared token for the traffic-shape route
mkdir -p "$ETC_DIR"; chmod 755 "$ETC_DIR"
if [ ! -s "$TOKEN_FILE" ]; then
  echo "DEMO_SHAPE_TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" > "$TOKEN_FILE"
  echo ">> Generated the traffic-shape token"
fi
chown root:root "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"     # systemd reads it as root

# 4. Production: publish shapes, and create new files without world access from now on
mkdir -p "/etc/systemd/system/$SERVICE.service.d"
cat > "/etc/systemd/system/$SERVICE.service.d/demo.conf" <<EOF
# Added by deploy/demo-setup.sh
[Service]
EnvironmentFile=$TOKEN_FILE
UMask=0027
EOF

# 5. The demo service
cat > "/etc/systemd/system/$DEMO_SERVICE.service" <<EOF
[Unit]
Description=Network Inventory & Management Platform — public demo
After=network.target $SERVICE.service

[Service]
Type=simple
User=$DEMO_USER
Group=$DEMO_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE server.js
Environment=DEMO_MODE=1
Environment=HOST=127.0.0.1
Environment=PORT=$DEMO_PORT
Environment=DB_PATH=$DEMO_DIR/data.db
Environment=SAMPLER=off
Environment=IMAP=off
Environment=GMAIL=off
Environment=BILLING=off
Environment=AUTO_PUSH=off
Environment=BACKUPS=off
Environment=DEMO_SHAPE_URL=http://127.0.0.1:$PROD_PORT/internal/traffic-shape
EnvironmentFile=$TOKEN_FILE
Restart=on-failure
RestartSec=5

# Second wall, below the app: the kernel drops any packet to anything but localhost.
IPAddressDeny=any
IPAddressAllow=localhost
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
# It can write its own directory and nothing else.
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DEMO_DIR
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectControlGroups=true
UMask=0027
# A visitor cannot starve production.
MemoryMax=600M
CPUQuota=60%

[Install]
WantedBy=multi-user.target
EOF

# 6. Nightly reset: throw the demo database away and let it regenerate
cat > "/etc/systemd/system/$DEMO_SERVICE-reset.service" <<EOF
[Unit]
Description=Reset the public demo to fresh data

[Service]
Type=oneshot
ExecStart=/bin/systemctl stop $DEMO_SERVICE
ExecStart=/bin/sh -c 'rm -rf $DEMO_DIR/* $DEMO_DIR/.[!.]* 2>/dev/null; true'
ExecStart=/bin/systemctl start $DEMO_SERVICE
EOF
cat > "/etc/systemd/system/$DEMO_SERVICE-reset.timer" <<EOF
[Unit]
Description=Reset the public demo nightly

[Timer]
OnCalendar=*-*-* 04:00:00 America/Phoenix
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
echo ">> Restarting production to pick up the token…"
systemctl restart "$SERVICE"
systemctl enable --now "$DEMO_SERVICE" >/dev/null
systemctl restart "$DEMO_SERVICE"
systemctl enable --now "$DEMO_SERVICE-reset.timer" >/dev/null

# 7. nginx
if command -v nginx >/dev/null 2>&1; then
  echo ">> Configuring nginx for $DEMO_DOMAIN…"
  cat > /etc/nginx/sites-available/netinv-demo <<EOF
# Added by deploy/demo-setup.sh — the public demo
limit_req_zone \$binary_remote_addr zone=netinv_demo:10m rate=15r/s;
server {
    listen 80;
    server_name $DEMO_DOMAIN;
    client_max_body_size 8m;
    location /internal/ { return 404; }
    location / {
        limit_req zone=netinv_demo burst=60 nodelay;
        proxy_pass http://127.0.0.1:$DEMO_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        add_header X-Robots-Tag "noindex" always;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/netinv-demo /etc/nginx/sites-enabled/netinv-demo
  nginx -t && systemctl reload nginx
  if command -v certbot >/dev/null 2>&1; then
    if getent hosts "$DEMO_DOMAIN" >/dev/null 2>&1; then
      certbot --nginx -d "$DEMO_DOMAIN" --redirect --non-interactive --keep-until-expiring \
        || echo "!! certbot failed — check DNS for $DEMO_DOMAIN, then run: certbot --nginx -d $DEMO_DOMAIN --redirect"
    else
      echo "!! $DEMO_DOMAIN does not resolve yet. Add the DNS A record, then run: certbot --nginx -d $DEMO_DOMAIN --redirect"
    fi
  fi
else
  echo "!! nginx not installed — the demo is only on 127.0.0.1:$DEMO_PORT"
fi

# 8. Check
echo ">> Waiting for the demo to build its data (first start generates ~60 days of traffic)…"
ok=""
for i in $(seq 1 90); do
  if curl -fs "http://127.0.0.1:$DEMO_PORT/api/build" | grep -q '"demo"'; then ok=1; break; fi
  sleep 1
done
echo
if [ -n "$ok" ]; then
  echo "== Demo is up =="
  journalctl -u "$DEMO_SERVICE" -n 20 --no-pager | grep -E 'Demo|running' | sed 's/^/   /' || true
  echo
  echo "   https://$DEMO_DOMAIN   sign in: demo@example.com / demo"
  echo "   Resets nightly at 04:00 (Phoenix). Reset now:  sudo systemctl start $DEMO_SERVICE-reset"
else
  echo "!! The demo did not come up. Recent log:" >&2
  journalctl -u "$DEMO_SERVICE" -n 30 --no-pager >&2 || true
  exit 1
fi
