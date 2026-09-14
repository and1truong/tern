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
  expect(store.get("connection:legacy")).toBe("postgres://u:secret@h/db");
  const row = db.query<{ url: string; secret_name: string }, []>("SELECT url, secret_name FROM datasource_connections WHERE id = 'legacy'").get()!;
  expect(row.url).not.toContain("secret");
  expect(row.secret_name).toBe("connection:legacy");
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
});
