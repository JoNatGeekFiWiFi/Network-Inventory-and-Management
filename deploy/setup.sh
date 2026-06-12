#!/usr/bin/env bash
#
# One-shot server setup for the Network Inventory & Management Platform.
# Run ON THE SERVER, from the cloned repo, as root:
#
#   sudo bash deploy/setup.sh
#
# Optional overrides:
#   sudo DOMAIN=netinv.example.com DB_PATH=/mnt/netinv-data/data.db PORT=3000 bash deploy/setup.sh
#
# It installs Node (if needed), creates the service user, installs deps,
# writes + starts the systemd service, and configures nginx as a reverse proxy.
#
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Please run with sudo/root." >&2; exit 1; fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
RUN_USER="${RUN_USER:-netinv}"
PORT="${PORT:-3000}"
DB_PATH="${DB_PATH:-$APP_DIR/data.db}"
DOMAIN="${DOMAIN:-_}"

echo ">> App dir:      $APP_DIR"
echo ">> Service user: $RUN_USER"
echo ">> Port:         $PORT"
echo ">> Database:     $DB_PATH"
echo ">> Domain:       $DOMAIN"
echo

node_ok() { command -v node >/dev/null 2>&1 && node -e 'const[a,b]=process.versions.node.split(".").map(Number);process.exit((a>22||(a==22&&b>=5))?0:1)' 2>/dev/null; }

# 1. Node >= 22.5
if node_ok; then
  echo ">> Node $(node --version) already present."
else
  echo ">> Installing Node…"
  apt-get update -y
  apt-get install -y nodejs npm || true
  if ! node_ok; then
    echo ">> Distro Node missing/too old; using NodeSource…"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
fi
node_ok || { echo "Could not get Node >= 22.5. Install it manually (see README) and re-run." >&2; exit 1; }
echo ">> Node $(node --version)"

# 2. Service user
id -u "$RUN_USER" >/dev/null 2>&1 || adduser --system --group --home "$APP_DIR" "$RUN_USER"

# 3. Data dir + ownership
mkdir -p "$(dirname "$DB_PATH")"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR" "$(dirname "$DB_PATH")"

# 4. Dependencies
echo ">> Installing dependencies…"
sudo -u "$RUN_USER" bash -c "cd '$APP_DIR' && npm install --omit=dev"

# 5. systemd service
echo ">> Writing systemd unit…"
cat > /etc/systemd/system/netinv.service <<EOF
[Unit]
Description=Network Inventory & Management Platform
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server.js
Environment=PORT=$PORT
Environment=DB_PATH=$DB_PATH
Restart=on-failure
User=$RUN_USER
Group=$RUN_USER

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now netinv

# 6. nginx reverse proxy (if nginx is installed)
if command -v nginx >/dev/null 2>&1; then
  echo ">> Configuring nginx…"
  cat > /etc/nginx/sites-available/netinv <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/netinv /etc/nginx/sites-enabled/netinv
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
else
  echo ">> nginx not installed; the app is reachable directly on port $PORT."
fi

echo
echo "=============================================================="
echo " Setup complete."
systemctl --no-pager --full status netinv | head -n 5 || true
echo
echo " Open:  http://<server-ip>/        (or http://$DOMAIN/ once DNS points here)"
echo " TLS:   sudo certbot --nginx       (after DNS is set)"
echo " Login: admin@geekitek.test / admin123  — CHANGE THIS, then create real users."
echo "=============================================================="
