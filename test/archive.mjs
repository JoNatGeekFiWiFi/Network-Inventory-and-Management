// Deactivating instead of deleting.
//
// The rule the platform now works to: a business record is never destroyed. A customer who leaves,
// a site that disconnects, a circuit that is cut over, a router that comes out of the field — all
// of it is marked deactivated, with who did it, when, and why, and all of it stays readable for as
// long as the company exists.
//
// That is easy to say and easy to half-implement, because "hidden from the list" and "still there"
// pull in opposite directions. The three failures this file is written to catch:
//
//   1. HIDDEN BECOMES GONE. If an archived record cannot be found by anyone who is not willing to
//      open a database client, the archive is a deletion with extra bookkeeping. Every assertion
//      about ?archived=1, about search, and about the record's own page is guarding that.
//   2. HIDDEN BECOMES HARMLESS. An archived customer that can still sign in to the portal, or an
//      archived device the platform still SSHes into, has been hidden from staff and from nobody
//      else. Those are the security assertions.
//   3. THE HISTORY GOES ANYWAY. Archiving the parent must not quietly take the invoices, tickets,
//      units or documents with it — those are the reason for keeping the record at all.
const B = process.env.BASE ?? 'http://localhost:3000';
let cookie = '';
async function call(p, { method = 'GET', body, raw = false } = {}) {
  const h = {};
  if (body !== undefined) { h['content-type'] = 'application/json'; if (method === 'GET') method = 'POST'; }
  if (cookie) h.cookie = cookie;
  const r = await fetch(B + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = r.headers.get('set-cookie'); if (sc && !raw) cookie = sc.split(';')[0];
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, t, headers: r.headers };
}
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

await call('/api/login', { body: { email: 'admin@geekitek.test', password: 'admin123' } });
const acct = (await call('/api/meta')).json.accounts[0];
const stamp = Date.now();

// ---- 1. the shape of the thing ---------------------------------------------------------------------
let cust, site;
{
  cust = (await call('/api/customers', { body: { name: 'ARCHIVE-TEST Departed ' + stamp, account_ids: [acct.id], billing_email: `arch${stamp}@example.test` } })).json;
  site = (await call('/api/sites', { body: { customer_id: cust.id, name: 'ARCHIVE-TEST Site ' + stamp, service_address: '900 Archive Way, Mesa, AZ' } })).json;
  ok(cust && cust.id && site && site.id, 'a customer and a site to work with');

  const r = await call('/api/customers/' + cust.id, { method: 'DELETE', body: { reason: 'Moved out of area' } });
  ok(r.status === 200 && r.json.archived === true, 'DELETE archives and says so, rather than reporting a deletion');

  const c = (await call('/api/customers/' + cust.id)).json;
  ok(c.archived_at, 'the record records WHEN');
  ok(c.archived_by, `the record records WHO (${c.archived_by})`);
  ok(c.archived_reason === 'Moved out of area', 'and WHY, in the words it was given');

  // Without all three, an archive is just a boolean, and six months later nobody can say whether a
  // record was closed deliberately or by a mis-click.
  ok(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(c.archived_at), 'the timestamp is a real timestamp, not a flag');
}

// ---- 2. hidden from the lists people work from -------------------------------------------------------
{
  ok((await call('/api/customers')).json.every(x => x.id !== cust.id), 'archived: absent from /api/customers');
  ok((await call('/api/customers?archived=1')).json.some(x => x.id === cust.id), 'present with ?archived=1');
  const all = (await call('/api/customers?archived=all')).json;
  ok(all.some(x => x.id === cust.id), 'present with ?archived=all');
  ok(all.length > (await call('/api/customers')).json.length, 'and ?archived=all is strictly bigger than the default');

  // A value nobody documented must not become "show me everything" by accident.
  ok((await call('/api/customers?archived=yes-please')).json.every(x => x.id !== cust.id),
    'an unrecognised ?archived value falls back to active-only rather than leaking the archive');
}

// ---- 3. the record is still a record ------------------------------------------------------------------
{
  const inv = (await call('/api/billing/invoices', { method: 'POST', body: { customer_id: cust.id, date: '2026-01-01', tax_rate: 0, items: [{ description: 'service', quantity: 1, unit_price: 99, taxable: 0 }] } })).json;
  ok(inv && inv.id, 'an invoice can still be written against an archived customer (correcting history is normal)');
  ok((await call('/api/billing/invoices')).json.some(i => i.id === inv.id), 'and it reads back');

  const detail = await call('/api/customers/' + cust.id);
  ok(detail.status === 200, 'the archived customer page still opens');
  ok(detail.json.sites.some(s => s.id === site.id), "and still lists the sites that belonged to it");
}

// ---- 4. SEARCH STILL FINDS IT ---------------------------------------------------------------------------
//
// The single most important assertion in this file. Everything else is about hiding the record well;
// this is the one that keeps hiding it from turning into losing it.
{
  const res = (await call('/api/search?q=' + encodeURIComponent('ARCHIVE-TEST Departed ' + stamp))).json;
  const group = (res.groups || []).find(g => g.type === 'customer');
  const hit = group && group.items.find(i => i.id === cust.id);
  ok(!!hit, 'an archived customer is still found by name in search');
  ok(hit && hit.archived === true, 'and is flagged as archived, so nobody starts work on it by mistake');
  ok(hit && hit.badge === 'archived', 'the badge says so in plain words rather than a colour');
}

// ---- 5. it cannot still ACT ---------------------------------------------------------------------------
//
// Hiding a customer from staff while leaving their portal login working is worse than not hiding
// them: the record looks closed to everyone except the person it was closed on.
{
  const email = `portal${stamp}@example.test`;
  const pw = 'archive-test-portal-pw';
  const pc = (await call('/api/customers', { body: { name: 'ARCHIVE-TEST Portal ' + stamp, account_ids: [acct.id], billing_email: email } })).json;
  await call('/api/customers/' + pc.id, { method: 'PUT', body: { name: 'ARCHIVE-TEST Portal ' + stamp, portal_enabled: 1, portal_password: pw } });

  // It works before archiving — otherwise the assertion after it proves nothing.
  const before = await call('/portal/login', { method: 'POST', body: { email, password: pw }, raw: true });
  ok(before.status === 200, 'the portal login works while the customer is active');

  await call('/api/customers/' + pc.id, { method: 'DELETE' });

  const after = await call('/portal/login', { method: 'POST', body: { email, password: pw }, raw: true });
  ok(after.status === 401, 'once archived, the same credentials are refused');
  ok(after.json && !/archiv|deactiv|closed/i.test(after.json.error || ''),
    'and the refusal does not announce that the account was closed — that is not the login page\'s business');

  // The magic link is the path that gets forgotten, because it does not look like a login.
  const link = await call('/portal/login-link', { method: 'POST', body: { email }, raw: true });
  ok(link.status === 200, 'the magic-link endpoint still answers 200 (it never reveals whether an address exists)');

  await call('/api/customers/' + pc.id + '/restore', { method: 'POST', body: {} });
  const back = await call('/portal/login', { method: 'POST', body: { email, password: pw }, raw: true });
  ok(back.status === 200, 'and reactivating restores portal access');
}

// ---- 6. archiving a parent does not destroy its children -------------------------------------------------
{
  const s2 = (await call('/api/sites', { body: { customer_id: cust.id, name: 'ARCHIVE-TEST MDU ' + stamp, service_address: '12 Units Rd, Mesa, AZ' } })).json;
  await call(`/api/sites/${s2.id}/units`, { body: { label: 'Unit A' } });
  await call(`/api/sites/${s2.id}/units`, { body: { label: 'Unit B' } });
  ok((await call(`/api/sites/${s2.id}/units`)).json.length === 2, 'two units on a site');

  await call('/api/sites/' + s2.id, { method: 'DELETE', body: { reason: 'Building sold' } });
  ok((await call(`/api/sites/${s2.id}/units`)).json.length === 2, 'archiving the site keeps both units');

  await call('/api/sites/' + s2.id + '/restore', { method: 'POST', body: {} });
  ok((await call(`/api/sites/${s2.id}/units`)).json.length === 2, 'and restoring brings back the whole MDU, not an empty building');
}

// ---- 7. a device leaves the network, and the platform stops chasing it -------------------------------------
{
  const models = (await call('/api/meta')).json.models;
  const dev = (await call('/api/devices', { body: { name: 'ARCHIVE-TEST Router ' + stamp, model_id: models[0] && models[0].id, assigned_type: 'site', assigned_site_id: site.id, serial: 'ARCH' + stamp } })).json;
  ok(dev && dev.id, 'a device assigned to a site');

  const r = await call('/api/devices/' + dev.id, { method: 'DELETE', body: { reason: 'RMA' } });
  ok(r.status === 200 && r.json.archived === true, 'DELETE archives the device');

  const d = (await call('/api/devices/' + dev.id)).json;
  ok(d.archived_at, 'it keeps its archived stamp');
  ok(!d.assigned_site_id, 'and is unassigned, so the site does not still claim hardware that left');
  ok((await call('/api/devices')).json.every(x => x.id !== dev.id), 'gone from Inventory');
  ok((await call('/api/devices?archived=1')).json.some(x => x.id === dev.id), 'reachable with ?archived=1');
  ok(d.serial === 'ARCH' + stamp, 'the serial survives — which is the whole point when it turns up in a box in two years');
}

// ---- 8. archiving twice, and restoring what was never archived ---------------------------------------------
{
  ok((await call('/api/customers/' + cust.id, { method: 'DELETE' })).status === 409,
    'archiving an already-archived record is refused rather than overwriting who archived it and why');

  const fresh = (await call('/api/customers', { body: { name: 'ARCHIVE-TEST Never ' + stamp, account_ids: [acct.id] } })).json;
  const r = await call('/api/customers/' + fresh.id + '/restore', { method: 'POST', body: {} });
  ok(r.status === 200, 'restoring a record that was never archived is harmless rather than an error');
  ok(!(await call('/api/customers/' + fresh.id)).json.archived_at, 'and leaves it active');

  ok((await call('/api/customers/99999999', { method: 'DELETE' })).status === 404, 'archiving a record that does not exist is a 404');
  ok((await call('/api/customers/99999999/restore', { method: 'POST', body: {} })).status === 404, 'and so is restoring one');
}

// ---- 9. it does not appear where a CHOICE is being made -------------------------------------------------------
{
  const meta = (await call('/api/meta')).json;
  const p = (await call('/api/pops', { body: { name: 'ARCHIVE-TEST POP ' + stamp, code: 'ATP' + (stamp % 10000) } })).json;
  await call('/api/pops/' + p.id, { method: 'DELETE' });

  ok((await call('/api/meta')).json.pops.every(x => x.id !== p.id),
    'an archived POP is not offered in the form pickers — you cannot choose a thing that is closed');
  ok(meta.accounts.length >= 1, 'accounts are still offered (sanity: the picker is not simply empty)');
  ok((await call('/api/pops?archived=1')).json.some(x => x.id === p.id), 'while remaining reachable on request');
}

// ---- 10. the audit log says what happened ----------------------------------------------------------------
{
  const log = (await call('/api/audit?limit=200')).json;
  const entries = Array.isArray(log) ? log : (log.rows || log.items || []);
  const arch = entries.filter(e => (e.action || '') === 'archive');
  ok(arch.length > 0, `archiving writes an 'archive' action to the audit log (${arch.length} found)`);
  // The column is `details`, not `detail` — reading the wrong one made this pass-looking check
  // assert nothing at all the first time it was written.
  ok(arch.some(e => /Moved out of area/.test(e.details || '')),
    'and the reason is in the entry, so the log answers "why is this closed?" without opening the record');
}

// ---- 11. reactivating puts it back ------------------------------------------------------------------------
{
  const r = await call('/api/customers/' + cust.id + '/restore', { method: 'POST', body: {} });
  ok(r.status === 200 && r.json.archived === false, 'restore reports the record is active again');
  const c = (await call('/api/customers/' + cust.id)).json;
  ok(!c.archived_at && !c.archived_by && !c.archived_reason,
    'and clears all three columns — a restored record carries no trace of having been archived, because it is simply active');
  ok((await call('/api/customers')).json.some(x => x.id === cust.id), 'back in the working list');
}

// ---- 12. what the two parallel versions each got right, now held together ---------------------------------
//
// This feature was written twice at once and merged. One version paused recurring billing and marked
// the customer Closed; the other kept who/when/why and hid the record. These assertions exist so the
// merge cannot quietly drop either half.
{
  const rc = (await call('/api/customers', { body: { name: 'ARCHIVE-TEST Billing ' + stamp, account_ids: [acct.id] } })).json;
  const sched = (await call('/api/billing/recurring', { body: { customer_id: rc.id, frequency: 'monthly', next_date: '2020-01-01', tax_rate: 0, items: [{ description: 'Internet', quantity: 1, unit_price: 80, taxable: 0 }] } })).json;
  ok(sched && sched.id, 'a monthly recurring invoice for the customer');

  await call('/api/customers/' + rc.id, { method: 'DELETE', body: { reason: 'Cancelled service' } });
  const recs = (await call('/api/billing/recurring')).json;
  const mine = recs.find(r => r.id === sched.id);
  ok(mine && mine.active === 0, 'deactivating PAUSES recurring billing — a closed customer is not invoiced next month');
  ok((await call('/api/customers/' + rc.id)).json.status === 'Closed', "and the customer's status reads Closed, so the pill says so everywhere");

  // Even if someone switches the schedule back on by hand, the run must not bill a closed account.
  // next_date is in the past, so a run would pick it up immediately if it were allowed to.
  await call('/api/billing/recurring/' + sched.id, { method: 'PUT', body: { active: 1 } });
  const before = (await call('/api/billing/invoices')).json.filter(i => i.customer_id === rc.id).length;
  await call('/api/billing/recurring/run', { method: 'POST', body: {} });
  const after = (await call('/api/billing/invoices')).json.filter(i => i.customer_id === rc.id).length;
  ok(after === before, 'and a schedule re-enabled by hand still does not invoice a deactivated customer');

  const back = await call('/api/customers/' + rc.id + '/restore', { method: 'POST', body: {} });
  ok(back.status === 200 && /paused/i.test((back.json && back.json.note) || ''),
    'reactivating says plainly that billing is still paused, rather than silently restarting charges');
  ok((await call('/api/customers/' + rc.id)).json.status === 'Active', 'and puts the status back to Active');
}

// ---- 13. closing from the edit form is the same act as the button -------------------------------------------
{
  const ec = (await call('/api/customers', { body: { name: 'ARCHIVE-TEST EditForm ' + stamp, account_ids: [acct.id] } })).json;
  await call('/api/customers/' + ec.id, { method: 'PUT', body: { name: 'ARCHIVE-TEST EditForm ' + stamp, status: 'Closed' } });
  const c = (await call('/api/customers/' + ec.id)).json;
  ok(c.archived_at && c.archived_by, 'setting status to Closed in the edit form archives the customer, with who and when');
  ok((await call('/api/customers')).json.every(x => x.id !== ec.id), 'so it leaves the list exactly as the Deactivate button would');

  await call('/api/customers/' + ec.id, { method: 'PUT', body: { name: 'ARCHIVE-TEST EditForm ' + stamp, status: 'Active' } });
  ok(!(await call('/api/customers/' + ec.id)).json.archived_at, 'and setting it back to Active reactivates it — the two ways cannot disagree');
}

console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
