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
  const dir = mkdtempSync(join(tmpdir(), "tern-create-"));
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

test("connections save→list redacts the password, delete removes it", async () => {
  const h = handlers();
  const saveRes = await h.connectionSave(
    new Request("http://x/connections", { method: "POST", body: JSON.stringify({ label: "l", url: "postgres://u:secret@h/db" }) }),
  );
  const saved = (await saveRes.json()) as PgConnectionShape;
  expect(saved.url).not.toContain("secret");
  expect(saved.readOnly).toBe(true);

  const listRes = await h.connectionsList();
  const list = (await listRes.json()) as { connections: PgConnectionShape[] };
  expect(list.connections[0].url).not.toContain("secret");

  const delRes = await h.connectionDelete(new URL(`http://x/connections?id=${saved.id}`));
  expect(((await delRes.json()) as { ok: boolean }).ok).toBe(true);
});

type PgConnectionShape = { id: string; url: string; readOnly: boolean };
