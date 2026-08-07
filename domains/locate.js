// Fibre distance ↔ GPS position along a circuit, cable or route.
//
// The field problem: an OTDR reports a fault at some distance of FIBRE from one end. A crew needs
// a place to dig. Doing that from a KMZ means exporting the plant first and trusting whatever
// order the segments happen to be in; here the geometry is already in the database, so a circuit
// can be picked by CID and the answer computed directly.
//
// Both directions are supported, because both come up: distance → position when a trace lands,
// and position → distance when a locate crew finds damage and the OTDR tech needs a number.
import { mergeSegments, cumulative, pathLengthM, pointAtDistance, distanceAlong,
         fibreToGround, groundToFibre, measuredSlackPct, DEFAULT_SLACK_PCT } from '../lib/path.js';
import { haversineM } from '../lib/geo.js';

const PATH_TYPES = ['circuit', 'cable', 'route'];
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export default function registerLocate(app, ctx) {
  const { db, N, requireNoc, audit } = ctx;

  const safeJson = s => { try { return JSON.parse(s); } catch { return null; } };

  /** Routes carrying a circuit / cable / route, in no particular order — merging sorts that out. */
  function routesFor(type, id) {
    if (type === 'route') return db.prepare('SELECT * FROM fiber_routes WHERE id=?').all(id);
    if (type === 'cable')
      return db.prepare('SELECT r.* FROM fiber_routes r JOIN fiber_cables c ON c.route_id=r.id WHERE c.id=?').all(id);
    // A circuit rides strands; those strands live on cables; those cables run on routes.
    return db.prepare(`
      SELECT DISTINCT r.* FROM fiber_routes r
      JOIN fiber_cables c ON c.route_id = r.id
      JOIN fiber_strands s ON s.cable_id = c.id
      WHERE s.assigned_type='circuit' AND s.assigned_id=?`).all(id);
  }

  function subjectOf(type, id) {
    if (type === 'circuit') {
      const c = db.prepare('SELECT id, label, circuit_id, ctype, status FROM circuits WHERE id=?').get(id);
      return c && { id: c.id, name: c.circuit_id || c.label || ('Circuit ' + c.id), sub: c.ctype, status: c.status };
    }
    if (type === 'cable') {
      const c = db.prepare('SELECT id, name, strand_count, status FROM fiber_cables WHERE id=?').get(id);
      return c && { id: c.id, name: c.name, sub: c.strand_count ? c.strand_count + ' strands' : null, status: c.status };
    }
    const r = db.prepare('SELECT id, name, status, placement FROM fiber_routes WHERE id=?').get(id);
    return r && { id: r.id, name: r.name, sub: r.placement, status: r.status };
  }

  /**
   * Assemble the merged path plus everything needed to reason about distances along it.
   * Returns null when the subject doesn't exist, or an object with `error` when it has no geometry.
   */
  function buildPath(type, id, snapM) {
    const subject = subjectOf(type, id);
    if (!subject) return null;
    const routes = routesFor(type, id);
    if (!routes.length) return { subject, error: 'no_geometry' };

    const segs = [];
    for (const r of routes) {
      const g = safeJson(r.geom_json);
      if (g && g.type === 'LineString' && Array.isArray(g.coordinates) && g.coordinates.length >= 2)
        segs.push({ id: r.id, coords: g.coordinates, meta: r });
    }
    if (!segs.length) return { subject, error: 'no_geometry' };

    const merged = mergeSegments(segs, snapM);
    const coords = merged.coords;
    if (coords.length < 2) return { subject, error: 'no_geometry' };
    const cum = cumulative(coords);
    const total = cum[cum.length - 1];

    // Ground distance at which each segment ends, with the slack that applies inside it. Gaps
    // bridged during the merge add distance too, so they're folded into the preceding segment.
    const byId = new Map(segs.map(s => [s.id, s]));
    const spans = [], segments = [];
    let acc = 0;
    for (const o of merged.order) {
      const seg = byId.get(o.id);
      const groundLen = pathLengthM(seg.coords);
      acc += (o.gapBefore || 0) + groundLen;
      // Slack precedence, best evidence first:
      //   1. a manual override typed on the route page — someone looked and decided
      //   2. a ratio measured from the source system's own fibre length, if it's believable
      //   3. the 13% convention
      // A caller-supplied ?slack overrides all three, and is applied later in applySlack().
      const measured = measuredSlackPct(seg.meta.fibre_m, groundLen);
      const slack = seg.meta.slack_pct != null ? seg.meta.slack_pct
        : (measured != null ? measured : null);
      const source = seg.meta.slack_pct != null ? 'route' : (measured != null ? 'measured' : 'default');
      spans.push({ endGround_m: acc, slackPct: slack });
      segments.push({
        route_id: o.id, name: seg.meta.name, reversed: o.reversed,
        ground_m: Math.round(groundLen), ends_at_m: Math.round(acc),
        slack_pct: slack == null ? null : Math.round(slack * 10) / 10,
        slack_source: source,
        fibre_m: seg.meta.fibre_m == null ? null : Math.round(seg.meta.fibre_m),
        placement: seg.meta.placement, status: seg.meta.status
      });
    }

    return { subject, coords, cum, total_m: total, spans, segments, merged };
  }

  /** Splices and structures on this path, referenced by distance from the A end. */
  function pointsAlong(type, id, coords, cum) {
    const cableIds = type === 'cable' ? [id]
      : type === 'circuit'
        ? db.prepare("SELECT DISTINCT cable_id id FROM fiber_strands WHERE assigned_type='circuit' AND assigned_id=?").all(id).map(r => r.id)
        : db.prepare('SELECT id FROM fiber_cables WHERE route_id=?').all(id).map(r => r.id);
    if (!cableIds.length) return [];
    const qs = cableIds.map(() => '?').join(',');

    const structs = db.prepare(`
      SELECT DISTINCT s.id, s.name, s.kind, s.lat, s.lng FROM fiber_structures s
      WHERE s.lat IS NOT NULL AND s.lng IS NOT NULL
        AND s.id IN (SELECT a_structure_id FROM fiber_cables WHERE id IN (${qs})
                     UNION SELECT z_structure_id FROM fiber_cables WHERE id IN (${qs}))`)
      .all(...cableIds, ...cableIds);

    const spliceCount = new Map();
    for (const r of db.prepare(`SELECT structure_id, COUNT(*) n FROM fiber_splices WHERE structure_id IS NOT NULL GROUP BY structure_id`).all())
      spliceCount.set(r.structure_id, r.n);

    const out = [];
    for (const s of structs) {
      const d = distanceAlong(coords, s.lat, s.lng, cum);
      if (!d) continue;
      out.push({
        id: s.id, name: s.name, kind: s.kind, lat: s.lat, lng: s.lng,
        along_m: Math.round(d.along_m), offset_m: Math.round(d.offset_m),
        splices: spliceCount.get(s.id) || 0, href: '#/fiber/structure/' + s.id
      });
    }
    out.sort((a, b) => a.along_m - b.along_m);
    return out;
  }

  const parse = req => {
    const type = String(req.query.type || '');
    const id = Number(req.query.id);
    if (!PATH_TYPES.includes(type) || !Number.isFinite(id)) return null;
    let snap = Number(req.query.snap);
    if (!Number.isFinite(snap) || snap < 0) snap = 50;
    return { type, id, snap: Math.min(snap, 5000) };
  };
  /**
   * Slack handling has two modes, and conflating them gives silently wrong distances:
   *   ?slack=N omitted  → each route uses its own slack_pct, falling back to the default.
   *   ?slack=N supplied → the user has chosen a figure, and it applies to the whole path.
   * The UI's "per-route" option simply omits the parameter.
   */
  const slackOf = req => {
    const raw = req.query.slack;
    const v = Number(raw);
    const forced = raw !== undefined && raw !== '' && Number.isFinite(v) && v > -100 && v < 100;
    return { pct: forced ? v : DEFAULT_SLACK_PCT, forced };
  };
  /** Apply a forced slack across every segment, or leave each route's own in place. */
  const applySlack = (spans, s) => s.forced ? spans.map(x => ({ ...x, slackPct: s.pct })) : spans;

  // ---- the path itself ----
  app.get('/api/fiber/path', (req, res) => {
    const q = parse(req);
    if (!q) return res.status(400).json({ error: 'type must be circuit|cable|route, with a numeric id' });
    const p = buildPath(q.type, q.id, q.snap);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.error) return res.status(409).json({ error: 'This ' + q.type + ' has no mapped route geometry yet.', subject: p.subject });

    const sl = slackOf(req);
    const spans = applySlack(p.spans, sl);
    res.json({
      type: q.type, subject: p.subject,
      geometry: { type: 'LineString', coordinates: p.coords },
      total_m: Math.round(p.total_m),
      total_fibre_m: Math.round(groundToFibre(p.total_m, spans, sl.pct)),
      default_slack_pct: sl.pct, slack_forced: sl.forced,
      slack_sources: p.segments.reduce((m, s) => (m[sl.forced ? 'forced' : s.slack_source] = (m[sl.forced ? 'forced' : s.slack_source] || 0) + 1, m), {}),
      segments: p.segments,
      gaps: p.merged.gaps,
      unused_routes: p.merged.unused,
      points: pointsAlong(q.type, q.id, p.coords, p.cum)
    });
  });

  // ---- fibre distance → position ----
  /**
   * One OTDR reading → a position, plus the context a crew needs around it.
   * Factored out because a trace usually shows SEVERAL events, and they all get located the
   * same way against the same prepared path.
   */
  function locateOne(p, spans, sl, pts, km, fromZ, totalFibre) {
    const fibreM = km * 1000;
    // Measuring from the Z end means the same fibre distance counted backwards, so convert the
    // whole path to fibre and subtract before mapping back to ground.
    const groundM = fromZ
      ? fibreToGround(Math.max(0, totalFibre - fibreM), spans, sl.pct)
      : fibreToGround(fibreM, spans, sl.pct);
    const pt = pointAtDistance(p.coords, groundM, p.cum);
    const before = [...pts].reverse().find(x => x.along_m <= pt.along_m) || null;
    const after = pts.find(x => x.along_m > pt.along_m) || null;
    const segment = p.segments.find(x => pt.along_m <= x.ends_at_m) || p.segments[p.segments.length - 1];
    return {
      lat: +pt.lat.toFixed(6), lng: +pt.lng.toFixed(6),
      requested_fibre_km: km,
      ground_m: Math.round(groundM), ground_km: +(groundM / 1000).toFixed(3),
      beyond_end: pt.clamped,
      on_segment: segment ? { route_id: segment.route_id, name: segment.name, slack_pct: sl.forced ? sl.pct : segment.slack_pct, slack_source: sl.forced ? 'forced' : segment.slack_source } : null,
      between: { before, after }
    };
  }

  /**
   * Fibre distance → position. `km` takes one value or several separated by commas, spaces or
   * newlines — an OTDR trace normally lists several events, and pasting them all at once beats
   * running the tool once per reading.
   *
   * The response keeps the single-point fields at the top level (the first reading) so existing
   * callers are unaffected, and adds `points[]` for the full set.
   */
  app.get('/api/fiber/locate', (req, res) => {
    const q = parse(req);
    if (!q) return res.status(400).json({ error: 'type must be circuit|cable|route, with a numeric id' });
    const kms = String(req.query.km ?? '').split(/[,\s]+/).map(x => x.trim()).filter(Boolean).map(Number);
    if (!kms.length || kms.some(k => !Number.isFinite(k)))
      return res.status(400).json({ error: 'km required — one distance, or several separated by commas' });
    if (kms.length > 50) return res.status(400).json({ error: 'Up to 50 distances at a time' });
    const p = buildPath(q.type, q.id, q.snap);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.error) return res.status(409).json({ error: 'This ' + q.type + ' has no mapped route geometry yet.' });

    const sl = slackOf(req);
    const spans = applySlack(p.spans, sl);
    const fromZ = String(req.query.from || 'a').toLowerCase() === 'z';
    const totalFibre = groundToFibre(p.total_m, spans, sl.pct);
    const pts = pointsAlong(q.type, q.id, p.coords, p.cum);

    const points = kms.map((km, i) => ({ index: i + 1, ...locateOne(p, spans, sl, pts, km, fromZ, totalFibre) }));
    // Ordered along the path, with the gap to the previous one. Several events close together
    // usually mean one damaged section rather than several independent faults.
    const ordered = [...points].sort((a, b) => a.ground_m - b.ground_m);
    ordered.forEach((x, i) => {
      x.order = i + 1;
      x.gap_from_previous_m = i === 0 ? null : Math.round(x.ground_m - ordered[i - 1].ground_m);
    });

    const first = points[0];
    res.json({
      ...first,
      from: fromZ ? 'z' : 'a',
      total_m: Math.round(p.total_m), total_fibre_km: +(totalFibre / 1000).toFixed(3),
      slack_pct: sl.pct, slack_forced: sl.forced,
      count: points.length,
      points,
      span_m: points.length > 1 ? Math.round(ordered[ordered.length - 1].ground_m - ordered[0].ground_m) : 0,
      gaps: p.merged.gaps
    });
  });

  // ---- position → fibre distance ----
  app.get('/api/fiber/locate/reverse', (req, res) => {
    const q = parse(req);
    if (!q) return res.status(400).json({ error: 'type must be circuit|cable|route, with a numeric id' });
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat and lng required' });
    const p = buildPath(q.type, q.id, q.snap);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.error) return res.status(409).json({ error: 'This ' + q.type + ' has no mapped route geometry yet.' });

    const sl = slackOf(req);
    const spans = applySlack(p.spans, sl);
    const d = distanceAlong(p.coords, lat, lng, p.cum);
    const totalFibre = groundToFibre(p.total_m, spans, sl.pct);
    const fromA = groundToFibre(d.along_m, spans, sl.pct);
    const pts = pointsAlong(q.type, q.id, p.coords, p.cum);
    res.json({
      snapped: { lat: +d.lat.toFixed(6), lng: +d.lng.toFixed(6) },
      offset_m: Math.round(d.offset_m),
      ground_m: Math.round(d.along_m),
      fibre_from_a_km: +(fromA / 1000).toFixed(3),
      fibre_from_z_km: +((totalFibre - fromA) / 1000).toFixed(3),
      total_fibre_km: +(totalFibre / 1000).toFixed(3),
      slack_pct: sl.pct, slack_forced: sl.forced,
      between: {
        before: [...pts].reverse().find(x => x.along_m <= d.along_m) || null,
        after: pts.find(x => x.along_m > d.along_m) || null
      }
    });
  });

  // ---- KML export, for the standalone locator and for Google Earth ----
  app.get('/api/fiber/path.kml', (req, res) => {
    const q = parse(req);
    if (!q) return res.status(400).type('text/plain').send('type must be circuit|cable|route, with a numeric id');
    const p = buildPath(q.type, q.id, q.snap);
    if (!p) return res.status(404).type('text/plain').send('not found');
    if (p.error) return res.status(409).type('text/plain').send('This ' + q.type + ' has no mapped route geometry yet.');

    const name = p.subject.name || (q.type + ' ' + q.id);
    // Optional fault markers, so a trace can be handed to a crew as a single file.
    const sl = slackOf(req);
    const spans = applySlack(p.spans, sl);
    const fromZ = String(req.query.from || 'a').toLowerCase() === 'z';
    const kms = String(req.query.faults || '').split(/[,\s]+/).map(x => x.trim()).filter(Boolean).map(Number).filter(Number.isFinite).slice(0, 50);
    let faultMarks = '';
    if (kms.length) {
      const totalFibre = groundToFibre(p.total_m, spans, sl.pct);
      const pts = pointsAlong(q.type, q.id, p.coords, p.cum);
      faultMarks = kms.map((km, i) => {
        const f = locateOne(p, spans, sl, pts, km, fromZ, totalFibre);
        const near = [f.between.before && f.between.before.name, f.between.after && f.between.after.name].filter(Boolean).join(' → ');
        return `
    <Placemark><name>Fault ${i + 1} — ${km} km</name><styleUrl>#fault</styleUrl>
      <description>${esc(km + ' km of fibre from the ' + (fromZ ? 'Z' : 'A') + ' end · ' + f.ground_km + ' km ground' + (near ? ' · between ' + near : ''))}</description>
      <Point><coordinates>${f.lng},${f.lat},0</coordinates></Point></Placemark>`;
      }).join('');
    }
    // One LineString for the whole merged run, plus a named Point per structure — the shape the
    // standalone locator expects (it labels named Point placemarks and merges LineStrings).
    const line = p.coords.map(c => `${c[0]},${c[1]},0`).join(' ');
    const marks = pointsAlong(q.type, q.id, p.coords, p.cum).map(s => `
    <Placemark><name>${esc(s.name)}</name>
      <description>${esc(s.kind || '')} · ${(s.along_m / 1000).toFixed(3)} km along${s.splices ? ' · ' + s.splices + ' splice(s)' : ''}</description>
      <Point><coordinates>${s.lng},${s.lat},0</coordinates></Point></Placemark>`).join('');

    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <name>${esc(name)}</name>
  <description>${esc(p.subject.sub || '')} · ${(p.total_m / 1000).toFixed(3)} km ground · exported from Network Inventory</description>
  <Style id="route"><LineStyle><color>ff2d8ad3</color><width>4</width></LineStyle></Style>
  <Style id="fault"><IconStyle><color>ff3636d9</color><scale>1.2</scale>
    <Icon><href>http://maps.google.com/mapfiles/kml/shapes/caution.png</href></Icon></IconStyle></Style>
  <Placemark><name>${esc(name)}</name><styleUrl>#route</styleUrl>
    <LineString><tessellate>1</tessellate><coordinates>${line}</coordinates></LineString></Placemark>${faultMarks}${marks}
</Document></kml>`;
    const file = String(name).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'path';
    res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
    res.setHeader('Content-Disposition', `attachment; filename="${file}.kml"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(kml);
  });

  // ---- save a located point as a structure ----
  app.post('/api/fiber/locate/mark', requireNoc, (req, res) => {
    const b = req.body || {};
    const lat = Number(b.lat), lng = Number(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat and lng required' });
    const name = N(b.name) || `Located point ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    const info = db.prepare('INSERT INTO fiber_structures (name,kind,lat,lng,status,notes) VALUES (?,?,?,?,?,?)')
      .run(String(name).slice(0, 160), 'handhole', lat, lng, 'planned', N(b.notes) || null);
    audit(req, 'create', 'fiber_structure#' + info.lastInsertRowid, name);
    res.json({ id: info.lastInsertRowid });
  });
}
