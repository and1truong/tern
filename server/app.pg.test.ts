import { test, expect } from "bun:test";
import { openAppDatabase } from "./appDatabase.ts";
import { makeApp } from "./app.ts";
const url = process.env.TEST_PG_URL;
test.skipIf(!url)('standalone PostgreSQL profile, database selection, read-only, conflicts, rollback, activity and cancellation', async () => {
  const db = openAppDatabase(':memory:');
  const secrets = new Map<string, string>();
  const app = makeApp(db, { secrets: { get: async k => secrets.get(k) ?? null, set: async (k, v) => { secrets.set(k, v); }, delete: async k => secrets.delete(k) } });
  const post = (route: string, body: unknown, signal?: AbortSignal) => app(new Request(`http://localhost/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }));
  const profile = await (await post('connections', { label: 'Integration', url, readOnly: true })).json();
  expect(profile.id).toBeTruthy();
  expect((await post('migration/preview', { connId: profile.id, sql: "SELECT setval('missing_sequence', 1)" })).status).toBe(403);
  const prefer = new URL(url!); prefer.searchParams.set('sslmode', 'prefer');
  expect((await post('connections/test', { url: prefer.toString() })).ok).toBe(true);
  const source = { connId: profile.id, database: decodeURIComponent(new URL(url!).pathname.slice(1)) };
  const query = new URLSearchParams(source).toString();
  try {
    const list = await app(new Request(`http://localhost/api/databases?${query}`));
    expect((await list.json()).databases).toContain(source.database);
    expect((await app(new Request(`http://localhost/api/schema?${query}`))).ok).toBe(true);
    expect((await post('exec', { ...source, sql: 'CREATE TABLE tern_api_test(id int primary key, name text)', allowWrite: true })).status).toBe(403);
    await post('access', { ...source, writable: true });
    await post('exec', { ...source, sql: 'CREATE SEQUENCE tern_preview_guard_seq', allowWrite: true });
    try {
      await post('access', { ...source, writable: false });
      expect((await post('migration/preview', { ...source, sql: "SELECT setval('tern_preview_guard_seq', 99)" })).status).toBe(403);
      const sequence = await (await post('query', { ...source, sql: 'SELECT last_value::text FROM tern_preview_guard_seq' })).json();
      expect(sequence.rows[0].last_value).toBe('1');
    } finally {
      await post('access', { ...source, writable: true });
      await post('exec', { ...source, sql: 'DROP SEQUENCE tern_preview_guard_seq', allowWrite: true });
    }
    await post('exec', { ...source, sql: 'DROP TABLE IF EXISTS tern_api_test', allowWrite: true });
    const migration = { ...source, sql: 'CREATE TABLE tern_api_test(id int primary key, name text)', allowWrite: true };
    expect((await post('migration/preview', migration)).ok).toBe(true);
    const absent = await post('query', { ...source, sql: "SELECT to_regclass('public.tern_api_test') AS name" });
    expect((await absent.json()).rows[0].name).toBeNull();
    expect((await post('migration/apply', migration)).ok).toBe(true);
    const insert = [{ kind: 'insert', table: { schema: 'public', name: 'tern_api_test' }, values: { id: 1, name: 'before' } }];
    expect((await post('rows/apply', { ...source, changes: insert, allowWrite: true })).ok).toBe(true);
    const conflict = [{ kind: 'update', table: { schema: 'public', name: 'tern_api_test' }, key: { id: 1 }, expected: { name: 'stale' }, values: { name: 'after' } }];
    expect((await post('rows/apply', { ...source, changes: conflict, allowWrite: true })).status).toBe(409);
    const rows = await (await post('query', { ...source, sql: 'SELECT name FROM tern_api_test WHERE id = ?', params: [1] })).json();
    expect(rows.rows).toEqual([{ name: 'before' }]);
    const insights = await (await app(new Request(`http://localhost/api/insights?${query}`))).json();
    expect(insights.tables.some((t: { name: string }) => t.name === 'public.tern_api_test')).toBe(true);
    const cancel = new AbortController();
    const running = post('query', { ...source, sql: 'SELECT pg_sleep(20)' }, cancel.signal);
    setTimeout(() => cancel.abort(), 100);
    expect((await running).status).toBe(408);
    expect((await post('query', { ...source, sql: 'SELECT pg_sleep(20)', timeoutMs: 1000 })).status).toBe(408);
  } finally {
    await post('exec', { ...source, sql: 'DROP TABLE IF EXISTS tern_api_test', allowWrite: true });
    db.close();
  }
}, 15000);

test.skipIf(!url)('migration dry-run approval is bound to the selected schema', async () => {
  const db = openAppDatabase(':memory:');
  const secrets = new Map<string, string>();
  const app = makeApp(db, { secrets: { get: async k => secrets.get(k) ?? null, set: async (k, v) => { secrets.set(k, v); }, delete: async k => secrets.delete(k) } });
  const post = (route: string, body: unknown) => app(new Request(`http://localhost/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const profile = await (await post('connections', { label: 'Schema gate', url, readOnly: true })).json();
  const source = { connId: profile.id };
  await post('access', { ...source, writable: true });
  try {
    expect((await post('exec', { ...source, sql: 'CREATE SCHEMA tern_gate_a; CREATE SCHEMA tern_gate_b', allowWrite: true })).ok).toBe(true);
    const migration = { ...source, sql: 'CREATE TABLE gated(id int)', schema: 'tern_gate_a', allowWrite: true };
    expect((await post('migration/preview', migration)).ok).toBe(true);
    const wrong = await post('migration/apply', { ...migration, schema: 'tern_gate_b' });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toContain('dry run');
    expect((await post('migration/apply', migration)).ok).toBe(true);
    const query = await post('query', { ...source, schema: 'tern_gate_b', sql: "SELECT to_regclass('gated') AS name" });
    expect((await query.json()).rows[0].name).toBeNull();
  } finally {
    await post('exec', { ...source, sql: 'DROP SCHEMA IF EXISTS tern_gate_a CASCADE; DROP SCHEMA IF EXISTS tern_gate_b CASCADE', allowWrite: true });
    db.close();
  }
});
