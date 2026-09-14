import { test, expect } from "bun:test";
import { dbApi } from "./dbApi.ts";

test('persistent state writes cannot overtake one another', async () => {
  const original = globalThis.fetch;
  const sent: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)); sent.push(body.value);
    if (body.value === 1) await gate;
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    const first = dbApi.state.set('sql:test', 1);
    const second = dbApi.state.set('sql:test', 2);
    await Bun.sleep(1);
    expect(sent).toEqual([1]);
    release(); await Promise.all([first, second]);
    expect(sent).toEqual([1, 2]);
  } finally { release(); globalThis.fetch = original; }
});


test('closing a SQL document deletes after pending writes and rejects late saves', async () => {
  const original = globalThis.fetch;
  const sent: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = (async (_input, init) => {
    sent.push(init?.method ?? 'GET');
    if (init?.method === 'POST') await gate;
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    const pending = dbApi.state.set('sql:closed', { sql: 'SELECT 1' });
    await Bun.sleep(1);
    const closed = dbApi.state.remove('sql:closed');
    const late = dbApi.state.set('sql:closed', { sql: 'SELECT 2' });
    expect(sent).toEqual(['POST']);
    release(); await Promise.all([pending, closed, late]);
    await dbApi.state.set('sql:closed', { sql: 'SELECT 3' });
    expect(sent).toEqual(['POST', 'DELETE']);
  } finally { release(); globalThis.fetch = original; }
});


test('failed state deletion allows saving and retrying', async () => {
  const original = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    sent.push(init?.method ?? 'GET');
    return sent.length === 1 ? Response.json({ error: 'delete failed' }, { status: 500 }) : Response.json({ ok: true });
  }) as typeof fetch;
  try {
    await expect(dbApi.state.remove('sql:retry-close')).rejects.toThrow('delete failed');
    await dbApi.state.set('sql:retry-close', { sql: 'SELECT 2' });
    await dbApi.state.remove('sql:retry-close');
    expect(sent).toEqual(['DELETE', 'POST', 'DELETE']);
  } finally { globalThis.fetch = original; }
});

test('all SQL execution requests carry the pinned schema, including paging and export', async () => {
  const original = globalThis.fetch;
  const requests: { url: string; body: any }[] = [];
  const source = { kind: 'postgres' as const, connId: 'one', database: 'db', schema: 'Odd " Schema', label: '', url: '', environment: 'local' as const, readOnly: true };
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
    return Response.json({});
  }) as typeof fetch;
  try {
    await dbApi.query(source, 'SELECT * FROM users', [], 10, 20);
    await dbApi.exportAll(source, 'SELECT * FROM users', []);
    await dbApi.explain(source, 'SELECT * FROM users');
    await dbApi.exec(source, 'SELECT 1', false);
    await dbApi.migration.preview(source, 'CREATE TABLE t(id int)');
    await dbApi.migration.apply(source, 'CREATE TABLE t(id int)');
    expect(requests).toHaveLength(6);
    for (const request of requests) expect(request.body).toMatchObject({ connId: 'one', database: 'db', schema: source.schema });
    expect(requests[0].body.offset).toBe(20);
    expect(requests[1].body.exportAll).toBe(true);
    await dbApi.query({ kind: 'sqlite', path: '/test' }, 'SELECT 1', [], 10);
    expect(requests[6].body).not.toHaveProperty('schema');
    await dbApi.schema(source, true);
    expect(requests[7].url).toContain('includeSystem=true');
  } finally { globalThis.fetch = original; }
});
