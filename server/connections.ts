import { LEGACY_SECRET_SERVICE, withLegacyCredentials } from "./legacyMigration.ts";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ConnectionProfile } from "../shared/types.ts";
import { validateRedisUrl } from "../datasources/redis/connection.ts";

const SECRET_SERVICE = "dev.tern.credentials";

interface ConnectionRow {
  id: string;
  label: string;
  driver: string;
  url: string;
  secret_name: string | null;
  environment: ConnectionProfile["environment"];
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

// Per-driver connection-url validation. Adding a backend means registering its
// validator here (and its driver in server/app.ts's registry).
const defaultValidators: Record<string, (url: string) => void> = {
  postgres: validateConnectionUrl,
  redis: validateRedisUrl,
};

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

const toProfile = (row: ConnectionRow): ConnectionProfile => ({
  id: row.id,
  label: row.label,
  driver: row.driver,
  url: sanitizedUrl(row.url),
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  environment: row.environment,
  readOnly: row.read_only === 1,
});

export interface Connections {
  list(): Promise<ConnectionProfile[]>;
  get(id: string): Promise<ConnectionProfile | null>;
  resolveUrl(id: string): Promise<string | null>;
  save(driver: string, label: string, url: string, options?: { id?: string; environment?: ConnectionProfile["environment"]; readOnly?: boolean }): Promise<ConnectionProfile>;
  touch(id: string): void;
  delete(id: string): Promise<boolean>;
}

export function makeConnections(db: Database, secrets: SecretStore = systemSecrets, validators: Record<string, (url: string) => void> = defaultValidators): Connections {
  const row = (id: string) =>
    db.query<ConnectionRow, [string]>("SELECT * FROM datasource_connections WHERE id = ?").get(id) ?? null;

  const api: Connections = {
    list: async () =>
      db.query<ConnectionRow, []>("SELECT * FROM datasource_connections ORDER BY last_used_at DESC NULLS LAST, label")
        .all().map(toProfile),
    get: async (id) => {
      const found = row(id);
      return found ? toProfile(found) : null;
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
      db.query("UPDATE datasource_connections SET url = ?, secret_name = ? WHERE id = ?")
        .run(sanitizedUrl(migratedUrl), secretName, found.id);
      return migratedUrl;
    },
    save: async (driver, label, url, options = {}) => {
      const validate = validators[driver];
      if (!validate) throw new Error(`Unknown driver "${driver}"`);
      validate(url);
      const id = options.id ?? randomUUID();
      const environment = options.environment ?? "development";
      const readOnly = options.readOnly ?? true;
      const secretName = `connection:${id}`;
      const secret = hasPassword(url) ? secretName : null;
      if (secret) await secrets.set(secret, url);
      else await secrets.delete(secretName).catch(() => false);
      try {
        db.query(
          "INSERT INTO datasource_connections (id, label, driver, url, secret_name, environment, read_only) VALUES (?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET label = excluded.label, driver = excluded.driver, url = excluded.url, secret_name = excluded.secret_name, environment = excluded.environment, read_only = excluded.read_only",
        ).run(id, label, driver, sanitizedUrl(url), secret, environment, readOnly ? 1 : 0);
      } catch (error) {
        if (secret) await secrets.delete(secret).catch(() => false);
        throw error;
      }
      const saved = await api.get(id);
      if (!saved) throw new Error("save failed");
      return saved;
    },
    touch: (id) => { db.query("UPDATE datasource_connections SET last_used_at = unixepoch() WHERE id = ?").run(id); },
    delete: async (id) => {
      const found = row(id);
      if (found?.secret_name) await secrets.delete(found.secret_name);
      return db.query("DELETE FROM datasource_connections WHERE id = ?").run(id).changes > 0;
    },
  };
  return api;
}
