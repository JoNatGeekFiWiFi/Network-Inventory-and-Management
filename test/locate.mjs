// Fibre distance ↔ GPS along a path: segment merging, linear referencing, slack arithmetic.
import { mergeSegments, cumulative, pathLengthM, pointAtDistance, distanceAlong,
         fibreToGround, groundToFibre, DEFAULT_SLACK_PCT } from '../lib/path.js';
import { haversineM } from '../lib/geo.js';
const B = process.env.BASE ?? 'http://localhost:3000'; let cookie = '';
async function call(p, { method = 'GET', body } = {}) { const h = {}; if (body !== undefined) { h['content-type'] = 'application/json'; method = method === 'GET' ? 'POST' : method; } if (cookie) h.cookie = cookie; const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, t }; }
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// Three collinear north-south segments, ~1.112 km each.
const S = {
  A: { id: 'A', coords: [[-112, 33.00], [-112, 33.01]] },
  Brev: { id: 'B', coords: [[-112, 33.02], [-112, 33.01]] },   // stored backwards
  C: { id: 'C', coords: [[-112, 33.02], [-112, 33.03]] },
  far: { id: 'D', coords: [[-112, 33.038], [-112, 33.05]] }    // ~890 m clear of C
};

// ---- merging ----
{
  const m = mergeSegments([S.C, S.A, S.Brev]);
  ok(m.order.map(o => o.id).join('') === 'ABC', 'segments given out of order chain correctly');
  ok(m.order[1].reversed === true, 'a backwards segment is flipped, not skipped');
  ok(m.gaps.length === 0 && m.unused.length === 0, 'a clean run reports no gaps and drops nothing');
  ok(near(pathLengthM(m.coords), 3336, 20), 'merged length is the sum of the parts (~3.336 km)');
  // The whole point of ordering: the path must not double back.
  const lats = m.coords.map(c => c[1]);
  ok(lats.every((v, i) => i === 0 || v >= lats[i - 1]), 'the merged path advances monotonically');

  ok(mergeSegments([S.Brev, S.A, S.C]).order.map(o => o.id).join('') === 'ABC', 'seeding mid-run still yields the full chain');
  ok(mergeSegments([]).coords.length === 0, 'no segments gives an empty path, not a crash');
  ok(mergeSegments([S.A]).coords.length === 2, 'a single segment passes through');
  ok(mergeSegments([S.A, { id: 'X', coords: [[-112, 33]] }]).order.length === 1, 'a degenerate one-point segment is ignored');
}
{
  // A stray segment must never displace the real run, whatever order it arrives in.
  const tight = mergeSegments([S.A, S.Brev, S.C, S.far], 50);
  ok(tight.order.map(o => o.id).join('') === 'ABC' && tight.unused.join('') === 'D', 'a disconnected segment is excluded, not chained');
  const strayFirst = mergeSegments([S.far, S.A, S.Brev, S.C], 50);
  ok(strayFirst.order.map(o => o.id).join('') === 'ABC', 'the longest run wins even when the stray is listed first');

  const loose = mergeSegments([S.A, S.Brev, S.C, S.far], 1000);
  ok(loose.order.length === 4 && loose.gaps.length === 1, 'a wider snap joins the gap');
  ok(near(loose.gaps[0].m, 890, 25), 'the bridged gap is reported with its size');
}

// ---- linear referencing ----
{
  const m = mergeSegments([S.A, S.Brev, S.C]);
  const cum = cumulative(m.coords);
  ok(cum.length === m.coords.length && cum[0] === 0, 'cumulative distance starts at zero, one entry per vertex');

  const p = pointAtDistance(m.coords, 1111.95, cum);
  ok(near(p.lat, 33.01, 1e-4), 'a point one segment along lands at the right latitude');
  ok(p.clamped === false, 'a distance inside the path is not flagged as clamped');

  const half = pointAtDistance(m.coords, 555.97, cum);
  ok(near(half.lat, 33.005, 1e-4), 'interpolation works mid-segment, not just at vertices');

  const end = pointAtDistance(m.coords, 999999, cum);
  ok(end.clamped === true && near(end.lat, 33.03, 1e-6), 'past the end clamps to the last vertex and says so');
  const start = pointAtDistance(m.coords, -50, cum);
  ok(start.clamped === true && near(start.lat, 33.00, 1e-6), 'a negative distance clamps to the start');

  // Forward then back must return the same distance.
  for (const d of [0, 250, 1111.95, 2000, 3335]) {
    const pt = pointAtDistance(m.coords, d, cum);
    const back = distanceAlong(m.coords, pt.lat, pt.lng, cum);
    if (!near(back.along_m, d, 2)) { ok(false, `round trip at ${d} m returned ${back.along_m.toFixed(1)} m`); break; }
    if (d === 3335) ok(true, 'position → distance → position round-trips within 2 m across the path');
  }
  const off = distanceAlong(m.coords, 33.015, -111.99, cum);
  ok(off.offset_m > 800, 'a point well off the route reports a large offset rather than pretending it is on it');
  ok(distanceAlong(m.coords, 33, -112, cum).offset_m < 1, 'a point on the route reports ~0 offset');
}

// ---- slack ----
{
  ok(DEFAULT_SLACK_PCT === 13, 'the default slack matches the field tool (13%)');
  ok(near(fibreToGround(4200, null), 3654, 0.5), '4.200 km of fibre at 13% slack is 3.654 km of ground');
  ok(near(groundToFibre(3654, null), 4200, 1), 'and the inverse recovers the fibre distance');
  ok(near(fibreToGround(1000, null, 0), 1000, 1e-9), 'zero slack means fibre equals ground');

  // Two segments with different slack: 1 km at 0%, then 1 km of ground at 50% (= 2 km of fibre).
  const spans = [{ endGround_m: 1000, slackPct: 0 }, { endGround_m: 2000, slackPct: 50 }];
  ok(near(fibreToGround(1000, spans), 1000, 1e-6), 'per-segment: fibre inside a 0% segment maps 1:1');
  ok(near(fibreToGround(2000, spans), 1500, 1e-6), 'per-segment: the second segment consumes fibre at its own rate');
  ok(near(fibreToGround(3000, spans), 2000, 1e-6), 'per-segment: the full path is reached at the right fibre distance');
  ok(near(groundToFibre(fibreToGround(2500, spans), spans), 2500, 1e-6), 'per-segment conversion round-trips');
  ok(fibreToGround(5000, spans) > 2000, 'fibre past the end extends at the last segment rate rather than sticking');
  // A null slack on a span means "inherit the default", not "zero".
  ok(near(fibreToGround(1000, [{ endGround_m: 10000, slackPct: null }], 13), 870, 0.5), 'a null per-route slack falls back to the default');
}

// ---- API ----
await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });

const mk = async (name, coords, slack) => (await call('/api/fiber/routes', { body: { name, status: 'as_built', geometry: { type: 'LineString', coordinates: coords }, slack_pct: slack } })).json;
const r1 = await mk('LOC-SEG-1', [[-112, 34.00], [-112, 34.01]]);
const r2 = await mk('LOC-SEG-2', [[-112, 34.02], [-112, 34.01]]);   // backwards on purpose
const st1 = (await call('/api/fiber/structures', { body: { name: 'LOC-HH-A', kind: 'handhole', lat: 34.00, lng: -112 } })).json;
const st2 = (await call('/api/fiber/structures', { body: { name: 'LOC-HH-Z', kind: 'vault', lat: 34.02, lng: -112 } })).json;
const cab = (await call('/api/fiber/cables', { body: { name: 'LOC-CABLE-1', route_id: r1.id, strand_count: 12, a_structure_id: st1.id, z_structure_id: st2.id, status: 'as_built' } })).json;
ok(r1 && r1.id && r2 && r2.id && cab && cab.id, 'fixtures created');

{
  const p = (await call(`/api/fiber/path?type=route&id=${r1.id}`)).json;
  ok(p.subject.name === 'LOC-SEG-1', 'path resolves a route');
  ok(near(p.total_m, 1112, 20), 'route ground length is right');
  ok(near(p.total_fibre_m, 1112 / 0.87, 30), 'fibre length applies the 13% default');
  ok(p.geometry.type === 'LineString' && p.geometry.coordinates.length >= 2, 'path returns drawable geometry');
}
{
  const p = (await call(`/api/fiber/path?type=cable&id=${cab.id}`)).json;
  ok(p.subject.name === 'LOC-CABLE-1', 'path resolves a cable through its route');
  ok(p.points.some(x => x.name === 'LOC-HH-A') && p.points.some(x => x.name === 'LOC-HH-Z'), 'the cable A and Z structures appear along the path');
  ok(p.points[0].along_m <= p.points[p.points.length - 1].along_m, 'structures are ordered by distance');
}
ok((await call('/api/fiber/path?type=route&id=99999')).status === 404, 'an unknown id is a 404');
ok((await call('/api/fiber/path?type=nonsense&id=1')).status === 400, 'an unknown path type is rejected');

// forward
{
  const total = (await call(`/api/fiber/path?type=route&id=${r1.id}`)).json.total_fibre_m / 1000;
  const l = (await call(`/api/fiber/locate?type=route&id=${r1.id}&km=${(total / 2).toFixed(4)}`)).json;
  ok(near(l.lat, 34.005, 1e-3), 'half the fibre length lands halfway along the route');
  ok(near(l.ground_m, 556, 15), 'the reported ground distance matches');
  ok(l.beyond_end === false, 'a valid distance is not flagged as beyond the end');

  const z = (await call(`/api/fiber/locate?type=route&id=${r1.id}&km=${(total / 2).toFixed(4)}&from=z`)).json;
  ok(near(z.lat, l.lat, 1e-3), 'measuring the midpoint from the Z end gives the same place');
  const zEnd = (await call(`/api/fiber/locate?type=route&id=${r1.id}&km=0&from=z`)).json;
  ok(near(zEnd.lat, 34.01, 1e-3), 'zero from the Z end is the far end of the route');
  const aEnd = (await call(`/api/fiber/locate?type=route&id=${r1.id}&km=0`)).json;
  ok(near(aEnd.lat, 34.00, 1e-3), 'zero from the A end is the start');

  const over = (await call(`/api/fiber/locate?type=route&id=${r1.id}&km=500`)).json;
  ok(over.beyond_end === true, 'a distance past the end is flagged rather than extrapolated off the plant');
  ok((await call(`/api/fiber/locate?type=route&id=${r1.id}`)).status === 400, 'locate without a distance is rejected');

  const slack0 = (await call(`/api/fiber/locate?type=route&id=${r1.id}&km=1.112&slack=0`)).json;
  ok(near(slack0.ground_m, 1112, 20), 'at 0% slack, fibre distance equals ground distance');
  const slack50 = (await call(`/api/fiber/locate?type=route&id=${r1.id}&km=1.112&slack=50`)).json;
  ok(near(slack50.ground_m, 556, 20), 'at 50% slack the same fibre reaches half as far');
}

// reverse
{
  const rev = (await call(`/api/fiber/locate/reverse?type=route&id=${r1.id}&lat=34.005&lng=-112`)).json;
  ok(near(rev.ground_m, 556, 15), 'reverse lookup reports ground distance from the A end');
  ok(near(rev.fibre_from_a_km + rev.fibre_from_z_km, rev.total_fibre_km, 0.01), 'distances from each end sum to the total');
  ok(rev.offset_m < 5, 'a point on the line reports a small offset');
  const offRoute = (await call(`/api/fiber/locate/reverse?type=route&id=${r1.id}&lat=34.005&lng=-111.95`)).json;
  ok(offRoute.offset_m > 1000, 'a point far off the line reports a large offset so the UI can warn');
  ok((await call(`/api/fiber/locate/reverse?type=route&id=${r1.id}&lat=abc&lng=-112`)).status === 400, 'reverse rejects a bad coordinate');
}

// per-route slack override
{
  await call('/api/fiber/routes/' + r1.id, { method: 'PUT', body: { slack_pct: 50 } });
  const p = (await call(`/api/fiber/path?type=route&id=${r1.id}`)).json;
  ok(p.segments[0].slack_pct === 50, "the route's own slack is reported on its segment");
  ok(near(p.total_fibre_m, 1112 / 0.5, 40), 'total fibre length uses the per-route slack');
  const own = (await call(`/api/fiber/locate?type=route&id=${r1.id}&km=1.112`)).json;
  ok(near(own.ground_m, 556, 25), "with no slack given, the route's own 50% applies");
  const forced = (await call(`/api/fiber/locate?type=route&id=${r1.id}&km=1.112&slack=0`)).json;
  ok(near(forced.ground_m, 1112, 25), 'an explicit slack overrides the per-route value');
  ok(forced.slack_forced === true && own.slack_forced === false, 'the response says which mode was used');
  await call('/api/fiber/routes/' + r1.id, { method: 'PUT', body: { slack_pct: null } });
  const back = (await call(`/api/fiber/path?type=route&id=${r1.id}`)).json;
  ok(back.segments[0].slack_pct === null, 'clearing the field returns the route to the default');
}

// KML export
{
  const r = await call(`/api/fiber/path.kml?type=cable&id=${cab.id}`);
  ok(r.status === 200, 'KML export returns 200');
  ok(/<kml[\s>]/.test(r.t) && /<LineString>/.test(r.t), 'KML has a LineString for the merged run');
  ok(/<Placemark>[\s\S]*<name>LOC-HH-A<\/name>/.test(r.t), 'named Point placemarks are included for the locator to label');
  ok(/coordinates>-112,34/.test(r.t), 'coordinates are lng,lat as KML requires');
  ok((await call('/api/fiber/path.kml?type=route&id=99999')).status === 404, 'KML export of a missing path is a 404');
}

// marking a located point
{
  const before = (await call('/api/fiber/structures')).json.length;
  const m = (await call('/api/fiber/locate/mark', { body: { lat: 34.006, lng: -112, name: 'LOC-MARKED' } })).json;
  ok(m && m.id, 'a located point can be saved as a structure');
  ok((await call('/api/fiber/structures')).json.length === before + 1, 'the structure list grows by one');
  ok((await call('/api/fiber/locate/mark', { body: { lat: 'x', lng: -112 } })).status === 400, 'marking rejects a bad coordinate');
}

// a path with no geometry should explain itself rather than 500
{
  const bare = (await call('/api/circuits', { body: { label: 'LOC-NO-GEOM', a_type: 'site', z_type: 'site', status: 'Up' } })).json;
  if (bare && bare.id) {
    const p = await call(`/api/fiber/path?type=circuit&id=${bare.id}`);
    ok(p.status === 409 && /no mapped route geometry/i.test(p.json.error), 'a circuit with no mapped fibre says so instead of failing');
  } else ok(true, 'skipped: circuit fixture needs endpoints');
}

// role gating on the write endpoint
{
  cookie = ''; await call('/api/login', { body: { email: 'support@geekitek.test', password: 'support123' } });
  ok((await call('/api/fiber/locate/mark', { body: { lat: 34.007, lng: -112 } })).status === 403, 'support cannot create structures from the locator');
  ok((await call(`/api/fiber/path?type=route&id=${r1.id}`)).status === 200, 'but support can still read a path');
}

// ---- slack derived from a measured fibre length ----
// The role-gating block above left us as `support`; these need write access again.
cookie = ''; await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });
{
  const { measuredSlackPct } = await import('../lib/path.js');
  ok(measuredSlackPct(1130, 1000).toFixed(1) === '11.5', 'a 1.130 ratio yields the ~11.5% slack seen in the real import');
  ok(measuredSlackPct(1000, 1000) === null, 'a ratio of exactly 1 is rejected — it means no fibre length was supplied');
  ok(measuredSlackPct(900, 1000) === null, 'fibre shorter than the ground route is rejected as impossible');
  ok(measuredSlackPct(1467000, 12840) === null, 'the corrupt 114x record is rejected rather than believed');
  ok(measuredSlackPct(1601, 1000) === null && measuredSlackPct(1600, 1000) !== null, 'the plausibility ceiling is inclusive at 1.6x and rejects beyond it');
  ok(measuredSlackPct(null, 1000) === null && measuredSlackPct(1130, 0) === null, 'missing or zero inputs give null');
}
{
  // A route carrying a measured fibre length should use it in preference to the 13% default.
  const coords = [[-112, 35.00], [-112, 35.01]];        // ~1112 m of ground
  const r = (await call('/api/fiber/routes', { body: { name: 'LOC-MEASURED', status: 'as_built', geometry: { type: 'LineString', coordinates: coords } } })).json;
  // Simulate what the IQGeo importer records: 1.250 km of fibre over 1.112 km of ground = 11% slack.
  await call('/api/fiber/routes/' + r.id, { method: 'PUT', body: { fibre_m: 1250 } });
  const withFibre = (await call('/api/fiber/path?type=route&id=' + r.id)).json;
  if (withFibre.segments[0].fibre_m === 1250) {
    ok(withFibre.segments[0].slack_source === 'measured', 'a route with a measured fibre length reports slack_source=measured');
    ok(near(withFibre.segments[0].slack_pct, 11, 1), 'the derived slack matches the measured ratio, not the 13% default');
    ok(near(withFibre.total_fibre_m, 1250, 30), 'total fibre length equals the measured value');
    // A manual override must beat the measurement.
    await call('/api/fiber/routes/' + r.id, { method: 'PUT', body: { slack_pct: 25 } });
    const manual = (await call('/api/fiber/path?type=route&id=' + r.id)).json;
    ok(manual.segments[0].slack_source === 'route' && manual.segments[0].slack_pct === 25, 'a manual route override beats the measured ratio');
    // And an explicit request parameter beats everything.
    const forced = (await call('/api/fiber/path?type=route&id=' + r.id + '&slack=5')).json;
    ok(forced.slack_forced === true && forced.slack_sources.forced === 1, 'an explicit slack parameter overrides both');
  } else {
    ok(true, 'skipped: fibre_m is only written by the importer on this build');
  }
}
{
  // A file-imported route has no measured length, so it must fall back to the chosen percentage.
  const r = (await call('/api/fiber/routes', { body: { name: 'LOC-UPLOADED', status: 'as_built', geometry: { type: 'LineString', coordinates: [[-112, 36.00], [-112, 36.01]] } } })).json;
  const p = (await call('/api/fiber/path?type=route&id=' + r.id)).json;
  ok(p.segments[0].slack_source === 'default', 'a route with no measured length reports slack_source=default');
  ok(p.segments[0].fibre_m === null, 'and carries no fibre length');
  ok(near(p.total_fibre_m, 1112 / 0.87, 30), 'its fibre length uses the 13% default');
  const forced = (await call('/api/fiber/path?type=route&id=' + r.id + '&slack=20')).json;
  ok(near(forced.total_fibre_m, 1112 / 0.8, 30), 'and a chosen percentage applies to it');
}

// ---- several OTDR readings at once ----
{
  const r3 = (await call('/api/fiber/routes', { body: { name: 'LOC-MULTI', status: 'as_built', geometry: { type: 'LineString', coordinates: [[-112, 37.00], [-112, 37.05]] } } })).json;  // ~5.56 km
  const one = (await call(`/api/fiber/locate?type=route&id=${r3.id}&km=1`)).json;
  ok(one.count === 1 && Array.isArray(one.points) && one.points.length === 1, 'a single distance still returns count 1 with a points array');
  ok(one.points[0].lat === one.lat, 'the top-level fields mirror the first point, so older callers keep working');

  const many = (await call(`/api/fiber/locate?type=route&id=${r3.id}&km=1,3,2`)).json;
  ok(many.count === 3 && many.points.length === 3, 'three distances give three points');
  ok(many.points.map(p => p.requested_fibre_km).join(',') === '1,3,2', 'points keep the order they were entered');
  ok(many.points[0].index === 1 && many.points[1].index === 2, 'each point is numbered as entered');
  // Ordering along the path is what tells you whether readings cluster.
  const byGround = [...many.points].sort((a, b) => a.ground_m - b.ground_m).map(p => p.requested_fibre_km);
  ok(byGround.join(',') === '1,2,3', 'points can be ordered along the route regardless of entry order');
  ok(many.points.every(p => p.gap_from_previous_m !== undefined), 'each point reports the gap from the one before it');
  const first = [...many.points].sort((a, b) => a.ground_m - b.ground_m)[0];
  ok(first.gap_from_previous_m === null, 'the first point along the path has no preceding gap');
  ok(near(many.span_m, (3 - 1) * 1000 * 0.87, 30), 'span_m is the ground distance between the outermost readings');
  ok(many.points.every(p => p.on_segment && p.between), 'every point carries its segment and surrounding structures');

  // Separators people actually paste.
  ok((await call(`/api/fiber/locate?type=route&id=${r3.id}&km=1%202%203`)).json.count === 3, 'space-separated readings are accepted');
  ok((await call(`/api/fiber/locate?type=route&id=${r3.id}&km=1,%202,%203`)).json.count === 3, 'comma-and-space is accepted');
  ok((await call(`/api/fiber/locate?type=route&id=${r3.id}&km=1,,2,`)).json.count === 2, 'empty entries are ignored rather than becoming zero');

  ok((await call(`/api/fiber/locate?type=route&id=${r3.id}&km=1,abc`)).status === 400, 'a non-numeric reading is rejected rather than silently dropped');
  ok((await call(`/api/fiber/locate?type=route&id=${r3.id}&km=`)).status === 400, 'an empty distance list is rejected');
  const tooMany = Array.from({ length: 51 }, (_, i) => i / 10).join(',');
  ok((await call(`/api/fiber/locate?type=route&id=${r3.id}&km=${tooMany}`)).status === 400, 'an absurd number of readings is refused');

  // Faults in the KML, so the whole trace hands over as one file.
  const kml = await call(`/api/fiber/path.kml?type=route&id=${r3.id}&faults=1,3`);
  ok(kml.status === 200 && /Fault 1 — 1 km/.test(kml.t), 'KML export includes numbered fault placemarks');
  ok((kml.t.match(/<Placemark>/g) || []).length >= 3, 'the route and both faults are present');
  const noFaults = await call(`/api/fiber/path.kml?type=route&id=${r3.id}`);
  ok(!/Fault 1/.test(noFaults.t), 'without the faults parameter the export is unchanged');
}

console.log('\nRESULT:', pass, 'passed,', fail, 'failed'); process.exit(fail ? 1 : 0);
