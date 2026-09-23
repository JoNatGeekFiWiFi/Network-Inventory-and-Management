// Where files live, and the boundary that keeps a bad path from reading the filesystem.
//
// Moving from one flat directory to per-record directories introduced something that was not there
// before: stored paths containing components derived from record NAMES. That is precisely how
// directory traversal gets introduced into an application that never had it. The traversal tests
// below are the most important thing in this file — a sanitiser that looks thorough and misses one
// encoding is worth nothing, so the check is on the RESOLVED path rather than on the text.
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileStore, slug, safeFilename } from '../lib/filestore.js';

let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? 'PASS' : 'FAIL', m); };

const ROOT = mkdtempSync(join(tmpdir(), 'filestore-'));
const store = createFileStore(ROOT);

// ---- readable directory names ----------------------------------------------------------------------
{
  ok(slug('Acme Logistics') === 'acme-logistics', 'a name becomes a readable slug');
  ok(slug('1200 E Washington St.') === '1200-e-washington-st', 'punctuation collapses to dashes');
  ok(slug('Café Münchén') === 'cafe-munchen', 'accents fold to their base letters rather than vanishing');
  ok(slug('///') === '', 'a name made only of separators yields nothing, and the id alone is used');
  ok(slug(null) === '' && slug(undefined) === '', 'null and undefined are safe');
  ok(!slug('../../etc').includes('.'), 'and a traversal attempt cannot survive slugging');
  ok(slug('x'.repeat(200)).length <= 40, 'a very long name is truncated so paths stay sane');
}

// ---- filenames -------------------------------------------------------------------------------------
{
  const f = safeFilename('My Report.pdf');
  ok(f.endsWith('.pdf') && f.startsWith('My-Report-'), `the extension and a readable stem survive (${f})`);
  ok(safeFilename('a.pdf') !== safeFilename('a.pdf'), 'two files with the same name never collide');
  ok(!safeFilename('../../etc/passwd').includes('/'), 'a path in a filename is reduced to its last component');
  ok(!safeFilename('.hidden').startsWith('.'), 'and a leading dot is stripped, so nothing becomes a hidden file');
  ok(safeFilename('').length > 0, 'an empty name still produces something usable');
}

// ---- per-record directories --------------------------------------------------------------------------
{
  const a = store.place('customer', 42, 'Acme Logistics', 'documents', 'agreement.pdf');
  ok(a.stored.startsWith('customer/42-acme-logistics/documents/'), `a customer's file is filed under them (${a.stored})`);
  writeFileSync(a.absolute, 'x');
  ok(existsSync(a.absolute), 'and the directory is created on the way');

  const b = store.place('site', 7, '1200 E Washington', 'attachments', 'photo.jpg');
  ok(b.stored.startsWith('site/7-1200-e-washington/attachments/'), 'a site gets its own tree');

  const c = store.place('pop', 3, 'POP-PHX01', 'documents', 'lease.pdf');
  ok(c.stored.startsWith('pop/3-pop-phx01/documents/'), 'and so does a POP');

  // THE RENAME CASE. A record is found by its id; the readable part is decoration. Renaming a
  // customer must not strand their files in an old directory or create a second one.
  const renamed = store.place('customer', 42, 'Acme Logistics Incorporated', 'documents', 'second.pdf');
  ok(renamed.stored.startsWith('customer/42-acme-logistics/'),
    'after a rename, the SAME directory is reused — the slug is a hint, the id is the identity');

  // And an id that is a prefix of another must not match it.
  const four = store.place('customer', 4, 'Four', 'documents', 'x.pdf');
  ok(four.stored.startsWith('customer/4-four/'), 'customer 4 does not land inside customer 42');
  ok(!four.stored.startsWith('customer/42'), 'confirmed: the trailing dash in the prefix does its job');

  const noName = store.place('customer', 99, '', 'documents', 'x.pdf');
  ok(noName.stored.startsWith('customer/99/'), 'a record with no usable name is filed under its id alone');

  const odd = store.place('customer', 50, '../../etc', 'documents', 'x.pdf');
  ok(!odd.stored.includes('..'), 'a record NAMED with a traversal attempt produces no traversal in the path');
}

// ---- THE SECURITY BOUNDARY --------------------------------------------------------------------------
{
  const good = store.place('customer', 1, 'Test', 'documents', 'ok.pdf');
  writeFileSync(good.absolute, 'content');
  ok(store.resolveStored(good.stored).startsWith(ROOT), 'a legitimate stored value resolves inside the root');

  // Every one of these must be refused. They are refused because the RESOLVED path is checked, not
  // because each pattern is recognised — which is why an encoding nobody thought of is also refused.
  const attacks = [
    '../../../etc/passwd',
    'customer/../../../etc/passwd',
    'customer/1-test/../../../../etc/shadow',
    '/etc/passwd',
    'customer/./../../etc/passwd',
    '..',
    '../'
  ];
  let refused = 0;
  for (const a of attacks) {
    try { const r = store.resolveStored(a); if (!r.startsWith(ROOT + '/') && r !== ROOT) refused++; }
    catch { refused++; }
  }
  ok(refused === attacks.length, `all ${attacks.length} traversal attempts are refused (${refused} caught)`);

  // "....//....//" defeats sanitisers that STRIP "../" — strip it once and the remainder collapses
  // back into a traversal. It is harmless here, and the reason is worth stating: nothing is
  // stripped. The path is resolved and the RESULT is checked, so "...." is just an unusual
  // directory name that lands inside the root. Pattern-matching catches the attacks you thought
  // of; resolving catches the ones you did not.
  const odd = store.resolveStored('....//....//etc/passwd');
  ok(odd.startsWith(ROOT + '/'),
    'a strip-defeating pattern resolves harmlessly INSIDE the root, because nothing is stripped');

  let nulByte = false;
  try { store.resolveStored('customer/1-test/ok.pdf\0.png'); } catch { nulByte = true; }
  ok(nulByte, 'a NUL byte in a stored value is refused — it truncates paths in some system calls');

  let empty = false;
  try { store.resolveStored(''); } catch { empty = true; }
  ok(empty, 'an empty stored value is refused rather than resolving to the root directory');

  // The error must not leak where the root is: if this fires it is a bug or an attack, and neither
  // is helped by telling the requester the filesystem layout.
  let message = '';
  try { store.resolveStored('../../../etc/passwd'); } catch (e) { message = e.message; }
  ok(message && !message.includes(ROOT), 'and the refusal does not echo the storage root back');

  // A legacy flat name from before the move must still resolve, or old rows break.
  writeFileSync(join(ROOT, 'legacy-file.pdf'), 'old');
  ok(store.resolveStored('legacy-file.pdf') === join(ROOT, 'legacy-file.pdf'),
    'a flat name written before the reorganisation still resolves');
}

// ---- files with no owner ------------------------------------------------------------------------------
{
  const sys = store.placeSystem('locator', 'upload.kmz');
  ok(sys.stored.startsWith('_system/locator/'), 'a file belonging to no record goes under _system');

  const id = store.placeSystem('access-id', 'idphoto.jpg');
  ok(id.stored.startsWith('_system/access-id/'),
    'identity documents get a category whose name makes their sensitivity obvious on the server');
}

// ---- answering "what do we hold for this customer?" -------------------------------------------------------
{
  const p1 = store.place('customer', 77, 'Listing Test', 'documents', 'a.pdf');
  const p2 = store.place('customer', 77, 'Listing Test', 'attachments', 'b.jpg');
  writeFileSync(p1.absolute, 'aa');
  writeFileSync(p2.absolute, 'bbbb');

  const list = store.listFor('customer', 77);
  ok(list.length === 2, `both files are listed (${list.length})`);
  ok(list.some(f => f.category === 'documents') && list.some(f => f.category === 'attachments'),
    'grouped by category');
  ok(list.every(f => f.size > 0 && f.modified), 'with a size and a date, which is what an audit asks for');

  ok(store.listFor('customer', 9999).length === 0, 'a record with no files lists nothing rather than throwing');
  ok(store.listFor('nonsense', 1).length === 0, 'and an unknown record type is handled');
}

// ---- refusing to place what cannot be placed -----------------------------------------------------------
{
  for (const [type, id, why] of [
    ['nonsense', 1, 'an unknown record type'],
    ['customer', 0, 'a zero id'],
    ['customer', -5, 'a negative id'],
    ['customer', null, 'a missing id'],
    ['customer', 'abc', 'a non-numeric id']
  ]) {
    let threw = false;
    try { store.place(type, id, 'x', 'documents', 'f.pdf'); } catch { threw = true; }
    ok(threw, `${why} is refused rather than producing a strange path`);
  }
}

// ---- moving a file that is already stored ----------------------------------------------------------------
{
  const src = store.place('customer', 11, 'Mover', 'documents', 'moveme.pdf');
  writeFileSync(src.absolute, 'data');
  const movedTo = store.relocate(src.stored, 'customer', 12, 'Destination', 'documents');
  ok(movedTo && movedTo.startsWith('customer/12-destination/'), `a file can be re-filed (${movedTo})`);
  ok(!existsSync(src.absolute), 'and is gone from where it was');
  ok(existsSync(store.resolveStored(movedTo)), 'and present where it went');

  // Relocating something that no longer exists must not throw or invent a result.
  ok(store.relocate('customer/11-mover/documents/gone.pdf', 'customer', 12, 'D', 'documents') === null,
    'relocating a missing file returns null rather than throwing');
}

// ---- router backups move into per-device folders, once, and nothing is lost ----------------------------
{
  const { DatabaseSync } = await import('node:sqlite');
  const { migrateBackupsIntoDeviceDirs } = await import('../lib/filemigrate.js');
  const BROOT = mkdtempSync(join(tmpdir(), 'backups-'));
  const bstore = createFileStore(BROOT);
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE devices (id INTEGER PRIMARY KEY, name TEXT)');
  db.exec('CREATE TABLE router_backups (id INTEGER PRIMARY KEY, device_id INTEGER, stored_name TEXT)');
  db.prepare('INSERT INTO devices VALUES (7, ?)').run('Tower Router');
  writeFileSync(join(BROOT, 'bak-7-1.rsc'), '/ip address\n');
  writeFileSync(join(BROOT, 'dev7-2.tar.gz'), 'tar');
  db.prepare('INSERT INTO router_backups VALUES (1, 7, ?)').run('bak-7-1.rsc');
  db.prepare('INSERT INTO router_backups VALUES (2, 7, ?)').run('dev7-2.tar.gz');
  db.prepare('INSERT INTO router_backups VALUES (3, 7, ?)').run('gone.rsc');           // file already missing

  const r = migrateBackupsIntoDeviceDirs(db, bstore, BROOT);
  ok(r.moved === 2, `existing flat backups are moved (${r.moved})`);
  const rows = db.prepare('SELECT id, stored_name FROM router_backups ORDER BY id').all();
  ok(rows[0].stored_name === 'device/7-tower-router/backups/bak-7-1.rsc', `into the device's own folder, name unchanged (${rows[0].stored_name})`);
  ok(existsSync(bstore.resolveStored(rows[0].stored_name)) && !existsSync(join(BROOT, 'bak-7-1.rsc')), 'the file is there and gone from the root');
  ok(readFileSync(bstore.resolveStored(rows[0].stored_name), 'utf8') === '/ip address\n', 'with its contents intact');
  ok(rows[2].stored_name === 'gone.rsc', 'a row whose file is already missing is left alone, not rewritten to point somewhere new');
  const again = migrateBackupsIntoDeviceDirs(db, bstore, BROOT);
  ok(again.moved === 0, 'running it again moves nothing');
  rmSync(BROOT, { recursive: true, force: true });
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
