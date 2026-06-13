// Network Inventory & Management Platform — frontend SPA
let META = null, CURRENT_USER = null;
const $ = (s, r = document) => r.querySelector(s);
const view = () => $('#view');
const isPriv = () => CURRENT_USER && ['noc', 'admin'].includes(CURRENT_USER.role);
const isAdmin = () => CURRENT_USER && CURRENT_USER.role === 'admin';
const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));

async function api(path, opts = {}) {
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const r = await fetch('/api' + path, opts);
  if (r.status === 401) { CURRENT_USER = null; renderLogin('Your session expired — please sign in.'); throw new Error('auth'); }
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
  return r.json();
}

// ---------- Auth ----------
function renderLogin(msg) {
  $('#sidebar').style.display = 'none';
  $('#userMenu').innerHTML = '';
  view().innerHTML = `<div class="login-wrap"><div class="login-card">
    <h1>Sign in</h1><div class="sec-muted small" style="margin-bottom:16px">Network Inventory &amp; Management</div>
    <div class="fld"><label class="fl">Email</label><input id="li-email" type="email" autocomplete="username"/></div>
    <div class="fld"><label class="fl">Password</label><input id="li-pass" type="password" autocomplete="current-password"/></div>
    <button class="btn primary" style="width:100%;justify-content:center" onclick="doLogin()"><i class="ti ti-login"></i> Sign in</button>
    <div class="login-err" id="li-err">${esc(msg || '')}</div>
    <div class="hint">Test accounts (change after deploy):<br>admin@geekitek.test / admin123<br>noc@geekitek.test / noc123<br>field@geekitek.test / field123<br>support@geekitek.test / support123</div>
  </div></div>`;
  $('#li-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
}
async function doLogin() {
  const email = $('#li-email').value, password = $('#li-pass').value;
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); $('#li-err').textContent = e.error || 'Login failed'; return; }
  CURRENT_USER = await r.json();
  $('#sidebar').style.display = '';
  setupHeader();
  META = await api('/meta');
  location.hash = '#/sites'; route();
}
async function logout() { try { await fetch('/api/logout', { method: 'POST' }); } catch {} CURRENT_USER = null; renderLogin('Signed out.'); }
function setupHeader() {
  $('#userMenu').innerHTML = `<div class="who"><div class="nm">${esc(CURRENT_USER.name || CURRENT_USER.email)}</div><div class="rl">${esc(CURRENT_USER.role)}</div></div>
    <button class="btn sm" onclick="logout()"><i class="ti ti-logout"></i> Sign out</button>`;
  $('#navModels').style.display = isPriv() ? '' : 'none';
  $('#navUsers').style.display = isAdmin() ? '' : 'none';
}
function toast(msg) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1800);
}
function pillFor(status) {
  const s = (status || '').toLowerCase();
  if (['up', 'active', 'online', 'reachable'].includes(s)) return ['s-up', 'var(--success)'];
  if (['standby', 'on failover', 'prospect'].includes(s)) return ['s-warn', 'var(--warning)'];
  if (['down', 'offline', 'suspended', 'closed'].includes(s)) return ['s-down', 'var(--danger)'];
  return ['s-up', 'var(--success)'];
}
function statusPill(status) {
  const [c, col] = pillFor(status);
  return `<span class="pill ${c}"><span class="dot" style="background:${col}"></span>${esc(status)}</span>`;
}
function loc(s) {
  if (s.service_address) return `<a class="iplink" href="https://maps.google.com/?q=${encodeURIComponent(s.service_address)}" target="_blank">${esc(s.service_address)} <i class="ti ti-external-link" style="font-size:11px"></i></a>`;
  if (s.lat != null) return `<a class="iplink mono" href="https://maps.google.com/?q=${s.lat},${s.lng}" target="_blank">${s.lat}, ${s.lng}</a> <span class="muted small">· GPS</span>`;
  return '<span class="muted">—</span>';
}

// ---------- Router ----------
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', init);

async function init() {
  try { CURRENT_USER = await api('/me'); }
  catch { return; } // 401 -> login screen already rendered
  setupHeader();
  try { META = await api('/meta'); } catch (e) { if (e.message !== 'auth') view().innerHTML = `<div class="card" style="padding:20px">Cannot reach API: ${esc(e.message)}</div>`; return; }
  if (!location.hash) location.hash = '#/sites';
  route();
}

function setNav(name) { document.querySelectorAll('.sidebar a').forEach(a => a.classList.toggle('active', a.dataset.nav === name)); }

async function route() {
  if (!CURRENT_USER) return await renderLogin();
  const h = location.hash.replace(/^#/, '') || '/sites';
  const p = h.split('?')[0].split('/').filter(Boolean);
  const q = Object.fromEntries(new URLSearchParams(h.split('?')[1] || ''));
  view().innerHTML = '<div class="loading">Loading…</div>';
  try {
    if (p[0] === 'sites' && !p[1]) { setNav('sites'); return await renderSites(); }
    if (p[0] === 'site' && p[1] === 'new') { setNav('sites'); return await formSite(q); }
    if (p[0] === 'site' && p[2] === 'notes') { setNav('sites'); return await renderNotes(p[1]); }
    if (p[0] === 'site' && p[2] === 'edit') { setNav('sites'); return await formSite({ id: p[1] }); }
    if (p[0] === 'site') { setNav('sites'); return await renderSite(p[1]); }
    if (p[0] === 'customers') { setNav('customers'); return await renderCustomers(); }
    if (p[0] === 'customer' && p[1] === 'new') { setNav('customers'); return await formCustomer({}); }
    if (p[0] === 'customer' && p[2] === 'edit') { setNav('customers'); return await formCustomer({ id: p[1] }); }
    if (p[0] === 'customer') { setNav('customers'); return await renderCustomer(p[1]); }
    if (p[0] === 'inventory') { setNav('inventory'); return await renderInventory(); }
    if (p[0] === 'device' && p[1] === 'new') { setNav('inventory'); return await formDevice(q); }
    if (p[0] === 'device' && p[2] === 'edit') { setNav('inventory'); return await formDevice({ id: p[1] }); }
    if (p[0] === 'device') { setNav('inventory'); return await renderDevice(p[1]); }
    if (p[0] === 'activity') { setNav('activity'); return await renderActivity(); }
    if (p[0] === 'users' && p[1] === 'new') { setNav('users'); return await formUser({}); }
    if (p[0] === 'users' && p[2] === 'edit') { setNav('users'); return await formUser({ id: p[1] }); }
    if (p[0] === 'users') { setNav('users'); return await renderUsers(); }
    if (p[0] === 'models' && p[1] === 'new') { setNav('models'); return await formModel({}); }
    if (p[0] === 'models' && p[2] === 'edit') { setNav('models'); return await formModel({ id: p[1] }); }
    if (p[0] === 'models') { setNav('models'); return await renderModels(); }
    view().innerHTML = '<div class="card" style="padding:20px">Not found</div>';
  } catch (e) { if (e.message === 'auth') return; view().innerHTML = `<div class="card" style="padding:20px">Error: ${esc(e.message)}</div>`; }
}

// ---------- Sites ----------
async function renderSites() {
  const sites = await api('/sites');
  const total = sites.length;
  const attention = sites.filter(s => s.needs_attention).length;
  const offline = sites.reduce((n, s) => n + (s.device_total - s.device_online), 0);
  const rows = sites.map(s => {
    const [, statCol] = pillFor(s.needs_attention ? (s.conn_status === 'Down' ? 'Down' : 'Standby') : 'Up');
    const hwCol = s.device_online < s.device_total ? 'color:var(--warning)' : '';
    return `<div class="row rowlink" onclick="location.hash='#/site/${s.id}'">
      <span class="dot" style="background:${statCol};flex:none"></span>
      <div style="flex:1;min-width:0">
        <div>${esc(s.name)}</div>
        <div class="small sec-muted">${esc(s.account_name || '')}</div>
        <div class="small mono sec-muted">mgmt ${esc(s.current_mgmt_ip || '—')} · pub ${esc(s.current_public_ip || '—')}</div>
      </div>
      <div class="stat">${statusPill(s.conn_status)}<span class="small mono" style="${hwCol}">${s.device_online}/${s.device_total} online</span></div>
      <i class="ti ti-chevron-right muted"></i></div>`;
  }).join('');
  view().innerHTML = `
    <div class="head"><h1 style="flex:1">Sites</h1><a class="btn" href="#/site/new"><i class="ti ti-plus"></i> Add site</a></div>
    <div class="grid3" style="margin:16px 0">
      <div class="metric"><div class="l">Total sites</div><div class="v">${total}</div></div>
      <div class="metric"><div class="l">Needs attention</div><div class="v" style="color:var(--warning)">${attention}</div></div>
      <div class="metric"><div class="l">Devices offline</div><div class="v" style="color:var(--danger)">${offline}</div></div>
    </div>
    <div class="card">${rows || '<div class="row muted">No sites yet</div>'}</div>`;
}

async function renderSite(id) {
  const s = await api('/sites/' + id);
  const connCards = s.connections.map(c => {
    const ipline = c.ip_type === 'Static' ? `Static · ${esc(c.static_ip || '')}` : `Dynamic · ${esc(c.current_ip || '')}`;
    return `<div class="metric" style="background:var(--surface);border:.5px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span class="small sec-muted">${esc(c.role)} ${c.wan_port ? '· <b>' + (c.role === 'Primary' ? 'WAN1' : 'WAN2') + '</b>' : ''}</span>${statusPill(c.status)}</div>
      <div style="font-weight:500">${esc(c.served_label || '—')}</div>
      <div class="small sec-muted">${c.wan_port ? '<span class="wan"><i class="ti ti-plug"></i> ' + esc(c.wan_port) + '</span> &nbsp;' : ''}${ipline}</div>
    </div>`;
  }).join('') || '<div class="metric muted">No connections</div>';

  const hw = s.devices.map(d => {
    const overlay = d.mgmt_overlay ? `<span class="tag">${esc(d.mgmt_overlay)}</span>` : (d.management_mode === 'provider' ? '<span class="tag">Cox</span>' : '');
    const ip = d.mgmt_address ? `<a class="iplink" href="https://${esc(d.mgmt_address)}" target="_blank">${esc(d.mgmt_address)} <i class="ti ti-external-link" style="font-size:11px"></i></a>` : '<span class="muted">—</span>';
    return `<div class="row rowlink" onclick="location.hash='#/device/${d.id}'">
      <i class="ti ti-${iconFor(d.device_type)} sec-muted"></i>
      <div style="flex:1;min-width:0">
        <div>${esc(d.name)} · ${esc(d.manufacturer || '')} ${esc(d.model || '')}</div>
        <div class="small mono sec-muted">${esc(d.mac || '')} &nbsp;·&nbsp; ${ip}</div>
      </div>${overlay}
      <div class="stat">${statusPill(d.online ? 'Online' : 'Offline')}</div></div>`;
  }).join('') || '<div class="row muted">No hardware</div>';

  const note = s.notes[0];
  view().innerHTML = `
    <div class="crumb" onclick="location.hash='#/sites'"><i class="ti ti-chevron-left"></i> Sites</div>
    <div class="head"><div class="t">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h1>${esc(s.name)}</h1>${statusPill(s.status)}</div>
      <div class="small sec-muted" style="margin-top:3px"><i class="ti ti-building"></i> <a class="iplink" href="#/customer/${s.account.id}">${esc(s.account.name)}</a> &nbsp;·&nbsp; <i class="ti ti-map-pin"></i> ${loc(s)}</div>
    </div><a class="btn" href="#/site/${s.id}/edit"><i class="ti ti-edit"></i> Edit</a></div>

    <div class="grid2" style="margin:16px 0">
      <div class="metric"><div class="l"><i class="ti ti-shield-lock"></i> Management IP</div><div class="mono" style="font-size:15px;font-weight:500">${s.current_mgmt_ip ? `<a class="iplink" href="https://${esc(s.current_mgmt_ip)}" target="_blank">${esc(s.current_mgmt_ip)} <i class="ti ti-external-link" style="font-size:11px"></i></a>` : '—'}</div></div>
      <div class="metric"><div class="l"><i class="ti ti-world"></i> Public IP</div><div class="mono" style="font-size:15px;font-weight:500">${esc(s.current_public_ip || '—')}</div></div>
    </div>

    <div class="grid2" style="margin-bottom:18px">${connCards}</div>

    <div class="card">
      <div class="hd"><h2>Hardware · ${s.devices.length}</h2><a class="btn sm" href="#/device/new?site=${s.id}"><i class="ti ti-plus"></i> Add hardware</a></div>
      ${hw}
    </div>

    <div class="card">
      <div class="hd"><h2><i class="ti ti-notes"></i> Site notes · ${s.notes.length}</h2><a class="btn sm" href="#/site/${s.id}/notes"><i class="ti ti-arrows-diagonal"></i> Expand</a></div>
      ${note ? `<div class="note"><div class="av">${initials(note.author)}</div><div><div class="small"><b>${esc(note.author)}</b> <span class="muted">· ${esc(note.created_at)}</span></div><div class="small sec-muted" style="margin-top:2px">${esc(note.body)}</div></div></div>` : '<div class="row muted">No notes yet</div>'}
    </div>`;
}

function iconFor(t) { t = (t || '').toLowerCase(); if (t.includes('router')) return 'router'; if (t.includes('switch')) return 'switch-3'; if (t.includes('access')) return 'access-point'; if (t.includes('modem')) return 'device-desktop-analytics'; return 'device-desktop'; }
function initials(n) { return (n || '?').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase(); }

// ---------- Notes ----------
async function renderNotes(id) {
  const s = await api('/sites/' + id);
  let access = null;
  if (isPriv()) { try { access = await api('/sites/' + id + '/access'); } catch {} }
  const accessHtml = isPriv() && access ? `
    <div class="card" style="border:2px solid var(--info)">
      <div class="hd"><h2><i class="ti ti-pin" style="color:var(--info)"></i> Site access <span class="badge noc">NOC / Admin only</span></h2></div>
      <div style="padding:0 14px 12px">
        ${access.gate_code ? kv('Gate code', access.gate_code, true) : ''}
        ${access.front_door ? kv('Front door', access.front_door, true) : ''}
        ${access.lockbox ? kv('Lockbox', access.lockbox, true) : ''}
        ${access.access_hours ? kv('Access hours', access.access_hours) : ''}
        ${(access.contacts || []).map(c => kv(c.name, `<a class="iplink" href="tel:${esc(c.phone)}">${esc(c.phone)}</a>`)).join('')}
      </div></div>` : (isPriv() ? '' : '<div class="card" style="padding:14px" class="muted">Site access codes are visible to NOC/Admin only.</div>');

  const notes = s.notes.map(n => `<div class="card" style="margin-bottom:12px"><div class="note" style="border:0">
    <div class="av">${initials(n.author)}</div>
    <div style="flex:1"><div class="small"><b>${esc(n.author)}</b> <span class="muted">· ${esc(n.created_at)} · ${esc(n.author_role || '')}</span></div>
    <div class="sec-muted" style="margin-top:4px">${esc(n.body)}</div></div></div>`).join('');

  view().innerHTML = `
    <div class="crumb" onclick="location.hash='#/site/${id}'"><i class="ti ti-chevron-left"></i> ${esc(s.name)}</div>
    <h1>Site notes</h1><div class="small sec-muted" style="margin-bottom:14px">${esc(s.name)} · ${esc(s.account.name)}</div>
    ${accessHtml}
    <div class="box"><textarea id="noteBody" rows="2" placeholder="Add a note about this site…"></textarea>
      <div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="btn primary" onclick="postNote(${id})"><i class="ti ti-send"></i> Post note</button></div></div>
    ${notes || '<div class="muted">No notes yet</div>'}`;
}
function kv(k, v, secret) {
  const val = secret ? `<span class="mono" style="cursor:pointer;filter:blur(5px)" onclick="this.style.filter='none'">${esc(v)}</span>` : `<span>${v}</span>`;
  return `<div class="kv"><span class="small sec-muted">${esc(k)}</span>${val}</div>`;
}
async function postNote(id) {
  const body = $('#noteBody').value.trim(); if (!body) return;
  await api('/sites/' + id + '/notes', { method: 'POST', body: JSON.stringify({ body }) });
  toast('Note posted'); renderNotes(id);
}

// ---------- Customers ----------
async function renderCustomers() {
  const list = await api('/accounts');
  const rows = list.map(a => `<div class="row rowlink" onclick="location.hash='#/customer/${a.id}'">
    <div class="av">${initials(a.name)}</div>
    <div style="flex:1;min-width:0"><div>${esc(a.name)}</div><div class="small mono sec-muted">${esc(a.account_number || '')}</div></div>
    <span class="small sec-muted">${a.site_count} site${a.site_count === 1 ? '' : 's'}</span>
    ${statusPill(a.status)}<i class="ti ti-chevron-right muted"></i></div>`).join('');
  view().innerHTML = `<div class="head"><h1 style="flex:1">Customers</h1>${isPriv() ? '<a class="btn" href="#/customer/new"><i class="ti ti-plus"></i> Add customer</a>' : ''}</div>
    <div class="card" style="margin-top:14px">${rows || '<div class="row muted">No customers</div>'}</div>`;
}

async function renderCustomer(id) {
  const a = await api('/accounts/' + id);
  const contacts = a.contacts.map(c => `<div class="kv"><div><div>${esc(c.name)}</div><div class="small sec-muted">${esc(c.role || '')}${c.is_primary ? ' · Primary' : ''}${c.is_billing ? ' · Billing' : ''}</div></div>
    <div style="text-align:right" class="small">${c.phone ? `<a class="iplink" href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ''}${c.email ? `<div><a class="iplink" href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ''}</div></div>`).join('');
  const prev = a.previous_isps.map(p => `<div class="kv" style="display:block">
    <div style="display:flex;justify-content:space-between"><span>${esc(p.provider)}</span><span class="small muted">${esc(p.until_label || '')}</span></div>
    <div class="small sec-muted" style="margin-top:3px"><span class="muted">Why they left:</span> ${esc(p.reason || '')}</div></div>`).join('');
  const sites = a.sites.map(s => `<div class="row rowlink" onclick="location.hash='#/site/${s.id}'">
    <span class="dot" style="flex:none;background:${pillFor(s.needs_attention ? 'Standby' : 'Up')[1]}"></span>
    <div style="flex:1;min-width:0"><div>${esc(s.name)}</div><div class="small mono sec-muted">mgmt ${esc(s.current_mgmt_ip || '—')} · pub ${esc(s.current_public_ip || '—')}</div></div>
    <div class="stat">${statusPill(s.conn_status)}<span class="small mono">${s.device_online}/${s.device_total} online</span></div>
    <i class="ti ti-chevron-right muted"></i></div>`).join('');
  view().innerHTML = `
    <div class="crumb" onclick="location.hash='#/customers'"><i class="ti ti-chevron-left"></i> Customers</div>
    <div class="head"><div class="av" style="width:46px;height:46px;border-radius:8px;font-size:16px">${initials(a.name)}</div>
      <div class="t"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h1>${esc(a.name)}</h1>${statusPill(a.status)}</div>
      <div class="small mono sec-muted" style="margin-top:3px">${esc(a.account_number || '')}</div></div>
      ${isPriv() ? `<a class="btn" href="#/customer/${a.id}/edit"><i class="ti ti-edit"></i> Edit</a>` : ''}</div>
    <div class="grid3" style="margin:16px 0">
      <div class="metric"><div class="l">Sites</div><div class="v">${a.sites.length}</div></div>
      <div class="metric"><div class="l">Devices</div><div class="v">${a.device_count}</div></div>
      <div class="metric"><div class="l">Needs attention</div><div class="v" style="color:var(--warning)">${a.needs_attention}</div></div>
    </div>
    ${contacts ? `<div class="card"><div class="hd"><h2>Contacts</h2></div><div style="padding:0 14px 10px">${contacts}</div></div>` : ''}
    ${prev ? `<div class="card"><div class="hd"><h2><i class="ti ti-history-toggle"></i> Previous ISP</h2></div><div style="padding:0 14px 10px">${prev}</div></div>` : ''}
    <div class="card"><div class="hd"><h2>Sites · ${a.sites.length}</h2><a class="btn sm" href="#/site/new?account=${a.id}"><i class="ti ti-plus"></i> Add site</a></div>${sites || '<div class="row muted">No sites</div>'}</div>`;
}

// ---------- Inventory ----------
async function renderInventory() {
  const devs = await api('/devices');
  const rows = devs.map(d => `<div class="row rowlink" onclick="location.hash='#/device/${d.id}'">
    <i class="ti ti-${iconFor(d.device_type)} sec-muted"></i>
    <div style="flex:1;min-width:0"><div>${esc(d.name)} · ${esc(d.manufacturer || '')} ${esc(d.model || '')}</div>
      <div class="small sec-muted">${esc(d.management_mode === 'provider' ? 'Provider-managed' : 'Platform-managed')} · owned by ${esc(d.ownership)}</div></div>
    <span class="tag">${esc(d.status)}</span>${statusPill(d.online ? 'Online' : 'Offline')}<i class="ti ti-chevron-right muted"></i></div>`).join('');
  view().innerHTML = `<div class="head"><h1 style="flex:1">Inventory</h1><a class="btn" href="#/device/new"><i class="ti ti-plus"></i> Add hardware</a></div>
    <div class="card" style="margin-top:14px">${rows || '<div class="row muted">No devices</div>'}</div>`;
}

// ---------- Device detail ----------
async function renderDevice(id) {
  const d = await api('/devices/' + id);
  const credFields = [];
  if (d.has_admin_password) credFields.push(['Admin password', 'admin_password', 'noc']);
  if (d.has_factory_password) credFields.push(['Factory password', 'factory_password', 'noc']);
  if (d.has_factory_wifi_password) credFields.push(['Factory WiFi password', 'factory_wifi_password', 'noc']);
  if (d.has_tech_username) credFields.push(['Tech username', 'tech_username', 'tech']);
  if (d.has_tech_password) credFields.push(['Tech password', 'tech_password', 'tech']);
  if (d.has_acct_pin) credFields.push(['Account PIN', 'acct_pin', 'noc']);
  if (d.has_acct_portal_username) credFields.push(['Portal username', 'acct_portal_username', 'noc']);
  if (d.has_acct_portal_password) credFields.push(['Portal password', 'acct_portal_password', 'noc']);
  if (d.has_acct_passphrase) credFields.push(['Security passphrase', 'acct_passphrase', 'noc']);
  const visibleCreds = credFields.filter(f => f[2] === 'tech' || isPriv());
  const credRows = visibleCreds.map(f => `<div class="kv"><span class="small sec-muted">${f[0]} ${f[2] === 'noc' ? '<span class="badge noc">NOC</span>' : '<span class="badge tech">Field/Support</span>'}</span>
    <span class="mono" id="cred-${f[1]}">••••••</span></div>`).join('');

  const info = [];
  info.push(['Status', d.status]);
  info.push(['Assigned to', d.assigned_label || '—']);
  info.push(['Management', d.management_mode === 'provider' ? 'Provider-managed (carrier provisions)' : 'Platform-managed']);
  if (d.mgmt_overlay) info.push(['Overlay', d.mgmt_overlay]);
  if (d.mgmt_address) info.push(['Mgmt IP', `<a class="iplink" href="https://${esc(d.mgmt_address)}" target="_blank">${esc(d.mgmt_address)}</a>`]);
  info.push(['Serial', d.serial || '—']);
  info.push(['MAC', d.mac || '—']);
  if (d.hfc_mac) info.push(['HFC MAC', d.hfc_mac]);
  info.push(['Ownership', d.ownership + (d.owner_org ? ' · ' + d.owner_org : '')]);
  if (d.account_number) info.push(['Account #', d.account_number]);
  if (d.owner_sub_account) info.push(['Sub-account', d.owner_sub_account]);
  if (d.cell_carrier) { info.push(['Cellular carrier', d.cell_carrier]); info.push(['Phone', d.cell_phone || '—']); info.push(['IMEI', d.cell_imei || '—']); info.push(['SIM/ICCID', d.cell_sim || '—']); }

  view().innerHTML = `
    <div class="crumb" onclick="history.back()"><i class="ti ti-chevron-left"></i> Back</div>
    <div class="head"><div class="t"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h1>${esc(d.name)}</h1>${statusPill(d.online ? 'Online' : 'Offline')}</div>
      <div class="small sec-muted" style="margin-top:3px">${esc(d.manufacturer || '')} ${esc(d.model || '')} · ${esc(d.assigned_label || 'unassigned')}</div></div>
      ${d.mgmt_address ? `<a class="btn" href="https://${esc(d.mgmt_address)}" target="_blank"><i class="ti ti-external-link"></i> Console</a>` : ''}
      <a class="btn" href="#/device/${d.id}/edit"><i class="ti ti-edit"></i> Edit</a></div>

    ${d.management_mode === 'provider' ? '' : `
    <div class="card"><div class="hd"><h2>Traffic</h2><div class="seg" style="flex:none" id="rng">
      <button class="segbtn on" data-r="1h" onclick="setRng('1h')">1h</button><button class="segbtn" data-r="24h" onclick="setRng('24h')">24h</button><button class="segbtn" data-r="7d" onclick="setRng('7d')">7d</button></div></div>
      <div style="padding:0 14px 14px"><div style="position:relative;height:200px"><canvas id="tchart"></canvas></div>
      <div class="help">Telemetry stubbed with sample data for this testing build · 1-min res / 60-day retention planned</div></div></div>`}

    <div class="card"><div class="hd"><h2>Details</h2></div><div style="padding:0 14px 10px">${info.map(([k, v]) => `<div class="kv"><span class="small sec-muted">${esc(k)}</span><span class="mono small">${v}</span></div>`).join('')}</div></div>

    ${visibleCreds.length ? `<div class="card"><div class="hd"><h2><i class="ti ti-key"></i> Credentials</h2><button class="btn sm" onclick="revealCreds(${d.id})"><i class="ti ti-eye"></i> Reveal</button></div><div style="padding:0 14px 10px">${credRows}<div class="help"><i class="ti ti-lock"></i> Masked · reveal is logged${isPriv() ? '' : ' · NOC-only fields hidden for your role'}</div></div></div>` : ''}`;

  if (d.management_mode !== 'provider') drawTraffic('24h');
}
let _tchart = null;
function genSeries(n, base, vary) { const a = []; for (let i = 0; i < n; i++) a.push(Math.max(0, Math.round(base + Math.sin(i / 2) * vary * 0.5 + (Math.random() - 0.5) * vary))); return a; }
function drawTraffic(r) {
  const n = r === '1h' ? 12 : r === '24h' ? 24 : 7;
  const labels = Array.from({ length: n }, (_, i) => r === '7d' ? 'D' + (i + 1) : i + (r === '1h' ? 'm' : ':00'));
  const cv = $('#tchart'); if (!cv) return;
  if (_tchart) _tchart.destroy();
  _tchart = new Chart(cv, { type: 'line', data: { labels, datasets: [
    { label: 'Download', data: genSeries(n, 180, 260), borderColor: '#378ADD', backgroundColor: 'rgba(55,138,221,.12)', fill: true, tension: .35, pointRadius: 0, borderWidth: 2 },
    { label: 'Upload', data: genSeries(n, 50, 90), borderColor: '#1D9E75', backgroundColor: 'rgba(29,158,117,.12)', fill: true, tension: .35, pointRadius: 0, borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } } });
}
function setRng(r) { document.querySelectorAll('#rng .segbtn').forEach(b => b.classList.toggle('on', b.dataset.r === r)); drawTraffic(r); }
async function revealCreds(id) {
  const res = await api('/devices/' + id + '/reveal', { method: 'POST' });
  for (const [k, v] of Object.entries(res.credentials)) { const el = $('#cred-' + k); if (el) el.textContent = v; }
  toast('Revealed · logged to activity');
}

// ---------- Activity ----------
async function renderActivity() {
  const rows = await api('/audit');
  view().innerHTML = `<h1>Activity</h1><div class="card" style="margin-top:14px">${rows.map(r => `<div class="row">
    <i class="ti ti-${actIcon(r.action)} sec-muted"></i>
    <div style="flex:1;min-width:0"><div class="small"><b>${esc(r.actor)}</b> <span class="muted">(${esc(r.role)})</span> ${esc(r.action)} <span class="mono">${esc(r.target || '')}</span></div>
    ${r.details ? `<div class="small sec-muted">${esc(r.details)}</div>` : ''}</div><span class="small muted">${esc(r.ts)}</span></div>`).join('') || '<div class="row muted">No activity</div>'}</div>`;
}
function actIcon(a) { a = a || ''; if (a.includes('credential') || a.includes('access')) return 'key'; if (a === 'create') return 'plus'; if (a === 'edit') return 'edit'; if (a === 'delete') return 'trash'; if (a === 'note') return 'notes'; return 'point'; }

// ---------- Forms ----------
function field(label, name, val = '', opts = {}) {
  const t = opts.type || 'text';
  if (t === 'select') return `<div class="fld"><label class="fl">${label}</label><select name="${name}">${opts.options.map(o => `<option value="${esc(o.v ?? o)}" ${(o.v ?? o) == val ? 'selected' : ''}>${esc(o.l ?? o)}</option>`).join('')}</select></div>`;
  if (t === 'textarea') return `<div class="fld"><label class="fl">${label}</label><textarea name="${name}" rows="2">${esc(val)}</textarea></div>`;
  return `<div class="fld"><label class="fl">${label}</label><input name="${name}" type="${t}" value="${esc(val)}" placeholder="${esc(opts.ph || '')}" ${opts.mono ? 'style="font-family:var(--mono)"' : ''}/></div>`;
}
function collect(formSel) {
  const data = {}; view().querySelectorAll(formSel + ' [name]').forEach(el => { data[el.name] = el.value; });
  return data;
}

// Type-to-search dropdown. host = element to fill; items = [{v,l}]; writes a hidden input[name].
function attachSearch(host, items, name, value, placeholder) {
  if (!host) return;
  host.classList.add('ss');
  const cur = items.find(i => String(i.v) === String(value == null ? '' : value));
  host.innerHTML = `<input type="text" class="ss-input" placeholder="${esc(placeholder || 'Search…')}" value="${cur ? esc(cur.l) : ''}" autocomplete="off"/>
    <input type="hidden" name="${name}" value="${cur ? esc(String(cur.v)) : ''}"/>
    <div class="ss-list" style="display:none"></div>`;
  const input = host.querySelector('.ss-input'), hidden = host.querySelector('input[type=hidden]'), list = host.querySelector('.ss-list');
  const draw = (f) => {
    const q = (f || '').toLowerCase();
    const m = items.filter(i => i.l.toLowerCase().includes(q)).slice(0, 80);
    list.innerHTML = m.length ? m.map(i => `<div class="ss-opt" data-v="${esc(String(i.v))}">${esc(i.l)}</div>`).join('') : '<div class="ss-opt muted">No matches</div>';
  };
  input.addEventListener('focus', () => { draw(''); list.style.display = 'block'; });
  input.addEventListener('input', () => { hidden.value = ''; draw(input.value); list.style.display = 'block'; });
  list.addEventListener('mousedown', (e) => { const o = e.target.closest('.ss-opt'); if (!o || !o.dataset.v) return; hidden.value = o.dataset.v; input.value = o.textContent; list.style.display = 'none'; });
  input.addEventListener('blur', () => setTimeout(() => { list.style.display = 'none'; }, 150));
}

async function formCustomer(q) {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  let a = { name: '', account_number: '', status: 'Active', billing_address: '', notes: '' };
  if (q.id) a = await api('/accounts/' + q.id);
  view().innerHTML = `<div class="crumb" onclick="history.back()"><i class="ti ti-chevron-left"></i> Back</div>
    <h1>${q.id ? 'Edit' : 'Add'} customer</h1>
    <div class="card" style="margin-top:14px;padding:16px" id="f">
      ${field('Account name', 'name', a.name, { ph: 'e.g. Acme Logistics' })}
      <div class="grid2">${field('Account number', 'account_number', a.account_number, { mono: true })}
      ${field('Status', 'status', a.status, { type: 'select', options: ['Active', 'Prospect', 'Suspended', 'Closed'] })}</div>
      ${field('Billing address', 'billing_address', a.billing_address)}
      ${field('Notes', 'notes', a.notes, { type: 'textarea' })}
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" onclick="history.back()">Cancel</button>
      <button class="btn primary" onclick="saveCustomer(${q.id || 'null'})"><i class="ti ti-check"></i> Save</button></div></div>`;
}
async function saveCustomer(id) {
  const d = collect('#f');
  if (id) { await api('/accounts/' + id, { method: 'PUT', body: JSON.stringify(d) }); location.hash = '#/customer/' + id; }
  else { const r = await api('/accounts', { method: 'POST', body: JSON.stringify(d) }); location.hash = '#/customer/' + r.id; }
  toast('Saved');
}

async function formSite(q) {
  let s = { name: '', service_address: '', status: 'Active', current_mgmt_ip: '', current_public_ip: '', account_id: q.account || '' };
  if (q.id) s = await api('/sites/' + q.id);
  const accOpts = META.accounts.map(a => ({ v: a.id, l: a.name }));
  view().innerHTML = `<div class="crumb" onclick="history.back()"><i class="ti ti-chevron-left"></i> Back</div>
    <h1>${q.id ? 'Edit' : 'Add'} site</h1>
    <div class="card" style="margin-top:14px;padding:16px;overflow:visible" id="f">
      <div class="fld"><label class="fl">Customer / account</label><div id="ss-account"></div></div>
      ${field('Site name', 'name', s.name, { ph: 'e.g. Riverside Office' })}
      ${field('Service address', 'service_address', s.service_address, { ph: 'Street, city, state (optional if GPS)' })}
      <div class="grid2">${field('Latitude', 'lat', s.lat || '', { mono: true })}${field('Longitude', 'lng', s.lng || '', { mono: true })}</div>
      <div class="grid2">${field('Status', 'status', s.status, { type: 'select', options: ['Active', 'Provisioning', 'Suspended', 'Cancelled'] })}
      ${field('Current public IP', 'current_public_ip', s.current_public_ip, { mono: true })}</div>
      ${field('Current management IP', 'current_mgmt_ip', s.current_mgmt_ip, { mono: true })}
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" onclick="history.back()">Cancel</button>
      <button class="btn primary" onclick="saveSite(${q.id || 'null'})"><i class="ti ti-check"></i> Save</button></div></div>`;
  attachSearch($('#ss-account'), accOpts, 'account_id', s.account_id || (s.account && s.account.id), 'Search customer…');
}
async function saveSite(id) {
  const d = collect('#f');
  if (!d.account_id) { toast('Pick a customer/account'); return; }
  if (!d.name) { toast('Enter a site name'); return; }
  try {
    if (id) { await api('/sites/' + id, { method: 'PUT', body: JSON.stringify(d) }); location.hash = '#/site/' + id; }
    else { const r = await api('/sites', { method: 'POST', body: JSON.stringify(d) }); location.hash = '#/site/' + r.id; }
    toast('Saved');
  } catch (e) { toast(e.message); }
}

async function formDevice(q) {
  let d = { name: '', status: 'Deployed', management_mode: 'platform', mgmt_overlay: 'WireGuard', ownership: 'us', account_status: 'active', online: 1 };
  if (q.id) d = await api('/devices/' + q.id);
  const modelOpts = (await api('/models')).map(m => ({ v: m.id, l: m.manufacturer + ' ' + m.model }));
  const siteOpts = (await api('/sites')).map(s => ({ v: s.id, l: s.name }));
  const popOpts = META.pops.map(p => ({ v: p.id, l: 'POP · ' + p.name }));
  view().innerHTML = `<div class="crumb" onclick="history.back()"><i class="ti ti-chevron-left"></i> Back</div>
    <h1>${q.id ? 'Edit' : 'Add'} hardware</h1>
    <div class="card" style="margin-top:14px;padding:16px;overflow:visible" id="f">
      ${field('Device name', 'name', d.name, { ph: 'e.g. Edge Router' })}
      <div class="fld"><label class="fl">Management mode</label><div class="seg">
        <button type="button" class="segbtn ${d.management_mode !== 'provider' ? 'on' : ''}" id="mm-plat" onclick="setMM('platform')"><i class="ti ti-settings-automation"></i> Platform-managed</button>
        <button type="button" class="segbtn ${d.management_mode === 'provider' ? 'on' : ''}" id="mm-prov" onclick="setMM('provider')"><i class="ti ti-building-broadcast-tower"></i> Provider-managed</button>
      </div><input type="hidden" name="management_mode" value="${d.management_mode}"/></div>
      <div class="grid2"><div class="fld"><label class="fl">Model</label><div id="ss-model"></div></div>
      ${field('Status', 'status', d.status, { type: 'select', options: ['Deployed', 'In stock', 'Spare', 'RMA', 'Retired'] })}</div>
      <div class="grid2">${field('Serial number', 'serial', d.serial, { mono: true })}${field('MAC address', 'mac', d.mac, { mono: true })}</div>

      <div id="provExtra" style="display:${d.management_mode === 'provider' ? 'block' : 'none'}">
        <div class="grid2">${field('HFC MAC', 'hfc_mac', d.hfc_mac, { mono: true })}${field('Purchased from', 'purchased_from', d.purchased_from)}</div>
      </div>

      <div class="box"><label class="fl">Ownership</label><div class="seg" style="margin-bottom:10px">
        <button type="button" class="segbtn ${d.ownership === 'us' ? 'on' : ''}" id="ow-us" onclick="setOwn('us')">Us</button>
        <button type="button" class="segbtn ${d.ownership === 'carrier' ? 'on' : ''}" id="ow-carrier" onclick="setOwn('carrier')">Carrier</button>
        <button type="button" class="segbtn ${d.ownership === 'distributor' ? 'on' : ''}" id="ow-distributor" onclick="setOwn('distributor')">Distributor</button>
      </div><input type="hidden" name="ownership" value="${d.ownership}"/>
      <div class="grid3">${field('Owner / account with', 'owner_org', d.owner_org)}${field('Account number', 'account_number', d.account_number, { mono: true })}${field('Sub-account', 'owner_sub_account', d.owner_sub_account)}</div>
      <div class="help">Account info is always recorded — even for gear we own there's a carrier/distributor account.</div>
      </div>

      <div id="platExtra" style="display:${d.management_mode === 'provider' ? 'none' : 'block'}">
        <div class="fld"><label class="fl">Management overlay</label><div class="seg" style="max-width:360px">
          <button type="button" class="segbtn ${d.mgmt_overlay !== 'ZeroTier' ? 'on' : ''}" id="ov-WireGuard" onclick="setOv('WireGuard')"><i class="ti ti-shield-lock"></i> WireGuard</button>
          <button type="button" class="segbtn ${d.mgmt_overlay === 'ZeroTier' ? 'on' : ''}" id="ov-ZeroTier" onclick="setOv('ZeroTier')"><i class="ti ti-network"></i> ZeroTier</button>
        </div><input type="hidden" name="mgmt_overlay" value="${d.mgmt_overlay || 'WireGuard'}"/></div>
        ${field('Management IP', 'mgmt_address', d.mgmt_address, { mono: true, ph: 'e.g. 10.20.1.1' })}
        <div class="box"><div class="small" style="font-weight:500;margin-bottom:8px"><i class="ti ti-key"></i> Credentials</div>
        <div class="grid2">${field('Admin password', 'admin_password', '', { ph: q.id ? 'unchanged' : '' })}${field('Factory password', 'factory_password', '', { ph: q.id ? 'unchanged' : '' })}</div>
        <div class="grid2">${field('Tech username', 'tech_username', d.tech_username)}${field('Tech password', 'tech_password', '', { ph: q.id ? 'unchanged' : '' })}</div></div>
      </div>

      <div id="deployBox" class="box" style="display:${d.status === 'Deployed' ? 'block' : 'none'}">
        <label class="fl"><i class="ti ti-map-pin"></i> Deploy to</label>
        <div class="seg" style="margin-bottom:10px">
          <button type="button" class="segbtn ${d.assigned_type !== 'pop' ? 'on' : ''}" id="dt-site" onclick="setDest('site')"><i class="ti ti-home"></i> Client site</button>
          <button type="button" class="segbtn ${d.assigned_type === 'pop' ? 'on' : ''}" id="dt-pop" onclick="setDest('pop')"><i class="ti ti-server-2"></i> POP site</button>
        </div>
        <input type="hidden" name="assigned_type" value="${d.assigned_type || 'site'}"/>
        <div id="destSite" style="display:${d.assigned_type === 'pop' ? 'none' : 'block'}"><label class="fl">Client site</label><div id="ss-site"></div></div>
        <div id="destPop" style="display:${d.assigned_type === 'pop' ? 'block' : 'none'}"><label class="fl">POP site</label><div id="ss-pop"></div></div>
      </div>

      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" onclick="history.back()">Cancel</button>
      <button class="btn primary" onclick="saveDevice(${q.id || 'null'})"><i class="ti ti-check"></i> Save</button></div>
    </div>`;
  $('select[name=status]').addEventListener('change', e => { $('#deployBox').style.display = e.target.value === 'Deployed' ? 'block' : 'none'; });
  attachSearch($('#ss-model'), modelOpts, 'model_id', d.model_id, 'Search manufacturer / model…');
  attachSearch($('#ss-site'), siteOpts, 'assigned_site_id', d.assigned_site_id, 'Search client site…');
  attachSearch($('#ss-pop'), popOpts, 'assigned_pop_id', d.assigned_pop_id, 'Search POP…');
}
function setMM(m) { $('input[name=management_mode]').value = m; $('#mm-plat').classList.toggle('on', m === 'platform'); $('#mm-prov').classList.toggle('on', m === 'provider'); $('#provExtra').style.display = m === 'provider' ? 'block' : 'none'; $('#platExtra').style.display = m === 'provider' ? 'none' : 'block'; }
function setOwn(o) { $('input[name=ownership]').value = o; ['us', 'carrier', 'distributor'].forEach(x => $('#ow-' + x).classList.toggle('on', x === o)); }
function setOv(o) { $('input[name=mgmt_overlay]').value = o; ['WireGuard', 'ZeroTier'].forEach(x => $('#ov-' + x).classList.toggle('on', x === o)); }
function setDest(t) { $('input[name=assigned_type]').value = t; $('#dt-site').classList.toggle('on', t === 'site'); $('#dt-pop').classList.toggle('on', t === 'pop'); $('#destSite').style.display = t === 'site' ? 'block' : 'none'; $('#destPop').style.display = t === 'pop' ? 'block' : 'none'; }
async function saveDevice(id) {
  const d = collect('#f');
  d.online = 1;
  if (!d.name) { toast('Enter a device name'); return; }
  // Normalize empty optional/FK fields so SQLite doesn't choke
  ['model_id', 'assigned_site_id', 'assigned_pop_id', 'controller_id'].forEach(k => { if (d[k] === '') d[k] = null; });
  if (d.status !== 'Deployed') { d.assigned_type = null; d.assigned_site_id = null; d.assigned_pop_id = null; }
  else if (d.assigned_type === 'site') d.assigned_pop_id = null;
  else if (d.assigned_type === 'pop') d.assigned_site_id = null;
  try {
    if (id) { await api('/devices/' + id, { method: 'PUT', body: JSON.stringify(d) }); location.hash = '#/device/' + id; }
    else { const r = await api('/devices', { method: 'POST', body: JSON.stringify(d) }); location.hash = '#/device/' + r.id; }
    toast('Saved');
  } catch (e) { toast(e.message); }
}

// ---------- Users (admin) ----------
async function renderUsers() {
  if (!isAdmin()) { view().innerHTML = '<div class="card" style="padding:20px">Admin only.</div>'; return; }
  const users = await api('/users');
  const rows = users.map(u => `<div class="row">
    <div class="av">${initials(u.name || u.email)}</div>
    <div style="flex:1;min-width:0"><div>${esc(u.name || '—')} ${u.id === CURRENT_USER.id ? '<span class="muted small">(you)</span>' : ''}</div><div class="small sec-muted">${esc(u.email)}</div></div>
    <span class="roletag">${esc(u.role)}</span>
    ${u.active ? '' : '<span class="pill s-down"><span class="dot" style="background:var(--danger)"></span>inactive</span>'}
    <a class="btn sm" href="#/users/${u.id}/edit"><i class="ti ti-edit"></i></a>
    ${u.id === CURRENT_USER.id ? '' : `<button class="btn sm" onclick="delUser(${u.id})"><i class="ti ti-trash"></i></button>`}
  </div>`).join('');
  view().innerHTML = `<div class="head"><h1 style="flex:1">Users</h1><a class="btn" href="#/users/new"><i class="ti ti-plus"></i> Add user</a></div>
    <div class="card" style="margin-top:14px">${rows}</div>
    <div class="help">Roles — <b>admin</b>: manage users + everything; <b>noc</b>: full detail incl. credentials; <b>field</b>/<b>support</b>: simplified, tech account only.</div>`;
}
async function formUser(q) {
  if (!isAdmin()) { view().innerHTML = '<div class="card" style="padding:20px">Admin only.</div>'; return; }
  let u = { name: '', email: '', role: 'support', active: 1 };
  if (q.id) u = (await api('/users')).find(x => x.id == q.id) || u;
  view().innerHTML = `<div class="crumb" onclick="location.hash='#/users'"><i class="ti ti-chevron-left"></i> Users</div>
    <h1>${q.id ? 'Edit' : 'Add'} user</h1>
    <div class="card" style="margin-top:14px;padding:16px" id="f">
      ${field('Name', 'name', u.name, { ph: 'Full name' })}
      ${field('Email', 'email', u.email, { type: q.id ? 'text' : 'email' })}
      ${q.id ? '<input type="hidden" name="email" value="' + esc(u.email) + '"/>' : ''}
      ${field('Role', 'role', u.role, { type: 'select', options: [{ v: 'admin', l: 'Admin' }, { v: 'noc', l: 'NOC' }, { v: 'field', l: 'Field tech' }, { v: 'support', l: 'Support tech' }] })}
      ${field(q.id ? 'New password (leave blank to keep)' : 'Password', 'password', '', { type: 'password' })}
      ${q.id ? `<div class="fld"><label class="fl">Active</label>${selBool('active', u.active)}</div>` : ''}
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" onclick="history.back()">Cancel</button>
      <button class="btn primary" onclick="saveUser(${q.id || 'null'})"><i class="ti ti-check"></i> Save</button></div>
    </div>`;
  if (q.id) { const em = view().querySelector('input[name=email][type=text]'); if (em) em.setAttribute('readonly', 'readonly'); }
}
function selBool(name, val) { return `<select name="${name}"><option value="1" ${val ? 'selected' : ''}>Active</option><option value="0" ${val ? '' : 'selected'}>Inactive</option></select>`; }
async function saveUser(id) {
  const d = collect('#f');
  if (d.active !== undefined) d.active = Number(d.active);
  try {
    if (id) { await api('/users/' + id, { method: 'PUT', body: JSON.stringify(d) }); }
    else { await api('/users', { method: 'POST', body: JSON.stringify(d) }); }
    toast('Saved'); location.hash = '#/users';
  } catch (e) { toast(e.message); }
}
async function delUser(id) {
  if (!confirm('Delete this user?')) return;
  try { await api('/users/' + id, { method: 'DELETE' }); toast('Deleted'); renderUsers(); } catch (e) { toast(e.message); }
}

// ---------- Device model catalog (NOC/Admin) ----------
function selYesNo(name, val) { return `<select name="${name}"><option value="1" ${val ? 'selected' : ''}>Yes</option><option value="0" ${val ? '' : 'selected'}>No</option></select>`; }
async function renderModels() {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  const models = await api('/models');
  const rows = models.map(m => `<div class="row">
    <i class="ti ti-${iconFor(m.device_type)} sec-muted"></i>
    <div style="flex:1;min-width:0"><div>${esc(m.manufacturer)} ${esc(m.model)}</div>
      <div class="small sec-muted">${esc(m.device_type || '—')}${m.has_wifi ? ' · WiFi' : ''}${m.has_cellular ? ' · Cellular' : ''}</div></div>
    <a class="btn sm" href="#/models/${m.id}/edit"><i class="ti ti-edit"></i></a>
    <button class="btn sm" onclick="delModel(${m.id})"><i class="ti ti-trash"></i></button></div>`).join('');
  view().innerHTML = `<div class="head"><h1 style="flex:1">Models</h1><a class="btn" href="#/models/new"><i class="ti ti-plus"></i> Add model</a></div>
    <div class="card" style="margin-top:14px">${rows || '<div class="row muted">No models yet</div>'}</div>
    <div class="help">The hardware catalog — what shows up in the Model picker when adding devices. NOC/Admin only.</div>`;
}
async function formModel(q) {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  let m = { manufacturer: '', model: '', device_type: 'Router', has_wifi: 0, has_cellular: 0 };
  if (q.id) m = (await api('/models')).find(x => x.id == q.id) || m;
  view().innerHTML = `<div class="crumb" onclick="location.hash='#/models'"><i class="ti ti-chevron-left"></i> Models</div>
    <h1>${q.id ? 'Edit' : 'Add'} model</h1>
    <div class="card" style="margin-top:14px;padding:16px" id="f">
      <div class="grid2">${field('Manufacturer', 'manufacturer', m.manufacturer, { ph: 'e.g. MikroTik' })}${field('Model', 'model', m.model, { ph: 'e.g. CCR2004' })}</div>
      ${field('Device type', 'device_type', m.device_type, { type: 'select', options: ['Router', 'Switch', 'Access point', 'Modem', 'Other'] })}
      <div class="grid2"><div class="fld"><label class="fl">Has WiFi</label>${selYesNo('has_wifi', m.has_wifi)}</div>
      <div class="fld"><label class="fl">Has cellular (5G/LTE)</label>${selYesNo('has_cellular', m.has_cellular)}</div></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" onclick="history.back()">Cancel</button>
      <button class="btn primary" onclick="saveModel(${q.id || 'null'})"><i class="ti ti-check"></i> Save</button></div></div>`;
}
async function saveModel(id) {
  const d = collect('#f');
  if (!d.manufacturer || !d.model) { toast('Manufacturer and model required'); return; }
  d.has_wifi = Number(d.has_wifi); d.has_cellular = Number(d.has_cellular);
  try {
    if (id) { await api('/models/' + id, { method: 'PUT', body: JSON.stringify(d) }); }
    else { await api('/models', { method: 'POST', body: JSON.stringify(d) }); }
    toast('Saved'); location.hash = '#/models';
  } catch (e) { toast(e.message); }
}
async function delModel(id) {
  if (!confirm('Delete this model?')) return;
  try { await api('/models/' + id, { method: 'DELETE' }); toast('Deleted'); renderModels(); } catch (e) { toast(e.message); }
}
