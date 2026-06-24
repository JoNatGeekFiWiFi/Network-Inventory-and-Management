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
  $('#navSettings').style.display = isPriv() ? '' : 'none';
  $('#navZt').style.display = isPriv() ? '' : 'none';
  $('#navBlock').style.display = isPriv() ? '' : 'none';
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
    if (p[0] === 'pops') { setNav('sites'); return await renderPops(); }
    if (p[0] === 'pop' && p[1] === 'new') { setNav('sites'); return await formPop({}); }
    if (p[0] === 'pop' && p[2] === 'edit') { setNav('sites'); return await formPop({ id: p[1] }); }
    if (p[0] === 'pop' && p[2] === 'notes') { setNav('sites'); return await renderPopNotes(p[1]); }
    if (p[0] === 'pop') { setNav('sites'); return await renderPop(p[1]); }
    if (p[0] === 'customers') { setNav('customers'); return await renderCustomers(); }
    if (p[0] === 'customer' && p[1] === 'new') { setNav('customers'); return await formCustomer({}); }
    if (p[0] === 'customer' && p[2] === 'edit') { setNav('customers'); return await formCustomer({ id: p[1] }); }
    if (p[0] === 'customer') { setNav('customers'); return await renderCustomer(p[1]); }
    if (p[0] === 'cust' && p[1] === 'new') { setNav('customers'); return await formCust(q); }
    if (p[0] === 'cust' && p[2] === 'edit') { setNav('customers'); return await formCust({ id: p[1] }); }
    if (p[0] === 'cust') { setNav('customers'); return await renderCust(p[1]); }
    if (p[0] === 'inventory') { setNav('inventory'); return await renderInventory(); }
    if (p[0] === 'device' && p[1] === 'new') { setNav('inventory'); return await formDevice(q); }
    if (p[0] === 'device' && p[2] === 'edit') { setNav('inventory'); return await formDevice({ id: p[1] }); }
    if (p[0] === 'device' && p[2] === 'dhcp') { setNav('inventory'); return await renderDeviceDhcp(p[1]); }
    if (p[0] === 'device' && p[2] === 'wifi') { setNav('inventory'); return await renderDeviceWifi(p[1]); }
    if (p[0] === 'device') { setNav('inventory'); return await renderDevice(p[1]); }
    if (p[0] === 'activity') { setNav('activity'); return await renderActivity(); }
    if (p[0] === 'users' && p[1] === 'new') { setNav('users'); return await formUser({}); }
    if (p[0] === 'users' && p[2] === 'edit') { setNav('users'); return await formUser({ id: p[1] }); }
    if (p[0] === 'users') { setNav('users'); return await renderUsers(); }
    if (p[0] === 'models' && p[1] === 'new') { setNav('models'); return await formModel({}); }
    if (p[0] === 'models' && p[2] === 'edit') { setNav('models'); return await formModel({ id: p[1] }); }
    if (p[0] === 'models') { setNav('models'); return await renderModels(); }
    if (p[0] === 'settings') { setNav('settings'); return await renderSettings(); }
    if (p[0] === 'zerotier') { setNav('zerotier'); return await renderZeroTier(); }
    if (p[0] === 'blocklist') { setNav('blocklist'); return await renderBlocklist(); }
    view().innerHTML = '<div class="card" style="padding:20px">Not found</div>';
  } catch (e) { if (e.message === 'auth') return; view().innerHTML = `<div class="card" style="padding:20px">Error: ${esc(e.message)}</div>`; }
}

// ---------- Sites ----------
const sitesToggle = (active) => `<div class="seg" style="max-width:340px;margin-bottom:14px">
  <a class="segbtn ${active === 'customer' ? 'on' : ''}" href="#/sites"><i class="ti ti-home"></i> Customer sites</a>
  <a class="segbtn ${active === 'pop' ? 'on' : ''}" href="#/pops"><i class="ti ti-server-2"></i> POP sites</a></div>`;

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
        <div class="small sec-muted">${esc(s.customer_name || s.account_name || '')}${s.customer_name && s.account_name ? ' · <span class="sec-muted">' + esc(s.account_name) + '</span>' : ''}</div>
        <div class="small mono sec-muted">mgmt ${esc(s.current_mgmt_ip || '—')} · pub ${esc(s.current_public_ip || '—')}</div>
      </div>
      <div class="stat">${statusPill(s.conn_status)}<span class="small mono" style="${hwCol}">${s.device_online}/${s.device_total} online</span></div>
      <i class="ti ti-chevron-right muted"></i></div>`;
  }).join('');
  view().innerHTML = `
    <div class="head"><h1 style="flex:1">Sites</h1><a class="btn" href="#/site/new"><i class="ti ti-plus"></i> Add site</a></div>
    ${sitesToggle('customer')}
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
      <div class="small sec-muted" style="margin-top:3px">${s.customer ? `<i class="ti ti-user"></i> <a class="iplink" href="#/cust/${s.customer.id}">${esc(s.customer.name)}</a> &nbsp;·&nbsp; ` : ''}<i class="ti ti-building"></i> <a class="iplink" href="#/customer/${s.account.id}">${esc(s.account.name)}</a> &nbsp;·&nbsp; <i class="ti ti-map-pin"></i> ${loc(s)}</div>
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

// ---------- POP sites ----------
async function renderPops() {
  const pops = await api('/pops');
  const rows = pops.map(p => `<div class="row rowlink" onclick="location.hash='#/pop/${p.id}'">
    <i class="ti ti-server-2 sec-muted"></i>
    <div style="flex:1;min-width:0"><div>${esc(p.name)} ${p.code ? `<span class="tag">${esc(p.code)}</span>` : ''}</div>
      <div class="small sec-muted">${p.address ? esc(p.address) : (p.lat != null ? `${p.lat}, ${p.lng} · GPS` : '—')}</div>
      <div class="small mono sec-muted">mgmt ${esc(p.current_mgmt_ip || '—')} · pub ${esc(p.current_public_ip || '—')}</div></div>
    <div class="stat">${statusPill(p.status)}<span class="small mono">${p.device_online}/${p.device_total} online</span></div>
    <i class="ti ti-chevron-right muted"></i></div>`).join('');
  view().innerHTML = `<div class="head"><h1 style="flex:1">Sites</h1>${isPriv() ? '<a class="btn" href="#/pop/new"><i class="ti ti-plus"></i> Add POP</a>' : ''}</div>
    ${sitesToggle('pop')}
    <div class="card">${rows || '<div class="row muted">No POP sites yet</div>'}</div>`;
}
async function renderPop(id) {
  const p = await api('/pops/' + id);
  const where = p.address ? `<a class="iplink" href="https://maps.google.com/?q=${encodeURIComponent(p.address)}" target="_blank">${esc(p.address)} <i class="ti ti-external-link" style="font-size:11px"></i></a>`
    : (p.lat != null ? `<a class="iplink mono" href="https://maps.google.com/?q=${p.lat},${p.lng}" target="_blank">${p.lat}, ${p.lng}</a> <span class="muted small">· GPS</span>` : '—');
  const hw = p.devices.map(d => `<div class="row rowlink" onclick="location.hash='#/device/${d.id}'">
    <i class="ti ti-${iconFor(d.device_type)} sec-muted"></i>
    <div style="flex:1;min-width:0"><div>${esc(d.name)} · ${esc(d.manufacturer || '')} ${esc(d.model || '')}</div>
      <div class="small mono sec-muted">${esc(d.mac || '')}${d.mgmt_address ? ' · ' + esc(d.mgmt_address) : ''}</div></div>
    ${statusPill(d.online ? 'Online' : 'Offline')}<i class="ti ti-chevron-right muted"></i></div>`).join('') || '<div class="row muted">No hardware</div>';
  const served = p.served_sites.map(s => `<a class="tag" href="#/site/${s.id}" style="margin:2px 4px 2px 0;display:inline-block">${esc(s.name)}</a>`).join('') || '<span class="muted small">No customer sites served</span>';
  view().innerHTML = `
    <div class="crumb" onclick="location.hash='#/pops'"><i class="ti ti-chevron-left"></i> POP sites</div>
    <div class="head"><div class="t"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h1>${esc(p.name)}</h1>${p.code ? `<span class="tag">${esc(p.code)}</span>` : ''}${statusPill(p.status)}</div>
      <div class="small sec-muted" style="margin-top:3px"><i class="ti ti-map-pin"></i> ${where}</div></div>
      ${isPriv() ? `<a class="btn" href="#/pop/${p.id}/edit"><i class="ti ti-edit"></i> Edit</a>` : ''}</div>
    <div class="grid2" style="margin:16px 0">
      <div class="metric"><div class="l"><i class="ti ti-shield-lock"></i> Management IP</div><div class="mono" style="font-size:15px;font-weight:500">${p.current_mgmt_ip ? `<a class="iplink" href="https://${esc(p.current_mgmt_ip)}" target="_blank">${esc(p.current_mgmt_ip)} <i class="ti ti-external-link" style="font-size:11px"></i></a>` : '—'}</div></div>
      <div class="metric"><div class="l"><i class="ti ti-world"></i> Public IP</div><div class="mono" style="font-size:15px;font-weight:500">${esc(p.current_public_ip || '—')}</div></div>
    </div>
    <div class="card"><div class="hd"><h2>Hardware · ${p.devices.length}</h2><a class="btn sm" href="#/device/new?pop=${p.id}"><i class="ti ti-plus"></i> Add hardware</a></div>${hw}</div>
    <div class="card"><div class="hd"><h2>Customer sites served</h2></div><div style="padding:0 14px 12px">${served}</div></div>
    <div class="card"><div class="hd"><h2><i class="ti ti-notes"></i> Notes · ${p.notes.length}</h2><a class="btn sm" href="#/pop/${p.id}/notes"><i class="ti ti-arrows-diagonal"></i> Expand</a></div>
      ${p.notes[0] ? `<div class="note"><div class="av">${initials(p.notes[0].author)}</div><div><div class="small"><b>${esc(p.notes[0].author)}</b> <span class="muted">· ${esc(p.notes[0].created_at)}</span></div><div class="small sec-muted" style="margin-top:2px">${esc(p.notes[0].body)}</div></div></div>` : '<div class="row muted">No notes yet</div>'}</div>`;
}
async function renderPopNotes(id) {
  const p = await api('/pops/' + id);
  let accessBody = null;
  if (isPriv()) { try { accessBody = (await api('/pops/' + id + '/access')).body || ''; } catch {} }
  const accessCard = isPriv() ? `
    <div class="card" style="border:2px solid var(--info)">
      <div class="hd"><h2><i class="ti ti-pin" style="color:var(--info)"></i> Access notes <span class="badge noc">NOC / Admin only</span></h2><button class="btn sm" onclick="editPopAccess(${id})"><i class="ti ti-edit"></i> Edit</button></div>
      <div style="padding:0 14px 12px" id="popacc">${accessBody ? `<pre style="white-space:pre-wrap;font-family:var(--mono);font-size:13px;margin:0;color:var(--text2)">${esc(accessBody)}</pre>` : '<span class="muted small">No access notes — click Edit to add gate codes, contacts, etc.</span>'}</div>
    </div>` : '<div class="card" style="padding:14px"><span class="muted">Access notes are NOC/Admin only.</span></div>';
  const notes = p.notes.map(n => `<div class="card" style="margin-bottom:12px"><div class="note" style="border:0">
    <div class="av">${initials(n.author)}</div>
    <div style="flex:1"><div class="small"><b>${esc(n.author)}</b> <span class="muted">· ${esc(n.created_at)} · ${esc(n.author_role || '')}</span></div>
    <div class="sec-muted" style="margin-top:4px">${esc(n.body)}</div></div></div>`).join('');
  view().innerHTML = `<div class="crumb" onclick="location.hash='#/pop/${id}'"><i class="ti ti-chevron-left"></i> ${esc(p.name)}</div>
    <h1>POP notes</h1><div class="small sec-muted" style="margin-bottom:14px">${esc(p.name)}${p.code ? ' · ' + esc(p.code) : ''}</div>
    ${accessCard}
    <div class="box"><textarea id="popNoteBody" rows="2" placeholder="Add a note about this POP…"></textarea>
      <div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="btn primary" onclick="postPopNote(${id})"><i class="ti ti-send"></i> Post note</button></div></div>
    ${notes || '<div class="muted">No notes yet</div>'}`;
  window._popAccessBody = accessBody || '';
}
function editPopAccess(id) {
  const el = $('#popacc');
  el.innerHTML = `<textarea id="popaccedit" rows="6" style="font-family:var(--mono);font-size:13px">${esc(window._popAccessBody || '')}</textarea>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px"><button class="btn sm" onclick="renderPopNotes(${id})">Cancel</button>
    <button class="btn primary sm" onclick="savePopAccess(${id})"><i class="ti ti-check"></i> Save</button></div>`;
}
async function savePopAccess(id) {
  const body = $('#popaccedit').value;
  try { await api('/pops/' + id + '/access', { method: 'PUT', body: JSON.stringify({ body }) }); toast('Saved'); renderPopNotes(id); } catch (e) { toast(e.message); }
}
async function postPopNote(id) {
  const body = $('#popNoteBody').value.trim(); if (!body) return;
  try { await api('/pops/' + id + '/notes', { method: 'POST', body: JSON.stringify({ body }) }); toast('Note posted'); renderPopNotes(id); } catch (e) { toast(e.message); }
}
async function formPop(q) {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  let p = { name: '', code: '', address: '', lat: '', lng: '', status: 'Active' };
  if (q.id) p = await api('/pops/' + q.id);
  view().innerHTML = `<div class="crumb" onclick="history.back()"><i class="ti ti-chevron-left"></i> Back</div>
    <h1>${q.id ? 'Edit' : 'Add'} POP site</h1>
    <div class="card" style="margin-top:14px;padding:16px" id="f">
      <div class="grid2">${field('POP name', 'name', p.name, { ph: 'e.g. Dallas 01' })}${field('Code', 'code', p.code, { mono: true, ph: 'e.g. POP-DAL01' })}</div>
      <div class="fld"><label class="fl">Address</label><div id="ss-paddr"></div></div>
      <div class="grid2">${field('Latitude', 'lat', p.lat || '', { mono: true })}${field('Longitude', 'lng', p.lng || '', { mono: true })}</div>
      ${field('Status', 'status', p.status, { type: 'select', options: ['Active', 'Planned', 'Decommissioned'] })}
      <div class="grid2">${field('Current management IP', 'current_mgmt_ip', p.current_mgmt_ip, { mono: true })}${field('Current public IP', 'current_public_ip', p.current_public_ip, { mono: true })}</div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" onclick="history.back()">Cancel</button>
      <button class="btn primary" onclick="savePop(${q.id || 'null'})"><i class="ti ti-check"></i> Save</button></div></div>`;
  attachAddressSearch($('#ss-paddr'), { name: 'address', value: p.address || '', latName: 'lat', lngName: 'lng', placeholder: 'Street, city, state (optional if GPS)' });
}
async function savePop(id) {
  const d = collect('#f');
  if (!d.name) { toast('Enter a POP name'); return; }
  try {
    if (id) { await api('/pops/' + id, { method: 'PUT', body: JSON.stringify(d) }); location.hash = '#/pop/' + id; }
    else { const r = await api('/pops', { method: 'POST', body: JSON.stringify(d) }); location.hash = '#/pop/' + r.id; }
    toast('Saved');
  } catch (e) { toast(e.message); }
}

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
  view().innerHTML = `<div class="head"><h1 style="flex:1">Accounts</h1>${isPriv() ? '<a class="btn" href="#/customer/new"><i class="ti ti-plus"></i> Add account</a>' : ''}</div>
    <div class="card" style="margin-top:14px">${rows || '<div class="row muted">No accounts yet</div>'}</div>`;
}

async function renderCustomer(id) {
  const a = await api('/accounts/' + id);
  const contacts = a.contacts.map(c => `<div class="kv"><div><div>${esc(c.name)}</div><div class="small sec-muted">${esc(c.role || '')}${c.is_primary ? ' · Primary' : ''}${c.is_billing ? ' · Billing' : ''}</div></div>
    <div style="text-align:right" class="small">${c.phone ? `<a class="iplink" href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ''}${c.email ? `<div><a class="iplink" href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ''}</div></div>`).join('');
  const prev = a.previous_isps.map(p => `<div class="kv" style="display:block">
    <div style="display:flex;justify-content:space-between"><span>${esc(p.provider)}</span><span class="small muted">${esc(p.until_label || '')}</span></div>
    <div class="small sec-muted" style="margin-top:3px"><span class="muted">Why they left:</span> ${esc(p.reason || '')}</div></div>`).join('');
  const det = [];
  if (a.sub_account) det.push(kv('Sub-account', esc(a.sub_account)));
  if (isPriv() && a.has_pin) det.push(`<div class="kv"><span class="small sec-muted">PIN <span class="badge noc">NOC</span></span><span class="mono" style="cursor:pointer;filter:blur(5px)" title="click to reveal" onclick="this.style.filter='none'">${esc(a.pin)}</span></div>`);
  if (a.email) det.push(`<div class="kv"><span class="small sec-muted">Email</span><a class="iplink" href="mailto:${esc(a.email)}">${esc(a.email)}</a></div>`);
  if (a.portal_url) det.push(`<div class="kv"><span class="small sec-muted">Portal</span><a class="iplink" href="${esc(a.portal_url)}" target="_blank" rel="noopener">Open portal <i class="ti ti-external-link" style="font-size:11px"></i></a></div>`);
  if (isPriv() && a.has_portal_password) det.push(`<div class="kv"><span class="small sec-muted">Account password <span class="badge noc">NOC</span></span><span class="mono" style="cursor:pointer;filter:blur(5px)" title="click to reveal" onclick="this.style.filter='none'">${esc(a.portal_password)}</span></div>`);
  if (isPriv() && a.has_security_questions) det.push(`<div class="kv" style="display:block"><div class="small sec-muted" style="margin-bottom:4px">Security Q&amp;A <span class="badge noc">NOC</span></div><div style="cursor:pointer;filter:blur(5px);white-space:pre-wrap" title="click to reveal" onclick="this.style.filter='none'">${esc(a.security_questions)}</div></div>`);
  if (a.billing_address) det.push(kv('Billing', esc(a.billing_address)));
  const detCard = det.length ? `<div class="card"><div class="hd"><h2>Account details</h2></div><div style="padding:0 14px 10px">${det.join('')}</div></div>` : '';
  const custs = a.customers.map(c => `<div class="row rowlink" onclick="location.hash='#/cust/${c.id}'">
    <div class="av">${initials(c.name)}</div>
    <div style="flex:1;min-width:0"><div>${esc(c.name)}</div><div class="small sec-muted">${c.site_count} site${c.site_count == 1 ? '' : 's'}</div></div>
    ${statusPill(c.status)}<i class="ti ti-chevron-right muted"></i></div>`).join('');
  const sites = a.sites.map(s => `<div class="row rowlink" onclick="location.hash='#/site/${s.id}'">
    <span class="dot" style="flex:none;background:${pillFor(s.needs_attention ? 'Standby' : 'Up')[1]}"></span>
    <div style="flex:1;min-width:0"><div>${esc(s.name)}</div><div class="small sec-muted">${esc(s.customer_name || '')}</div></div>
    <div class="stat">${statusPill(s.conn_status)}<span class="small mono">${s.device_online}/${s.device_total} online</span></div>
    <i class="ti ti-chevron-right muted"></i></div>`).join('');
  view().innerHTML = `
    <div class="crumb" onclick="location.hash='#/customers'"><i class="ti ti-chevron-left"></i> Accounts</div>
    <div class="head"><div class="av" style="width:46px;height:46px;border-radius:8px;font-size:16px">${initials(a.name)}</div>
      <div class="t"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h1>${esc(a.name)}</h1>${statusPill(a.status)}</div>
      <div class="small mono sec-muted" style="margin-top:3px">${esc(a.account_number || '')}</div></div>
      ${isPriv() ? `<a class="btn" href="#/customer/${a.id}/edit"><i class="ti ti-edit"></i> Edit</a>` : ''}</div>
    <div class="grid3" style="margin:16px 0">
      <div class="metric"><div class="l">Customers</div><div class="v">${a.customers.length}</div></div>
      <div class="metric"><div class="l">Sites</div><div class="v">${a.sites.length}</div></div>
      <div class="metric"><div class="l">Devices</div><div class="v">${a.device_count}</div></div>
      <div class="metric"><div class="l">Needs attention</div><div class="v" style="color:var(--warning)">${a.needs_attention}</div></div>
    </div>
    ${detCard}
    ${contacts ? `<div class="card"><div class="hd"><h2>Contacts</h2></div><div style="padding:0 14px 10px">${contacts}</div></div>` : ''}
    ${prev ? `<div class="card"><div class="hd"><h2><i class="ti ti-history-toggle"></i> Previous ISP</h2></div><div style="padding:0 14px 10px">${prev}</div></div>` : ''}
    <div class="card"><div class="hd"><h2>Customers · ${a.customers.length}</h2>${isPriv() ? `<a class="btn sm" href="#/cust/new?account=${a.id}"><i class="ti ti-plus"></i> Add customer</a>` : ''}</div>${custs || '<div class="row muted">No customers yet</div>'}</div>
    ${a.sites.length ? `<div class="card"><div class="hd"><h2>All sites · ${a.sites.length}</h2></div>${sites}</div>` : ''}`;
}

// ---------- Customer (under an account; owns sites) ----------
async function renderCust(id) {
  const c = await api('/customers/' + id);
  const sites = c.sites.map(s => `<div class="row rowlink" onclick="location.hash='#/site/${s.id}'">
    <span class="dot" style="flex:none;background:${pillFor(s.needs_attention ? 'Standby' : 'Up')[1]}"></span>
    <div style="flex:1;min-width:0"><div>${esc(s.name)}</div><div class="small mono sec-muted">mgmt ${esc(s.current_mgmt_ip || '—')} · pub ${esc(s.current_public_ip || '—')}</div></div>
    <div class="stat">${statusPill(s.conn_status)}<span class="small mono">${s.device_online}/${s.device_total} online</span></div>
    <i class="ti ti-chevron-right muted"></i></div>`).join('');
  view().innerHTML = `
    <div class="crumb" onclick="location.hash='#/customer/${c.account.id}'"><i class="ti ti-chevron-left"></i> ${esc(c.account.name)}</div>
    <div class="head"><div class="av" style="width:46px;height:46px;border-radius:8px;font-size:16px">${initials(c.name)}</div>
      <div class="t"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h1>${esc(c.name)}</h1>${statusPill(c.status)}</div>
      <div class="small sec-muted" style="margin-top:3px">Account: <a class="iplink" href="#/customer/${c.account.id}">${esc(c.account.name)}</a></div></div>
      ${isPriv() ? `<a class="btn" href="#/cust/${c.id}/edit"><i class="ti ti-edit"></i> Edit</a>` : ''}</div>
    <div class="grid3" style="margin:16px 0">
      <div class="metric"><div class="l">Sites</div><div class="v">${c.sites.length}</div></div>
      <div class="metric"><div class="l">Devices</div><div class="v">${c.device_count}</div></div>
      <div class="metric"><div class="l">Needs attention</div><div class="v" style="color:var(--warning)">${c.needs_attention}</div></div>
    </div>
    ${c.notes ? `<div class="card" style="padding:12px 14px"><div class="small sec-muted">${esc(c.notes)}</div></div>` : ''}
    <div class="card"><div class="hd"><h2>Sites · ${c.sites.length}</h2><a class="btn sm" href="#/site/new?customer=${c.id}"><i class="ti ti-plus"></i> Add site</a></div>${sites || '<div class="row muted">No sites yet</div>'}</div>`;
}
async function formCust(q) {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  let c = { name: '', account_id: q.account || '', status: 'Active', notes: '' };
  if (q.id) c = await api('/customers/' + q.id);
  const accOpts = META.accounts.map(a => ({ v: a.id, l: a.name }));
  view().innerHTML = `<div class="crumb" onclick="history.back()"><i class="ti ti-chevron-left"></i> Back</div>
    <h1>${q.id ? 'Edit' : 'Add'} customer</h1>
    <div class="card" style="margin-top:14px;padding:16px;overflow:visible" id="f">
      <div class="fld"><label class="fl">Account</label><div id="ss-cacct"></div></div>
      ${field('Customer name', 'name', c.name, { ph: 'e.g. Unit 1072 / Acme West' })}
      ${field('Status', 'status', c.status, { type: 'select', options: ['Active', 'Prospect', 'Suspended', 'Closed'] })}
      ${field('Notes', 'notes', c.notes, { type: 'textarea' })}
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" onclick="history.back()">Cancel</button>
      <button class="btn primary" onclick="saveCust(${q.id || 'null'})"><i class="ti ti-check"></i> Save</button></div></div>`;
  attachSearch($('#ss-cacct'), accOpts, 'account_id', c.account_id || (c.account && c.account.id), 'Search account…');
}
async function saveCust(id) {
  const d = collect('#f');
  if (!d.account_id) { toast('Pick an account'); return; }
  if (!d.name) { toast('Enter a customer name'); return; }
  try {
    if (id) { await api('/customers/' + id, { method: 'PUT', body: JSON.stringify(d) }); location.hash = '#/cust/' + id; }
    else { const r = await api('/customers', { method: 'POST', body: JSON.stringify(d) }); location.hash = '#/cust/' + r.id; }
    toast('Saved');
  } catch (e) { toast(e.message); }
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

  let ifaces = [];
  try { ifaces = d.interfaces_json ? JSON.parse(d.interfaces_json) : []; } catch {}
  let roles = {};
  try { roles = d.iface_roles_json ? JSON.parse(d.iface_roles_json) : {}; } catch {}
  const portsCard = (d.management_mode === 'provider') ? '' : `
    <div class="card"><div class="hd"><h2><i class="ti ti-plug"></i> Ports / interfaces${ifaces.length ? ` · ${ifaces.length}` : ''} <span class="small muted" style="font-weight:400">· tap to graph</span></h2>${isPriv() ? `<button class="btn sm" onclick="pollDevice(${d.id})"><i class="ti ti-refresh"></i> Poll now</button>` : ''}</div>
      ${ifaces.length ? ifaces.map((i, idx) => { const role = roles[i.name] || ''; return `
        <div class="row rowlink" onclick="togglePort(${idx})">
          <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${i.running ? 'var(--success)' : 'var(--text3)'};flex:none"></span>
          <div style="flex:1;min-width:0"><div><span class="mono">${esc(i.name)}</span> ${role ? `<span class="tag" style="background:var(--info-bg);color:var(--info)">${esc(role)}</span>` : ''} ${i.type ? `<span class="tag">${esc(i.type)}</span>` : ''}${i.speed ? ` <span class="tag" style="background:var(--info-bg);color:var(--info)">${esc(i.speed)}</span>` : ''}${i.disabled ? ' <span class="small muted">(disabled)</span>' : ''}</div>
            <div class="small mono sec-muted">${(i.ips && i.ips.length) ? esc(i.ips.join(', ')) : ''}${i.mac ? ((i.ips && i.ips.length) ? ' · ' : '') + esc(i.mac) : ''}</div></div>
          <i class="ti ti-chevron-down chev" id="cv${idx}"></i></div>
        <div id="pp${idx}" style="display:none;padding:8px 14px 14px;background:var(--surface2)">
          ${isPriv() ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span class="small sec-muted">Role</span><select onchange="setIfaceRole(${idx},this.value)" style="width:auto">${['', 'WAN1', 'WAN2', 'LAN', 'MGMT'].map(o => `<option value="${o}" ${o === role ? 'selected' : ''}>${o || '—'}</option>`).join('')}</select></div>` : ''}
          <div class="seg" id="prng${idx}" style="max-width:260px;margin-bottom:8px">
            <button class="segbtn on" data-r="1h" onclick="setPortRange(${idx},'1h')">1h</button>
            <button class="segbtn" data-r="24h" onclick="setPortRange(${idx},'24h')">24h</button>
            <button class="segbtn" data-r="7d" onclick="setPortRange(${idx},'7d')">7d</button></div>
          <div style="position:relative;height:160px"><canvas id="pc${idx}"></canvas></div></div>`; }).join('')
        : '<div class="row muted">Not polled yet. Add admin login + management IP, then Poll now. (MikroTik RouterOS)</div>'}
      ${d.last_polled ? `<div class="help" style="padding:8px 14px">Last polled ${esc(d.last_polled)} · traffic sampled every minute</div>` : ''}
    </div>`;

  const overlayCard = (d.management_mode === 'provider') ? '' : `
    <div class="card"><div class="hd"><h2><i class="ti ti-router-2"></i> Management overlay</h2><span class="tag">${esc(d.mgmt_overlay || 'none')}</span></div>
      <div style="padding:0 14px 14px">
        <div class="kv"><span class="small sec-muted">Overlay IP</span><span class="mono">${esc(d.mgmt_address || '—')}</span></div>
        <div class="kv"><span class="small sec-muted">ZeroTier node ID</span><span class="mono">${esc(d.zt_node_id || '—')}</span></div>
        ${isPriv() ? `<div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
          ${d.wg_provisioned
            ? `<button class="btn sm" onclick="showWg(${d.id})"><i class="ti ti-shield-lock"></i> WireGuard config</button><button class="btn sm" onclick="provisionWg(${d.id})"><i class="ti ti-refresh"></i> Re-provision</button>`
            : `<button class="btn sm" onclick="provisionWg(${d.id})"><i class="ti ti-shield-lock"></i> Provision on WireGuard</button>`}
          ${d.zt_node_id ? `<button class="btn sm" onclick="ztSyncDevice(${d.id})"><i class="ti ti-refresh"></i> Sync ZeroTier</button>` : ''}
        </div><div id="wgout"></div>` : '<div class="help">Overlay provisioning is NOC/Admin only.</div>'}
      </div></div>`;

  const dhcpCard = (d.management_mode === 'provider' || !isPriv()) ? '' : `
    <div class="card"><a class="row rowlink" href="#/device/${d.id}/dhcp">
      <i class="ti ti-address-book sec-muted"></i>
      <div style="flex:1;min-width:0"><div>DHCP leases</div><div class="small sec-muted">View and manage live DHCP leases on this router</div></div>
      <i class="ti ti-chevron-right muted"></i></a></div>`;

  let wifi = null; try { wifi = d.wifi_json ? JSON.parse(d.wifi_json) : null; } catch {}
  const wifiCard = (d.management_mode === 'provider' || !isPriv() || !wifi || !wifi.radios || !wifi.radios.length) ? '' : `
    <div class="card"><a class="row rowlink" href="#/device/${d.id}/wifi">
      <i class="ti ti-wifi sec-muted"></i>
      <div style="flex:1;min-width:0"><div>WiFi${wifi.radios.length > 1 ? ' · ' + wifi.radios.length + ' SSIDs' : ''}</div>
        <div class="small sec-muted">${esc(wifi.radios.map(r => r.ssid || '(no SSID)').join(', '))} · clients, signal &amp; settings</div></div>
      <i class="ti ti-chevron-right muted"></i></a></div>`;

  view().innerHTML = `
    <div class="crumb" onclick="history.back()"><i class="ti ti-chevron-left"></i> Back</div>
    <div class="head"><div class="t"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h1>${esc(d.name)}</h1>${statusPill(d.online ? 'Online' : 'Offline')}</div>
      <div class="small sec-muted" style="margin-top:3px">${esc(d.manufacturer || '')} ${esc(d.model || '')} · ${esc(d.assigned_label || 'unassigned')}</div></div>
      ${d.mgmt_address ? `<a class="btn" href="https://${esc(d.mgmt_address)}" target="_blank"><i class="ti ti-external-link"></i> Console</a>` : ''}
      <a class="btn" href="#/device/${d.id}/edit"><i class="ti ti-edit"></i> Edit</a></div>

    ${d.management_mode === 'provider' ? '' : `
    <div class="card"><div class="hd"><h2><i class="ti ti-arrows-up-down"></i> WAN traffic</h2><div class="seg" style="flex:none" id="wanrng">
      <button class="segbtn on" data-r="1h" onclick="setWanRange('1h')">1h</button><button class="segbtn" data-r="24h" onclick="setWanRange('24h')">24h</button><button class="segbtn" data-r="7d" onclick="setWanRange('7d')">7d</button></div></div>
      <div style="padding:0 14px 14px"><div style="position:relative;height:180px"><canvas id="wanchart"></canvas></div>
      <div class="help" id="wanhelp">Sum of interfaces tagged WAN1/WAN2 · sampled every minute</div></div>
    <div class="card"><div class="hd"><h2><i class="ti ti-activity"></i> WAN latency</h2><div class="seg" style="flex:none" id="latrng">
      <button class="segbtn on" data-r="1h" onclick="setLatRange('1h')">1h</button><button class="segbtn" data-r="24h" onclick="setLatRange('24h')">24h</button><button class="segbtn" data-r="7d" onclick="setLatRange('7d')">7d</button></div></div>
      <div style="padding:0 14px 14px"><div style="position:relative;height:180px"><canvas id="latchart"></canvas></div>
      <div class="help">Ping to 8.8.8.8 from the device · sampled every minute</div></div></div>`}

    <div class="card"><div class="hd"><h2>Details</h2></div><div style="padding:0 14px 10px">${info.map(([k, v]) => `<div class="kv"><span class="small sec-muted">${esc(k)}</span><span class="mono small">${v}</span></div>`).join('')}</div></div>

    ${portsCard}

    ${wifiCard}

    ${dhcpCard}

    ${overlayCard}

    ${visibleCreds.length ? `<div class="card"><div class="hd"><h2><i class="ti ti-key"></i> Credentials</h2><button class="btn sm" onclick="revealCreds(${d.id})"><i class="ti ti-eye"></i> Reveal</button></div><div style="padding:0 14px 10px">${credRows}<div class="help"><i class="ti ti-lock"></i> Masked · reveal is logged${isPriv() ? '' : ' · NOC-only fields hidden for your role'}</div></div></div>` : ''}`;

  window._devId = d.id; window._devPorts = ifaces.map(i => i.name);
  if (d.management_mode !== 'provider') { setWanRange('1h'); setLatRange('1h'); }
}
let _wanChart = null;
async function setWanRange(range) {
  document.querySelectorAll('#wanrng .segbtn').forEach(b => b.classList.toggle('on', b.dataset.r === range));
  let rows = []; try { rows = await api('/devices/' + window._devId + '/wan-traffic?range=' + range); } catch {}
  const cv = $('#wanchart'); if (!cv) return;
  const mbps = v => Math.round(v / 1e4) / 100;
  if (_wanChart) _wanChart.destroy();
  _wanChart = new Chart(cv, { type: 'line', data: { labels: rows.map(r => fmtTs(r.ts, range)), datasets: [
    { label: 'Download', data: rows.map(r => mbps(r.rx_bps)), borderColor: '#378ADD', backgroundColor: 'rgba(55,138,221,.12)', fill: true, tension: .35, pointRadius: 0, borderWidth: 2 },
    { label: 'Upload', data: rows.map(r => mbps(r.tx_bps)), borderColor: '#1D9E75', backgroundColor: 'rgba(29,158,117,.12)', fill: true, tension: .35, pointRadius: 0, borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.dataset.label + ': ' + c.parsed.y + ' Mbps' } } }, scales: { y: { beginAtZero: true, ticks: { callback: v => v + 'M' } } } } });
  const h = $('#wanhelp'); if (h) h.textContent = rows.length ? 'Sum of interfaces tagged WAN1/WAN2 · sampled every minute' : 'No WAN traffic yet — tag a port as WAN1/WAN2 (expand a port → Role).';
}
function fmtTs(ts, range) { const d = new Date(ts); return (range === '7d' || range === '60d') ? (d.getMonth() + 1) + '/' + d.getDate() : ('' + d.getHours()).padStart(2, '0') + ':' + ('' + d.getMinutes()).padStart(2, '0'); }
let _latChart = null;
async function setLatRange(range) {
  document.querySelectorAll('#latrng .segbtn').forEach(b => b.classList.toggle('on', b.dataset.r === range));
  let rows = []; try { rows = await api('/devices/' + window._devId + '/latency?range=' + range); } catch {}
  const cv = $('#latchart'); if (!cv) return;
  if (_latChart) _latChart.destroy();
  _latChart = new Chart(cv, { type: 'line', data: { labels: rows.map(r => fmtTs(r.ts, range)), datasets: [{ label: 'ms', data: rows.map(r => r.ms), borderColor: '#7F77DD', backgroundColor: 'rgba(127,119,221,.12)', fill: true, tension: .35, pointRadius: 0, borderWidth: 2 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.parsed.y + ' ms' } } }, scales: { y: { beginAtZero: true, ticks: { callback: v => v + 'ms' } } } } });
}
const _portCharts = {};
async function togglePort(idx) {
  const panel = $('#pp' + idx), cv = $('#cv' + idx);
  const open = panel.style.display !== 'block';
  panel.style.display = open ? 'block' : 'none';
  if (cv) cv.classList.toggle('open', open);
  if (open && !panel.dataset.loaded) { panel.dataset.loaded = '1'; setPortRange(idx, '1h'); }
}
async function setPortRange(idx, range) {
  const name = window._devPorts[idx];
  document.querySelectorAll('#prng' + idx + ' .segbtn').forEach(b => b.classList.toggle('on', b.dataset.r === range));
  let rows = []; try { rows = await api('/devices/' + window._devId + '/traffic?iface=' + encodeURIComponent(name) + '&range=' + range); } catch {}
  const cv = $('#pc' + idx); if (!cv) return;
  const mbps = v => Math.round(v / 1e4) / 100;
  if (_portCharts[idx]) _portCharts[idx].destroy();
  _portCharts[idx] = new Chart(cv, { type: 'line', data: { labels: rows.map(r => fmtTs(r.ts, range)), datasets: [
    { label: 'Download', data: rows.map(r => mbps(r.rx_bps)), borderColor: '#378ADD', backgroundColor: 'rgba(55,138,221,.12)', fill: true, tension: .35, pointRadius: 0, borderWidth: 2 },
    { label: 'Upload', data: rows.map(r => mbps(r.tx_bps)), borderColor: '#1D9E75', backgroundColor: 'rgba(29,158,117,.12)', fill: true, tension: .35, pointRadius: 0, borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.dataset.label + ': ' + c.parsed.y + ' Mbps' } } }, scales: { y: { beginAtZero: true, ticks: { callback: v => v + 'M' } } } } });
}
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

// Address autocomplete (OpenStreetMap via /api/geocode). Fills the address input + optional lat/lng fields.
function attachAddressSearch(host, opts) {
  if (!host) return;
  const { name, value = '', placeholder = 'Start typing an address…', latName, lngName } = opts;
  host.classList.add('ss');
  host.innerHTML = `<input type="text" class="ss-input" name="${name}" placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off"/>
    <div class="ss-list" style="display:none"></div>`;
  const input = host.querySelector('.ss-input'), list = host.querySelector('.ss-list');
  let timer = null, seq = 0;
  const setField = (n, v) => { if (!n) return; const el = view().querySelector('#f [name="' + n + '"]'); if (el && v != null) el.value = v; };
  const run = async (q) => {
    const my = ++seq;
    try {
      const r = await api('/geocode?q=' + encodeURIComponent(q));
      if (my !== seq) return;
      list._data = r;
      list.innerHTML = r.length ? r.map((i, idx) => `<div class="ss-opt" data-idx="${idx}">${esc(i.label)}</div>`).join('') : '<div class="ss-opt muted">No matches</div>';
      list.style.display = 'block';
    } catch { if (my === seq) { list.innerHTML = '<div class="ss-opt muted">Lookup failed</div>'; list.style.display = 'block'; } }
  };
  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 3) { list.style.display = 'none'; return; }
    list.innerHTML = '<div class="ss-opt muted">Searching…</div>'; list.style.display = 'block';
    timer = setTimeout(() => run(q), 350);
  });
  list.addEventListener('mousedown', (e) => {
    const o = e.target.closest('.ss-opt'); if (!o || o.dataset.idx == null) return;
    const item = (list._data || [])[+o.dataset.idx]; if (!item) return;
    input.value = item.label;
    setField(latName, item.lat); setField(lngName, item.lon);
    list.style.display = 'none';
  });
  input.addEventListener('blur', () => setTimeout(() => { list.style.display = 'none'; }, 150));
}

async function formCustomer(q) {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  let a = { name: '', account_number: '', status: 'Active', billing_address: '', notes: '' };
  if (q.id) a = await api('/accounts/' + q.id);
  view().innerHTML = `<div class="crumb" onclick="history.back()"><i class="ti ti-chevron-left"></i> Back</div>
    <h1>${q.id ? 'Edit' : 'Add'} account</h1>
    <div class="card" style="margin-top:14px;padding:16px" id="f">
      ${field('Account name', 'name', a.name, { ph: 'e.g. Acme Logistics' })}
      <div class="grid2">${field('Account number', 'account_number', a.account_number, { mono: true })}
      ${field('Status', 'status', a.status, { type: 'select', options: ['Active', 'Prospect', 'Suspended', 'Closed'] })}</div>
      <div class="grid2">${field('Sub-account (optional)', 'sub_account', a.sub_account, { mono: true })}
      ${field('Account PIN', 'pin', '', { mono: true, ph: q.id ? 'unchanged' : 'NOC/Admin only' })}</div>
      <div class="grid2">${field('Account email', 'email', a.email, { type: 'email', ph: 'login email / contact' })}
      ${field('Portal login URL', 'portal_url', a.portal_url, { ph: 'https://portal.carrier.com/login' })}</div>
      ${field('Account / portal password', 'portal_password', '', { mono: true, ph: q.id ? 'unchanged · NOC/Admin only' : 'NOC/Admin only' })}
      ${field('Security questions & answers', 'security_questions', a.security_questions || '', { type: 'textarea', ph: q.id && a.has_security_questions ? 'unchanged — type to replace' : 'e.g. First pet? Fluffy · City born? Dallas' })}
      <div class="fld"><label class="fl">Billing address</label><div id="ss-baddr"></div></div>
      ${field('Notes', 'notes', a.notes, { type: 'textarea' })}
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" onclick="history.back()">Cancel</button>
      <button class="btn primary" onclick="saveCustomer(${q.id || 'null'})"><i class="ti ti-check"></i> Save</button></div></div>`;
  attachAddressSearch($('#ss-baddr'), { name: 'billing_address', value: a.billing_address || '', placeholder: 'Start typing an address…' });
}
async function saveCustomer(id) {
  const d = collect('#f');
  if (id) { await api('/accounts/' + id, { method: 'PUT', body: JSON.stringify(d) }); location.hash = '#/customer/' + id; }
  else { const r = await api('/accounts', { method: 'POST', body: JSON.stringify(d) }); location.hash = '#/customer/' + r.id; }
  toast('Saved');
}

async function formSite(q) {
  let s = { name: '', service_address: '', status: 'Active', current_mgmt_ip: '', current_public_ip: '' };
  if (q.id) s = await api('/sites/' + q.id);
  const custs = await api('/customers');
  const custOpts = custs.map(c => ({ v: c.id, l: c.name + (c.account_name ? ' · ' + c.account_name : '') }));
  const accOpts = META.accounts.map(a => ({ v: a.id, l: a.name }));
  const preCust = q.customer || (s.customer && s.customer.id) || s.customer_id || '';
  view().innerHTML = `<div class="crumb" onclick="history.back()"><i class="ti ti-chevron-left"></i> Back</div>
    <h1>${q.id ? 'Edit' : 'Add'} site</h1>
    <div class="card" style="margin-top:14px;padding:16px;overflow:visible" id="f">
      <div class="fld">
        <label class="fl" style="display:flex;justify-content:space-between;align-items:center">Customer
          ${isPriv() && !q.id ? `<label class="small sec-muted" style="font-weight:400;cursor:pointer"><input type="checkbox" id="newCust" onchange="toggleNewCust()" style="width:auto"> New customer</label>` : ''}</label>
        <div id="ss-customer"></div>
        <div id="newCustBox" style="display:none;margin-top:10px;padding:12px;border:.5px solid var(--border);border-radius:8px;background:var(--surface)">
          ${field('Customer name', 'nc_name', '', { ph: 'e.g. Riverside Logistics' })}
          <div class="fld">
            <label class="fl" style="display:flex;justify-content:space-between;align-items:center">Account
              <label class="small sec-muted" style="font-weight:400;cursor:pointer"><input type="checkbox" id="newAcct" onchange="toggleNewAccount()" style="width:auto"> New account</label></label>
            <div id="ss-account"></div>
            <div id="newAcctBox" style="display:none">
              ${field('Account name', 'na_name', '', { ph: 'e.g. Acme Brokerage' })}
              <div class="grid2">${field('Account number', 'na_account_number', '', { mono: true })}${field('Status', 'na_status', 'Active', { type: 'select', options: ['Active', 'Prospect', 'Suspended', 'Closed'] })}</div>
            </div>
          </div>
        </div>
      </div>
      ${field('Site name', 'name', s.name, { ph: 'e.g. Riverside Office' })}
      <div class="fld"><label class="fl">Service address</label><div id="ss-saddr"></div></div>
      <div class="grid2">${field('Latitude', 'lat', s.lat || '', { mono: true })}${field('Longitude', 'lng', s.lng || '', { mono: true })}</div>
      <div class="grid2">${field('Status', 'status', s.status, { type: 'select', options: ['Active', 'Provisioning', 'Suspended', 'Cancelled'] })}
      ${field('Current public IP', 'current_public_ip', s.current_public_ip, { mono: true })}</div>
      ${field('Current management IP', 'current_mgmt_ip', s.current_mgmt_ip, { mono: true })}
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" onclick="history.back()">Cancel</button>
      <button class="btn primary" onclick="saveSite(${q.id || 'null'})"><i class="ti ti-check"></i> Save</button></div></div>`;
  attachSearch($('#ss-customer'), custOpts, 'customer_id', preCust, 'Search customer…');
  attachSearch($('#ss-account'), accOpts, 'account_id', '', 'Search account…');
  attachAddressSearch($('#ss-saddr'), { name: 'service_address', value: s.service_address || '', latName: 'lat', lngName: 'lng', placeholder: 'Street, city, state (optional if GPS)' });
}
function toggleNewCust() {
  const on = $('#newCust').checked;
  $('#newCustBox').style.display = on ? 'block' : 'none';
  $('#ss-customer').style.display = on ? 'none' : 'block';
}
function toggleNewAccount() {
  const on = $('#newAcct').checked;
  $('#newAcctBox').style.display = on ? 'block' : 'none';
  $('#ss-account').style.display = on ? 'none' : 'block';
}
async function saveSite(id) {
  const d = collect('#f');
  const newCust = $('#newCust') && $('#newCust').checked;
  if (newCust) {
    if (!d.nc_name) { toast('Enter the new customer name'); return; }
    let accountId = d.account_id;
    const newAcct = $('#newAcct') && $('#newAcct').checked;
    if (newAcct) {
      if (!d.na_name) { toast('Enter the new account name'); return; }
      try { const a = await api('/accounts', { method: 'POST', body: JSON.stringify({ name: d.na_name, account_number: d.na_account_number, status: d.na_status }) }); accountId = a.id; }
      catch (e) { toast('Account: ' + e.message); return; }
    }
    if (!accountId) { toast('Pick an account for the new customer'); return; }
    try { const c = await api('/customers', { method: 'POST', body: JSON.stringify({ account_id: accountId, name: d.nc_name }) }); d.customer_id = c.id; }
    catch (e) { toast('Customer: ' + e.message); return; }
  }
  if (!d.customer_id) { toast('Pick a customer'); return; }
  if (!d.name) { toast('Enter a site name'); return; }
  ['nc_name', 'na_name', 'na_account_number', 'na_status', 'account_id'].forEach(k => delete d[k]);
  try {
    if (id) { await api('/sites/' + id, { method: 'PUT', body: JSON.stringify(d) }); location.hash = '#/site/' + id; }
    else { const r = await api('/sites', { method: 'POST', body: JSON.stringify(d) }); location.hash = '#/site/' + r.id; }
    toast('Saved');
  } catch (e) { toast(e.message); }
}

async function formDevice(q) {
  let d = { name: '', status: 'Deployed', management_mode: 'platform', mgmt_overlay: 'WireGuard', ownership: 'us', account_status: 'active', online: 1 };
  if (q.id) d = await api('/devices/' + q.id);
  if (!q.id) { // prefill from a ZeroTier member ("Add to site")
    if (q.zt) { d.zt_node_id = q.zt; d.mgmt_overlay = 'ZeroTier'; }
    if (q.name) d.name = q.name;
    if (q.ip) d.mgmt_address = q.ip;
  }
  const modelOpts = (await api('/models')).map(m => ({ v: m.id, l: m.manufacturer + ' ' + m.model }));
  const siteOpts = (await api('/sites')).map(s => ({ v: s.id, l: s.name }));
  const popOpts = (await api('/pops')).map(p => ({ v: p.id, l: 'POP · ' + p.name }));
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
      <div class="grid2">${field('Carrier / distributor', 'owner_org', d.owner_org, { ph: 'e.g. Verizon, Granite' })}${field('Account number', 'account_number', d.account_number, { mono: true })}</div>
      <div class="help">This is the carrier/distributor account the hardware sits on — not the customer. Always recorded, even for gear we own.</div>
      </div>

      <div id="platExtra" style="display:${d.management_mode === 'provider' ? 'none' : 'block'}">
        <div class="fld"><label class="fl">Management overlay</label><div class="seg" style="max-width:360px">
          <button type="button" class="segbtn ${d.mgmt_overlay !== 'ZeroTier' ? 'on' : ''}" id="ov-WireGuard" onclick="setOv('WireGuard')"><i class="ti ti-shield-lock"></i> WireGuard</button>
          <button type="button" class="segbtn ${d.mgmt_overlay === 'ZeroTier' ? 'on' : ''}" id="ov-ZeroTier" onclick="setOv('ZeroTier')"><i class="ti ti-network"></i> ZeroTier</button>
        </div><input type="hidden" name="mgmt_overlay" value="${d.mgmt_overlay || 'WireGuard'}"/></div>
        ${field('Management IP', 'mgmt_address', d.mgmt_address, { mono: true, ph: 'auto-set when provisioned' })}
        ${field('ZeroTier node ID (if using ZeroTier)', 'zt_node_id', d.zt_node_id, { mono: true, ph: '10-hex node id' })}
        <div class="box"><div class="small" style="font-weight:500;margin-bottom:8px"><i class="ti ti-key"></i> Credentials</div>
        <div class="grid2">${field('Admin username', 'admin_username', d.admin_username || 'admin', { mono: true })}${field('Admin password', 'admin_password', '', { ph: q.id ? 'unchanged' : '' })}</div>
        <div class="grid2">${field('Tech username', 'tech_username', d.tech_username)}${field('Tech password', 'tech_password', '', { ph: q.id ? 'unchanged' : '' })}</div>
        ${field('Factory password', 'factory_password', '', { ph: q.id ? 'unchanged' : '' })}
        <div class="help">Admin login is used to poll the device for its live ports (MikroTik RouterOS).</div></div>
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

// ---------- Settings: management overlays (NOC/Admin) ----------
async function renderSettings() {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  const s = await api('/settings');
  view().innerHTML = `<h1>Settings</h1><div class="small sec-muted" style="margin:4px 0 14px">Management network &amp; overlays</div>
    <div class="card" style="padding:16px" id="zt">
      <h2 style="margin-bottom:12px"><i class="ti ti-network"></i> ZeroTier</h2>
      ${field('Network ID', 'zt_network_id', s.zt_network_id, { mono: true, ph: '16-hex network id' })}
      ${field('API token', 'zt_api_token', '', { mono: true, ph: s.has_zt_api_token ? 'unchanged' : 'ZeroTier Central API token' })}
      <div class="help">Used to read members' assigned IPs from ZeroTier Central. Token is NOC/Admin-only and stored server-side.</div>
      <div style="display:flex;gap:10px;margin-top:12px"><button class="btn primary" onclick="saveSettings()"><i class="ti ti-check"></i> Save</button>
      <button class="btn" onclick="ztSync()"><i class="ti ti-refresh"></i> Sync ZeroTier now</button></div>
    </div>
    <div class="card" style="padding:16px" id="wg">
      <h2 style="margin-bottom:12px"><i class="ti ti-shield-lock"></i> WireGuard</h2>
      <div class="grid2">${field('Hub endpoint', 'wg_endpoint', s.wg_endpoint, { mono: true, ph: 'mgmt.host:51820' })}
      ${field('Subnet (managed range)', 'wg_subnet', s.wg_subnet, { mono: true, ph: '10.200.0.0/16' })}</div>
      ${field('DNS (optional)', 'wg_dns', s.wg_dns, { mono: true })}
      <div class="fld"><label class="fl">Hub public key</label>
        <input value="${esc(s.wg_server_pub || '(generated on save)')}" readonly style="font-family:var(--mono);background:var(--surface2)"/>
        <div class="help">Devices use this as the [Peer] PublicKey. Private key stays server-side. ${s.has_wg_server_priv ? '' : 'Save once to generate the hub keypair.'}</div></div>
      <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap"><button class="btn primary" onclick="saveSettings()"><i class="ti ti-check"></i> Save</button>
      <button class="btn" onclick="dlHub()"><i class="ti ti-download"></i> Download hub wg0.conf</button>
      <button class="btn" onclick="regenWg()"><i class="ti ti-refresh"></i> Regenerate hub key</button></div>
      <div id="hubout"></div>
    </div>
    <div class="help">After saving the WireGuard subnet, open a device → Management overlay → Provision on WireGuard to assign it a non-overlapping IP and download its config. Apply the device's <span class="mono">[Peer]</span> stanza to your hub.</div>`;
}
async function saveSettings() {
  const z = collect('#zt'), w = collect('#wg');
  const d = Object.assign({}, z, w);
  if (!d.zt_api_token) delete d.zt_api_token; // blank = keep existing
  try { await api('/settings', { method: 'PUT', body: JSON.stringify(d) }); toast('Saved'); renderSettings(); } catch (e) { toast(e.message); }
}
async function regenWg() {
  if (!confirm('Regenerate the hub keypair? Existing device configs will need to be re-downloaded.')) return;
  try { await api('/settings/wg/regenerate', { method: 'POST' }); toast('New hub key generated'); renderSettings(); } catch (e) { toast(e.message); }
}
async function ztSync() {
  try { const r = await api('/zerotier/sync', { method: 'POST' }); toast(`ZeroTier: updated ${r.updated} of ${r.members} members`); } catch (e) { toast(e.message); }
}
// ---------- ZeroTier status page ----------
let _ztMembers = [];
async function renderZeroTier() {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  let data;
  try { data = await api('/zerotier/members'); }
  catch (e) { view().innerHTML = `<h1>ZeroTier</h1><div class="card" style="padding:20px">Couldn't load members: ${esc(e.message)}<div class="help" style="margin-top:8px">Set your network ID + API token under Settings.</div></div>`; return; }
  _ztMembers = data.members;
  view().innerHTML = `<div class="head"><h1 style="flex:1">ZeroTier</h1><button class="btn" onclick="ztSyncAll()"><i class="ti ti-refresh"></i> Sync IPs</button></div>
    <div class="grid3" style="margin:16px 0">
      <div class="metric"><div class="l">Members</div><div class="v">${data.count}</div></div>
      <div class="metric"><div class="l">Online</div><div class="v" style="color:var(--success)">${data.online}</div></div>
      <div class="metric"><div class="l">Linked to a device</div><div class="v">${_ztMembers.filter(m => m.device).length}</div></div>
    </div>
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">
      <input id="ztq" placeholder="Search name, node ID, or IP…" oninput="drawZt()" style="flex:1"/>
      <label class="small sec-muted" style="display:flex;align-items:center;gap:6px;white-space:nowrap;cursor:pointer"><input type="checkbox" id="ztUnassigned" onchange="drawZt()" style="width:auto"/> Unassigned only</label>
    </div>
    <div class="card" id="ztlist"></div>`;
  drawZt();
}
function drawZt() {
  const q = ($('#ztq') ? $('#ztq').value : '').toLowerCase();
  const unassignedOnly = $('#ztUnassigned') && $('#ztUnassigned').checked;
  const rows = _ztMembers.filter(m => (!q || (m.name + m.nodeId + (m.ip || '')).toLowerCase().includes(q)) && (!unassignedOnly || !m.device)).map(m => {
    const dotc = m.online ? 'var(--success)' : 'var(--text3)';
    const assigned = m.device ? `<span class="tag" style="background:var(--success-bg);color:var(--success)"><i class="ti ti-circle-check" style="font-size:11px"></i> ${esc(m.device.site || m.device.name)}</span>` : '';
    const action = m.device
      ? `<a class="btn sm" href="#/device/${m.device.id}">View device</a>`
      : `<button class="btn sm" onclick="ztAdd('${esc(m.nodeId)}','${encodeURIComponent(m.name)}','${esc(m.ip || '')}')"><i class="ti ti-plus"></i> Add to site</button>`;
    return `<div class="row">
      <span class="dot" style="background:${dotc};flex:none"></span>
      <div style="flex:1;min-width:0"><div>${esc(m.name || '(unnamed)')} ${assigned} ${m.authorized ? '' : '<span class="badge" style="background:var(--warning-bg);color:var(--warning)">unauthorized</span>'}</div>
        <div class="small mono sec-muted">${esc(m.nodeId)} · ${esc(m.ip || 'no IP')}</div></div>
      <span class="small muted">${m.online ? 'online' : timeAgo(m.lastSeen)}</span>
      ${action}</div>`;
  }).join('');
  $('#ztlist').innerHTML = rows || '<div class="row muted">No matches</div>';
}
function ztAdd(nodeId, nameEnc, ip) { location.hash = `#/device/new?zt=${encodeURIComponent(nodeId)}&name=${nameEnc}&ip=${encodeURIComponent(ip)}`; }
async function ztSyncAll() { try { const r = await api('/zerotier/sync', { method: 'POST' }); toast(`Synced ${r.updated} of ${r.members}`); renderZeroTier(); } catch (e) { toast(e.message); } }
function timeAgo(ms) { if (!ms) return 'never'; const s = Math.floor((Date.now() - ms) / 1000); if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; }

// ---------- Threat blocklist ----------
async function renderBlocklist() {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  const data = await api('/blocklist');
  const list = data.list || [];
  const min = data.min_hits || 1;
  const isBlocked = b => b.active && (b.source === 'manual' || b.hits >= min);
  const blocked = list.filter(isBlocked).length;
  const pending = list.filter(b => b.active && !isBlocked(b)).length;
  const rows = list.map(b => {
    const eff = isBlocked(b);
    const dot = eff ? 'var(--danger)' : (b.active ? 'var(--warning)' : 'var(--text3)');
    const label = !b.active ? ' <span class="small muted">(disabled)</span>'
      : (eff ? '' : ' <span class="small" style="color:var(--warning)">(below threshold)</span>');
    return `<div class="row">
    <span class="dot" style="flex:none;background:${dot}"></span>
    <div style="flex:1;min-width:0"><div class="mono">${esc(b.ip)}${label}</div>
      <div class="small sec-muted">${esc(b.reason || '')}${b.source ? ' · ' + esc(b.source) : ''} · ${b.hits} hit${b.hits == 1 ? '' : 's'} · ${esc(b.last_seen || '')}</div></div>
    <button class="btn sm" onclick="toggleBlock(${b.id},${b.active ? 0 : 1})">${b.active ? 'Disable' : 'Enable'}</button>
    <button class="btn sm" onclick="delBlock(${b.id})"><i class="ti ti-trash"></i></button></div>`;
  }).join('');
  view().innerHTML = `<div class="head"><h1 style="flex:1">Blocklist</h1>
    <button class="btn" onclick="scanBlock()"><i class="ti ti-search"></i> Scan logs</button>
    <button class="btn primary" onclick="pushBlock()"><i class="ti ti-upload"></i> Push to routers</button></div>
    <div class="grid3" style="margin:16px 0">
      <div class="metric"><div class="l">Blocked on routers</div><div class="v" style="color:var(--danger)">${blocked}</div></div>
      <div class="metric"><div class="l">Below threshold</div><div class="v" style="color:var(--warning)">${pending}</div></div>
      <div class="metric"><div class="l">Total tracked</div><div class="v">${list.length}</div></div>
    </div>
    <div class="box"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span class="small sec-muted">Only block IPs with at least</span>
      <input id="minhits" type="number" min="1" value="${min}" style="width:72px;font-family:var(--mono)"/>
      <span class="small sec-muted">failed-login hit(s)</span>
      <button class="btn sm" onclick="saveMinHits()"><i class="ti ti-check"></i> Save</button>
      <span class="small sec-muted">· manually-added IPs always block.</span>
    </div></div>
    <div class="box"><div style="display:flex;gap:8px"><input id="newip" placeholder="Add IP manually (e.g. 1.2.3.4)" style="flex:1;font-family:var(--mono)"/><button class="btn" onclick="addBlock()"><i class="ti ti-plus"></i> Add</button></div></div>
    <div class="card">${rows || '<div class="row muted">No blocked IPs yet — Scan logs to harvest failed-login attempts.</div>'}</div>
    <div class="help">Auto-harvested from RouterOS logs (failed logins) every minute, and auto-pushed to all reachable routers whenever the list changes — writing to each router's <span class="mono">netinv-blocklist</span> address-list and ensuring an input-chain drop rule. Use <b>Push to routers</b> to force a sync now.</div>`;
}
async function saveMinHits() { const n = parseInt($('#minhits').value, 10); if (!Number.isFinite(n) || n < 1) { toast('Enter a whole number ≥ 1'); return; } try { const r = await api('/blocklist/settings', { method: 'PUT', body: JSON.stringify({ min_hits: n }) }); toast('Threshold saved · ' + r.min_hits + ' hit(s)'); renderBlocklist(); } catch (e) { toast(e.message); } }
async function addBlock() { const ip = $('#newip').value.trim(); if (!ip) return; try { await api('/blocklist', { method: 'POST', body: JSON.stringify({ ip }) }); toast('Added'); renderBlocklist(); } catch (e) { toast(e.message); } }
async function toggleBlock(id, active) { try { await api('/blocklist/' + id, { method: 'PUT', body: JSON.stringify({ active }) }); renderBlocklist(); } catch (e) { toast(e.message); } }
async function delBlock(id) { try { await api('/blocklist/' + id, { method: 'DELETE' }); renderBlocklist(); } catch (e) { toast(e.message); } }
async function scanBlock() { toast('Scanning device logs…'); try { const r = await api('/blocklist/scan', { method: 'POST' }); toast(`Scanned ${r.scanned} device(s) · ${r.total} IPs tracked`); renderBlocklist(); } catch (e) { toast(e.message); } }
async function pushBlock() {
  if (!confirm('Push the active blocklist to all reachable routers? Updates their netinv-blocklist address-list and ensures a drop rule.')) return;
  toast('Pushing to routers…');
  try {
    const r = await api('/blocklist/push', { method: 'POST', body: JSON.stringify({}) });
    const ok = r.results.filter(x => !x.error).length;
    const added = r.results.reduce((a, x) => a + (x.added || 0), 0);
    const err = r.results.find(x => x.error);
    toast(err ? ('Push error: ' + err.error) : `Pushed to ${ok}/${r.results.length} router(s) · ${added} IP(s) added`);
  } catch (e) { toast(e.message); }
}

async function dlHub() {
  try {
    const r = await api('/settings/wg/hub-config');
    const out = $('#hubout');
    out.innerHTML = `<div style="margin-top:12px"><div class="small sec-muted" style="margin-bottom:4px">Hub config — put at <span class="mono">/etc/wireguard/wg0.conf</span> (${r.peers} peer(s))</div>
      <textarea id="hubcfg" readonly rows="8" style="font-family:var(--mono);font-size:12px"></textarea>
      <button class="btn sm" id="hubdl" style="margin-top:8px"><i class="ti ti-download"></i> Download wg0.conf</button></div>`;
    $('#hubcfg').value = r.config;
    $('#hubdl').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([r.config], { type: 'text/plain' }));
      a.download = 'wg0.conf'; a.click();
    });
  } catch (e) { toast(e.message); }
}

// ---------- Device overlay actions ----------
async function provisionWg(id) {
  try { const r = await api('/devices/' + id + '/wireguard', { method: 'POST' }); toast('Provisioned ' + r.address); renderDevice(id); } catch (e) { toast(e.message); }
}
async function ztSyncDevice(id) {
  try { const r = await api('/zerotier/sync', { method: 'POST' }); toast(`ZeroTier: updated ${r.updated} of ${r.members}`); renderDevice(id); } catch (e) { toast(e.message); }
}
async function setIfaceRole(idx, role) {
  const name = window._devPorts[idx];
  try { await api('/devices/' + window._devId + '/iface-role', { method: 'PUT', body: JSON.stringify({ iface: name, role }) }); toast(role ? `${name} → ${role}` : `${name} role cleared`); renderDevice(window._devId); } catch (e) { toast(e.message); }
}
async function pollDevice(id) {
  toast('Polling device…');
  try {
    const r = await api('/devices/' + id + '/poll', { method: 'POST' });
    let msg = `Found ${r.count} interfaces`;
    if (r.set_mgmt) msg += ` · mgmt ${r.set_mgmt}→${r.target}`;
    if (r.public_ip) msg += ` · public ${r.public_ip}${r.set_public ? ' set' : ''}`;
    else if (r.target) msg += ' · no public IP found (CGNAT?)';
    toast(msg); renderDevice(id);
  } catch (e) { toast(e.message); }
}
async function renderDeviceDhcp(id) {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  const d = await api('/devices/' + id);
  view().innerHTML = `
    <div class="crumb" onclick="location.hash='#/device/${id}'"><i class="ti ti-chevron-left"></i> ${esc(d.name)}</div>
    <div class="head"><div class="t"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h1><i class="ti ti-address-book"></i> DHCP leases</h1></div>
      <div class="small sec-muted" style="margin-top:3px">${esc(d.name)} · ${esc(d.mgmt_address || 'no management IP')}</div></div>
      <button class="btn" onclick="loadLeases(${id})"><i class="ti ti-refresh"></i> Refresh</button></div>
    <div class="card" style="margin-top:14px"><div id="dhcpBody"><div class="row muted">Loading leases…</div></div></div>`;
  loadLeases(id);
}
async function loadLeases(id) {
  const body = $('#dhcpBody'); if (!body) return;
  body.innerHTML = '<div class="row muted">Loading leases from the router…</div>';
  try {
    const r = await api('/devices/' + id + '/dhcp-leases');
    window._leases = r.leases || []; window._dhcpDevId = id;
    renderLeases();
  } catch (e) { body.innerHTML = '<div class="row muted">' + esc(e.message) + '</div>'; }
}
function renderLeases() {
  const body = $('#dhcpBody'); if (!body) return;
  const ls = window._leases || [];
  if (!ls.length) { body.innerHTML = '<div class="row muted">No DHCP leases on this router.</div>'; return; }
  body.innerHTML = ls.map((l, idx) => {
    const tags = [`<span class="tag">${l.dynamic ? 'dynamic' : 'static'}</span>`];
    if (l.blocked) tags.push('<span class="tag" style="background:rgba(220,53,69,.14);color:var(--danger)">blocked</span>');
    if (l.disabled) tags.push('<span class="tag" style="background:rgba(245,166,35,.16);color:var(--warning)">disabled</span>');
    const dot = l.status === 'bound' ? 'var(--success)' : 'var(--text3)';
    const opts = ['<option value="">Actions…</option>'];
    if (l.dynamic) opts.push('<option value="make-static">Make static</option>');
    opts.push(l.blocked ? '<option value="unblock">Unblock</option>' : '<option value="block">Block</option>');
    opts.push(l.disabled ? '<option value="enable">Enable</option>' : '<option value="disable">Disable</option>');
    opts.push('<option value="remove">Remove lease</option>');
    return `<div class="row">
      <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${dot};flex:none"></span>
      <div style="flex:1;min-width:0">
        <div><span class="mono">${esc(l.address || '—')}</span> ${tags.join(' ')}</div>
        <div class="small mono sec-muted">${esc(l.mac || '')}${l.host ? ' · ' + esc(l.host) : ''}${l.expires ? ' · expires ' + esc(l.expires) : ''}</div></div>
      <select style="width:auto" onchange="leaseAction(${idx}, this)">${opts.join('')}</select></div>`;
  }).join('');
}
async function leaseAction(idx, sel) {
  const action = sel.value; if (!action) return;
  const l = (window._leases || [])[idx]; if (!l) { sel.value = ''; return; }
  if (action === 'remove' && !confirm('Remove this DHCP lease?\n' + (l.address || '') + ' ' + (l.mac || ''))) { sel.value = ''; return; }
  sel.disabled = true; toast(action.replace('-', ' ') + '…');
  try {
    await api('/devices/' + window._dhcpDevId + '/dhcp-leases/action', { method: 'POST', body: JSON.stringify({ id: l.id, mac: l.mac, dynamic: l.dynamic, action }) });
    toast('Done · ' + action.replace('-', ' '));
    await loadLeases(window._dhcpDevId);
  } catch (e) { toast(e.message); sel.disabled = false; sel.value = ''; }
}
async function renderDeviceWifi(id) {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  const d = await api('/devices/' + id);
  let wifi = null; try { wifi = d.wifi_json ? JSON.parse(d.wifi_json) : null; } catch {}
  const radios = (wifi && wifi.radios) || [];
  view().innerHTML = `
    <div class="crumb" onclick="location.hash='#/device/${id}'"><i class="ti ti-chevron-left"></i> ${esc(d.name)}</div>
    <div class="head"><div class="t"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h1><i class="ti ti-wifi"></i> WiFi</h1></div>
      <div class="small sec-muted" style="margin-top:3px">${esc(d.name)} · ${esc(d.mgmt_address || 'no management IP')}${wifi && wifi.system ? ' · ' + esc(wifi.system) : ''}</div></div>
      <button class="btn" onclick="loadWifiClients(${id})"><i class="ti ti-refresh"></i> Refresh</button></div>

    <div class="card" style="margin-top:14px"><div class="hd"><h2><i class="ti ti-access-point"></i> Networks</h2>
      <button class="btn sm" onclick="manageWifi(${id})"><i class="ti ti-eye"></i> Reveal &amp; edit</button></div>
      <div id="wifiBody">${radios.length ? radios.map(r => `<div class="row"><i class="ti ti-wifi sec-muted"></i>
        <div style="flex:1;min-width:0"><div><span class="mono">${esc(r.ssid || '(no SSID)')}</span> ${r.band ? `<span class="tag">${esc(r.band)}</span>` : ''}${r.disabled ? ' <span class="small muted">(disabled)</span>' : ''}</div>
        <div class="small mono sec-muted">${esc(r.iface)} · password ${r.hasPassword ? '••••••' : '—'}</div></div></div>`).join('') : '<div class="row muted">No WiFi radios found — Poll the device first.</div>'}</div>
      <div class="help" style="padding:8px 14px"><i class="ti ti-lock"></i> Passwords hidden · reveal is logged</div></div>

    <div class="card"><div class="hd"><h2><i class="ti ti-devices"></i> Connected clients</h2></div>
      <div id="wifiClients"><div class="row muted">Loading clients…</div></div>
      <div class="help" style="padding:8px 14px">Live association table · weakest signal first. Guide: <b style="color:var(--success)">≥ −60 dBm</b> good · <b style="color:var(--warning)">−60 to −72</b> fair · <b style="color:var(--danger)">&lt; −72</b> weak.</div></div>`;
  loadWifiClients(id);
}
async function loadWifiClients(id) {
  const body = $('#wifiClients'); if (!body) return;
  body.innerHTML = '<div class="row muted">Reading clients from the router…</div>';
  try {
    const r = await api('/devices/' + id + '/wifi-clients');
    const cs = r.clients || [];
    if (!cs.length) { body.innerHTML = '<div class="row muted">No clients currently associated.</div>'; return; }
    cs.sort((a, b) => (a.signal == null ? 999 : -a.signal) - (b.signal == null ? 999 : -b.signal)); // weakest first
    body.innerHTML = cs.map(c => {
      const dbm = c.signal;
      const q = dbm == null ? 0 : Math.max(0, Math.min(100, Math.round(2 * (dbm + 100))));
      const col = dbm == null ? 'var(--text3)' : (dbm >= -60 ? 'var(--success)' : (dbm >= -72 ? 'var(--warning)' : 'var(--danger)'));
      return `<div class="row">
        <div style="width:58px;flex:none;text-align:center"><div style="font-weight:600;color:${col}">${dbm == null ? '—' : dbm}</div><div class="small sec-muted">dBm</div></div>
        <div style="flex:1;min-width:0">
          <div class="mono">${esc(c.mac || '')}${c.lastIp ? ' · ' + esc(c.lastIp) : ''}</div>
          <div class="small sec-muted">${esc(c.ssid || c.iface || '')}${c.txRate ? ' · tx ' + esc(c.txRate) : ''}${c.rxRate ? ' · rx ' + esc(c.rxRate) : ''}${c.uptime ? ' · up ' + esc(c.uptime) : ''}${c.snr != null ? ' · SNR ' + c.snr : ''}</div>
          <div style="height:5px;border-radius:3px;background:var(--surface2);margin-top:5px;overflow:hidden"><div style="height:100%;width:${q}%;background:${col}"></div></div>
        </div></div>`;
    }).join('');
  } catch (e) { body.innerHTML = '<div class="row muted">' + esc(e.message) + '</div>'; }
}
async function manageWifi(id) {
  const body = $('#wifiBody'); if (!body) return;
  body.innerHTML = '<div class="row muted">Reading WiFi from the router…</div>';
  try {
    const r = await api('/devices/' + id + '/wifi');
    window._wifi = { id, system: r.system, radios: r.radios || [] };
    body.innerHTML = (r.radios || []).map((w, idx) => `<div style="padding:10px 14px;border-top:.5px solid var(--border)">
      <div class="small sec-muted" style="margin-bottom:6px"><span class="mono">${esc(w.iface)}</span>${w.band ? ' · ' + esc(w.band) : ''}${w.disabled ? ' · (disabled)' : ''}</div>
      <div class="grid2">
        <div class="fld" style="margin:0"><label class="fl">SSID (network name)</label><input id="wssid${idx}" value="${esc(w.ssid || '')}"/></div>
        <div class="fld" style="margin:0"><label class="fl">Password</label><input id="wpass${idx}" class="mono" value="${esc(w.password || '')}"/></div>
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="btn sm primary" onclick="saveWifi(${idx})"><i class="ti ti-check"></i> Save to router</button></div></div>`).join('')
      || '<div class="row muted">No WiFi radios found.</div>';
  } catch (e) { body.innerHTML = '<div class="row muted">' + esc(e.message) + '</div>'; }
}
async function saveWifi(idx) {
  const w = ((window._wifi || {}).radios || [])[idx]; if (!w) return;
  const ssid = $('#wssid' + idx).value, password = $('#wpass' + idx).value;
  if (!ssid && !password) { toast('Nothing to change'); return; }
  toast('Saving WiFi to router…');
  try {
    await api('/devices/' + window._wifi.id + '/wifi', { method: 'POST', body: JSON.stringify({
      system: window._wifi.system, id: w.id, iface: w.iface, profile: w.profile, profileId: w.profileId, configRef: w.configRef, ssid, password
    }) });
    toast('WiFi updated · Poll now to confirm');
  } catch (e) { toast(e.message); }
}
async function showWg(id) {
  try {
    const r = await api('/devices/' + id + '/wireguard/config');
    const out = $('#wgout');
    out.innerHTML = `<div style="margin-top:12px">
      <div class="small sec-muted" style="margin-bottom:4px">Device config (<span class="mono">${esc(r.address)}</span>)</div>
      <textarea id="wgcfg" readonly rows="8" style="font-family:var(--mono);font-size:12px"></textarea>
      <div class="small sec-muted" style="margin:8px 0 4px">Add this [Peer] to the hub</div>
      <textarea id="wgpeer" readonly rows="4" style="font-family:var(--mono);font-size:12px"></textarea>
      <button class="btn sm" id="wgdl" style="margin-top:8px"><i class="ti ti-download"></i> Download .conf</button></div>`;
    $('#wgcfg').value = r.config;
    $('#wgpeer').value = r.server_peer;
    $('#wgdl').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([r.config], { type: 'text/plain' }));
      a.download = 'wg-' + id + '.conf'; a.click();
    });
  } catch (e) { toast(e.message); }
}
