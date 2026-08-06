// Test runner: boots the app against a throwaway DB, runs every suite, reports.
//   npm test              — run all
//   npm test circuits     — run suites whose name matches
import { spawn } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const filter = process.argv[2] || '';
const PORT = Number(process.env.TEST_PORT || 4100);
const DB = join('/tmp', 'netinv-test-' + process.pid + '.db');

const suites = readdirSync(__dirname).filter(f => f.endsWith('.mjs') && f !== 'run.mjs' && f.includes(filter)).sort();
if (!suites.length) { console.error('No suites match', filter); process.exit(1); }

const wait = ms => new Promise(r => setTimeout(r, ms));
// Require a real 2xx — a 500 still "responds", and treating that as ready once let a
// broken /portal route slip through a whole refactor unnoticed.
async function up(url, tries = 40) {
  let last = 0;
  for (let i = 0; i < tries; i++) { try { const r = await fetch(url); last = r.status; if (r.ok) return true; } catch {} await wait(500); }
  console.log(`    (readiness: last status ${last})`);
  return false;
}

let totalPass = 0, totalFail = 0, failedSuites = [];
for (const suite of suites) {
  rmSync(DB, { force: true }); rmSync(DB + '-wal', { force: true }); rmSync(DB + '-shm', { force: true });
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT), SAMPLER: 'off', IMAP: 'off' }
  });
  const ok = await up(`http://localhost:${PORT}/portal`);
  if (!ok) { console.log(`✗ ${suite} — server failed to start`); failedSuites.push(suite); totalFail++; srv.kill(); continue; }

  const out = await new Promise(res => {
    let buf = '';
    const p = spawn(process.execPath, [join(__dirname, suite)], { env: { ...process.env, BASE: `http://localhost:${PORT}` } });
    p.stdout.on('data', d => buf += d); p.stderr.on('data', d => buf += d);
    p.on('close', code => res({ code, buf }));
  });
  srv.kill();
  await wait(300);

  const m = out.buf.match(/RESULT:\s*(\d+) passed,\s*(\d+) failed/);
  if (m) {
    totalPass += Number(m[1]); totalFail += Number(m[2]);
    const bad = Number(m[2]) > 0;
    if (bad) failedSuites.push(suite);
    console.log(`${bad ? '✗' : '✓'} ${suite.padEnd(18)} ${m[1]} passed, ${m[2]} failed`);
    if (bad) out.buf.split('\n').filter(l => l.startsWith('FAIL')).forEach(l => console.log('    ' + l));
  } else {
    console.log(`✗ ${suite.padEnd(18)} did not report a result`);
    console.log(out.buf.split('\n').slice(-6).map(l => '    ' + l).join('\n'));
    failedSuites.push(suite); totalFail++;
  }
}
rmSync(DB, { force: true }); rmSync(DB + '-wal', { force: true }); rmSync(DB + '-shm', { force: true });
console.log(`\n${totalPass} passed, ${totalFail} failed` + (failedSuites.length ? ` — failing: ${failedSuites.join(', ')}` : ''));
process.exit(failedSuites.length ? 1 : 0);
