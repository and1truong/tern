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
