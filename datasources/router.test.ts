import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDatasourceRouter, type Profiles } from "./router.ts";
import { createDriverRegistry } from "./registry.ts";
import { makeSqliteDriver } from "./sqlite/driver.ts";
import type { DataSourceDriver, DriverSession } from "./contracts.ts";
import { DbError, type DataSourceInfo } from "../shared/types.ts";

const INFO: DataSourceInfo = {
  flavor: "redis", version: "7.2.4",
  capabilities: { streams: true, acl: true, functions: true, cluster: false, modules: false, search: false },
  summary: {},
};

function fakeDriver(overrides: Partial<DataSourceDriver> & { session?: Partial<DriverSession> } = {}) {
  let connectCount = 0;
  const driver: DataSourceDriver = {
    id: "redis", displayName: "fake", kind: "key-value",
    validateUrl: () => {},
    async test() { return INFO; },
    async connect() {
      connectCount++;
      return {
        info: INFO,
        console: {
          async exec(command, ctx) {
            if (command.startsWith("SET") && !ctx.writable) throw new DbError("not_read_only", "SET is a write command; enable writes");
            return { reply: { t: "str", s: command }, ms: 1 };
          },
          async catalog() { return []; },
        },
        explorer: {
          async scan() { return { cursor: "0", keys: [] }; },
          async inspect(key) { return { key, type: "none", ttlSeconds: -2, memoryBytes: null, size: null, value: { kind: "none" } }; },
          async keyOp(op) { return { ok: true, op: (op as { op: string }).op } as never; },
        },
        close: async () => {},
        ...overrides.session,
      } as DriverSession;
    },
    ...overrides,
  } as DataSourceDriver;
  return { driver, connectCount: () => connectCount };
}

const profiles: Profiles = {
  get: async (id) => id === "p1" ? { id: "p1", driver: "redis" } : null,
  resolveUrl: async (id) => id === "p1" ? "redis://localhost:6379" : null,
};

function makeRequest(path: string, body: Record<string, unknown>, writable = () => true) {
  return { path, body, url: new URL("http://127.0.0.1/api/datasource" + path), signal: new AbortController().signal, writable };
}

describe("datasource router", () => {
  test("/test dispatches by driver id", async () => {
    const { driver } = fakeDriver();
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    const res = await router.route(makeRequest("/test", { driver: "redis", url: "redis://h" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ flavor: "redis" });
  });

  test("/test treats an empty database like an absent one", async () => {
    let seen: unknown = "unset";
    const { driver } = fakeDriver({ test: async (config) => { seen = config.database; return INFO; } });
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    const res = await router.route(makeRequest("/test", { driver: "redis", url: "redis://h/5", database: "" }));
    expect(res.status).toBe(200);
    // "" means "no override" — the driver's sessionUrl must preserve the
    // URL's embedded db instead of resetting to db 0.
    expect(seen).toBeUndefined();
  });

  test("/session caches the session across calls", async () => {
    const { driver, connectCount } = fakeDriver();
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    await router.route(makeRequest("/session", { connId: "p1" }));
    const res = await router.route(makeRequest("/session", { connId: "p1" }));
    expect(res.status).toBe(200);
    expect(connectCount()).toBe(1);
  });

  test("/command without a console provider is 404", async () => {
    const { driver } = fakeDriver({ session: { console: undefined } });
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    const res = await router.route(makeRequest("/command", { connId: "p1", command: "PING" }));
    expect(res.status).toBe(404);
  });

  test("/command enforces the session writability callback", async () => {
    const { driver } = fakeDriver();
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    await router.route(makeRequest("/session", { connId: "p1" }));
    const denied = await router.route(makeRequest("/command", { connId: "p1", command: "SET k v" }, () => false));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe("not_read_only");
    const allowed = await router.route(makeRequest("/command", { connId: "p1", command: "SET k v" }, () => true));
    expect(allowed.status).toBe(200);
  });

  test("/scan and /key/op pass through to the explorer", async () => {
    const { driver } = fakeDriver();
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    const scan = await router.route(makeRequest("/scan", { connId: "p1", cursor: "0" }));
    expect(scan.status).toBe(200);
    const op = await router.route(makeRequest("/key/op", { connId: "p1", op: { op: "delete", keys: ["a"] } }));
    expect(op.status).toBe(200);
    expect((await op.json())).toMatchObject({ ok: true });
  });

  test("/scan rejects oversized match and type rather than truncating", async () => {
    const { driver } = fakeDriver();
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    // A chopped glob would silently scan a different key set than requested.
    const long = await router.route(makeRequest("/scan", { connId: "p1", cursor: "0", match: "x".repeat(257) }));
    expect(long.status).toBe(400);
    expect(((await long.json()) as { code: string }).code).toBe("invalid_change");
    const ok = await router.route(makeRequest("/scan", { connId: "p1", cursor: "0", match: "k*".padEnd(256, "*"), type: "hash" }));
    expect(ok.status).toBe(200);
    // An empty match would otherwise be silently dropped into an
    // unfiltered SCAN; an empty cursor means the first page like /key.
    const emptyMatch = await router.route(makeRequest("/scan", { connId: "p1", cursor: "0", match: "" }));
    expect(emptyMatch.status).toBe(400);
    const emptyCursor = await router.route(makeRequest("/scan", { connId: "p1", cursor: "" }));
    expect(emptyCursor.status).toBe(200);
    // count must be a real number — a string is rejected, not coerced.
    const stringCount = await router.route(makeRequest("/scan", { connId: "p1", cursor: "0", count: "50" }));
    expect(stringCount.status).toBe(400);
  });

  test("/key and /key/op accept the empty-string key (legal in Redis)", async () => {
    const { driver } = fakeDriver();
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    // SCAN returns "" as a key name — inspect and ops must reach it too.
    const inspect = await router.route(makeRequest("/key", { connId: "p1", key: "" }));
    expect(inspect.status).toBe(200);
    const op = await router.route(makeRequest("/key/op", { connId: "p1", op: { op: "delete", keys: [""] } }));
    expect(op.status).toBe(200);
  });

  test("/key/op allows empty field/member strings (legal in Redis)", async () => {
    const { driver } = fakeDriver();
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    for (const op of [
      { op: "hashDelete", key: "h", fields: [""] },
      { op: "setRemove", key: "s", members: [""] },
      { op: "hashSet", key: "h", field: "", value: "v" },
    ]) {
      const res = await router.route(makeRequest("/key/op", { connId: "p1", op }));
      expect(res.status, JSON.stringify(op)).toBe(200);
    }
  });

  test("/key/op requires an explicitly writable session", async () => {
    const { driver } = fakeDriver();
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    const denied = await router.route(makeRequest("/key/op", { connId: "p1", op: { op: "delete", keys: ["a"] } }, () => false));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe("not_read_only");
  });

  test("invalidate closes sessions for a deleted profile", async () => {
    let closed = false;
    const { driver } = fakeDriver({ session: { close: async () => { closed = true; } } });
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    await router.route(makeRequest("/session", { connId: "p1" }));
    await router.invalidate("p1");
    expect(closed).toBe(true);
  });

  test("a `database` request field becomes a suffixed urlKey that invalidate sweeps", async () => {
    let closed = 0;
    const { driver } = fakeDriver({ session: { close: async () => { closed++; } } });
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    const res = await router.route(makeRequest("/session", { connId: "p1", database: "1" }));
    expect(res.status).toBe(200);
    await router.invalidate("p1");
    expect(closed).toBe(1);
  });

  test("a profile row with driver sqlite never reaches the sqlite driver", async () => {
    const { driver } = fakeDriver();
    const registry = createDriverRegistry();
    registry.register(driver);
    registry.register(makeSqliteDriver());
    const sqliteProfiles: Profiles = {
      get: async (id) => id === "sq" ? { id: "sq", driver: "sqlite" } : null,
      resolveUrl: async () => "/tmp/probe.db",
    };
    const router = makeDatasourceRouter(sqliteProfiles, registry);
    const res = await router.route(makeRequest("/session", { connId: "sq" }));
    expect(res.status).toBe(400);
  });

  test("/test refuses the sqlite driver — files open through /open only", async () => {
    const { driver } = fakeDriver();
    const registry = createDriverRegistry();
    registry.register(driver);
    registry.register(makeSqliteDriver());
    const router = makeDatasourceRouter(profiles, registry);
    const res = await router.route(makeRequest("/test", { driver: "sqlite", url: "/tmp/probe.db" }));
    expect(res.status).toBe(400);
  });

  test("unknown driver id is 404 and unknown profile is 404", async () => {
    const { driver } = fakeDriver();
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    expect((await router.route(makeRequest("/test", { driver: "oracle", url: "x" }))).status).toBe(404);
    expect((await router.route(makeRequest("/session", { connId: "nope" }))).status).toBe(404);
  });
});

describe("session lifecycle on errors", () => {
  test("logical errors retain the session; transport errors evict and close it", async () => {
    let closed = 0;
    let failMode: "none" | "readonly" | "transport" = "readonly";
    const { driver, connectCount } = fakeDriver({
      session: {
        console: {
          async exec(command) {
            if (failMode === "readonly") throw new DbError("not_read_only", "write refused");
            if (failMode === "transport") throw new DbError("sql", "connection refused");
            return { reply: { t: "str", s: command }, ms: 1 };
          },
          async catalog() { return []; },
        },
        close: async () => { closed++; },
      },
    });
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    await router.route(makeRequest("/session", { connId: "p1" }));

    const denied = await router.route(makeRequest("/command", { connId: "p1", command: "SET k v" }, () => false));
    expect(denied.status).toBe(403);
    // A read-only rejection is logical: the healthy session stays cached.
    expect(closed).toBe(0);
    failMode = "none";
    const ok = await router.route(makeRequest("/command", { connId: "p1", command: "GET k" }, () => true));
    expect(ok.status).toBe(200);
    expect(connectCount()).toBe(1);

    failMode = "transport";
    const broken = await router.route(makeRequest("/command", { connId: "p1", command: "GET k" }, () => true));
    expect(broken.status).toBe(400);
    expect(closed).toBe(1);
    // The broken session was evicted: the next call reconnects.
    await router.route(makeRequest("/command", { connId: "p1", command: "GET k" }, () => true));
    expect(connectCount()).toBe(2);
  });

  test("concurrent first requests share one in-flight connect", async () => {
    let resolveConnect: (session: DriverSession) => void = () => {};
    const gate = new Promise<DriverSession>(resolve => { resolveConnect = resolve; });
    let connectCount = 0;
    const base = fakeDriver();
    const driver: DataSourceDriver = {
      ...base.driver,
      async connect() {
        connectCount++;
        return gate;
      },
    };
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    const first = router.route(makeRequest("/session", { connId: "p1" }));
    const second = router.route(makeRequest("/scan", { connId: "p1", cursor: "0" }));
    await new Promise(r => setTimeout(r, 0));
    resolveConnect(await base.driver.connect({ url: "redis://localhost:6379" }));
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(connectCount).toBe(1);
  });

  test("a failed connect is not cached; the next request retries", async () => {
    let connectCount = 0;
    const base = fakeDriver();
    const driver: DataSourceDriver = {
      ...base.driver,
      async connect() {
        connectCount++;
        if (connectCount === 1) throw new DbError("sql", "connection refused");
        return base.driver.connect({ url: "redis://localhost:6379" });
      },
    };
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    const failed = await router.route(makeRequest("/session", { connId: "p1" }));
    expect(failed.status).toBe(400);
    const retried = await router.route(makeRequest("/session", { connId: "p1" }));
    expect(retried.status).toBe(200);
    expect(connectCount).toBe(2);
  });

  test("command_error rejections keep the healthy session", async () => {
    let closed = 0;
    const { driver, connectCount } = fakeDriver({
      session: {
        explorer: {
          async scan() { throw new DbError("command_error", "NOPERM denied"); },
          async inspect(key) { return { key, type: "none", ttlSeconds: -2, memoryBytes: null, size: null, value: { kind: "none" } }; },
          async keyOp() { return { ok: true } as never; },
        },
        close: async () => { closed++; },
      },
    });
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    const denied = await router.route(makeRequest("/scan", { connId: "p1", cursor: "0" }));
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { code: string }).code).toBe("command_error");
    expect(closed).toBe(0);
    // Same session serves the next request — no reconnect happened.
    await router.route(makeRequest("/scan", { connId: "p1", cursor: "0" }));
    expect(connectCount()).toBe(1);
  });
});

test("/key/op expire requires a positive second count", async () => {
  const { driver } = fakeDriver();
  const registry = createDriverRegistry();
  registry.register(driver);
  const router = makeDatasourceRouter(profiles, registry);
  for (const seconds of [0, -5, Number.NaN]) {
    const res = await router.route(makeRequest("/key/op", { connId: "p1", op: { op: "expire", key: "k", seconds } }));
    expect(res.status, String(seconds)).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/positive/);
  }
});

test("/key/op rejects malformed operation bodies before dispatch", async () => {
  let dispatched = 0;
  const { driver } = fakeDriver({
    session: {
      explorer: {
        async scan() { return { cursor: "0", keys: [] }; },
        async inspect(key) { return { key, type: "none", ttlSeconds: -2, memoryBytes: null, size: null, value: { kind: "none" } }; },
        async keyOp(op) { dispatched++; return { ok: true, op: (op as { op: string }).op } as never; },
      },
    },
  });
  const registry = createDriverRegistry();
  registry.register(driver);
  const router = makeDatasourceRouter(profiles, registry);
  const malformed: unknown[] = [
    // A string would char-split into SREM members a,d,m,i,n at the driver.
    { op: "setRemove", key: "myset", members: "admin" },
    { op: "setAdd", key: "s", members: "x" },
    { op: "hashDelete", key: "h", fields: "f" },
    { op: "zsetRemove", key: "z", members: [] },
    { op: "delete", keys: "k" },
    { op: "delete", keys: [] },
    { op: "rename", from: "a" },
    { op: "zsetAdd", key: "z", member: "m", score: "high" },
    { op: "hashSet", key: "h", field: "f" },
    // Values are capped too — a workbench key edit must not accept a
    // multi-hundred-MB body.
    { op: "setString", key: "k", value: "x".repeat(1024 * 1024 + 1) },
    { op: "listSet", key: "l", index: 1.5, value: "v" },
    { op: "persist" },
    { op: "teleport", key: "k" },
    "not-an-object",
  ];
  for (const op of malformed) {
    const res = await router.route(makeRequest("/key/op", { connId: "p1", op }));
    expect(res.status, JSON.stringify(op)).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_change");
  }
  expect(dispatched).toBe(0);
});

// Relational dispatch: SQLite files resolve path-keyed sessions through the
// registered driver (the app's open-gate runs before routing).
describe("relational routes", () => {
  const dir = mkdtempSync(join(tmpdir(), "tern-router-"));
  const path = join(dir, "r.sqlite");
  {
    const db = new Database(path);
    db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO users VALUES (1, 'Ada')");
    db.close();
  }
  const registry = createDriverRegistry();
  registry.register(makeSqliteDriver());
  const router = makeDatasourceRouter(profiles, registry);
  const writable = () => true;

  test("schema resolves a path session", async () => {
    const res = await router.route(makeRequest("/schema", { path }, writable));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tables: unknown[] }).tables).toHaveLength(1);
    const missing = await router.route(makeRequest("/schema", { path: join(dir, "none.db") }, writable));
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe("not_found");
  });

  test("query rejects write verbs as not_read_only", async () => {
    const res = await router.route(makeRequest("/query", { path, sql: "DELETE FROM users" }, writable));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("not_read_only");
  });

  test("/exec enforces the writable gate and read-only batch", async () => {
    const denied = await router.route(makeRequest("/exec", { path, sql: "CREATE TABLE t(a)", allowWrite: true }, () => false));
    expect(denied.status).toBe(403);
    const batch = await router.route(makeRequest("/exec", { path, sql: "CREATE TABLE t(a)" }, writable));
    expect(batch.status).toBe(403);
    expect(((await batch.json()) as { code: string }).code).toBe("not_read_only");
    const allowed = await router.route(makeRequest("/exec", { path, sql: "CREATE TABLE t(a)", allowWrite: true }, writable));
    expect(allowed.status).toBe(200);
  });

  test("migration preview rolls back and apply commits", async () => {
    const script = "CREATE TABLE migrated (id INTEGER PRIMARY KEY);";
    const preview = await router.route(makeRequest("/migration/preview", { path, sql: script }, writable));
    expect(preview.status).toBe(200);
    const check = new Database(path, { readonly: true });
    expect(check.query("SELECT name FROM sqlite_master WHERE name = 'migrated'").get()).toBeNull();
    check.close();
    const denied = await router.route(makeRequest("/migration/apply", { path, sql: script, allowWrite: true }, () => false));
    expect(denied.status).toBe(403);
    const applied = await router.route(makeRequest("/migration/apply", { path, sql: script, allowWrite: true }, writable));
    expect(applied.status).toBe(200);
    const verify = new Database(path, { readonly: true });
    expect(verify.query("SELECT name FROM sqlite_master WHERE name = 'migrated'").get()).toBeTruthy();
    verify.close();
  });

  test("rows preview compiles and apply writes in a transaction", async () => {
    const changes = [{
      kind: "update" as const,
      table: { name: "users" },
      key: { id: 1 },
      expected: { id: 1, name: "Ada" },
      values: { name: "Augusta" },
    }];
    const preview = await router.route(makeRequest("/rows/preview", { changes }, writable));
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { statements: unknown[] }).statements).toHaveLength(1);
    const denied = await router.route(makeRequest("/rows/apply", { path, changes, allowWrite: true }, () => false));
    expect(denied.status).toBe(403);
    const applied = await router.route(makeRequest("/rows/apply", { path, changes, allowWrite: true }, writable));
    expect(applied.status).toBe(200);
    const check = new Database(path, { readonly: true });
    expect(check.query<{ name: string }, []>("SELECT name FROM users WHERE id = 1").get()?.name).toBe("Augusta");
    check.close();
  });

  test("a redis profile has no relational provider", async () => {
    const res = await router.route(makeRequest("/schema", { connId: "p1" }, writable));
    expect(res.status).toBe(404);
  });

  // The UI's schema GET sends includeSystem as a searchParam, which app.ts
  // surfaces in the body as the string "true" — the router must coerce it.
  test("/schema coerces the GET includeSystem string to a boolean", async () => {
    let seen: boolean | undefined;
    const { driver } = fakeDriver({
      id: "fakerel",
      session: {
        relational: {
          async schema(_signal: AbortSignal | undefined, includeSystem?: boolean) {
            seen = includeSystem;
            return { schemas: [], tables: [], indexes: [], triggers: [], pragmas: {} };
          },
        } as never,
      },
    });
    const relRegistry = createDriverRegistry();
    relRegistry.register(driver);
    const relRouter = makeDatasourceRouter(
      { get: async () => ({ id: "rel1", driver: "fakerel" }), resolveUrl: async () => "fakerel://x" },
      relRegistry,
    );
    const res = await relRouter.route(makeRequest("/schema", { connId: "rel1", includeSystem: "true" }, writable));
    expect(res.status).toBe(200);
    expect(seen).toBe(true);
  });
});
