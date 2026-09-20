import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAppDatabase } from "./appDatabase.ts";
import { makeApp } from "./app.ts";
import { makeRedisDriver } from "../datasources/redis/driver.ts";

test("application database remains protected when configured through a symlink", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tern-app-links-')));
  const path = join(dir, 'app.sqlite');
  const alias = join(dir, 'alias.sqlite');
  const db = openAppDatabase(path);
  symlinkSync(path, alias);
  const app = makeApp(db, { appPath: alias });
  try {
    for (const candidate of [path, alias]) {
      const response = await app(new Request('http://localhost/api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: candidate }) }));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('application database');
    }
    expect(db.query('SELECT * FROM recent_files').all()).toEqual([]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("the app database self-open guard fails closed without an explicit appPath", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tern-app-guard-')));
  const path = join(dir, 'app.sqlite');
  const db = openAppDatabase(path);
  const app = makeApp(db);
  try {
    const response = await app(new Request('http://localhost/api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('application database');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("standalone API persists state and recent files, denies implicit access/writes, and gates migration apply", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tern-app-')));
  const path = join(dir, 'user.sqlite');
  const user = new Database(path); user.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users VALUES (1, \'Ada\')'); user.close();
  let db = openAppDatabase(join(dir, 'app.sqlite'));
  let app = makeApp(db);
  const post = (route: string, body: unknown, headers = {}) => app(new Request(`http://localhost/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  try {
    expect((await post('datasource/query', { path, sql: 'SELECT * FROM users' })).status).toBe(403);
    expect((await post('open', { path }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('open', { path })).status).toBe(200);
    expect((await post('datasource/query', { path, sql: 'DELETE FROM users' })).status).toBe(403);
    expect((await post('datasource/exec', { path, sql: 'DELETE FROM users', allowWrite: true })).status).toBe(403);
    expect((await post('access', { path, writable: true })).status).toBe(200);
    expect((await post('datasource/exec', { path, sql: 'DELETE FROM users', allowWrite: true }, { 'x-tern-session': 'new-window' })).status).toBe(403);
    const migration = { path, sql: 'CREATE TABLE audit(id INTEGER)', allowWrite: true };
    expect((await post('datasource/migration/apply', migration)).status).toBe(400);
    expect((await post('datasource/migration/preview', migration)).status).toBe(200);
    const check = new Database(path, { readonly: true });
    expect(check.query("SELECT name FROM sqlite_master WHERE name='audit'").get()).toBeNull(); check.close();
    expect((await post('datasource/migration/apply', { ...migration, sql: 'CREATE TABLE other(id)' })).status).toBe(400);
    expect((await post('datasource/migration/apply', migration)).status).toBe(200);
    const changes = [{ kind: 'update', table: { name: 'users' }, key: { id: 1 }, expected: { name: 'Ada' }, values: { name: 'Grace' } }];
    expect((await post('datasource/rows/apply', { path, changes, allowWrite: true })).status).toBe(200);
    expect((await post('datasource/rows/apply', { path, changes, allowWrite: true })).status).toBe(409);
    await post('state', { key: 'sql:test', value: { sql: 'SELECT 42', history: ['SELECT 1'] } });
    db.close(); db = openAppDatabase(join(dir, 'app.sqlite')); app = makeApp(db);
    const saved = await app(new Request('http://localhost/api/state?key=sql:test'));
    expect(await saved.json()).toEqual({ sql: 'SELECT 42', history: ['SELECT 1'] });
    expect((await app(new Request('http://localhost/api/state?key=sql:test', { method: 'DELETE' }))).status).toBe(200);
    expect(await (await app(new Request('http://localhost/api/state?key=sql:test'))).json()).toBeNull();
    expect(db.query("SELECT count(*) AS n FROM app_state WHERE key = 'sql:test'").get()).toEqual({ n: 0 });
    const recent = await app(new Request('http://localhost/api/recent'));
    expect((await recent.json()).databases[0].path).toBe(path);
    await post('open', { path });
    expect((await post('datasource/exec', { path, sql: 'DELETE FROM users', allowWrite: true })).status).toBe(403);
    expect((await post('datasource/exec', { path, sql: 'BEGIN; SELECT * FROM users; COMMIT' })).status).toBe(200);
    expect((await post('datasource/exec', { path, sql: 'BEGIN; DELETE FROM users; COMMIT' })).status).toBe(403);
    expect((await post('datasource/exec', { path, sql: 'SELECT COUNT(*) AS n FROM users' })).status).toBe(200);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("datasource routes resolve profiles through registered drivers and gate writes", async () => {
  const calls: { command: string; args: string[] }[] = [];
  let closedTransports = 0;
  const redis = makeRedisDriver(() => ({
    async send(command: string, args: string[]) { calls.push({ command, args }); return command === 'INFO' ? '# Server\nredis_version:7.2.4' : command === 'GET' ? 'v1' : 'OK'; },
    async connect() {}, async close() { closedTransports++; },
  }));
  const db = openAppDatabase(':memory:');
  const app = makeApp(db, { drivers: [redis] });
  const post = (route: string, body: unknown, headers = {}) => app(new Request(`http://localhost/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  try {
    const saved = await post('connections', { driver: 'redis', label: 'cache', url: 'redis://localhost:6379' });
    expect(saved.status).toBe(200);
    const profile = await saved.json();
    expect(profile.driver).toBe('redis');

    expect((await post('datasource/session', { connId: 'nope' })).status).toBe(404);
    const session = await post('datasource/session', { connId: profile.id });
    expect(session.status).toBe(200);
    expect((await session.json()).info.flavor).toBe('redis');

    const read = await post('datasource/command', { connId: profile.id, command: 'GET k' });
    expect(read.status).toBe(200);
    expect((await read.json()).reply).toEqual({ t: 'str', s: 'v1' });
    expect((await post('datasource/command', { connId: profile.id, command: 'SET k v' })).status).toBe(403);
    expect((await post('access', { connId: profile.id, writable: true })).status).toBe(200);
    expect((await post('datasource/command', { connId: profile.id, command: 'SET k v' })).status).toBe(200);
    expect(calls.some(c => c.command === 'SET')).toBe(true);

    // Db-index aliases canonicalize server-side: a grant on "0" covers "00"
    // and both share one session, while "" still means "the URL's db".
    await post('access', { connId: profile.id, database: '0', writable: true });
    const aliased = await post('datasource/command', { connId: profile.id, database: '00', command: 'SET k v2' });
    expect(aliased.status).toBe(200);

    expect((await post('state', { key: 'redis:doc-1', value: { input: 'PING', history: [] } })).status).toBe(200);

    // Deleting the profile closes its cached driver sessions.
    expect((await app(new Request(`http://localhost/api/connections?id=${profile.id}`, { method: 'DELETE' }))).status).toBe(200);
    expect(closedTransports).toBeGreaterThan(0);
    expect((await post('datasource/session', { connId: profile.id })).status).toBe(404);
  } finally { db.close(); }
});

test("a sqlite profile cannot be saved — files must go through the /open gate", async () => {
  const db = openAppDatabase(':memory:');
  const app = makeApp(db);
  try {
    const res = await app(new Request('http://localhost/api/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ driver: 'sqlite', label: 'bypass', url: '/tmp/anywhere.sqlite' }) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/driver/i);
    expect(db.query("SELECT count(*) AS n FROM datasource_connections").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});

test("state DELETE accepts redis console keys", async () => {
  const db = openAppDatabase(':memory:');
  const app = makeApp(db);
  try {
    const post = (key: string) => app(new Request('http://localhost/api/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, value: { input: 'PING' } }) }));
    expect((await post('redis:doc-9')).status).toBe(200);
    const removed = await app(new Request('http://localhost/api/state?key=redis:doc-9', { method: 'DELETE' }));
    expect(removed.status).toBe(200);
    expect(db.query("SELECT count(*) AS n FROM app_state WHERE key = 'redis:doc-9'").get()).toEqual({ n: 0 });
    expect((await app(new Request('http://localhost/api/state?key=evil:key', { method: 'DELETE' }))).status).toBe(400);
  } finally { db.close(); }
});

test("state keys are an anchored allowlist and sessions cannot contain '/'", async () => {
  const db = openAppDatabase(':memory:');
  const app = makeApp(db);
  try {
    const post = (key: string) => app(new Request('http://localhost/api/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, value: 1 }) }));
    // `documents_evil` must not satisfy the `documents` prefix.
    expect((await post('documents_evil')).status).toBe(400);
    expect((await post('documents')).status).toBe(200);
    // GET is allowlisted too — app_state rows are not a free-form read API.
    expect((await app(new Request('http://localhost/api/state?key=evil'))).status).toBe(400);
    expect((await app(new Request('http://localhost/api/state?key=sql:doc-1'))).status).toBe(200);
    // A '/' in the session id could forge writable keys of shape session:connId/db.
    const slashy = await app(new Request('http://localhost/api/state?key=documents', { headers: { 'x-tern-session': 'a/b' } }));
    expect(slashy.status).toBe(400);
  } finally { db.close(); }
});
