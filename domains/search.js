// Unified search + geographic lookup.
//
// One box that answers three different questions, because a tech doesn't want to think about
// which one they're asking:
//   "F17L-0044605"          → an asset, by name / CID / serial / MAC / account number
//   "33.4484, -112.0740"    → a place, by coordinate (four notations, see lib/geo.js)
//   "1215 E Pennsylvania"   → a place, by address (geocoded through the existing /api/geocode proxy)
//
// Results are grouped by entity type and capped per group, so one prolific match type can't crowd
// out the others. Nothing here returns a credential column — search hits carry identity and
// location only, and the caller follows the href to a detail endpoint that does its own gating.
import { parseCoords, haversineM, distanceToLineM, degBox } from '../lib/geo.js';

const CAP = 6;              // results per group
const NEAR_DEFAULT = 500;   // metres
const NEAR_MAX = 20000;
// Structures imported from IQGeo inherit their position from the end of a span, so every shelf,
// card and splice tray in one building lands on the identical coordinate. Without collapsing them
// a search inside a POP returns hundreds of rows all reading "0 m". Anything within this many
// metres of another structure is treated as the same physical location.
const COLOCATE_M = 8;
// Closest N of each entity type in a proximity result, so one dense type can't hide the rest.
const NEAR_PER_TYPE = 8;

const t = s => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());

// LIKE with the wildcards escaped, so a customer called "100%" doesn't match everything.
const like = q => '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
const pre = q => q.replace(/[\\%_]/g, c => '\\' + c) + '%';

export default function registerSearch(app, ctx) {
  const { db, isPriv, geocode } = ctx;

  // Rank: exact match first, then prefix, then anywhere. Keeps "F21T" from burying "F21T-0119142".
  const RANK = (col) => `CASE WHEN LOWER(${col})=LOWER(:exact) THEN 0 WHEN ${col} LIKE :pre ESCAPE '\\' THEN 1 ELSE 2 END`;

  /**
   * Each group is one query. Declared as data rather than code so adding an entity type is a
   * single entry, and so the /api/search handler can't accidentally forget to cap one of them.
   * `priv` marks groups only privileged roles may see.
   */
  const GROUPS = [
    {
      type: 'circuit', label: 'Circuits',
      sql: `SELECT id, label, circuit_id, ctype, status FROM circuits
            WHERE label LIKE :q ESCAPE '\\' OR circuit_id LIKE :q ESCAPE '\\' OR ctype LIKE :q ESCAPE '\\'
            ORDER BY ${RANK('COALESCE(circuit_id, label)')}, label LIMIT ${CAP}`,
      map: r => ({ id: r.id, title: t(r.circuit_id) || t(r.label) || ('Circuit ' + r.id),
                   subtitle: [t(r.label) !== t(r.circuit_id) ? t(r.label) : null, t(r.ctype)].filter(Boolean).join(' · '),
                   badge: r.status, href: '#/circuit/' + r.id })
    },
    {
      type: 'cable', label: 'Cables',
      sql: `SELECT c.id, c.name, c.strand_count, c.cable_type, c.status, r.id AS route_id
            FROM fiber_cables c LEFT JOIN fiber_routes r ON r.id=c.route_id
            WHERE c.name LIKE :q ESCAPE '\\' OR c.cable_type LIKE :q ESCAPE '\\'
            ORDER BY ${RANK('c.name')}, c.name LIMIT ${CAP}`,
      map: r => ({ id: r.id, title: t(r.name), subtitle: [r.strand_count ? r.strand_count + ' strands' : null, t(r.cable_type)].filter(Boolean).join(' · '),
                   badge: r.status, href: '#/fiber/cable/' + r.id, route_id: r.route_id })
    },
    {
      type: 'route', label: 'Fiber routes',
      sql: `SELECT id, name, status, placement, length_m, min_lat, min_lng, max_lat, max_lng FROM fiber_routes
            WHERE name LIKE :q ESCAPE '\\' OR owner LIKE :q ESCAPE '\\'
            ORDER BY ${RANK('name')}, name LIMIT ${CAP}`,
      map: r => ({ id: r.id, title: t(r.name),
                   subtitle: [t(r.placement), r.length_m != null ? (r.length_m / 1000).toFixed(2) + ' km' : null].filter(Boolean).join(' · '),
                   badge: (r.status || '').replace('_', ' '), href: '#/fiber/route/' + r.id,
                   bbox: r.min_lat != null ? [r.min_lat, r.min_lng, r.max_lat, r.max_lng] : null })
    },
    {
      type: 'structure', label: 'Structures',
      sql: `SELECT id, name, kind, lat, lng, status FROM fiber_structures
            WHERE name LIKE :q ESCAPE '\\' OR ext_ref LIKE :q ESCAPE '\\'
            ORDER BY ${RANK('name')}, name LIMIT ${CAP}`,
      map: r => ({ id: r.id, title: t(r.name), subtitle: t(r.kind).replace('_', ' '),
                   badge: r.status, href: '#/fiber/structure/' + r.id, lat: r.lat, lng: r.lng })
    },
    {
      type: 'site', label: 'Sites',
      sql: `SELECT s.id, s.name, s.service_address, s.lat, s.lng, s.status, c.name AS customer
            FROM sites s LEFT JOIN customers c ON c.id=s.customer_id
            WHERE s.name LIKE :q ESCAPE '\\' OR s.service_address LIKE :q ESCAPE '\\' OR c.name LIKE :q ESCAPE '\\'
            ORDER BY ${RANK('s.name')}, s.name LIMIT ${CAP}`,
      map: r => ({ id: r.id, title: t(r.name), subtitle: [t(r.customer), t(r.service_address)].filter(Boolean).join(' · '),
                   badge: r.status, href: '#/site/' + r.id, lat: r.lat, lng: r.lng })
    },
    {
      type: 'pop', label: 'POPs',
      sql: `SELECT id, name, code, address, lat, lng, status FROM pops
            WHERE name LIKE :q ESCAPE '\\' OR code LIKE :q ESCAPE '\\' OR address LIKE :q ESCAPE '\\'
            ORDER BY ${RANK('name')}, name LIMIT ${CAP}`,
      map: r => ({ id: r.id, title: t(r.name), subtitle: [t(r.code), t(r.address)].filter(Boolean).join(' · '),
                   badge: r.status, href: '#/pop/' + r.id, lat: r.lat, lng: r.lng })
    },
    {
      // Identity and location only — no credential columns are selected at all.
      type: 'device', label: 'Devices',
      sql: `SELECT d.id, d.name, d.serial, d.mac, d.status, d.online, m.manufacturer, m.model
            FROM devices d LEFT JOIN device_models m ON m.id=d.model_id
            WHERE d.name LIKE :q ESCAPE '\\' OR d.serial LIKE :q ESCAPE '\\' OR d.mac LIKE :q ESCAPE '\\'
               OR d.mgmt_address LIKE :q ESCAPE '\\'
            ORDER BY ${RANK('d.name')}, d.name LIMIT ${CAP}`,
      map: r => ({ id: r.id, title: t(r.name), subtitle: [[t(r.manufacturer), t(r.model)].filter(Boolean).join(' '), t(r.serial)].filter(Boolean).join(' · '),
                   badge: r.online ? 'online' : (r.status || 'offline'), href: '#/device/' + r.id })
    },
    {
      type: 'customer', label: 'Customers',
      sql: `SELECT id, name, status, billing_email FROM customers
            WHERE name LIKE :q ESCAPE '\\' OR billing_email LIKE :q ESCAPE '\\' OR sms_number LIKE :q ESCAPE '\\'
            ORDER BY ${RANK('name')}, name LIMIT ${CAP}`,
      map: r => ({ id: r.id, title: t(r.name), subtitle: t(r.billing_email), badge: r.status, href: '#/customer/' + r.id })
    },
    {
      type: 'account', label: 'Accounts', priv: true,
      sql: `SELECT id, name, account_number, status FROM accounts
            WHERE name LIKE :q ESCAPE '\\' OR account_number LIKE :q ESCAPE '\\'
            ORDER BY ${RANK('name')}, name LIMIT ${CAP}`,
      map: r => ({ id: r.id, title: t(r.name), subtitle: t(r.account_number), badge: r.status, href: '#/account/' + r.id })
    }
  ];

  // ---- unified search ----
  app.get('/api/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    const out = { q, coords: parseCoords(q), groups: [] };
    if (q.length < 2 && !out.coords) return res.json(out);

    const priv = isPriv(req);
    const params = { q: like(q), pre: pre(q), exact: q };
    for (const g of GROUPS) {
      if (g.priv && !priv) continue;
      let rows;
      try { rows = db.prepare(g.sql).all(params); }
      catch (e) { console.error('search group ' + g.type + ':', e.message); continue; }
      if (rows.length) out.groups.push({ type: g.type, label: g.label, items: rows.map(g.map) });
    }
    res.json(out);
  });

  /**
   * What plant is near this point. Structures/sites/POPs compare cheaply on their stored lat/lng;
   * routes are prefiltered on the cached bbox so only nearby geometries get parsed.
   */
  /**
   * Fold structures sharing a location into one row. The nearest becomes the representative and
   * carries the others as `members`, so the UI can show "Vault 12 +23 more here" and expand it
   * instead of printing two dozen rows that all say 0 m.
   */
  function collapse(items) {
    const out = [];
    for (const it of items.sort((a, b) => a.distance_m - b.distance_m)) {
      const near = out.find(o => haversineM(o.lat, o.lng, it.lat, it.lng) <= COLOCATE_M);
      if (near) { (near.members ||= []).push({ id: it.id, title: it.title, subtitle: it.subtitle, href: it.href }); }
      else out.push(it);
    }
    for (const o of out) if (o.members) o.colocated = o.members.length + 1;
    return out;
  }

  function nearbyOf(lat, lng, radius) {
    const { dLat, dLng } = degBox(lat, radius);
    const lo = { la: lat - dLat, ha: lat + dLat, lo: lng - dLng, ho: lng + dLng };
    const hits = [];
    // Counted before collapsing and capping, so "43 structures nearby" stays true even though the
    // list only shows a handful of rows.
    const counts = {};

    const points = [
      ['structure', 'SELECT id, name, kind, lat, lng, status FROM fiber_structures WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?', r => ({ subtitle: t(r.kind).replace('_', ' '), href: '#/fiber/structure/' + r.id })],
      ['site', 'SELECT id, name, service_address, lat, lng, status FROM sites WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?', r => ({ subtitle: t(r.service_address), href: '#/site/' + r.id })],
      ['pop', 'SELECT id, name, code, address, lat, lng, status FROM pops WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?', r => ({ subtitle: [t(r.code), t(r.address)].filter(Boolean).join(' · '), href: '#/pop/' + r.id })]
    ];
    for (const [type, sql, extra] of points) {
      const found = [];
      for (const r of db.prepare(sql).all(lo.la, lo.ha, lo.lo, lo.ho)) {
        const m = haversineM(lat, lng, r.lat, r.lng);
        if (m <= radius) found.push({ type, id: r.id, title: t(r.name), badge: r.status, distance_m: Math.round(m), lat: r.lat, lng: r.lng, ...extra(r) });
      }
      counts[type] = found.length;
      hits.push(...(type === 'structure' ? collapse(found) : found));
    }

    // Routes: bbox is expanded by the radius so a line passing nearby isn't missed just because
    // none of its vertices fall inside the box.
    const cand = db.prepare(
      `SELECT id, name, status, placement, geom_json FROM fiber_routes
       WHERE min_lat IS NOT NULL AND min_lat <= ? AND max_lat >= ? AND min_lng <= ? AND max_lng >= ?`
    ).all(lo.ha, lo.la, lo.ho, lo.lo);
    for (const r of cand) {
      let coords = null;
      try { const g = JSON.parse(r.geom_json); coords = g && g.type === 'LineString' ? g.coordinates : null; } catch {}
      const d = distanceToLineM(lat, lng, coords);
      if (d && d.m <= radius) {
        counts.route = (counts.route || 0) + 1;
        hits.push({ type: 'route', id: r.id, title: t(r.name), badge: t(r.status).replace('_', ' '),
                    subtitle: t(r.placement), distance_m: Math.round(d.m), lat: d.lat, lng: d.lng,
                    href: '#/fiber/route/' + r.id });
      }
    }

    hits.sort((a, b) => a.distance_m - b.distance_m);
    // In a dense metro every span path terminates in the same building, so an uncapped list is
    // 700 routes all reading 0 m and the one nearby site never appears. Keep the closest few of
    // each type and report the true totals separately.
    const shownPerType = {}, kept = [];
    for (const h of hits) {
      shownPerType[h.type] = (shownPerType[h.type] || 0) + 1;
      if (shownPerType[h.type] <= NEAR_PER_TYPE) kept.push(h);
    }
    for (const k of Object.keys(counts)) if (!counts[k]) delete counts[k];
    return { items: kept, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  }

  app.get('/api/nearby', (req, res) => {
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
      return res.status(400).json({ error: 'lat and lng required' });
    let radius = Number(req.query.radius);
    if (!Number.isFinite(radius) || radius <= 0) radius = NEAR_DEFAULT;
    radius = Math.min(radius, NEAR_MAX);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const n = nearbyOf(lat, lng, radius);
    res.json({ lat, lng, radius_m: radius, total: n.total, counts: n.counts, items: n.items.slice(0, limit) });
  });

  /**
   * One call for the map's search box: figures out whether the query is a coordinate, an asset or
   * an address, and returns the resolved point plus what's around it. Saves the client from
   * orchestrating three round trips and guessing which one applies.
   */
  app.get('/api/locate', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q required' });
    let radius = Number(req.query.radius);
    if (!Number.isFinite(radius) || radius <= 0) radius = NEAR_DEFAULT;
    radius = Math.min(radius, NEAR_MAX);

    const c = parseCoords(q);
    if (c) {
      const n = nearbyOf(c.lat, c.lng, radius);
      return res.json({ kind: 'coords', lat: c.lat, lng: c.lng, format: c.format,
                        label: c.lat.toFixed(6) + ', ' + c.lng.toFixed(6),
                        nearby: n.items, nearby_counts: n.counts, nearby_total: n.total });
    }

    // Not a coordinate — try the address geocoder, but only if we have one wired up.
    if (typeof geocode !== 'function') return res.json({ kind: 'none', q });
    let results = [];
    try { results = await geocode(q); } catch (e) { return res.status(502).json({ error: 'geocoder unavailable' }); }
    if (!results.length) return res.json({ kind: 'none', q });
    const top = results[0];
    const lat = Number(top.lat), lng = Number(top.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.json({ kind: 'none', q });
    const n = nearbyOf(lat, lng, radius);
    return res.json({
      kind: 'address', lat, lng, label: top.label, display: top.display,
      alternatives: results.slice(1, 5).map(r => ({ label: r.label, lat: +r.lat, lng: +r.lon })),
      nearby: n.items, nearby_counts: n.counts, nearby_total: n.total
    });
  });
}
