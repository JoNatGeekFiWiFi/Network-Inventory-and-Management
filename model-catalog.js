// Device model catalog: current MikroTik + Ubiquiti hardware (pulled from mikrotik.com and
// techspecs.ui.com, July 2026). Imported idempotently at startup — only missing models are added,
// so editing/removing rows in the UI sticks and new entries here flow in on the next deploy.
// Format: [model, type, hasWifi, hasCellular] grouped per manufacturer.
// Antennas and accessories are intentionally left out (no credentials/management to track).

const R = 'Router', S = 'Switch', A = 'Access point';

const MIKROTIK = [
  // Ethernet routers
  ['hEX lite', R], ['hEX', R], ['hEX refresh', R], ['hEX S', R], ['hEX S (2025)', R],
  ['hEX PoE lite', R], ['hEX PoE', R], ['PowerBox Pro', R], ['L009UiGS-RM', R],
  ['RB4011iGS+RM', R], ['RB5009UG+S+IN', R], ['RB5009UPr+S+IN', R], ['RB5009UPr+S+OUT', R],
  ['RB1100AHx4', R], ['RB1100AHx4 Dude Edition', R],
  ['CCR2004-16G-2S+', R], ['CCR2004-16G-2S+PC', R], ['CCR2004-1G-12S+2XS', R], ['CCR2004-1G-2XS-PCIe', R],
  ['CCR2116-12G-4S+', R], ['CCR2216-1G-12XS-2XQ', R],
  // Switches
  ['CRS106-1C-5S', S], ['CRS112-8P-4S-IN', S], ['CRS304-4XG-IN', S], ['CRS305-1G-4S+IN', S],
  ['CRS309-1G-8S+IN', S], ['CRS310-1G-5S-4S+IN', S], ['CRS310-8G+2S+IN', S], ['CRS312-4C+8XG-RM', S],
  ['CRS317-1G-16S+RM', S], ['CRS320-8P-8B-4S+RM', S], ['CRS326-24G-2S+IN', S], ['CRS326-24G-2S+RM', S],
  ['CRS326-24S+2Q+RM', S], ['CRS326-4C+20G+2Q+RM', S], ['CRS328-24P-4S+RM', S], ['CRS328-4C-20S-4S+RM', S],
  ['CRS354-48G-4S+2Q+RM', S], ['CRS354-48P-4S+2Q+RM', S], ['CRS418-8P-8G-2S+RM', S],
  ['CRS504-4XQ-IN', S], ['CRS504-4XQ-OUT', S], ['CRS510-8XS-2XQ-IN', S], ['CRS518-16XS-2XQ-RM', S],
  ['CRS520-4XS-16XQ-RM', S], ['CSS318-16G-2S+IN', S], ['CSS326-24G-2S+RM', S],
  ['CSS610-8G-2S+IN', S], ['CSS610-8P-2S+IN', S], ['RB260GS', S], ['RB260GSP', S],
  ['netPower 16P', S], ['netPower 15FR', S], ['netPower Lite 7R', S], ['netPower Lite 8P', S],
  ['netFiber 9', S], ['FiberBox Plus', S],
  // Home / office WiFi
  ['hAP lite', A, 1], ['hAP lite TC', A, 1], ['hAP', A, 1], ['hAP ac lite', A, 1], ['hAP ac lite TC', A, 1],
  ['hAP ac', A, 1], ['hAP ac²', A, 1], ['hAP ac³', A, 1], ['hAP ax lite', A, 1], ['hAP ax S', A, 1],
  ['hAP be lite', A, 1], ['hAP be³ Media', A, 1], ['cAP lite', A, 1], ['cAP', A, 1], ['cAP ac', A, 1],
  ['cAP XL ac', A, 1], ['cAP ax', A, 1], ['wAP', A, 1], ['wAP R', A, 1, 1], ['wAP ax', A, 1],
  ['mAP lite', A, 1], ['mAP', A, 1], ['RB951Ui-2HnD', A, 1],
  ['L009UiGS-2HaxD-IN', R, 1], ['RB4011iGS+5HacQ2HnD-IN', R, 1],
  // LTE / 5G
  ['Chateau LTE6-US', R, 1, 1], ['Chateau LTE7', R, 1, 1], ['Chateau LTE7 ax', R, 1, 1],
  ['Chateau LTE12 (2025)', R, 1, 1], ['Chateau LTE18 ax', R, 1, 1], ['Chateau PRO ax', R, 1, 1],
  ['Chateau 5G R17 ax', R, 1, 1],
  ['LtAP mini', R, 1, 1], ['LtAP mini LTE kit', R, 1, 1], ['LtAP LTE7 kit', R, 1, 1],
  ['wAP LTE kit', A, 1, 1], ['wAP ax LTE7 kit', A, 1, 1], ['cAP LTE12 ax', A, 1, 1],
  ['KNOT', R, 0, 1], ['SXT LTE7 kit', R, 0, 1], ['SXTsq Embedded LTE4', R, 0, 1],
  ['LHGG LTE7 kit', R, 0, 1], ['LHG LTE18 kit', R, 0, 1], ['ATL 5G R16', R, 0, 1], ['ATL LTE18 kit', R, 0, 1],
  // Outdoor wireless (PtP / PtMP)
  ['SXTsq Lite2', A, 1], ['SXTsq Lite5', A, 1], ['SXTsq 5 ac', A, 1], ['SXTsq 5 ax', A, 1],
  ['SXT SA5 ac', A, 1], ['LHG 5', A, 1], ['LHG 5 ax', A, 1], ['LHG XL 5 ac', A, 1], ['LHG XL 5 ax', A, 1],
  ['LHG XL HP5', A, 1], ['LDF 5', A, 1], ['NetBox 5 ax', A, 1], ['NetMetal ax', A, 1], ['NetMetal 5', A, 1],
  ['BaseBox 5', A, 1], ['QRT 5', A, 1], ['Groove 52', A, 1], ['GrooveA 52', A, 1], ['GrooveA 52 ac', A, 1],
  ['Metal 52 ac', A, 1], ['OmniTIK 5 PoE ac', A, 1], ['mANTBox 2 12s', A, 1], ['mANTBox ax 15s', A, 1]
];

const UBIQUITI = [
  // UniFi WiFi 7 / 6 / legacy APs
  ['U7-Pro', A, 1], ['U7-Pro-Max', A, 1], ['U7-Pro-XG', A, 1], ['U7-Pro-XGS', A, 1],
  ['U7-Pro-Wall', A, 1], ['U7-Pro-XG-Wall', A, 1], ['U7-Pro-Outdoor', A, 1], ['U7-Outdoor', A, 1],
  ['U7-In-Wall', A, 1], ['U7-Lite', A, 1], ['U7-Mesh', A, 1], ['U7-LR', A, 1],
  ['E7', A, 1], ['E7-Campus', A, 1], ['E7-Audience', A, 1],
  ['U6-Enterprise', A, 1], ['U6-Enterprise-IW', A, 1], ['U6-Pro', A, 1], ['U6-LR', A, 1],
  ['U6+', A, 1], ['U6-Lite', A, 1], ['U6-IW', A, 1], ['U6-Extender', A, 1], ['U6-Mesh', A, 1], ['U6-Mesh-Pro', A, 1],
  ['UAP-AC-PRO', A, 1], ['UAP-AC-LR', A, 1], ['UAP-AC-LITE', A, 1], ['UAP-AC-IW', A, 1],
  ['UAP-IW-HD', A, 1], ['UAP-AC-M', A, 1], ['UAP-AC-M-PRO', A, 1],
  // UniFi cloud gateways / routers
  ['UDM-Pro', R], ['UDM-SE', R], ['UDM-Pro-Max', R], ['UDR', R, 1], ['UDR7', R, 1],
  ['Dream Router 5G Max', R, 1, 1], ['UCG-Ultra', R], ['UCG-Max', R], ['UCG-Fiber', R],
  ['UXG-Lite', R], ['UXG-Max', R], ['UXG-Pro', R], ['EFG', R],
  // UniFi switches
  ['USW-Flex-Mini', S], ['USW-Flex', S], ['USW-Flex-XG', S], ['USW-Flex-Utility', S],
  ['USW-Flex-2.5G-5', S], ['USW-Flex-2.5G-8', S], ['USW-Flex-2.5G-8-PoE', S],
  ['USW-Ultra', S], ['USW-Ultra-60W', S], ['USW-Ultra-210W', S],
  ['USW-Lite-8-PoE', S], ['USW-Lite-16-PoE', S], ['USW-Pro-8-PoE', S], ['USW-Enterprise-8-PoE', S],
  ['USW-16-POE', S], ['USW-24', S], ['USW-24-POE', S], ['USW-48', S], ['USW-48-POE', S],
  ['USW-Pro-24', S], ['USW-Pro-24-POE', S], ['USW-Pro-48', S], ['USW-Pro-48-POE', S],
  ['USW-Pro-Max-16', S], ['USW-Pro-Max-16-PoE', S], ['USW-Pro-Max-24', S], ['USW-Pro-Max-24-PoE', S],
  ['USW-Pro-Max-48', S], ['USW-Pro-Max-48-PoE', S], ['USW-Pro-HD-24', S], ['USW-Pro-HD-24-PoE', S],
  ['USW-Pro-XG-8-PoE', S], ['USW-Pro-XG-10-PoE', S], ['USW-Pro-XG-24', S], ['USW-Pro-XG-24-PoE', S],
  ['USW-Pro-XG-48', S], ['USW-Pro-XG-48-PoE', S], ['USW-Enterprise-24-PoE', S], ['USW-Enterprise-48-PoE', S],
  ['USW-Aggregation', S], ['USW-Pro-Aggregation', S], ['USW-Pro-XG-Aggregation', S],
  ['USW-Mission-Critical', S], ['USW-Industrial', S],
  ['US-8', S], ['US-8-60W', S], ['US-8-150W', S], ['US-24', S], ['US-48', S],
  ['ECS-24-PoE', S], ['ECS-48-PoE', S], ['ECS-Aggregation', S],
  // EdgeMAX routers
  ['ER-X', R], ['ER-X-SFP', R], ['ERLite-3', R], ['ERPoe-5', R], ['ER-4', R], ['ER-6P', R],
  ['ER-8-XG', R], ['ER-10X', R], ['ER-12', R], ['ER-12P', R],
  // UISP fixed wireless: 60 GHz Wave + LTU
  ['Wave MLO5', A, 1], ['Wave MLO6', A, 1],
  ['LTU Rocket', A, 1], ['LTU Instant', A, 1], ['LTU Pro', A, 1], ['LTU Lite', A, 1],
  ['LTU Long-Range', A, 1], ['LTU Extreme-Range', A, 1],
  // UISP airMAX
  ['PrismStation 5AC', A, 1], ['Rocket Prism 5AC', A, 1], ['Rocket Prism 2AC', A, 1], ['Rocket AC Lite', A, 1],
  ['PowerBeam 5AC', A, 1], ['PowerBeam 5AC ISO', A, 1], ['PowerBeam 5AC 500', A, 1], ['PowerBeam 5AC 620', A, 1],
  ['PowerBeam 2AC 400', A, 1], ['PowerBeam M2 400', A, 1],
  ['PowerBeam M5 300', A, 1], ['PowerBeam M5 300 ISO', A, 1], ['PowerBeam M5 400', A, 1], ['PowerBeam M5 400 ISO', A, 1],
  ['LiteBeam 5AC', A, 1], ['LiteBeam 5AC Long-Range', A, 1], ['LiteBeam 5AC Extreme-Range', A, 1], ['LiteBeam M5', A, 1],
  ['NanoBeam 5AC', A, 1], ['NanoBeam 2AC', A, 1], ['NanoBeam M5', A, 1],
  ['NanoStation 5AC', A, 1], ['NanoStation 5AC Loco', A, 1], ['NanoStation M5', A, 1], ['NanoStation M5 loco', A, 1],
  ['NanoStation M2', A, 1], ['NanoStation M2 loco', A, 1],
  ['IsoStation 5AC', A, 1], ['IsoStation M5', A, 1], ['Lite AP', A, 1], ['Lite AP GPS', A, 1],
  ['Bullet AC', A, 1], ['Bullet AC IP67', A, 1], ['Bullet M2', A, 1], ['Rocket M3', A, 1],
  // UISP airFiber PtP
  ['airFiber 24', A, 1], ['airFiber 24 Hi-Density', A, 1], ['airFiber 11', A, 1],
  ['airFiber 11 Low-Band', A, 1], ['airFiber 11 High-Band', A, 1], ['airFiber 5XHD', A, 1],
  ['airFiber 5 Mid-Band', A, 1], ['airFiber 5 High-Band', A, 1], ['airFiber 2X', A, 1]
];

// ---- OpenWrt hardware -----------------------------------------------------------------------
//
// Hardware that SHIPS running OpenWrt, so the platform is known from the model alone. The Katalyst
// Spark is a rebadged GL.iNet XE3000 — both names are listed, because a technician holding the box
// will search for what is printed on it, not for what is inside.
const KATALYST = [
  ['Spark K500A', R, 1, 1]
];

const GLINET = [
  ['GL-XE3000 (Puli AX)', R, 1, 1], ['GL-X3000 (Spitz AX)', R, 1, 1], ['GL-X750 (Spitz)', R, 1, 1],
  ['GL-XE300 (Puli)', R, 1, 1], ['GL-E750 (Mudi)', R, 1, 1], ['GL-X1200 (Amarok)', R, 1, 1],
  ['GL-MT6000 (Flint 2)', R, 1], ['GL-AX1800 (Flint)', R, 1], ['GL-MT3000 (Beryl AX)', R, 1],
  ['GL-A1300 (Slate Plus)', R, 1], ['GL-AXT1800 (Slate AX)', R, 1], ['GL-MT2500 (Brume 2)', R],
  ['GL-B3000 (Marble)', R, 1], ['GL-SFT1200 (Opal)', R, 1], ['GL-AR750S (Slate)', R, 1]
];

// ---- flashable hardware ----------------------------------------------------------------------
//
// These ship with the manufacturer's own firmware and may be running stock, OpenWrt or DD-WRT. The
// model genuinely does not say which, so they default to "unknown" and Identify settles it in a few
// seconds. Guessing here would assign a driver that fails every poll for a reason nobody can see.
const LINKSYS = [
  ['WRT1900AC', R, 1], ['WRT1900ACS', R, 1], ['WRT3200ACM', R, 1], ['WRT32X', R, 1],
  ['WRT1200AC', R, 1], ['WRT54GL', R, 1], ['E8450', R, 1]
];

const NETGEAR = [
  ['R7800 (Nighthawk X4S)', R, 1], ['R7000 (Nighthawk)', R, 1], ['R6700', R, 1],
  ['WNDR3800', R, 1], ['WNDR4300', R, 1]
];

const TPLINK = [
  ['Archer C7', R, 1], ['Archer A7', R, 1], ['Archer C2600', R, 1], ['Archer AX23', R, 1],
  ['TL-WDR3600', R, 1], ['TL-WR1043ND', R, 1]
];

/**
 * Insert any catalog models not already present, and keep the platform hint current.
 *
 * The platform belongs on the MODEL, not in a regex over its name. A device form that guesses
 * "openwrt" from the string "Spark" is guessing; one that reads it from the catalog row knows. It
 * stays a default — every device can override it, because the same Linksys chassis runs three
 * different operating systems depending on what somebody flashed onto it.
 *
 * Returns how many models were added.
 */
export function importModelCatalog(db) {
  db.exec("UPDATE device_models SET manufacturer='Ubiquiti' WHERE manufacturer='Ubiquiti UniFi'"); // normalize legacy seed rows
  // Added here rather than in db.js migrate() so the column and the values that fill it arrive
  // together — a column that exists but is empty until the next deploy is its own kind of bug.
  const hasCol = db.prepare('PRAGMA table_info(device_models)').all().some(c => c.name === 'default_platform');
  if (!hasCol) db.exec('ALTER TABLE device_models ADD COLUMN default_platform TEXT');

  const exists = db.prepare('SELECT id, default_platform FROM device_models WHERE manufacturer=? COLLATE NOCASE AND model=? COLLATE NOCASE');
  const ins = db.prepare('INSERT INTO device_models (manufacturer, model, device_type, has_wifi, has_cellular, default_platform) VALUES (?,?,?,?,?,?)');
  const setPlatform = db.prepare('UPDATE device_models SET default_platform=? WHERE id=?');
  let added = 0;

  const load = (manufacturer, list, platform) => {
    for (const [model, type, wifi, cell] of list) {
      const row = exists.get(manufacturer, model);
      if (row) {
        // Backfill rows that predate the column, without overwriting a value someone has set by
        // hand — a correction made in the UI has to survive the next deploy.
        if (!row.default_platform && platform) setPlatform.run(platform, row.id);
        continue;
      }
      ins.run(manufacturer, model, type, wifi ? 1 : 0, cell ? 1 : 0, platform || null);
      added++;
    }
  };

  load('MikroTik', MIKROTIK, 'routeros');
  // UniFi is managed by its own controller, not from here — polling it is not built, so claiming a
  // platform would offer cards that cannot work.
  load('Ubiquiti', UBIQUITI, 'unknown');
  load('Katalyst', KATALYST, 'openwrt');
  load('GL.iNet', GLINET, 'openwrt');
  load('Linksys', LINKSYS, null);
  load('Netgear', NETGEAR, null);
  load('TP-Link', TPLINK, null);

  // Manufacturer-level backfill, for rows that are in the database but not in the lists above —
  // seed data, and anything added by hand in the UI. Without this a MikroTik somebody typed in
  // themselves gets no hint, and the form leaves its operating system unset.
  //
  // Only ever fills a BLANK: every manufacturer here makes exactly one operating system, so the
  // inference is safe in a way it would not be for Linksys or Netgear, which are deliberately absent.
  // Single quotes: in SQLite a double-quoted token is an IDENTIFIER, so `default_platform=""`
  // parses as a comparison against a column named "" and throws at startup.
  const byMaker = db.prepare("UPDATE device_models SET default_platform=? WHERE manufacturer=? COLLATE NOCASE AND (default_platform IS NULL OR default_platform='')");
  byMaker.run('routeros', 'MikroTik');
  byMaker.run('unknown', 'Ubiquiti');
  byMaker.run('openwrt', 'GL.iNet');
  byMaker.run('openwrt', 'Katalyst');

  return added;
}
