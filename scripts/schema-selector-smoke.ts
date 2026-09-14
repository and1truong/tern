// Exercise the actual App with an in-memory HTTP boundary: selection, document
// pinning, execution requests, system/empty schemas and persisted restoration.
import { Window } from 'happy-dom';
import { strict as assert } from 'node:assert';
const win = new Window({ url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'Text', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'DOMRect', 'getComputedStyle']) (globalThis as any)[key] = (win as any)[key];
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0);
(globalThis as any).cancelAnimationFrame = clearTimeout;
(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
Object.defineProperty(win, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
const state = new Map<string, any>();
const queries: any[] = [];
let names = ['public', 'billing', 'empty', 'Odd " Schema', 'pg_catalog'];
let failCatalog = false;
const connection = { id: 'pg', label: 'Test PostgreSQL', url: 'postgres://localhost/db', environment: 'local', readOnly: true };
(globalThis as any).fetch = async (input: string, init?: RequestInit) => {
  const url = new URL(String(input), 'http://localhost');
  const body = JSON.parse(String(init?.body ?? '{}'));
  if (url.pathname === '/api/connections') return Response.json({ connections: [connection] });
  if (url.pathname === '/api/recent') return Response.json({ databases: [] });
  if (url.pathname === '/api/databases') return Response.json({ databases: ['db', 'other'] });
  if (url.pathname === '/api/schema') {
    if (failCatalog) return Response.json({ error: 'catalog offline' }, { status: 400 });
    return Response.json({ schemas: names, tables: names.filter(name => name !== 'empty' && (name !== 'pg_catalog' || url.searchParams.has('includeSystem'))).map(schema => ({ schema, name: 'items', columns: [], type: 'table', rowCount: 0, ddl: '' })), indexes: [], triggers: [], pragmas: {} });
  }
  if (url.pathname === '/api/state') {
    const key = url.searchParams.get('key') ?? body.key;
    if (init?.method === 'POST') { state.set(key, body.value); return Response.json({ ok: true }); }
    return Response.json(state.get(key) ?? (key.startsWith('sql:') ? { tabs: [{ id: 'c', name: 'Console', sql: 'SELECT * FROM items' }], activeId: 'c', history: [] } : null));
  }
  if (url.pathname === '/api/query') { queries.push(body); return Response.json({ columns: ['schema'], rows: [{ schema: body.schema }], ms: 1, hasMore: false, offset: 0 }); }
  if (url.pathname === '/api/access') return Response.json({ writable: false });
  throw new Error(`Unexpected request: ${url}`);
};
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { App } = await import('../src/App.tsx');
const container = document.createElement('div'); document.body.append(container);
let root = createRoot(container);
const settle = async () => { for (let i = 0; i < 4; i++) await Bun.sleep(5); };
const select = async (label: string, value: string) => {
  const element = container.querySelector(`[aria-label="${label}"]`) as HTMLSelectElement;
  assert(element, label); assert(!element.disabled, label);
  element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); await settle();
};
const click = async (text: string, scope: ParentNode = container) => {
  const button = [...scope.querySelectorAll('button')].find(b => b.textContent?.trim() === text) as HTMLButtonElement;
  assert(button, text); assert(!button.disabled, text); button.click(); await settle();
};
const activePanel = () => container.querySelector('[role="tabpanel"]:not(.hidden)')!;
flushSync(() => root.render(React.createElement(App))); await settle();
container.querySelector<HTMLButtonElement>('.connection-row button')!.click(); await settle();
assert([...container.querySelectorAll('[aria-label="Schema"] option')].some(o => o.textContent === 'empty'));
assert(![...container.querySelectorAll('[aria-label="Schema"] option')].some(o => o.textContent === 'pg_catalog'));
await select('Schema', 'billing');
assert.equal(container.querySelectorAll('.explorer button[title=""]').length, 1);
await click('SQL');
await click('Run', activePanel()); assert.equal(queries.at(-1).schema, 'billing');
await select('Schema', 'public'); await click('SQL');
await click('Run', activePanel()); assert.equal(queries.at(-1).schema, 'public');
container.querySelector<HTMLButtonElement>('[role="tab"]')!.click(); await settle();
assert(activePanel().textContent?.includes('Query schema: billing'));
await click('Run', activePanel()); assert.equal(queries.at(-1).schema, 'billing');
await select('Schema', 'empty');
assert(container.querySelector('.explorer')?.textContent?.includes('No objects in this schema.'));
await select('Database', 'other'); await select('Schema', 'Odd " Schema');
await select('Database', 'db'); assert.equal((container.querySelector('[aria-label="Schema"]') as HTMLSelectElement).value, 'empty');
await select('Database', 'other'); assert.equal((container.querySelector('[aria-label="Schema"]') as HTMLSelectElement).value, 'Odd " Schema');
container.querySelector<HTMLInputElement>('[aria-label="Show system schemas"]')!.click(); await settle();
await select('Schema', 'pg_catalog');
assert(container.querySelector('.explorer')?.textContent?.includes('pg_catalog.items'));
await select('Schema', 'billing'); await click('SQL');
flushSync(() => root.unmount()); await settle();
root = createRoot(container); flushSync(() => root.render(React.createElement(App))); await settle();
assert(activePanel().textContent?.includes('Query schema: billing'));
await click('Run', activePanel()); assert.equal(queries.at(-1).schema, 'billing');
await select('Schema', 'Odd " Schema');
names = names.filter(name => name !== 'Odd " Schema');
container.querySelector<HTMLButtonElement>('[aria-label="Refresh schemas"]')!.click(); await settle();
assert(container.textContent?.includes('Schema unavailable'));
assert.equal((container.querySelector('[aria-label="Schema"]') as HTMLSelectElement).value, 'Odd " Schema');
failCatalog = true;
container.querySelector<HTMLButtonElement>('[aria-label="Refresh schemas"]')!.click(); await settle();
assert(container.textContent?.includes('catalog offline'));
flushSync(() => root.unmount());
console.log('PASS: schema selection, pinned execution, empty/system schemas, database preferences, reload, missing schemas and catalog errors');
