// Router maintenance from the device page: reboot, firmware, and (OpenWrt) packages.
//
// MikroTik already had firmware/package updates through the Batch page; this adds the per-device
// view for both platforms and the OpenWrt paths that did not exist: flashing an uploaded image
// (validated by the router before anything is written) and installing/removing opkg packages.
import express from 'express';
import { driverFor, platformOf, can } from '../lib/drivers/index.js';
import { sshExec } from '../lib/sshexec.js';

export default function registerMaintenance(app, ctx) {
  const { db, requireNoc, audit, restReq, rosHeaders } = ctx;
  const device = (id) => db.prepare('SELECT * FROM devices WHERE id=?').get(id);
  const ready = (d) => d && d.management_mode === 'platform' && d.mgmt_address && d.admin_password;
  const need = (cap) => (req, res, next) => {
    const d = device(req.params.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    if (!ready(d)) return res.status(400).json({ error: 'This device has no management address or admin password on file' });
    if (!can(d, cap)) return res.status(400).json({ error: `${d.name} cannot do this from here`, unsupported: true });
    req.device = d; next();
  };
  const ros = (d) => async (method, path, body, timeoutMs = 15000) => {
    const r = await restReq(d.mgmt_address, path, { headers: rosHeaders(d), method, body, timeoutMs });
    let data = null; try { data = r.body ? JSON.parse(r.body) : null; } catch {}
    return { status: r.status, data, body: r.body };
  };

  // ---- reboot ----
  app.post('/api/devices/:id/reboot', requireNoc, need('reboot'), async (req, res) => {
    const d = req.device;
    try {
      if (platformOf(d) === 'openwrt') {
        const r = await (await driverFor(d, { sshExec })).reboot();
        if (!r.ok) return res.status(502).json({ error: r.error });
      } else {
        try { const r = await ros(d)('POST', '/rest/system/reboot', {}); if (r.status >= 400) return res.status(502).json({ error: 'Device returned ' + r.status }); }
        catch (e) { if (!(['ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(e.code) || e.message === 'timeout')) throw e; }
      }
      audit(req, 'reboot', 'device#' + d.id, String((req.body || {}).reason || '').slice(0, 200));
      res.json({ ok: true, message: `${d.name} is rebooting — it should be back in a minute or two.` });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // ---- firmware ----
  app.get('/api/devices/:id/firmware', requireNoc, need('firmware'), async (req, res) => {
    const d = req.device;
    try {
      if (platformOf(d) === 'openwrt') return res.json({ platform: 'openwrt', ...(await (await driverFor(d, { sshExec })).firmware()), canUpgradeFromHere: true });
      const call = ros(d);
      const rb = await call('GET', '/rest/system/routerboard');
      const up = await call('GET', '/rest/system/package/update');
      const b = [].concat(rb.data || [])[0] || {}, u = [].concat(up.data || [])[0] || {};
      res.json({ platform: 'routeros', running: u['installed-version'] || d.ros_version || null, latest: u['latest-version'] || null, channel: u.channel || null,
        routerboot: { current: b['current-firmware'] || null, upgrade: b['upgrade-firmware'] || null },
        canUpgradeFromHere: false, note: 'Use Batch → Update packages / Update RouterBOOT to upgrade MikroTik routers.' });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  /**
   * Flash an OpenWrt image. The body is the raw image (sysupgrade .bin). Order of events:
   *   1. a configuration backup is taken and filed on the device (so there is always a way back);
   *   2. the image is copied to the router's RAM and the router checks it (board match, signature);
   *   3. only if the router accepts it does the flash start, keeping settings unless told otherwise.
   * The router drops off for a few minutes; the health checks report when it is back.
   */
  app.post('/api/devices/:id/firmware/upgrade', requireNoc, need('firmware'), express.raw({ type: '*/*', limit: '64mb' }), async (req, res) => {
    const d = req.device;
    if (platformOf(d) !== 'openwrt') return res.status(400).json({ error: 'Firmware uploads are for OpenWrt; MikroTik upgrades go through Batch.' });
    const image = Buffer.isBuffer(req.body) ? req.body : null;
    if (!image || !image.length) return res.status(400).json({ error: 'Choose a firmware image file' });
    if (req.query.confirm !== d.name) return res.status(400).json({ error: 'Type the device name to confirm the upgrade' });
    const keep = req.query.keep !== '0';
    let backup = null;
    try { backup = ctx.backupDevice ? await ctx.backupDevice(d, 'pre-upgrade') : null; }
    catch (e) { return res.status(502).json({ error: 'Could not take a configuration backup first, so nothing was flashed: ' + e.message }); }
    try {
      const driver = await driverFor(d, { sshExec });
      const r = await driver.sysupgrade(image, { keep, force: req.query.force === '1' });
      audit(req, 'firmware', 'device#' + d.id, `${r.ok ? 'flashing' : 'refused at ' + r.stage} · ${String(req.headers['x-filename'] || 'image').slice(0, 80)} · ${image.length} bytes · keep settings ${keep}`);
      if (!r.ok) return res.status(r.stage === 'validate' ? 400 : 502).json({ error: r.error, stage: r.stage, tests: r.tests, backup });
      res.json({ ok: true, message: `The router accepted the image and is flashing it${keep ? ' (settings kept)' : ''}. It will be offline for a few minutes.`, tests: r.tests, backup });
    } catch (e) { res.status(502).json({ error: e.message, backup }); }
  });

  // ---- packages (OpenWrt) ----
  app.get('/api/devices/:id/opkg', requireNoc, need('packages'), async (req, res) => {
    try { res.json(await (await driverFor(req.device, { sshExec })).packages()); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.post('/api/devices/:id/opkg', requireNoc, need('packages'), async (req, res) => {
    const d = req.device, b = req.body || {};
    try {
      const r = await (await driverFor(d, { sshExec })).packageAction(String(b.action || ''), String(b.name || '').trim());
      audit(req, 'packages', 'device#' + d.id, `${b.action} ${b.name || ''}${r.ok ? '' : ' — failed'}`);
      if (!r.ok) return res.status(/not a valid|core|Unknown/.test(r.error || '') ? 400 : 502).json({ error: r.error });
      res.json(r);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
}
