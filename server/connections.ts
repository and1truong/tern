import { LEGACY_SECRET_SERVICE, withLegacyCredentials } from "./legacyMigration.ts";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { PgConnection } from "../shared.ts";

const SECRET_SERVICE = "dev.tern.credentials";

interface PgConnectionRow {
  id: string;
  label: string;
  url: string;
  secret_name: string | null;
  environment: PgConnection["environment"];
  read_only: number;
  created_at: number;
  last_used_at: number | null;
}

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

const systemSecrets: SecretStore = withLegacyCredentials({
  get: (name) => Bun.secrets.get({ service: SECRET_SERVICE, name }),
  set: (name, value) => Bun.secrets.set({ service: SECRET_SERVICE, name, value, allowUnrestrictedAccess: false }),
  delete: (name) => Bun.secrets.delete({ service: SECRET_SERVICE, name }),
}, {
  get: (name) => Bun.secrets.get({ service: LEGACY_SECRET_SERVICE, name }),
  set: async () => { throw new Error("Legacy credentials are read-only"); },
  delete: async () => false,
});

export function validateConnectionUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Invalid PostgreSQL URL"); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('A PostgreSQL URL with a host is required');
  const ssl = parsed.searchParams.get("sslmode");
  if (ssl && !["disable", "prefer", "require", "verify-ca", "verify-full"].includes(ssl)) throw new Error("Invalid SSL mode");
  for (const key of parsed.searchParams.keys()) {
    if (!['sslmode', 'application_name', 'connect_timeout'].includes(key)) throw new Error(`Unsupported PostgreSQL URL option: ${key}`);
  }
}

function sanitizedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = "";
    return parsed.toString();
  } catch { return url; }
}

function hasPassword(url: string): boolean {
  try { return new URL(url).password.length > 0; }
  catch { return false; }
}

const toPgConnection = (row: PgConnectionRow): PgConnection => ({
  id: row.id,
  label: row.label,
  url: sanitizedUrl(row.url),
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  environment: row.environment,
  readOnly: row.read_only === 1,
});

export interface Connections {
  list(): Promise<PgConnection[]>;
  get(id: string): Promise<PgConnection | null>;
  resolveUrl(id: string): Promise<string | null>;
  save(label: string, url: string, options?: { id?: string; environment?: PgConnection["environment"]; readOnly?: boolean }): Promise<PgConnection>;
  touch(id: string): void;
  delete(id: string): Promise<boolean>;
}

export function makeConnections(db: Database, secrets: SecretStore = systemSecrets): Connections {
  const row = (id: string) =>
    db.query<PgConnectionRow, [string]>("SELECT * FROM pg_connections WHERE id = ?").get(id) ?? null;

  const api: Connections = {
    list: async () =>
      db.query<PgConnectionRow, []>("SELECT * FROM pg_connections ORDER BY last_used_at DESC NULLS LAST, label")
        .all().map(toPgConnection),
    get: async (id) => {
      const found = row(id);
      return found ? toPgConnection(found) : null;
    },
    resolveUrl: async (id) => {
      const found = row(id);
      if (!found) return null;
      if (found.secret_name) {
        const secret = await secrets.get(found.secret_name);
        if (!secret) throw new Error(`credential unavailable for connection "${found.label}"`);
        return secret;
      }
      if (!hasPassword(found.url)) return found.url;

      // Lazy migration for v1 rows: persist securely before scrubbing SQLite.
      const secretName = `connection:${found.id}`;
      const existing = await secrets.get(secretName);
      const migratedUrl = existing ?? found.url;
      if (existing === null) await secrets.set(secretName, migratedUrl);
      db.query("UPDATE pg_connections SET url = ?, secret_name = ? WHERE id = ?")
        .run(sanitizedUrl(migratedUrl), secretName, found.id);
      return migratedUrl;
    },
    save: async (label, url, options = {}) => {
      validateConnectionUrl(url);
      const id = options.id ?? randomUUID();
      const environment = options.environment ?? "development";
      const readOnly = options.readOnly ?? true;
      const secretName = `connection:${id}`;
      const secret = hasPassword(url) ? secretName : null;
      if (secret) await secrets.set(secret, url);
      else await secrets.delete(secretName).catch(() => false);
      try {
        db.query(
          "INSERT INTO pg_connections (id, label, url, secret_name, environment, read_only) VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET label = excluded.label, url = excluded.url, secret_name = excluded.secret_name, environment = excluded.environment, read_only = excluded.read_only",
        ).run(id, label, sanitizedUrl(url), secret, environment, readOnly ? 1 : 0);
      } catch (error) {
        if (secret) await secrets.delete(secret).catch(() => false);
        throw error;
      }
      const saved = await api.get(id);
      if (!saved) throw new Error("save failed");
      return saved;
    },
    touch: (id) => { db.query("UPDATE pg_connections SET last_used_at = unixepoch() WHERE id = ?").run(id); },
    delete: async (id) => {
      const found = row(id);
      if (found?.secret_name) await secrets.delete(found.secret_name);
      return db.query("DELETE FROM pg_connections WHERE id = ?").run(id).changes > 0;
    },
  };
  return api;
}
