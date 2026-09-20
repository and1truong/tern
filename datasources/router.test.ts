import { describe, test, expect } from "bun:test";
import { makeDatasourceRouter, type Profiles } from "./router.ts";
import { createDriverRegistry } from "./registry.ts";
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
  return { path, body, url: new URL("http://127.0.0.1/api/datasource" + path), writable };
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

  test("/exec without a console provider is 404", async () => {
    const { driver } = fakeDriver({ session: { console: undefined } });
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    const res = await router.route(makeRequest("/exec", { connId: "p1", command: "PING" }));
    expect(res.status).toBe(404);
  });

  test("/exec enforces the session writability callback", async () => {
    const { driver } = fakeDriver();
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    await router.route(makeRequest("/session", { connId: "p1" }));
    const denied = await router.route(makeRequest("/exec", { connId: "p1", command: "SET k v" }, () => false));
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { code: string }).code).toBe("not_read_only");
    const allowed = await router.route(makeRequest("/exec", { connId: "p1", command: "SET k v" }, () => true));
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

  test("/key/op requires an explicitly writable session", async () => {
    const { driver } = fakeDriver();
    const registry = createDriverRegistry();
    registry.register(driver);
    const router = makeDatasourceRouter(profiles, registry);
    const denied = await router.route(makeRequest("/key/op", { connId: "p1", op: { op: "delete", keys: ["a"] } }, () => false));
    expect(denied.status).toBe(400);
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

    const denied = await router.route(makeRequest("/exec", { connId: "p1", command: "SET k v" }, () => false));
    expect(denied.status).toBe(400);
    // A read-only rejection is logical: the healthy session stays cached.
    expect(closed).toBe(0);
    failMode = "none";
    const ok = await router.route(makeRequest("/exec", { connId: "p1", command: "GET k" }, () => true));
    expect(ok.status).toBe(200);
    expect(connectCount()).toBe(1);

    failMode = "transport";
    const broken = await router.route(makeRequest("/exec", { connId: "p1", command: "GET k" }, () => true));
    expect(broken.status).toBe(400);
    expect(closed).toBe(1);
    // The broken session was evicted: the next call reconnects.
    await router.route(makeRequest("/exec", { connId: "p1", command: "GET k" }, () => true));
    expect(connectCount()).toBe(2);
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
