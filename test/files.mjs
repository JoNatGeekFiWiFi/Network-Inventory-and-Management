// Admin Files section: who can see it, and what is actually retained.
const B = process.env.BASE ?? 'http://localhost:3000'; let cookie = '';
async function call(p, { method = 'GET', body, raw } = {}) {
  const h = {};
  if (raw) { h['content-type'] = 'application/octet-stream'; method = 'POST'; }
  else if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; }
  if (cookie) h.cookie = cookie;
  const r = await fetch(B + p, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, t };
}
const login = async (email, password) => { cookie = ''; return call('/api/login', { body: { email, password } }); };
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

const kml = `<?xml version="1.0"?><kml><Document>
  <Placemark><name>FILES-SEG</name><LineString><coordinates>-112,41.00,0 -112,41.01,0</coordinates></LineString></Placemark>
</Document></kml>`;

// ---- a staff upload is retained; a public one is not ----
await login('admin@geekitek.test', 'admin123');
{
  const before = (await call('/api/files/locator')).json.total;
  await call('/api/fiber/locate/file?km=1&filename=staff-route.kml', { raw: Buffer.from(kml, 'utf8') });
  // The public route is outside /api and takes no session.
  await fetch(B + '/locator/calc?km=1&filename=public-route.kml', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from(kml, 'utf8') });

  const d = (await call('/api/files/locator')).json;
  ok(d.total === before + 2, 'both a staff upload and a public one are recorded');

  const staff = d.rows.find(r => r.filename === 'staff-route.kml');
  const pub = d.rows.find(r => r.filename === 'public-route.kml');
  ok(staff && staff.source === 'staff' && staff.actor === 'admin@geekitek.test', 'a staff upload is attributed to the person');
  ok(staff.retained === 1 || staff.retained === true, 'the staff upload keeps its file');
  ok(pub && pub.source === 'public', 'a public upload is recorded as public');
  ok(!pub.retained, 'the public upload does NOT keep its file');
  ok(!pub.actor && pub.ip, 'the public upload has no user but does record an address');
  ok(staff.sha256 && staff.sha256 === pub.sha256, 'the same bytes hash identically, so duplicates are recognisable');
  ok(staff.format === 'kml' && staff.segments === 1, 'parsed details are recorded alongside');

  // Download follows retention.
  const dl = await call(`/api/files/locator/${staff.id}/download`);
  ok(dl.status === 200 && /FILES-SEG/.test(dl.t), 'the retained staff file downloads intact');
  const nodl = await call(`/api/files/locator/${pub.id}/download`);
  ok(nodl.status === 410 && /metadata only/i.test(nodl.json.error), 'downloading a public upload explains why there is nothing to fetch');

  // A rejected file is still logged, so abuse is visible.
  await fetch(B + '/locator/calc?km=1&filename=junk.txt', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('not a map', 'utf8') });
  const after = (await call('/api/files/locator')).json;
  const junk = after.rows.find(r => r.filename === 'junk.txt');
  ok(junk && junk.format === null, 'a rejected upload is recorded with no format, rather than vanishing');

  // Delete removes both row and file.
  const del = await call(`/api/files/locator/${staff.id}`, { method: 'DELETE' });
  ok(del.status === 200, 'an admin can delete an entry');
  ok((await call(`/api/files/locator/${staff.id}/download`)).status === 404, 'the file is gone afterwards');
}

// ---- ID documents ----
{
  const ids = await call('/api/files/ids');
  ok(ids.status === 200 && Array.isArray(ids.json), 'the ID list loads for an admin');
  // Whatever is listed must not leak the on-disk name — the photo is served by request id only.
  const flat = JSON.stringify(ids.json);
  ok(!/idphoto-/.test(flat), 'stored filenames are not exposed');
  ok(!/id_photo/.test(flat), 'the raw column is not passed through');
}

// ---- access control ----
for (const [email, password, role] of [
  ['noc@geekitek.test', 'noc123', 'noc'],
  ['support@geekitek.test', 'support123', 'support']
]) {
  const li = await login(email, password);
  if (li.status !== 200) { ok(true, `skipped ${role}: no such seed user`); continue; }
  ok((await call('/api/files/locator')).status === 403, `${role} cannot list locator uploads`);
  ok((await call('/api/files/ids')).status === 403, `${role} cannot list ID documents`);
  ok((await call('/api/files/locator/1/download')).status === 403, `${role} cannot download an upload`);
  ok((await call('/api/files/locator/1', { method: 'DELETE' })).status === 403, `${role} cannot delete an entry`);
}
{
  cookie = '';
  ok((await call('/api/files/locator')).status === 401, 'anonymous callers cannot list uploads');
  ok((await call('/api/files/ids')).status === 401, 'anonymous callers cannot list ID documents');
  ok((await call('/api/files/locator/1/download')).status === 401, 'anonymous callers cannot download');
}

// ---- reading an ID is audited ----
await login('admin@geekitek.test', 'admin123');
{
  const ids = (await call('/api/files/ids')).json;
  if (!ids.length) { ok(true, 'skipped: no ID documents in this database'); }
  else {
    const before = (await call('/api/audit')).json.filter(a => a.action === 'access_read').length;
    await call(`/api/access/${ids[0].id}/photo`);
    const after = (await call('/api/audit')).json.filter(a => a.action === 'access_read').length;
    ok(after > before, 'viewing an identity document is written to the audit log');
  }
}

console.log('\nRESULT:', pass, 'passed,', fail, 'failed'); process.exit(fail ? 1 : 0);
