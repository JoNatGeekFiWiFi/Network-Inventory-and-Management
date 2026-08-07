// Fiber plant domain (GIS): routes → cables → strands, plus structures and splices.
//
// Modelled on how purpose-built OSP tools (VETRO FiberMap, 3-GIS, OSPInsight) structure fiber,
// rather than on a general-purpose GIS: the physical PATH (route), the CABLE riding it, and the
// individual STRAND are separate things, and splices join strands at a structure.
//
// Geometry is GeoJSON stored as text — SQLite has no spatial type and we don't need spatial
// queries, just "draw it on a map and tell me what's connected to what".
import express from 'express';
import { r2 } from '../lib/core.js';
import { extractKmlFromKmz, looksLikeZip, listZipEntries, readZipEntry } from '../lib/unzip.js';
import { shapefileToFeatures } from '../lib/shapefile.js';
import { looksLikeIqgeo, parseIqgeo } from '../lib/iqgeo.js';
import { bboxOf, simplifyPath, clipPathToBox, robustExtent } from '../lib/geo.js';

/**
 * Work out what an uploaded file is and turn it into { routes, structures, cables, circuits }.
 *
 * Shared by the importer and by the locator's "upload a file" mode, so both accept exactly the
 * same formats and read them identically — if a KMZ imports cleanly it must also locate cleanly.
 *
 * @param input Buffer (raw upload) | { b64 } | { text }
 * @returns { format, parsed } or { error }
 */
export function parseUpload(input) {
  let raw = '', format = null, parsed = null;
  let buf = null;
  if (Buffer.isBuffer(input)) buf = input;
  else if (input && input.b64 != null) {
    try { buf = Buffer.from(String(input.b64), 'base64'); }
    catch { return { error: 'Could not decode the uploaded file' }; }
  } else raw = (input && input.text) || '';

  if (buf) {
    if (!buf.length) return { error: 'No file content received' };
    if (looksLikeZip(buf)) {
      // A zip is either a KMZ or a zipped shapefile set — look inside to decide.
      let entries;
      try { entries = listZipEntries(buf).filter(e => !e.name.endsWith('/')); }
      catch (e) { return { error: e.message }; }
      const shp = entries.find(e => /\.shp$/i.test(e.name));
      if (shp) {
        const base = shp.name.replace(/\.shp$/i, '');
        const dbfEntry = entries.find(e => e.name.toLowerCase() === (base + '.dbf').toLowerCase());
        try {
          parsed = shapefileToFeatures(readZipEntry(buf, shp), dbfEntry ? readZipEntry(buf, dbfEntry) : null);
          format = 'shapefile';
        } catch (e) { return { error: e.message }; }
      } else {
        try { raw = extractKmlFromKmz(buf); format = 'kmz'; }
        catch (e) { return { error: e.message }; }
      }
    } else if (buf.length > 4 && buf.readInt32BE(0) === 9994) {
      // a bare .shp with no .dbf alongside — geometry only, names auto-numbered
      try { parsed = shapefileToFeatures(buf, null); format = 'shapefile'; }
      catch (e) { return { error: e.message }; }
    } else raw = buf.toString('utf8');   // a plain text format sent as bytes — fine
  }

  if (!parsed) {
    if (!raw.trim()) return { error: 'No file content received' };
    const head = raw.slice(0, 4000);
    if (format === 'kmz') parsed = parseKml(raw);
    else if (/<gpx[\s>]/i.test(head)) { format = 'gpx'; parsed = parseGpx(raw); }
    else if (/<kml|<Placemark/i.test(head)) { format = 'kml'; parsed = parseKml(raw); }
    else if (/^\s*[{[]/.test(head)) {
      let j; try { j = JSON.parse(raw); } catch (e) { return { error: 'Not valid GeoJSON: ' + e.message }; }
      // A myWorld/IQGeo export is GeoJSON, but its user_* attributes carry cable counts,
      // strand ranges and endpoint structures that a generic reader would discard.
      if (looksLikeIqgeo(j)) { format = 'iqgeo'; parsed = parseIqgeo(j); }
      else { format = 'geojson'; parsed = parseGeoJson(j); }
    } else if (/[,;]/.test(head.split(/\r?\n/)[0] || '')) { format = 'csv'; parsed = parseCsv(raw); }
    else return { error: 'Unrecognised file. Supported: GeoJSON, KML, KMZ, GPX, CSV, Shapefile (.shp or zipped).' };
  }
  if (!parsed.routes.length && !parsed.structures.length)
    return { error: `No routes or points found in that ${format} file` };
  return { format, parsed };
}

// TIA-598-C fibre colour sequence. Repeats every 12; beyond the first 12 units the standard
// adds a black stripe (black itself gets a yellow stripe).
export const TIA_COLORS = ['Blue', 'Orange', 'Green', 'Brown', 'Slate', 'White', 'Red', 'Black', 'Yellow', 'Violet', 'Rose', 'Aqua'];
export const TIA_HEX = { Blue: '#1f6fd0', Orange: '#f07c1e', Green: '#1f9d4d', Brown: '#7b4a26', Slate: '#8a94a0', White: '#e9edf2', Red: '#d93636', Black: '#22262b', Yellow: '#e8c72c', Violet: '#8b5cd6', Rose: '#e87fa8', Aqua: '#43c8d4' };

/** Colour + tube for a 1-based strand position, per TIA-598-C. */
export function strandColor(position) {
  const idx = ((position - 1) % 12);
  const tube = Math.floor((position - 1) / 12) + 1;
  const tubeIdx = ((tube - 1) % 12);
  const striped = tube > 12;                      // >144ct: units repeat with a tracer stripe
  return {
    tube,
    position_in_tube: idx + 1,
    color: TIA_COLORS[idx],
    tube_color: TIA_COLORS[tubeIdx] + (striped ? (TIA_COLORS[tubeIdx] === 'Black' ? '/Yellow' : '/Black') : '')
  };
}

/** Rough great-circle length of a GeoJSON LineString, in metres. */
export function lineLengthM(coords) {
  const R = 6371000, rad = d => d * Math.PI / 180;
  let m = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lon1, lat1] = coords[i - 1], [lon2, lat2] = coords[i];
    const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    m += 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return Math.round(m);
}

/** Accept a GeoJSON LineString (geometry or Feature) and return its coordinate array, or null. */
export function lineCoords(input) {
  if (!input) return null;
  const g = input.type === 'Feature' ? input.geometry : input;
  if (!g || g.type !== 'LineString' || !Array.isArray(g.coordinates)) return null;
  const cs = g.coordinates.filter(c => Array.isArray(c) && c.length >= 2 && Number.isFinite(+c[0]) && Number.isFinite(+c[1]))
    .map(c => [+c[0], +c[1]]);
  return cs.length >= 2 ? cs : null;
}

// Minimal KML reader — Google Earth is where most small ISPs keep their fiber, and its
// Placemark/LineString/Point subset is simple enough not to justify an XML dependency.
export function parseKml(xml) {
  const out = { routes: [], structures: [] };
  const placemarks = String(xml).match(/<Placemark[\s\S]*?<\/Placemark>/gi) || [];
  const tag = (s, t) => { const m = s.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>', 'i')); return m ? m[1].trim() : ''; };
  const strip = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
  const coordsOf = s => strip(s).split(/\s+/).map(p => p.split(',')).filter(p => p.length >= 2)
    .map(p => [parseFloat(p[0]), parseFloat(p[1])]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  for (const pm of placemarks) {
    const name = strip(tag(pm, 'name')) || 'Imported';
    const desc = strip(tag(pm, 'description'));
    const lineBlock = pm.match(/<LineString[\s\S]*?<\/LineString>/i);
    const pointBlock = pm.match(/<Point[\s\S]*?<\/Point>/i);
    if (lineBlock) {
      const cs = coordsOf(tag(lineBlock[0], 'coordinates'));
      if (cs.length >= 2) out.routes.push({ name, notes: desc || null, coordinates: cs });
    } else if (pointBlock) {
      const cs = coordsOf(tag(pointBlock[0], 'coordinates'));
      if (cs.length) out.structures.push({ name, notes: desc || null, lng: cs[0][0], lat: cs[0][1] });
    }
  }
  return out;
}

/** Pull routes + structures out of a GeoJSON FeatureCollection / Feature / geometry. */
export function parseGeoJson(data) {
  const out = { routes: [], structures: [] };
  const feats = data && data.type === 'FeatureCollection' ? (data.features || [])
    : (data && data.type === 'Feature' ? [data] : (data && data.type ? [{ type: 'Feature', properties: {}, geometry: data }] : []));
  for (const f of feats) {
    const g = f && f.geometry; if (!g) continue;
    const p = f.properties || {};
    const name = p.name || p.Name || p.label || p.NAME || 'Imported';
    const notes = p.description || p.notes || null;
    if (g.type === 'LineString') {
      const cs = lineCoords(g); if (cs) out.routes.push({ name, notes, coordinates: cs });
    } else if (g.type === 'MultiLineString') {
      (g.coordinates || []).forEach((part, i) => {
        const cs = lineCoords({ type: 'LineString', coordinates: part });
        if (cs) out.routes.push({ name: name + (i ? ` (${i + 1})` : ''), notes, coordinates: cs });
      });
    } else if (g.type === 'Point' && Array.isArray(g.coordinates)) {
      const [lng, lat] = g.coordinates;
      if (Number.isFinite(+lng) && Number.isFinite(+lat)) out.structures.push({ name, notes, lng: +lng, lat: +lat });
    }
  }
  return out;
}

// GPX — what a field crew's handheld GPS or phone app produces. Tracks/routes become fiber
// routes; waypoints become structures.
export function parseGpx(xml) {
  const out = { routes: [], structures: [] };
  const s = String(xml);
  const tagText = (blk, t) => { const m = blk.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>', 'i')); return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : ''; };
  const ptsOf = (blk, tag) => {
    const pts = [];
    for (const m of blk.matchAll(new RegExp('<' + tag + '\\b[^>]*?lat="([-\\d.]+)"[^>]*?lon="([-\\d.]+)"', 'gi'))) {
      const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([lon, lat]);
    }
    return pts;
  };
  for (const m of s.match(/<trk>[\s\S]*?<\/trk>/gi) || []) {
    const cs = ptsOf(m, 'trkpt'); if (cs.length >= 2) out.routes.push({ name: tagText(m, 'name') || 'GPS track', notes: tagText(m, 'desc') || null, coordinates: cs });
  }
  for (const m of s.match(/<rte>[\s\S]*?<\/rte>/gi) || []) {
    const cs = ptsOf(m, 'rtept'); if (cs.length >= 2) out.routes.push({ name: tagText(m, 'name') || 'GPS route', notes: tagText(m, 'desc') || null, coordinates: cs });
  }
  for (const m of s.match(/<wpt\b[\s\S]*?<\/wpt>/gi) || []) {
    const cs = ptsOf(m, 'wpt'); if (cs.length) out.structures.push({ name: tagText(m, 'name') || 'Waypoint', notes: tagText(m, 'desc') || null, lng: cs[0][0], lat: cs[0][1] });
  }
  return out;
}

// CSV — a list of structures (one point per row), the format people hand you from a spreadsheet.
// Also accepts a WKT LINESTRING column for routes.
export function parseCsv(text) {
  const out = { routes: [], structures: [] };
  const lines = String(text).split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return out;
  const splitRow = l => { const cells = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; } else if (ch === ',' && !q) { cells.push(cur); cur = ''; } else cur += ch; } cells.push(cur); return cells.map(c => c.trim()); };
  const head = splitRow(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const findCol = (...names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  const latI = findCol('lat', 'latitude', 'y'), lngI = findCol('lng', 'lon', 'long', 'longitude', 'x');
  const nameI = findCol('name', 'label', 'id', 'structure', 'site');
  const kindI = findCol('kind', 'type', 'structuretype');
  const noteI = findCol('notes', 'note', 'description', 'comment');
  const wktI = findCol('wkt', 'geometry', 'geom', 'linestring');
  for (let i = 1; i < lines.length; i++) {
    const c = splitRow(lines[i]);
    if (wktI >= 0 && /LINESTRING/i.test(c[wktI] || '')) {
      const inner = (c[wktI].match(/LINESTRING\s*\(([^)]*)\)/i) || [])[1] || '';
      const coords = inner.split(',').map(p => p.trim().split(/\s+/).map(Number)).filter(p => p.length >= 2 && p.every(Number.isFinite));
      if (coords.length >= 2) out.routes.push({ name: (nameI >= 0 && c[nameI]) || 'CSV route ' + i, notes: noteI >= 0 ? (c[noteI] || null) : null, coordinates: coords });
      continue;
    }
    if (latI < 0 || lngI < 0) continue;
    const lat = parseFloat(c[latI]), lng = parseFloat(c[lngI]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.structures.push({ name: (nameI >= 0 && c[nameI]) || 'Point ' + i, notes: noteI >= 0 ? (c[noteI] || null) : null, lat, lng, kind: kindI >= 0 ? (c[kindI] || '').toLowerCase() : null });
  }
  return out;
}

const ROUTE_STATUS = ['planned', 'permitted', 'under_construction', 'as_built', 'retired'];
const CIRCUIT_STATUSES = ['Up', 'Standby', 'Down', 'Planned', 'Decommissioned'];
const STRAND_STATUS = ['free', 'reserved', 'assigned', 'dark', 'damaged', 'abandoned'];
const STRUCTURE_KINDS = ['handhole', 'vault', 'pole', 'cabinet', 'pedestal', 'building', 'splice_case'];
const SPLICE_TYPES = ['fusion', 'mechanical', 'splitter', 'termination'];

export default function registerFiber(app, ctx) {
  const { db, N, audit, requireNoc, attachmentsFor, deleteAttachmentsFor } = ctx;

  // ---- helpers ----
  const routeOut = r => ({ ...r, geometry: safeJson(r.geom_json) });
  const safeJson = s => { try { return JSON.parse(s); } catch { return null; } };
  function generateStrands(cableId, count) {
    const ins = db.prepare('INSERT INTO fiber_strands (cable_id,position,tube,tube_color,color) VALUES (?,?,?,?,?)');
    for (let p = 1; p <= count; p++) { const c = strandColor(p); ins.run(cableId, p, c.tube, c.tube_color, c.color); }
  }
  function cableSummary(c) {
    const counts = db.prepare('SELECT status, COUNT(*) n FROM fiber_strands WHERE cable_id=? GROUP BY status').all(c.id);
    const by = {}; counts.forEach(x => by[x.status] = x.n);
    const used = (by.assigned || 0) + (by.reserved || 0);
    return { ...c, strand_counts: by, strands_used: used, strands_free: by.free || 0 };
  }

  // ---- routes ----
  app.get('/api/fiber/routes', (req, res) => res.json(db.prepare('SELECT * FROM fiber_routes ORDER BY name').all().map(routeOut)));
  app.get('/api/fiber/routes/:id', (req, res) => {
    const r = db.prepare('SELECT * FROM fiber_routes WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const out = routeOut(r);
    out.attachments = attachmentsFor('route', r.id);
    out.cables = db.prepare('SELECT * FROM fiber_cables WHERE route_id=? ORDER BY name').all(r.id).map(cableSummary);
    res.json(out);
  });
  app.post('/api/fiber/routes', requireNoc, (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'Route name required' });
    const cs = lineCoords(b.geometry);
    if (!cs) return res.status(400).json({ error: 'Draw a route line with at least two points' });
    const geom = JSON.stringify({ type: 'LineString', coordinates: cs });
    const bb = bboxOf(cs);
    const info = db.prepare('INSERT INTO fiber_routes (name,status,placement,owner,length_m,geom_json,notes,min_lat,min_lng,max_lat,max_lng) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(String(b.name).slice(0, 160), ROUTE_STATUS.includes(b.status) ? b.status : 'as_built', N(b.placement) || null,
        N(b.owner) || null, lineLengthM(cs), geom, N(b.notes) || null,
        bb && bb.minLat, bb && bb.minLng, bb && bb.maxLat, bb && bb.maxLng);
    audit(req, 'create', 'fiber_route#' + info.lastInsertRowid, b.name);
    res.json({ id: info.lastInsertRowid, length_m: lineLengthM(cs) });
  });
  app.put('/api/fiber/routes/:id', requireNoc, (req, res) => {
    const ex = db.prepare('SELECT * FROM fiber_routes WHERE id=?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    let geom = ex.geom_json, len = ex.length_m;
    let bb = { minLat: ex.min_lat, minLng: ex.min_lng, maxLat: ex.max_lat, maxLng: ex.max_lng };
    if (b.geometry !== undefined) {
      const cs = lineCoords(b.geometry);
      if (!cs) return res.status(400).json({ error: 'Route needs at least two points' });
      geom = JSON.stringify({ type: 'LineString', coordinates: cs }); len = lineLengthM(cs);
      bb = bboxOf(cs) || { minLat: null, minLng: null, maxLat: null, maxLng: null };
    }
    // Slack: blank/absent means "inherit the system default", which is different from 0%.
    let slack = ex.slack_pct;
    if (b.slack_pct !== undefined) {
      const v = Number(b.slack_pct);
      slack = (b.slack_pct === '' || b.slack_pct === null || !Number.isFinite(v)) ? null
        : Math.max(0, Math.min(99, v));
    }
    // Measured fibre length. Normally written by the importer from the source system, but editable
    // so a known-bad figure can be corrected or cleared rather than silently skewing distances.
    let fibre = ex.fibre_m;
    if (b.fibre_m !== undefined) {
      const v = Number(b.fibre_m);
      fibre = (b.fibre_m === '' || b.fibre_m === null || !Number.isFinite(v) || v <= 0) ? null : v;
    }
    db.prepare('UPDATE fiber_routes SET name=?, status=?, placement=?, owner=?, length_m=?, geom_json=?, notes=?, min_lat=?, min_lng=?, max_lat=?, max_lng=?, slack_pct=?, fibre_m=? WHERE id=?')
      .run(N(b.name, ex.name), ROUTE_STATUS.includes(b.status) ? b.status : ex.status, N(b.placement, ex.placement),
        N(b.owner, ex.owner), len, geom, N(b.notes, ex.notes),
        bb.minLat, bb.minLng, bb.maxLat, bb.maxLng, slack, fibre, ex.id);
    audit(req, 'edit', 'fiber_route#' + ex.id, b.name || ex.name);
    res.json({ ok: true, length_m: len });
  });
  app.delete('/api/fiber/routes/:id', requireNoc, (req, res) => {
    const n = db.prepare('SELECT COUNT(*) n FROM fiber_cables WHERE route_id=?').get(req.params.id).n;
    if (n) return res.status(409).json({ error: `${n} cable(s) run on this route — delete or move them first` });
    db.prepare('DELETE FROM fiber_routes WHERE id=?').run(req.params.id);
    deleteAttachmentsFor('route', req.params.id);
    audit(req, 'delete', 'fiber_route#' + req.params.id);
    res.json({ ok: true });
  });

  // ---- structures (handholes, vaults, poles, cabinets…) ----
  app.get('/api/fiber/structures', (req, res) => res.json(db.prepare('SELECT * FROM fiber_structures ORDER BY name').all()));
  app.get('/api/fiber/structures/:id', (req, res) => {
    const s2 = db.prepare('SELECT * FROM fiber_structures WHERE id=?').get(req.params.id);
    if (!s2) return res.status(404).json({ error: 'not found' });
    s2.attachments = attachmentsFor('structure', s2.id);
    s2.splices = db.prepare('SELECT * FROM fiber_splices WHERE structure_id=?').all(s2.id).map(x => ({ ...x, attachments: attachmentsFor('splice', x.id) }));
    res.json(s2);
  });
  app.post('/api/fiber/structures', requireNoc, (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'Structure name required' });
    if (!Number.isFinite(+b.lat) || !Number.isFinite(+b.lng)) return res.status(400).json({ error: 'Place the structure on the map' });
    const info = db.prepare('INSERT INTO fiber_structures (name,kind,lat,lng,site_id,pop_id,status,notes) VALUES (?,?,?,?,?,?,?,?)')
      .run(String(b.name).slice(0, 160), STRUCTURE_KINDS.includes(b.kind) ? b.kind : 'handhole', +b.lat, +b.lng,
        b.site_id ? Number(b.site_id) : null, b.pop_id ? Number(b.pop_id) : null,
        ROUTE_STATUS.includes(b.status) ? b.status : 'as_built', N(b.notes) || null);
    audit(req, 'create', 'fiber_structure#' + info.lastInsertRowid, b.name);
    res.json({ id: info.lastInsertRowid });
  });
  app.put('/api/fiber/structures/:id', requireNoc, (req, res) => {
    const ex = db.prepare('SELECT * FROM fiber_structures WHERE id=?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    db.prepare('UPDATE fiber_structures SET name=?, kind=?, lat=?, lng=?, site_id=?, pop_id=?, status=?, notes=? WHERE id=?')
      .run(N(b.name, ex.name), STRUCTURE_KINDS.includes(b.kind) ? b.kind : ex.kind,
        Number.isFinite(+b.lat) ? +b.lat : ex.lat, Number.isFinite(+b.lng) ? +b.lng : ex.lng,
        b.site_id !== undefined ? (b.site_id ? Number(b.site_id) : null) : ex.site_id,
        b.pop_id !== undefined ? (b.pop_id ? Number(b.pop_id) : null) : ex.pop_id,
        ROUTE_STATUS.includes(b.status) ? b.status : ex.status, N(b.notes, ex.notes), ex.id);
    audit(req, 'edit', 'fiber_structure#' + ex.id, b.name || ex.name);
    res.json({ ok: true });
  });
  app.delete('/api/fiber/structures/:id', requireNoc, (req, res) => {
    const n = db.prepare('SELECT COUNT(*) n FROM fiber_splices WHERE structure_id=?').get(req.params.id).n;
    if (n) return res.status(409).json({ error: `${n} splice(s) recorded here — remove them first` });
    db.prepare('UPDATE fiber_cables SET a_structure_id=NULL WHERE a_structure_id=?').run(req.params.id);
    db.prepare('UPDATE fiber_cables SET z_structure_id=NULL WHERE z_structure_id=?').run(req.params.id);
    db.prepare('DELETE FROM fiber_structures WHERE id=?').run(req.params.id);
    deleteAttachmentsFor('structure', req.params.id);
    audit(req, 'delete', 'fiber_structure#' + req.params.id);
    res.json({ ok: true });
  });

  // ---- cables (strands are generated automatically) ----
  app.get('/api/fiber/cables', (req, res) => {
    const rows = db.prepare(`SELECT c.*, r.name AS route_name,
        a.name AS a_structure_name, z.name AS z_structure_name
      FROM fiber_cables c
      LEFT JOIN fiber_routes r ON r.id=c.route_id
      LEFT JOIN fiber_structures a ON a.id=c.a_structure_id
      LEFT JOIN fiber_structures z ON z.id=c.z_structure_id ORDER BY c.name`).all();
    res.json(rows.map(cableSummary));
  });
  app.get('/api/fiber/cables/:id', (req, res) => {
    const c = db.prepare(`SELECT c.*, r.name AS route_name, r.geom_json,
        a.name AS a_structure_name, z.name AS z_structure_name
      FROM fiber_cables c
      LEFT JOIN fiber_routes r ON r.id=c.route_id
      LEFT JOIN fiber_structures a ON a.id=c.a_structure_id
      LEFT JOIN fiber_structures z ON z.id=c.z_structure_id WHERE c.id=?`).get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const out = cableSummary(c);
    out.geometry = safeJson(c.geom_json); delete out.geom_json;
    out.strands = db.prepare('SELECT * FROM fiber_strands WHERE cable_id=? ORDER BY position').all(c.id);
    out.attachments = attachmentsFor('cable', c.id);
    // splices touching this cable, so the strand grid can show what each fibre lands on
    out.splices = db.prepare(`SELECT s.*, st.name AS structure_name FROM fiber_splices s
      LEFT JOIN fiber_structures st ON st.id=s.structure_id
      WHERE s.a_strand_id IN (SELECT id FROM fiber_strands WHERE cable_id=?)
         OR s.z_strand_id IN (SELECT id FROM fiber_strands WHERE cable_id=?)`).all(c.id, c.id)
      .map(s2 => ({ ...s2, attachments: attachmentsFor('splice', s2.id) }));
    res.json(out);
  });
  app.post('/api/fiber/cables', requireNoc, (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'Cable name required' });
    const count = Math.min(Math.max(parseInt(b.strand_count, 10) || 12, 1), 864);
    const info = db.prepare('INSERT INTO fiber_cables (name,route_id,strand_count,cable_type,a_structure_id,z_structure_id,status,notes) VALUES (?,?,?,?,?,?,?,?)')
      .run(String(b.name).slice(0, 160), b.route_id ? Number(b.route_id) : null, count, N(b.cable_type) || null,
        b.a_structure_id ? Number(b.a_structure_id) : null, b.z_structure_id ? Number(b.z_structure_id) : null,
        ROUTE_STATUS.includes(b.status) ? b.status : 'as_built', N(b.notes) || null);
    generateStrands(info.lastInsertRowid, count);
    audit(req, 'create', 'fiber_cable#' + info.lastInsertRowid, `${b.name} (${count}ct)`);
    res.json({ id: info.lastInsertRowid, strand_count: count });
  });
  app.put('/api/fiber/cables/:id', requireNoc, (req, res) => {
    const ex = db.prepare('SELECT * FROM fiber_cables WHERE id=?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    db.prepare('UPDATE fiber_cables SET name=?, route_id=?, cable_type=?, a_structure_id=?, z_structure_id=?, status=?, notes=? WHERE id=?')
      .run(N(b.name, ex.name), b.route_id !== undefined ? (b.route_id ? Number(b.route_id) : null) : ex.route_id,
        N(b.cable_type, ex.cable_type),
        b.a_structure_id !== undefined ? (b.a_structure_id ? Number(b.a_structure_id) : null) : ex.a_structure_id,
        b.z_structure_id !== undefined ? (b.z_structure_id ? Number(b.z_structure_id) : null) : ex.z_structure_id,
        ROUTE_STATUS.includes(b.status) ? b.status : ex.status, N(b.notes, ex.notes), ex.id);
    // growing a cable adds strands; shrinking is refused if the doomed strands are in use
    const want = b.strand_count === undefined ? ex.strand_count : Math.min(Math.max(parseInt(b.strand_count, 10) || ex.strand_count, 1), 864);
    if (want > ex.strand_count) {
      const ins = db.prepare('INSERT INTO fiber_strands (cable_id,position,tube,tube_color,color) VALUES (?,?,?,?,?)');
      for (let p = ex.strand_count + 1; p <= want; p++) { const c = strandColor(p); ins.run(ex.id, p, c.tube, c.tube_color, c.color); }
      db.prepare('UPDATE fiber_cables SET strand_count=? WHERE id=?').run(want, ex.id);
    } else if (want < ex.strand_count) {
      const inUse = db.prepare("SELECT COUNT(*) n FROM fiber_strands WHERE cable_id=? AND position>? AND status!='free'").get(ex.id, want).n;
      if (inUse) return res.status(409).json({ error: `${inUse} strand(s) above position ${want} are in use — free them first` });
      db.prepare('DELETE FROM fiber_strands WHERE cable_id=? AND position>?').run(ex.id, want);
      db.prepare('UPDATE fiber_cables SET strand_count=? WHERE id=?').run(want, ex.id);
    }
    audit(req, 'edit', 'fiber_cable#' + ex.id, b.name || ex.name);
    res.json({ ok: true });
  });
  app.delete('/api/fiber/cables/:id', requireNoc, (req, res) => {
    const ids = db.prepare('SELECT id FROM fiber_strands WHERE cable_id=?').all(req.params.id).map(x => x.id);
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM fiber_splices WHERE a_strand_id IN (${ph}) OR z_strand_id IN (${ph})`).run(...ids, ...ids);
    }
    db.prepare('DELETE FROM fiber_strands WHERE cable_id=?').run(req.params.id);
    db.prepare('DELETE FROM fiber_cables WHERE id=?').run(req.params.id);
    deleteAttachmentsFor('cable', req.params.id);
    audit(req, 'delete', 'fiber_cable#' + req.params.id);
    res.json({ ok: true });
  });

  // ---- strands ----
  app.put('/api/fiber/strands/:id', requireNoc, (req, res) => {
    const ex = db.prepare('SELECT * FROM fiber_strands WHERE id=?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const status = STRAND_STATUS.includes(b.status) ? b.status : ex.status;
    db.prepare('UPDATE fiber_strands SET status=?, assigned_type=?, assigned_id=?, label=?, notes=? WHERE id=?')
      .run(status, b.assigned_type !== undefined ? (N(b.assigned_type) || null) : ex.assigned_type,
        b.assigned_id !== undefined ? (b.assigned_id ? Number(b.assigned_id) : null) : ex.assigned_id,
        b.label !== undefined ? (N(b.label) || null) : ex.label,
        b.notes !== undefined ? (N(b.notes) || null) : ex.notes, ex.id);
    res.json({ ok: true });
  });
  // bulk range assignment — "strands 1-12 to Tower A" is how this work is actually done
  app.post('/api/fiber/cables/:id/strands/assign', requireNoc, (req, res) => {
    const b = req.body || {};
    const cable = db.prepare('SELECT * FROM fiber_cables WHERE id=?').get(req.params.id);
    if (!cable) return res.status(404).json({ error: 'not found' });
    const from = Math.max(1, parseInt(b.from, 10) || 1);
    const to = Math.min(cable.strand_count, parseInt(b.to, 10) || from);
    if (to < from) return res.status(400).json({ error: 'End of range is before the start' });
    const status = STRAND_STATUS.includes(b.status) ? b.status : 'assigned';
    const info = db.prepare('UPDATE fiber_strands SET status=?, assigned_type=?, assigned_id=?, label=? WHERE cable_id=? AND position BETWEEN ? AND ?')
      .run(status, N(b.assigned_type) || null, b.assigned_id ? Number(b.assigned_id) : null, N(b.label) || null, cable.id, from, to);
    audit(req, 'edit', 'fiber_cable#' + cable.id, `strands ${from}-${to} → ${status}${b.label ? ' (' + b.label + ')' : ''}`);
    res.json({ ok: true, updated: info.changes, from, to });
  });

  // ---- splices ----
  app.post('/api/fiber/splices', requireNoc, (req, res) => {
    const b = req.body || {};
    const a = db.prepare('SELECT * FROM fiber_strands WHERE id=?').get(b.a_strand_id);
    if (!a) return res.status(400).json({ error: 'Pick the A-side strand' });
    const z = b.z_strand_id ? db.prepare('SELECT * FROM fiber_strands WHERE id=?').get(b.z_strand_id) : null;
    if (b.z_strand_id && !z) return res.status(400).json({ error: 'Z-side strand not found' });
    if (z && z.id === a.id) return res.status(400).json({ error: 'A strand cannot be spliced to itself' });
    const dup = db.prepare('SELECT id FROM fiber_splices WHERE (a_strand_id=? AND z_strand_id=?) OR (a_strand_id=? AND z_strand_id=?)')
      .get(a.id, z ? z.id : null, z ? z.id : null, a.id);
    if (dup) return res.status(409).json({ error: 'That splice already exists' });
    const info = db.prepare('INSERT INTO fiber_splices (structure_id,a_strand_id,z_strand_id,splice_type,tray,loss_db,notes) VALUES (?,?,?,?,?,?,?)')
      .run(b.structure_id ? Number(b.structure_id) : null, a.id, z ? z.id : null,
        SPLICE_TYPES.includes(b.splice_type) ? b.splice_type : 'fusion', N(b.tray) || null,
        b.loss_db != null && b.loss_db !== '' ? r2(b.loss_db) : null, N(b.notes) || null);
    audit(req, 'create', 'fiber_splice#' + info.lastInsertRowid, `strand#${a.id}${z ? ' ↔ strand#' + z.id : ''}`);
    res.json({ id: info.lastInsertRowid });
  });
  app.delete('/api/fiber/splices/:id', requireNoc, (req, res) => {
    db.prepare('DELETE FROM fiber_splices WHERE id=?').run(req.params.id);
    deleteAttachmentsFor('splice', req.params.id);
    audit(req, 'delete', 'fiber_splice#' + req.params.id);
    res.json({ ok: true });
  });

  // Follow a strand through splices end to end — the question this whole module exists to answer.
  app.get('/api/fiber/strands/:id/trace', (req, res) => {
    const start = db.prepare('SELECT * FROM fiber_strands WHERE id=?').get(req.params.id);
    if (!start) return res.status(404).json({ error: 'not found' });
    const hop = [], seen = new Set();
    let cur = start;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      const cable = db.prepare('SELECT id,name,strand_count FROM fiber_cables WHERE id=?').get(cur.cable_id) || {};
      hop.push({ strand_id: cur.id, position: cur.position, color: cur.color, tube: cur.tube, status: cur.status, label: cur.label, cable_id: cable.id, cable_name: cable.name });
      const sp = db.prepare(`SELECT s.*, st.name AS structure_name FROM fiber_splices s LEFT JOIN fiber_structures st ON st.id=s.structure_id
        WHERE (s.a_strand_id=? OR s.z_strand_id=?)`).all(cur.id, cur.id)
        .find(s => { const other = s.a_strand_id === cur.id ? s.z_strand_id : s.a_strand_id; return other && !seen.has(other); });
      if (!sp) break;
      hop[hop.length - 1].splice = { type: sp.splice_type, at: sp.structure_name || null, tray: sp.tray || null };
      const nextId = sp.a_strand_id === cur.id ? sp.z_strand_id : sp.a_strand_id;
      cur = nextId ? db.prepare('SELECT * FROM fiber_strands WHERE id=?').get(nextId) : null;
    }
    res.json({ hops: hop, terminated: hop.length > 0 && !hop[hop.length - 1].splice });
  });

  // ---- map feed: everything as one GeoJSON FeatureCollection ----
  /**
   * Plant as GeoJSON for the map.
   *
   * Unfiltered this returns everything, which after a statewide import is ~95 MB and 17 s — enough
   * to hang the browser. So the map sends its viewport and zoom, and we return only what's visible,
   * simplified to that zoom and capped. Called without params the behaviour is unchanged, which
   * keeps small deployments and the existing tests working.
   *   ?bbox=minLng,minLat,maxLng,maxLat   only plant intersecting this box
   *   ?zoom=13                            geometry detail to match (higher = more detail)
   *   ?limit=4000                         hard cap; `truncated` says whether it bit
   */
  /**
   * Extent of the plant, so the map can frame it without downloading any geometry.
   * Trimmed to the bulk of the data: a handful of imported spans have corrupt paths that jump
   * continents, and framing on the true min/max would open the map on half the globe.
   */
  app.get('/api/fiber/extent', (req, res) => {
    const boxes = db.prepare('SELECT min_lat AS minLat, min_lng AS minLng, max_lat AS maxLat, max_lng AS maxLng FROM fiber_routes WHERE min_lat IS NOT NULL').all();
    for (const s of db.prepare('SELECT lat, lng FROM fiber_structures WHERE lat IS NOT NULL AND lng IS NOT NULL').all())
      boxes.push({ minLat: s.lat, minLng: s.lng, maxLat: s.lat, maxLng: s.lng });
    const e = robustExtent(boxes);
    if (!e) return res.json({ empty: true });
    res.json({ empty: false, bbox: [e.minLat, e.minLng, e.maxLat, e.maxLng], outliers: e.outliers, total: e.total });
  });

  app.get('/api/fiber/geojson', (req, res) => {
    const bbox = String(req.query.bbox || '').split(',').map(Number);
    const hasBox = bbox.length === 4 && bbox.every(Number.isFinite);
    const zoom = Number(req.query.zoom);
    const limit = Math.min(Math.max(Number(req.query.limit) || 4000, 1), 20000);
    // One screen pixel in degrees at this zoom — simplifying below that is invisible.
    const tol = Number.isFinite(zoom) ? 360 / (256 * Math.pow(2, Math.min(zoom, 22))) : 0;

    const features = [];
    let truncated = false;

    // Strand totals in one pass instead of a query per route (7,964 of them after the AZ import).
    const cableAgg = new Map();
    for (const c of db.prepare('SELECT route_id, COUNT(*) n, COALESCE(SUM(strand_count),0) s FROM fiber_cables WHERE route_id IS NOT NULL GROUP BY route_id').all())
      cableAgg.set(c.route_id, c);

    const routeSql = hasBox
      ? `SELECT id,name,status,placement,length_m,geom_json FROM fiber_routes
         WHERE min_lat IS NOT NULL AND min_lat <= ? AND max_lat >= ? AND min_lng <= ? AND max_lng >= ? LIMIT ?`
      : 'SELECT id,name,status,placement,length_m,geom_json FROM fiber_routes LIMIT ?';
    const routes = hasBox
      ? db.prepare(routeSql).all(bbox[3], bbox[1], bbox[2], bbox[0], limit + 1)
      : db.prepare(routeSql).all(limit + 1);
    if (routes.length > limit) { routes.length = limit; truncated = true; }

    // Pad the clip box by a screen-ish margin so lines still run off the edge when panning.
    const padLng = hasBox ? (bbox[2] - bbox[0]) * 0.15 : 0, padLat = hasBox ? (bbox[3] - bbox[1]) * 0.15 : 0;
    const clipBox = hasBox ? { minLng: bbox[0] - padLng, minLat: bbox[1] - padLat, maxLng: bbox[2] + padLng, maxLat: bbox[3] + padLat } : null;

    for (const r of routes) {
      const g = safeJson(r.geom_json); if (!g) continue;
      let geom = g;
      if (g.type === 'LineString') {
        // Clip first (drops the out-of-view bulk), then simplify what's left.
        let parts = clipBox ? clipPathToBox(g.coordinates, clipBox) : [g.coordinates];
        if (!parts.length) continue;
        if (tol > 0) parts = parts.map(p => simplifyPath(p, tol));
        geom = parts.length === 1
          ? { type: 'LineString', coordinates: parts[0] }
          : { type: 'MultiLineString', coordinates: parts };
      }
      const agg = cableAgg.get(r.id);
      features.push({ type: 'Feature', geometry: geom, properties: { kind: 'route', id: r.id, name: r.name, status: r.status, placement: r.placement, length_m: r.length_m, cables: agg ? agg.n : 0, strand_total: agg ? agg.s : 0 } });
    }

    const structSql = hasBox
      ? 'SELECT id,name,kind,lat,lng,status FROM fiber_structures WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? LIMIT ?'
      : 'SELECT id,name,kind,lat,lng,status FROM fiber_structures WHERE lat IS NOT NULL AND lng IS NOT NULL LIMIT ?';
    const structs = hasBox
      ? db.prepare(structSql).all(bbox[1], bbox[3], bbox[0], bbox[2], limit + 1)
      : db.prepare(structSql).all(limit + 1);
    if (structs.length > limit) { structs.length = limit; truncated = true; }
    for (const s of structs)
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] }, properties: { kind: 'structure', id: s.id, name: s.name, structure_kind: s.kind, status: s.status } });

    res.json({ type: 'FeatureCollection', features, truncated });
  });

  // ---- import: GeoJSON, KML, or KMZ (Google Earth) ----
  // Text formats arrive in `data`; KMZ is binary so the browser sends it base64 in `data_b64`.
  // Accepts either JSON ({data} text / {data_b64} binary) or — preferred for big files — the raw
  // bytes with any non-JSON content type plus ?commit=&status=&structure_kind= in the query.
  // Raw avoids base64's ~33% inflation, which matters for multi-MB KMZ/shapefile exports.
  const rawIfNotJson = express.raw({ type: req => !/application\/json/i.test(req.headers['content-type'] || ''), limit: '64mb' });
  app.post('/api/fiber/import', requireNoc, rawIfNotJson, (req, res) => {
    const isRaw = Buffer.isBuffer(req.body);
    const b = isRaw
      ? { commit: req.query.commit === '1' || req.query.commit === 'true', status: req.query.status, structure_kind: req.query.structure_kind }
      : (req.body || {});
    const up = parseUpload(isRaw ? req.body : (b.data_b64 ? { b64: b.data_b64 } : { text: typeof b.data === 'string' ? b.data : JSON.stringify(b.data || '') }));
    if (up.error) return res.status(400).json({ error: up.error });
    const { format, parsed } = up;
    if (!parsed.routes.length && !parsed.structures.length) return res.status(400).json({ error: `No routes or points found in that ${format} file` });
    const status = ROUTE_STATUS.includes(b.status) ? b.status : 'as_built';
    const cablesIn = parsed.cables || [];
    const result = { format, routes_found: parsed.routes.length, structures_found: parsed.structures.length, cables_found: cablesIn.length, circuits_found: (parsed.circuits || []).length, routes_created: 0, structures_created: 0, cables_created: 0, circuits_created: 0, circuits_skipped: 0, strands_created: 0, strands_assigned: 0, skipped: 0, total_length_m: 0 };
    if (!b.commit) { // dry run so the operator can look before importing
      result.total_length_m = parsed.routes.reduce((n, r) => n + lineLengthM(r.coordinates), 0);
      result.samples = {
        routes: parsed.routes.slice(0, 5).map(r => ({ name: r.name, points: r.coordinates.length, length_m: r.length_m != null ? r.length_m : lineLengthM(r.coordinates) })),
        structures: parsed.structures.slice(0, 5).map(s => ({ name: s.name, kind: s.kind })),
        cables: cablesIn.slice(0, 5).map(c => ({ name: c.name, strand_count: c.strand_count, assign: c.assign ? `${c.assign.from}-${c.assign.to}` : null, label: c.assign_label }))
      };
      result.strands_created = cablesIn.reduce((n, c) => n + (c.strand_count || 0), 0);
      return res.json({ ok: true, committed: false, ...result });
    }
    // ext_ref (source system id) makes re-import idempotent; fall back to name for formats
    // that carry no stable identifier.
    const routeIdByRef = new Map(), structIdByRef = new Map();
    const insR = db.prepare('INSERT INTO fiber_routes (name,status,placement,owner,geom_json,length_m,notes,ext_ref,min_lat,min_lng,max_lat,max_lng,fibre_m) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const r of parsed.routes) {
      const existing = r.ext_ref
        ? db.prepare('SELECT id FROM fiber_routes WHERE ext_ref=?').get(r.ext_ref)
        : db.prepare('SELECT id FROM fiber_routes WHERE name=?').get(r.name);
      if (existing) { if (r.ext_ref) routeIdByRef.set(r.ext_ref, existing.id); result.skipped++; continue; }
      const len = r.length_m != null ? r.length_m : lineLengthM(r.coordinates);
      const rbb = bboxOf(r.coordinates);
      const info = insR.run(String(r.name).slice(0, 160), ROUTE_STATUS.includes(r.status) ? r.status : status,
        r.placement || N(b.placement) || null, r.owner || null,
        JSON.stringify({ type: 'LineString', coordinates: r.coordinates }), len, r.notes, r.ext_ref || null,
        rbb && rbb.minLat, rbb && rbb.minLng, rbb && rbb.maxLat, rbb && rbb.maxLng,
        // Measured fibre length, where the source gave one. Only IQGeo does today; a KML or
        // shapefile has no such field, so those routes fall back to the chosen slack percentage.
        r.fibre_m != null ? r.fibre_m : null);
      if (r.ext_ref) routeIdByRef.set(r.ext_ref, info.lastInsertRowid);
      result.routes_created++; result.total_length_m += len;
    }
    const insS = db.prepare('INSERT INTO fiber_structures (name,kind,lat,lng,status,notes,ext_ref) VALUES (?,?,?,?,?,?,?)');
    for (const s of parsed.structures) {
      const existing = s.ext_ref
        ? db.prepare('SELECT id FROM fiber_structures WHERE ext_ref=?').get(s.ext_ref)
        : db.prepare('SELECT id FROM fiber_structures WHERE name=? AND lat=? AND lng=?').get(s.name, s.lat, s.lng);
      if (existing) { if (s.ext_ref) structIdByRef.set(s.ext_ref, existing.id); result.skipped++; continue; }
      const kind = STRUCTURE_KINDS.includes(s.kind) ? s.kind : (STRUCTURE_KINDS.includes(b.structure_kind) ? b.structure_kind : 'handhole');
      const info = insS.run(String(s.name).slice(0, 160), kind, s.lat, s.lng, status, s.notes, s.ext_ref || null);
      if (s.ext_ref) structIdByRef.set(s.ext_ref, info.lastInsertRowid);
      result.structures_created++;
    }
    // Circuits: an IQGeo span carrying a CID is a real circuit. Create it first so the strands
    // below can point at it (assigned_type='circuit'), which is what makes "who is on this fibre"
    // answerable from either direction.
    const circuitIdByRef = new Map();
    const insCk = db.prepare(`INSERT INTO circuits (label,a_type,a_ref_id,z_type,z_ref_id,circuit_id,ctype,status,notes,install_date,ext_ref)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const ck of (parsed.circuits || [])) {
      const found = db.prepare('SELECT id FROM circuits WHERE ext_ref=? OR (circuit_id IS NOT NULL AND circuit_id=?)').get(ck.ext_ref, ck.circuit_id);
      if (found) { circuitIdByRef.set(ck.ext_ref, found.id); result.skipped++; continue; }
      const aId = structIdByRef.get(ck.a_structure_ref) || null;
      const zId = structIdByRef.get(ck.z_structure_ref) || null;
      // circuits need two endpoints; skip rather than invent one if the structures didn't import
      if (!aId || !zId) { result.circuits_skipped++; continue; }
      const info = insCk.run(String(ck.label || ck.circuit_id).slice(0, 160), 'structure', aId, 'structure', zId,
        ck.circuit_id, ck.ctype || null, CIRCUIT_STATUSES.includes(ck.status) ? ck.status : 'Up',
        ck.notes || null, ck.install_date || null, ck.ext_ref);
      circuitIdByRef.set(ck.ext_ref, info.lastInsertRowid);
      result.circuits_created++;
    }
    // Cables (IQGeo spans): create with the real strand count, then mark the lit range assigned.
    const insC = db.prepare('INSERT INTO fiber_cables (name,route_id,strand_count,cable_type,a_structure_id,z_structure_id,status,notes,ext_ref) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const c of cablesIn) {
      if (c.ext_ref && db.prepare('SELECT id FROM fiber_cables WHERE ext_ref=?').get(c.ext_ref)) { result.skipped++; continue; }
      const count = Math.min(Math.max(parseInt(c.strand_count, 10) || 12, 1), 864);
      const info = insC.run(String(c.name).slice(0, 160),
        c.route_ext_ref ? (routeIdByRef.get(c.route_ext_ref) || null) : null, count, c.cable_type || null,
        structIdByRef.get(c.a_structure_ref) || null, structIdByRef.get(c.z_structure_ref) || null,
        ROUTE_STATUS.includes(c.status) ? c.status : status, c.notes || null, c.ext_ref || null);
      const cableId = info.lastInsertRowid;
      generateStrands(cableId, count);
      result.cables_created++; result.strands_created += count;
      if (c.assign && c.assign.from >= 1 && c.assign.to <= count) {
        const ckId = c.circuit_ext_ref ? (circuitIdByRef.get(c.circuit_ext_ref) || null) : null;
        const n = db.prepare("UPDATE fiber_strands SET status='assigned', label=?, assigned_type=?, assigned_id=? WHERE cable_id=? AND position BETWEEN ? AND ?")
          .run(c.assign_label || null, ckId ? 'circuit' : null, ckId, cableId, c.assign.from, c.assign.to).changes;
        result.strands_assigned += n;
      }
    }
    audit(req, 'import', 'fiber', `${result.routes_created} route(s), ${result.structures_created} structure(s), ${result.cables_created} cable(s), ${result.circuits_created} circuit(s) from ${result.format}`);
    res.json({ ok: true, committed: true, ...result });
  });

  // summary for the dashboard/nav
  app.get('/api/fiber/summary', (req, res) => {
    const routes = db.prepare('SELECT COUNT(*) n, IFNULL(SUM(length_m),0) m FROM fiber_routes').get();
    const built = db.prepare("SELECT COUNT(*) n, IFNULL(SUM(length_m),0) m FROM fiber_routes WHERE status='as_built'").get();
    const strands = db.prepare('SELECT status, COUNT(*) n FROM fiber_strands GROUP BY status').all();
    const by = {}; strands.forEach(s => by[s.status] = s.n);
    res.json({
      routes: routes.n, route_km: r2(routes.m / 1000), as_built_km: r2(built.m / 1000),
      structures: db.prepare('SELECT COUNT(*) n FROM fiber_structures').get().n,
      cables: db.prepare('SELECT COUNT(*) n FROM fiber_cables').get().n,
      splices: db.prepare('SELECT COUNT(*) n FROM fiber_splices').get().n,
      strands: by, strand_total: Object.values(by).reduce((a, b2) => a + b2, 0)
    });
  });
}
