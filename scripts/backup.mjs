import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, chmod, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Publish a complete pair of private, standalone SQLite snapshots. */
export async function backupDatabases(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('DATA_DIR must name the application data directory.');
  const data = path.resolve(dataDir);
  const backups = path.join(data, 'backups');
  await mkdir(backups, { recursive: true, mode: 0o700 });
  await chmod(backups, 0o700);
  const stamp = `${new Date().toISOString().replace(/[-:.]/gu, '')}-${randomUUID().slice(0, 8)}`;
  const temporary = path.join(backups, `.pending-${stamp}`);
  const complete = path.join(backups, stamp);
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const name of ['ledger.sqlite', 'auth.sqlite']) {
      const sourcePath = path.join(data, name);
      if (!(await stat(sourcePath)).isFile()) throw new Error(`Missing database: ${name}`);
      const destination = path.join(temporary, name);
      // Pre-create privately; the SQLite backup API preserves the file permissions.
      await writeFile(destination, '', { flag: 'wx', mode: 0o600 });
      const source = new DatabaseSync(sourcePath, { readOnly: true });
      try {
        source.exec('PRAGMA busy_timeout = 5000');
        await backup(source, destination);
      } finally {
        source.close();
      }
      const snapshot = new DatabaseSync(destination);
      try {
        // The saved copy must be restorable without copying any WAL/SHM sidecars.
        snapshot.exec('PRAGMA journal_mode = DELETE');
        const integrity = snapshot.prepare('PRAGMA integrity_check').all();
        if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || snapshot.prepare('PRAGMA foreign_key_check').all().length) {
          throw new Error(`Backup validation failed: ${name}`);
        }
      } finally {
        snapshot.close();
      }
      await chmod(destination, 0o600);
    }
    // Incomplete or failed backups never appear as finished dated folders.
    await rename(temporary, complete);
    return complete;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const folder = await backupDatabases(process.env.DATA_DIR);
    console.log(`Validated database backup: ${folder}`);
  } catch (error) {
    console.error(`Backup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
