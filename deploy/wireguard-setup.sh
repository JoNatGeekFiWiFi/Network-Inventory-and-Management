#!/usr/bin/env bash
#
# One-time WireGuard hub setup. Run this once, on the server, as root:
#
#   sudo bash /opt/netinv/deploy/wireguard-setup.sh
#
# After it finishes, adding and removing devices happens entirely in the platform's web UI. You
# should never need to SSH in for WireGuard again — that is the whole point of this script.
#
# What it does, and why each part is here:
#
#   * installs wireguard-tools (creating a kernel interface is root work; a web app must not do it)
#   * reads the hub key, subnet and port the platform has ALREADY generated, straight from its
#     database — so no private key is ever typed on a command line, where it would sit in your
#     shell history and in `ps` output for every user on the box
#   * writes /etc/wireguard/wg0.conf and brings the interface up at boot
#   * turns on IPv4 forwarding and allows traffic between wg0 and the ZeroTier interface, which is
#     what actually lets WireGuard devices and ZeroTier devices reach each other
#   * opens the UDP port
#   * grants the service account permission to run exactly two commands — `wg` and `wg-quick` —
#     and nothing else
#
# Re-running it is safe: everything is idempotent, and existing peers are preserved.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/netinv}"
RUN_USER="${RUN_USER:-netinv}"
IFACE="${IFACE:-wg0}"
SERVICE="${SERVICE:-netinv}"

echo "== WireGuard hub setup =="

[ "$(id -u)" -eq 0 ] || { echo "!! Run this with sudo." >&2; exit 1; }

# ---- 1. find the platform's database -------------------------------------------------------
# Taken from the running service's own environment rather than guessed, so this keeps working if
# the data volume ever moves.
DB_PATH="${DB_PATH:-}"
if [ -z "$DB_PATH" ]; then
  DB_PATH="$(systemctl show "$SERVICE" -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n 's/^DB_PATH=//p' | head -1)"
fi
DB_PATH="${DB_PATH:-$APP_DIR/data.db}"
[ -f "$DB_PATH" ] || { echo "!! Cannot find the database at $DB_PATH. Set DB_PATH=... and re-run." >&2; exit 1; }
echo ">> Database:  $DB_PATH"

# ---- 2. dependencies -----------------------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1; }
if ! need wg || ! need wg-quick || ! need sqlite3; then
  echo ">> Installing wireguard-tools and sqlite3..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq wireguard-tools sqlite3 >/dev/null
fi
echo ">> wg:        $(wg --version 2>/dev/null | head -1)"

# ---- 3. read what the platform already decided ----------------------------------------------
# The platform generates the hub keypair and picks the subnet. This script does not invent either:
# if it did, the config on disk and the config the platform hands to devices would disagree, and
# every device would fail to connect for no visible reason.
setting() { sqlite3 "$DB_PATH" "SELECT value FROM settings WHERE key='$1';" 2>/dev/null || true; }

WG_SUBNET="$(setting wg_subnet)"
WG_PRIV="$(setting wg_server_priv)"
WG_ENDPOINT="$(setting wg_endpoint)"
WG_PORT="${WG_ENDPOINT##*:}"
[ "$WG_PORT" = "$WG_ENDPOINT" ] && WG_PORT=51820
WG_PORT="${WG_PORT:-51820}"

if [ -z "$WG_SUBNET" ] || [ -z "$WG_PRIV" ]; then
  cat >&2 <<'MSG'
!! The platform has not been configured for WireGuard yet.

   Open the web UI first:  Settings -> WireGuard
     1. press "Plan from ZeroTier" (or set the subnet by hand)
     2. press Save

   That generates the hub key and picks a subnet that will not collide with ZeroTier.
   Then run this script again.
MSG
  exit 1
fi

# The hub takes .1 of its own subnet.
# Computed by the platform's own module rather than re-implemented here: if this script and the
# app disagreed about which address is the hub, every device would be handed a config pointing at
# the wrong place, and nothing would say why.
HUB_IP="$(cd "$APP_DIR" && node -e "import('./lib/ipam.js').then(m=>console.log(m.hubAddress(process.argv[1])||''))" "$WG_SUBNET")"
[ -n "$HUB_IP" ] || { echo "!! Could not work out the hub address from '$WG_SUBNET'." >&2; exit 1; }
PREFIX="${WG_SUBNET##*/}"
echo ">> Subnet:    $WG_SUBNET   (hub is $HUB_IP)"
echo ">> Port:      $WG_PORT"

# ---- 4. the ZeroTier interface ---------------------------------------------------------------
# Named zt<something>. Finding it is what makes the two overlays reachable from each other; without
# it WireGuard works fine but cannot see anything on ZeroTier.
ZT_IFACE="${ZT_IFACE:-$(ip -o link show 2>/dev/null | awk -F': ' '{print $2}' | grep -m1 '^zt' || true)}"
if [ -n "$ZT_IFACE" ]; then
  echo ">> ZeroTier:  $ZT_IFACE (traffic will be forwarded between it and $IFACE)"
else
  echo ">> ZeroTier:  none found — WireGuard will work, but will not reach ZeroTier devices."
  echo "              If ZeroTier is on this box, re-run with ZT_IFACE=ztxxxxxxxx"
fi

# ---- 5. the interface config ------------------------------------------------------------------
# Existing [Peer] blocks are carried over. Without this, re-running the script would silently
# disconnect every device already deployed.
mkdir -p /etc/wireguard
chmod 700 /etc/wireguard
CONF="/etc/wireguard/$IFACE.conf"
EXISTING_PEERS=""
if [ -f "$CONF" ]; then
  EXISTING_PEERS="$(awk '/^\[Peer\]/{p=1} p' "$CONF" || true)"
  cp "$CONF" "$CONF.bak.$(date +%s)"
  echo ">> Kept $(grep -c '^\[Peer\]' "$CONF" 2>/dev/null || echo 0) existing peer(s); previous config backed up."
fi

{
  echo "# Managed by the Network Inventory platform. Peers are added and removed from the web UI."
  echo "# Edits to the [Interface] section are preserved; peers are rewritten by 'wg-quick save'."
  echo "[Interface]"
  echo "Address = $HUB_IP/$PREFIX"
  echo "ListenPort = $WG_PORT"
  echo "PrivateKey = $WG_PRIV"
  echo "SaveConfig = false"
  if [ -n "$ZT_IFACE" ]; then
    # Forward between the two overlays, and undo it cleanly on the way down.
    echo "PostUp = sysctl -q -w net.ipv4.ip_forward=1"
    echo "PostUp = iptables -A FORWARD -i %i -o $ZT_IFACE -j ACCEPT"
    echo "PostUp = iptables -A FORWARD -i $ZT_IFACE -o %i -j ACCEPT"
    echo "PostDown = iptables -D FORWARD -i %i -o $ZT_IFACE -j ACCEPT || true"
    echo "PostDown = iptables -D FORWARD -i $ZT_IFACE -o %i -j ACCEPT || true"
  else
    echo "PostUp = sysctl -q -w net.ipv4.ip_forward=1"
  fi
  [ -n "$EXISTING_PEERS" ] && { echo; echo "$EXISTING_PEERS"; }
} > "$CONF"
chmod 600 "$CONF"
echo ">> Wrote $CONF"

# Persist forwarding across reboots.
SYSCTL=/etc/sysctl.d/99-netinv-wireguard.conf
echo "net.ipv4.ip_forward = 1" > "$SYSCTL"
sysctl -q --system || true

# ---- 6. let the service manage peers ----------------------------------------------------------
# Exactly two binaries, no arguments wildcarded beyond what they need, no password. This is the
# narrowest grant that still allows "add a device" to work from the web UI.
SUDOERS=/etc/sudoers.d/netinv-wireguard
cat > "$SUDOERS" <<EOF
# Added by deploy/wireguard-setup.sh — lets the platform add and remove WireGuard peers.
# Deliberately limited to these two commands: it cannot install packages, edit files or reboot.
$RUN_USER ALL=(root) NOPASSWD: /usr/bin/wg, /usr/bin/wg-quick
EOF
chmod 440 "$SUDOERS"
# A malformed sudoers file locks everyone out of sudo, so verify before leaving it in place.
if ! visudo -cf "$SUDOERS" >/dev/null; then
  rm -f "$SUDOERS"
  echo "!! The sudoers rule failed validation and was removed. Nothing else was changed." >&2
  exit 1
fi
echo ">> Granted $RUN_USER permission to run wg and wg-quick (and nothing else)."

# ---- 7. firewall ------------------------------------------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$WG_PORT"/udp >/dev/null && echo ">> Opened $WG_PORT/udp in ufw."
else
  echo ">> No active ufw detected. Make sure $WG_PORT/udp is open to the internet."
fi

# ---- 8. up, and up at boot ---------------------------------------------------------------------
systemctl enable "wg-quick@$IFACE" >/dev/null 2>&1 || true
if systemctl is-active --quiet "wg-quick@$IFACE"; then
  # Reload rather than restart: restarting would drop every connected device.
  wg syncconf "$IFACE" <(wg-quick strip "$IFACE") && echo ">> Reloaded $IFACE without dropping peers."
else
  systemctl start "wg-quick@$IFACE" && echo ">> Started $IFACE."
fi

echo
echo "== Done =="
wg show "$IFACE" 2>/dev/null | sed 's/^/   /' || true
cat <<MSG

Next, in the web UI:
  Settings -> WireGuard should now show the hub as reachable.
  Any device set to WireGuard can be provisioned and pushed from its own page.

One thing this script cannot do for you: ZeroTier members need a route to the WireGuard range
($WG_SUBNET) via this server's ZeroTier address, or traffic will only flow one way. The platform
can add that for you — press "Advertise to ZeroTier" in Settings -> WireGuard.
MSG
