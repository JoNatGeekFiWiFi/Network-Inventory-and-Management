// The fiber map's layer tree.
//
//   Zayo                     everything imported from Zayo's IQGeo
//     Underground            routes placed buried / underground / in conduit
//     Aerial                 routes on poles (IQGeo "Route (Overhead)")
//     Placement unknown      routes IQGeo gives no placement for — including every fiber SPAN path,
//                            because spans are logical fiber runs and IQGeo records placement on
//                            the physical route they ride, not on the span
//     Structures             handholes, vaults, splice points…
//   Our plant                anything drawn here or imported from another format
//     Routes
//     Structures
//
// Which network a record belongs to is stored (fiber_routes.network / fiber_structures.network):
// set to 'zayo' by the IQGeo importer, and backfilled once from ext_ref, which only the IQGeo
// importer ever sets. NULL means our own plant.
//
// Keys are 'network.sub'. The client sends the ones that are switched on; the server turns them
// into one WHERE clause, so hidden layers cost nothing — they are not fetched and then thrown away,
// which matters because the viewport query is capped and hidden features would eat the cap.

export const PLACEMENT_GROUP = { buried: 'underground', underground: 'underground', conduit: 'underground', aerial: 'aerial' };
export const placementGroup = (p) => PLACEMENT_GROUP[String(p || '').toLowerCase()] || 'unknown';

export const LAYER_TREE = [
  { key: 'zayo', label: 'Zayo', children: [
    { key: 'zayo.underground', label: 'Underground', kind: 'route' },
    { key: 'zayo.aerial', label: 'Aerial', kind: 'route' },
    { key: 'zayo.unknown', label: 'Placement unknown', kind: 'route' },
    { key: 'zayo.structures', label: 'Structures', kind: 'structure' }
  ] },
  { key: 'own', label: 'Our plant', children: [
    { key: 'own.routes', label: 'Routes', kind: 'route' },
    { key: 'own.structures', label: 'Structures', kind: 'structure' }
  ] }
];
export const ALL_LAYER_KEYS = LAYER_TREE.flatMap(g => g.children.map(c => c.key));

const UNDERGROUND = "LOWER(COALESCE(placement,'')) IN ('buried','underground','conduit')";
const AERIAL = "LOWER(COALESCE(placement,''))='aerial'";
const ROUTE_SQL = {
  'zayo.underground': `(network='zayo' AND ${UNDERGROUND})`,
  'zayo.aerial': `(network='zayo' AND ${AERIAL})`,
  'zayo.unknown': `(network='zayo' AND NOT ${UNDERGROUND} AND NOT ${AERIAL})`,
  'own.routes': "(network IS NULL OR network<>'zayo')"
};
const STRUCT_SQL = {
  'zayo.structures': "(network='zayo')",
  'own.structures': "(network IS NULL OR network<>'zayo')"
};

/**
 * Parse ?layers= into a set of known keys. Absent means everything (the old behaviour, and what
 * other callers of the endpoint expect); present but empty means nothing.
 */
export function parseLayers(param) {
  if (param === undefined || param === null) return new Set(ALL_LAYER_KEYS);
  return new Set(String(param).split(',').map(s => s.trim()).filter(k => ALL_LAYER_KEYS.includes(k)));
}

/** SQL fragments for the routes and structures a layer set asks for; null means "none at all". */
export function layerWhere(keys) {
  const r = [...keys].filter(k => ROUTE_SQL[k]).map(k => ROUTE_SQL[k]);
  const s = [...keys].filter(k => STRUCT_SQL[k]).map(k => STRUCT_SQL[k]);
  return { routes: r.length ? '(' + r.join(' OR ') + ')' : null, structures: s.length ? '(' + s.join(' OR ') + ')' : null };
}

/** Counts for every layer, for the numbers beside each checkbox. */
export function layerCounts(db) {
  const out = {};
  for (const [k, sql] of Object.entries(ROUTE_SQL)) out[k] = db.prepare(`SELECT COUNT(*) n FROM fiber_routes WHERE ${sql}`).get().n;
  for (const [k, sql] of Object.entries(STRUCT_SQL)) out[k] = db.prepare(`SELECT COUNT(*) n FROM fiber_structures WHERE ${sql}`).get().n;
  return out;
}
