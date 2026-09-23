// Where files live on disk, and how a path is proved safe before anything opens it.
//
// Everything used to go into one flat uploads/ directory with a random filename, and the database
// was the only index. That is safe but opaque: on the server you see six hundred files called
// doc-41-8a23.pdf and cannot answer "what do we hold for this customer?" without a query. When
// somebody asks that question it is usually during an audit, a dispute, or a subject access
// request — none of which are good moments to be writing SQL.
//
// So files are grouped by the record they belong to:
//
//   uploads/customer/42-acme-logistics/documents/…
//   uploads/site/7-1200-e-washington/attachments/…
//   uploads/site/7-1200-e-washington/access-id/…      (restricted: identity documents)
//   uploads/pop/3-pop-phx01/documents/…
//   uploads/_system/locator/…                          (not owned by any record)
//
// THE SLUG IS A HINT, NOT AN IDENTITY. The directory is found by its numeric id; the readable part
// is there for a person browsing over SSH. Renaming a customer does not move their files and does
// not break anything, because nothing resolves by name — a stale slug is cosmetic.
//
// PATH SAFETY IS THE WHOLE POINT OF THIS FILE. Every stored path now contains components derived
// from user-supplied data, where before it was a hex string. That is exactly how directory
// traversal gets introduced. Two defences, both applied every time: components are sanitised when
// written, and every resolved path is proved to sit inside the root before it is opened.
import { mkdirSync, existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

// Every record type a file can hang off. Kept in step with ATT_PARENTS in server.js — that list is
// the API's allow-list for attachments, and a type accepted there but rejected here would mean an
// upload that validates and then fails to save, which is the most annoying possible order to fail in.
//
// 'customer' is here for documents, which attach to a customer that has no attachments of its own;
// the fibre types come from the plant records.
export const PARENTS = ['customer', 'site', 'pop', 'cable', 'splice', 'structure', 'route', 'device', 'vendor'];
export const CATEGORIES = ['documents', 'attachments', 'receipts', 'access-id', 'backups', 'other'];

/**
 * A readable, safe directory-name fragment.
 *
 * Everything outside [a-z0-9-] goes, which removes the interesting characters — slashes, dots,
 * NULs, unicode lookalikes — rather than trying to enumerate what is dangerous. A name that
 * sanitises to nothing yields '' and the directory is just its id, which is still correct.
 */
export function slug(name, max = 40) {
  return String(name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip accents rather than dropping the letter
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/** Is this name already safe to use verbatim? Used when moving a file that is already stored. */
function isAlreadySafe(name) {
  const n = String(name || '');
  return n.length > 0 && n.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n) && !n.includes('..');
}

/** A stored filename: safe characters only, always with a random part so nothing collides. */
export function safeFilename(original, { prefix = '', ext = '' } = {}) {
  const base = String(original || '')
    .replace(/^.*[\\/]/, '')                              // never trust a path in a filename
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')                                // no leading dot: not a hidden file
    .slice(0, 60) || 'file';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const suffix = ext || (dot > 0 ? base.slice(dot) : '');
  const rand = randomBytes(6).toString('hex');
  return `${prefix ? prefix + '-' : ''}${stem}-${rand}${suffix}`.replace(/-+/g, '-');
}

export function createFileStore(root) {
  const ROOT = resolve(root);
  try { mkdirSync(ROOT, { recursive: true }); } catch {}

  /**
   * Find (or create) the directory for one record.
   *
   * Looks for an existing directory starting "<id>-" or named exactly "<id>" before creating one,
   * so a record that has been renamed keeps using the folder it already has rather than growing a
   * second one under the new name.
   */
  function recordDir(parentType, parentId, name = '', { create = true } = {}) {
    if (!PARENTS.includes(parentType)) throw new Error(`Unknown record type "${parentType}"`);
    const id = Number(parentId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('A record id is required to store a file');

    const typeDir = join(ROOT, parentType);
    if (create) { try { mkdirSync(typeDir, { recursive: true }); } catch {} }

    let dirName = null;
    if (existsSync(typeDir)) {
      // The trailing dash in the prefix is what stops a search for 4 matching "42-acme".
      // Sorted, so that if a record somehow has two directories the same one is chosen every
      // time — an arbitrary readdir order would scatter one record's files across both.
      const wanted = `${id}-`;
      const matches = readdirSync(typeDir).filter(e => e === String(id) || e.startsWith(wanted)).sort();
      if (matches.length) dirName = matches[0];
    }
    if (!dirName) {
      const s = slug(name);
      dirName = s ? `${id}-${s}` : String(id);
    }
    const dir = join(typeDir, dirName);
    if (create) { try { mkdirSync(dir, { recursive: true }); } catch {} }
    return { dir, rel: `${parentType}/${dirName}` };
  }

  /**
   * Reserve a place for a new file. Returns the path to write and the value to store in the DB.
   *
   * The stored value is RELATIVE and uses forward slashes regardless of platform, because it goes
   * into a database that may outlive the machine it was written on.
   */
  function place(parentType, parentId, parentName, category, originalName, opts = {}) {
    const cat = CATEGORIES.includes(category) ? category : 'other';
    const { dir, rel } = recordDir(parentType, parentId, parentName);
    const catDir = join(dir, cat);
    try { mkdirSync(catDir, { recursive: true }); } catch {}
    // `keepName` is for moving a file that already has a unique, safe name. Re-randomising it would
    // append a second hash to a name that already had one, and break the continuity between the
    // name in an old backup and the name on disk now.
    const filename = opts.keepName && isAlreadySafe(originalName)
      ? originalName
      : safeFilename(originalName, opts);
    return {
      absolute: join(catDir, filename),
      stored: `${rel}/${cat}/${filename}`
    };
  }

  /** The same, for files that belong to no record — the public locator's uploads. */
  function placeSystem(category, originalName, opts = {}) {
    const cat = String(category).replace(/[^a-z0-9-]+/gi, '') || 'other';
    const dir = join(ROOT, '_system', cat);
    try { mkdirSync(dir, { recursive: true }); } catch {}
    const filename = safeFilename(originalName, opts);
    return { absolute: join(dir, filename), stored: `_system/${cat}/${filename}` };
  }

  /**
   * Turn a stored value into an absolute path, or throw.
   *
   * THE SECURITY BOUNDARY. A stored value is data, and data can be wrong — through a bug, an
   * import, or someone editing the database. It is resolved and then proved to be inside the root,
   * which catches "../../etc/passwd" and every encoding of it, because the check is on the resolved
   * path rather than on the text.
   *
   * Legacy flat names ("doc-4-abc.pdf", no slash) still resolve, so rows written before the move
   * keep working whether or not the migration has run.
   */
  function resolveStored(stored) {
    const value = String(stored || '');
    if (!value) throw new Error('No stored file name');
    if (value.includes('\0')) throw new Error('Invalid stored file name');

    const abs = resolve(ROOT, value);
    if (abs !== ROOT && !abs.startsWith(ROOT + sep)) {
      // Deliberately not echoed back to the caller: if this ever fires it is either a bug or an
      // attack, and neither is helped by telling the requester what the root is.
      throw new Error('Refusing to open a file outside the storage root');
    }
    return abs;
  }

  /** Does it exist, and how big is it? Never throws for a missing file. */
  function stat(stored) {
    try { return statSync(resolveStored(stored)); } catch { return null; }
  }

  /**
   * Move a file that is already stored into a record's directory, returning the new stored value.
   *
   * Used by the migration and whenever something is re-parented. Never overwrites: a collision
   * would destroy the file already there, and the whole point of this module is not losing files.
   */
  function relocate(stored, parentType, parentId, parentName, category) {
    const from = resolveStored(stored);
    if (!existsSync(from)) return null;
    const target = place(parentType, parentId, parentName, category, basename(from), { keepName: true });
    if (existsSync(target.absolute)) return null;
    renameSync(from, target.absolute);
    return target.stored;
  }

  /** Everything held for one record, for the "what do we have on file?" question. */
  function listFor(parentType, parentId) {
    let dir;
    try { dir = recordDir(parentType, parentId, '', { create: false }).dir; } catch { return []; }
    if (!existsSync(dir)) return [];
    const out = [];
    for (const cat of readdirSync(dir)) {
      const catDir = join(dir, cat);
      let entries = [];
      try { if (!statSync(catDir).isDirectory()) continue; entries = readdirSync(catDir); } catch { continue; }
      for (const f of entries) {
        try {
          const st = statSync(join(catDir, f));
          if (st.isFile()) out.push({ category: cat, filename: f, size: st.size, modified: st.mtime.toISOString() });
        } catch {}
      }
    }
    return out;
  }

  return { ROOT, recordDir, place, placeSystem, resolveStored, stat, relocate, listFor, slug, safeFilename };
}
