import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { migrations } from "./migrations.ts";
import { makeConnections } from "./connections.ts";
import type { SecretStore } from "./connections.ts";

function freshDb() {
  const db = new Database(":memory:");
  for (const m of migrations) m.up(db);
  return db;
}

function fixture(store = new Map<string, string>()) {
  const db = freshDb();
  const secrets: SecretStore = {
    get: async (name) => store.get(name) ?? null,
    set: async (name, value) => { store.set(name, value); },
    delete: async (name) => store.delete(name),
  };
  return { db, store, connections: makeConnections(db, secrets) };
}

test("save stores credentials outside SQLite and resolves them", async () => {
  const { db, store, connections: c } = fixture();
  const saved = await c.save("postgres", "local", "postgres://u:p@h:5432/db");
  expect(saved.id).toBeTruthy();
  expect(saved.label).toBe("local");
  expect(saved.environment).toBe("development");
  expect(saved.readOnly).toBe(true);
  expect(saved.url).not.toContain(":p@");
  expect((await c.get(saved.id))?.label).toBe("local");
  expect(await c.resolveUrl(saved.id)).toBe("postgres://u:p@h:5432/db");
  expect(store.get(`connection:${saved.id}`)).toBe("postgres://u:p@h:5432/db");
  const row = db.query<{ url: string }, [string]>("SELECT url FROM datasource_connections WHERE id = ?").get(saved.id)!;
  expect(row.url).not.toContain(":p@");
});

test("save with explicit id upserts (label/url overwritten)", async () => {
  const c = fixture().connections;
  await c.save("postgres", "a", "postgres://1", { id: "fixed" });
  const again = await c.save("postgres", "b", "postgres://2", { id: "fixed" });
  expect(again.id).toBe("fixed");
  expect(again.label).toBe("b");
  expect((await c.list()).length).toBe(1);
});

test("list orders touched connections before untouched", async () => {
  const c = fixture().connections;
  const a = await c.save("postgres", "a", "postgres://a");
  await c.save("postgres", "b", "postgres://b");
  c.touch(a.id);
  expect((await c.list())[0].id).toBe(a.id);
});

test("delete removes the row and its secret", async () => {
  const { store, connections: c } = fixture();
  const s = await c.save("postgres", "x", "postgres://u:p@x/db");
  expect(await c.delete(s.id)).toBe(true);
  expect(await c.delete(s.id)).toBe(false);
  expect(await c.get(s.id)).toBeNull();
  expect(store.has(`connection:${s.id}`)).toBe(false);
});

test("legacy plaintext rows migrate lazily only after secure storage succeeds", async () => {
  const { db, store, connections: c } = fixture();
  db.query("INSERT INTO datasource_connections (id, label, driver, url) VALUES (?, ?, 'postgres', ?)")
    .run("legacy", "legacy", "postgres://u:secret@h/db");
  expect(await c.resolveUrl("legacy")).toBe("postgres://u:secret@h/db");
  const row = db.query<{ url: string; secret_name: string }, []>("SELECT url, secret_name FROM datasource_connections WHERE id = 'legacy'").get()!;
  expect(row.url).not.toContain("secret");
  // The migrated credential lives under a unique name — a concurrent
  // save()'s connection:<id> write can never be clobbered by the resolver.
  expect(row.secret_name).toMatch(/^connection:legacy:[0-9a-f-]{36}$/);
  expect(store.get(row.secret_name)).toBe("postgres://u:secret@h/db");
});

test("invalid connection descriptors and unavailable secret storage never persist plaintext", async () => {
  const db = freshDb();
  const connections = makeConnections(db, {
    get: async () => null, delete: async () => false,
    set: async () => { throw new Error('OS credential store unavailable'); },
  });
  for (const url of ['https://example.test', 'postgres://localhost/db?password=secret', 'postgres://localhost/db?sslmode=invalid', 'postgres://user:secret@localhost/db']) {
    await expect(connections.save('postgres', 'test', url)).rejects.toBeInstanceOf(Error);
  }
  expect(await connections.list()).toEqual([]);
  db.close();
});

test("credential deletion failure retains the profile for retry", async () => {
  const db = freshDb();
  const store = new Map<string, string>();
  let fail = true;
  const c = makeConnections(db, {
    get: async name => store.get(name) ?? null,
    set: async (name, value) => { store.set(name, value); },
    delete: async name => { if (fail) throw new Error("credential deletion denied"); return store.delete(name); },
  });
  try {
    const saved = await c.save("postgres", "test", "postgres://u:p@h/db");
    await expect(c.delete(saved.id)).rejects.toThrow("credential deletion denied");
    expect(await c.get(saved.id)).not.toBeNull();
    expect(store.size).toBe(1);
    fail = false;
    expect(await c.delete(saved.id)).toBe(true);
    expect(await c.get(saved.id)).toBeNull();
    expect(store.size).toBe(0);
  } finally { db.close(); }
});

test("migration v4 renames the profile table and backfills driver='postgres'", () => {
  const db = new Database(":memory:");
  // Only v1-v3: a pre-Redis database file.
  for (const m of migrations.filter(m => m.v < 4)) m.up(db);
  db.query("INSERT INTO pg_connections (id, label, url) VALUES (?, ?, ?)").run("old", "Old", "postgres://h/db");
  for (const m of migrations.filter(m => m.v === 4)) m.up(db);
  const row = db.query<{ id: string; driver: string }, []>("SELECT id, driver FROM datasource_connections").get()!;
  expect(row).toEqual({ id: "old", driver: "postgres" });
  expect(db.query<{ name: string } | null, []>("SELECT name FROM sqlite_master WHERE name = 'pg_connections'").get() ?? null).toBeNull();
  db.close();
});

test("migration v4 merges when both profile tables exist", () => {
  const db = new Database(":memory:");
  for (const m of migrations) m.up(db);
  db.exec(`CREATE TABLE pg_connections (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, url TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), last_used_at INTEGER,
    secret_name TEXT, environment TEXT NOT NULL DEFAULT 'development', read_only INTEGER NOT NULL DEFAULT 1)`);
  db.query("INSERT INTO pg_connections (id, label, url) VALUES ('legacy', 'Legacy', 'postgres://h/old')").run();
  db.query("INSERT INTO datasource_connections (id, label, driver, url) VALUES ('new', 'New', 'redis', 'redis://h/0')").run();
  for (const m of migrations.filter(m => m.v === 4)) m.up(db);
  const rows = db.query<{ id: string; driver: string }, []>("SELECT id, driver FROM datasource_connections ORDER BY id").all();
  expect(rows).toEqual([{ id: "legacy", driver: "postgres" }, { id: "new", driver: "redis" }]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'pg_connections'").get()).toBeNull();
  db.close();
});

test("migration v4 adds the driver column to a hand-edited profile table", () => {
  const db = new Database(":memory:");
  // A partially-migrated file: the new table exists without the driver column.
  db.exec(`CREATE TABLE datasource_connections (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, url TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), last_used_at INTEGER,
    secret_name TEXT, environment TEXT NOT NULL DEFAULT 'development', read_only INTEGER NOT NULL DEFAULT 1)`);
  db.query("INSERT INTO datasource_connections (id, label, url) VALUES ('x', 'X', 'postgres://h/db')").run();
  for (const m of migrations.filter(m => m.v === 4)) m.up(db);
  const row = db.query<{ id: string; driver: string }, []>("SELECT id, driver FROM datasource_connections").get()!;
  expect(row).toEqual({ id: "x", driver: "postgres" });
  db.close();
});

test("saves a redis profile with a redis url and keeps its driver", async () => {
  const { connections: c, store } = fixture();
  const saved = await c.save("redis", "cache", "redis://:pw@cache.internal:6380/2");
  expect(saved.driver).toBe("redis");
  expect(saved.readOnly).toBe(true);
  expect(saved.url).toBe("redis://cache.internal:6380/2");
  expect(await c.resolveUrl(saved.id)).toBe("redis://:pw@cache.internal:6380/2");
  expect(store.get(`connection:${saved.id}`)).toContain("pw");
});

test("redis driver rejects postgres urls and unknown drivers are refused", async () => {
  const { connections: c } = fixture();
  await expect(c.save("redis", "r", "postgres://h/db")).rejects.toThrow(/Redis/);
  await expect(c.save("oracle", "o", "oracle://h")).rejects.toThrow(/Unknown driver/);
  await expect(c.save("postgres", "p", "redis://h")).rejects.toThrow(/PostgreSQL/);
  // Prototype members must never resolve as validators.
  await expect(c.save("constructor", "x", "anything://h")).rejects.toThrow(/Unknown driver/);
});

test("a failed credential delete aborts the passwordless re-save", async () => {
  const db = freshDb();
  const store = new Map<string, string>();
  let fail = true;
  const c = makeConnections(db, {
    get: async name => store.get(name) ?? null,
    set: async (name, value) => { store.set(name, value); },
    delete: async name => { if (fail) throw new Error("keychain locked"); return store.delete(name); },
  });
  try {
    const saved = await c.save("postgres", "test", "postgres://u:p@h/db");
    // Re-saving without a password must not orphan the old credential.
    await expect(c.save("postgres", "test", "postgres://u@h/db", { id: saved.id })).rejects.toThrow("keychain locked");
    expect(await c.resolveUrl(saved.id)).toBe("postgres://u:p@h/db");
    fail = false;
    await c.save("postgres", "test", "postgres://u@h/db", { id: saved.id });
    expect(await c.resolveUrl(saved.id)).toBe("postgres://u@h/db");
    expect(store.size).toBe(0);
  } finally { db.close(); }
});

test("resolveUrl lazy migration retries when the row changed mid-flight", async () => {
  const { db, store } = fixture();
  db.query("INSERT INTO datasource_connections (id, label, driver, url) VALUES ('c1', 'old', 'postgres', 'postgres://u:p1@h/db1')").run();
  // Mutate the row once, inside the secret write — mimicking a concurrent
  // save racing the migration between the read and the conditional UPDATE.
  let swapped = false;
  const secrets: SecretStore = {
    get: async (name) => store.get(name) ?? null,
    set: async (name, value) => {
      store.set(name, value);
      if (!swapped) { swapped = true; db.query("UPDATE datasource_connections SET url = 'postgres://u:p2@h/db2' WHERE id = 'c1'").run(); }
    },
    delete: async (name) => store.delete(name),
  };
  const c = makeConnections(db, secrets);
  expect(await c.resolveUrl("c1")).toBe("postgres://u:p2@h/db2");
  const row = db.query<{ url: string; secret_name: string | null }, []>("SELECT url, secret_name FROM datasource_connections WHERE id = 'c1'").get()!;
  expect(row.secret_name).toMatch(/^connection:c1:[0-9a-f-]{36}$/);
  expect(store.get(row.secret_name!)).toBe("postgres://u:p2@h/db2");
  // The lost-race secret under the other unique name was rolled back.
  expect(store.size).toBe(1);
  expect(row.url).not.toContain(":p2@");
  db.close();
});

test("resolveUrl rollback keeps a secret a concurrent migration adopted", async () => {
  const { db, store } = fixture();
  db.query("INSERT INTO datasource_connections (id, label, driver, url) VALUES ('c4', 'racy', 'postgres', 'postgres://u:p@h/db')").run();
  let inner: ReturnType<typeof makeConnections>;
  let hooked = false;
  const c = makeConnections(db, {
    get: async (name) => store.get(name) ?? null,
    set: async (name, value) => {
      store.set(name, value);
      // A second resolver runs fully inside the first write: it links its
      // own unique name into the row and returns. The first resolver's
      // conditional UPDATE then loses — its rollback must not delete the
      // credential the row now references.
      if (hooked) return;
      hooked = true;
      await inner.resolveUrl("c4");
    },
    delete: async (name) => store.delete(name),
  });
  inner = c;
  expect(await c.resolveUrl("c4")).toBe("postgres://u:p@h/db");
  const row = db.query<{ url: string; secret_name: string | null }, []>("SELECT url, secret_name FROM datasource_connections WHERE id = 'c4'").get()!;
  expect(row.secret_name).toMatch(/^connection:c4:[0-9a-f-]{36}$/);
  expect(store.get(row.secret_name!)).toBe("postgres://u:p@h/db");
  // Only the inner resolver's secret survives — the outer rolled back.
  expect(store.size).toBe(1);
  db.close();
});

test("a failed upsert restores a prior secret under its actual name", async () => {
  const { db, store, connections: c } = fixture();
  // Row whose secret_name is not the conventional connection:<id>.
  db.query("INSERT INTO datasource_connections (id, label, driver, url, secret_name) VALUES ('c2', 'taken', 'postgres', 'postgres://u@h/db', 'custom:name')").run();
  store.set("custom:name", "postgres://u:p@h/db");
  // Force the upsert to fail with a duplicate label via a unique index.
  db.exec("CREATE UNIQUE INDEX uq_label ON datasource_connections(label)");
  db.query("INSERT INTO datasource_connections (id, label, driver, url) VALUES ('c3', 'blocker', 'postgres', 'postgres://u@h')").run();
  await expect(c.save("postgres", "blocker", "postgres://u@h/db", { id: "c2" })).rejects.toThrow();
  expect(store.get("custom:name")).toBe("postgres://u:p@h/db");
  db.close();
});

test("a successful re-save deletes a prior non-conventional secret name", async () => {
  const { db, store, connections: c } = fixture();
  // Hand-edited row referencing a non-conventional secret_name — the upsert
  // repoints it to connection:<id>, so the old credential must not linger.
  db.query("INSERT INTO datasource_connections (id, label, driver, url, secret_name) VALUES ('c9', 'taken', 'postgres', 'postgres://u@h/db', 'custom:name')").run();
  store.set("custom:name", "postgres://u:p@h/db");
  await c.save("postgres", "taken", "postgres://u:new@h/db", { id: "c9" });
  expect(store.get("custom:name")).toBeUndefined();
  expect(store.get("connection:c9")).toBe("postgres://u:new@h/db");
  db.close();
});

test("migration v4 merges when the target table predates the driver column", () => {
  const db = new Database(":memory:");
  // Mixed file where datasource_connections predates v4's driver column.
  db.exec(`CREATE TABLE datasource_connections (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, url TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), last_used_at INTEGER,
    secret_name TEXT, environment TEXT NOT NULL DEFAULT 'development', read_only INTEGER NOT NULL DEFAULT 1)`);
  db.exec(`CREATE TABLE pg_connections (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, url TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), last_used_at INTEGER)`);
  db.query("INSERT INTO datasource_connections (id, label, url) VALUES ('new', 'New', 'redis://h')").run();
  db.query("INSERT INTO pg_connections (id, label, url) VALUES ('legacy', 'Legacy', 'postgres://h/old')").run();
  for (const m of migrations.filter(m => m.v === 4)) m.up(db);
  const rows = db.query<{ id: string; driver: string }, []>("SELECT id, driver FROM datasource_connections ORDER BY id").all();
  expect(rows).toEqual([{ id: "legacy", driver: "postgres" }, { id: "new", driver: "postgres" }]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'pg_connections'").get()).toBeNull();
  db.close();
});

test("migration v4 merges a v1-shaped legacy table with missing columns", () => {
  const db = new Database(":memory:");
  for (const m of migrations) m.up(db);
  db.exec(`CREATE TABLE pg_connections (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, url TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), last_used_at INTEGER)`);
  db.query("INSERT INTO pg_connections (id, label, url) VALUES ('legacy', 'Legacy', 'postgres://h/old')").run();
  for (const m of migrations.filter(m => m.v === 4)) m.up(db);
  const row = db.query<{ id: string; driver: string; environment: string; read_only: number }, []>(
    "SELECT id, driver, environment, read_only FROM datasource_connections WHERE id = 'legacy'").get()!;
  expect(row).toEqual({ id: "legacy", driver: "postgres", environment: "development", read_only: 1 });
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'pg_connections'").get()).toBeNull();
  db.close();
});
