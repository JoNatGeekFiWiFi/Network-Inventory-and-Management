#!/usr/bin/env bash
#
# Feature check against the real routers (MikroTik + OpenWrt). READ-ONLY unless --live-suspend.
#
#   sudo bash /opt/netinv/tools/device-check.sh                     # every managed router
#   sudo bash /opt/netinv/tools/device-check.sh --device 12         # one router, by id or name
#   sudo bash /opt/netinv/tools/device-check.sh --live-suspend 12 --yes   # really suspend one for ~20 s
#
# Runs as the service user, with the service's database path, so it sees exactly what the app sees.
set -u
APP_DIR="${APP_DIR:-/opt/netinv}"
SERVICE="${SERVICE:-netinv}"
getenv() { systemctl show "$SERVICE" -p Environment --value 2>/dev/null | tr ' ' '\n' | grep "^$1=" | head -1 | cut -d= -f2-; }
DB_PATH="$(getenv DB_PATH)"; DB_PATH="${DB_PATH:-$APP_DIR/data.db}"
RUN_USER="$(systemctl show "$SERVICE" -p User --value 2>/dev/null)"; RUN_USER="${RUN_USER:-netinv}"
cd "$APP_DIR" || exit 1
exec sudo -u "$RUN_USER" env DB_PATH="$DB_PATH" CAPTIVE_PORT="${CAPTIVE_PORT:-3080}" "$(command -v node)" --no-warnings tools/device-check.mjs "$@"
