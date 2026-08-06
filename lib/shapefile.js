// Minimal Shapefile (.shp) + dBase (.dbf) reader — dependency-free, matching the rest of the
// project's no-native-deps philosophy. Supports the shape types that actually turn up in OSP
// deliverables: Point, PolyLine and Polygon (plus their Z/M variants, whose extra ordinates we
// simply ignore since we only care about lng/lat).
//
// Deliberately NOT handled: reprojection. Shapefiles are frequently in State Plane or UTM rather
// than WGS84; guessing would silently place fiber in the wrong hemisphere, so callers should use
// looksProjected() and refuse with a clear message instead.

const SHP_POINT = [1, 11, 21], SHP_POLYLINE = [3, 13, 23], SHP_POLYGON = [5, 15, 25];

/** Parse .shp geometry records → [{ type:'Point'|'LineString', coordinates }]. */
export function parseShp(buf) {
  if (buf.length < 100 || buf.readInt32BE(0) !== 9994) throw new Error('Not a valid .shp file');
  const out = [];
  let p = 100;                                    // 100-byte header, then variable-length records
  while (p + 8 <= buf.length) {
    const contentLen = buf.readInt32BE(p + 4) * 2; // stored in 16-bit words
    const rec = p + 8;
    if (contentLen <= 0 || rec + contentLen > buf.length) break;
    const type = buf.readInt32LE(rec);
    if (SHP_POINT.includes(type)) {
      out.push({ type: 'Point', coordinates: [buf.readDoubleLE(rec + 4), buf.readDoubleLE(rec + 12)] });
    } else if (SHP_POLYLINE.includes(type) || SHP_POLYGON.includes(type)) {
      const numParts = buf.readInt32LE(rec + 36);
      const numPoints = buf.readInt32LE(rec + 40);
      const partsAt = rec + 44, pointsAt = partsAt + numParts * 4;
      const parts = []; for (let i = 0; i < numParts; i++) parts.push(buf.readInt32LE(partsAt + i * 4));
      for (let i = 0; i < numParts; i++) {
        const from = parts[i], to = (i + 1 < numParts ? parts[i + 1] : numPoints);
        const coords = [];
        for (let j = from; j < to; j++) coords.push([buf.readDoubleLE(pointsAt + j * 16), buf.readDoubleLE(pointsAt + j * 16 + 8)]);
        if (coords.length >= 2) out.push({ type: 'LineString', coordinates: coords });
      }
    } // other shape types (MultiPatch etc) are skipped rather than guessed at
    p = rec + contentLen;
  }
  return out;
}

/** Parse a dBase III .dbf into an array of plain objects (attribute table of the shapefile). */
export function parseDbf(buf) {
  if (!buf || buf.length < 32) return [];
  const numRecords = buf.readInt32LE(4);
  const headerLen = buf.readInt16LE(8);
  const recordLen = buf.readInt16LE(10);
  const fields = [];
  for (let p = 32; p < headerLen - 1 && buf[p] !== 0x0d; p += 32) {
    fields.push({ name: buf.toString('latin1', p, p + 11).replace(/\0.*$/, '').trim(), type: String.fromCharCode(buf[p + 11]), len: buf[p + 16] });
  }
  const rows = [];
  for (let i = 0; i < numRecords; i++) {
    const start = headerLen + i * recordLen;
    if (start + recordLen > buf.length) break;
    if (buf[start] === 0x2a) continue;            // 0x2A = record marked deleted
    const row = {}; let off = start + 1;
    for (const f of fields) {
      const raw = buf.toString('latin1', off, off + f.len).trim();
      row[f.name] = (f.type === 'N' || f.type === 'F') ? (raw === '' ? null : Number(raw)) : raw;
      off += f.len;
    }
    rows.push(row);
  }
  return rows;
}

/** Heuristic: WGS84 lng/lat fits in ±180/±90, so anything larger is a projected CRS. */
export function looksProjected(shapes) {
  for (const s of shapes) {
    const pts = s.type === 'Point' ? [s.coordinates] : s.coordinates;
    for (const [x, y] of pts) if (Math.abs(x) > 180 || Math.abs(y) > 90) return true;
  }
  return false;
}

/** Pick the best attribute to use as a feature name. */
export function attrName(row, fallback) {
  if (!row) return fallback;
  const preferred = ['NAME', 'Name', 'name', 'LABEL', 'Label', 'ID', 'FID', 'CABLE', 'ROUTE', 'DESC', 'COMMENT'];
  for (const k of preferred) if (row[k] != null && String(row[k]).trim()) return String(row[k]).trim();
  for (const k of Object.keys(row)) { const v = row[k]; if (typeof v === 'string' && v.trim()) return v.trim(); }
  return fallback;
}

/** Combine .shp + optional .dbf into { routes, structures } the importer understands. */
export function shapefileToFeatures(shpBuf, dbfBuf) {
  const shapes = parseShp(shpBuf);
  if (!shapes.length) throw new Error('That shapefile contains no points or lines');
  if (looksProjected(shapes)) throw new Error('This shapefile is in a projected coordinate system, not WGS84 lat/long. Re-export it as WGS84 (EPSG:4326) and try again.');
  const attrs = dbfBuf ? parseDbf(dbfBuf) : [];
  const out = { routes: [], structures: [] };
  // shapes and dbf rows are positionally aligned, but multi-part lines expand to several shapes
  let shapeIdx = 0;
  for (const s of shapes) {
    const row = attrs[shapeIdx] || null;
    const name = attrName(row, (s.type === 'Point' ? 'Structure ' : 'Route ') + (shapeIdx + 1));
    if (s.type === 'Point') out.structures.push({ name, notes: null, lng: s.coordinates[0], lat: s.coordinates[1] });
    else out.routes.push({ name, notes: null, coordinates: s.coordinates });
    shapeIdx++;
  }
  return out;
}
