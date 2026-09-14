import { expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openAppDatabase } from "./appDatabase.ts";
import { migrateAppDatabase, withLegacyCredentials } from "./legacyMigration.ts";
import { makeConnections, type SecretStore } from "./connections.ts";

function secrets(values = new Map<string, string>()): SecretStore {
  return { get: async name => values.get(name) ?? null, set: async (name, value) => { values.set(name, value); }, delete: async name => values.delete(name) };
}

test("legacy migration preserves committed WAL connections, credentials and app state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tern-migration-"));
  const source = join(dir, "legacy.sqlite");
  const target = join(dir, "tern", "app.sqlite");
  const old = openAppDatabase(source);
  const oldSecrets = new Map<string, string>();
  const currentSecrets = new Map<string, string>();
  const saved = await makeConnections(old, secrets(oldSecrets)).save("saved", "postgres://user:fixture@localhost/test");
  old.query("INSERT INTO app_state VALUES (?, ?)").run("workspace", JSON.stringify({ sql: "SELECT 42", activeId: saved.id }));
  old.query("INSERT INTO recent_files VALUES (?, ?)").run("/tmp/example.sqlite", 1);
  migrateAppDatabase(source, target); // source remains open with WAL writes
  const migrated = openAppDatabase(target);
  const connections = makeConnections(migrated, withLegacyCredentials(secrets(currentSecrets), secrets(oldSecrets)));
  expect((await connections.list()).map(c => c.id)).toEqual([saved.id]);
  expect(await connections.resolveUrl(saved.id) === oldSecrets.get(`connection:${saved.id}`)).toBe(true);
  expect(currentSecrets.has(`connection:${saved.id}`)).toBe(true);
  expect(oldSecrets.has(`connection:${saved.id}`)).toBe(true);
  expect(migrated.query("SELECT * FROM app_state").all()).toEqual(old.query("SELECT * FROM app_state").all());
  expect(migrated.query("SELECT * FROM recent_files").all()).toEqual(old.query("SELECT * FROM recent_files").all());
  expect(statSync(target).mode & 0o777).toBe(0o600);
  migrated.query("UPDATE app_state SET value = 'new Tern state'").run();
  migrateAppDatabase(source, target);
  expect(migrated.query("SELECT value FROM app_state").get()).toEqual({ value: "new Tern state" });
  migrated.close(); old.close();
});

test("Tern credentials win and failed migration leaves legacy credentials intact", async () => {
  const old = new Map([['connection:x', 'legacy-fixture']]);
  const current = new Map([['connection:x', 'tern-fixture']]);
  expect(await withLegacyCredentials(secrets(current), secrets(old)).get('connection:x') === current.get('connection:x')).toBe(true);
  const failing = { ...secrets(), set: async () => { throw new Error('locked'); } };
  await expect(withLegacyCredentials(failing, secrets(old)).get('connection:x')).rejects.toThrow('locked');
  expect(old.has('connection:x')).toBe(true);
});

test("plaintext legacy rows never replace an existing Tern credential", async () => {
  const db = openAppDatabase(':memory:');
  db.query('INSERT INTO pg_connections(id,label,url) VALUES(?,?,?)').run('same', 'legacy', 'postgres://old:fixture@localhost/old');
  const current = new Map([['connection:same', 'postgres://new:fixture@localhost/new']]);
  const connections = makeConnections(db, withLegacyCredentials(secrets(current), secrets()));
  expect(await connections.resolveUrl('same') === current.get('connection:same')).toBe(true);
  expect((await connections.get('same'))?.url).toBe('postgres://new@localhost/new');
  db.close();
});
