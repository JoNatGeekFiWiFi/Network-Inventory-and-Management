#!/usr/bin/env bash
#
# Server health check — READ-ONLY. Changes nothing, restarts nothing, prints no secrets.
#
# Run on the server after a deploy and paste the output back:
#
#   sudo bash /opt/netinv/tools/server-check.sh | tee /tmp/netinv-check.txt
#
# What it deliberately does NOT print: settings values (SMTP/Stripe/Twilio keys, the Google service
# account key), passwords, tokens, customer names, or the contents of any record. Email addresses
# in log lines are masked. The database is opened read-only.
#
# Overrides: APP_DIR=/opt/netinv SERVICE=netinv DOMAIN=management.geekitek.com
set -u
APP_DIR="${APP_DIR:-/opt/netinv}"
SERVICE="${SERVICE:-netinv}"
DOMAIN="${DOMAIN:-management.geekitek.com}"

section() { printf '\n== %s ==\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
mask() { sed -E 's/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)/***@\1/g; s/(token|secret|password|key)=[^ &"]+/\1=***/Ig'; }

echo "netinv server check — $(date -u '+%Y-%m-%d %H:%M UTC') — host $(hostname)"

# ---- code ---------------------------------------------------------------------------------------
section "code"
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" || exit 1
  echo "running commit : $(git log -1 --format='%h %ad %s' --date=short)"
  git fetch -q origin 2>/dev/null && echo "vs GitHub      : $(git status -sb | head -1)" || echo "vs GitHub      : (could not fetch — check the deploy key)"
  changed=$(git status --porcelain --untracked-files=no | wc -l)
  echo "edited on server (tracked files): $changed"
  [ "$changed" -gt 0 ] && git status --porcelain --untracked-files=no | head -15
  [ -f forms/irs-fw9-2024-03.pdf ] && echo "W-9 form file  : present" || echo "W-9 form file  : MISSING (forms/irs-fw9-2024-03.pdf)"
else
  echo "no git checkout at $APP_DIR"
fi

# ---- runtime ------------------------------------------------------------------------------------
section "runtime"
have node && echo "node           : $(node -v)" || echo "node: NOT FOUND"
if have systemctl; then
  echo "service        : $(systemctl is-active "$SERVICE" 2>/dev/null) (enabled: $(systemctl is-enabled "$SERVICE" 2>/dev/null))"
  systemctl show "$SERVICE" -p ActiveEnterTimestamp -p NRestarts -p User 2>/dev/null | sed 's/^/                 /'
  ENVLINE=$(systemctl show "$SERVICE" -p Environment --value 2>/dev/null)
fi
ENVLINE="${ENVLINE:-}"
getenv() { printf '%s\n' "$ENVLINE" | tr ' ' '\n' | sed -n "s/^$1=//p" | head -1; }
DB_PATH="$(getenv DB_PATH)"; DB_PATH="${DB_PATH:-$APP_DIR/data.db}"
PORT="$(getenv PORT)"; PORT="${PORT:-3000}"
DATA_DIR="$(dirname "$DB_PATH")"
UPLOADS="$(getenv UPLOADS_DIR)"; UPLOADS="${UPLOADS:-$DATA_DIR/uploads}"
BACKUPS="$(getenv BACKUPS_DIR)"; BACKUPS="${BACKUPS:-$DATA_DIR/backups}"
# Only the names of variables, never their values — a unit file can carry secrets.
echo "unit env vars  : $(printf '%s\n' "$ENVLINE" | tr ' ' '\n' | cut -d= -f1 | grep -v '^$' | tr '\n' ' ')"
echo "database       : $DB_PATH"
echo "uploads        : $UPLOADS"
echo "backups        : $BACKUPS"

# ---- is it answering --------------------------------------------------------------------------------
section "responding"
if have curl; then
  echo "local  /api/build : $(curl -s -m 5 "http://127.0.0.1:$PORT/api/build" || echo 'NO ANSWER')"
  echo "public /api/build : $(curl -s -m 8 "https://$DOMAIN/api/build" || echo 'NO ANSWER')"
  # The signing page must be reachable without a login; /api/vendors must NOT be.
  echo "public /sign      : HTTP $(curl -s -o /dev/null -w '%{http_code}' -m 8 "https://$DOMAIN/sign")"
  echo "anon /api/vendors : HTTP $(curl -s -o /dev/null -w '%{http_code}' -m 8 "https://$DOMAIN/api/vendors") (expect 401)"
  echo "anon /sign preview: HTTP $(curl -s -o /dev/null -w '%{http_code}' -m 8 -X POST -H 'content-type: application/json' -d '{"token":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}' "https://$DOMAIN/api/sign/form-preview") (expect 404 = new build; 401 = old build)"
fi

# ---- errors -------------------------------------------------------------------------------------
section "log: last 24h errors and warnings (emails masked)"
if have journalctl; then
  journalctl -u "$SERVICE" --since "24 hours ago" --no-pager 2>/dev/null \
    | grep -iE '\[error\]|error|warn|failed|uncaught|EADDRINUSE' | grep -vE 'ExperimentalWarning|trace-warnings' | tail -40 | mask
  section "log: startup file moves (this boot)"
  journalctl -u "$SERVICE" -b --no-pager 2>/dev/null | grep -E 'Files:|Backups:|moved|running on' | tail -10 | mask
fi

# ---- database -------------------------------------------------------------------------------------
section "database (read-only)"
if [ -f "$DB_PATH" ] && have node; then
  ls -la "$DB_PATH"* 2>/dev/null | awk '{print "  " $1, $3, $4, $5, $NF}'
  DB_PATH="$DB_PATH" node --no-warnings --input-type=module - <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.DB_PATH, { readOnly: true });
const one = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch (e) { return { error: e.message }; } };
const cols = (t) => { try { return db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name); } catch { return []; } };
const ok = (c) => (c ? 'ok' : 'MISSING');
console.log('  integrity     :', (one('PRAGMA quick_check') || {}).quick_check);
console.log('  journal mode  :', (one('PRAGMA journal_mode') || {}).journal_mode);
// Migrations: the newest schema each recent feature needs.
for (const t of ['customers', 'sites', 'pops', 'accounts', 'devices', 'circuits', 'upstream_providers'])
  console.log(`  archive cols  : ${t.padEnd(18)} ${ok(cols(t).includes('archived_at'))}`);
for (const t of ['expenses', 'expense_recurring', 'vendor_contacts', 'vendor_messages', 'mailboxes', 'documents'])
  console.log(`  table         : ${t.padEnd(18)} ${ok(cols(t).length)}`);
console.log('  vendor_kind   :', ok(cols('upstream_providers').includes('vendor_kind')), ' w9 columns:', ok(cols('documents').includes('form_kind') && cols('upstream_providers').includes('w9_document_id')));
// Counts only — no names, no values.
const n = (sql) => { const r = one(sql); return r && r.error ? '?' : Object.values(r)[0]; };
console.log('  customers     :', n("SELECT COUNT(*) FROM customers WHERE archived_at IS NULL"), 'active,', n("SELECT COUNT(*) FROM customers WHERE archived_at IS NOT NULL"), 'deactivated,', n("SELECT COUNT(*) FROM customers WHERE status='Closed' AND archived_at IS NULL"), 'Closed-but-not-archived (should be 0)');
console.log('  sites / pops  :', n('SELECT COUNT(*) FROM sites'), '/', n('SELECT COUNT(*) FROM pops'), '  devices:', n('SELECT COUNT(*) FROM devices'));
console.log('  vendors       :', n("SELECT COUNT(*) FROM upstream_providers WHERE COALESCE(vendor_kind,'carrier')='carrier'"), 'carriers,', n("SELECT COUNT(*) FROM upstream_providers WHERE COALESCE(vendor_kind,'carrier')<>'carrier'"), 'other');
console.log('  expenses      :', n('SELECT COUNT(*) FROM expenses'), ' recurring bills:', n('SELECT COUNT(*) FROM expense_recurring WHERE active=1'), 'active');
console.log('  documents     :', JSON.stringify(Object.fromEntries((() => { try { return db.prepare('SELECT status, COUNT(*) n FROM documents GROUP BY status').all().map(r => [r.status, r.n]); } catch { return []; } })())));
console.log('  mailboxes     :', n('SELECT COUNT(*) FROM mailboxes WHERE enabled=1'), 'enabled;', n("SELECT COUNT(*) FROM mailboxes WHERE last_sync_error IS NOT NULL AND last_sync_error<>''"), 'with a sync error');
console.log('  flat uploads still referenced:', n("SELECT (SELECT COUNT(*) FROM note_attachments WHERE stored_name NOT LIKE '%/%') + (SELECT COUNT(*) FROM documents WHERE stored_name IS NOT NULL AND stored_name NOT LIKE '%/%') + (SELECT COUNT(*) FROM access_requests WHERE id_photo IS NOT NULL AND id_photo NOT LIKE '%/%')"), '(should be 0)');
console.log('  flat backups still referenced:', n("SELECT COUNT(*) FROM router_backups WHERE stored_name IS NOT NULL AND stored_name NOT LIKE '%/%'"), '(should be 0)');
// Settings that must be set for W-9s and signing links to be right — reports SET / not set only.
const set = (k) => { const r = one('SELECT value FROM settings WHERE key=?', k); return r && r.value ? 'set' : 'NOT SET'; };
const bub = (one("SELECT value FROM settings WHERE key='backup_upload_base'") || {}).value || '';
console.log('  router backup upload URL :', !bub ? 'not set' : (/:3000\b/.test(bub) ? 'set, points at port 3000 directly' : 'set, goes through nginx'), bub ? '(host: ' + (bub.match(/^\w+:\/\/([^/:]+)/) || [])[1] + ')' : '');
console.log('  settings      : company_name', set('company_name'), '| company_address', set('company_address'), '| inbound_secret', set('inbound_secret'), '| public_base_url', set('public_base_url'));
NODE
  # The seed accounts. The sign-in page used to print them with their passwords, so if any is still
  # active with its default password, anyone who ever loaded the page can sign in as it. Checked by
  # verifying the known default against the stored hash — the hash itself is never printed.
  APP_DIR="$APP_DIR" DB_PATH="$DB_PATH" node --no-warnings --input-type=module - <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const { verifyPassword } = await import(process.env.APP_DIR + '/hash.js');
const db = new DatabaseSync(process.env.DB_PATH, { readOnly: true });
const seeds = [['admin@geekitek.test', 'admin123'], ['noc@geekitek.test', 'noc123'], ['field@geekitek.test', 'field123'], ['support@geekitek.test', 'support123']];
let bad = 0;
for (const [email, pw] of seeds) {
  const u = db.prepare('SELECT active, password_hash, role FROM users WHERE lower(email)=?').get(email);
  let state = 'not present';
  if (u) {
    const dflt = (() => { try { return verifyPassword(pw, u.password_hash); } catch { return false; } })();
    state = !u.active ? 'deactivated' : dflt ? `ACTIVE WITH DEFAULT PASSWORD (${u.role}) — change or deactivate now` : 'active, password changed';
    if (u.active && dflt) bad++;
  }
  console.log('  seed account  :', email.padEnd(24), state);
}
if (!bad) console.log('  seed accounts : none usable with the published passwords');
NODE
else
  echo "database not found at $DB_PATH (or node missing)"
fi

# ---- files on disk --------------------------------------------------------------------------------
section "file layout"
for d in "$UPLOADS" "$BACKUPS"; do
  [ -d "$d" ] || { echo "$d: not found"; continue; }
  loose=$(find "$d" -maxdepth 1 -type f | wc -l)
  echo "$d"
  echo "  folders at top : $(find "$d" -mindepth 1 -maxdepth 1 -type d -printf '%f ' 2>/dev/null)"
  echo "  loose files    : $loose (should be 0 — everything belongs in a record's folder)"
  [ "$loose" -gt 0 ] && find "$d" -maxdepth 1 -type f -printf '    %f\n' | head -10
  echo "  size           : $(du -sh "$d" 2>/dev/null | cut -f1)"
done
echo "owner of data dir: $(stat -c '%U:%G' "$DATA_DIR" 2>/dev/null)   service user: $(systemctl show "$SERVICE" -p User --value 2>/dev/null)"
df -h "$DATA_DIR" 2>/dev/null | tail -1 | awk '{print "disk             : " $4 " free of " $2 " (" $5 " used)"}'

# ---- database backups -------------------------------------------------------------------------------
section "is the database itself backed up?"
found=0
for f in /etc/cron.d/* /etc/cron.daily/* /var/spool/cron/crontabs/*; do
  [ -f "$f" ] && grep -qiE 'data\.db|netinv|sqlite' "$f" 2>/dev/null && { echo "cron: $f"; found=1; }
done
have systemctl && systemctl list-timers --all --no-pager 2>/dev/null | grep -iE 'netinv|backup' | grep -v dpkg && found=1
DEPLOY_BAK="$DATA_DIR/deploy-backups"
[ -d "$DEPLOY_BAK" ] && echo "deploy-time backups: $(ls "$DEPLOY_BAK" 2>/dev/null | wc -l) in $DEPLOY_BAK (same disk as the database — they do not survive losing it)"
[ "$found" -eq 0 ] && echo "no SCHEDULED backup of $DB_PATH or the uploads folder, and nothing copied off this server"

# ---- web / tls / firewall ---------------------------------------------------------------------------
section "nginx and TLS"
have nginx && nginx -t 2>&1 | tail -1
if have openssl; then
  echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | sed 's/^/certificate expires: /'
fi
section "firewall and listening ports"
have ufw && ufw status 2>/dev/null | head -12
have ss && ss -tlnp 2>/dev/null | awk 'NR==1 || /LISTEN/ {print "  " $4, $6}' | sed -E 's/users:\(\("([^"]+)".*/\1/' | head -20
echo "  -- UDP --"
have ss && ss -ulnp 2>/dev/null | awk 'NR>1 {print "  " $4, $6}' | sed -E 's/users:\(\("([^"]+)".*/\1/' | head -20
echo "  -- interfaces --"
have ip && ip -br addr 2>/dev/null | awk '{print "  " $1, $3}' | head -12

echo; echo "done — nothing was changed."
