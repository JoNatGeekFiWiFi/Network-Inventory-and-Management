// The surface the phone and tablet apps talk to.
//
// Why a separate surface at all, when /api already has 222 endpoints: those were shaped for a
// browser SPA that can afford a dozen round trips over a desk connection. A tech standing in a
// basement on one bar of LTE cannot. These endpoints are shaped by the JOB — "show me everything
// about this site", "what did I just scan" — so that opening a site is one request, and so that a
// future native app inherits a contract instead of reverse-engineering the web app's.
//
// Two rules hold everywhere in here:
//   1. No credentials, ever. Not in a list, not in a detail, not in the scan result. Credentials
//      come only from the existing audited /reveal call, so a cached mobile response can never be
//      the thing that leaks a router password off a lost phone.
//   2. Everything is role-aware in the same way the web app is. A token carries its user's role
//      and nothing more.
import { normalizeMac } from '../lib/normalize.js';

export default function registerMobile(app, ctx) {
  const { db, audit, isPriv, publicDevice, customerAccounts,
          verifyPassword, createApiToken, clientIp, loginThrottle, loginSucceeded } = ctx;

  // What the app is built against. Bumped when a response shape changes in a way an older build
  // cannot cope with, so the app can say "update me" rather than silently mis-rendering.
  const API_VERSION = 1;

  // ---- sign in and get a device token -------------------------------------------------
  //
  // Outside the /api auth middleware on purpose: this is how a device gets its credential in the
  // first place. Same throttle as the web login, because it is the same password being guessed.
  app.post('/api/m/session', (req, res) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const wait = loginThrottle(req, 'mobile:' + email);
    if (wait) return res.status(429).json({ error: `Too many attempts — try again in ${wait} minute(s)` });

    const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
    if (!u || !verifyPassword(String(b.password || ''), u.password_hash))
      return res.status(401).json({ error: 'Invalid email or password' });
    loginSucceeded(req, 'mobile:' + email);

    const name = String(b.device_name || '').trim() || 'Unnamed device';
    const platform = ['ios', 'ipados', 'web', 'other'].includes(b.platform) ? b.platform : 'other';
    const { id, token } = createApiToken(u.id, { name, platform });
    audit(req, 'token_issue', 'api_token#' + id, `${name} (${platform})`);
    res.json({
      token,                                    // shown once; the device stores it
      token_id: id,
      api_version: API_VERSION,
      user: { id: u.id, name: u.name, email: u.email, role: u.role }
    });
  });

  // Everything below is inside the /api auth middleware, so req.user is set either way.

  app.get('/api/m/me', (req, res) => {
    res.json({
      api_version: API_VERSION,
      user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role },
      auth_via: req.authVia || 'cookie',
      device: req.user.token_name || null,
      // What the app should offer. Sending this rather than duplicating the role rules in the
      // client means a role change takes effect without shipping a new build.
      can: {
        see_credentials: isPriv(req),
        edit_devices: true,
        delete: isPriv(req),
        see_money: isPriv(req)
      }
    });
  });

  /** Sign this device out by killing its own token. Needs no special privilege — it is self-harm. */
  app.post('/api/m/signout', (req, res) => {
    if (req.authVia !== 'token' || !req.user.token_id)
      return res.status(400).json({ error: 'Not signed in with a device token' });
    db.prepare("UPDATE api_tokens SET revoked_at=datetime('now') WHERE id=? AND revoked_at IS NULL").run(req.user.token_id);
    audit(req, 'token_revoke', 'api_token#' + req.user.token_id, 'signed out on device');
    res.json({ ok: true });
  });

  // ---- reference data ------------------------------------------------------------------
  //
  // The lists a device needs to fill in a form: carriers, accounts, models. Small, changes rarely,
  // and fetched once at launch instead of per screen. `version` lets the app skip the download
  // when nothing has changed.
  app.get('/api/m/bootstrap', (req, res) => {
    const carriers = db.prepare('SELECT id, name FROM upstream_providers ORDER BY name').all();
    const accounts = db.prepare(`SELECT a.id, a.name, a.account_number, a.carrier_id, p.name AS carrier_name
      FROM accounts a LEFT JOIN upstream_providers p ON p.id=a.carrier_id
      WHERE a.status='Active' ORDER BY a.name`).all();
    const models = db.prepare('SELECT id, manufacturer, model, device_type FROM device_models ORDER BY manufacturer, model').all();
    const statuses = db.prepare("SELECT DISTINCT status FROM devices WHERE status IS NOT NULL AND status<>'' ORDER BY status").all().map(r => r.status);
    // A cheap change-stamp: if nothing has been added or edited, the counts and newest ids hold.
    const stamp = [carriers.length, accounts.length, models.length,
      db.prepare('SELECT COALESCE(MAX(id),0) n FROM accounts').get().n,
      db.prepare('SELECT COALESCE(MAX(id),0) n FROM device_models').get().n].join('.');
    res.json({ api_version: API_VERSION, version: stamp, carriers, accounts, models, device_statuses: statuses });
  });

  // ---- one site, everything a tech needs on arrival -------------------------------------
  app.get('/api/m/site/:id', (req, res) => {
    const s = db.prepare('SELECT * FROM sites WHERE id=?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });

    const account = db.prepare(`SELECT a.id, a.name, a.account_number, p.name AS carrier_name
      FROM accounts a LEFT JOIN upstream_providers p ON p.id=a.carrier_id WHERE a.id=?`).get(s.account_id) || null;
    const units = db.prepare(`SELECT u.id, u.label, u.status, u.customer_id, c.name AS customer_name
      FROM site_units u LEFT JOIN customers c ON c.id=u.customer_id
      WHERE u.site_id=? ORDER BY LTRIM(u.label,'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz #')+0, u.label`).all(s.id);
    const devices = db.prepare(`SELECT d.*, m.manufacturer, m.model, m.device_type
      FROM devices d LEFT JOIN device_models m ON m.id=d.model_id
      WHERE d.assigned_type='site' AND d.assigned_site_id=? ORDER BY d.name`).all(s.id).map(publicDevice);

    res.json({
      api_version: API_VERSION,
      site: {
        id: s.id, name: s.name, service_address: s.service_address, lat: s.lat, lng: s.lng,
        status: s.status, is_mdu: !!s.is_mdu, notes: s.notes,
        current_mgmt_ip: s.current_mgmt_ip, current_public_ip: s.current_public_ip
      },
      account,
      customer: s.customer_id ? db.prepare('SELECT id, name, billing_email, sms_number FROM customers WHERE id=?').get(s.customer_id) : null,
      subaccount: s.subaccount_id ? db.prepare('SELECT id, name FROM account_subaccounts WHERE id=?').get(s.subaccount_id) : null,
      units,
      devices,
      connections: db.prepare(`SELECT id, role, status, priority, bandwidth, served_type, wan_port, ip_type, current_ip
        FROM connections WHERE site_id=? ORDER BY priority`).all(s.id),
      recent_notes: db.prepare('SELECT id, body, author, created_at FROM site_notes WHERE site_id=? ORDER BY datetime(created_at) DESC LIMIT 5').all(s.id)
    });
  });

  // ---- one device --------------------------------------------------------------------
  app.get('/api/m/device/:id', (req, res) => {
    const d = db.prepare(`SELECT d.*, m.manufacturer, m.model, m.device_type
      FROM devices d LEFT JOIN device_models m ON m.id=d.model_id WHERE d.id=?`).get(req.params.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    const out = publicDevice(d);      // strips every credential, leaves has_* flags
    if (d.assigned_site_id) {
      out.site = db.prepare('SELECT id, name, service_address FROM sites WHERE id=?').get(d.assigned_site_id) || null;
      if (d.unit_id) out.unit = db.prepare('SELECT id, label FROM site_units WHERE id=?').get(d.unit_id) || null;
    }
    res.json({ api_version: API_VERSION, device: out });
  });

  // ---- scan -----------------------------------------------------------------------------
  /**
   * Resolve a scanned or typed code to whatever it is.
   *
   * This is the whole point of the phone app: a tech points the camera at a label and the system
   * says "that's the hAP ax2 at 1400 W Elliot, Apt 12" or "that serial is new — add it?".
   *
   * The label could be a serial, a MAC (bare hex on most equipment labels), an account number, or
   * a site's own address. Rather than making the app guess and send a type, everything is tried
   * and the matches come back ranked, because a barcode carries no indication of which it is.
   */
  app.get('/api/m/scan', (req, res) => {
    const raw = String(req.query.code || '').trim();
    if (!raw) return res.status(400).json({ error: 'Nothing scanned' });
    if (raw.length > 120) return res.status(400).json({ error: 'That code is too long to be a label' });

    const matches = [];
    const seen = new Set();
    const push = (type, id, label, detail, how) => {
      const k = type + '#' + id;
      if (seen.has(k)) return;
      seen.add(k);
      matches.push({ type, id, label, detail, matched_on: how });
    };

    // A MAC on a label is usually printed without separators. normalizeMac turns both forms into
    // the one shape the database holds, which is what makes the scan match at all.
    const mac = normalizeMac(raw);
    const isMac = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(String(mac));

    const devSql = `SELECT d.id, d.name, d.serial, d.mac, d.status, d.assigned_site_id, d.unit_id,
        m.manufacturer, m.model, s.name AS site_name, s.service_address, u.label AS unit_label
      FROM devices d LEFT JOIN device_models m ON m.id=d.model_id
      LEFT JOIN sites s ON s.id=d.assigned_site_id LEFT JOIN site_units u ON u.id=d.unit_id`;
    const describe = d => [
      [d.manufacturer, d.model].filter(Boolean).join(' ') || null,
      d.site_name ? (d.unit_label ? `${d.site_name} · ${d.unit_label}` : d.site_name) : 'Unassigned'
    ].filter(Boolean).join(' — ');

    if (isMac) {
      for (const d of db.prepare(`${devSql} WHERE UPPER(REPLACE(REPLACE(d.mac,'-',':'),'.',''))=? OR UPPER(REPLACE(d.hfc_mac,'-',':'))=?`).all(mac, mac))
        push('device', d.id, d.name, describe(d), 'MAC');
    }
    for (const d of db.prepare(`${devSql} WHERE d.serial IS NOT NULL AND UPPER(TRIM(d.serial))=UPPER(?)`).all(raw))
      push('device', d.id, d.name, describe(d), 'serial');

    // Account numbers are printed on carrier equipment and paperwork too.
    for (const a of db.prepare(`SELECT a.id, a.name, a.account_number, p.name AS carrier_name
        FROM accounts a LEFT JOIN upstream_providers p ON p.id=a.carrier_id
        WHERE a.account_number IS NOT NULL AND TRIM(a.account_number)=TRIM(?)`).all(raw))
      push('account', a.id, a.name, [a.carrier_name, a.account_number].filter(Boolean).join(' · '), 'account number');

    // A QR code stuck on a cabinet may just be a site id or a URL ending in one.
    const idFromUrl = raw.match(/#\/site\/(\d+)/) || raw.match(/^site:(\d+)$/i);
    if (idFromUrl) {
      const s = db.prepare('SELECT id, name, service_address FROM sites WHERE id=?').get(Number(idFromUrl[1]));
      if (s) push('site', s.id, s.name, s.service_address, 'site code');
    }

    // Nothing exact: offer a partial serial match, which catches a mis-read character or a label
    // that carries a longer string than the serial itself.
    if (!matches.length && raw.length >= 6) {
      const like = '%' + raw.replace(/[%_\\]/g, c => '\\' + c) + '%';
      for (const d of db.prepare(`${devSql} WHERE d.serial LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\' LIMIT 5`).all(like, like))
        push('device', d.id, d.name, describe(d), 'partial serial');
    }

    res.json({
      api_version: API_VERSION,
      code: raw,
      // What the app should prefill if the tech chooses to create a device from this scan.
      interpreted: { mac: isMac ? mac : null, serial: isMac ? null : raw },
      matches,
      // An unmatched scan is the normal case on a new install, not an error — say so plainly so
      // the app offers "add this device" rather than showing a failure.
      status: matches.length ? 'found' : 'unknown'
    });
  });

  // ---- assign a scanned device to where it now lives -------------------------------------
  app.post('/api/m/device/:id/assign', (req, res) => {
    const b = req.body || {};
    const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'not found' });

    const siteId = b.site_id ? Number(b.site_id) : null;
    if (siteId && !db.prepare('SELECT id FROM sites WHERE id=?').get(siteId))
      return res.status(400).json({ error: 'No such site' });

    // A unit has to belong to the site being assigned, or the device ends up filed under a tenant
    // of a different building.
    let unitId = b.unit_id ? Number(b.unit_id) : null;
    if (unitId) {
      const u = db.prepare('SELECT id, site_id FROM site_units WHERE id=?').get(unitId);
      if (!u) return res.status(400).json({ error: 'No such unit' });
      if (siteId && u.site_id !== siteId) return res.status(400).json({ error: 'That unit belongs to a different site' });
    }

    if (siteId) {
      db.prepare("UPDATE devices SET assigned_type='site', assigned_site_id=?, unit_id=?, status=COALESCE(?, status), enroll_pending=0 WHERE id=?")
        .run(siteId, unitId, b.status || null, d.id);
    } else {
      // Explicitly clearing the assignment — the device came back to the van.
      db.prepare("UPDATE devices SET assigned_type='stock', assigned_site_id=NULL, unit_id=NULL, status=COALESCE(?, status) WHERE id=?")
        .run(b.status || null, d.id);
    }
    audit(req, 'edit', 'device#' + d.id, siteId ? `assigned to site#${siteId}${unitId ? ' unit#' + unitId : ''} from device app` : 'returned to stock from device app');
    res.json({ ok: true });
  });

  // ---- what a tech is likely to want next ------------------------------------------------
  /**
   * Sites near a point, for "which of my jobs am I standing at".
   *
   * Bounded by a rough degree box before the distance maths so it stays an indexed-ish scan rather
   * than a full table sort — the same trick the fibre map uses.
   */
  app.get('/api/m/nearby', (req, res) => {
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat and lng are required' });
    const km = Math.min(50, Math.max(0.1, Number(req.query.km) || 5));
    const dLat = km / 111;
    const dLng = km / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));

    const rows = db.prepare(`SELECT id, name, service_address, lat, lng, status FROM sites
      WHERE lat IS NOT NULL AND lng IS NOT NULL AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`)
      .all(lat - dLat, lat + dLat, lng - dLng, lng + dLng);

    const R = 6371000, rad = d => d * Math.PI / 180;
    const out = rows.map(s => {
      const a = Math.sin(rad(s.lat - lat) / 2) ** 2 +
        Math.cos(rad(lat)) * Math.cos(rad(s.lat)) * Math.sin(rad(s.lng - lng) / 2) ** 2;
      return { ...s, distance_m: Math.round(2 * R * Math.asin(Math.sqrt(a))) };
    }).filter(s => s.distance_m <= km * 1000)
      .sort((a, b) => a.distance_m - b.distance_m).slice(0, 25);

    res.json({ api_version: API_VERSION, sites: out });
  });
}
