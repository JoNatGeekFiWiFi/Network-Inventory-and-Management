// Moving the existing flat uploads/ into per-record directories.
//
// This runs at startup and must be safe to run on every start, on a half-migrated directory, and on
// one somebody has already tidied by hand. The rules it works to:
//
//   * MOVE, THEN RECORD. The database row is only updated after the file is definitely at its new
//     path. Updating first and crashing would leave a row pointing at nothing.
//   * NEVER OVERWRITE. If something already sits at the destination, the move is skipped and
//     reported. Losing a file to a name collision is the one outcome worth any amount of caution.
//   * A ROW THAT CANNOT BE PLACED IS LEFT ALONE. An attachment whose parent record has been deleted
//     has nowhere to go; it stays flat and is counted, rather than being guessed at or discarded.
//   * IDEMPOTENT. A stored value containing a slash is already migrated and is skipped, so the
//     second run does nothing and says so.
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const ALREADY_MIGRATED = (v) => String(v || '').includes('/');

/**
 * @param db        the database
 * @param store     a file store from lib/filestore.js
 * @param uploadsDir the old flat directory (the store's root)
 */
export function migrateFilesIntoRecordDirs(db, store, uploadsDir) {
  const report = { moved: 0, skipped: 0, orphaned: 0, collisions: [], errors: [], byTable: {} };

  const count = (table, key) => {
    report.byTable[table] = report.byTable[table] || { moved: 0, skipped: 0, orphaned: 0 };
    report.byTable[table][key]++;
    report[key]++;
  };

  /** Move one file and update one column, or explain why not. */
  const moveOne = ({ table, idColumn, id, column, stored, parentType, parentId, parentName, category }) => {
    if (!stored || ALREADY_MIGRATED(stored)) { count(table, 'skipped'); return; }
    const from = join(uploadsDir, stored);
    if (!existsSync(from)) { count(table, 'skipped'); return; }      // row points at a file that is gone
    if (!parentType || !parentId) { count(table, 'orphaned'); return; }

    try {
      const target = store.place(parentType, parentId, parentName || '', category, stored);
      if (existsSync(target.absolute)) {
        report.collisions.push({ table, id, stored, target: target.stored });
        count(table, 'skipped');
        return;
      }
      // Rename first. Only once the bytes are certainly at the new path does the row change.
      const moved = store.relocate(stored, parentType, parentId, parentName || '', category);
      if (!moved) { count(table, 'skipped'); return; }
      db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${idColumn}=?`).run(moved, id);
      count(table, 'moved');
    } catch (e) {
      report.errors.push({ table, id, stored, error: e.message });
      count(table, 'skipped');
    }
  };

  // ---- note attachments: photos and PDFs hung off a site or POP note --------------------------------
  try {
    for (const r of db.prepare('SELECT id, parent_type, parent_id, stored_name FROM note_attachments').all()) {
      moveOne({
        table: 'note_attachments', idColumn: 'id', id: r.id, column: 'stored_name',
        stored: r.stored_name,
        parentType: r.parent_type, parentId: r.parent_id,
        parentName: nameOf(db, r.parent_type, r.parent_id),
        category: 'attachments'
      });
    }
  } catch (e) { report.errors.push({ table: 'note_attachments', error: e.message }); }

  // ---- documents: both the as-sent and the signed copy ------------------------------------------------
  try {
    for (const r of db.prepare('SELECT id, parent_type, parent_id, stored_name, signed_stored_name FROM documents').all()) {
      const name = nameOf(db, r.parent_type, r.parent_id);
      for (const column of ['stored_name', 'signed_stored_name']) {
        moveOne({
          table: 'documents', idColumn: 'id', id: r.id, column,
          stored: r[column], parentType: r.parent_type, parentId: r.parent_id,
          parentName: name, category: 'documents'
        });
      }
    }
  } catch (e) { report.errors.push({ table: 'documents', error: e.message }); }

  // ---- visitor ID photos ---------------------------------------------------------------------------
  //
  // These are government identity documents, and they belong to the ACCESS REQUEST, not to a site —
  // one request can cover several sites, so filing the photo under a site would be a guess. They go
  // to _system/access-id/ where their sensitivity is obvious from the path and a retention rule can
  // find them all without a query.
  try {
    for (const r of db.prepare('SELECT id, id_photo FROM access_requests WHERE id_photo IS NOT NULL').all()) {
      if (ALREADY_MIGRATED(r.id_photo)) { count('access_requests', 'skipped'); continue; }
      const from = join(uploadsDir, r.id_photo);
      if (!existsSync(from)) { count('access_requests', 'skipped'); continue; }
      try {
        const target = store.placeSystem('access-id', r.id_photo);
        if (existsSync(target.absolute)) { report.collisions.push({ table: 'access_requests', id: r.id }); count('access_requests', 'skipped'); continue; }
        renameSync(from, target.absolute);
        db.prepare('UPDATE access_requests SET id_photo=? WHERE id=?').run(target.stored, r.id);
        count('access_requests', 'moved');
      } catch (e) {
        report.errors.push({ table: 'access_requests', id: r.id, error: e.message });
        count('access_requests', 'skipped');
      }
    }
  } catch (e) { report.errors.push({ table: 'access_requests', error: e.message }); }

  // ---- locator uploads: belong to nobody ------------------------------------------------------------------
  try {
    for (const r of db.prepare('SELECT id, stored_name FROM locator_uploads WHERE stored_name IS NOT NULL').all()) {
      if (ALREADY_MIGRATED(r.stored_name)) { count('locator_uploads', 'skipped'); continue; }
      const from = join(uploadsDir, r.stored_name);
      if (!existsSync(from)) { count('locator_uploads', 'skipped'); continue; }
      try {
        const target = store.placeSystem('locator', r.stored_name);
        if (existsSync(target.absolute)) { report.collisions.push({ table: 'locator_uploads', id: r.id, stored: r.stored_name }); count('locator_uploads', 'skipped'); continue; }
        renameSync(from, target.absolute);
        db.prepare('UPDATE locator_uploads SET stored_name=? WHERE id=?').run(target.stored, r.id);
        count('locator_uploads', 'moved');
      } catch (e) {
        report.errors.push({ table: 'locator_uploads', id: r.id, error: e.message });
        count('locator_uploads', 'skipped');
      }
    }
  } catch (e) { report.errors.push({ table: 'locator_uploads', error: e.message }); }

  return report;
}

/** The record's own name, for the readable part of its directory. Missing is fine. */
function nameOf(db, type, id) {
  const table = {
    customer: 'customers', site: 'sites', pop: 'pops',
    cable: 'fiber_cables', splice: 'fiber_splices', structure: 'fiber_structures',
    route: 'fiber_routes', device: 'devices', vendor: 'upstream_providers'
  }[type];
  if (!table || !id) return '';
  try {
    const row = db.prepare(`SELECT name FROM ${table} WHERE id=?`).get(id);
    return row ? row.name : '';
  } catch { return ''; }
}

/**
 * Router config backups: backups/<flat name> → backups/device/<id>-<name>/backups/<same name>.
 * Same rules as above — move then record, never overwrite, idempotent (a slash means done).
 */
export function migrateBackupsIntoDeviceDirs(db, store, backupsDir) {
  const report = { moved: 0, skipped: 0, errors: [] };
  let rows = [];
  try { rows = db.prepare('SELECT b.id, b.device_id, b.stored_name, d.name FROM router_backups b LEFT JOIN devices d ON d.id=b.device_id WHERE b.stored_name IS NOT NULL').all(); }
  catch (e) { report.errors.push({ error: e.message }); return report; }
  for (const r of rows) {
    if (ALREADY_MIGRATED(r.stored_name) || !r.device_id) { report.skipped++; continue; }
    if (!existsSync(join(backupsDir, r.stored_name))) { report.skipped++; continue; }
    try {
      const moved = store.relocate(r.stored_name, 'device', r.device_id, r.name || '', 'backups');
      if (!moved) { report.skipped++; continue; }
      db.prepare('UPDATE router_backups SET stored_name=? WHERE id=?').run(moved, r.id);
      report.moved++;
    } catch (e) { report.errors.push({ id: r.id, error: e.message }); }
  }
  return report;
}
