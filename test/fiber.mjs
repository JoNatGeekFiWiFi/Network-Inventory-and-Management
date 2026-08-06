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

console.log('\nRESULT:', pass, 'passed,', fail, 'failed'); process.exit(fail ? 1 : 0);
