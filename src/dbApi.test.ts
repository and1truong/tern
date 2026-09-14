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
