// Unified search, coordinate parsing and proximity lookup.
import { parseCoords, haversineM, distanceToLineM, pointToSegmentM, bboxOf, degBox, fmtDistance,
         simplifyPath, clipPathToBox, robustExtent } from '../lib/geo.js';
const B = process.env.BASE ?? 'http://localhost:3000'; let cookie = '';
async function call(p, { method = 'GET', body } = {}) { const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; method = method === 'GET' ? 'POST' : method; } if (cookie) h.cookie = cookie; const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, t }; }
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

// ---- coordinate parsing (pure) ----
{
  const near = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;
  const P = parseCoords;
  ok(near(P('33.4484, -112.0740').lat, 33.4484) && near(P('33.4484, -112.0740').lng, -112.0740), 'decimal pair with comma');
  ok(near(P('33.4484 -112.0740').lng, -112.0740), 'decimal pair separated by a space');
  ok(near(P('-33.8688,151.2093').lat, -33.8688), 'southern/eastern hemisphere signs');
  ok(near(P('N33.4484 W112.0740').lng, -112.0740), 'leading hemisphere letters');
  ok(near(P('33.4484N 112.0740W').lng, -112.0740), 'trailing hemisphere letters');
  ok(near(P('W112.0740 N33.4484').lat, 33.4484), 'lng-first is detected and swapped');
  ok(P(`33°26'54.2"N 112°04'26.4"W`).format === 'dms' && near(P(`33°26'54.2"N 112°04'26.4"W`).lat, 33.44839), 'DMS with symbols');
  ok(P('33 26.903 N, 112 04.440 W').format === 'ddm' && near(P('33 26.903 N, 112 04.440 W').lat, 33.44838), 'degrees + decimal minutes');
  ok(P('33.4484') === null, 'a single number is not a coordinate');
  ok(P('91.0, -112.0') === null, 'latitude beyond 90 rejected');
  ok(P('33.4484, -200') === null, 'longitude beyond 180 rejected');
  ok(P('N33 N112') === null, 'two latitudes rejected');
  ok(P('-33N, -112W') === null, 'sign contradicting the hemisphere letter rejected');
  ok(P('33 61.0 N, 112 04 W') === null, 'minutes >= 60 rejected rather than folded in');
  ok(P('F17L-0044605') === null && P('Phoenix') === null && P('') === null, 'asset names and empty input are not coordinates');
}

// ---- distance maths (pure) ----
{
  ok(Math.abs(haversineM(0, 0, 1, 0) - 111195) < 400, 'one degree of latitude ≈ 111.2 km');
  ok(Math.abs(haversineM(33.4484, -112.0740, 32.2226, -110.9747) - 170700) < 2000, 'Phoenix→Tucson ≈ 170.7 km');
  ok(haversineM(33.4, -112.1, 33.4, -112.1) === 0, 'zero distance to itself');
  // A point 0.005° north of an east-west line ≈ 553 m away.
  const line = [[-112.08, 33.44], [-112.06, 33.44]];
  const d = distanceToLineM(33.4450, -112.07, line);
  ok(Math.abs(d.m - 553) < 15, 'perpendicular distance to a line segment');
  ok(Math.abs(d.lat - 33.44) < 1e-5, 'closest point lands on the line, not an endpoint');
  // Beyond the end of the segment the nearest point must be the endpoint, not the infinite line.
  const off = distanceToLineM(33.44, -112.00, line);
  ok(Math.abs(off.lng - (-112.06)) < 1e-5, 'past the end of a segment clamps to the endpoint');
  ok(distanceToLineM(33, -112, []) === null && distanceToLineM(33, -112, null) === null, 'empty geometry gives null, not a false 0 m');
  const s = pointToSegmentM(33.44, -112.07, 33.44, -112.08, 33.44, -112.06);
  ok(s.m < 1, 'a point on the segment is ~0 m from it');

  const bb = bboxOf([[-112.08, 33.44], [-112.06, 33.46], [-112.10, 33.42]]);
  ok(bb.minLat === 33.42 && bb.maxLat === 33.46 && bb.minLng === -112.10 && bb.maxLng === -112.06, 'bbox spans all vertices');
  ok(bboxOf([['x', 'y']]) === null, 'bbox of junk coordinates is null');
  const g = degBox(33.45, 1000);
  ok(Math.abs(g.dLat - 0.00904) < 1e-4 && g.dLng > g.dLat, 'degree box: longitude degrees are shorter at this latitude');
  ok(fmtDistance(420) === '420 m' && fmtDistance(1500) === '1.50 km' && fmtDistance(42000) === '42.0 km', 'distance formatting');
}

// ---- geometry reduction for the map (pure) ----
{
  // A straight line sampled at 100 points collapses to its two endpoints.
  const straight = Array.from({ length: 100 }, (_, i) => [-112 + i * 0.001, 33]);
  ok(simplifyPath(straight, 0.0001).length === 2, 'a straight line simplifies to two points');
  // A genuine corner must survive.
  const bend = [[-112, 33], [-111.99, 33], [-111.99, 33.01]];
  ok(simplifyPath(bend, 0.0001).length === 3, 'a real corner is kept');
  const sp = simplifyPath(straight, 0.0001);
  ok(sp[0][0] === straight[0][0] && sp[sp.length - 1][0] === straight[straight.length - 1][0], 'endpoints are never dropped');
  ok(simplifyPath(straight, 0).length === 100 && simplifyPath([[0, 0], [1, 1]], 1).length === 2, 'zero tolerance and 2-point paths pass through');
  // Big tolerance must not produce a degenerate 1-point line.
  ok(simplifyPath(bend, 999).length === 2, 'an extreme tolerance still leaves a drawable 2-point line');

  const box = { minLng: -112.01, minLat: 32.99, maxLng: -111.99, maxLat: 33.01 };
  // Line crossing the box from far outside on both sides.
  const cross = [[-113, 33], [-112.5, 33], [-112, 33], [-111.5, 33], [-111, 33]];
  const cl = clipPathToBox(cross, box);
  ok(cl.length === 1, 'a line crossing the box yields one piece');
  ok(cl[0].length === 3 && cl[0][0][0] === -112.5 && cl[0][2][0] === -111.5, 'clip keeps one vertex either side so the line reaches the edge');
  ok(clipPathToBox([[-120, 10], [-119, 10]], box).length === 0, 'a line nowhere near the box is dropped entirely');
  // Exits and re-enters — must come back as two pieces, not one line cutting the corner.
  const inOut = [[-112, 33], [-110, 33], [-112, 33.005]];
  ok(clipPathToBox(inOut, box).length === 2, 'a line that leaves and returns yields two pieces');

  const boxes = [
    ...Array.from({ length: 98 }, () => ({ minLat: 33, minLng: -112, maxLat: 33.5, maxLng: -111.5 })),
    { minLat: 43.7, minLng: -79.5, maxLat: 48.9, maxLng: 2.2 },       // the corrupt cross-continent span
    { minLat: -60, minLng: -179, maxLat: -59, maxLng: -178 }          // and one in the far south-west
  ];
  const e = robustExtent(boxes);
  ok(e.maxLat < 40 && e.maxLng < -100, 'robust extent ignores a continent-spanning outlier');
  ok(e.minLat > 30 && e.minLng < -100, 'and ignores one at the opposite extreme');
  ok(e.outliers >= 1 && e.total === 100, 'outliers are counted, not silently dropped');
  ok(robustExtent([]) === null, 'no geometry gives a null extent rather than NaN bounds');
}

// ---- API ----
await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });

// Fixtures with known positions, ~250 m apart along a line.
const pop = (await call('/api/pops', { body: { name: 'SEARCH-POP-A', code: 'SPA', address: '1 Test Way', lat: 33.4500, lng: -112.0700, status: 'active' } })).json;
const st = (await call('/api/fiber/structures', { body: { name: 'SEARCH-HH-1', kind: 'handhole', lat: 33.4520, lng: -112.0700 } })).json;
const far = (await call('/api/fiber/structures', { body: { name: 'SEARCH-HH-FAR', kind: 'vault', lat: 33.5400, lng: -112.0700 } })).json;
const rt = (await call('/api/fiber/routes', { body: { name: 'SEARCH-ROUTE-1', status: 'as_built', geometry: { type: 'LineString', coordinates: [[-112.0800, 33.4510], [-112.0600, 33.4510]] } } })).json;
ok(pop && pop.id && st && st.id && rt && rt.id, 'fixtures created');

{
  const r = (await call('/api/search?q=SEARCH-POP-A')).json;
  const g = r.groups.find(x => x.type === 'pop');
  ok(g && g.items[0].title === 'SEARCH-POP-A', 'search finds a POP by name');
  ok(g.items[0].href === '#/pop/' + pop.id && g.items[0].lat === 33.45, 'POP hit carries href and coordinates');
}
{
  const r = (await call('/api/search?q=SEARCH-')).json;
  const types = r.groups.map(g => g.type);
  ok(types.includes('pop') && types.includes('structure') && types.includes('route'), 'one query spans several entity types');
  ok(r.groups.every(g => g.items.length <= 6), 'each group is capped so one type cannot crowd out the rest');
}
{
  const r = (await call('/api/search?q=' + encodeURIComponent('33.4484, -112.0740'))).json;
  ok(r.coords && Math.abs(r.coords.lat - 33.4484) < 1e-6, 'search reports parsed coordinates alongside asset hits');
}
ok((await call('/api/search?q=x')).json.groups.length === 0, 'a single character returns nothing rather than everything');
{
  // A LIKE wildcard typed by the user must be matched literally, not treated as "match all".
  const r = (await call('/api/search?q=' + encodeURIComponent('%'))).json;
  ok(r.groups.length === 0 || r.groups.every(g => g.items.every(i => /%/.test(i.title + i.subtitle))), 'percent sign is escaped, not a wildcard');
}
{
  const r = (await call('/api/search?q=SEARCH-POP-A')).json;
  const flat = JSON.stringify(r);
  ok(!/password|portal_password|pin"|admin_password|wg_private/i.test(flat), 'search results carry no credential fields');
}

// ---- nearby ----
{
  const r = (await call(`/api/nearby?lat=33.4500&lng=-112.0700&radius=500`)).json;
  const names = r.items.map(i => i.title);
  ok(names.includes('SEARCH-POP-A'), 'nearby finds the POP at the query point');
  ok(names.includes('SEARCH-HH-1'), 'nearby finds a structure ~222 m away');
  ok(!names.includes('SEARCH-HH-FAR'), 'a structure 10 km away is excluded at 500 m radius');
  ok(names.includes('SEARCH-ROUTE-1'), 'nearby finds a route by perpendicular distance, not just its vertices');
  const dists = r.items.map(i => i.distance_m);
  ok(dists.every((d, i) => i === 0 || d >= dists[i - 1]), 'results are ordered nearest first');
  const hh = r.items.find(i => i.title === 'SEARCH-HH-1');
  ok(Math.abs(hh.distance_m - 222) < 15, 'reported distance is accurate (~222 m)');
}
{
  const wide = (await call(`/api/nearby?lat=33.4500&lng=-112.0700&radius=15000`)).json;
  ok(wide.items.some(i => i.title === 'SEARCH-HH-FAR'), 'widening the radius reaches the far structure');
}
ok((await call('/api/nearby?lat=abc&lng=-112')).status === 400, 'nearby rejects a non-numeric latitude');
ok((await call('/api/nearby?lat=95&lng=-112')).status === 400, 'nearby rejects an out-of-range latitude');
{
  const r = (await call('/api/nearby?lat=33.45&lng=-112.07&radius=99999999')).json;
  ok(r.radius_m <= 20000, 'radius is clamped so one request cannot scan the whole plant');
}

// ---- locate ----
{
  const r = (await call('/api/locate?q=' + encodeURIComponent('33.4500, -112.0700') + '&radius=500')).json;
  ok(r.kind === 'coords' && Math.abs(r.lat - 33.45) < 1e-6, 'locate resolves a coordinate string');
  ok(Array.isArray(r.nearby) && r.nearby.some(i => i.title === 'SEARCH-POP-A'), 'locate returns nearby plant with the point');
  ok(r.nearby_counts && typeof r.nearby_counts === 'object', 'locate reports per-type totals');
}
ok((await call('/api/locate?q=')).status === 400, 'locate requires a query');

// ---- co-located structures collapse ----
{
  // Three structures on one coordinate, as IQGeo produces for equipment inside a building.
  for (const n of ['COLO-A', 'COLO-B', 'COLO-C'])
    await call('/api/fiber/structures', { body: { name: n, kind: 'cabinet', lat: 34.1000, lng: -111.5000 } });
  const r = (await call('/api/nearby?lat=34.1000&lng=-111.5000&radius=100')).json;
  const rows = r.items.filter(i => i.type === 'structure');
  ok(rows.length === 1, 'three structures on one spot collapse to a single row');
  ok(rows[0].colocated === 3, 'the row reports how many are stacked there');
  ok(rows[0].members && rows[0].members.length === 2, 'the others are carried as members so the UI can expand them');
  ok(r.counts.structure === 3, 'the true count is still reported');
}

// ---- map payload: viewport filtering, clipping, extent ----
{
  // A long route that crosses a small viewport, with lots of vertices well outside it.
  // Deliberately wiggly: a perfectly straight line simplifies to 2 points at any tolerance, which
  // would make the zoom-detail assertion below vacuous.
  const long = [];
  for (let i = 0; i <= 400; i++) long.push([-113 + i * 0.005, 33.4510 + (i % 2 ? 0.0004 : -0.0004)]);
  await call('/api/fiber/routes', { body: { name: 'LONGHAUL-1', status: 'as_built', geometry: { type: 'LineString', coordinates: long } } });

  const all = (await call('/api/fiber/geojson')).json;
  ok(all.features.length > 0 && all.truncated === false, 'unfiltered geojson still works for small deployments');

  const box = '-112.075,33.4495,-112.070,33.4525';
  const win = (await call(`/api/fiber/geojson?bbox=${box}&zoom=18`)).json;
  const lh = win.features.find(f => f.properties.name === 'LONGHAUL-1');
  ok(!!lh, 'a route crossing the viewport is returned');
  const pts = lh.geometry.type === 'LineString' ? lh.geometry.coordinates.length
    : lh.geometry.coordinates.reduce((n, p) => n + p.length, 0);
  ok(pts < 20, `route geometry is clipped to the viewport (${pts} points, not ${long.length})`);
  ok(!win.features.some(f => f.properties.name === 'SEARCH-HH-FAR'), 'a structure outside the viewport is excluded');

  const far = (await call('/api/fiber/geojson?bbox=10,10,11,11&zoom=14')).json;
  ok(far.features.length === 0, 'a viewport with no plant returns nothing');

  const lo = (await call(`/api/fiber/geojson?bbox=-113,33,-111,34&zoom=8`)).json;
  const hi = (await call(`/api/fiber/geojson?bbox=-113,33,-111,34&zoom=16`)).json;
  const count = g => g.features.reduce((n, f) => n + (f.geometry.type === 'LineString' ? f.geometry.coordinates.length : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.reduce((m, p) => m + p.length, 0) : 1), 0);
  ok(count(lo) < count(hi), 'lower zoom returns less geometry detail than higher zoom');

  // Two routes exist by now (SEARCH-ROUTE-1 and LONGHAUL-1), so a limit of 1 must bite.
  const cap = (await call('/api/fiber/geojson?limit=1')).json;
  ok(cap.truncated === true, 'limit reports truncation when there is more than it will return');
  ok(cap.features.filter(f => f.properties.kind === 'route').length === 1, 'limit caps the routes returned');

  const ext = (await call('/api/fiber/extent')).json;
  ok(ext.empty === false && ext.bbox.length === 4, 'extent returns a bounding box');
  ok(ext.bbox[0] < ext.bbox[2] && ext.bbox[1] < ext.bbox[3], 'extent min is below max on both axes');
}

// ---- role gating ----
{
  cookie = ''; await call('/api/login', { body: { email: 'support@geekitek.test', password: 'support123' } });
  const r = (await call('/api/search?q=SEARCH-')).json;
  ok(!r.groups.some(g => g.type === 'account'), 'support role does not see the Accounts group');
  ok(r.groups.some(g => g.type === 'pop'), 'support role still gets non-privileged groups');
}

console.log('\nRESULT:', pass, 'passed,', fail, 'failed'); process.exit(fail ? 1 : 0);
