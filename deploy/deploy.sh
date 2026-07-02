#!/usr/bin/env bash
#
# Update the Network Inventory & Management Platform on the VPS.
# Run ON THE SERVER as root:
#
#   sudo bash /opt/netinv/deploy/deploy.sh
#
# What it does, in order:
#   1. Back up the SQLite database (kept in <db dir>/deploy-backups, last 14)
#   2. git pull
#   3. npm install --omit=dev
#   4. chown everything back to the service user
#   5. Restart the systemd service
#   6. Health-check the app; on failure, print exact rollback commands
#
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Please run with sudo/root." >&2; exit 1; fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE="${SERVICE:-netinv}"
RUN_USER="${RUN_USER:-netinv}"

# Read DB_PATH + PORT from the systemd unit so we back up the *real* database
unit_env() { systemctl show "$SERVICE" -p Environment --value 2>/dev/null | tr ' ' '\n' | grep "^$1=" | head -1 | cut -d= -f2-; }
DB_PATH="${DB_PATH:-$(unit_env DB_PATH)}"; DB_PATH="${DB_PATH:-$APP_DIR/data.db}"
PORT="${PORT:-$(unit_env PORT)}"; PORT="${PORT:-3000}"

echo ">> App dir:  $APP_DIR"
echo ">> Service:  $SERVICE (user $RUN_USER, port $PORT)"
echo ">> Database: $DB_PATH"

# 1. Backup the database before touching anything
BAK_DIR="$(dirname "$DB_PATH")/deploy-backups"
mkdir -p "$BAK_DIR"
BAK_FILE="$BAK_DIR/data-$(date +%Y%m%d-%H%M%S).db"
if [ -f "$DB_PATH" ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" ".backup '$BAK_FILE'"      # safe while the app is running (WAL)
  else
    systemctl stop "$SERVICE"                      # no sqlite3: stop first so the copy is consistent
    cp "$DB_PATH" "$BAK_FILE"
  fi
  echo ">> DB backed up to $BAK_FILE"
  ls -1t "$BAK_DIR"/data-*.db 2>/dev/null | tail -n +15 | xargs -r rm --   # keep the newest 14
else
  echo ">> No database at $DB_PATH yet — skipping backup."
fi

# 2. Pull the new code (remember where we were for rollback)
cd "$APP_DIR"
OLD_SHA="$(git rev-parse HEAD)"
git pull --ff-only
NEW_SHA="$(git rev-parse HEAD)"
if [ "$OLD_SHA" = "$NEW_SHA" ]; then echo ">> Already up to date ($NEW_SHA)."; fi

# 3. Dependencies (lockfile-pinned, production only)
sudo -u "$RUN_USER" bash -c "cd '$APP_DIR' && npm install --omit=dev --no-audit --no-fund"

# 4. Ownership (git pull as root leaves root-owned files behind)
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR" "$(dirname "$DB_PATH")"

# 5. Restart
systemctl restart "$SERVICE"

# 6. Health check: the app is up if / answers 200 (login page) within ~15s
echo ">> Health check…"
ok=""
for i in $(seq 1 15); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)"
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep 1
done

if [ -n "$ok" ]; then
  echo
  echo "== Deploy OK: $(git log -1 --format='%h %s') =="
else
  echo
  echo "!! Deploy FAILED health check (no 200 from http://127.0.0.1:$PORT/)." >&2
  echo "!! Recent service log:" >&2
  journalctl -u "$SERVICE" -n 25 --no-pager >&2 || true
  echo >&2
  echo "!! To roll back:" >&2
  echo "     cd $APP_DIR && git reset --hard $OLD_SHA" >&2
  echo "     sudo -u $RUN_USER bash -c 'cd $APP_DIR && npm install --omit=dev'" >&2
  [ -f "${BAK_FILE:-}" ] && echo "     cp '$BAK_FILE' '$DB_PATH'   # only if the new code migrated the DB" >&2
  echo "     chown -R $RUN_USER:$RUN_USER $APP_DIR && systemctl restart $SERVICE" >&2
  exit 1
fi
