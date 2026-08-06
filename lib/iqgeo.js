// IQGeo / myWorld ("Network Manager") GeoJSON export mapper.
//
// A myWorld report export is a plain GeoJSON FeatureCollection, but every attribute is namespaced
// `user_*` and the useful structure lives in fields a generic GeoJSON reader throws away. Two
// export shapes matter to us:
//
//   ROUTES  – the physical path. in_structure/out_structure ("pole/1108027") name the endpoints,
//             user_calc_length is metres, user_construction_status is the lifecycle state.
//   SPANS   – the fibre riding those routes. user_count is the strand count, termination_info
//             and a_location_pins give the strand RANGES at each end, user_cid the circuit.
//
// Structures aren't exported with their own geometry, but a route's first/last vertex *is* the
// in/out structure position, so we synthesise them from the endpoints and dedupe on the myWorld
// reference. Every record keeps its ext_ref so re-importing updates rather than duplicates.

/** Does this look like a myWorld/IQGeo export rather than generic GeoJSON? */
export function looksLikeIqgeo(data) {
  const f = data && Array.isArray(data.features) ? data.features[0] : null;
  if (!f) return false;
  if (f.myw_title !== undefined || f.myw_short_description !== undefined) return true;
  return !!(f.properties && Object.keys(f.properties).some(k => k.startsWith('user_')));
}

// myWorld construction status → our route lifecycle
const STATUS_MAP = {
  'in service': 'as_built', 'complete': 'as_built', 'active': 'as_built',
  'leased (contact 3rd party)': 'as_built', 'stub (customer owned)': 'as_built',
  'iru/fs fibers': 'as_built', 'occupied by 3rd party': 'as_built', 'unoccupied': 'as_built',
  'construction services': 'under_construction', 'in construction': 'under_construction',
  'new install': 'under_construction',
  'planned': 'planned', 'proposed': 'planned', 'reserved future': 'planned', 'virtual': 'planned',
  'abandoned': 'retired', 'removed': 'retired'
};
const mapStatus = v => STATUS_MAP[String(v || '').trim().toLowerCase()] || 'as_built';

// myWorld structure table prefix → our structure kind
const KIND_MAP = {
  pole: 'pole', manhole: 'vault', handhole: 'handhole', vault: 'vault',
  cabinet: 'cabinet', pedestal: 'pedestal', building: 'building',
  fiber_splice_tray: 'splice_case', splice_closure: 'splice_case', splice: 'splice_case',
  terminal_enclosure: 'splice_case', card: 'cabinet'
};
const refKind = ref => KIND_MAP[String(ref || '').split('/')[0].toLowerCase()] || 'handhole';

/** Placement from the several fields myWorld spreads it across. */
function placementOf(p, shortDesc) {
  const s = String(shortDesc || '').toLowerCase();
  if (s.includes('overhead') || s.includes('aerial')) return 'aerial';
  if (String(p.user_opgw || '').toLowerCase() === 'yes') return 'aerial';
  const rt = String(p.user_route_type || '').toLowerCase();
  if (rt === 'bore' || rt === 'trench') return 'buried';
  if (s.includes('underground') || s.includes('buried')) return 'buried';
  if (rt === 'virtual') return 'other';
  return null;
}

/**
 * Strand ranges out of myWorld's terminal notation.
 *   "fiber_splice_tray::in:1:24" → {from:1,to:24}
 *   "out:49:72"                  → {from:49,to:72}
 * Returns null when it doesn't parse — we never guess at fibre assignments.
 */
export function parsePins(text) {
  const m = String(text || '').match(/(?:^|:)(\d+):(\d+)\s*$/);
  if (!m) return null;
  const from = parseInt(m[1], 10), to = parseInt(m[2], 10);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) return null;
  return { from, to };
}

const first = (...vals) => vals.find(v => v !== undefined && v !== null && String(v).trim() !== '') ?? null;
const numOr = (v, d = null) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/**
 * Convert a myWorld FeatureCollection into { routes, structures, cables, stats }.
 * Everything carries ext_ref so a re-import is idempotent.
 */
export function parseIqgeo(data) {
  const out = { routes: [], structures: [], cables: [], circuits: [], stats: { spans: 0, routes: 0, skipped: 0 } };
  const structByRef = new Map();   // myWorld ref → structure (deduped)

  const noteStructure = (ref, coord, hintName) => {
    if (!ref || !coord) return null;
    const key = String(ref);
    if (structByRef.has(key)) return key;
    structByRef.set(key, {
      ext_ref: key, name: hintName || key.replace('/', ' '), kind: refKind(key),
      lng: coord[0], lat: coord[1], notes: 'Imported from IQGeo (' + key + ')'
    });
    return key;
  };

  for (const f of (data.features || [])) {
    const p = f.properties || {};
    const g = f.geometry || {};
    const coords = g.type === 'LineString' && Array.isArray(g.coordinates)
      ? g.coordinates.filter(c => Array.isArray(c) && Number.isFinite(+c[0]) && Number.isFinite(+c[1])).map(c => [+c[0], +c[1]])
      : null;
    const title = String(f.myw_title || '').trim();
    const shortDesc = String(f.myw_short_description || '').trim();
    const extRef = f.ID != null ? String(f.ID) : null;

    // ---- fibre span: a CABLE (has a strand count) ----
    if (p.user_count != null || String(p.user_type || '').toLowerCase() === 'span') {
      const count = numOr(p.user_count, 0);
      const name = first(p.name, p.user_name, title) || ('Span ' + (extRef || out.cables.length + 1));
      // the span's own path becomes a route so it can be drawn
      let routeRef = null;
      if (coords && coords.length >= 2) {
        routeRef = 'span-route/' + (extRef || name);
        out.routes.push({
          ext_ref: routeRef, name: name + ' (span path)', status: mapStatus(p.user_status),
          placement: placementOf(p, shortDesc), owner: first(p.user_owner),
          coordinates: coords,
          length_m: numOr(p.user_actual_fiber_dist_km_sfdc) != null ? Math.round(numOr(p.user_actual_fiber_dist_km_sfdc) * 1000) : null,
          notes: [shortDesc, p.user_group ? 'Group: ' + p.user_group : null].filter(Boolean).join(' · ') || null
        });
        // A/Z ends of the span path, so the cable has structures to hang off
        noteStructure(p.in_feature, coords[0], first(p.user_a_location));
        noteStructure(p.out_feature, coords[coords.length - 1], first(p.user_z_location));
      }
      const aPins = parsePins(p.a_location_pins);
      const zPins = parsePins(p.termination_info);
      // A span with a CID is a real circuit riding these strands — emit it so the importer can
      // create the circuit record and point the strands at it.
      const cid = first(p.user_cid, p.user_so_circuit_id_sfdc);
      const circuit = cid ? {
        ext_ref: 'iqgeo-cid/' + cid,
        circuit_id: String(cid),
        label: first(p.user_group, p.user_ring_name_sfdc, p.name, title),
        ctype: first(p.user_product_group),
        status: /active|in service|complete/i.test(String(p.user_status || p.user_fiber_span_status_sfdc || '')) ? 'Up' : 'Planned',
        account_name: first(p.user_account),
        a_structure_ref: p.in_feature || null,
        z_structure_ref: p.out_feature || null,
        notes: [
          p.user_account ? 'Account: ' + p.user_account : null,
          p.user_a_location ? 'A: ' + p.user_a_location : null,
          p.user_z_location ? 'Z: ' + p.user_z_location : null,
          p.user_service_component_sfdc ? 'Service component: ' + p.user_service_component_sfdc : null,
          p.user_customer_service_sfdc ? 'Customer service: ' + p.user_customer_service_sfdc : null,
          p.user_so_order ? 'Service order: ' + p.user_so_order : null,
          p.user_pni_id ? 'PNI: ' + p.user_pni_id : null
        ].filter(Boolean).join('\n') || null,
        install_date: first(p.user_insert_date),
        length_km: numOr(p.user_actual_fiber_dist_km_sfdc)
      } : null;
      if (circuit && !out.circuits.some(x => x.ext_ref === circuit.ext_ref)) out.circuits.push(circuit);
      out.cables.push({
        circuit_ext_ref: circuit ? circuit.ext_ref : null,
        ext_ref: extRef ? 'span/' + extRef : 'span/' + name,
        name, strand_count: count > 0 ? count : 12,
        route_ext_ref: routeRef,
        a_structure_ref: p.in_feature || null, z_structure_ref: p.out_feature || null,
        status: mapStatus(p.user_status),
        cable_type: first(p.user_product_group),
        // the range actually lit, so strands can be marked assigned rather than left free
        assign: zPins || aPins,
        assign_label: first(p.user_cid, p.user_account, p.user_group),
        notes: [
          p.user_account ? 'Account: ' + p.user_account : null,
          p.user_cid ? 'CID: ' + p.user_cid : null,
          p.user_group ? 'Group: ' + p.user_group : null,
          p.user_a_location ? 'A: ' + p.user_a_location : null,
          p.user_z_location ? 'Z: ' + p.user_z_location : null,
          p.termination_info ? 'Termination: ' + p.termination_info : null,
          p.user_comments ? 'Comments: ' + p.user_comments : null,
          p.user_pni_id ? 'PNI: ' + p.user_pni_id : null
        ].filter(Boolean).join('\n') || null
      });
      out.stats.spans++;
      continue;
    }

    // ---- physical route (conduit / aerial / underground) ----
    if (coords && coords.length >= 2) {
      const name = first(title, p.user_name, p.user_loc_code) || ('Route ' + (extRef || out.routes.length + 1));
      noteStructure(p.in_structure, coords[0]);
      noteStructure(p.out_structure, coords[coords.length - 1]);
      out.routes.push({
        ext_ref: extRef ? 'route/' + extRef : null,
        name, status: mapStatus(p.user_construction_status),
        placement: placementOf(p, shortDesc),
        owner: first(p.user_owner),
        coordinates: coords,
        length_m: numOr(p.user_calc_length) != null ? Math.round(numOr(p.user_calc_length)) : null,
        notes: [
          shortDesc || null,
          p.user_class ? 'Class: ' + p.user_class : null,
          p.user_route_type ? 'Type: ' + p.user_route_type : null,
          p.user_cover_type ? 'Cover: ' + p.user_cover_type : null,
          p.user_diameter ? 'Diameter: ' + p.user_diameter : null,
          p.user_depth ? 'Depth: ' + p.user_depth : null,
          p.user_construction_status ? 'Status: ' + p.user_construction_status : null,
          p.user_pni_id ? 'PNI: ' + p.user_pni_id : null,
          p.user_comments || null
        ].filter(Boolean).join(' · ') || null
      });
      out.stats.routes++;
      continue;
    }
    out.stats.skipped++;
  }

  out.structures = [...structByRef.values()];
  return out;
}
