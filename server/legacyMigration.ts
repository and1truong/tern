import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, linkSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
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
  // A corrupt or non-SQLite legacy file must not brick startup — the
  // migration is a convenience, not a gate.
  let legacy: Database | null = null;
  let serialized: Uint8Array;
  try { legacy = new Database(source, { readonly: true }); serialized = legacy.serialize(); }
  catch (error) {
    legacy?.close();
    console.warn(`Skipping legacy database migration: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    // SQLite serialization includes committed WAL pages; copying the file alone does not.
    writeFileSync(temporary, serialized, { flag: "wx", mode: 0o600 });
    try { linkSync(temporary, destination); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EXDEV") {
        // Cross-device destination: copy then hard-link inside the target
        // filesystem — linkSync refuses an existing destination where
        // renameSync would silently replace it.
        const staged = `${destination}.${crypto.randomUUID()}.staging`;
        try {
          copyFileSync(temporary, staged);
          try { linkSync(staged, destination); }
          catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") throw linkError; }
        } finally {
          if (existsSync(staged)) unlinkSync(staged);
        }
      } else if (code !== "EEXIST") throw error;
    }
  } finally {
    legacy!.close();
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function withLegacyCredentials(current: SecretStore, legacy: SecretStore): SecretStore {
  // The keychain has no CAS — serialize operations per name so the get()
  // copy-back can't clobber a concurrent set() with the stale legacy value
  // (and a set can't slip between the double-check and the copy-back).
  const pending = new Map<string, Promise<unknown>>();
  const enqueue = <T>(name: string, op: () => Promise<T>): Promise<T> => {
    const run = (pending.get(name) ?? Promise.resolve()).catch(() => {}).then(op);
    pending.set(name, run);
    // finally() would forward run's rejection on a discarded promise —
    // then(settle, settle) cleans up without an unhandled rejection.
    const settle = () => { if (pending.get(name) === run) pending.delete(name); };
    void run.then(settle, settle);
    return run;
  };
  return {
    ...current,
    get: (name) => enqueue(name, async () => {
      const present = await current.get(name);
      if (present !== null) return present;
      const old = await legacy.get(name);
      if (old === null) return null;
      const newer = await current.get(name);
      if (newer !== null) return newer;
      // The copy-back is a convenience, not a gate: when the new store refuses
      // the write the credential is still valid and retries next time.
      try { await current.set(name, old); } catch { /* legacy stays readable */ }
      // Leave the old credential available to the untouched legacy database.
      return old;
    }),
    set: (name, value) => enqueue(name, () => current.set(name, value)),
    delete: (name) => enqueue(name, () => current.delete(name)),
  };
}
