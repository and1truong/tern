import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations } from "./migrations.ts";
import { makeConnections } from "./connections.ts";
import type { SecretStore } from "./connections.ts";
import { makeHandlers } from "./routeHandlers.ts";

function handlers() {
  const db = new Database(":memory:");
  for (const m of migrations) m.up(db);
  const values = new Map<string, string>();
  const secrets: SecretStore = {
    get: async (name) => values.get(name) ?? null,
    set: async (name, value) => { values.set(name, value); },
    delete: async (name) => values.delete(name),
  };
  return makeHandlers(makeConnections(db, secrets));
}

test("create makes a new sqlite database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dbm-create-"));
  const path = join(dir, "created.sqlite");
  try {
    const response = await handlers().create(new Request("http://x/create", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()) as { path: string; created: boolean }).toEqual({ path, created: true });
    new Database(path, { readonly: true }).close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("schema of a missing sqlite path maps DbError(not_found) to 404", async () => {
  const res = await handlers().schema(new URL("http://x/schema?path=/no/such/file.db"));
  expect(res.status).toBe(404);
  const body = (await res.json()) as { code?: string };
  expect(body.code).toBe("not_found");
});

test("query with a write verb maps DbError(not_read_only) to 400", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dbm-"));
  const f = join(dir, "y.sqlite");
  const d = new Database(f); d.exec("CREATE TABLE t(a)"); d.close();
  try {
    const req = new Request("http://x/query", { method: "POST", body: JSON.stringify({ path: f, sql: "DELETE FROM t" }) });
    const res = await handlers().query(req);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("not_read_only");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("exec requires explicit write confirmation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dbm-"));
  const f = join(dir, "write.sqlite");
  new Database(f).close();
  try {
    const denied = await handlers().exec(new Request("http://x/exec", {
      method: "POST",
      body: JSON.stringify({ path: f, sql: "CREATE TABLE t(a)" }),
    }));
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { code?: string }).code).toBe("not_read_only");

    const allowed = await handlers().exec(new Request("http://x/exec", {
      method: "POST",
      body: JSON.stringify({ path: f, sql: "CREATE TABLE t(a)", allowWrite: true }),
    }));
    expect(allowed.status).toBe(200);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("migration preview rolls back and apply commits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dbm-migration-"));
  const path = join(dir, "migration.sqlite");
  new Database(path).close();
  const script = "CREATE TABLE migrated (id INTEGER PRIMARY KEY);";
  try {
    const preview = await handlers().migration(new Request("http://x/migration/preview", { method: "POST", body: JSON.stringify({ path, sql: script }) }), false);
    expect(preview.status).toBe(200);
    const afterPreview = new Database(path, { readonly: true });
    try { expect(afterPreview.query("SELECT name FROM sqlite_master WHERE name = 'migrated'").get()).toBeNull(); }
    finally { afterPreview.close(); }
    const applied = await handlers().migration(new Request("http://x/migration/apply", { method: "POST", body: JSON.stringify({ path, sql: script, allowWrite: true }) }), true);
    expect(applied.status).toBe(200);
    const db = new Database(path, { readonly: true });
    try { expect(db.query("SELECT name FROM sqlite_master WHERE name = 'migrated'").get()).toBeTruthy(); }
    finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("row changes preview then apply through the structured endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dbm-"));
  const f = join(dir, "rows.sqlite");
  const db = new Database(f);
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO users VALUES (1, 'Ada')");
  db.close();
  const changes = [{
    kind: "update" as const,
    table: { name: "users" },
    key: { id: 1 },
    expected: { id: 1, name: "Ada" },
    values: { name: "Augusta" },
  }];
  try {
    const preview = await handlers().rowPreview(new Request("http://x/rows/preview", {
      method: "POST", body: JSON.stringify({ changes }),
    }));
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { statements: unknown[] }).statements).toHaveLength(1);

    const applied = await handlers().rowApply(new Request("http://x/rows/apply", {
      method: "POST", body: JSON.stringify({ path: f, changes, allowWrite: true }),
    }));
    expect(applied.status).toBe(200);
    expect(((await applied.json()) as { applied: number }).applied).toBe(1);
    const check = new Database(f, { readonly: true });
    expect(check.query<{ name: string }, []>("SELECT name FROM users WHERE id = 1").get()?.name).toBe("Augusta");
    check.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("connections save→list redacts the password, delete removes it", async () => {
  const h = handlers();
  const saveRes = await h.connectionSave(
    new Request("http://x/connections", { method: "POST", body: JSON.stringify({ label: "l", url: "postgres://u:secret@h/db" }) }),
  );
  const saved = (await saveRes.json()) as PgConnectionShape;
  expect(saved.url).not.toContain("secret");
  expect(saved.readOnly).toBe(true);

  const deniedWrite = await h.exec(new Request("http://x/exec", {
    method: "POST",
    body: JSON.stringify({ connId: saved.id, sql: "DROP TABLE users", allowWrite: true }),
  }));
  expect(deniedWrite.status).toBe(400);
  expect(((await deniedWrite.json()) as { code?: string }).code).toBe("not_read_only");

  const listRes = await h.connectionsList();
  const list = (await listRes.json()) as { connections: PgConnectionShape[] };
  expect(list.connections[0].url).not.toContain("secret");

  const delRes = await h.connectionDelete(new URL(`http://x/connections?id=${saved.id}`));
  expect(((await delRes.json()) as { ok: boolean }).ok).toBe(true);
});

type PgConnectionShape = { id: string; url: string; readOnly: boolean };
