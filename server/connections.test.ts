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
  const saved = await c.save("local", "postgres://u:p@h:5432/db");
  expect(saved.id).toBeTruthy();
  expect(saved.label).toBe("local");
  expect(saved.environment).toBe("development");
  expect(saved.readOnly).toBe(true);
  expect(saved.url).not.toContain(":p@");
  expect((await c.get(saved.id))?.label).toBe("local");
  expect(await c.resolveUrl(saved.id)).toBe("postgres://u:p@h:5432/db");
  expect(store.get(`connection:${saved.id}`)).toBe("postgres://u:p@h:5432/db");
  const row = db.query<{ url: string }, [string]>("SELECT url FROM pg_connections WHERE id = ?").get(saved.id)!;
  expect(row.url).not.toContain(":p@");
});

test("save with explicit id upserts (label/url overwritten)", async () => {
  const c = fixture().connections;
  await c.save("a", "postgres://1", { id: "fixed" });
  const again = await c.save("b", "postgres://2", { id: "fixed" });
  expect(again.id).toBe("fixed");
  expect(again.label).toBe("b");
  expect((await c.list()).length).toBe(1);
});

test("list orders touched connections before untouched", async () => {
  const c = fixture().connections;
  const a = await c.save("a", "postgres://a");
  await c.save("b", "postgres://b");
  c.touch(a.id);
  expect((await c.list())[0].id).toBe(a.id);
});

test("delete removes the row and its secret", async () => {
  const { store, connections: c } = fixture();
  const s = await c.save("x", "postgres://u:p@x/db");
  expect(await c.delete(s.id)).toBe(true);
  expect(await c.delete(s.id)).toBe(false);
  expect(await c.get(s.id)).toBeNull();
  expect(store.has(`connection:${s.id}`)).toBe(false);
});

test("legacy plaintext rows migrate lazily only after secure storage succeeds", async () => {
  const { db, store, connections: c } = fixture();
  db.query("INSERT INTO pg_connections (id, label, url) VALUES (?, ?, ?)")
    .run("legacy", "legacy", "postgres://u:secret@h/db");
  expect(await c.resolveUrl("legacy")).toBe("postgres://u:secret@h/db");
  expect(store.get("connection:legacy")).toBe("postgres://u:secret@h/db");
  const row = db.query<{ url: string; secret_name: string }, []>("SELECT url, secret_name FROM pg_connections WHERE id = 'legacy'").get()!;
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
    await expect(connections.save('test', url)).rejects.toBeInstanceOf(Error);
  }
  expect(await connections.list()).toEqual([]);
  db.close();
});
