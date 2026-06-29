# NetInv provisioning node (Netinstall bench)

A small Linux host that Netinstalls MikroTik routers with the platform's default config.
Each router then **self-enrolls into inventory by serial number** on first boot.

## What you need

| Role | Hardware | Notes |
|------|----------|-------|
| Brains | Raspberry Pi 4/5 or any mini-PC (Linux) | Runs `netinstall-cli`. Needs a dedicated NIC for the bench. |
| Power + L2 | MikroTik **netPower 16P** | PoE power + switch fabric for the routers being flashed. |
| Uplink | Any internet source | So flashed routers can phone home (HTTPS to the platform). |

### Power note (important)
The netPower 16P has **no voltage converter — PoE-out voltage = the PSU you feed it.**
- Feed **48 V** → ports do 802.3af/at (negotiated, safe) → use for modern gear (hAP ax2, etc.).
- Feed **24 V** → 24 V passive → only for legacy 24 V gear.
- **Do not mix** 24 V-passive-only and 48 V gear on one unit — passive 48 V can damage a 24 V-only device.

## Wiring

```
[Pi NIC: eth1, static 192.168.88.2] ──┐
                                      ├── netPower 16P (L2, fed 48V) ── PoE ports ── routers to flash
[internet uplink] ── Pi NIC: eth0 ────┘   (Pi NATs the bench segment so routers reach the platform)
```

- The bench segment must have **no other DHCP server** during Netinstall (Netinstall uses BOOTP).
- The script stops `dnsmasq` during the flash and starts it after, so the router gets DHCP+internet to phone home.

## One-time setup on the Pi

```bash
# 1. Install netinstall-cli (MikroTik Linux Netinstall) and tools
sudo apt update && sudo apt install -y dnsmasq curl python3
#   download netinstall-cli for your arch from mikrotik.com → /usr/local/bin/netinstall-cli, chmod +x

# 2. dnsmasq for the bench segment (DHCP + DNS); NAT via your distro's firewall/iptables
#    /etc/dnsmasq.d/bench.conf:
#      interface=eth1
#      dhcp-range=192.168.88.50,192.168.88.200,12h
#    enable IP forwarding + NAT eth1 -> eth0:
sudo sysctl -w net.ipv4.ip_forward=1
sudo iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE

# 3. Configure the node
sudo cp netinv-node.conf.example /etc/netinv-node.conf
sudo nano /etc/netinv-node.conf      # set PLATFORM, NODE_TOKEN, IFACE, ARCH
sudo install -m755 provision-node.sh /usr/local/bin/provision-node
```

Create the **NODE_TOKEN** in the platform: **Settings → Provisioning nodes → Add node** (the token is shown once).
Upload the RouterOS base packages (e.g. `routeros-…-arm64.npk`, `wifi-qcom-…-arm64.npk`) under **Packages**, tagged with the matching **architecture** — the node pulls all packages for its `ARCH`.

## Provisioning a router

```bash
sudo provision-node once     # flash one unit
sudo provision-node loop     # flash units back-to-back
```

1. Connect the router to a PoE port, put it in **Etherboot** (hold reset while powering on until the LED pattern), and run the command.
2. The node downloads the packages + default config from the platform, runs Netinstall, then re-enables DHCP/NAT.
3. The router boots, applies the default config, **self-enrolls by serial** (appears in inventory as *In stock*), and restores its latest backup if one exists.

## Security
- `NODE_TOKEN` and the platform's provision token authorize package/config downloads and enrollment — keep them secret and use HTTPS.
- Auto-enroll only creates inventory records when **Settings → Provisioning → Allow auto-enroll** is on.
