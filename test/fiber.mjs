// Fiber plant: routes, cables, TIA-598-C strand generation, assignments, splices, trace, import.
import { strandColor, lineLengthM, parseKml, parseGeoJson } from '../domains/fiber.js';
const B = process.env.BASE ?? 'http://localhost:3000'; let cookie = '';
async function call(p, { method = 'GET', body } = {}) { const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; method = method === 'GET' ? 'POST' : method; } if (cookie) h.cookie = cookie; const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, t }; }
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

// ---- pure helpers (no server needed) ----
ok(strandColor(1).color === 'Blue' && strandColor(1).tube === 1, 'strand 1 = Blue, tube 1');
ok(strandColor(12).color === 'Aqua' && strandColor(12).tube === 1, 'strand 12 = Aqua, tube 1');
ok(strandColor(13).color === 'Blue' && strandColor(13).tube === 2, 'strand 13 wraps to Blue in tube 2');
ok(strandColor(27).color === 'Green' && strandColor(27).tube === 3, 'strand 27 = Green, tube 3');
ok(strandColor(144).color === 'Aqua' && strandColor(144).tube === 12, 'strand 144 = Aqua, tube 12 (full 144ct)');
ok(strandColor(145).tube === 13 && /\/Black/.test(strandColor(145).tube_color), 'tube 13 gets a black tracer stripe (>144ct)');
ok(strandColor(1).tube_color === 'Blue', 'tube 1 colour is Blue');
// ~111km along a degree of latitude
ok(Math.abs(lineLengthM([[0, 0], [0, 1]]) - 111195) < 500, 'line length ≈ 111km per degree of latitude');

// KML parsing (Google Earth export shape)
{
  const kml = `<?xml version="1.0"?><kml><Document>
    <Placemark><name>Main St Fiber</name><description>144ct backbone</description>
      <LineString><coordinates>-112.1,33.5,0 -112.2,33.6,0 -112.3,33.7,0</coordinates></LineString></Placemark>
    <Placemark><name>HH-101</name><Point><coordinates>-112.15,33.55,0</coordinates></Point></Placemark>
  </Document></kml>`;
  const p = parseKml(kml);
  ok(p.routes.length === 1 && p.routes[0].coordinates.length === 3, 'KML LineString → route with 3 points');
  ok(p.routes[0].name === 'Main St Fiber' && p.routes[0].notes === '144ct backbone', 'KML name + description carried over');
  ok(p.structures.length === 1 && p.structures[0].lat === 33.55, 'KML Point → structure with lat/lng');
}
// GeoJSON parsing
{
  const gj = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { name: 'Route A' }, geometry: { type: 'LineString', coordinates: [[-112, 33], [-112.1, 33.1]] } },
    { type: 'Feature', properties: { name: 'Vault 9' }, geometry: { type: 'Point', coordinates: [-112.05, 33.05] } },
    { type: 'Feature', properties: { name: 'Multi' }, geometry: { type: 'MultiLineString', coordinates: [[[-1, 1], [-1.1, 1.1]], [[-2, 2], [-2.1, 2.1]]] } } ] };
  const p = parseGeoJson(gj);
  ok(p.routes.length === 3, 'GeoJSON: LineString + MultiLineString(2) → 3 routes');
  ok(p.structures.length === 1, 'GeoJSON Point → structure');
}

// ---- API ----
await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });

// route
let r = await call('/api/fiber/routes', { method: 'POST', body: { name: 'POP-A to Cabinet-1', status: 'as_built', placement: 'buried', geometry: { type: 'LineString', coordinates: [[-112.1, 33.5], [-112.2, 33.6]] } } });
ok(r.status === 200 && r.json.length_m > 0, `route created with computed length (${r.json && r.json.length_m}m)`);
const routeId = r.json.id;
ok((await call('/api/fiber/routes', { method: 'POST', body: { name: 'Bad', geometry: { type: 'LineString', coordinates: [[-112, 33]] } } })).status === 400, 'single-point route rejected');
ok((await call('/api/fiber/routes', { method: 'POST', body: { name: 'NoGeom' } })).status === 400, 'route without geometry rejected');

// structures
const st1 = (await call('/api/fiber/structures', { method: 'POST', body: { name: 'HH-1', kind: 'handhole', lat: 33.5, lng: -112.1 } })).json.id;
const st2 = (await call('/api/fiber/structures', { method: 'POST', body: { name: 'HH-2', kind: 'vault', lat: 33.6, lng: -112.2 } })).json.id;
ok(st1 > 0 && st2 > 0, 'structures created');
ok((await call('/api/fiber/structures', { method: 'POST', body: { name: 'NoWhere' } })).status === 400, 'structure without coordinates rejected');

// cable — strands auto-generate
r = await call('/api/fiber/cables', { method: 'POST', body: { name: 'BB-144-01', route_id: routeId, strand_count: 144, a_structure_id: st1, z_structure_id: st2 } });
const cableId = r.json.id;
ok(r.json.strand_count === 144, 'cable created as 144ct');
let cable = (await call('/api/fiber/cables/' + cableId)).json;
ok(cable.strands.length === 144, '144 strands auto-generated');
ok(cable.strands[0].color === 'Blue' && cable.strands[0].tube === 1, 'strand 1 stored as Blue/tube 1');
ok(cable.strands[26].color === 'Green' && cable.strands[26].tube === 3, 'strand 27 stored as Green/tube 3');
ok(cable.strands_free === 144, 'all strands start free');

// range assignment — how the work is actually done
r = await call('/api/fiber/cables/' + cableId + '/strands/assign', { method: 'POST', body: { from: 1, to: 12, status: 'assigned', label: 'Tower A' } });
ok(r.json.updated === 12, 'assigned strands 1-12 in one call');
cable = (await call('/api/fiber/cables/' + cableId)).json;
ok(cable.strands_used === 12 && cable.strands_free === 132, 'counts reflect the assignment');
ok(cable.strands[0].label === 'Tower A' && cable.strands[0].status === 'assigned', 'label + status stored');
// abandoned strands must be representable (mid-span cuts leave them)
await call('/api/fiber/cables/' + cableId + '/strands/assign', { method: 'POST', body: { from: 13, to: 24, status: 'abandoned' } });
cable = (await call('/api/fiber/cables/' + cableId)).json;
ok(cable.strand_counts.abandoned === 12, 'abandoned status supported');

// second cable + splice between them
const cable2 = (await call('/api/fiber/cables', { method: 'POST', body: { name: 'DIST-48-01', strand_count: 48, a_structure_id: st2 } })).json.id;
const c1 = (await call('/api/fiber/cables/' + cableId)).json.strands[0];      // BB strand 1
const c2 = (await call('/api/fiber/cables/' + cable2)).json.strands[0];       // DIST strand 1
r = await call('/api/fiber/splices', { method: 'POST', body: { structure_id: st2, a_strand_id: c1.id, z_strand_id: c2.id, splice_type: 'fusion', tray: 'T1', loss_db: 0.15 } });
ok(r.status === 200, 'splice created between two cables');
ok((await call('/api/fiber/splices', { method: 'POST', body: { a_strand_id: c1.id, z_strand_id: c2.id } })).status === 409, 'duplicate splice rejected');
ok((await call('/api/fiber/splices', { method: 'POST', body: { a_strand_id: c1.id, z_strand_id: c1.id } })).status === 400, 'self-splice rejected');

// trace follows the splice across cables
const tr = (await call('/api/fiber/strands/' + c1.id + '/trace')).json;
ok(tr.hops.length === 2, `trace crosses the splice (${tr.hops.length} hops)`);
ok(tr.hops[0].cable_name === 'BB-144-01' && tr.hops[1].cable_name === 'DIST-48-01', 'trace names both cables in order');
ok(tr.hops[0].splice && tr.hops[0].splice.type === 'fusion', 'trace reports the splice type');

// shrinking a cable below in-use strands is refused
ok((await call('/api/fiber/cables/' + cableId, { method: 'PUT', body: { strand_count: 6 } })).status === 409, 'cannot shrink a cable past strands in use');
// growing works and colours continue correctly
await call('/api/fiber/cables/' + cable2, { method: 'PUT', body: { strand_count: 96 } });
const grown = (await call('/api/fiber/cables/' + cable2)).json;
ok(grown.strands.length === 96 && grown.strands[95].color === 'Aqua' && grown.strands[95].tube === 8, 'grown cable keeps correct TIA colours');

// route delete blocked while cables ride it
ok((await call('/api/fiber/routes/' + routeId, { method: 'DELETE' })).status === 409, 'route with cables cannot be deleted');
// structure delete blocked while splices reference it
ok((await call('/api/fiber/structures/' + st2, { method: 'DELETE' })).status === 409, 'structure with splices cannot be deleted');

// map feed
const gj = (await call('/api/fiber/geojson')).json;
ok(gj.type === 'FeatureCollection' && gj.features.some(f => f.properties.kind === 'route') && gj.features.some(f => f.properties.kind === 'structure'), 'geojson feed returns routes + structures');

// import: dry run then commit
const kml = `<kml><Placemark><name>Imported Run</name><LineString><coordinates>-112.4,33.8 -112.5,33.9</coordinates></LineString></Placemark>
<Placemark><name>HH-Imported</name><Point><coordinates>-112.45,33.85</coordinates></Point></Placemark></kml>`;
r = await call('/api/fiber/import', { method: 'POST', body: { data: kml, commit: false } });
ok(r.json.format === 'kml' && r.json.routes_found === 1 && r.json.routes_created === 0, 'import dry-run reports without writing');
r = await call('/api/fiber/import', { method: 'POST', body: { data: kml, commit: true } });
ok(r.json.routes_created === 1 && r.json.structures_created === 1, 'import commit creates route + structure');
r = await call('/api/fiber/import', { method: 'POST', body: { data: kml, commit: true } });
ok(r.json.routes_created === 0 && r.json.skipped === 2, 're-import skips duplicates by name');
ok((await call('/api/fiber/import', { method: 'POST', body: { data: 'not json or kml' } })).status === 400, 'garbage import rejected');

// summary
const sum = (await call('/api/fiber/summary')).json;
ok(sum.cables === 2 && sum.splices === 1 && sum.route_km > 0, `summary totals (cables ${sum.cables}, km ${sum.route_km})`);

// NOC gating
cookie = ''; await call('/api/login', { body: { email: 'support@geekitek.test', password: 'support123' } });
ok((await call('/api/fiber/routes', { method: 'POST', body: { name: 'x', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } } })).status === 403, 'route create is NOC-only');
ok((await call('/api/fiber/geojson')).status === 200, 'map feed readable by non-NOC staff');


// ---- KMZ (zipped KML) ----
// Build genuine ZIP archives so this exercises the real reader, not a stub.
import { deflateRawSync } from 'node:zlib';
import { extractKmlFromKmz, looksLikeZip, listZipEntries } from '../lib/unzip.js';
function crc32(buf) {
  let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  let crc = 0xFFFFFFFF; for (const b of buf) crc = t[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(files) { // files: [{name, data:Buffer, store?:bool}]
  const locals = [], central = []; let off = 0;
  for (const f of files) {
    const store = !!f.store;
    const comp = store ? f.data : deflateRawSync(f.data);
    const name = Buffer.from(f.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(store ? 0 : 8, 8); lh.writeUInt32LE(crc32(f.data), 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(store ? 0 : 8, 10); ch.writeUInt32LE(crc32(f.data), 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central), lo = Buffer.concat(locals);
  const eo = Buffer.alloc(22);
  eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(files.length, 8); eo.writeUInt16LE(files.length, 10);
  eo.writeUInt32LE(cd.length, 12); eo.writeUInt32LE(lo.length, 16);
  return Buffer.concat([lo, cd, eo]);
}
const kmzDoc = `<?xml version="1.0"?><kml><Document>
  <Placemark><name>KMZ Route</name><LineString><coordinates>-112.6,33.1 -112.7,33.2 -112.8,33.3</coordinates></LineString></Placemark>
  <Placemark><name>KMZ Vault</name><Point><coordinates>-112.65,33.15</coordinates></Point></Placemark>
</Document></kml>`;

// unit: reader handles deflate, stored, nested paths, and rejects non-zips
{
  const z = makeZip([{ name: 'doc.kml', data: Buffer.from(kmzDoc) }]);
  ok(looksLikeZip(z), 'KMZ magic detected');
  ok(extractKmlFromKmz(z).includes('KMZ Route'), 'deflated doc.kml extracted');
  const stored = makeZip([{ name: 'doc.kml', data: Buffer.from(kmzDoc), store: true }]);
  ok(extractKmlFromKmz(stored).includes('KMZ Route'), 'stored (uncompressed) entry extracted');
  const multi = makeZip([{ name: 'images/logo.png', data: Buffer.from([1, 2, 3]) }, { name: 'doc.kml', data: Buffer.from(kmzDoc) }]);
  ok(listZipEntries(multi).length === 2, 'multi-entry archive listed');
  ok(extractKmlFromKmz(multi).includes('KMZ Route'), 'doc.kml found past other files');
  const noKml = makeZip([{ name: 'readme.txt', data: Buffer.from('hi') }]);
  let threw = false; try { extractKmlFromKmz(noKml); } catch { threw = true; }
  ok(threw, 'archive with no .kml rejected');
  ok(!looksLikeZip(Buffer.from('<kml></kml>')), 'plain KML not mistaken for a ZIP');
}
// end-to-end through the import endpoint
{
  cookie = ''; await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });
  const b64 = makeZip([{ name: 'doc.kml', data: Buffer.from(kmzDoc) }]).toString('base64');
  let r = await call('/api/fiber/import', { method: 'POST', body: { data_b64: b64, commit: false } });
  ok(r.json.format === 'kmz' && r.json.routes_found === 1 && r.json.structures_found === 1, 'KMZ dry-run detects format + contents');
  r = await call('/api/fiber/import', { method: 'POST', body: { data_b64: b64, commit: true } });
  ok(r.json.routes_created === 1 && r.json.structures_created === 1, 'KMZ import creates route + structure');
  r = await call('/api/fiber/import', { method: 'POST', body: { data_b64: b64, commit: true } });
  ok(r.json.skipped === 2, 'KMZ re-import skips duplicates');
  const junk = Buffer.from('PK\u0003\u0004totally-not-a-zip').toString('base64');
  ok((await call('/api/fiber/import', { method: 'POST', body: { data_b64: junk } })).status === 400, 'corrupt KMZ rejected with 400');
}


// ---- Shapefile / GPX / CSV ----
import { parseShp, parseDbf, shapefileToFeatures, looksProjected } from '../lib/shapefile.js';
import { parseGpx, parseCsv } from '../domains/fiber.js';

// Build a real .shp (and matching .dbf) so this exercises the actual binary parser.
function makeShp(shapes) { // shapes: [{type:'Point',coords:[x,y]} | {type:'Line',coords:[[x,y],...]}]
  const recs = [];
  shapes.forEach((s, i) => {
    let content;
    if (s.type === 'Point') { content = Buffer.alloc(20); content.writeInt32LE(1, 0); content.writeDoubleLE(s.coords[0], 4); content.writeDoubleLE(s.coords[1], 12); }
    else {
      const n = s.coords.length;
      content = Buffer.alloc(44 + 4 + n * 16);
      content.writeInt32LE(3, 0);                     // PolyLine
      content.writeInt32LE(1, 36); content.writeInt32LE(n, 40); content.writeInt32LE(0, 44);
      s.coords.forEach((c, j) => { content.writeDoubleLE(c[0], 48 + j * 16); content.writeDoubleLE(c[1], 48 + j * 16 + 8); });
    }
    const hdr = Buffer.alloc(8); hdr.writeInt32BE(i + 1, 0); hdr.writeInt32BE(content.length / 2, 4);
    recs.push(hdr, content);
  });
  const body = Buffer.concat(recs);
  const head = Buffer.alloc(100); head.writeInt32BE(9994, 0); head.writeInt32BE((100 + body.length) / 2, 24); head.writeInt32LE(1000, 28);
  return Buffer.concat([head, body]);
}
function makeDbf(rows, field = 'NAME', width = 20) {
  const headerLen = 32 + 32 + 1, recordLen = 1 + width;
  const h = Buffer.alloc(headerLen); h[0] = 3;
  h.writeInt32LE(rows.length, 4); h.writeInt16LE(headerLen, 8); h.writeInt16LE(recordLen, 10);
  h.write(field.padEnd(11, '\0'), 32, 'latin1'); h.write('C', 43, 'latin1'); h[48] = width;
  h[64] = 0x0d;
  const recs = rows.map(v => { const b = Buffer.alloc(recordLen, 0x20); b.write(String(v).slice(0, width), 1, 'latin1'); return b; });
  return Buffer.concat([h, ...recs, Buffer.from([0x1a])]);
}

{
  const shp = makeShp([{ type: 'Line', coords: [[-112.9, 33.9], [-112.95, 33.95]] }, { type: 'Point', coords: [-112.92, 33.92] }]);
  const parsedShapes = parseShp(shp);
  ok(parsedShapes.length === 2 && parsedShapes[0].type === 'LineString' && parsedShapes[1].type === 'Point', 'shp parser reads PolyLine + Point');
  ok(Math.abs(parsedShapes[1].coordinates[0] + 112.92) < 1e-9, 'shp point coordinates exact');
  const dbf = makeDbf(['Feeder A', 'HH-77']);
  const attrs = parseDbf(dbf);
  ok(attrs.length === 2 && attrs[0].NAME === 'Feeder A', 'dbf attribute table parsed');
  const feats = shapefileToFeatures(shp, dbf);
  ok(feats.routes.length === 1 && feats.routes[0].name === 'Feeder A', 'shapefile route takes its name from the dbf');
  ok(feats.structures.length === 1 && feats.structures[0].name === 'HH-77', 'shapefile point takes its name from the dbf');
  ok(shapefileToFeatures(shp, null).routes[0].name.startsWith('Route'), 'shapefile without dbf falls back to generated names');
  // projected coordinates must be refused, not silently mis-placed
  const proj = makeShp([{ type: 'Line', coords: [[656123.4, 3712345.6], [656200.1, 3712400.2]] }]);
  ok(looksProjected(parseShp(proj)), 'projected coordinates detected');
  let threw = ''; try { shapefileToFeatures(proj, null); } catch (e) { threw = e.message; }
  ok(/WGS84|projected/i.test(threw), 'projected shapefile rejected with a clear message');

  // through the API: zipped .shp + .dbf
  cookie = ''; await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });
  const zipped = makeZip([{ name: 'plant.shp', data: shp }, { name: 'plant.dbf', data: dbf }, { name: 'plant.prj', data: Buffer.from('GEOGCS["WGS 84"]') }]).toString('base64');
  let rr = await call('/api/fiber/import', { method: 'POST', body: { data_b64: zipped, commit: false } });
  ok(rr.json.format === 'shapefile' && rr.json.routes_found === 1 && rr.json.structures_found === 1, 'zipped shapefile detected and previewed');
  rr = await call('/api/fiber/import', { method: 'POST', body: { data_b64: zipped, commit: true } });
  ok(rr.json.routes_created === 1 && rr.json.structures_created === 1, 'zipped shapefile imported');
  // bare .shp (no dbf)
  rr = await call('/api/fiber/import', { method: 'POST', body: { data_b64: makeShp([{ type: 'Line', coords: [[-113.1, 34.1], [-113.2, 34.2]] }]).toString('base64'), commit: true } });
  ok(rr.json.format === 'shapefile' && rr.json.routes_created === 1, 'bare .shp imported without a dbf');
  // projected shapefile refused end to end
  rr = await call('/api/fiber/import', { method: 'POST', body: { data_b64: proj.toString('base64') } });
  ok(rr.status === 400 && /WGS84/i.test(rr.json.error), 'projected shapefile refused by the API');
}

// GPX
{
  const gpx = `<?xml version="1.0"?><gpx version="1.1">
    <wpt lat="33.71" lon="-112.71"><name>Pole 12</name><desc>riser</desc></wpt>
    <trk><name>Aerial Run</name><trkseg><trkpt lat="33.7" lon="-112.7"/><trkpt lat="33.72" lon="-112.72"/><trkpt lat="33.74" lon="-112.74"/></trkseg></trk>
  </gpx>`;
  const g = parseGpx(gpx);
  ok(g.routes.length === 1 && g.routes[0].coordinates.length === 3 && g.routes[0].name === 'Aerial Run', 'GPX track → route with all points');
  ok(g.structures.length === 1 && g.structures[0].name === 'Pole 12', 'GPX waypoint → structure');
  ok(g.routes[0].coordinates[0][0] === -112.7 && g.routes[0].coordinates[0][1] === 33.7, 'GPX coordinates are lng,lat ordered');
  const rr = await call('/api/fiber/import', { method: 'POST', body: { data: gpx, commit: true } });
  ok(rr.json.format === 'gpx' && rr.json.routes_created === 1 && rr.json.structures_created === 1, 'GPX imported via API');
}

// CSV
{
  const csv = 'name,lat,lng,kind,notes\n"HH-200",33.61,-112.61,handhole,"corner of 3rd"\n"Vault 9",33.62,-112.62,vault,\n';
  const c = parseCsv(csv);
  ok(c.structures.length === 2 && c.structures[0].name === 'HH-200' && c.structures[0].kind === 'handhole', 'CSV lat/lng rows → structures with kind');
  ok(c.structures[0].notes === 'corner of 3rd', 'CSV quoted field with a comma handled');
  const wkt = 'name,wkt\n"WKT Route","LINESTRING(-112.8 33.8, -112.85 33.85)"\n';
  ok(parseCsv(wkt).routes.length === 1, 'CSV WKT LINESTRING → route');
  let rr = await call('/api/fiber/import', { method: 'POST', body: { data: csv, commit: true } });
  ok(rr.json.format === 'csv' && rr.json.structures_created === 2, 'CSV imported via API');
  // per-row kind is honoured
  const made = (await call('/api/fiber/structures')).json.find(s => s.name === 'Vault 9');
  ok(made && made.kind === 'vault', 'CSV per-row structure kind applied');
}

// unknown format
ok((await call('/api/fiber/import', { method: 'POST', body: { data: 'just some prose with no structure' } })).status === 400, 'unrecognised file rejected with guidance');


// ---- photos + documents on cables, splices, structures, routes ----
{
  cookie = ''; await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });
  const png = 'data:image/png;base64,' + Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]).toString('base64');
  const pdf = Buffer.from('%PDF-1.4 fake').toString('base64');

  // cable
  let a = await call('/api/attachments', { method: 'POST', body: { parent_type: 'cable', parent_id: cableId, filename: 'tray.png', mime: 'image/png', data: png, caption: 'Tray 1 after splicing' } });
  ok(a.status === 200 && a.json.id > 0, 'photo attached to a cable');
  const photoId = a.json.id;
  const withAtt = (await call('/api/fiber/cables/' + cableId)).json;
  ok(withAtt.attachments.length === 1 && withAtt.attachments[0].caption === 'Tray 1 after splicing', 'cable detail returns its attachments + caption');

  // splice
  const spliceId = withAtt.splices[0].id;
  a = await call('/api/attachments', { method: 'POST', body: { parent_type: 'splice', parent_id: spliceId, filename: 'otdr.sor', mime: 'application/octet-stream', data: Buffer.from('OTDR').toString('base64') } });
  ok(a.status === 200, 'OTDR trace attached to a splice');
  const spliceDoc = a.json.id;
  const c2b = (await call('/api/fiber/cables/' + cableId)).json;
  ok(c2b.splices[0].attachments.length === 1, 'splice attachments come back on the cable detail');

  // structure + route
  ok((await call('/api/attachments', { method: 'POST', body: { parent_type: 'structure', parent_id: st1, filename: 'hh.png', mime: 'image/png', data: png } })).status === 200, 'photo attached to a structure');
  ok((await call('/api/fiber/structures/' + st1)).json.attachments.length === 1, 'structure detail returns attachments');
  ok((await call('/api/attachments', { method: 'POST', body: { parent_type: 'route', parent_id: routeId, filename: 'permit.pdf', mime: 'application/pdf', data: pdf } })).status === 200, 'PDF attached to a route');
  ok((await call('/api/fiber/routes/' + routeId)).json.attachments.length === 1, 'route detail returns attachments');

  // list endpoint
  const listed = (await call('/api/attachments?parent_type=cable&parent_id=' + cableId)).json;
  ok(Array.isArray(listed) && listed.length === 1, 'attachment list endpoint filters by parent');
  ok((await call('/api/attachments?parent_type=bogus&parent_id=1')).status === 400, 'unknown parent type rejected');

  // caption edit
  await call('/api/attachments/' + photoId, { method: 'PUT', body: { caption: 'Updated caption' } });
  ok((await call('/api/attachments?parent_type=cable&parent_id=' + cableId)).json[0].caption === 'Updated caption', 'caption can be edited');

  // serving: images inline, documents forced to download (so nothing executes in our origin)
  let raw = await fetch(B + '/api/attachments/' + photoId, { headers: { cookie } });
  ok(raw.headers.get('content-disposition').startsWith('inline'), 'image served inline');
  ok(raw.headers.get('x-content-type-options') === 'nosniff', 'nosniff header present');
  raw = await fetch(B + '/api/attachments/' + spliceDoc, { headers: { cookie } });
  ok(raw.headers.get('content-disposition').startsWith('attachment'), 'non-image document forced to download');

  // rejects
  ok((await call('/api/attachments', { method: 'POST', body: { parent_type: 'cable', parent_id: cableId, filename: 'x.svg', mime: 'image/svg+xml', data: png } })).status === 400, 'SVG (script-capable) rejected');
  ok((await call('/api/attachments', { method: 'POST', body: { parent_type: 'cable', parent_id: cableId, filename: 'e.png', mime: 'image/png', data: '' } })).status === 400, 'empty file rejected');

  // deleting the parent removes its files
  const doomed = (await call('/api/fiber/cables', { method: 'POST', body: { name: 'TEMP-12', strand_count: 12 } })).json.id;
  await call('/api/attachments', { method: 'POST', body: { parent_type: 'cable', parent_id: doomed, filename: 'x.png', mime: 'image/png', data: png } });
  ok((await call('/api/attachments?parent_type=cable&parent_id=' + doomed)).json.length === 1, 'temp cable has an attachment');
  await call('/api/fiber/cables/' + doomed, { method: 'DELETE' });
  ok((await call('/api/attachments?parent_type=cable&parent_id=' + doomed)).json.length === 0, 'deleting a cable cascades its attachments away');
}


// ---- realistic Google Earth KMZ (nested Folders, styles, CDATA, MultiGeometry) ----
{
  cookie = ''; await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });
  const realKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document><name>Plant.kmz</name>
 <Style id="s_ylw"><LineStyle><color>ff00ffff</color><width>3</width></LineStyle></Style>
 <Folder><name>Backbone</name>
  <Placemark><name>GE Main 144ct</name><description><![CDATA[<b>144 count</b>]]></description><styleUrl>#s_ylw</styleUrl>
   <LineString><tessellate>1</tessellate><coordinates>
     -112.074036,33.448376,0 -112.070000,33.450000,0
     -112.065000,33.452000,0
   </coordinates></LineString></Placemark>
  <Folder><name>Laterals</name>
   <Placemark><name>GE 3rd Ave</name><LineString><coordinates>-112.06,33.45,0 -112.061,33.455,0</coordinates></LineString></Placemark>
  </Folder>
 </Folder>
 <Folder><name>Structures</name>
  <Placemark><name>GE HH-204</name><Point><coordinates>-112.07,33.45,0</coordinates></Point></Placemark>
 </Folder>
</Document></kml>`;
  const p2 = parseKml(realKml);
  ok(p2.routes.length === 2, 'KML: placemarks found inside nested <Folder> elements');
  ok(p2.routes[0].coordinates.length === 3, 'KML: coordinates split across newlines/indentation parsed');
  ok(p2.routes[0].notes.includes('144 count'), 'KML: CDATA description preserved');
  ok(p2.structures.length === 1 && p2.structures[0].name === 'GE HH-204', 'KML: point inside a folder found');
  // and the same content zipped as a KMZ, through the endpoint
  const b64 = makeZip([{ name: 'doc.kml', data: Buffer.from(realKml) }]).toString('base64');
  const rr = await call('/api/fiber/import', { method: 'POST', body: { data_b64: b64, commit: true } });
  ok(rr.json.format === 'kmz' && rr.json.routes_created === 2 && rr.json.structures_created === 1, 'realistic KMZ imports 2 routes + 1 structure');
}

console.log('\nRESULT:', pass, 'passed,', fail, 'failed'); process.exit(fail ? 1 : 0);
