#!/usr/bin/env bash
# NetInv provisioning-node agent
# Netinstalls a MikroTik router with the platform's generic default config, then the
# router self-enrolls into inventory by serial on first boot.
#
# Requires: mikrotik netinstall-cli, curl, and (for phone-home) dnsmasq for DHCP+NAT.
# Run as root (netinstall needs raw sockets).  Edit /etc/netinv-node.conf first.

set -euo pipefail

CONF="${NETINV_CONF:-/etc/netinv-node.conf}"
[ -f "$CONF" ] && . "$CONF"

: "${PLATFORM:?set PLATFORM=https://management.geekitek.com in $CONF}"
: "${NODE_TOKEN:?set NODE_TOKEN=node_... in $CONF}"
: "${IFACE:?set IFACE=eth1 (the NIC facing the bench switch) in $CONF}"
: "${ARCH:?set ARCH=arm64 (router architecture, e.g. arm, arm64, mipsbe) in $CONF}"
STATIC_IP="${STATIC_IP:-192.168.88.2/24}"           # node IP on the bench segment
NETINSTALL="${NETINSTALL:-netinstall-cli}"
WORK="${WORK:-/var/lib/netinv-node}"
mkdir -p "$WORK"

log(){ printf '\033[36m[netinv]\033[0m %s\n' "$*"; }
die(){ printf '\033[31m[netinv] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

dnsmasq_off(){ systemctl stop dnsmasq 2>/dev/null || true; }
dnsmasq_on(){ systemctl start dnsmasq 2>/dev/null || true; }

fetch_artifacts(){
  log "Fetching package list for arch=$ARCH …"
  local list; list="$(curl -fsS "$PLATFORM/node/packages?arch=$ARCH&token=$NODE_TOKEN")" \
    || die "could not reach platform (check PLATFORM/NODE_TOKEN)"
  # extract each {url,filename}
  PKGS=()
  while IFS=$'\t' read -r url fn; do
    [ -z "$url" ] && continue
    log "  downloading $fn"
    curl -fsS "$url" -o "$WORK/$fn" || die "download failed: $fn"
    PKGS+=("$WORK/$fn")
  done < <(printf '%s' "$list" | python3 -c '
import sys,json
for p in json.load(sys.stdin): print(p["url"]+"\t"+p["filename"])')
  [ "${#PKGS[@]}" -gt 0 ] || die "no packages tagged arch=$ARCH in the platform library — upload them under Packages"
  log "Fetching generic default config …"
  curl -fsS "$PLATFORM/node/default-config?token=$NODE_TOKEN" -o "$WORK/default.rsc" \
    || die "could not fetch default config"
}

provision_one(){
  fetch_artifacts
  log "Setting static IP $STATIC_IP on $IFACE …"
  ip addr flush dev "$IFACE" 2>/dev/null || true
  ip addr add "$STATIC_IP" dev "$IFACE" 2>/dev/null || true
  ip link set "$IFACE" up

  log "Stopping local DHCP (dnsmasq) during netinstall …"; dnsmasq_off
  log "Put the router in Etherboot mode now (hold reset while powering on)…"
  log "Running netinstall on $IFACE — this waits for the device…"
  # -r reformat, -s apply config script, then the packages
  sudo "$NETINSTALL" -r -s "$WORK/default.rsc" -i "$IFACE" "${PKGS[@]}" || die "netinstall failed"

  log "Netinstall done. Re-enabling DHCP+NAT so the router can phone home…"; dnsmasq_on
  log "The router will boot, self-enroll by serial, and appear in inventory (status 'In stock')."
}

case "${1:-once}" in
  once)  provision_one ;;
  loop)  while true; do provision_one; read -rp $'\nProvision another? [Enter]=yes  Ctrl-C=stop '; done ;;
  *)     echo "usage: $0 [once|loop]"; exit 1 ;;
esac
