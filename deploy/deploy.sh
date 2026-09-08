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
#
# Three things here were learned the hard way, when this filled a 9.8 GB volume and left the
# service stopped:
#
#   * Prune BEFORE writing the new backup, not after. Pruning afterwards means that once the disk
#     is full the copy fails, `set -e` exits, and the cleanup never runs again — every retry fails
#     identically. The janitor was locked behind the door it was meant to open.
#   * Keep far fewer copies. "Keep 14" was set when the database was a few megabytes; at 700 MB
#     that policy needs 9.8 GB, which was the entire volume.
#   * Refuse early if there is not enough room, rather than stopping the service and then failing.
BAK_DIR="$(dirname "$DB_PATH")/deploy-backups"
KEEP="${KEEP_BACKUPS:-3}"
mkdir -p "$BAK_DIR"
BAK_FILE="$BAK_DIR/data-$(date +%Y%m%d-%H%M%S).db"

if [ -f "$DB_PATH" ]; then
  # Drop anything beyond the retention count first, and any zero-length or partial file left by a
  # previous failure — those are never useful and are exactly what a full disk produces.
  find "$BAK_DIR" -maxdepth 1 -name 'data-*.db' -size 0 -delete 2>/dev/null || true
  ls -1t "$BAK_DIR"/data-*.db 2>/dev/null | tail -n +"$KEEP" | xargs -r rm --

  DB_KB=$(du -k "$DB_PATH" | cut -f1)
  FREE_KB=$(df -Pk "$BAK_DIR" | awk 'NR==2{print $4}')
  # 20% headroom: the WAL and the copy both need room, and filling a volume to the last byte is
  # how the database itself ends up unable to write.
  NEED_KB=$(( DB_KB * 12 / 10 ))
  if [ "$FREE_KB" -lt "$NEED_KB" ]; then
    echo "!! Not enough room to back up the database before deploying." >&2
    echo "   Database $(( DB_KB / 1024 )) MB, need ~$(( NEED_KB / 1024 )) MB, free $(( FREE_KB / 1024 )) MB on $(dirname "$BAK_DIR")." >&2
    echo "   Free some space, or run with KEEP_BACKUPS=1 to prune harder:" >&2
    echo "     ls -1t $BAK_DIR/data-*.db | tail -n +2 | xargs -r rm --" >&2
    echo "   Nothing was changed and the service was not stopped." >&2
    exit 1
  fi

  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" ".backup '$BAK_FILE'"      # safe while the app is running (WAL)
  else
    # No sqlite3: the copy is only consistent with the app stopped. Guarantee it starts again even
    # if the copy fails — otherwise a failed deploy becomes an outage, which is what happened.
    trap 'systemctl start "$SERVICE" >/dev/null 2>&1 || true' EXIT
    systemctl stop "$SERVICE"
    cp "$DB_PATH" "$BAK_FILE"
    systemctl start "$SERVICE"
    trap - EXIT
    echo ">> (install sqlite3 to back up without stopping the service: apt-get install -y sqlite3)"
  fi
  echo ">> DB backed up to $BAK_FILE ($(du -h "$BAK_FILE" | cut -f1)), keeping $KEEP"
else
  echo ">> No database at $DB_PATH yet — skipping backup."
fi

# 2. Pull the new code (remember where we were for rollback)
cd "$APP_DIR"
OLD_SHA="$(git rev-parse HEAD)"
git pull --ff-only
NEW_SHA="$(git rev-parse HEAD)"
if [ "$OLD_SHA" = "$NEW_SHA" ]; then echo ">> Already up to date ($NEW_SHA)."; fi

# 3. Ownership FIRST — the pull above ran as root, so package.json/package-lock.json and any
#    newly added files are root-owned. npm install runs as $RUN_USER and needs to rewrite the
#    lockfile, so chowning after the install (as this used to) fails with EACCES.
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR" "$(dirname "$DB_PATH")"

# 4. Dependencies (lockfile-pinned, production only)
sudo -u "$RUN_USER" bash -c "cd '$APP_DIR' && npm install --omit=dev --no-audit --no-fund"

# 4b. Re-assert ownership in case npm created root-owned cache/artifacts
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"

# 5. Restart
systemctl restart "$SERVICE"

# 6. Health check. Allow a generous window: a release that adds a column to a large table has to
#    backfill it before the app listens. Backfilling bounding boxes for a statewide fiber import
#    (~8k routes) takes ~11s, and a 15s budget was close enough to that to fail a healthy deploy.
echo ">> Health check (up to 90s — a schema migration can delay first response)…"
ok=""
for i in $(seq 1 90); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)"
  if [ "$code" = "200" ]; then ok=1; break; fi
  if [ "$i" = "15" ]; then echo "   still starting (migration in progress?) — continuing to wait…"; fi
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
