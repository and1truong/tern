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
      const table = (name: string) => db.query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",).get(name);
      const legacy = table("pg_connections");
      const current = table("datasource_connections");
      if (legacy && !current) {
        db.exec("ALTER TABLE pg_connections RENAME TO datasource_connections");
      } else if (!legacy && !current) {
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
      // datasource_connections exists in every branch now, but may predate
      // later columns (hand-edited or partially-migrated files) — add what is
      // missing before any merge below. created_at gets a plain nullable
      // column because ALTER cannot take an expression default.
      const ensureColumn = (name: string, ddl: string) => {
        const present = db.query<{ name: string }, [string]>(
          "SELECT name FROM pragma_table_info('datasource_connections') WHERE name = ?").get(name);
        if (!present) db.exec(`ALTER TABLE datasource_connections ADD COLUMN ${ddl}`);
      };
      ensureColumn("secret_name", "secret_name TEXT");
      ensureColumn("environment", "environment TEXT NOT NULL DEFAULT 'development'");
      ensureColumn("read_only", "read_only INTEGER NOT NULL DEFAULT 1");
      ensureColumn("created_at", "created_at INTEGER");
      ensureColumn("last_used_at", "last_used_at INTEGER");
      ensureColumn("driver", "driver TEXT NOT NULL DEFAULT 'postgres'");
      // The 'postgres' default mislabels redis-scheme rows in a driver-less
      // pre-v4 file — re-derive the driver from the URL scheme.
      db.exec("UPDATE datasource_connections SET driver = 'redis' WHERE driver = 'postgres' AND (url LIKE 'redis://%' OR url LIKE 'rediss://%')");
      if (legacy && current) {
        // A mixed file (both tables present) cannot rename — merge the legacy
        // rows instead, then drop the old table so this path never repeats.
        // A v1-shaped legacy table lacks later columns; select defaults for
        // whatever is absent rather than aborting the migration.
        const cols = new Set(
          db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('pg_connections')")
            .all().map(r => r.name));
        const col = (name: string, fallback: string) => cols.has(name) ? name : `${fallback} AS ${name}`;
        db.exec(`INSERT OR IGNORE INTO datasource_connections
          (id, label, url, secret_name, environment, read_only, created_at, last_used_at, driver)
          SELECT id, label, url,
            ${col("secret_name", "NULL")},
            ${col("environment", "'development'")},
            ${col("read_only", "1")},
            ${col("created_at", "unixepoch()")},
            ${col("last_used_at", "NULL")},
            'postgres' FROM pg_connections`);
        db.exec("DROP TABLE pg_connections");
      }
    },
  },
];
