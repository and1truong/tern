import type { Database } from "bun:sqlite";
interface Migration { v: number; up(db: Database): void }

export const migrations: Migration[] = [
  {
    v: 1,
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS pg_connections (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        url TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_used_at INTEGER
      )`);
    },
  },
  {
    v: 2,
    up: (db) => {
      // Full credential URLs live in Bun.secrets (OS credential storage).
      // `url` is retained as the password-free connection descriptor.
      db.exec("ALTER TABLE pg_connections ADD COLUMN secret_name TEXT");
    },
  },
  {
    v: 3,
    up: (db) => {
      db.exec("ALTER TABLE pg_connections ADD COLUMN environment TEXT NOT NULL DEFAULT 'development'");
      db.exec("ALTER TABLE pg_connections ADD COLUMN read_only INTEGER NOT NULL DEFAULT 1");
    },
  },
  {
    v: 4,
    up: (db) => {
      // Profiles are driver-generic since Redis/Valkey support; legacy files
      // keep the pg_connections table until this migration runs on them. A
      // hand-edited file may record v1-v3 without the table existing at all.
      const legacy = db.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pg_connections'",
      ).get();
      if (legacy) {
        db.exec("ALTER TABLE pg_connections RENAME TO datasource_connections");
        db.exec("ALTER TABLE datasource_connections ADD COLUMN driver TEXT NOT NULL DEFAULT 'postgres'");
      } else {
        db.exec(`CREATE TABLE IF NOT EXISTS datasource_connections (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          url TEXT NOT NULL,
          secret_name TEXT,
          environment TEXT NOT NULL DEFAULT 'development',
          read_only INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          last_used_at INTEGER,
          driver TEXT NOT NULL DEFAULT 'postgres'
        )`);
      }
    },
  },
];
