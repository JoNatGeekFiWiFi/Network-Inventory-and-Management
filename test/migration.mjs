// One-time data migrations. Boots its own servers against a purpose-built legacy DB,
// so it ignores BASE and does not use the shared runner instance.
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB = '/tmp/netinv-migration-' + process.pid + '.db';
const PORT = Number(process.env.TEST_PORT || 4100) + 50;
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const clean = () => ['', '-wal', '-shm'].forEach(s => rmSync(DB + s, { force: true }));

async function boot() { // start, wait for readiness, stop — enough for migrate() to run
  const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, DB_PATH: DB, PORT: String(PORT), SAMPLER: 'off', IMAP: 'off' } });
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://localhost:${PORT}/portal`); if (r.status) break; } catch {} await wait(500); }
  srv.kill(); await wait(400);
}

clean();
await boot(); // first boot creates + seeds schema

// --- seed legacy rows the way an existing deployment would look ---
{
  const db = new DatabaseSync(DB);
  const pops = db.prepare('SELECT id FROM pops ORDER BY id').all();
  const acct = db.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').get();
  db.prepare('DELETE FROM circuits').run();
  db.prepare('DELETE FROM pop_circuits').run();
  db.prepare('INSERT INTO pop_circuits (pop_id,source_type,source_account_id,circuit_id,bandwidth,status,notes) VALUES (?,?,?,?,?,?,?)').run(pops[0].id, 'account', acct.id, 'COX-77001', '1 Gbps', 'Up', 'primary feed');
  if (pops[1]) db.prepare('INSERT INTO pop_circuits (pop_id,source_type,source_pop_id,circuit_id,bandwidth,status,notes) VALUES (?,?,?,?,?,?,?)').run(pops[1].id, 'pop', pops[0].id, 'BACKHAUL-1', '10 Gbps', 'Up', 'ring');
  db.prepare('INSERT INTO pop_circuits (pop_id,source_type,source_pop_id,circuit_id) VALUES (?,?,?,?)').run(pops[0].id, 'pop', pops[0].id, 'SELFLOOP');   // must be skipped
  db.prepare('INSERT INTO pop_circuits (pop_id,source_type,source_account_id,circuit_id) VALUES (?,?,?,?)').run(pops[0].id, 'account', null, 'BROKEN');  // must be skipped
  // legacy single sub_account, and clear both migration flags so they re-run
  db.prepare('UPDATE accounts SET sub_account=? WHERE id=?').run('Legacy Sub 42', acct.id);
  db.prepare('DELETE FROM account_subaccounts').run();
  db.prepare("DELETE FROM settings WHERE key IN ('popcircuits_merged','subaccount_migrated')").run();
  db.close();
}

await boot(); // second boot runs the migrations

{
  const db = new DatabaseSync(DB);
  const circuits = db.prepare('SELECT * FROM circuits ORDER BY id').all();
  ok(circuits.length === 2, `pop_circuits merged: 2 circuits (got ${circuits.length}); self-loop + broken ref skipped`);
  const up = circuits.find(c => c.a_type === 'account');
  ok(!!up && up.z_type === 'pop' && up.circuit_id === 'COX-77001' && up.bandwidth === '1 Gbps' && up.notes === 'primary feed', 'account-sourced feed migrated losslessly (A=account, Z=pop)');
  ok(circuits.some(c => c.a_type === 'pop' && c.z_type === 'pop' && c.circuit_id === 'BACKHAUL-1'), 'pop-to-pop backhaul migrated');
  ok(db.prepare('SELECT COUNT(*) n FROM pop_circuits').get().n === 4, 'legacy pop_circuits table left intact for rollback');
  const subs = db.prepare('SELECT * FROM account_subaccounts').all();
  ok(subs.some(s => s.name === 'Legacy Sub 42'), 'legacy accounts.sub_account folded into the sub-account list');
  db.close();
}

await boot(); // third boot must be a no-op

{
  const db = new DatabaseSync(DB);
  ok(db.prepare('SELECT COUNT(*) n FROM circuits').get().n === 2, 'migration is idempotent across reboots (no duplicates)');
  ok(db.prepare('SELECT COUNT(*) n FROM account_subaccounts').get().n === 1, 'sub-account migration idempotent');
  db.close();
}

clean();
console.log('\nRESULT:', pass, 'passed,', fail, 'failed'); process.exit(fail ? 1 : 0);
