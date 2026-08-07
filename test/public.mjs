// The public fault locator: works signed out, reaches nothing else, and refuses to be abused.
const B = process.env.BASE ?? 'http://localhost:3000';
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };
// NOTE: no login anywhere in this file — every request below is anonymous on purpose.
const get = async p => { const r = await fetch(B + p); return { status: r.status, t: await r.text() }; };
const post = async (p, body, headers = {}) => {
  const r = await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, t };
};

const kml = (n = 3) => {
  const segs = Array.from({ length: n }, (_, i) =>
    `<Placemark><name>S${i}</name><LineString><coordinates>-112,${(40 + i * 0.01).toFixed(4)},0 -112,${(40 + (i + 1) * 0.01).toFixed(4)},0</coordinates></LineString></Placemark>`).join('');
  return `<?xml version="1.0"?><kml><Document>${segs}
    <Placemark><name>SPLICE-A</name><Point><coordinates>-112,40.01,0</coordinates></Point></Placemark>
  </Document></kml>`;
};

// ---- the page is served without a session ----
{
  const p = await get('/locator');
  ok(p.status === 200, 'the locator page loads signed out');
  ok(/Fiber Fault Locator/.test(p.t), 'it is the locator page, not the app shell or a login screen');
  ok(/noindex/.test(p.t), 'it asks not to be indexed');
  // It must not drag in the authenticated SPA.
  ok(!/src="\/app\.js"/.test(p.t), 'it does not load the inventory application script');
}

// ---- calculating works signed out ----
{
  const r = await post('/locator/calc?km=1,2&slack=13', Buffer.from(kml(), 'utf8'));
  ok(r.status === 200, 'an anonymous calculation succeeds');
  ok(r.json.count === 2 && r.json.points.length === 2, 'both readings are located');
  ok(r.json.source.format === 'kml' && r.json.source.segments_in_file === 3, 'the file is parsed and its segments counted');
  ok(r.json.labels.length === 1 && r.json.labels[0].name === 'SPLICE-A', 'named points come back as labels');
  ok(r.json.geometry.coordinates.length >= 4, 'the merged geometry is returned for drawing');
  ok(Math.abs(r.json.points[0].ground_m - 870) < 20, '1 km of fibre at 13% slack is 870 m of ground');
  // Nothing about the inventory should ever appear in a public response.
  const flat = JSON.stringify(r.json);
  ok(!/circuit_id|account|password|href|structure_id/i.test(flat), 'the response carries no inventory fields');
}

// ---- it is not a way into anything else ----
{
  ok((await get('/api/circuits')).status === 401, 'the inventory API still requires a session');
  ok((await get('/api/fiber/geojson')).status === 401, 'the fiber map data still requires a session');
  ok((await get('/api/me')).status === 401, 'there is no anonymous identity');
  ok((await post('/api/fiber/locate/file?km=1', Buffer.from(kml(), 'utf8'))).status === 401,
    'the signed-in file endpoint is still gated — the public one is separate, not a bypass');
  ok((await post('/locator/calc?km=1', Buffer.from(kml(), 'utf8'), { 'Content-Type': 'application/json' })).status !== 401,
    'the public endpoint does not accidentally sit behind the auth gate');
}

// ---- limits ----
{
  ok((await post('/locator/calc?km=1', Buffer.alloc(0))).status === 400, 'an empty upload is rejected');
  ok((await post('/locator/calc?km=1', Buffer.from('hello', 'utf8'))).status === 400, 'a non-map file is rejected');
  ok((await post('/locator/calc?km=abc', Buffer.from(kml(), 'utf8'))).status === 400, 'a non-numeric distance is rejected');
  const many = Array.from({ length: 51 }, (_, i) => i / 10).join(',');
  ok((await post(`/locator/calc?km=${many}`, Buffer.from(kml(), 'utf8'))).status === 400, 'more than 50 readings is refused');

  // Complexity ceiling: this is what stops one anonymous request from monopolising the server.
  const huge = await post('/locator/calc?km=1', Buffer.from(kml(1600), 'utf8'));
  ok(huge.status === 413, 'a file beyond the segment ceiling is refused');
  ok(/1500/.test(huge.json.error) && /[Ss]ign in/.test(huge.json.error), 'the refusal says what the limit is and how to work around it');
  ok((await post('/locator/calc?km=1', Buffer.from(kml(1400), 'utf8'))).status === 200, 'a file just under the ceiling is accepted');

  // Body-size cap, enforced by the parser rather than by us reading 100 MB into memory first.
  const big = Buffer.alloc(9 * 1024 * 1024, 0x20);
  const r = await post('/locator/calc?km=1', big);
  ok(r.status === 413, 'an upload over 8 MB is refused');
}

// ---- performance: the merge must not block the event loop ----
{
  // 1400 disconnected segments used to take well over a minute of blocked CPU.
  const t = Date.now();
  const r = await post('/locator/calc?km=1', Buffer.from(kml(1400), 'utf8'));
  const ms = Date.now() - t;
  ok(r.status === 200 && ms < 10000, `a large file completes quickly (${ms} ms) rather than stalling the server`);
}

// ---- rate limiting ----
{
  // The limit is 20/minute; earlier tests have already used some of the budget.
  let limited = false;
  for (let i = 0; i < 40; i++) {
    const r = await post('/locator/calc?km=1', Buffer.from(kml(2), 'utf8'));
    if (r.status === 429) { limited = true; break; }
  }
  ok(limited, 'repeated requests from one address are eventually rate limited');
}

console.log('\nRESULT:', pass, 'passed,', fail, 'failed'); process.exit(fail ? 1 : 0);
