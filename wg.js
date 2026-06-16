// WireGuard helpers: keypair generation, IPv4 math, IP allocation, config rendering.
// Uses Node's built-in crypto (X25519) — no wireguard-tools needed for key generation.
import { generateKeyPairSync } from 'node:crypto';

// Generate a WireGuard-compatible keypair (base64 of the raw 32-byte X25519 keys).
export function wgKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  return { privateKey: priv, publicKey: pub };
}

export const ipToInt = (ip) => ip.split('.').reduce((a, o) => ((a << 8) + (+o)) >>> 0, 0);
export const intToIp = (n) => [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.');

export function parseCidr(cidr) {
  const [ip, bitsStr] = String(cidr).split('/');
  const mask = bitsStr === undefined ? 24 : parseInt(bitsStr, 10);
  const maskBits = mask === 0 ? 0 : (0xffffffff << (32 - mask)) >>> 0;
  const base = (ipToInt(ip) & maskBits) >>> 0;
  return { base, mask };
}

// Next free host IP in subnet, skipping reserved low addresses (default: network + .1 server) and given taken IPs.
export function nextFreeIp(subnetCidr, taken = [], reserve = 1) {
  const { base, mask } = parseCidr(subnetCidr);
  const size = 2 ** (32 - mask);
  const used = new Set((taken || []).filter(Boolean).map(ipToInt));
  const limit = Math.min(size - 1, 1 + reserve + 65535); // cap scan
  for (let i = 1 + reserve; i < limit; i++) {
    const cand = (base + i) >>> 0;
    if (!used.has(cand)) return intToIp(cand);
  }
  return null;
}

// The server/hub's own address in the subnet (.1 by convention)
export function serverIp(subnetCidr) {
  const { base } = parseCidr(subnetCidr);
  return intToIp((base + 1) >>> 0);
}

// wg-quick config for a device (peer side)
export function deviceConfig({ privateKey, address, dns, serverPub, endpoint, allowed }) {
  return `[Interface]
PrivateKey = ${privateKey}
Address = ${address}/32${dns ? `\nDNS = ${dns}` : ''}

[Peer]
PublicKey = ${serverPub}
Endpoint = ${endpoint}
AllowedIPs = ${allowed}
PersistentKeepalive = 25
`;
}

// Server-side [Peer] stanza to add to the hub for this device
export function serverPeerStanza({ name, publicKey, address }) {
  return `# ${name}
[Peer]
PublicKey = ${publicKey}
AllowedIPs = ${address}/32
`;
}
