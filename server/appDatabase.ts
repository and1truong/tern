import { legacyDataFile, migrateAppDatabase } from "./legacyMigration.ts";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, basename, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { migrations } from "./migrations.ts";
import type { DbFile } from "../shared/types.ts";

export function openAppDatabase(path?: string) {
  if (path === undefined) {
    path = process.env.TERN_DATA_FILE ?? join(homedir(), ".tern", "app.sqlite");
    if (!process.env.TERN_DATA_FILE) migrateAppDatabase(legacyDataFile(), path);
  }
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true });
  // The WAL/SHM siblings are created under the process umask — lock them
  // down alongside the main file.
  if (path !== ":memory:") for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try { chmodSync(file, 0o600); } catch { /* sibling may not exist yet */ }
  }
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON");
  // The WAL/SHM files appear when the journal engages — chmod them now.
  if (path !== ":memory:") for (const file of [`${path}-wal`, `${path}-shm`]) {
    try { chmodSync(file, 0o600); } catch { /* still absent is fine */ }
  }
  db.exec("CREATE TABLE IF NOT EXISTS app_migrations (version INTEGER PRIMARY KEY)");
  db.transaction(() => {
    for (const migration of migrations) {
      if (db.query("SELECT 1 FROM app_migrations WHERE version = ?").get(migration.v)) continue;
      migration.up(db);
      db.query("INSERT INTO app_migrations VALUES (?)").run(migration.v);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recent_files (path TEXT PRIMARY KEY, opened_at INTEGER NOT NULL);`);
  })();
  return db;
}

export function sqlitePath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) throw new Error("An absolute SQLite file path is required");
  const path = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(path)) throw new Error("SQLite paths must be absolute");
  const resolved = realpathSync(path);
  if (!statSync(resolved).isFile()) throw new Error("SQLite path must be a regular file");
  return resolved;
}

export function recentFiles(db: Database): DbFile[] {
  return db.query<{ path: string }, []>("SELECT path FROM recent_files ORDER BY opened_at DESC").all().map(({ path }) => ({
    path, name: basename(path), sizeBytes: (() => { try { return statSync(path).size; } catch { return 0; } })(),
  }));
}
