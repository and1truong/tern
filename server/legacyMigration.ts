import { Database } from "bun:sqlite";
import { existsSync, linkSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { SecretStore } from "./connections.ts";

// Only migration reads these legacy names; new writes always use Tern names.
export const LEGACY_SECRET_SERVICE = "dev.dbm.credentials";
export function legacyDataFile() {
  return process.env.DBM_DATA_FILE ?? join(homedir(), ".dbm", "app.sqlite");
}

export function migrateAppDatabase(source: string, destination: string): void {
  if (existsSync(destination) || !existsSync(source)) return;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${crypto.randomUUID()}.migration`;
  const legacy = new Database(source, { readonly: true });
  try {
    // SQLite serialization includes committed WAL pages; copying the file alone does not.
    writeFileSync(temporary, legacy.serialize(), { flag: "wx", mode: 0o600 });
    try { linkSync(temporary, destination); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally {
    legacy.close();
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function withLegacyCredentials(current: SecretStore, legacy: SecretStore): SecretStore {
  return {
    ...current,
    async get(name) {
      const present = await current.get(name);
      if (present !== null) return present;
      const old = await legacy.get(name);
      if (old === null) return null;
      const newer = await current.get(name);
      if (newer !== null) return newer;
      await current.set(name, old);
      // Leave the old credential available to the untouched legacy database.
      return old;
    },
  };
}
