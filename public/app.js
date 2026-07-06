// Network Inventory & Management Platform — frontend SPA
let META = null, CURRENT_USER = null;
const $ = (s, r = document) => r.querySelector(s);
const view = () => $('#view');
const isPriv = () => CURRENT_USER && ['noc', 'admin'].includes(CURRENT_USER.role);
const isAdmin = () => CURRENT_USER && CURRENT_USER.role === 'admin';
const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));

// ---------- Theme (auto = follow device, or force light/dark; saved per device) ----------
const THEMES = ['auto', 'light', 'dark'];
function getTheme() { try { const t = localStorage.getItem('theme'); return THEMES.includes(t) ? t : 'auto'; } catch { return 'auto'; } }
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  document.querySelectorAll('#themeSeg button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
}
function setTheme(t) {
  if (!THEMES.includes(t)) t = 'auto';
  try { localStorage.setItem('theme', t); } catch {}
  applyTheme(t);
}

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
  $('#navBatch').style.display = isPriv() ? '' : 'none';
  $('#navAccess').style.display = isPriv() ? '' : 'none';
  $('#navBilling').style.display = isPriv() ? '' : 'none';
  $('#navPackages').style.display = isPriv() ? '' : 'none';
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
window.addEventListener('DOMContentLoaded', () => { applyTheme(getTheme()); init(); });

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
    if (p[0] === 'pop' && p[2] === 'circuit' && p[3] === 'new') { setNav('sites'); return await formPopCircuit({ popId: p[1] }); }
    if (p[0] === 'pop' && p[2] === 'circuit' && p[3]) { setNav('sites'); return await formPopCircuit({ popId: p[1], id: p[3] }); }
    if (p[0] === 'pop') { setNav('sites'); return await renderPop(p[1]); }
    if (p[0] === 'accounts') { setNav('accounts'); return await renderCustomers(); }
    if (p[0] === 'customers') { setNav('customers'); return await renderCustomerList(); }
    if (p[0] === 'account' && p[1] === 'new') { setNav('accounts'); return await formCustomer({}); }
    if (p[0] === 'account' && p[2] === 'edit') { setNav('accounts'); return await formCustomer({ id: p[1] }); }
    if (p[0] === 'account') { setNav('accounts'); return await renderCustomer(p[1]); }
    if (p[0] === 'customer' && p[1] === 'new') { setNav('accounts'); return await formCust(q); }
    if (p[0] === 'customer' && p[2] === 'edit') { setNav('accounts'); return await formCust({ id: p[1] }); }
    if (p[0] === 'customer') { setNav('accounts'); return await renderCust(p[1]); }
    if (p[0] === 'inventory') { setNav('inventory'); return await renderInventory(); }
    if (p[0] === 'device' && p[1] === 'new') { setNav('inventory'); return await formDevice(q); }
    if (p[0] === 'device' && p[2] === 'edit') { setNav('inventory'); return await formDevice({ id: p[1] }); }
    if (p[0] === 'device' && p[2] === 'dhcp') { setNav('inventory'); return await renderDeviceDhcp(p[1]); }
    if (p[0] === 'device' && p[2] === 'wifi') { setNav('inventory'); return await renderDeviceWifi(p[1]); }
    if (p[0] === 'device' && p[2] === 'backups') { setNav('inventory'); return await renderDeviceBackups(p[1]); }
    if (p[0] === 'device') { setNav('inventory'); return await renderDevice(p[1]); }
    if (p[0] === 'billing' && p[1] === 'new') { setNav('billing'); return await formInvoice({}); }
    if (p[0] === 'billing' && p[1] === 'invoice' && p[3] === 'edit') { setNav('billing'); return await formInvoice({ id: p[2] }); }
    if (p[0] === 'billing' && p[1] === 'recurring' && p[2] === 'new') { setNav('billing'); return await formRecurring({}); }
    if (p[0] === 'billing' && p[1] === 'recurring' && p[3] === 'edit') { setNav('billing'); return await formRecurring({ id: p[2] }); }
    if (p[0] === 'billing') { setNav('billing'); return await renderBilling(); }
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
    if (p[0] === 'batch' && p[1]) { setNav('batch'); return await renderBatchJob(p[1]); }
    if (p[0] === 'batch') { setNav('batch'); return await renderBatch(); }
    if (p[0] === 'packages') { setNav('packages'); return await renderPackages(); }
    if (p[0] === 'access' && p[1] === 'new') { setNav('access'); return await formAccessVisit(); }
    if (p[0] === 'access') { setNav('access'); return await renderAccessRequests(); }
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

// ---------- Deletes (confirm → DELETE → navigate) ----------
async function doDelete(path, okMsg, goto) {
  try { await api(path, { method: 'DELETE' }); toast(okMsg); if (typeof goto === 'function') goto(); else location.hash = goto; }
  catch (e) { toast(e.message); }
}
function delSite(id, name) {
  if (confirm(`Delete site "${name}"?\n\nIts connections, notes and access info are removed. Hardware stays in Inventory as unassigned.`))
    doDelete('/sites/' + id, 'Site deleted', '#/sites');
}
function delAccount(id, name) {
  if (confirm(`Delete account "${name}"?\n\nContacts and previous-ISP records go with it. (Blocked while customers or sites still use it.)`))
    doDelete('/accounts/' + id, 'Account deleted', '#/accounts');
}
function delCust(id, name) {
  if (confirm(`Delete customer "${name}"?\n\n(Blocked while it still has sites.)`))
    doDelete('/customers/' + id, 'Customer deleted', '#/customers');
}
function delPop(id, name) {
  if (confirm(`Delete POP "${name}"?\n\n(Blocked while devices or site connections still use it.)`))
    doDelete('/pops/' + id, 'POP deleted', '#/pops');
}
function delDevice(id, name) {
  if (confirm(`Delete device "${name}"?\n\nIts stored credentials, telemetry and backup history are removed. This cannot be undone.`))
    doDelete('/devices/' + id, 'Device deleted', '#/inventory');
}
function delConn(id, siteId) {
  if (confirm('Delete this connection?')) doDelete('/connections/' + id, 'Connection deleted', () => renderSite(siteId));
}
function delSiteNote(id, siteId) {
  if (confirm('Delete this note and its attachments?')) doDelete('/site-notes/' + id, 'Note deleted', () => renderNotes(siteId));
}
function delPopNote(id, popId) {
  if (confirm('Delete this note and its attachments?')) doDelete('/pop-notes/' + id, 'Note deleted', () => renderPopNotes(popId));
}

async function renderSite(id) {
  const s = await api('/sites/' + id);
  const connCards = s.connections.map(c => {
    const ipline = c.ip_type === 'Static' ? `Static · ${esc(c.static_ip || '')}` : `Dynamic · ${esc(c.current_ip || '')}`;
    return `<div class="metric" style="background:var(--surface);border:.5px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span class="small sec-muted">${esc(c.role)} ${c.wan_port ? '· <b>' + (c.role === 'Primary' ? 'WAN1' : 'WAN2') + '</b>' : ''}</span>
        <span style="display:flex;align-items:center;gap:6px">${statusPill(c.status)}${isPriv() ? `<button class="btn sm" onclick="delConn(${c.id}, ${s.id})" title="Delete this connection"><i class="ti ti-trash"></i> Delete</button>` : ''}</span></div>
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
      <div class="small sec-muted" style="margin-top:3px"><span id="custassign"><i class="ti ti-user"></i> ${s.customer ? `<a class="iplink" href="#/customer/${s.customer.id}">${esc(s.customer.name)}</a>` : '<span class="muted">no customer</span>'}${isPriv() ? ` <a class="iplink" style="cursor:pointer" onclick="assignCustomerUI(${s.id}, ${s.customer ? s.customer.id : 'null'})" title="Assign this site to a customer">(${s.customer ? 'change' : 'assign'})</a>` : ''}</span> &nbsp;·&nbsp; <i class="ti ti-building"></i> <a class="iplink" href="#/account/${s.account.id}">${esc(s.account.name)}</a> &nbsp;·&nbsp; <i class="ti ti-map-pin"></i> ${loc(s)}</div>
    </div><a class="btn" href="#/site/${s.id}/edit"><i class="ti ti-edit"></i> Edit</a>${isPriv() ? `<button class="btn" onclick="delSite(${s.id}, ${esc(JSON.stringify(s.name))})" title="Delete this site — hardware becomes unassigned"><i class="ti ti-trash"></i> Delete</button>` : ''}</div>

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
      ${note ? `<div class="note"><div class="av">${initials(note.author)}</div><div style="flex:1"><div class="small"><b>${esc(note.author)}</b> <span class="muted">· ${esc(note.created_at)}</span></div>${note.body ? `<div class="small sec-muted" style="margin-top:2px">${esc(note.body)}</div>` : ''}${attachmentsHtml(note.attachments, false)}</div></div>` : '<div class="row muted">No notes yet</div>'}
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
      ${isPriv() ? `<a class="btn" href="#/pop/${p.id}/edit"><i class="ti ti-edit"></i> Edit</a><button class="btn" onclick="delPop(${p.id}, ${esc(JSON.stringify(p.name))})" title="Delete this POP (blocked while devices or connections use it)"><i class="ti ti-trash"></i> Delete</button>` : ''}</div>
    <div class="grid2" style="margin:16px 0">
      <div class="metric"><div class="l"><i class="ti ti-shield-lock"></i> Management IP</div><div class="mono" style="font-size:15px;font-weight:500">${p.current_mgmt_ip ? `<a class="iplink" href="https://${esc(p.current_mgmt_ip)}" target="_blank">${esc(p.current_mgmt_ip)} <i class="ti ti-external-link" style="font-size:11px"></i></a>` : '—'}</div></div>
      <div class="metric"><div class="l"><i class="ti ti-world"></i> Public IP</div><div class="mono" style="font-size:15px;font-weight:500">${esc(p.current_public_ip || '—')}</div></div>
    </div>
    <div class="card"><div class="hd"><h2><i class="ti ti-route"></i> Upstream / bandwidth · ${p.circuits.length}</h2>${isPriv() ? `<a class="btn sm" href="#/pop/${p.id}/circuit/new"><i class="ti ti-plus"></i> Add circuit</a>` : ''}</div>
      ${p.circuits.length ? p.circuits.map(c => `<div class="row${isPriv() ? ' rowlink' : ''}"${isPriv() ? ` onclick="location.hash='#/pop/${p.id}/circuit/${c.id}'"` : ''}>
        <i class="ti ti-${c.source_type === 'pop' ? 'building-broadcast-tower' : 'building-bank'} sec-muted"></i>
        <div style="flex:1;min-width:0"><div>${esc(c.source_label)}${c.bandwidth ? ' · <b>' + esc(c.bandwidth) + '</b>' : ''}</div>
          <div class="small mono sec-muted">${c.circuit_id ? esc(c.circuit_id) : 'no circuit ID'}${c.notes ? ' · ' + esc(c.notes) : ''}</div></div>
        ${statusPill(c.status)}${isPriv() ? '<i class="ti ti-chevron-right muted"></i>' : ''}</div>`).join('') : '<div class="row muted">No upstream circuits defined — Add circuit to record where this POP gets bandwidth.</div>'}</div>
    <div class="card"><div class="hd"><h2>Hardware · ${p.devices.length}</h2><a class="btn sm" href="#/device/new?pop=${p.id}"><i class="ti ti-plus"></i> Add hardware</a></div>${hw}</div>
    <div class="card"><div class="hd"><h2>Customer sites served</h2></div><div style="padding:0 14px 12px">${served}</div></div>
    <div class="card"><div class="hd"><h2><i class="ti ti-notes"></i> Notes · ${p.notes.length}</h2><a class="btn sm" href="#/pop/${p.id}/notes"><i class="ti ti-arrows-diagonal"></i> Expand</a></div>
      ${p.notes[0] ? `<div class="note"><div class="av">${initials(p.notes[0].author)}</div><div style="flex:1"><div class="small"><b>${esc(p.notes[0].author)}</b> <span class="muted">· ${esc(p.notes[0].created_at)}</span></div>${p.notes[0].body ? `<div class="small sec-muted" style="margin-top:2px">${esc(p.notes[0].body)}</div>` : ''}${attachmentsHtml(p.notes[0].attachments, false)}</div></div>` : '<div class="row muted">No notes yet</div>'}</div>`;
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
    ${n.body ? `<div class="sec-muted" style="margin-top:4px">${esc(n.body)}</div>` : ''}${attachmentsHtml(n.attachments, true)}</div>
    ${isPriv() ? `<button class="btn sm" style="flex:none" onclick="delPopNote(${n.id}, ${id})" title="Delete this note and its attachments"><i class="ti ti-trash"></i> Delete</button>` : ''}</div></div>`).join('');
  view().innerHTML = `<div class="crumb" onclick="location.hash='#/pop/${id}'"><i class="ti ti-chevron-left"></i> ${esc(p.name)}</div>
    <h1>POP notes</h1><div class="small sec-muted" style="margin-bottom:14px">${esc(p.name)}${p.code ? ' · ' + esc(p.code) : ''}</div>
    ${accessCard}
    ${noteComposer('postPopNote', id)}
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
  const body = $('#noteBody').value.trim();
  const files = $('#noteFiles').files;
  if (!body && (!files || !files.length)) { toast('Add a note or attach a file'); return; }
  try {
    const r = await api('/pops/' + id + '/notes', { method: 'POST', body: JSON.stringify({ body }) });
    if (files && files.length) { toast('Uploading attachment(s)…'); await uploadAttachments('pop', id, r.id, files); }
    toast('Note posted'); renderPopNotes(id);
  } catch (e) { toast(e.message); }
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

async function formPopCircuit(q) {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  const pop = await api('/pops/' + q.popId);
  let c = { source_type: 'pop', source_pop_id: '', source_account_id: '', circuit_id: '', bandwidth: '', status: 'Up', notes: '' };
  if (q.id) { const found = (pop.circuits || []).find(x => String(x.id) === String(q.id)); if (found) c = found; }
  const popOpts = (META.pops || []).filter(p => String(p.id) !== String(q.popId)).map(p => ({ v: p.id, l: p.name }));
  const accOpts = (META.accounts || []).map(a => ({ v: a.id, l: a.name }));
  view().innerHTML = `<div class="crumb" onclick="location.hash='#/pop/${q.popId}'"><i class="ti ti-chevron-left"></i> ${esc(pop.name)}</div>
    <h1>${q.id ? 'Edit' : 'Add'} circuit</h1>
    <div class="small sec-muted" style="margin-bottom:14px">Where ${esc(pop.name)} gets its bandwidth</div>
    <div class="card" style="padding:16px;overflow:visible" id="f">
      <div class="fld"><label class="fl">Bandwidth source</label>
        <select name="source_type" onchange="toggleCircSource()">
          <option value="pop" ${c.source_type === 'pop' ? 'selected' : ''}>Other POP site</option>
          <option value="account" ${c.source_type === 'account' ? 'selected' : ''}>Account (carrier)</option>
        </select></div>
      <div class="fld" id="srcpopFld"><label class="fl">Source POP</label><div id="ss-srcpop"></div></div>
      <div class="fld" id="srcacctFld"><label class="fl">Source account</label><div id="ss-srcacct"></div></div>
      <div class="grid2">${field('Circuit / account ID', 'circuit_id', c.circuit_id, { mono: true, ph: 'e.g. COX-123456' })}
      ${field('Bandwidth', 'bandwidth', c.bandwidth, { ph: 'e.g. 1 Gbps' })}</div>
      ${field('Status', 'status', c.status, { type: 'select', options: ['Up', 'Standby', 'Down'] })}
      ${field('Notes', 'notes', c.notes, { type: 'textarea' })}
      <div style="display:flex;gap:10px;justify-content:${q.id ? 'space-between' : 'flex-end'};margin-top:8px">
        ${q.id ? `<button class="btn" style="color:var(--danger)" onclick="delCircuit(${q.popId},${q.id})"><i class="ti ti-trash"></i> Delete</button>` : ''}
        <div style="display:flex;gap:10px"><button class="btn" onclick="history.back()">Cancel</button>
        <button class="btn primary" onclick="saveCircuit(${q.popId},${q.id || 'null'})"><i class="ti ti-check"></i> Save</button></div></div></div>`;
  attachSearch($('#ss-srcpop'), popOpts, 'source_pop_id', c.source_pop_id || '', 'Search POP…');
  attachSearch($('#ss-srcacct'), accOpts, 'source_account_id', c.source_account_id || '', 'Search account…');
  toggleCircSource();
}
function toggleCircSource() {
  const t = $('#f [name="source_type"]').value;
  $('#srcpopFld').style.display = t === 'pop' ? 'block' : 'none';
  $('#srcacctFld').style.display = t === 'account' ? 'block' : 'none';
}
async function saveCircuit(popId, id) {
  const d = collect('#f');
  if (d.source_type === 'pop' && !d.source_pop_id) { toast('Pick a source POP'); return; }
  if (d.source_type === 'account' && !d.source_account_id) { toast('Pick a source account'); return; }
  try {
    if (id) await api('/pops/' + popId + '/circuits/' + id, { method: 'PUT', body: JSON.stringify(d) });
    else await api('/pops/' + popId + '/circuits', { method: 'POST', body: JSON.stringify(d) });
    toast('Saved'); location.hash = '#/pop/' + popId;
  } catch (e) { toast(e.message); }
}
async function delCircuit(popId, id) {
  if (!confirm('Delete this circuit?')) return;
  try { await api('/pops/' + popId + '/circuits/' + id, { method: 'DELETE' }); toast('Deleted'); location.hash = '#/pop/' + popId; } catch (e) { toast(e.message); }
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
    ${n.body ? `<div class="sec-muted" style="margin-top:4px">${esc(n.body)}</div>` : ''}${attachmentsHtml(n.attachments, true)}</div>
    ${isPriv() ? `<button class="btn sm" style="flex:none" onclick="delSiteNote(${n.id}, ${id})" title="Delete this note and its attachments"><i class="ti ti-trash"></i> Delete</button>` : ''}</div></div>`).join('');

  view().innerHTML = `
    <div class="crumb" onclick="location.hash='#/site/${id}'"><i class="ti ti-chevron-left"></i> ${esc(s.name)}</div>
    <h1>Site notes</h1><div class="small sec-muted" style="margin-bottom:14px">${esc(s.name)} · ${esc(s.account.name)}</div>
    ${accessHtml}
    ${noteComposer('postNote', id)}
    ${notes || '<div class="muted">No notes yet</div>'}`;
}
function kv(k, v, secret) {
  const val = secret ? `<span class="mono" style="cursor:pointer;filter:blur(5px)" onclick="this.style.filter='none'">${esc(v)}</span>` : `<span>${v}</span>`;
  return `<div class="kv"><span class="small sec-muted">${esc(k)}</span>${val}</div>`;
}
// ---- note attachments (pictures + PDFs) ----
const ATT_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf';
function fileToDataUrl(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }
async function uploadAttachments(parentType, parentId, noteId, files) {
  for (const f of files) {
    if (f.size > 25 * 1024 * 1024) { toast(f.name + ' is over 25 MB — skipped'); continue; }
    try { const data = await fileToDataUrl(f); await api('/attachments', { method: 'POST', body: JSON.stringify({ parent_type: parentType, parent_id: parentId, note_id: noteId, filename: f.name, mime: f.type, data }) }); }
    catch (e) { toast('Upload failed (' + f.name + '): ' + e.message); }
  }
}
function showPicked(inputId, spanId) { const f = $('#' + inputId).files; const el = $('#' + spanId); el.textContent = f && f.length ? (f.length + ' file' + (f.length > 1 ? 's' : '') + ': ' + Array.from(f).map(x => x.name).join(', ')) : ''; }
function attachmentsHtml(atts, canDelete) {
  if (!atts || !atts.length) return '';
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">` + atts.map(a => {
    const url = '/api/attachments/' + a.id;
    const del = canDelete ? `<i class="ti ti-x" title="Remove" style="position:absolute;top:2px;right:2px;background:var(--surface);border-radius:50%;cursor:pointer;font-size:13px;padding:2px" onclick="event.preventDefault();event.stopPropagation();delAttachment(${a.id})"></i>` : '';
    if ((a.mime || '').startsWith('image/')) return `<a href="${url}" target="_blank" style="position:relative;display:inline-block"><img src="${url}" loading="lazy" style="height:90px;width:90px;object-fit:cover;border-radius:8px;border:.5px solid var(--border)"/>${del}</a>`;
    return `<a href="${url}" target="_blank" class="tag" style="position:relative;display:inline-flex;align-items:center;gap:5px;padding:8px 24px 8px 10px"><i class="ti ti-file-type-pdf" style="color:var(--danger)"></i> ${esc(a.filename || 'PDF')}${del}</a>`;
  }).join('') + `</div>`;
}
function noteComposer(postFn, id) {
  return `<div class="box"><textarea id="noteBody" rows="2" placeholder="Add a note…"></textarea>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;gap:8px">
      <label class="btn sm" style="cursor:pointer;flex:none"><i class="ti ti-paperclip"></i> Attach<input type="file" id="noteFiles" accept="${ATT_ACCEPT}" multiple style="display:none" onchange="showPicked('noteFiles','pickedFiles')"></label>
      <span id="pickedFiles" class="small sec-muted" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
      <button class="btn primary" style="flex:none" onclick="${postFn}(${id})"><i class="ti ti-send"></i> Post note</button></div>
    <div class="help" style="padding:6px 2px 0">Attach pictures (PNG/JPG/GIF/WebP) or PDF · up to 25 MB each</div></div>`;
}
async function delAttachment(id) { if (!confirm('Remove this attachment?')) return; try { await api('/attachments/' + id, { method: 'DELETE' }); toast('Removed'); route(); } catch (e) { toast(e.message); } }
async function postNote(id) {
  const body = $('#noteBody').value.trim();
  const files = $('#noteFiles').files;
  if (!body && (!files || !files.length)) { toast('Add a note or attach a file'); return; }
  try {
    const r = await api('/sites/' + id + '/notes', { method: 'POST', body: JSON.stringify({ body }) });
    if (files && files.length) { toast('Uploading attachment(s)…'); await uploadAttachments('site', id, r.id, files); }
    toast('Note posted'); renderNotes(id);
  } catch (e) { toast(e.message); }
}

// ---------- Customers ----------
async function renderCustomers() {
  const list = await api('/accounts');
  const rows = list.map(a => `<div class="row rowlink" onclick="location.hash='#/account/${a.id}'">
    <div class="av">${initials(a.name)}</div>
    <div style="flex:1;min-width:0"><div>${esc(a.name)}</div><div class="small mono sec-muted">${esc(a.account_number || '')}</div></div>
    <span class="small sec-muted">${a.site_count} site${a.site_count === 1 ? '' : 's'}</span>
    ${statusPill(a.status)}<i class="ti ti-chevron-right muted"></i></div>`).join('');
  view().innerHTML = `<div class="head"><h1 style="flex:1">Accounts</h1>${isPriv() ? '<a class="btn" href="#/account/new"><i class="ti ti-plus"></i> Add account</a>' : ''}</div>
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
  const custs = a.customers.map(c => `<div class="row rowlink" onclick="location.hash='#/customer/${c.id}'">
    <div class="av">${initials(c.name)}</div>
    <div style="flex:1;min-width:0"><div>${esc(c.name)}</div><div class="small sec-muted">${c.site_count} site${c.site_count == 1 ? '' : 's'}</div></div>
    ${statusPill(c.status)}<i class="ti ti-chevron-right muted"></i></div>`).join('');
  const sites = a.sites.map(s => `<div class="row rowlink" onclick="location.hash='#/site/${s.id}'">
    <span class="dot" style="flex:none;background:${pillFor(s.needs_attention ? 'Standby' : 'Up')[1]}"></span>
    <div style="flex:1;min-width:0"><div>${esc(s.name)}</div><div class="small sec-muted">${esc(s.customer_name || '')}</div></div>
    <div class="stat">${statusPill(s.conn_status)}<span class="small mono">${s.device_online}/${s.device_total} online</span></div>
    <i class="ti ti-chevron-right muted"></i></div>`).join('');
  view().innerHTML = `
    <div class="crumb" onclick="location.hash='#/accounts'"><i class="ti ti-chevron-left"></i> Accounts</div>
    <div class="head"><div class="av" style="width:46px;height:46px;border-radius:8px;font-size:16px">${initials(a.name)}</div>
      <div class="t"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h1>${esc(a.name)}</h1>${statusPill(a.status)}</div>
      <div class="small mono sec-muted" style="margin-top:3px">${esc(a.account_number || '')}</div></div>
      ${isPriv() ? `<a class="btn" href="#/account/${a.id}/edit"><i class="ti ti-edit"></i> Edit</a><button class="btn" onclick="delAccount(${a.id}, ${esc(JSON.stringify(a.name))})" title="Delete this account (blocked while customers or sites use it)"><i class="ti ti-trash"></i> Delete</button>` : ''}</div>
    <div class="grid3" style="margin:16px 0">
      <div class="metric"><div class="l">Customers</div><div class="v">${a.customers.length}</div></div>
      <div class="metric"><div class="l">Sites</div><div class="v">${a.sites.length}</div></div>
      <div class="metric"><div class="l">Devices</div><div class="v">${a.device_count}</div></div>
      <div class="metric"><div class="l">Needs attention</div><div class="v" style="color:var(--warning)">${a.needs_attention}</div></div>
    </div>
    ${detCard}
    ${contacts ? `<div class="card"><div class="hd"><h2>Contacts</h2></div><div style="padding:0 14px 10px">${contacts}</div></div>` : ''}
    ${prev ? `<div class="card"><div class="hd"><h2><i class="ti ti-history-toggle"></i> Previous ISP</h2></div><div style="padding:0 14px 10px">${prev}</div></div>` : ''}
    <div class="card"><div class="hd"><h2>Customers · ${a.customers.length}</h2>${isPriv() ? `<a class="btn sm" href="#/customer/new?account=${a.id}"><i class="ti ti-plus"></i> Add customer</a>` : ''}</div>${custs || '<div class="row muted">No customers yet</div>'}</div>
    ${a.sites.length ? `<div class="card"><div class="hd"><h2>All sites · ${a.sites.length}</h2></div>${sites}</div>` : ''}`;
}

// ---------- Customers (end clients; served by one or more accounts) ----------
async function renderCustomerList() {
  const list = await api('/customers');
  const rows = list.map(c => `<div class="row rowlink" onclick="location.hash='#/customer/${c.id}'">
    <div class="av">${initials(c.name)}</div>
    <div style="flex:1;min-width:0"><div>${esc(c.name)}</div><div class="small sec-muted">${esc(c.account_names || 'no account')}</div></div>
    <span class="small sec-muted">${c.site_count} site${c.site_count == 1 ? '' : 's'}</span>
    ${statusPill(c.status)}<i class="ti ti-chevron-right muted"></i></div>`).join('');
  view().innerHTML = `<div class="head"><h1 style="flex:1">Customers</h1>${isPriv() ? '<a class="btn" href="#/customer/new"><i class="ti ti-plus"></i> Add customer</a>' : ''}</div>
    <div class="small sec-muted" style="margin:-6px 0 14px">End clients. A customer can be served by one or more accounts.</div>
    <div class="card">${rows || '<div class="row muted">No customers yet</div>'}</div>`;
}
async function renderCust(id) {
  const c = await api('/customers/' + id);
  let bill = null;
  if (isPriv()) { try { bill = await api('/customers/' + id + '/billing'); } catch {} }
  const sites = c.sites.map(s => `<div class="row rowlink" onclick="location.hash='#/site/${s.id}'">
    <span class="dot" style="flex:none;background:${pillFor(s.needs_attention ? 'Standby' : 'Up')[1]}"></span>
    <div style="flex:1;min-width:0"><div>${esc(s.name)}</div><div class="small mono sec-muted">mgmt ${esc(s.current_mgmt_ip || '—')} · pub ${esc(s.current_public_ip || '—')}</div></div>
    <div class="stat">${statusPill(s.conn_status)}<span class="small mono">${s.device_online}/${s.device_total} online</span></div>
    <i class="ti ti-chevron-right muted"></i></div>`).join('');
  const acctLinks = (c.accounts || []).map(a => `<a class="tag" href="#/account/${a.id}" style="margin:0 4px 0 0">${esc(a.name)}</a>`).join('') || '<span class="muted small">no accounts</span>';
  view().innerHTML = `
    <div class="crumb" onclick="location.hash='#/accounts'"><i class="ti ti-chevron-left"></i> Accounts</div>
    <div class="head"><div class="av" style="width:46px;height:46px;border-radius:8px;font-size:16px">${initials(c.name)}</div>
      <div class="t"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h1>${esc(c.name)}</h1>${statusPill(c.status)}</div>
      <div class="small sec-muted" style="margin-top:5px">Served by: ${acctLinks}</div></div>
      ${isPriv() ? `<a class="btn" href="#/customer/${c.id}/edit"><i class="ti ti-edit"></i> Edit</a><button class="btn" onclick="delCust(${c.id}, ${esc(JSON.stringify(c.name))})" title="Delete this customer (blocked while it has sites)"><i class="ti ti-trash"></i> Delete</button>` : ''}</div>
    <div class="grid3" style="margin:16px 0">
      <div class="metric"><div class="l">Sites</div><div class="v">${c.sites.length}</div></div>
      <div class="metric"><div class="l">Devices</div><div class="v">${c.device_count}</div></div>
      <div class="metric"><div class="l">Needs attention</div><div class="v" style="color:var(--warning)">${c.needs_attention}</div></div>
    </div>
    ${c.notes ? `<div class="card" style="padding:12px 14px"><div class="small sec-muted">${esc(c.notes)}</div></div>` : ''}
    ${bill && bill.any ? `<div class="card"><div class="hd"><h2><i class="ti ti-file-invoice"></i> Billing</h2>
      <div style="display:flex;align-items:center;gap:10px">${bill.outstanding > 0 ? `<span class="mono" style="color:var(--warning)">${fmtMoney(bill.outstanding)} outstanding</span>` : '<span class="pill s-up">Settled</span>'}<a class="btn sm" href="#/billing">All billing</a></div></div>
      ${bill.invoices.map(i => `<div class="row"><i class="ti ti-file-invoice sec-muted"></i>
        <div style="flex:1;min-width:0"><div><b>${esc(i.number)}</b></div><div class="small sec-muted">${esc(i.date)}${i.due_date ? ' · due ' + esc(i.due_date) : ''}</div></div>
        <span class="mono">${fmtMoney(i.total)}</span>${invPill(i)}</div>`).join('')}</div>` : ''}
    <div class="card"><div class="hd"><h2>Sites · ${c.sites.length}</h2><div style="display:flex;gap:8px">
      ${isPriv() ? `<button class="btn sm" onclick="attachSiteUI(${c.id})" title="Move an existing site to this customer"><i class="ti ti-link"></i> Attach existing site</button>` : ''}
      <a class="btn sm" href="#/site/new?customer=${c.id}"><i class="ti ti-plus"></i> Add site</a></div></div>
      <div id="attachsite"></div>${sites || '<div class="row muted">No sites yet — attach an existing site or add a new one</div>'}</div>`;
}
// Inline pickers: assign a site to a customer (from either end)
async function assignCustomerUI(siteId, currentId) {
  const custs = await api('/customers');
  if (!custs.length) { toast('No customers yet — create one first'); return; }
  $('#custassign').innerHTML = `<select id="custsel" style="width:auto;display:inline-block;padding:4px 8px">${custs.map(c => `<option value="${c.id}" ${c.id === currentId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <button class="btn sm" onclick="saveAssignCustomer(${siteId})"><i class="ti ti-check"></i> Save</button>
    <button class="btn sm" onclick="renderSite(${siteId})">Cancel</button>`;
}
async function saveAssignCustomer(siteId) {
  try {
    await api('/sites/' + siteId, { method: 'PUT', body: JSON.stringify({ customer_id: Number($('#custsel').value) }) });
    toast('Customer assigned'); renderSite(siteId);
  } catch (e) { toast(e.message); }
}
async function attachSiteUI(custId) {
  const sites = await api('/sites');
  const others = sites.filter(s => s.customer_id !== custId);
  if (!others.length) { toast('Every site already belongs to this customer'); return; }
  $('#attachsite').innerHTML = `<div class="row" style="gap:8px">
    <select id="attachsel" style="flex:1">${others.map(s => `<option value="${s.id}">${esc(s.name)}${s.customer_name ? ' — currently ' + esc(s.customer_name) : ' — no customer'}</option>`).join('')}</select>
    <button class="btn sm primary" onclick="saveAttachSite(${custId})"><i class="ti ti-check"></i> Attach</button>
    <button class="btn sm" onclick="this.closest('#attachsite').innerHTML=''">Cancel</button></div>`;
}
async function saveAttachSite(custId) {
  try {
    await api('/sites/' + $('#attachsel').value, { method: 'PUT', body: JSON.stringify({ customer_id: custId }) });
    toast('Site attached'); renderCust(custId);
  } catch (e) { toast(e.message); }
}
async function formCust(q) {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  let c = { name: '', status: 'Active', notes: '', accounts: [] };
  if (q.id) c = await api('/customers/' + q.id);
  window._custAcctSel = new Set((c.accounts || []).map(a => a.id));
  if (q.account) window._custAcctSel.add(Number(q.account));
  window._custAccts = META.accounts;
  view().innerHTML = `<div class="crumb" onclick="history.back()"><i class="ti ti-chevron-left"></i> Back</div>
    <h1>${q.id ? 'Edit' : 'Add'} customer</h1>
    <div class="card" style="margin-top:14px;padding:16px;overflow:visible" id="f">
      ${field('Customer name', 'name', c.name, { ph: 'e.g. Unit 1072 / Acme West' })}
      <div class="fld"><label class="fl">Served by accounts</label>
        <input id="acctFilter" placeholder="Filter accounts…" oninput="renderCustAccts()" style="margin-bottom:6px"/>
        <div id="custAccts" style="max-height:200px;overflow:auto;border:.5px solid var(--border);border-radius:8px"></div>
        <div class="help">A customer can be served by more than one account. Pick all that apply.</div></div>
      ${field('Status', 'status', c.status, { type: 'select', options: ['Active', 'Prospect', 'Suspended', 'Closed'] })}
      ${field('Billing email (invoices go here)', 'billing_email', c.billing_email || '', { mono: true, ph: 'billing@customer.com' })}
      ${field('Notes', 'notes', c.notes, { type: 'textarea' })}
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" onclick="history.back()">Cancel</button>
      <button class="btn primary" onclick="saveCust(${q.id || 'null'})"><i class="ti ti-check"></i> Save</button></div></div>`;
  renderCustAccts();
}
function renderCustAccts() {
  const box = $('#custAccts'); if (!box) return;
  const sel = window._custAcctSel, q = ($('#acctFilter').value || '').toLowerCase();
  const items = (window._custAccts || []).filter(a => !q || a.name.toLowerCase().includes(q));
  box.innerHTML = items.map(a => `<label class="row" style="cursor:pointer">
    <input type="checkbox" ${sel.has(a.id) ? 'checked' : ''} onchange="toggleCustAcct(${a.id},this.checked)" style="width:auto"/>
    <div style="flex:1;min-width:0">${esc(a.name)}</div></label>`).join('') || '<div class="row muted">No matching accounts</div>';
}
function toggleCustAcct(id, on) { if (on) window._custAcctSel.add(id); else window._custAcctSel.delete(id); }
async function saveCust(id) {
  const d = collect('#f');
  d.account_ids = Array.from(window._custAcctSel || []);
  if (!d.account_ids.length) { toast('Pick at least one account'); return; }
  if (!d.name) { toast('Enter a customer name'); return; }
  try {
    if (id) { await api('/customers/' + id, { method: 'PUT', body: JSON.stringify(d) }); location.hash = '#/customer/' + id; }
    else { const r = await api('/customers', { method: 'POST', body: JSON.stringify(d) }); location.hash = '#/customer/' + r.id; }
    toast('Saved');
  } catch (e) { toast(e.message); }
}

// ---------- Inventory ----------
async function renderInventory() {
  const devs = await api('/devices');
  let pending = []; if (isPriv()) { try { pending = await api('/enrollments'); } catch {} }
  const pendCard = pending.length ? `<div class="card" style="margin-top:14px;border:1px solid var(--info)">
    <div class="hd"><h2><i class="ti ti-sparkles" style="color:var(--info)"></i> Pending enrollments · ${pending.length}</h2></div>
    ${pending.map(d => `<div class="row">
      <i class="ti ti-router sec-muted"></i>
      <div style="flex:1;min-width:0"><div>${esc(d.name)} ${d.manufacturer || d.model ? `· ${esc(d.manufacturer || '')} ${esc(d.model || '')}` : ''}</div>
        <div class="small mono sec-muted">SN ${esc(d.serial || '—')}${d.mac ? ' · ' + esc(d.mac) : ''} · enrolled ${esc(d.enrolled_at || '')}</div></div>
      <a class="btn sm" href="#/device/${d.id}/edit"><i class="ti ti-settings"></i> Set up</a>
      <button class="btn sm" onclick="clearEnroll(${d.id})" title="Remove from this pending list (device stays in inventory)"><i class="ti ti-check"></i> Mark set up</button></div>`).join('')}
    <div class="help" style="padding:8px 14px">Auto-enrolled from the provisioning bench. Assign each to a site/POP and set its details; assigning (or clicking ✓) clears it from this list.</div></div>` : '';
  const rows = devs.map(d => `<div class="row rowlink" onclick="location.hash='#/device/${d.id}'">
    <i class="ti ti-${iconFor(d.device_type)} sec-muted"></i>
    <div style="flex:1;min-width:0"><div>${esc(d.name)} · ${esc(d.manufacturer || '')} ${esc(d.model || '')} ${d.enroll_pending ? '<span class="tag" style="background:var(--info-bg);color:var(--info)">new</span>' : ''}</div>
      <div class="small sec-muted">${esc(d.management_mode === 'provider' ? 'Provider-managed' : 'Platform-managed')} · owned by ${esc(d.ownership)}</div></div>
    <span class="tag">${esc(d.status)}</span>${statusPill(d.online ? 'Online' : 'Offline')}<i class="ti ti-chevron-right muted"></i></div>`).join('');
  view().innerHTML = `<div class="head"><h1 style="flex:1">Inventory</h1><a class="btn" href="#/device/new"><i class="ti ti-plus"></i> Add hardware</a></div>
    ${pendCard}
    <div class="card" style="margin-top:14px">${rows || '<div class="row muted">No devices</div>'}</div>`;
}
async function clearEnroll(id) {
  try { await api('/devices/' + id + '/enroll-clear', { method: 'POST' }); toast('Marked set up'); renderInventory(); } catch (e) { toast(e.message); }
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
    <div class="card"><div class="hd"><h2><i class="ti ti-plug"></i> Ports / interfaces${ifaces.length ? ` · ${ifaces.length}` : ''} <span class="small muted" style="font-weight:400">· tap to graph</span></h2>${isPriv() ? `<button class="btn sm" onclick="pollDevice(${d.id})" title="Contact the router and refresh its live ports, IPs and version info"><i class="ti ti-refresh"></i> Poll now</button>` : ''}</div>
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
            ? `<button class="btn sm" onclick="showWg(${d.id})" title="Show/download this device's WireGuard config (contains its private key — logged)"><i class="ti ti-shield-lock"></i> WireGuard config</button><button class="btn sm" onclick="provisionWg(${d.id})" title="Keep or re-assign this device's WireGuard key and management IP"><i class="ti ti-refresh"></i> Re-provision</button>`
            : `<button class="btn sm" onclick="provisionWg(${d.id})" title="Generate a WireGuard key and assign a free management IP for this device"><i class="ti ti-shield-lock"></i> Provision on WireGuard</button>`}
          ${d.zt_node_id ? `<button class="btn sm" onclick="ztSyncDevice(${d.id})" title="Pull this device's assigned IP from ZeroTier Central"><i class="ti ti-refresh"></i> Sync ZeroTier</button>` : ''}
        </div><div id="wgout"></div>` : '<div class="help">Overlay provisioning is NOC/Admin only.</div>'}
      </div></div>`;

  const dhcpCard = (d.management_mode === 'provider' || !isPriv()) ? '' : `
    <div class="card"><a class="row rowlink" href="#/device/${d.id}/dhcp">
      <i class="ti ti-address-book sec-muted"></i>
      <div style="flex:1;min-width:0"><div>DHCP leases</div><div class="small sec-muted">View and manage live DHCP leases on this router</div></div>
      <i class="ti ti-chevron-right muted"></i></a></div>`;

  const backupCard = (d.management_mode === 'provider' || !isPriv()) ? '' : `
    <div class="card"><a class="row rowlink" href="#/device/${d.id}/backups">
      <i class="ti ti-archive sec-muted"></i>
      <div style="flex:1;min-width:0"><div>Config backups</div><div class="small sec-muted">Weekly auto-backups (kept 6 months) · download or back up now</div></div>
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
      <a class="btn" href="#/device/${d.id}/edit"><i class="ti ti-edit"></i> Edit</a>${isPriv() ? `<button class="btn" onclick="delDevice(${d.id}, ${esc(JSON.stringify(d.name))})" title="Delete this device and its stored credentials/telemetry"><i class="ti ti-trash"></i> Delete</button>` : ''}</div>

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

    ${backupCard}

    ${overlayCard}

    ${visibleCreds.length ? `<div class="card"><div class="hd"><h2><i class="ti ti-key"></i> Credentials</h2><button class="btn sm" onclick="revealCreds(${d.id})" title="Show the masked passwords (each reveal is written to the activity log)"><i class="ti ti-eye"></i> Reveal</button></div><div style="padding:0 14px 10px">${credRows}<div class="help"><i class="ti ti-lock"></i> Masked · reveal is logged${isPriv() ? '' : ' · NOC-only fields hidden for your role'}</div></div></div>` : ''}`;

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
  if (id) { await api('/accounts/' + id, { method: 'PUT', body: JSON.stringify(d) }); location.hash = '#/account/' + id; }
  else { const r = await api('/accounts', { method: 'POST', body: JSON.stringify(d) }); location.hash = '#/account/' + r.id; }
  toast('Saved');
}

async function formSite(q) {
  let s = { name: '', service_address: '', status: 'Active', current_mgmt_ip: '', current_public_ip: '' };
  if (q.id) s = await api('/sites/' + q.id);
  const custs = await api('/customers');
  const custOpts = custs.map(c => ({ v: c.id, l: c.name + (c.account_names ? ' · ' + c.account_names : '') }));
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
      <div class="fld"><label class="fl">Served by account <span class="small sec-muted" style="font-weight:400">· optional, defaults to the customer's primary</span></label><div id="ss-siteacct"></div></div>
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
  attachSearch($('#ss-siteacct'), accOpts, 'site_account_id', (s.account && s.account.id) || '', 'Search account…');
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
    try { const c = await api('/customers', { method: 'POST', body: JSON.stringify({ account_ids: [accountId], name: d.nc_name }) }); d.customer_id = c.id; }
    catch (e) { toast('Customer: ' + e.message); return; }
  }
  if (!d.customer_id) { toast('Pick a customer'); return; }
  if (!d.name) { toast('Enter a site name'); return; }
  // serving account: new-customer flow already set d.account_id; otherwise use the optional override (server defaults to the customer's primary)
  if (!newCust) d.account_id = d.site_account_id || '';
  if (!d.account_id) delete d.account_id;
  ['nc_name', 'na_name', 'na_account_number', 'na_status', 'site_account_id'].forEach(k => delete d[k]);
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
  const custOpts = (await api('/customers')).map(c => ({ v: c.id, l: c.name + (c.account_names ? ' · ' + c.account_names : '') }));
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
        <div id="destSite" style="display:${d.assigned_type === 'pop' ? 'none' : 'block'}">
          <div style="display:flex;justify-content:space-between;align-items:center"><label class="fl">Client site</label>
            <label class="small sec-muted" style="font-weight:400;cursor:pointer"><input type="checkbox" id="newSite" onchange="toggleNewSite()" style="width:auto"> New site</label></div>
          <div id="ss-site"></div>
          <div id="newSiteBox" style="display:none;margin-top:8px;padding:12px;border:.5px solid var(--border);border-radius:8px;background:var(--surface)">
            ${field('Site name', 'ns_name', '', { ph: 'e.g. Riverside Office' })}
            <div class="fld"><label class="fl">Customer</label><div id="ss-newcust"></div></div>
          </div>
        </div>
        <div id="destPop" style="display:${d.assigned_type === 'pop' ? 'block' : 'none'}"><label class="fl">POP site</label><div id="ss-pop"></div></div>
      </div>

      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" onclick="history.back()">Cancel</button>
      <button class="btn primary" onclick="saveDevice(${q.id || 'null'})"><i class="ti ti-check"></i> Save</button></div>
    </div>`;
  $('select[name=status]').addEventListener('change', e => { $('#deployBox').style.display = e.target.value === 'Deployed' ? 'block' : 'none'; });
  attachSearch($('#ss-model'), modelOpts, 'model_id', d.model_id, 'Search manufacturer / model…');
  attachSearch($('#ss-site'), siteOpts, 'assigned_site_id', d.assigned_site_id, 'Search client site…');
  attachSearch($('#ss-pop'), popOpts, 'assigned_pop_id', d.assigned_pop_id, 'Search POP…');
  attachSearch($('#ss-newcust'), custOpts, 'ns_customer_id', '', 'Search customer…');
}
function toggleNewSite() {
  const on = $('#newSite').checked;
  $('#newSiteBox').style.display = on ? 'block' : 'none';
  $('#ss-site').style.display = on ? 'none' : 'block';
}
function setMM(m) { $('input[name=management_mode]').value = m; $('#mm-plat').classList.toggle('on', m === 'platform'); $('#mm-prov').classList.toggle('on', m === 'provider'); $('#provExtra').style.display = m === 'provider' ? 'block' : 'none'; $('#platExtra').style.display = m === 'provider' ? 'none' : 'block'; }
function setOwn(o) { $('input[name=ownership]').value = o; ['us', 'carrier', 'distributor'].forEach(x => $('#ow-' + x).classList.toggle('on', x === o)); }
function setOv(o) { $('input[name=mgmt_overlay]').value = o; ['WireGuard', 'ZeroTier'].forEach(x => $('#ov-' + x).classList.toggle('on', x === o)); }
function setDest(t) { $('input[name=assigned_type]').value = t; $('#dt-site').classList.toggle('on', t === 'site'); $('#dt-pop').classList.toggle('on', t === 'pop'); $('#destSite').style.display = t === 'site' ? 'block' : 'none'; $('#destPop').style.display = t === 'pop' ? 'block' : 'none'; }
async function saveDevice(id) {
  const d = collect('#f');
  d.online = 1;
  if (!d.name) { toast('Enter a device name'); return; }
  // Inline "New site": create the site (under a customer) first, then assign this device to it
  const newSite = $('#newSite') && $('#newSite').checked;
  if (d.status === 'Deployed' && d.assigned_type === 'site' && newSite) {
    if (!d.ns_name) { toast('Enter the new site name'); return; }
    if (!d.ns_customer_id) { toast('Pick a customer for the new site'); return; }
    try { const s = await api('/sites', { method: 'POST', body: JSON.stringify({ name: d.ns_name, customer_id: d.ns_customer_id }) }); d.assigned_site_id = s.id; }
    catch (e) { toast('Site: ' + e.message); return; }
  }
  delete d.ns_name; delete d.ns_customer_id;
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
    <a class="btn sm" href="#/users/${u.id}/edit" title="Edit name, role, password or active status"><i class="ti ti-edit"></i> Edit</a>
    ${u.id === CURRENT_USER.id ? '' : `<button class="btn sm" onclick="delUser(${u.id})" title="Delete this user"><i class="ti ti-trash"></i> Delete</button>`}
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
    <a class="btn sm" href="#/models/${m.id}/edit" title="Edit this model's details"><i class="ti ti-edit"></i> Edit</a>
    <button class="btn sm" onclick="delModel(${m.id})" title="Delete this model"><i class="ti ti-trash"></i> Delete</button></div>`).join('');
  view().innerHTML = `<div class="head"><h1 style="flex:1">Models</h1><a class="btn" href="#/models/new"><i class="ti ti-plus"></i> Add model</a></div>
    <input id="mfilter" placeholder="Filter ${models.length} models — try 'hAP', 'USW', 'LTU'…" style="margin-top:12px"/>
    <div class="card" id="mlist" style="margin-top:12px">${rows || '<div class="row muted">No models yet</div>'}</div>
    <div class="help">The hardware catalog — what shows up in the Model picker when adding devices. NOC/Admin only.</div>`;
  $('#mfilter').addEventListener('input', () => {
    const q = $('#mfilter').value.trim().toLowerCase();
    for (const r of document.querySelectorAll('#mlist .row')) r.style.display = (!q || r.textContent.toLowerCase().includes(q)) ? '' : 'none';
  });
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

// ---------- Batch config (fleet-wide changes) ----------
async function renderBatch() {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  const [targets, jobs] = await Promise.all([api('/batch/targets'), api('/batch')]);
  window._batchTargets = targets; window._batchSel = new Set();
  const jobRows = jobs.map(j => `<div class="row rowlink" onclick="location.hash='#/batch/${j.id}'">
    <i class="ti ti-${j.fail ? 'alert-triangle' : 'circle-check'}" style="color:${j.fail ? 'var(--warning)' : 'var(--success)'}"></i>
    <div style="flex:1;min-width:0"><div>${esc(j.summary || j.op)}</div><div class="small sec-muted">${esc(j.created_at)} · ${esc(j.actor || '')}</div></div>
    <span class="small mono"><span style="color:var(--success)">${j.ok}✓</span>${j.fail ? ' · <span style="color:var(--danger)">' + j.fail + '✗</span>' : ''} / ${j.total}</span>
    <i class="ti ti-chevron-right muted"></i></div>`).join('');
  view().innerHTML = `<div class="head"><h1 style="flex:1">Batch config</h1></div>
    <div class="small sec-muted" style="margin:-6px 0 14px">Push a change to many MikroTik routers at once · runs over the management overlay.</div>
    <div class="card" style="padding:16px;overflow:visible" id="f">
      <div class="fld"><label class="fl">Operation</label>
        <select name="op" onchange="batchOpChange()">
          <option value="change-password">Change user password</option>
          <option value="add-user">Add user account</option>
          <option value="remove-user">Remove user account</option>
          <option value="set-wifi">Set WiFi (SSID / password)</option>
          <option value="add-firewall">Add firewall rule</option>
          <option value="update-packages">Update packages (RouterOS)</option>
          <option value="update-firmware">Update RouterBOOT firmware</option>
        </select></div>
      <div id="opFields"></div>
      <div class="hd" style="padding:8px 0 4px"><h2>Target routers</h2>
        <div style="display:flex;gap:8px"><input id="tfilter" placeholder="Filter…" oninput="renderTargets()" style="width:130px"/>
        <button class="btn sm" onclick="pollAllTargets()" title="Refresh versions/info from every router"><i class="ti ti-refresh"></i> Poll all</button>
        <button class="btn sm" onclick="selAllTargets(true)">Select all</button><button class="btn sm" onclick="selAllTargets(false)">None</button></div></div>
      <div id="targetList" style="max-height:320px;overflow:auto;border:.5px solid var(--border);border-radius:8px"></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px">
        <span class="small sec-muted" id="selCount"></span>
        <button class="btn primary" onclick="runBatchOp()" title="Apply this operation to every selected router now"><i class="ti ti-player-play"></i> Run on selected</button></div>
    </div>
    <div id="batchResults"></div>
    <div class="hd" style="margin-top:18px"><h2>Recent batch jobs</h2></div>
    <div class="card">${jobRows || '<div class="row muted">No batch jobs yet</div>'}</div>`;
  batchOpChange(); renderTargets();
}
function batchOpChange() {
  const op = $('#f [name=op]').value, F = $('#opFields'); if (!F) return;
  if (op === 'add-user') F.innerHTML = `<div class="grid2">${field('Username', 'name', '', { mono: true })}${field('Password', 'password', '', { mono: true })}</div>${field('Group', 'group', 'full', { type: 'select', options: ['full', 'write', 'read'] })}`;
  else if (op === 'change-password') F.innerHTML = `<div class="grid2">${field('Username', 'name', '', { mono: true, ph: 'e.g. admin' })}${field('New password', 'password', '', { mono: true })}</div>`;
  else if (op === 'remove-user') F.innerHTML = `${field('Username', 'name', '', { mono: true, ph: 'user to remove' })}<div class="help">Each router's own admin user is protected and will be skipped. Removing a user that isn't present is treated as success.</div>`;
  else if (op === 'set-wifi') F.innerHTML = `<div class="grid2">${field('New SSID', 'ssid', '', { ph: 'leave blank to keep' })}${field('New WiFi password', 'password', '', { mono: true, ph: 'leave blank to keep' })}</div><div class="help">Applies to all WiFi radios on each router (e.g. 2.4 &amp; 5 GHz). Leave a field blank to leave it unchanged.</div>`;
  else if (op === 'add-firewall') F.innerHTML = `<div class="grid2">${field('Chain', 'chain', 'input', { type: 'select', options: ['input', 'forward', 'output'] })}${field('Action', 'action', 'drop', { type: 'select', options: ['accept', 'drop', 'reject'] })}</div>
    <div class="grid2">${field('Protocol', 'protocol', 'any', { type: 'select', options: ['any', 'tcp', 'udp', 'icmp'] })}${field('Dst. port', 'dst_port', '', { mono: true, ph: 'e.g. 23 or 8291' })}</div>
    <div class="grid2">${field('Src. address', 'src_address', '', { mono: true, ph: 'e.g. 203.0.113.0/24' })}${field('Dst. address', 'dst_address', '', { mono: true })}</div>
    <div class="grid2">${field('In-interface', 'in_interface', '', { mono: true, ph: 'optional, e.g. ether1' })}${field('Comment', 'comment', 'netinv batch')}</div>
    <div class="help">Rule is appended to the chain. Order matters in RouterOS — put specific drops above any broad accept. Use a comment so you can find/manage it later.</div>`;
  else if (op === 'update-packages') F.innerHTML = `${field('Channel', 'channel', '', { type: 'select', options: ['', 'stable', 'long-term', 'testing'] })}
    <div class="help" style="color:var(--warning)"><i class="ti ti-alert-triangle"></i> Checks MikroTik for updates and, if a newer version exists, downloads it and <b>reboots</b> each selected router. Leave channel blank to keep each router's current channel. Routers need internet access.</div>`;
  else if (op === 'update-firmware') F.innerHTML = `<div class="help" style="color:var(--warning)"><i class="ti ti-alert-triangle"></i> Upgrades the RouterBOOT firmware to match the installed RouterOS and <b>reboots</b> each selected router to apply. Do this after a packages update.</div>`;
}
function batchVisible() { const q = ($('#tfilter').value || '').toLowerCase(); return (window._batchTargets || []).filter(t => !q || (t.name || '').toLowerCase().includes(q) || (t.group || '').toLowerCase().includes(q)); }
function renderTargets() {
  const list = $('#targetList'); if (!list) return;
  const sel = window._batchSel || (window._batchSel = new Set());
  const items = batchVisible();
  list.innerHTML = items.map(t => {
    const ver = t.ros_version ? `<span class="tag" title="RouterOS version">v${esc(String(t.ros_version).split(' ')[0])}</span>` : '<span class="small muted">v?</span>';
    const fw = t.fw_needs_update ? `<span class="tag" style="background:rgba(245,166,35,.16);color:var(--warning)" title="RouterBOOT ${esc(t.fw_version)} → ${esc(t.fw_upgrade)}">FW↑ ${esc(t.fw_upgrade)}</span>` : (t.fw_version ? `<span class="small sec-muted" title="RouterBOOT firmware">FW ${esc(t.fw_version)}</span>` : '');
    return `<label class="row" style="cursor:${t.eligible ? 'pointer' : 'not-allowed'};opacity:${t.eligible ? 1 : .5}">
    <input type="checkbox" ${sel.has(t.id) ? 'checked' : ''} ${t.eligible ? '' : 'disabled'} onchange="toggleTarget(${t.id},this.checked)" style="width:auto"/>
    <div style="flex:1;min-width:0"><div>${esc(t.name)} ${ver} ${fw}</div><div class="small mono sec-muted">${esc(t.group || '')}${t.mgmt_address ? ' · ' + esc(t.mgmt_address) : ''}${t.eligible ? '' : ' · ' + esc(t.reason)}${t.last_polled ? ' · polled ' + esc(t.last_polled) : ' · never polled'}</div></div></label>`;
  }).join('') || '<div class="row muted">No matching devices</div>';
  updateSelCount();
}
function toggleTarget(id, on) { const sel = window._batchSel; if (on) sel.add(id); else sel.delete(id); updateSelCount(); }
async function pollAllTargets() {
  toast('Polling all routers… this can take a moment');
  try {
    const r = await api('/devices/poll-all', { method: 'POST' });
    window._batchTargets = await api('/batch/targets'); // refresh versions
    renderTargets();
    toast(`Polled ${r.ok}/${r.total} router(s)${r.fail ? ' · ' + r.fail + ' unreachable' : ''}`);
  } catch (e) { toast(e.message); }
}
function selAllTargets(on) { const sel = window._batchSel = new Set(); if (on) for (const t of batchVisible()) if (t.eligible) sel.add(t.id); renderTargets(); }
function updateSelCount() { const el = $('#selCount'); if (el) el.textContent = (window._batchSel || new Set()).size + ' selected'; }
function batchResultCard(r) {
  const rows = r.results.map(x => `<div class="row"><i class="ti ti-${x.status === 'ok' ? 'circle-check' : 'alert-triangle'}" style="color:${x.status === 'ok' ? 'var(--success)' : 'var(--danger)'}"></i>
    <div style="flex:1;min-width:0"><div>${esc(x.device_name || ('device#' + x.device_id))}</div><div class="small sec-muted">${esc(x.detail || '')}</div></div></div>`).join('');
  return `<div class="card" style="margin-top:14px"><div class="hd"><h2>${esc(r.summary || r.op)}</h2><span class="small mono"><span style="color:var(--success)">${r.ok}✓</span> · <span style="color:var(--danger)">${r.fail}✗</span> / ${r.total}</span></div>${rows}</div>`;
}
const BATCH_LABELS = { 'add-user': 'Add user', 'change-password': 'Change password', 'remove-user': 'Remove user', 'set-wifi': 'Set WiFi', 'add-firewall': 'Add firewall rule', 'update-packages': 'Update packages', 'update-firmware': 'Update RouterBOOT firmware' };
async function runBatchOp() {
  const op = $('#f [name=op]').value;
  const params = collect('#opFields');
  if (params.name) params.name = params.name.trim();
  const ids = Array.from(window._batchSel || []);
  if ((op === 'add-user' || op === 'change-password') && (!params.name || !params.password)) { toast('Enter username and password'); return; }
  if (op === 'remove-user' && !params.name) { toast('Enter a username'); return; }
  if (op === 'set-wifi' && !params.ssid && !params.password) { toast('Enter an SSID and/or password'); return; }
  if (op === 'add-firewall' && (!params.chain || !params.action)) { toast('Pick a chain and action'); return; }
  if (!ids.length) { toast('Select at least one router'); return; }
  const reboots = op === 'update-packages' || op === 'update-firmware';
  const extra = op === 'remove-user' ? ' — this removes the account' : (reboots ? ' — this DOWNLOADS updates and REBOOTS each router' : '');
  if (!confirm(`Run "${BATCH_LABELS[op]}" on ${ids.length} router(s)?${extra}`)) return;
  const out = $('#batchResults'); out.innerHTML = `<div class="card" style="margin-top:14px;padding:14px"><span class="muted">Running on ${ids.length} router(s)…</span></div>`;
  try {
    const r = await api('/batch', { method: 'POST', body: JSON.stringify({ op, params, device_ids: ids }) });
    out.innerHTML = batchResultCard(r);
    toast(`Done · ${r.ok}/${r.total} ok`);
  } catch (e) { out.innerHTML = ''; toast(e.message); }
}
async function renderBatchJob(id) {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  const j = await api('/batch/' + id);
  view().innerHTML = `<div class="crumb" onclick="location.hash='#/batch'"><i class="ti ti-chevron-left"></i> Batch config</div>
    <h1>${esc(j.summary || j.op)}</h1><div class="small sec-muted" style="margin-bottom:14px">${esc(j.created_at)} · ${esc(j.actor || '')}</div>
    ${batchResultCard(j)}`;
}

// ---------- Packages library (RouterOS .npk) ----------
async function renderPackages() {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  const list = await api('/packages');
  const rows = list.map(p => `<div class="row">
    <i class="ti ti-package sec-muted"></i>
    <div style="flex:1;min-width:0"><div>${esc(p.name || p.filename)} ${p.arch ? `<span class="tag">${esc(p.arch)}</span>` : ''}${p.version ? ` <span class="small sec-muted">${esc(p.version)}</span>` : ''}</div>
      <div class="small mono sec-muted">${esc(p.filename)} · ${fmtSize(p.size)}${p.notes ? ' · ' + esc(p.notes) : ''}</div></div>
    <button class="btn sm" onclick="delPackage(${p.id})" title="Delete this package file"><i class="ti ti-trash"></i> Delete</button></div>`).join('');
  view().innerHTML = `<div class="head"><h1 style="flex:1">Packages</h1></div>
    <div class="small sec-muted" style="margin:-6px 0 14px">RouterOS <span class="mono">.npk</span> packages routers can auto-install during zero-touch provisioning.</div>
    <div class="card" style="padding:16px" id="pf">
      <div class="grid2">${field('Package name', 'name', '', { mono: true, ph: 'e.g. wifiwave2 (RouterOS package name)' })}${field('Architecture', 'arch', '', { mono: true, ph: 'e.g. arm, arm64, mipsbe' })}</div>
      <div class="grid2">${field('Version (optional)', 'version', '', { mono: true, ph: 'e.g. 7.15' })}${field('Notes (optional)', 'notes', '')}</div>
      <div class="fld"><label class="fl">.npk file</label>
        <label class="btn sm" style="cursor:pointer;display:inline-flex"><i class="ti ti-upload"></i> Choose .npk<input type="file" id="npkFile" accept=".npk" style="display:none" onchange="document.getElementById('npkName').textContent=this.files[0]?this.files[0].name:''"></label>
        <span id="npkName" class="small sec-muted" style="margin-left:8px"></span></div>
      <div style="display:flex;justify-content:flex-end"><button class="btn primary" onclick="uploadPackage()"><i class="ti ti-check"></i> Upload</button></div>
    </div>
    <div class="card" style="margin-top:14px">${rows || '<div class="row muted">No packages yet — upload a .npk above.</div>'}</div>
    <div class="help">The package <b>name</b> must match the RouterOS package name (it's used to check if the router already has it). Assign packages to a device on its Config backups page.</div>`;
}
async function uploadPackage() {
  const f = $('#npkFile').files[0];
  if (!f) { toast('Choose a .npk file'); return; }
  if (!/\.npk$/i.test(f.name)) { toast('Must be a .npk file'); return; }
  const d = collect('#pf');
  toast('Uploading package…');
  try {
    const data = await fileToDataUrl(f);
    await api('/packages', { method: 'POST', body: JSON.stringify({ filename: f.name, name: d.name, arch: d.arch, version: d.version, notes: d.notes, data }) });
    toast('Uploaded'); renderPackages();
  } catch (e) { toast(e.message); }
}
async function delPackage(id) {
  if (!confirm('Delete this package? It will be unassigned from all devices.')) return;
  try { await api('/packages/' + id, { method: 'DELETE' }); toast('Deleted'); renderPackages(); } catch (e) { toast(e.message); }
}

// ---------- Site Access requests (visitor check-in review) ----------
function accessStatusPill(s) {
  const m = { pending: ['var(--warning)', 'pending'], approved: ['var(--success)', 'approved'], denied: ['var(--danger)', 'denied'] };
  const [col, lbl] = m[s] || m.pending;
  return `<span class="pill" style="border-color:${col}"><span class="dot" style="background:${col}"></span>${lbl}</span>`;
}
async function renderAccessRequests() {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  const list = await api('/access');
  window._accessAll = list;
  const pending = list.filter(r => r.status === 'pending').length;
  const onSite = list.filter(r => r.on_site).length;
  view().innerHTML = `<div class="head"><h1 style="flex:1">Site Access</h1><a class="btn" href="#/access/new"><i class="ti ti-user-plus"></i> Add visitor</a></div>
    <div class="small sec-muted" style="margin:-6px 0 14px">Visitor check-in requests. Public form: <a class="iplink" href="/access" target="_blank">/access</a> — share the link or a QR code.</div>
    <div class="grid2" style="margin-bottom:14px">
      <div class="metric"><div class="l"><i class="ti ti-user-check"></i> On site now</div><div class="v" style="color:var(--success)">${onSite}</div></div>
      <div class="metric"><div class="l">Pending review</div><div class="v" style="color:var(--warning)">${pending}</div></div>
    </div>
    <div class="box"><div style="display:flex;gap:8px;align-items:center"><i class="ti ti-search sec-muted"></i>
      <input id="accessSearch" placeholder="Search a returning visitor by name, email, or phone…" oninput="renderAccessRows()" style="flex:1"/>
      <label class="small sec-muted" style="cursor:pointer;white-space:nowrap"><input type="checkbox" id="accessOnSiteOnly" onchange="renderAccessRows()" style="width:auto"> On site only</label></div></div>
    <div id="visitHist"></div>
    <div class="card" id="accessRows"></div>`;
  renderAccessRows();
}
function accessRow(r) {
  const siteNames = (r.sites || []).map(s => esc(s.name)).join(', ') || '—';
  const contact = [r.email ? `<a class="iplink" href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : '', r.phone ? `<a class="iplink" href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : ''].filter(Boolean).join(' · ');
  const photo = r.has_photo ? `<a href="/api/access/${r.id}/photo" target="_blank" title="View ID"><img src="/api/access/${r.id}/photo" loading="lazy" style="height:54px;width:54px;object-fit:cover;border-radius:8px;border:.5px solid var(--border)"/></a>` : '<span class="small muted" style="width:54px;text-align:center">no ID</span>';
  const onSiteBadge = r.on_site ? `<span class="pill" style="border-color:var(--success)"><span class="dot" style="background:var(--success)"></span>on site</span>` : '';
  const visitLine = r.on_site ? `<div class="small" style="color:var(--success)"><i class="ti ti-login"></i> On site since ${esc(r.checkin_at)}</div>`
    : (r.last_visit && r.last_visit.check_out_at ? `<div class="small sec-muted"><i class="ti ti-logout"></i> Last out ${esc(r.last_visit.check_out_at)}</div>` : '');
  return `<div class="row" style="align-items:flex-start">
    ${photo}
    <div style="flex:1;min-width:0">
      <div>${esc(r.first_name)} ${esc(r.last_name)} ${accessStatusPill(r.status)} ${onSiteBadge}</div>
      <div class="small sec-muted">${contact || 'no contact'}</div>
      <div class="small sec-muted"><i class="ti ti-map-pin"></i> ${siteNames} · <span class="muted">${esc(r.created_at)}</span>${r.reviewed_by ? ' · by ' + esc(r.reviewed_by) : ''}${r.visit_count ? ` · ${r.visit_count} visit${r.visit_count == 1 ? '' : 's'}` : ''}</div>
      ${visitLine}
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
      ${r.on_site
        ? `<button class="btn sm" style="color:var(--warning)" onclick="checkVisit(${r.id},'checkout')"><i class="ti ti-logout"></i> Check out</button>`
        : `<button class="btn sm" style="color:var(--success)" onclick="checkVisit(${r.id},'checkin')"><i class="ti ti-login"></i> Check in</button>`}
      ${r.visit_count ? `<button class="btn sm" onclick="visitHistory(${r.id})" title="Show every past check-in/out for this visitor"><i class="ti ti-history"></i> History</button>` : ''}
      ${r.status !== 'approved' ? `<button class="btn sm" style="color:var(--success)" onclick="setAccess(${r.id},'approved')"><i class="ti ti-check"></i> Approve</button>` : ''}
      ${r.status !== 'denied' ? `<button class="btn sm" style="color:var(--danger)" onclick="setAccess(${r.id},'denied')"><i class="ti ti-x"></i> Deny</button>` : ''}
      <button class="btn sm" onclick="delAccess(${r.id})" title="Delete this visitor record (and ID photo)"><i class="ti ti-trash"></i> Delete</button>
    </div></div>`;
}
function renderAccessRows() {
  const box = $('#accessRows'); if (!box) return;
  const q = ($('#accessSearch') && $('#accessSearch').value || '').toLowerCase().trim();
  const onlyOnSite = $('#accessOnSiteOnly') && $('#accessOnSiteOnly').checked;
  let items = window._accessAll || [];
  if (onlyOnSite) items = items.filter(r => r.on_site);
  if (q) items = items.filter(r => [r.first_name, r.last_name, r.first_name + ' ' + r.last_name, r.email, r.phone].some(v => (v || '').toLowerCase().includes(q)));
  box.innerHTML = items.map(accessRow).join('') || `<div class="row muted">${q || onlyOnSite ? 'No matching visitors' : 'No access requests yet'}</div>`;
}
async function checkVisit(id, action) {
  try { await api('/access/' + id + '/' + action, { method: 'POST' }); toast(action === 'checkin' ? 'Checked in' : 'Checked out'); renderAccessRequests(); } catch (e) { toast(e.message); }
}
async function visitHistory(id) {
  try {
    const v = await api('/access/' + id + '/visits');
    const box = $('#visitHist'); if (!box) return;
    box.innerHTML = `<div class="card" style="margin-bottom:14px;border:1px solid var(--info)"><div class="hd"><h2><i class="ti ti-history"></i> Visit history</h2><button class="btn sm" onclick="document.getElementById('visitHist').innerHTML=''">Close</button></div>
      ${v.map(x => `<div class="row"><i class="ti ti-arrow-right sec-muted"></i><div style="flex:1"><div class="small">In: ${esc(x.check_in_at || '—')} ${x.check_in_by ? '· ' + esc(x.check_in_by) : ''}</div><div class="small sec-muted">Out: ${esc(x.check_out_at || 'still on site')} ${x.check_out_by ? '· ' + esc(x.check_out_by) : ''}</div></div></div>`).join('') || '<div class="row muted">No visits</div>'}</div>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) { toast(e.message); }
}
async function formAccessVisit() {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  window._maPeople = await api('/access');
  window._maSites = []; window._reusePhoto = null; window._maPhoto = null; window._maSiteResults = [];
  view().innerHTML = `<div class="crumb" onclick="location.hash='#/access'"><i class="ti ti-chevron-left"></i> Site Access</div>
    <h1>Add visitor</h1><div class="small sec-muted" style="margin-bottom:14px">Register + check in a visitor without the public form. Look up a returning visitor to reuse their details and ID photo.</div>
    <div class="card" style="padding:16px;overflow:visible" id="f">
      <div class="fld"><label class="fl">Returning visitor? (optional)</label>
        <div style="position:relative"><input id="maReturn" placeholder="Search a previous visitor…" autocomplete="off" oninput="maReturnSearch()"/>
          <div id="maReturnList" class="ss-list" style="display:none"></div></div>
        <div id="maReuseNote" class="help"></div></div>
      <div class="grid2">${field('First name', 'ma_fn', '', {})}${field('Last name', 'ma_ln', '', {})}</div>
      <div class="grid2">${field('Email', 'ma_email', '', { type: 'email' })}${field('Phone', 'ma_phone', '', { type: 'tel' })}</div>
      <div class="fld"><label class="fl">Site(s)</label>
        <div style="position:relative"><input id="maSiteQ" placeholder="Search a site to add…" autocomplete="off" oninput="maSiteSearch()"/>
          <div id="maSiteList" class="ss-list" style="display:none"></div></div>
        <div id="maChips" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"></div></div>
      <div class="fld"><label class="fl">ID photo</label>
        <label class="btn sm" style="cursor:pointer;display:inline-flex"><i class="ti ti-camera"></i> Choose photo / PDF<input type="file" id="maPhoto" accept="image/*,application/pdf,.pdf" style="display:none" onchange="maPhotoPick()"></label>
        <span id="maPhotoName" class="small sec-muted" style="margin-left:8px"></span></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" onclick="history.back()">Cancel</button>
      <button class="btn primary" onclick="saveAccessVisit()"><i class="ti ti-login"></i> Add &amp; check in</button></div></div>`;
}
function maReturnSearch() {
  const q = ($('#maReturn').value || '').toLowerCase().trim(); const box = $('#maReturnList');
  if (!q) { box.style.display = 'none'; return; }
  const m = (window._maPeople || []).filter(p => [p.first_name, p.last_name, p.first_name + ' ' + p.last_name, p.email, p.phone].some(v => (v || '').toLowerCase().includes(q))).slice(0, 8);
  box.innerHTML = m.length ? m.map(p => `<div class="ss-opt" onmousedown="maReturnPick(${p.id})">${esc(p.first_name)} ${esc(p.last_name)}${p.email ? ' · ' + esc(p.email) : ''}${p.has_photo ? ' · 📷' : ''}</div>`).join('') : '<div class="ss-opt muted">No matches</div>';
  box.style.display = 'block';
}
function maReturnPick(id) {
  const p = (window._maPeople || []).find(x => x.id === id); if (!p) return;
  $('#f [name=ma_fn]').value = p.first_name || ''; $('#f [name=ma_ln]').value = p.last_name || '';
  $('#f [name=ma_email]').value = p.email || ''; $('#f [name=ma_phone]').value = p.phone || '';
  window._reusePhoto = p.has_photo ? p.id : null; window._maPhoto = null; $('#maPhotoName').textContent = '';
  window._maSites = (p.sites || []).map(s => ({ id: s.id, name: s.name })); maRenderChips();
  $('#maReturn').value = p.first_name + ' ' + p.last_name; $('#maReturnList').style.display = 'none';
  $('#maReuseNote').innerHTML = p.has_photo ? '<span style="color:var(--success)"><i class="ti ti-photo"></i> Reusing ID photo from their previous visit — no re-scan needed.</span>' : 'No prior ID photo on file — capture one below.';
}
async function maSiteSearch() {
  const q = ($('#maSiteQ').value || '').trim(); const box = $('#maSiteList');
  if (!q) { box.style.display = 'none'; return; }
  try {
    const r = await fetch('/access/sites?q=' + encodeURIComponent(q)); window._maSiteResults = await r.json();
    box.innerHTML = window._maSiteResults.length ? window._maSiteResults.map((s, i) => `<div class="ss-opt" onmousedown="maSiteAdd(${i})">${esc(s.name)}</div>`).join('') : '<div class="ss-opt muted">No matches</div>';
    box.style.display = 'block';
  } catch {}
}
function maSiteAdd(i) { const s = (window._maSiteResults || [])[i]; if (!s) return; if (!window._maSites.find(x => x.id === s.id)) window._maSites.push({ id: s.id, name: s.name }); $('#maSiteQ').value = ''; $('#maSiteList').style.display = 'none'; maRenderChips(); }
function maRenderChips() { $('#maChips').innerHTML = (window._maSites || []).map((s, i) => `<span class="tag">${esc(s.name)} <b style="cursor:pointer" onclick="maRmSite(${i})">✕</b></span>`).join(''); }
function maRmSite(i) { window._maSites.splice(i, 1); maRenderChips(); }
async function maPhotoPick() {
  const f = $('#maPhoto').files[0]; if (!f) return;
  window._reusePhoto = null; $('#maReuseNote').innerHTML = '';
  try { window._maPhoto = await fileToDataUrl(f); $('#maPhotoName').textContent = f.name; } catch { toast('Could not read file'); }
}
async function saveAccessVisit() {
  const d = collect('#f');
  if (!d.ma_fn || !d.ma_ln) { toast('Enter first and last name'); return; }
  const body = { first_name: d.ma_fn, last_name: d.ma_ln, email: d.ma_email, phone: d.ma_phone, site_ids: (window._maSites || []).map(s => s.id) };
  if (window._reusePhoto) body.reuse_photo_from = window._reusePhoto;
  else if (window._maPhoto) body.id_photo = window._maPhoto;
  try { await api('/access/manual', { method: 'POST', body: JSON.stringify(body) }); toast('Added & checked in'); location.hash = '#/access'; } catch (e) { toast(e.message); }
}
async function setAccess(id, status) {
  try { await api('/access/' + id, { method: 'PUT', body: JSON.stringify({ status }) }); toast(status); renderAccessRequests(); } catch (e) { toast(e.message); }
}
async function delAccess(id) {
  if (!confirm('Delete this access request and its ID photo?')) return;
  try { await api('/access/' + id, { method: 'DELETE' }); toast('Deleted'); renderAccessRequests(); } catch (e) { toast(e.message); }
}

// ---------- Settings: management overlays (NOC/Admin) ----------
async function renderSettings() {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  const s = await api('/settings');
  let nodes = []; try { nodes = await api('/nodes'); } catch {}
  view().innerHTML = `<h1>Settings</h1><div class="small sec-muted" style="margin:4px 0 14px">Management network &amp; overlays</div>
    <div class="card" style="padding:16px" id="zt">
      <h2 style="margin-bottom:12px"><i class="ti ti-network"></i> ZeroTier</h2>
      ${field('Network ID', 'zt_network_id', s.zt_network_id, { mono: true, ph: '16-hex network id' })}
      ${field('API token', 'zt_api_token', '', { mono: true, ph: s.has_zt_api_token ? 'unchanged' : 'ZeroTier Central API token' })}
      <div class="help">Used to read members' assigned IPs from ZeroTier Central. Token is NOC/Admin-only and stored server-side.</div>
      <div style="display:flex;gap:10px;margin-top:12px"><button class="btn primary" onclick="saveSettings()"><i class="ti ti-check"></i> Save</button>
      <button class="btn" onclick="ztSync()" title="Pull every linked device's assigned IP from ZeroTier Central into its management IP"><i class="ti ti-refresh"></i> Sync ZeroTier now</button></div>
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
      <button class="btn" onclick="dlHub()" title="Full hub config with all device peers — apply on the VPS (contains the hub private key; download is logged)"><i class="ti ti-download"></i> Download hub wg0.conf</button>
      <button class="btn" onclick="regenWg()" title="Replace the hub keypair — every device's config must then be re-downloaded and re-applied"><i class="ti ti-refresh"></i> Regenerate hub key</button></div>
      <div id="hubout"></div>
    </div>
    <div class="help">After saving the WireGuard subnet, open a device → Management overlay → Provision on WireGuard to assign it a non-overlapping IP and download its config. Apply the device's <span class="mono">[Peer]</span> stanza to your hub.</div>
    <div class="card" style="padding:16px" id="bak">
      <h2 style="margin-bottom:12px"><i class="ti ti-archive"></i> Router backups</h2>
      ${field('Backup upload URL', 'backup_upload_base', s.backup_upload_base, { mono: true, ph: 'http://<server-overlay-ip>:3000' })}
      <div class="help">Optional fallback. The platform pulls config exports from routers via FTP over the overlay; leave this blank unless your routers can only push over HTTP.</div>
      <div style="display:flex;gap:10px;margin-top:12px"><button class="btn primary" onclick="saveSettings()"><i class="ti ti-check"></i> Save</button></div>
    </div>
    <div class="card" style="padding:16px" id="prov">
      <h2 style="margin-bottom:12px"><i class="ti ti-rocket"></i> Zero-touch provisioning</h2>
      ${field('Public server URL', 'public_base_url', s.public_base_url, { mono: true, ph: 'https://management.geekitek.com' })}
      <div class="fld"><label class="fl">Provision token</label>
        <input value="${s.has_provision_token ? '•••••••• (set)' : '(generated on save)'}" readonly style="font-family:var(--mono);background:var(--surface2)"/>
        <div class="help">Shared secret embedded in the phone-home/enroll scripts. Routers present it (with their serial) to enroll and fetch their config.</div></div>
      <label class="row" style="cursor:pointer;padding:6px 0"><input type="checkbox" id="autoEnroll" ${s.allow_auto_enroll ? 'checked' : ''} style="width:auto"/>
        <div style="flex:1"><div>Allow auto-enroll</div><div class="small sec-muted">Newly netinstalled routers that phone home (valid token) get added to inventory automatically.</div></div></label>
      <div class="grid2">${field('Bench WiFi SSID', 'prov_wifi_ssid', s.prov_wifi_ssid, { ph: 'optional, for generic config' })}${field('Bench WiFi password', 'prov_wifi_password', '', { mono: true, ph: s.has_prov_wifi_password ? 'unchanged' : 'optional' })}</div>
      ${field('Generic admin password', 'prov_admin_password', '', { mono: true, ph: s.has_prov_admin_password ? 'unchanged' : 'admin password for fresh units' })}
      <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap"><button class="btn primary" onclick="saveProv()"><i class="ti ti-check"></i> Save</button>
      <button class="btn" onclick="regenProv()" title="Replace the provisioning token — configs already on routers keep the old token and will stop phoning home until re-loaded"><i class="ti ti-refresh"></i> Regenerate token</button></div>
      <div class="help">Set the public URL (reachable from devices' WAN over HTTPS). Per-device default configs are on each device's Config backups page; the provisioning node uses the generic config + these bench WiFi/admin defaults.</div>
    </div>
    <div class="card" style="padding:16px" id="billcfg">
      <h2 style="margin-bottom:12px"><i class="ti ti-file-invoice"></i> Billing &amp; Stripe</h2>
      <div class="grid2">${field('Company name (on invoices/emails)', 'bill_company', s.bill_company, { ph: 'GeekFi WiFi' })}${field('Invoice number prefix', 'bill_prefix', s.bill_prefix, { mono: true })}</div>
      ${field('Next invoice number', 'bill_next', s.bill_next, { mono: true })}
      ${field('Stripe secret key', 'stripe_secret', '', { mono: true, ph: s.has_stripe_secret ? 'unchanged' : 'sk_live_… (Stripe → Developers → API keys)' })}
      ${field('Stripe webhook signing secret', 'stripe_webhook_secret', '', { mono: true, ph: s.has_stripe_webhook_secret ? 'unchanged' : 'whsec_… (add the endpoint first, see below)' })}
      <div class="help">Invoices live in this platform; Stripe only processes card &amp; ACH payments — card data never touches this server. In Stripe → Developers → Webhooks, add endpoint <span class="mono">${esc((s.public_base_url || 'https://your-domain') + '/stripe/webhook')}</span> with events <span class="mono">checkout.session.completed</span>, <span class="mono">checkout.session.async_payment_succeeded</span>, <span class="mono">checkout.session.async_payment_failed</span>, then paste its signing secret above so online payments mark invoices paid automatically.</div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn primary" onclick="saveBillingCfg()"><i class="ti ti-check"></i> Save</button>
        <button class="btn" onclick="testStripe()" title="Verify the secret key against the Stripe API">Test Stripe</button>
        <a class="btn" href="/api/billing/backup" title="Download all invoices, payments, products and schedules as one JSON file"><i class="ti ti-download"></i> Download backup</a>
        <button class="btn" onclick="$('#billRestoreFile').click()" title="Load a billing backup file (replaces current billing data)"><i class="ti ti-upload"></i> Restore backup</button>
        <input type="file" id="billRestoreFile" accept="application/json,.json" style="display:none" onchange="restoreBilling(this)"/>
      </div>
      <div id="billout"></div>
    </div>
    <div class="card" style="padding:16px" id="mail">
      <h2 style="margin-bottom:12px"><i class="ti ti-mail"></i> Email notifications</h2>
      <div class="grid2">${field('SMTP host', 'smtp_host', s.smtp_host, { mono: true, ph: 'smtp.example.com' })}${field('SMTP port', 'smtp_port', s.smtp_port, { mono: true, ph: '587' })}</div>
      <label class="row" style="cursor:pointer;padding:6px 0"><input type="checkbox" id="smtpSecure" ${s.smtp_secure ? 'checked' : ''} style="width:auto"/>
        <div style="flex:1"><div>Use TLS/SSL (port 465)</div><div class="small sec-muted">Leave off for STARTTLS on 587.</div></div></label>
      <div class="grid2">${field('SMTP username', 'smtp_user', s.smtp_user, { mono: true })}${field('SMTP password', 'smtp_pass', '', { mono: true, ph: s.has_smtp_pass ? 'unchanged' : '' })}</div>
      <div class="grid2">${field('From address', 'mail_from', s.mail_from, { mono: true, ph: 'noreply@geekitek.com' })}${field('Access requests → notify', 'access_notify_email', s.access_notify_email, { mono: true, ph: 'access@geekitek.com' })}</div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center"><button class="btn primary" onclick="saveMail()"><i class="ti ti-check"></i> Save</button>
        <input id="mailTestTo" placeholder="test recipient (optional)" style="flex:1;min-width:160px;font-family:var(--mono)"/>
        <button class="btn" onclick="sendTestMail()"><i class="ti ti-send"></i> Send test</button></div>
      <div class="help">New site-access requests email the "notify" address; approving/denying a request emails the requester. Requires a working SMTP server + From address. Save before sending a test.</div>
    </div>
    <div class="card" style="padding:16px" id="accesscfg">
      <h2 style="margin-bottom:12px"><i class="ti ti-id-badge-2"></i> Site access</h2>
      ${field('Auto check-out time (HH:MM, blank = off)', 'auto_checkout_at', s.auto_checkout_at, { mono: true, ph: 'e.g. 18:00' })}
      <div class="help">Any visitor still checked in at this time each day is automatically checked out (uses the server's local time). Manual check-out emails the visitor; auto check-out does not.</div>
      <div style="display:flex;gap:10px;margin-top:12px"><button class="btn primary" onclick="saveAccessCfg()"><i class="ti ti-check"></i> Save</button></div>
    </div>
    <div class="card" style="padding:16px" id="billing">
      <h2 style="margin-bottom:12px"><i class="ti ti-file-invoice"></i> Billing agreements</h2>
      <div class="fld"><label class="fl">Invoice terms / billing agreement</label>
        <textarea name="invoice_terms" rows="6" placeholder="Terms &amp; billing agreement attached to one-time invoices…">${esc(s.invoice_terms || '')}</textarea></div>
      <div class="fld"><label class="fl">Recurring invoice terms / billing agreement</label>
        <textarea name="recurring_invoice_terms" rows="6" placeholder="Terms &amp; billing agreement attached to recurring / subscription invoices…">${esc(s.recurring_invoice_terms || '')}</textarea></div>
      <div class="help">These are attached to the corresponding invoices (one-time vs recurring). Plain text — line breaks are preserved.</div>
      <div style="display:flex;gap:10px;margin-top:12px"><button class="btn primary" onclick="saveBilling()"><i class="ti ti-check"></i> Save</button></div>
    </div>
    <div class="card" style="padding:16px" id="nodes">
      <h2 style="margin-bottom:12px"><i class="ti ti-server-cog"></i> Provisioning nodes (Netinstall benches)</h2>
      ${nodes.map(n => `<div class="row"><i class="ti ti-server-2 sec-muted"></i>
        <div style="flex:1;min-width:0"><div>${esc(n.name)}</div><div class="small sec-muted">${esc(n.location || '')}${n.last_seen ? ' · last seen ' + esc(n.last_seen) : ' · never connected'}</div></div>
        <button class="btn sm" onclick="delNode(${n.id})" title="Delete this provisioning node (its token stops working)"><i class="ti ti-trash"></i> Delete</button></div>`).join('') || '<div class="row muted">No provisioning nodes yet</div>'}
      <div class="box" style="margin-top:10px"><div class="grid2">${field('Node name', 'nodename', '', { ph: 'e.g. Bench-1' })}${field('Location', 'nodeloc', '', { ph: 'optional' })}</div>
        <div style="display:flex;justify-content:flex-end"><button class="btn" onclick="addNode()"><i class="ti ti-plus"></i> Add node</button></div></div>
      <div id="nodeTok"></div>
      <div class="help">Each bench node uses its token to pull packages + the generic config and to enroll devices. The token is shown once when created.</div>
    </div>`;
}
async function saveSettings() {
  const z = collect('#zt'), w = collect('#wg'), bk = collect('#bak');
  const d = Object.assign({}, z, w, bk);
  if (!d.zt_api_token) delete d.zt_api_token; // blank = keep existing
  try { await api('/settings', { method: 'PUT', body: JSON.stringify(d) }); toast('Saved'); renderSettings(); } catch (e) { toast(e.message); }
}
async function saveProv() {
  const d = collect('#prov');
  d.allow_auto_enroll = $('#autoEnroll').checked;
  if (!d.prov_wifi_password) delete d.prov_wifi_password;
  if (!d.prov_admin_password) delete d.prov_admin_password;
  try { await api('/settings', { method: 'PUT', body: JSON.stringify(d) }); toast('Saved'); renderSettings(); } catch (e) { toast(e.message); }
}
async function saveMail() {
  const d = collect('#mail');
  d.smtp_secure = $('#smtpSecure').checked;
  if (!d.smtp_pass) delete d.smtp_pass;
  delete d.mailTestTo;
  try { await api('/settings', { method: 'PUT', body: JSON.stringify(d) }); toast('Saved'); renderSettings(); } catch (e) { toast(e.message); }
}
async function saveAccessCfg() {
  const d = collect('#accesscfg');
  try { await api('/settings', { method: 'PUT', body: JSON.stringify(d) }); toast('Saved'); renderSettings(); } catch (e) { toast(e.message); }
}
async function saveBilling() {
  const d = collect('#billing');
  try { await api('/settings', { method: 'PUT', body: JSON.stringify(d) }); toast('Billing agreements saved'); } catch (e) { toast(e.message); }
}
async function sendTestMail() {
  const to = $('#mailTestTo').value.trim();
  toast('Sending test email…');
  try { const r = await api('/settings/mail-test', { method: 'POST', body: JSON.stringify({ to }) }); toast('Test email sent to ' + r.to); } catch (e) { toast('Email failed: ' + e.message); }
}
async function addNode() {
  const d = collect('#nodes');
  if (!d.nodename) { toast('Enter a node name'); return; }
  try {
    const r = await api('/nodes', { method: 'POST', body: JSON.stringify({ name: d.nodename, location: d.nodeloc }) });
    const box = $('#nodeTok');
    if (box) box.innerHTML = `<div class="box" style="margin-top:10px;border:1px solid var(--info)"><div class="small sec-muted" style="margin-bottom:4px">Node token (copy now — shown once):</div>
      <textarea readonly rows="2" style="font-family:var(--mono);font-size:12px">${esc(r.token)}</textarea></div>`;
    toast('Node added · copy the token now');
  } catch (e) { toast(e.message); }
}
async function delNode(id) {
  if (!confirm('Delete this provisioning node? Its token stops working.')) return;
  try { await api('/nodes/' + id, { method: 'DELETE' }); toast('Deleted'); renderSettings(); } catch (e) { toast(e.message); }
}
async function regenProv() {
  if (!confirm('Regenerate the provision token? You must re-download and re-flash default configs that embed the old token.')) return;
  try { await api('/settings/provision/regenerate', { method: 'POST' }); toast('New token generated'); renderSettings(); } catch (e) { toast(e.message); }
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
    <button class="btn sm" onclick="delBlock(${b.id})" title="Delete this IP from the blocklist"><i class="ti ti-trash"></i> Delete</button></div>`;
  }).join('');
  view().innerHTML = `<div class="head"><h1 style="flex:1">Blocklist</h1>
    <button class="btn" onclick="scanBlock()" title="Read every router's log for failed-login attempts and add the source IPs here"><i class="ti ti-search"></i> Scan logs</button>
    <button class="btn primary" onclick="pushBlock()" title="Sync this blocklist to every managed router's firewall now (also runs automatically)"><i class="ti ti-upload"></i> Push to routers</button></div>
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
      <button class="btn sm" id="hubdl" style="margin-top:8px" title="Contains the hub private key — handle carefully"><i class="ti ti-download"></i> Download wg0.conf</button></div>`;
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
function fmtSize(n) { n = +n || 0; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
async function renderDeviceBackups(id) {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  const d = await api('/devices/' + id);
  const list = await api('/devices/' + id + '/backups');
  const rows = list.map(b => {
    const ok = b.status === 'ok';
    return `<div class="row">
      <i class="ti ti-${ok ? 'file-text sec-muted' : 'alert-triangle'}" ${ok ? '' : 'style="color:var(--danger)"'}></i>
      <div style="flex:1;min-width:0"><div>${esc(b.created_at)} ${b.source ? `<span class="tag">${esc(b.source)}</span>` : ''}</div>
        <div class="small sec-muted">${ok ? (fmtSize(b.size) + ' · ' + (b.format || 'rsc')) : ('Failed · ' + esc(b.error || ''))}</div></div>
      ${ok ? `<a class="btn sm" href="/api/backups/${b.id}/download" title="Download this config export (.rsc)"><i class="ti ti-download"></i> Download</a>` : ''}
      <button class="btn sm" onclick="delBackup(${b.id},${id})" title="Delete this backup file"><i class="ti ti-trash"></i> Delete</button></div>`;
  }).join('');
  view().innerHTML = `
    <div class="crumb" onclick="location.hash='#/device/${id}'"><i class="ti ti-chevron-left"></i> ${esc(d.name)}</div>
    <div class="head"><div class="t"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h1><i class="ti ti-archive"></i> Config backups</h1></div>
      <div class="small sec-muted" style="margin-top:3px">${esc(d.name)} · automatic weekly · kept 6 months</div></div>
      <div style="display:flex;gap:8px"><button class="btn" onclick="diagnoseBackup(${id})" title="Troubleshoot: run each backup step and show the raw router responses"><i class="ti ti-stethoscope"></i> Diagnose</button>
      <button class="btn primary" onclick="backupNow(${id})" title="Export this router's config and save a copy here now"><i class="ti ti-player-record"></i> Back up now</button></div></div>
    <div id="bakDiag"></div>
    <div class="card" style="margin-top:14px">${rows || '<div class="row muted">No backups yet. Weekly backups run automatically — or click Back up now.</div>'}</div>
    <div class="help">RouterOS text export (.rsc). Download to keep offline or to restore on the device. Backups older than 6 months are removed automatically.</div>
    <div class="card" style="margin-top:14px"><div class="hd"><h2><i class="ti ti-rocket"></i> Default config (Netinstall)</h2>
      <a class="btn sm" href="/api/devices/${id}/default-config"><i class="ti ti-download"></i> Download .rsc</a></div>
      <div class="help" style="padding:8px 14px">Load this as the <b>default configuration</b> via Netinstall so it survives the reset button. It sets up users, WiFi, a baseline firewall, and a phone-home script: after a reset the router installs its assigned packages then restores its latest backup automatically (by serial number, over WAN/HTTPS — no overlay needed). Requires Settings → Zero-touch provisioning (public URL + token). ${d.serial ? '' : '<b style="color:var(--warning)">Poll this device first so its serial number is on file — the phone-home matches by serial.</b>'}</div></div>
    <div class="card" style="margin-top:14px"><div class="hd"><h2><i class="ti ti-package"></i> Assigned packages</h2><a class="btn sm" href="#/packages"><i class="ti ti-external-link"></i> Library</a></div>
      <div id="pkgAssign"><div class="row muted">Loading…</div></div></div>`;
  loadDevicePackages(id);
}
async function loadDevicePackages(id) {
  const box = $('#pkgAssign'); if (!box) return;
  try {
    const r = await api('/devices/' + id + '/packages');
    window._devPkgSel = new Set(r.assigned || []); window._devPkgId = id;
    if (!r.available.length) { box.innerHTML = '<div class="row muted">No packages in the library yet — add some under Packages.</div>'; return; }
    box.innerHTML = r.available.map(p => `<label class="row" style="cursor:pointer">
      <input type="checkbox" ${window._devPkgSel.has(p.id) ? 'checked' : ''} onchange="toggleDevPkg(${p.id},this.checked)" style="width:auto"/>
      <div style="flex:1;min-width:0"><div>${esc(p.name || p.filename)} ${p.arch ? `<span class="tag">${esc(p.arch)}</span>` : ''}</div><div class="small mono sec-muted">${esc(p.filename)} · ${fmtSize(p.size)}</div></div></label>`).join('')
      + `<div style="display:flex;justify-content:flex-end;padding:10px 14px"><button class="btn sm primary" onclick="saveDevPkgs()"><i class="ti ti-check"></i> Save assignments</button></div>`;
  } catch (e) { box.innerHTML = '<div class="row muted">' + esc(e.message) + '</div>'; }
}
function toggleDevPkg(id, on) { const s = window._devPkgSel; if (on) s.add(id); else s.delete(id); }
async function saveDevPkgs() {
  try { await api('/devices/' + window._devPkgId + '/packages', { method: 'PUT', body: JSON.stringify({ package_ids: Array.from(window._devPkgSel || []) }) }); toast('Saved · re-download the default config to embed them'); } catch (e) { toast(e.message); }
}
async function diagnoseBackup(id) {
  const box = $('#bakDiag'); if (box) box.innerHTML = '<div class="card" style="margin-top:14px;padding:14px" class="muted">Running diagnostics on the router…</div>';
  try {
    const r = await api('/devices/' + id + '/backup-debug');
    if (box) box.innerHTML = `<div class="card" style="margin-top:14px;padding:14px"><div class="hd" style="padding:0 0 8px"><h2><i class="ti ti-stethoscope"></i> Backup diagnostics</h2></div>
      <pre style="white-space:pre-wrap;font-family:var(--mono);font-size:12px;margin:0;color:var(--text2);max-height:420px;overflow:auto">${esc(JSON.stringify(r, null, 2))}</pre></div>`;
  } catch (e) { if (box) box.innerHTML = `<div class="card" style="margin-top:14px;padding:14px">Diagnose failed: ${esc(e.message)}</div>`; toast(e.message); }
}
async function backupNow(id) {
  toast('Backing up…');
  try { const r = await api('/devices/' + id + '/backup', { method: 'POST' }); toast('Backed up · ' + fmtSize(r.size)); renderDeviceBackups(id); }
  catch (e) { toast(e.message); renderDeviceBackups(id); }
}
async function delBackup(bid, id) {
  if (!confirm('Delete this backup?')) return;
  try { await api('/backups/' + bid, { method: 'DELETE' }); toast('Deleted'); renderDeviceBackups(id); } catch (e) { toast(e.message); }
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
      <button class="btn sm" onclick="manageWifi(${id})" title="Show the live WiFi names/passwords from the router and edit them (reveal is logged)"><i class="ti ti-eye"></i> Reveal &amp; edit</button></div>
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
      <button class="btn sm" id="wgdl" style="margin-top:8px" title="WireGuard config to load on the device (contains its private key)"><i class="ti ti-download"></i> Download .conf</button></div>`;
    $('#wgcfg').value = r.config;
    $('#wgpeer').value = r.server_peer;
    $('#wgdl').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([r.config], { type: 'text/plain' }));
      a.download = 'wg-' + id + '.conf'; a.click();
    });
  } catch (e) { toast(e.message); }
}

// ---------- Billing (standalone; Stripe processes card/ACH) ----------
const fmtMoney = (n) => '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const BILL_PILL = { paid: 's-up', partial: 's-warn', sent: 's-warn', draft: '', void: 's-down' };
const isOverdueInv = (i) => (i.status === 'sent' || i.status === 'partial') && i.balance > 0 && i.due_date && i.due_date < new Date().toISOString().slice(0, 10);
function invPill(i) {
  if (isOverdueInv(i)) return '<span class="pill s-down">Overdue</span>';
  const s = i.status || '';
  return `<span class="pill ${BILL_PILL[s] || ''}">${esc(s[0] ? s[0].toUpperCase() + s.slice(1) : '')}</span>`;
}
async function renderBilling() {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  const s = await api('/billing/summary');
  window._billTab = window._billTab || 'invoices';
  view().innerHTML = `
    <div class="head"><div class="t"><h1>Billing</h1>
      <div class="small sec-muted" style="margin-top:3px">Invoices live here · Stripe processes cards &amp; ACH${s.stripe ? '' : ' · <a class="iplink" href="#/settings">connect Stripe in Settings</a>'}</div></div>
      <a class="btn primary" href="#/billing/new"><i class="ti ti-plus"></i> New invoice</a></div>
    <div class="grid3" style="margin:16px 0">
      <div class="metric"><div class="l">Outstanding</div><div class="v">${fmtMoney(s.outstanding)}</div></div>
      <div class="metric"><div class="l">Overdue (${s.overdue_count})</div><div class="v" style="color:var(--danger)">${fmtMoney(s.overdue)}</div></div>
      <div class="metric"><div class="l">Collected · 30 days</div><div class="v" style="color:var(--success)">${fmtMoney(s.collected_30d)}</div></div>
    </div>
    <div class="seg" style="margin-bottom:14px">
      ${['invoices', 'payments', 'recurring', 'products'].map(t => `<button class="segbtn${window._billTab === t ? ' on' : ''}" data-bt="${t}" onclick="billTab('${t}')">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
    </div>
    <div id="billbody"><div class="loading">Loading…</div></div>`;
  await billTab(window._billTab);
}
async function billTab(tab) {
  window._billTab = tab;
  document.querySelectorAll('[data-bt]').forEach(b => b.classList.toggle('on', b.dataset.bt === tab));
  const body = $('#billbody'); if (!body) return;
  try {
    if (tab === 'invoices') {
      body.innerHTML = `<div style="display:flex;gap:8px;margin-bottom:10px">
        <input id="billq" placeholder="Search number or customer…" style="flex:1"/>
        <select id="billst" style="width:auto"><option value="">All statuses</option>
          <option value="draft">Draft</option><option value="sent">Sent</option><option value="partial">Partial</option><option value="paid">Paid</option><option value="void">Void</option></select>
        </div><div class="card" id="billinv"></div>`;
      const load = async () => {
        const rows = await api('/billing/invoices?q=' + encodeURIComponent($('#billq').value.trim()) + '&status=' + $('#billst').value);
        $('#billinv').innerHTML = rows.map(i => `<div class="row rowlink" onclick="toggleInvoice(${i.id})">
          <i class="ti ti-file-invoice sec-muted"></i>
          <div style="flex:1;min-width:0"><div><b>${esc(i.number)}</b> · ${esc(i.customer_name || '?')}</div>
            <div class="small sec-muted">${esc(i.date)}${i.due_date ? ' · due ' + esc(i.due_date) : ''}</div></div>
          <div class="stat"><span class="mono">${fmtMoney(i.total)}</span>${i.balance > 0 && i.status !== 'void' ? `<span class="small mono" style="color:var(--warning)">${fmtMoney(i.balance)} due</span>` : ''}</div>
          ${invPill(i)}</div><div id="invdet-${i.id}"></div>`).join('') || '<div class="row muted">No invoices yet — create one with New invoice</div>';
      };
      $('#billq').addEventListener('input', () => { clearTimeout(window._billT); window._billT = setTimeout(load, 250); });
      $('#billst').addEventListener('change', load);
      await load();
    } else if (tab === 'payments') {
      const rows = await api('/billing/payments');
      const M = { stripe: 'Stripe', stripe_ach: 'Stripe ACH', check: 'Check', cash: 'Cash', other: 'Other' };
      body.innerHTML = `<div class="card">${rows.map(p => `<div class="row">
        <i class="ti ti-credit-card sec-muted"></i>
        <div style="flex:1;min-width:0"><div>${esc(p.customer_name || '?')} · <span class="small mono">${esc(p.invoice_number)}</span></div>
          <div class="small sec-muted">${esc(p.date)} · ${esc(M[p.method] || p.method)}${p.reference ? ' · ' + esc(p.reference) : ''}</div></div>
        <span class="mono" style="color:var(--success)">${fmtMoney(p.amount)}</span></div>`).join('') || '<div class="row muted">No payments recorded yet</div>'}</div>`;
    } else if (tab === 'recurring') {
      const rows = await api('/billing/recurring');
      body.innerHTML = `<div style="display:flex;gap:8px;margin-bottom:10px;justify-content:flex-end">
          <button class="btn sm" onclick="runRecurring()" title="Generate invoices for any schedules that are due today">Run due now</button>
          <a class="btn sm" href="#/billing/recurring/new"><i class="ti ti-plus"></i> New recurring</a></div>
        <div class="card">${rows.map(r => `<div class="row">
        <i class="ti ti-repeat sec-muted"></i>
        <div style="flex:1;min-width:0"><div>${esc(r.customer_name || '?')} · ${fmtMoney(r.amount)}</div>
          <div class="small sec-muted">${esc(r.frequency_label)} · next ${esc(r.next_date)}${r.auto_send ? ' · auto-emails' : ' · creates draft'}</div></div>
        ${r.active ? '<span class="pill s-up">Active</span>' : '<span class="pill">Paused</span>'}
        <a class="btn sm" href="#/billing/recurring/${r.id}/edit" title="Edit this schedule"><i class="ti ti-edit"></i> Edit</a>
        <button class="btn sm" onclick="toggleRecurring(${r.id}, ${r.active ? 0 : 1})" title="${r.active ? 'Stop generating invoices (keeps the schedule)' : 'Resume generating invoices'}">${r.active ? 'Pause' : 'Resume'}</button>
        <button class="btn sm" onclick="delRecurring(${r.id})" title="Delete this schedule (existing invoices stay)"><i class="ti ti-trash"></i> Delete</button></div>`).join('') || '<div class="row muted">No recurring schedules — use New recurring for monthly service billing</div>'}</div>`;
    } else if (tab === 'products') {
      const rows = await api('/billing/products');
      body.innerHTML = `<div style="display:flex;gap:8px;margin-bottom:10px;justify-content:flex-end"><button class="btn sm" onclick="addProduct()"><i class="ti ti-plus"></i> New product</button></div>
        <div class="card">${rows.map(p => `<div class="row">
        <i class="ti ti-package sec-muted"></i>
        <div style="flex:1;min-width:0"><div>${esc(p.name)}${p.taxable === 0 ? ' <span class="tag">no tax</span>' : ''}</div><div class="small sec-muted">${esc(p.description || '')}</div></div>
        <span class="mono">${fmtMoney(p.price)}</span>
        <button class="btn sm" onclick="editProduct(${p.id}, ${esc(JSON.stringify(p.name))}, ${esc(JSON.stringify(p.description || ''))}, ${p.price}, ${p.taxable})" title="Edit this product"><i class="ti ti-edit"></i> Edit</button>
        <button class="btn sm" onclick="delProduct(${p.id})" title="Remove from the catalog (past invoices keep their lines)"><i class="ti ti-trash"></i> Delete</button></div>`).join('') || '<div class="row muted">No products yet — add your service plans (e.g. "Fiber 1G — $99/mo") for quick invoicing</div>'}</div>`;
    }
  } catch (e) { body.innerHTML = `<div class="card" style="padding:16px;color:var(--danger)">${esc(e.message)}</div>`; }
}
async function toggleInvoice(id) {
  const det = $('#invdet-' + id); if (!det) return;
  if (det.innerHTML) { det.innerHTML = ''; return; }
  try {
    const i = await api('/billing/invoices/' + id);
    const items = i.items.map(it => `<div class="kv"><span class="small">${esc(it.description)} <span class="muted">× ${it.quantity}${it.taxable === 0 && i.tax_rate > 0 ? ' · no tax' : ''}</span></span><span class="mono small">${fmtMoney(it.amount)}</span></div>`).join('');
    const pays = i.payments.map(p => `<div class="kv"><span class="small" style="color:var(--success)">Payment · ${esc(p.date)} · ${esc(p.method)}${p.reference ? ' · ' + esc(p.reference) : ''}</span><span class="mono small" style="color:var(--success)">-${fmtMoney(p.amount)}</span></div>`).join('');
    const actions = [];
    if (i.status === 'draft') actions.push(`<a class="btn sm" href="#/billing/invoice/${i.id}/edit"><i class="ti ti-edit"></i> Edit</a>`);
    if (!['paid', 'void'].includes(i.status)) actions.push(`<button class="btn sm" onclick="sendInvoice(${i.id})" title="Email it to the customer with the pay link (marks it Sent)"><i class="ti ti-send"></i> ${i.status === 'draft' ? 'Send' : 'Resend'}</button>`);
    if (i.balance > 0 && i.status !== 'void') actions.push(`<button class="btn sm" onclick="recordPayment(${i.id}, ${i.balance})" title="Record a check/cash/manual payment"><i class="ti ti-cash"></i> Record payment</button>`);
    if (i.pay_url && i.balance > 0 && i.status !== 'void') actions.push(`<button class="btn sm" onclick="copyText(${esc(JSON.stringify(i.pay_url))})" title="Copy the public payment link (card / ACH via Stripe)"><i class="ti ti-link"></i> Copy pay link</button>`);
    if (!['paid', 'void'].includes(i.status)) actions.push(`<button class="btn sm" onclick="voidInvoice(${i.id})" title="Cancel this invoice (kept for records)">Void</button>`);
    if (['draft', 'void'].includes(i.status)) actions.push(`<button class="btn sm" onclick="delInvoice(${i.id})" title="Delete permanently"><i class="ti ti-trash"></i> Delete</button>`);
    det.innerHTML = `<div style="padding:4px 14px 12px 40px;background:var(--surface2)">
      ${items}${i.tax > 0 ? `<div class="kv"><span class="small">Tax (${i.tax_rate}%)</span><span class="mono small">${fmtMoney(i.tax)}</span></div>` : ''}
      <div class="kv"><span class="small"><b>Total</b></span><span class="mono small"><b>${fmtMoney(i.total)}</b></span></div>
      ${pays}${i.balance > 0 && i.status !== 'void' ? `<div class="kv"><span class="small"><b>Balance due</b></span><span class="mono small" style="color:var(--warning)"><b>${fmtMoney(i.balance)}</b></span></div>` : ''}
      ${i.notes ? `<div class="small sec-muted" style="margin-top:6px">${esc(i.notes)}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">${actions.join('')}</div></div>`;
  } catch (e) { toast(e.message); }
}
function copyText(t) { navigator.clipboard.writeText(t).then(() => toast('Copied'), () => prompt('Copy this link:', t)); }
async function sendInvoice(id) {
  try { const r = await api('/billing/invoices/' + id + '/send', { method: 'POST' }); toast(r.emailed ? 'Invoice emailed' : 'Marked sent — no billing email on file, copy the pay link instead'); billTab('invoices'); } catch (e) { toast(e.message); }
}
async function recordPayment(id, balance) {
  const amt = parseFloat(prompt(`Payment amount (balance ${fmtMoney(balance)}):`, balance));
  if (!(amt > 0)) return;
  const method = (prompt('Method — check / cash / other:', 'check') || 'other').toLowerCase();
  const reference = prompt('Reference (check #, memo — optional):') || '';
  try { const r = await api('/billing/invoices/' + id + '/pay', { method: 'POST', body: JSON.stringify({ amount: amt, method: ['check', 'cash'].includes(method) ? method : 'other', reference }) }); toast(r.status === 'paid' ? 'Paid in full' : 'Partial payment recorded'); billTab('invoices'); } catch (e) { toast(e.message); }
}
async function voidInvoice(id) {
  if (!confirm('Void this invoice? It stays on record but is no longer collectible.')) return;
  try { await api('/billing/invoices/' + id + '/void', { method: 'POST' }); toast('Voided'); billTab('invoices'); } catch (e) { toast(e.message); }
}
async function delInvoice(id) {
  if (!confirm('Permanently delete this invoice?')) return;
  try { await api('/billing/invoices/' + id, { method: 'DELETE' }); toast('Deleted'); billTab('invoices'); } catch (e) { toast(e.message); }
}
async function runRecurring() {
  try { const r = await api('/billing/recurring/run', { method: 'POST' }); toast(r.made ? r.made + ' invoice(s) generated' : 'Nothing due'); billTab('recurring'); } catch (e) { toast(e.message); }
}
async function toggleRecurring(id, active) {
  try { await api('/billing/recurring/' + id, { method: 'PUT', body: JSON.stringify({ active: !!active }) }); billTab('recurring'); } catch (e) { toast(e.message); }
}
async function delRecurring(id) {
  if (!confirm('Delete this recurring schedule? Invoices already generated stay.')) return;
  try { await api('/billing/recurring/' + id, { method: 'DELETE' }); toast('Deleted'); billTab('recurring'); } catch (e) { toast(e.message); }
}
async function addProduct() {
  const name = prompt('Product / service name (e.g. "Fiber 1G"):'); if (!name) return;
  const price = parseFloat(prompt('Price:', '0')) || 0;
  const description = prompt('Description (optional):') || '';
  const taxable = confirm('Charge sales tax on this item?\n\nOK = taxable · Cancel = not taxed');
  try { await api('/billing/products', { method: 'POST', body: JSON.stringify({ name, price, description, taxable }) }); toast('Added'); billTab('products'); } catch (e) { toast(e.message); }
}
async function editProduct(id, name, description, price, taxable) {
  const n = prompt('Name:', name); if (!n) return;
  const p = parseFloat(prompt('Price:', price)); const d = prompt('Description:', description) || '';
  const t = confirm('Charge sales tax on this item?\n\nOK = taxable · Cancel = not taxed' + (taxable === 0 ? '\n(currently: not taxed)' : '\n(currently: taxable)'));
  try { await api('/billing/products/' + id, { method: 'PUT', body: JSON.stringify({ name: n, price: isNaN(p) ? price : p, description: d, taxable: t }) }); toast('Saved'); billTab('products'); } catch (e) { toast(e.message); }
}
async function delProduct(id) {
  if (!confirm('Remove this product from the catalog?')) return;
  try { await api('/billing/products/' + id, { method: 'DELETE' }); toast('Removed'); billTab('products'); } catch (e) { toast(e.message); }
}
// ---- invoice / recurring form (shared line-item editor) ----
function renderItemRows() {
  const rows = window._items.map((it, i) => `<div style="display:flex;gap:8px;margin-bottom:6px;align-items:center">
    <input placeholder="Description" value="${esc(it.description)}" oninput="window._items[${i}].description=this.value;itemTotals()" style="flex:3"/>
    <input type="number" min="0" step="any" title="Quantity" value="${it.quantity}" oninput="window._items[${i}].quantity=parseFloat(this.value)||0;itemTotals()" style="flex:1"/>
    <input type="number" min="0" step="any" title="Unit price" value="${it.unit_price}" oninput="window._items[${i}].unit_price=parseFloat(this.value)||0;itemTotals()" style="flex:1;font-family:var(--mono)"/>
    <label class="small sec-muted" style="display:flex;align-items:center;gap:4px;flex:none;cursor:pointer" title="Charge sales tax on this line (uses the invoice tax rate)"><input type="checkbox" ${it.taxable === 0 ? '' : 'checked'} onchange="window._items[${i}].taxable=this.checked?1:0;itemTotals()" style="width:auto"/>Tax</label>
    <button class="btn sm" onclick="window._items.splice(${i},1);renderItemRows()" title="Remove this line">Remove</button></div>`).join('');
  $('#itemrows').innerHTML = rows + `<div style="display:flex;gap:8px;margin-top:4px;align-items:center;flex-wrap:wrap">
    <button class="btn sm" onclick="window._items.push({description:'',quantity:1,unit_price:0,taxable:1});renderItemRows()"><i class="ti ti-plus"></i> Add line</button>
    ${window._products.length ? `<select id="prodpick" style="width:auto" onchange="pickProduct(this)"><option value="">Add from products…</option>${window._products.map(p => `<option value="${p.id}">${esc(p.name)} — ${fmtMoney(p.price)}${p.taxable === 0 ? ' (no tax)' : ''}</option>`).join('')}</select>` : ''}
    <div style="flex:1"></div><div class="small sec-muted" id="itemsub"></div></div>`;
  itemTotals();
}
function itemTotals() {
  const line = it => (it.quantity || 0) * (it.unit_price || 0);
  const sub = window._items.reduce((n, it) => n + line(it), 0);
  const taxable = window._items.filter(it => it.taxable !== 0).reduce((n, it) => n + line(it), 0);
  const el = $('#itemsub');
  if (el) el.innerHTML = `Subtotal <b class="mono">${fmtMoney(sub)}</b>${taxable !== sub ? ` · taxed portion <b class="mono">${fmtMoney(taxable)}</b>` : ''}`;
}
function pickProduct(sel) {
  const p = window._products.find(x => x.id === Number(sel.value)); sel.value = '';
  if (p) { window._items.push({ description: p.name + (p.description ? ' — ' + p.description : ''), quantity: 1, unit_price: p.price, taxable: p.taxable === 0 ? 0 : 1 }); renderItemRows(); }
}
async function formInvoice(q) {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  const [custs, products] = await Promise.all([api('/customers'), api('/billing/products')]);
  let inv = { customer_id: '', email: '', date: new Date().toISOString().slice(0, 10), due_date: '', tax_rate: 0, notes: '', items: [{ description: '', quantity: 1, unit_price: 0, taxable: 1 }] };
  if (q.id) inv = await api('/billing/invoices/' + q.id);
  window._items = inv.items.map(it => ({ description: it.description, quantity: it.quantity, unit_price: it.unit_price, taxable: it.taxable === 0 ? 0 : 1 }));
  window._products = products;
  view().innerHTML = `<div class="crumb" onclick="location.hash='#/billing'"><i class="ti ti-chevron-left"></i> Billing</div>
    <h1>${q.id ? 'Edit invoice ' + esc(inv.number) : 'New invoice'}</h1>
    <div class="card" style="margin-top:14px;padding:16px" id="f">
      <div class="grid2">
        <div class="fld"><label class="fl">Customer</label><select name="customer_id">${custs.map(c => `<option value="${c.id}" ${c.id == inv.customer_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        ${field('Email invoice to (blank = customer billing email)', 'email', inv.email || '', { mono: true, ph: 'billing@customer.com' })}
      </div>
      <div class="grid2">${field('Invoice date', 'date', inv.date, { type: 'date' })}${field('Due date', 'due_date', inv.due_date || '', { type: 'date' })}</div>
      ${field('Tax rate %', 'tax_rate', inv.tax_rate || 0, { type: 'number' })}
      <div class="fld"><label class="fl">Line items (description · qty · unit price)</label><div id="itemrows"></div></div>
      ${field('Notes (shown on the invoice)', 'notes', inv.notes || '', { type: 'textarea' })}
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
        <button class="btn" onclick="location.hash='#/billing'">Cancel</button>
        <button class="btn" onclick="saveInvoice(${q.id || 'null'}, false)" title="Save without emailing — you can send it later"><i class="ti ti-device-floppy"></i> Save draft</button>
        <button class="btn primary" onclick="saveInvoice(${q.id || 'null'}, true)" title="Save and email it to the customer with the online pay link"><i class="ti ti-send"></i> Save &amp; send</button></div>
    </div>`;
  renderItemRows();
}
async function saveInvoice(id, send) {
  const d = collect('#f');
  d.items = window._items; d.send = send;
  try {
    if (id) {
      await api('/billing/invoices/' + id, { method: 'PUT', body: JSON.stringify(d) });
      if (send) await api('/billing/invoices/' + id + '/send', { method: 'POST' });
      toast(send ? 'Saved & sent' : 'Saved');
    } else {
      const r = await api('/billing/invoices', { method: 'POST', body: JSON.stringify(d) });
      toast(r.number + (send ? (r.emailed ? ' sent' : ' created — no email on file, copy the pay link') : ' saved as draft'));
    }
    location.hash = '#/billing';
  } catch (e) { toast(e.message); }
}
async function formRecurring(q) {
  if (!isPriv()) { view().innerHTML = '<div class="card" style="padding:20px">NOC/Admin only.</div>'; return; }
  const [custs, products] = await Promise.all([api('/customers'), api('/billing/products')]);
  let r = { customer_id: '', frequency: 'monthly', next_date: new Date().toISOString().slice(0, 10), tax_rate: 0, auto_send: 1, items: [{ description: '', quantity: 1, unit_price: 0, taxable: 1 }] };
  if (q.id) { const all = await api('/billing/recurring'); r = all.find(x => x.id === Number(q.id)) || r; }
  window._items = r.items.map(it => ({ description: it.description, quantity: it.quantity, unit_price: it.unit_price, taxable: it.taxable === 0 ? 0 : 1 }));
  window._products = products;
  view().innerHTML = `<div class="crumb" onclick="location.hash='#/billing'"><i class="ti ti-chevron-left"></i> Billing</div>
    <h1>${q.id ? 'Edit' : 'New'} recurring invoice</h1>
    <div class="card" style="margin-top:14px;padding:16px" id="f">
      <div class="grid2">
        <div class="fld"><label class="fl">Customer</label><select name="customer_id">${custs.map(c => `<option value="${c.id}" ${c.id == r.customer_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
        ${field('Frequency', 'frequency', r.frequency, { type: 'select', options: [{ v: 'weekly', l: 'Weekly' }, { v: 'monthly', l: 'Monthly' }, { v: 'quarterly', l: 'Quarterly' }, { v: 'semiannual', l: 'Every 6 months' }, { v: 'yearly', l: 'Yearly' }] })}
      </div>
      <div class="grid2">${field('Next invoice date', 'next_date', r.next_date, { type: 'date' })}${field('Tax rate %', 'tax_rate', r.tax_rate || 0, { type: 'number' })}</div>
      <label class="row" style="cursor:pointer;padding:6px 0"><input type="checkbox" id="autoSend" ${r.auto_send ? 'checked' : ''} style="width:auto"/>
        <div style="flex:1"><div>Auto-send</div><div class="small sec-muted">Email each invoice (with the pay link) as it's generated. Off = invoices appear as drafts for review.</div></div></label>
      <div class="fld"><label class="fl">Line items</label><div id="itemrows"></div></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
        <button class="btn" onclick="location.hash='#/billing'">Cancel</button>
        <button class="btn primary" onclick="saveRecurring(${q.id || 'null'})"><i class="ti ti-check"></i> Save</button></div>
    </div>`;
  renderItemRows();
}
async function saveRecurring(id) {
  const d = collect('#f');
  d.items = window._items; d.auto_send = $('#autoSend').checked;
  try {
    if (id) await api('/billing/recurring/' + id, { method: 'PUT', body: JSON.stringify(d) });
    else await api('/billing/recurring', { method: 'POST', body: JSON.stringify(d) });
    toast('Saved'); window._billTab = 'recurring'; location.hash = '#/billing';
  } catch (e) { toast(e.message); }
}
// ---- settings card actions ----
async function saveBillingCfg() {
  const d = collect('#billcfg');
  if (!d.stripe_secret) delete d.stripe_secret;
  if (!d.stripe_webhook_secret) delete d.stripe_webhook_secret;
  try { await api('/settings', { method: 'PUT', body: JSON.stringify(d) }); toast('Saved'); renderSettings(); } catch (e) { toast(e.message); }
}
async function testStripe() {
  const out = $('#billout'); out.innerHTML = '<div class="loading">Testing…</div>';
  try { const r = await api('/billing/stripe-test', { method: 'POST' }); out.innerHTML = `<div class="help" style="color:var(--success)">Connected — ${r.livemode ? 'LIVE mode' : 'test mode'} (${esc(r.currency.toUpperCase())})</div>`; }
  catch (e) { out.innerHTML = `<div class="help" style="color:var(--danger)">${esc(e.message)}</div>`; }
}
async function restoreBilling(input) {
  const f = input.files && input.files[0]; if (!f) return;
  input.value = '';
  if (!confirm(`Restore billing from "${f.name}"?\n\nThis REPLACES all invoices, payments, products and recurring schedules with the file's contents.`)) return;
  try {
    const data = JSON.parse(await f.text());
    const r = await api('/billing/restore', { method: 'POST', body: JSON.stringify(data) });
    toast(`Restored: ${r.counts.invoices} invoices, ${r.counts.payments} payments`);
  } catch (e) { toast('Restore failed: ' + (e.message || 'bad file')); }
}
