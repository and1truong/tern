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
  const prefer = new URL(url!); prefer.searchParams.set('sslmode', 'prefer');
  expect((await post('connections/test', { url: prefer.toString() })).ok).toBe(true);
  const source = { connId: profile.id, database: decodeURIComponent(new URL(url!).pathname.slice(1)) };
  const query = new URLSearchParams(source).toString();
  try {
    const list = await app(new Request(`http://localhost/api/databases?${query}`));
    expect((await list.json()).databases).toContain(source.database);
    expect((await app(new Request(`http://localhost/api/schema?${query}`))).ok).toBe(true);
    expect((await post('exec', { ...source, sql: 'CREATE TABLE dbm_api_test(id int primary key, name text)', allowWrite: true })).status).toBe(403);
    await post('access', { ...source, writable: true });
    await post('exec', { ...source, sql: 'DROP TABLE IF EXISTS dbm_api_test', allowWrite: true });
    const migration = { ...source, sql: 'CREATE TABLE dbm_api_test(id int primary key, name text)', allowWrite: true };
    expect((await post('migration/preview', migration)).ok).toBe(true);
    const absent = await post('query', { ...source, sql: "SELECT to_regclass('public.dbm_api_test') AS name" });
    expect((await absent.json()).rows[0].name).toBeNull();
    expect((await post('migration/apply', migration)).ok).toBe(true);
    const insert = [{ kind: 'insert', table: { schema: 'public', name: 'dbm_api_test' }, values: { id: 1, name: 'before' } }];
    expect((await post('rows/apply', { ...source, changes: insert, allowWrite: true })).ok).toBe(true);
    const conflict = [{ kind: 'update', table: { schema: 'public', name: 'dbm_api_test' }, key: { id: 1 }, expected: { name: 'stale' }, values: { name: 'after' } }];
    expect((await post('rows/apply', { ...source, changes: conflict, allowWrite: true })).status).toBe(409);
    const rows = await (await post('query', { ...source, sql: 'SELECT name FROM dbm_api_test WHERE id = ?', params: [1] })).json();
    expect(rows.rows).toEqual([{ name: 'before' }]);
    const insights = await (await app(new Request(`http://localhost/api/insights?${query}`))).json();
    expect(insights.tables.some((t: { name: string }) => t.name === 'public.dbm_api_test')).toBe(true);
    const cancel = new AbortController();
    const running = post('query', { ...source, sql: 'SELECT pg_sleep(20)' }, cancel.signal);
    setTimeout(() => cancel.abort(), 100);
    expect((await running).status).toBe(408);
    expect((await post('query', { ...source, sql: 'SELECT pg_sleep(20)', timeoutMs: 1000 })).status).toBe(408);
  } finally {
    await post('exec', { ...source, sql: 'DROP TABLE IF EXISTS dbm_api_test', allowWrite: true });
    db.close();
  }
}, 15000);
