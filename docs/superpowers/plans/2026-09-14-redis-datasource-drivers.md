# Redis/Valkey Datasource Drivers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship issue #2 Phase 1 — Redis/Valkey support behind a pluggable datasource driver layer (connection + capability detection, SCAN key explorer, type-aware value viewer, console, deterministic autocomplete/explain/lint), with zero new runtime dependencies.

**Architecture:** A `DataSourceDriver` contract with optional capability providers (`console`, `explorer`) lives in a new isomorphic `datasources/` directory; the Redis-compatible driver implements it over an injected `RespTransport` (Bun's `RedisClient` in production, fakes in tests). A generic `/api/datasource/*` router resolves saved profiles → driver → session and enforces the existing read-only session model. The React client gains a Redis key explorer (sidebar), key viewer, and command console consuming pure driver modules (catalog/autocomplete/explain/lint) plus new `DbSource`/`Document` kinds.

**Tech Stack:** Bun runtime (`Bun.RedisClient` as private transport detail), React 18 + CodeMirror (`@uiw/react-codemirror`, plain-text mode for the console), Tailwind 4 (existing classes), `bun:sqlite` for profiles, `bun test` + `tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-09-14-redis-datasource-drivers-design.md`

## Global Constraints

- No new npm dependencies. Redis transport is `Bun.RedisClient` only (issue dependency policy).
- `Bun.RedisClient` types may appear **only** inside `datasources/redis/driver.ts`. Contracts are Bun-free.
- Key browsing uses `SCAN` only; `KEYS` never executes.
- Warnings/lint never rewrite user commands; the console executes the exact text.
- Writes (exec of write-classified commands, all key mutations) require the existing writable-session toggle (`/api/access`), which stays read-only by default for saved profiles.
- Existing style: no semicolons at statement end is NOT used — this codebase **uses** the surrounding style of each file; server files use semicolons, src files mix — match the file you edit. Tests colocated as `<name>.test.ts`, run with `bun test`.
- Verify each task: `bun run typecheck` then targeted `bun test <file>`. Full gates at the end: `make check` (typecheck, test, ui-smoke, build).
- After each task: commit with the message given in the task.

---

### Task 1: Contracts, registry, wire types, tsconfig

**Files:**
- Create: `datasources/contracts.ts`
- Create: `datasources/registry.ts`
- Modify: `shared.ts` (append wire types; leave existing types untouched)
- Modify: `tsconfig.json` (include `datasources/**/*.ts`)
- Test: `datasources/registry.test.ts`

**Interfaces:**
- Produces: `DataSourceDriver`, `DriverSession`, `ConsoleProvider`, `KeyValueExplorerProvider`, `ConnectionConfig`, `ExecContext`, `CommandResultRef`, `DriverRegistry` (`registerDriver`, `getDriver`, `listDrivers`), wire types in `shared.ts`: `RespValue`, `DataSourceInfo`, `Capabilities`, `ScanPage`, `KeyInspection`, `KeyValueView`, `KeyOp`, `KeyOpResult`, `CommandResult`.

- [ ] **Step 1: Write the failing registry test**

```ts
// datasources/registry.test.ts
import { describe, test, expect } from "bun:test";
import { createDriverRegistry } from "./registry.ts";
import type { DataSourceDriver } from "./contracts.ts";

const fake = (id: string): DataSourceDriver => ({
  id, displayName: id, kind: "key-value",
  validateUrl: () => {}, test: undefined as never, connect: undefined as never,
});

describe("driver registry", () => {
  test("registers, resolves and lists drivers", () => {
    const registry = createDriverRegistry();
    const a = fake("a");
    registry.register(a);
    expect(registry.get("a")).toBe(a);
    expect(registry.get("missing")).toBeNull();
    expect(registry.list().map(d => d.id)).toEqual(["a"]);
  });
  test("last registration wins for the same id", () => {
    const registry = createDriverRegistry();
    registry.register(fake("a"));
    const b = fake("a");
    registry.register(b);
    expect(registry.get("a")).toBe(b);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test datasources/registry.test.ts`
Expected: FAIL — cannot find module `./contracts.ts`/`./registry.ts`.

- [ ] **Step 3: Write contracts**

```ts
// datasources/contracts.ts
// Datasource driver contracts. Isomorphic: imported by the Bun server and the
// browser bundle. No runtime-specific imports (Bun clients stay inside driver
// implementations, e.g. datasources/redis/driver.ts).
import type {
  CommandResult, DataSourceInfo, KeyInspection, KeyOp, KeyOpResult, ScanPage,
} from "../shared.ts";
import type { CommandDoc } from "./redis/catalog.ts";

export interface ConnectionConfig {
  url: string;              // credential-bearing; resolved server-side, never sent to the client
  database?: string;        // logical database (Redis db index as string)
}

export interface ExecContext {
  writable: boolean;        // session writes explicitly enabled via /api/access
}

// One command execution through the driver's console provider.
export type ConsoleExec = (command: string, ctx: ExecContext) => Promise<CommandResult>;

export interface ConsoleProvider {
  exec: ConsoleExec;
  catalog(): Promise<CommandDoc[]>;   // built-in catalog merged with runtime metadata when available
}

export interface ScanQuery {
  cursor: string;           // "0" starts a new iteration
  match?: string;           // glob pattern
  count?: number;           // hint per SCAN call
  type?: string;            // requires server >= 6
}

export interface KeyValueExplorerProvider {
  scan(q: ScanQuery): Promise<ScanPage>;
  inspect(key: string, cursor?: string): Promise<KeyInspection>;
  keyOp(op: KeyOp): Promise<KeyOpResult>;
}

export interface DriverSession {
  info: DataSourceInfo;
  console?: ConsoleProvider;
  explorer?: KeyValueExplorerProvider;
  close(): Promise<void>;
}

export interface DataSourceDriver {
  id: string;               // "redis", "postgres", ...
  displayName: string;
  kind: string;             // "key-value", "relational", ...
  validateUrl(url: string): void;    // throws Error with a user-facing message
  test(config: ConnectionConfig): Promise<DataSourceInfo>;
  connect(config: ConnectionConfig): Promise<DriverSession>;
}

export interface DriverRegistry {
  register(driver: DataSourceDriver): void;
  get(id: string): DataSourceDriver | null;
  list(): DataSourceDriver[];
}
```

```ts
// datasources/registry.ts
import type { DataSourceDriver, DriverRegistry } from "./contracts.ts";

export function createDriverRegistry(): DriverRegistry {
  const drivers = new Map<string, DataSourceDriver>();
  return {
    register: (driver) => { drivers.set(driver.id, driver); },
    get: (id) => drivers.get(id) ?? null,
    list: () => [...drivers.values()],
  };
}
```

- [ ] **Step 4: Append wire types to `shared.ts`**

```ts
// --- Datasource driver wire shapes (HTTP JSON between /api/datasource/* and the client) ---

export type RedisFlavor = "redis" | "valkey" | "unknown";

export interface Capabilities {
  streams: boolean;   // >= 5.0
  acl: boolean;       // >= 6.0
  functions: boolean; // >= 7.0
  cluster: boolean;
  modules: boolean;
  search: boolean;    // a search module (RedSearch / Valkey search) is loaded
}

export interface DataSourceInfo {
  flavor: RedisFlavor;
  version: string;
  capabilities: Capabilities;
  summary: Record<string, string | number | boolean>;  // small human-facing facts (uptime, port, memory…)
}

// Tagged RESP values so the console can render nested replies verbatim.
export type RespValue =
  | { t: "nil" }
  | { t: "str"; s: string }                    // simple + bulk strings
  | { t: "int"; n: number }
  | { t: "dbl"; n: number }
  | { t: "bool"; b: boolean }
  | { t: "err"; s: string }
  | { t: "big"; s: string }                    // big number, string-encoded
  | { t: "verb"; format: string; s: string }   // verbatim string (RESP3)
  | { t: "arr"; items: RespValue[] }
  | { t: "map"; entries: [RespValue, RespValue][] }
  | { t: "set"; items: RespValue[] };

export interface CommandResult {
  reply: RespValue;   // server reply; command errors arrive as { t: "err" }
  ms: number;
}

export interface ScanPage {
  cursor: string;     // "0" when the iteration is complete
  keys: { key: string; type: string }[];
}

export type KeyValueView =
  | { kind: "string"; value: string; truncated: boolean; lengthBytes: number }
  | { kind: "hash"; entries: { field: string; value: string }[]; cursor: string; truncated: boolean }
  | { kind: "list"; items: string[]; start: number; truncated: boolean }
  | { kind: "set"; members: string[]; cursor: string; truncated: boolean }
  | { kind: "zset"; entries: { member: string; score: number }[]; cursor: string; truncated: boolean }
  | { kind: "stream"; length: number; entries: { id: string; fields: Record<string, string> }[]; lastId: string | null; truncated: boolean }
  | { kind: "none" }
  | { kind: "unknown"; note: string };

export interface KeyInspection {
  key: string;
  type: string;             // string|list|set|zset|hash|stream|none|unknown server type
  ttlSeconds: number;       // -1 no expiry, -2 missing key
  memoryBytes: number | null;
  size: number | null;      // cardinality / length / strlen
  value: KeyValueView;
}

export type KeyOp =
  | { op: "rename"; from: string; to: string }
  | { op: "delete"; keys: string[] }
  | { op: "expire"; key: string; seconds: number }
  | { op: "persist"; key: string }
  | { op: "setString"; key: string; value: string }
  | { op: "hashSet"; key: string; field: string; value: string }
  | { op: "hashDelete"; key: string; fields: string[] }
  | { op: "setAdd"; key: string; members: string[] }
  | { op: "setRemove"; key: string; members: string[] }
  | { op: "zsetAdd"; key: string; member: string; score: number }
  | { op: "zsetRemove"; key: string; members: string[] }
  | { op: "listSet"; key: string; index: number; value: string };

export interface KeyOpResult {
  ok: boolean;
  n?: number;       // keys/members affected when meaningful
  error?: string;   // server error text when ok === false
}
```

Also update `tsconfig.json` include: add `"datasources/**/*.ts"` to the array.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test datasources/registry.test.ts && bun run typecheck`
Expected: registry PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add datasources/ shared.ts tsconfig.json
git commit -m "feat(datasources): driver contracts, registry and wire types"
```

---

### Task 2: RESP utilities — tokenizer + JSON encoder

**Files:**
- Create: `datasources/redis/resp.ts`
- Test: `datasources/redis/resp.test.ts`

**Interfaces:**
- Produces: `tokenizeCommand(input: string): string[]`, `encodeRESP(value: unknown): RespValue`, `unquoteToken(token: string): string` is internal — tokenize returns final strings.

- [ ] **Step 1: Write failing tests**

```ts
// datasources/redis/resp.test.ts
import { describe, test, expect } from "bun:test";
import { tokenizeCommand, encodeRESP } from "./resp.ts";

describe("tokenizeCommand", () => {
  test("splits on whitespace", () => {
    expect(tokenizeCommand("ZRANGE leaderboard 0 9 REV WITHSCORES")).toEqual(
      ["ZRANGE", "leaderboard", "0", "9", "REV", "WITHSCORES"]);
  });
  test("collapses runs of spaces and trims", () => {
    expect(tokenizeCommand("  GET   key  ")).toEqual(["GET", "key"]);
  });
  test("double quotes with escapes", () => {
    expect(tokenizeCommand('SET k "hello \\"world\\"\n"')).toEqual(["SET", "k", 'hello "world"\n']);
  });
  test("single quotes: literal backslash, doubled quote escapes", () => {
    expect(tokenizeCommand("SET k 'a\\nb''c'")).toEqual(["SET", "k", "a\\nb'c"]);
  });
  test("mismatched quote throws with position", () => {
    expect(() => tokenizeCommand('SET k "unterminated')).toThrow(/quote/);
  });
  test("empty input yields empty array", () => {
    expect(tokenizeCommand("")).toEqual([]);
    expect(tokenizeCommand("   ")).toEqual([]);
  });
});

describe("encodeRESP", () => {
  test("scalars", () => {
    expect(encodeRESP(null)).toEqual({ t: "nil" });
    expect(encodeRESP("OK")).toEqual({ t: "str", s: "OK" });
    expect(encodeRESP(5)).toEqual({ t: "int", n: 5 });
    expect(encodeRESP(1.5)).toEqual({ t: "dbl", n: 1.5 });
    expect(encodeRESP(true)).toEqual({ t: "bool", b: true });
    expect(encodeRESP(10n)).toEqual({ t: "big", s: "10" });
  });
  test("error instances become err replies", () => {
    expect(encodeRESP(new Error("ERR wrong number"))).toEqual({ t: "err", s: "ERR wrong number" });
  });
  test("arrays, maps, sets and nested values", () => {
    expect(encodeRESP(["a", 1, null])).toEqual({ t: "arr", items: [{ t: "str", s: "a" }, { t: "int", n: 1 }, { t: "nil" }] });
    expect(encodeRESP(new Map([["k", 1]]))).toEqual({ t: "map", entries: [[{ t: "str", s: "k" }, { t: "int", n: 1 }]] });
    expect(encodeRESP(new Set(["a"]))).toEqual({ t: "set", items: [{ t: "str", s: "a" }] });
  });
  test("Uint8Array decodes lossily to str", () => {
    expect(encodeRESP(new Uint8Array([104, 105]))).toEqual({ t: "str", s: "hi" });
  });
  test("objects fall back to string form", () => {
    expect(encodeRESP({ a: 1 })).toEqual({ t: "str", s: "[object Object]" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test datasources/redis/resp.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// datasources/redis/resp.ts
// Redis command-line tokenizing and RESP → JSON encoding. Pure, shared by
// server (console execution) and client (autocomplete/explain/lint parsing).
import type { RespValue } from "../../shared.ts";

// Tokenize a command line following redis-cli rules: whitespace separates
// tokens; "double quotes" support \x hex, \n \r \t \b \a and \\ escapes plus
// \" for a literal quote; 'single quotes' support only \' via doubled '' and
// keep backslashes literal.
export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && /\s/.test(input[i]!)) i++;
    if (i >= n) break;
    let token = "";
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i++]!;
      for (;;) {
        if (i >= n) throw new Error(`Unmatched ${quote === '"' ? "double" : "single"} quote in command`);
        const ch = input[i++]!;
        if (ch === quote) {
          if (quote === "'" && input[i] === "'") { token += "'"; i++; continue; }
          break;
        }
        if (quote === '"' && ch === "\\") {
          if (i >= n) throw new Error("Unmatched escape at end of command");
          const esc = input[i++]!;
          const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", a: "\a", '"': '"', "\\": "\\" };
          if (esc === "x") {
            const hex = input.slice(i, i + 2);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error("Invalid \\x escape in command");
            token += String.fromCharCode(parseInt(hex, 16)); i += 2;
          } else if (esc in simple) token += simple[esc]!;
          else throw new Error(`Unsupported escape \\${esc} in command`);
        } else token += ch;
      }
    } else {
      while (i < n && !/\s/.test(input[i]!)) { token += input[i++]!; }
    }
    tokens.push(token);
  }
  return tokens;
}

// Encode an arbitrary parsed RESP value (as returned by the transport) into the
// tagged wire form. The transport may hand us strings, numbers, booleans,
// bigint, null, arrays, Maps, Sets, Errors and Uint8Arrays.
export function encodeRESP(value: unknown): RespValue {
  if (value === null || value === undefined) return { t: "nil" };
  if (value instanceof Error) return { t: "err", s: value.message };
  switch (typeof value) {
    case "string": return { t: "str", s: value };
    case "boolean": return { t: "bool", b: value };
    case "bigint": return { t: "big", s: value.toString() };
    case "number": return Number.isInteger(value) ? { t: "int", n: value } : { t: "dbl", n: value };
  }
  if (value instanceof Uint8Array) return { t: "str", s: new TextDecoder("utf-8", { fatal: false }).decode(value) };
  if (Array.isArray(value)) return { t: "arr", items: value.map(encodeRESP) };
  if (value instanceof Map) return { t: "map", entries: [...value].map(([k, v]) => [encodeRESP(k), encodeRESP(v)] as [RespValue, RespValue]) };
  if (value instanceof Set) return { t: "set", items: [...value].map(encodeRESP) };
  return { t: "str", s: String(value) };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test datasources/redis/resp.test.ts && bun run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add datasources/redis/resp.ts datasources/redis/resp.test.ts
git commit -m "feat(redis): command tokenizer and RESP JSON encoder"
```

---

### Task 3: Flavor/capability detection from INFO

**Files:**
- Create: `datasources/redis/capabilities.ts`
- Test: `datasources/redis/capabilities.test.ts`

**Interfaces:**
- Consumes: `DataSourceInfo`, `Capabilities`, `RedisFlavor` from `shared.ts`.
- Produces: `parseInfoSections(raw: string | Record<string, unknown>): { sections: Record<string, string>; modules: string[] }`, `detectDataSourceInfo(raw: string | Record<string, unknown>): DataSourceInfo`.

- [ ] **Step 1: Write failing tests** — fixtures for Redis 7.2.4, Valkey 8.1.1, Redis 5.0.14 (no `valkey_version`, no `acl` capability), cluster enabled, module lines. Include `totalKeys` derivation from `keyspace` lines (`db0:keys=3,expires=1,avg_ttl=0`).

```ts
// datasources/redis/capabilities.test.ts
import { describe, test, expect } from "bun:test";
import { parseInfoSections, detectDataSourceInfo } from "./capabilities.ts";

const redis72 = [
  "# Server",
  "redis_version:7.2.4",
  "redis_mode:standalone",
  "os:Linux",
  "tcp_port:6379",
  "uptime_in_seconds:100",
  "# Clients",
  "connected_clients:2",
  "# Memory",
  "used_memory_human:1.00M",
  "# Persistence",
  "# Stats",
  "# Replication",
  "role:master",
  "# CPU",
  "# Cluster",
  "cluster_enabled:0",
  "# Keyspace",
  "db0:keys=3,expires=1,avg_ttl=0",
].join("\r\n");

const valkey81 = redis72
  .replace("redis_version:7.2.4", "redis_version:7.2.4\nvalkey_version:8.1.1");

const redis5 = redis72.replace("redis_version:7.2.4", "redis_version:5.0.14");

const withModules = redis72 + "\r\n# Modules\r\nmodule:name=search,ver=20800,api=1";

describe("parseInfoSections", () => {
  test("flattens key:value lines and ignores comments", () => {
    const { sections, modules } = parseInfoSections(redis72);
    expect(sections.redis_version).toBe("7.2.4");
    expect(sections.cluster_enabled).toBe("0");
    expect(sections.db0).toBe("keys=3,expires=1,avg_ttl=0");
    expect(modules).toEqual([]);
  });
  test("collects module names", () => {
    const { modules } = parseInfoSections(withModules);
    expect(modules).toEqual(["search"]);
  });
  test("tolerates an already-parsed object (some transports pre-parse INFO)", () => {
    const { sections } = parseInfoSections({ redis_version: "7.0.0" });
    expect(sections.redis_version).toBe("7.0.0");
  });
});

describe("detectDataSourceInfo", () => {
  test("redis 7.2: flavor, version, capabilities, summary", () => {
    const info = detectDataSourceInfo(redis72);
    expect(info.flavor).toBe("redis");
    expect(info.version).toBe("7.2.4");
    expect(info.capabilities).toEqual({ streams: true, acl: true, functions: true, cluster: false, modules: false, search: false });
    expect(info.summary.totalKeys).toBe(3);
    expect(info.summary.tcpPort).toBe(6379);
  });
  test("valkey reports valkey flavor while keeping redis_version compat line", () => {
    const info = detectDataSourceInfo(valkey81);
    expect(info.flavor).toBe("valkey");
    expect(info.version).toBe("8.1.1");
  });
  test("redis 5 predates acl/functions", () => {
    const info = detectDataSourceInfo(redis5);
    expect(info.capabilities).toEqual({ streams: true, acl: false, functions: false, cluster: false, modules: false, search: false });
  });
  test("cluster + search module flags", () => {
    const info = detectDataSourceInfo(withModules.replace("cluster_enabled:0", "cluster_enabled:1"));
    expect(info.capabilities.cluster).toBe(true);
    expect(info.capabilities.search).toBe(true);
    expect(info.capabilities.modules).toBe(true);
  });
  test("unknown server yields unknown flavor and no capabilities", () => {
    const info = detectDataSourceInfo("# Server\r\nfoo:bar");
    expect(info.flavor).toBe("unknown");
    expect(info.version).toBe("");
    expect(info.capabilities).toEqual({ streams: false, acl: false, functions: false, cluster: false, modules: false, search: false });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `bun test datasources/redis/capabilities.test.ts`

- [ ] **Step 3: Implement**

```ts
// datasources/redis/capabilities.ts
// Server metadata → flavor/version/capabilities. Pure: unit-testable, and the
// UI's feature decisions consume Capabilities rather than product names.
import type { Capabilities, DataSourceInfo, RedisFlavor } from "../../shared.ts";

function versionParts(version: string): [number, number, number] {
  const [maj = 0, min = 0, pat = 0] = version.split(".").map(Number);
  return [maj, min, pat];
}
const since = (version: string, maj: number, min = 0) => versionParts(version)[0] > maj
  || (versionParts(version)[0] === maj && versionParts(version)[1] >= min);

export function parseInfoSections(raw: string | Record<string, unknown>): {
  sections: Record<string, string>; modules: string[];
} {
  const sections: Record<string, string> = {};
  const modules: string[] = [];
  if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) sections[k] = String(v);
    return { sections, modules };
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("module:")) {
      const name = /(?:^|,)name=([^,]+)/.exec(line)?.[1];
      if (name) modules.push(name);
      continue;
    }
    const idx = line.indexOf(":");
    if (idx > 0) sections[line.slice(0, idx)!] = line.slice(idx + 1);
  }
  return { sections, modules };
}

export function detectDataSourceInfo(raw: string | Record<string, unknown>): DataSourceInfo {
  const { sections, modules } = parseInfoSections(raw);
  const flavor: RedisFlavor = sections.valkey_version ? "valkey" : sections.redis_version ? "redis" : "unknown";
  const version = sections.valkey_version ?? sections.redis_version ?? "";
  const capabilities: Capabilities = {
    streams: since(version, 5),
    acl: since(version, 6),
    functions: since(version, 7),
    cluster: sections.cluster_enabled === "1",
    modules: modules.length > 0,
    search: modules.some(m => m.includes("search")),
  };
  let totalKeys = 0;
  for (const [key, value] of Object.entries(sections)) {
    if (/^db\d+$/.test(key)) totalKeys += Number(/keys=(\d+)/.exec(value)?.[1] ?? 0);
  }
  const summary: Record<string, string | number | boolean> = { totalKeys };
  for (const field of ["tcp_port", "uptime_in_seconds", "connected_clients", "used_memory_human", "role", "os"] as const) {
    if (sections[field] !== undefined) summary[field] = /^\d+$/.test(sections[field]!) ? Number(sections[field]) : sections[field]!;
  }
  return { flavor, version, capabilities, summary };
}
```

- [ ] **Step 4: Run tests** — `bun test datasources/redis/capabilities.test.ts && bun run typecheck` — expected PASS.

- [ ] **Step 5: Commit** — `git add datasources/redis/capabilities.ts* && git commit -m "feat(redis): flavor and capability detection from INFO"`

---

### Task 4: Redis connection config (URL build/validate)

**Files:**
- Create: `datasources/redis/connection.ts`
- Test: `datasources/redis/connection.test.ts`

**Interfaces:**
- Produces: `buildRedisUrl(opts: { host: string; port?: number; username?: string; password?: string; tls?: boolean; database?: number }): string`, `validateRedisUrl(url: string): void`, `sessionUrl(url: string, database?: string): string`, `REDIS_DEFAULT_PORT = 6379`.

- [ ] **Step 1: Write failing tests**

```ts
// datasources/redis/connection.test.ts
import { describe, test, expect } from "bun:test";
import { buildRedisUrl, validateRedisUrl, sessionUrl } from "./connection.ts";

describe("buildRedisUrl", () => {
  test("host only", () => expect(buildRedisUrl({ host: "localhost" })).toBe("redis://localhost:6379"));
  test("port, db index, tls scheme", () => {
    expect(buildRedisUrl({ host: "db.example.com", port: 6380, database: 2 })).toBe("redis://db.example.com:6380/2");
    expect(buildRedisUrl({ host: "db.example.com", tls: true })).toBe("rediss://db.example.com:6379");
  });
  test("password only targets the default user; username included when present", () => {
    expect(buildRedisUrl({ host: "h", password: "secret" })).toBe("redis://:secret@h:6379");
    expect(buildRedisUrl({ host: "h", username: "default", password: "secret" })).toBe("redis://default:secret@h:6379");
  });
});

describe("validateRedisUrl", () => {
  test("accepts redis and rediss urls with host", () => {
    expect(() => validateRedisUrl("redis://localhost:6379")).not.toThrow();
    expect(() => validateRedisUrl("rediss://:pw@h/0")).not.toThrow();
  });
  test("rejects wrong scheme, missing host, non-numeric db, query params", () => {
    expect(() => validateRedisUrl("postgres://h")).toThrow(/redis/i);
    expect(() => validateRedisUrl("redis://")).toThrow(/host/i);
    expect(() => validateRedisUrl("redis://h/abc")).toThrow(/database/i);
    expect(() => validateRedisUrl("redis://h/?foo=bar")).toThrow(/option/i);
  });
});

describe("sessionUrl", () => {
  test("applies the db index while preserving userinfo", () => {
    expect(sessionUrl("redis://:pw@h:6379", "3")).toBe("redis://:pw@h:6379/3");
    expect(sessionUrl("redis://:pw@h:6379/9", "0")).toBe("redis://:pw@h:6379/0");
    expect(sessionUrl("redis://h:6379", undefined)).toBe("redis://h:6379");
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

```ts
// datasources/redis/connection.ts
// Connection-string handling for the Redis-compatible driver. The URL carries
// host/port, username/password, TLS (rediss scheme) and logical db (path) —
// mirroring how the Postgres driver treats its connection URL.
export const REDIS_DEFAULT_PORT = 6379;

export function buildRedisUrl(opts: { host: string; port?: number; username?: string; password?: string; tls?: boolean; database?: number }): string {
  const auth = opts.password !== undefined
    ? `//${encodeURIComponent(opts.username ?? "")}:${encodeURIComponent(opts.password)}@`
    : "//";
  const db = opts.database !== undefined && opts.database > 0 ? `/${opts.database}` : "";
  return `${opts.tls ? "rediss" : "redis"}:${auth}${opts.host}${opts.port && opts.port !== REDIS_DEFAULT_PORT ? `:${opts.port}` : ""}${db || (opts.port === undefined ? ":6379" : "")}`;
}
```

Careful — the test expects `redis://localhost:6379` and `redis://db.example.com:6380/2` and `redis://h:6379` forms. Simplify to always include the port explicitly and db path only when > 0:

```ts
export function buildRedisUrl(opts: { host: string; port?: number; username?: string; password?: string; tls?: boolean; database?: number }): string {
  const auth = opts.password !== undefined ? `//${encodeURIComponent(opts.username ?? "")}:${encodeURIComponent(opts.password)}@` : "//";
  const port = opts.port ?? REDIS_DEFAULT_PORT;
  const db = opts.database !== undefined && opts.database > 0 ? `/${opts.database}` : "";
  return `${opts.tls ? "rediss" : "redis"}:${auth}${opts.host}:${port}${db}`;
}

export function validateRedisUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Invalid Redis URL"); }
  if (!["redis:", "rediss:"].includes(parsed.protocol)) throw new Error("A Redis URL (redis:// or rediss://) is required");
  if (!parsed.hostname) throw new Error("A Redis URL with a host is required");
  const db = parsed.pathname.replace(/^\//, "");
  if (db && !/^\d+$/.test(db)) throw new Error("The Redis URL database must be a numeric db index");
  if (parsed.port && !/^\d+$/.test(parsed.port)) throw new Error("Invalid Redis URL port");
  for (const key of parsed.searchParams.keys()) throw new Error(`Unsupported Redis URL option: ${key}`);
}

// Apply (or replace) the logical db index for a session; keeps credentials.
export function sessionUrl(url: string, database?: string): string {
  const parsed = new URL(url);
  if (database === undefined || database === "") return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : ""}`.length >= 0 ? rebuild(url, undefined) : url;
  return rebuild(url, database);
}

function rebuild(url: string, database: string | undefined): string {
  const parsed = new URL(url);
  const dbPath = database !== undefined && database !== "" && database !== "0" ? `/${database}` : "";
  return `${parsed.protocol}//${parsed.username}${parsed.password ? `:${parsed.password}` : ""}${parsed.username || parsed.password ? "@" : ""}${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${dbPath}`;
}
```

(Executor: keep only `buildRedisUrl` from the first block, `validateRedisUrl`, and the corrected `sessionUrl` + `rebuild` — the intermediate draft line in `sessionUrl` above is superseded. Final `sessionUrl` delegates to `rebuild` unconditionally.)

- [ ] **Step 4: Run tests** — `bun test datasources/redis/connection.test.ts && bun run typecheck`

- [ ] **Step 5: Commit** — `git commit -am "feat(redis): connection url build/validate"`

---

### Task 5: Command catalog

**Files:**
- Create: `datasources/redis/catalog.ts` (types + data + lookup)
- Test: `datasources/redis/catalog.test.ts`

**Interfaces:**
- Produces: `CommandDoc`, `CommandArgSpec`, `CommandGroup`, `COMMAND_GROUPS`, `commandCatalog: CommandDoc[]`, `lookupCommand(name: string): CommandDoc | null`, `isWriteCommand(doc: CommandDoc | null): boolean` (null → false; `access !== "read"` → true), `blockingTimeoutSeconds(doc: CommandDoc, args: string[]): number | null` (null = not blocking / undetermined; 0 = indefinite).

**Catalog authoring rules (enforced by the integrity test):**

```ts
export type CommandGroup =
  | "key" | "string" | "hash" | "list" | "set" | "sorted-set" | "stream"
  | "connection" | "server" | "scripting" | "pubsub" | "transactions" | "cluster";

export interface CommandArgSpec {
  name: string;
  type?: "key" | "string" | "int" | "double" | "pattern" | "enum" | "unix-time";
  description?: string;
  enum?: string[];        // for type "enum": literal tokens
  optional?: boolean;
  multiple?: boolean;     // repeats (with its enum values if present)
  /** count of trailing tokens this spec consumes when multiple; default 1 */
}

export interface CommandDoc {
  name: string;               // canonical uppercase
  group: CommandGroup;
  arity: number;              // Redis arity: positive exact, negative means minimum (-x ⇒ at least x incl. command name)
  summary: string;
  since: string;
  access: "read" | "write" | "read-write" | "admin";
  complexity?: string;
  args?: CommandArgSpec[];
  returns?: string;           // expected result, human phrasing
  blocking?: boolean;
  ttl?: "clear" | "set" | "none";
  danger?: "destructive" | "full-scan" | "admin" | "config";
  keyPositions?: number[];    // 0-based arg positions (after the command name) holding key names
  notes?: string;             // cluster/large-key guidance shown by explain
}
```

**Full command list to author** (one `CommandDoc` per name; `keyPositions` and `args` required wherever listed):

- key: `DEL`(k1+,write,clear,"O(N)"), `UNLINK`(k1+,write,clear,"O(N)"), `EXISTS`(k1+,read), `EXPIRE`(k,k,int,"O(1)",ttl:"set"), `EXPIREAT`(k,k,int,unix-time), `PEXPIRE`, `PTTL`, `TTL`, `PERSIST`(ttl:"set"), `TYPE`, `RENAME`(k,k), `RENAMENX`(k,k), `SCAN`(cursor int + MATCH pattern + COUNT int + TYPE enum[strings "MATCH","COUNT","TYPE"]), `RANDOMKEY`, `DBSIZE`, `KEYS`(pattern,danger:"full-scan",notes:"Loads every key; use SCAN"), `FLUSHDB`(async/sync enum,admin,destructive), `FLUSHALL`(same), `TOUCH`(k+), `COPY`(k,k,optional enum ["DB","REPLACE"]), `MOVE`(k,k,int), `OBJECT`(subcommand enum ["ENCODING","FREQ","IDLETIME","REFCOUNT"] + key), `MEMORY`(subcommand enum ["USAGE"] + key,admin)
- string: `GET`,`SET`(key,value + enum opts ["EX","PX","EXAT","PXAT","KEEPTTL","NX","XX","GET"] with int args where relevant, write, ttl:"clear" unless KEEPTTL — set ttl:"clear" + notes explaining KEEPTTL),`SETNX`,`SETEX`(key,int,value,ttl:"set"),`PSETEX`,`MSET`(key,value multiple,write),`MSETNX`,`MGET`(k+),`INCR`,`INCRBY`,`INCRBYFLOAT`,`DECR`,`DECRBY`,`APPEND`,`STRLEN`,`GETRANGE`,`SETRANGE`,`GETDEL`,`GETEX`(opts),`GETSET`
- hash: `HSET`(key,field,value multiple),`HGET`,`HGETALL`,`HMGET`,`HDEL`,`HLEN`,`HKEYS`,`HVALS`,`HEXISTS`,`HINCRBY`,`HINCRBYFLOAT`,`HSETNX`,`HSTRLEN`,`HSCAN`(key,cursor + MATCH/COUNT/NOVALUES)
- list: `LPUSH`,`RPUSH`,`LPUSHX`,`RPUSHX`,`LPOP`(optional count int),`RPOP`,`LLEN`,`LRANGE`(key,start int,stop int),`LINDEX`,`LSET`(key,int,value),`LREM`,`LTRIM`,`LINSERT`,`LMOVE`,`RPOPLPUSH`,`BLPOP`(k+ then timeout,double-arg key-tuple handling: keyPositions = all but last,blocking),`BRPOP`(same),`BLMOVE`,`BRPOPLPUSH`,`LPOS`
- set: `SADD`,`SREM`,`SMEMBERS`(danger full-scan on big keys? no — unbounded read note in notes),`SCARD`,`SISMEMBER`,`SMISMEMBER`,`SPOP`,`SRANDMEMBER`,`SMOVE`,`SDIFF`,`SDIFFSTORE`,`SINTER`,`SINTERSTORE`,`SUNION`,`SUNIONSTORE`,`SSCAN`
- sorted-set: `ZADD`(key + enum ["NX","XX","GT","LT","CH","INCR"] + score,member multiple),`ZCARD`,`ZCOUNT`,`ZINCRBY`,`ZSCORE`,`ZMSCORE`,`ZRANK`,`ZREVRANK`,`ZRANGE`(key,start,stop + enums ["BYSCORE","BYLEX","REV","WITHSCORES","LIMIT"] + int pair, notes about LIMIT needing care),`ZREVRANGE`,`ZRANGEBYSCORE`,`ZRANGEBYLEX`,`ZREVRANGEBYSCORE`,`ZREM`,`ZREMRANGEBYRANK`,`ZREMRANGEBYSCORE`,`ZREMRANGEBYLEX`,`ZPOPMIN`,`ZPOPMAX`,`ZRANDMEMBER`,`ZLEXCOUNT`,`ZSCAN`,`ZUNIONSTORE`,`ZINTERSTORE`,`ZDIFF`
- stream: `XADD`(key + enum ["NOMKSTREAM"] + int trio ["MAXLEN","MINID"] patterns simplified: name "id-or-options" string multiple, then field,value multiple — model args loosely with multiple),`XLEN`,`XRANGE`(key,start string "-" default,stop "+" default, optional COUNT int),`XREVRANGE`,`XREAD`(enum ["COUNT","BLOCK"] + int + k,v multiple "STREAMS",blocking via BLOCK),`XDEL`,`XTRIM`,`XINFO`,`XGROUP`
- connection: `PING`,`ECHO`,`SELECT`(int),`AUTH`,`CLIENT`(admin),"HELLO"(optional protover int + AUTH k/v + SETNAME),`RESET`,`QUIT`,`SWAPDB`(int,int)
- server: `INFO`(optional section string),`COMMAND`(optional enum ["COUNT","INFO","DOCS","GETKEYS"] + args),`CONFIG`(enum ["GET","SET","RESETSTAT","REWRITE"] + param,admin/config),`DBSIZE`,`TIME`,`LASTSAVE`,`BGREWRITEAOF`(admin),`BGSAVE`(admin),`SAVE`(admin),`SHUTDOWN`(admin,destructive),`DEBUG`(admin),`MONITOR`(admin),`SLAVEOF`(admin),`REPLICAOF`(admin),`WAIT`(int,int),`LOLWUT`
- scripting: `EVAL`(script string, numkeys int + k+ + arg+),`EVALSHA`,`SCRIPT`(enum ["LOAD","EXISTS","FLUSH"]),"FCALL","FUNCTION"(enum ["LOAD","LIST","DELETE","STATS"]),`WAIT` already in server — skip dup
- pubsub: `PUBLISH`(channel,string),`SUBSCRIBE`(channel+),`UNSUBSCRIBE`,`PSUBSCRIBE`,`PUNSUBSCRIBE`,`PUBSUB`(enum ["CHANNELS","NUMSUB","NUMPAT","SHARDCHANNELS"])
- transactions: `MULTI`,`EXEC`,`DISCARD`,`WATCH`(k+),`UNWATCH`

Eight fully-worked example entries (match these exactly):

```ts
{ name: "GET", group: "string", arity: 2, summary: "Get the value of a key", since: "1.0.0",
  access: "read", complexity: "O(1)", args: [{ name: "key", type: "key" }], returns: "The value string, or nil when the key does not exist.",
  keyPositions: [0] },
{ name: "SET", group: "string", arity: -3, summary: "Set the string value of a key, optionally with expiry or conditions", since: "1.0.0",
  access: "write", complexity: "O(1)",
  args: [
    { name: "key", type: "key" }, { name: "value", type: "string" },
    { name: "expiration", type: "enum", enum: ["EX", "PX", "EXAT", "PXAT"], optional: true, description: "Expiry flag followed by a number (seconds, milliseconds, or unix timestamps)" },
    { name: "seconds", type: "int", optional: true },
    { name: "condition", type: "enum", enum: ["NX", "XX", "GET", "KEEPTTL"], optional: true, description: "NX: only if absent · XX: only if present · GET: return old value · KEEPTTL: retain TTL" },
  ],
  returns: '"OK" on success, nil when NX/XX prevented the write, or the old value with GET.',
  ttl: "clear", keyPositions: [0],
  notes: "SET clears the TTL unless KEEPTTL is given." },
{ name: "KEYS", group: "key", arity: 2, summary: "Find all keys matching the given pattern", since: "1.0.0",
  access: "read", complexity: "O(N)", danger: "full-scan",
  args: [{ name: "pattern", type: "pattern" }], keyPositions: [],
  notes: "Blocks the server while scanning the whole keyspace. Use SCAN for incremental iteration." },
{ name: "SCAN", group: "key", arity: -2, summary: "Incrementally iterate the keyspace", since: "2.8.0",
  access: "read", complexity: "O(1) per call",
  args: [
    { name: "cursor", type: "int", description: '"0" starts a new iteration; use the returned cursor to continue' },
    { name: "MATCH", type: "enum", enum: ["MATCH"], optional: true }, { name: "pattern", type: "pattern", optional: true },
    { name: "COUNT", type: "enum", enum: ["COUNT"], optional: true }, { name: "count", type: "int", optional: true, description: "Approximate elements examined per call" },
    { name: "TYPE", type: "enum", enum: ["TYPE"], optional: true, description: "Requires Redis 6+; filter by a single type" }, { name: "type", type: "string", optional: true },
  ],
  returns: "[next-cursor, [keys…]] — iteration is complete when the cursor returns to 0.",
  keyPositions: [] },
{ name: "ZRANGE", group: "sorted-set", arity: -4, summary: "Return members in a sorted set within an index, score, or lexicographic range", since: "6.2.0",
  access: "read", complexity: "O(log(N)+M) where M is the number of elements returned",
  args: [
    { name: "key", type: "key" }, { name: "start", type: "int" }, { name: "stop", type: "int" },
    { name: "modifier", type: "enum", enum: ["BYSCORE", "BYLEX", "REV"], optional: true },
    { name: "WITHSCORES", type: "enum", enum: ["WITHSCORES"], optional: true },
    { name: "LIMIT", type: "enum", enum: ["LIMIT"], optional: true, description: "With BYSCORE/BYLEX only" },
    { name: "offset", type: "int", optional: true }, { name: "count", type: "int", optional: true },
  ],
  returns: "Members (with scores when WITHSCORES) in ascending order unless REV.",
  keyPositions: [0],
  notes: "With REV the start/stop indexes are from the highest score." },
{ name: "BLPOP", group: "list", arity: -3, summary: "Remove and return the first element of the first non-empty list, blocking if needed", since: "2.0.0",
  access: "write", complexity: "O(1)", blocking: true,
  args: [
    { name: "key", type: "key", multiple: true }, { name: "timeout", type: "int", description: "Seconds; 0 blocks indefinitely" },
  ],
  returns: "[key, element] or nil after the timeout expires.",
  keyPositions: [], notes: "Holds the client connection; timeout 0 blocks forever." },
{ name: "FLUSHALL", group: "server", arity: -1, summary: "Remove all keys from all databases", since: "1.0.0",
  access: "admin", complexity: "O(N)", danger: "destructive",
  args: [{ name: "mode", type: "enum", enum: ["ASYNC", "SYNC"], optional: true }], returns: '"OK".', keyPositions: [] },
{ name: "HSET", group: "hash", arity: -4, summary: "Set hash field(s) to value(s), creating the hash if needed", since: "4.0.0",
  access: "write", complexity: "O(1) per field",
  args: [
    { name: "key", type: "key" },
    { name: "field", type: "string", multiple: true, description: "field/value pairs repeat" }, { name: "value", type: "string" },
  ],
  returns: "Number of fields that were added (new fields only).", keyPositions: [0] },
```

- [ ] **Step 1: Write the integrity test first** (this defines correctness for the data task):

```ts
// datasources/redis/catalog.test.ts
import { describe, test, expect } from "bun:test";
import { commandCatalog, lookupCommand, isWriteCommand, blockingTimeoutSeconds } from "./catalog.ts";

describe("command catalog integrity", () => {
  const names = commandCatalog.map(d => d.name);
  test("names are unique and uppercase", () => {
    expect(new Set(names).size).toBe(names.length);
    names.forEach(n => expect(n).toMatch(/^[A-Z][A-Z0-9.-]*$/));
  });
  test("every doc has required fields with sane values", () => {
    for (const d of commandCatalog) {
      expect(d.summary.length).toBeGreaterThan(3);
      expect(d.since).toMatch(/^\d+\.\d+\.\d+$/);
      expect(["read", "write", "read-write", "admin"]).toContain(d.access);
      expect(Number.isInteger(d.arity)).toBe(true);
      if (d.args) {
        for (const a of d.args) {
          expect(a.name.length).toBeGreaterThan(0);
          if (a.type === "enum") expect(a.enum?.length).toBeGreaterThan(0);
        }
      }
      if (d.keyPositions) for (const p of d.keyPositions) expect(p).toBeGreaterThanOrEqual(0);
      expect(d.ttl === undefined || ["clear", "set", "none"].includes(d.ttl)).toBe(true);
    }
  });
  test("core commands the UI relies on are present", () => {
    for (const name of ["GET", "SET", "DEL", "SCAN", "TYPE", "TTL", "EXPIRE", "PERSIST", "RENAME", "HGETALL", "LRANGE", "SMEMBERS", "ZRANGE", "XRANGE", "XADD", "INFO", "PING", "FLUSHALL", "BLPOP"]) {
      expect(lookupCommand(name), name).not.toBeNull();
    }
  });
  test("lookupCommand is case-insensitive", () => {
    expect(lookupCommand("zrange")?.name).toBe("ZRANGE");
    expect(lookupCommand("NOPE")).toBeNull();
  });
  test("write classification", () => {
    expect(isWriteCommand(lookupCommand("GET"))).toBe(false);
    expect(isWriteCommand(lookupCommand("SET"))).toBe(true);
    expect(isWriteCommand(lookupCommand("FLUSHALL"))).toBe(true);
    expect(isWriteCommand(null)).toBe(false);
  });
  test("blocking timeout resolution", () => {
    const blpop = lookupCommand("BLPOP")!;
    expect(blockingTimeoutSeconds(blpop, ["k", "5"])).toBe(5);
    expect(blockingTimeoutSeconds(blpop, ["a", "b", "0"])).toBe(0);
    expect(blockingTimeoutSeconds(lookupCommand("GET")!, ["k"])).toBeNull();
    const xread = lookupCommand("XREAD")!;
    expect(blockingTimeoutSeconds(xread, ["COUNT", "2", "STREAMS", "s", "$"])).toBeNull();
    expect(blockingTimeoutSeconds(xread, ["BLOCK", "0", "STREAMS", "s", "$"])).toBe(0);
    expect(blockingTimeoutSeconds(xread, ["BLOCK", "1500", "STREAMS", "s", "$"])).toBe(1.5);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `bun test datasources/redis/catalog.test.ts`

- [ ] **Step 3: Author `catalog.ts`** — types, the eight examples above verbatim, then entries for the full list. Per-command source of truth: redis.io command pages semantics (summaries paraphrased, complexity, since, access, blocking, ttl effect). `lookupCommand` builds a `Map` on first use. `blockingTimeoutSeconds`: table `{ BLPOP: "last", BRPOP: "last", BZPOPMIN: "last", BZPOPMAX: "last", BLMOVE: "last", BRPOPLPUSH: "last", BLMPOP: "first" }`; for XREAD/XREADGROUP scan for a "BLOCK" token and take the next numeric token (milliseconds → seconds); null when undetermined or not blocking. Write/admin classification follows the list above (`SMEMBERS`/`ZRANGE`/`HGETALL` stay read).

- [ ] **Step 4: Run tests** — `bun test datasources/redis/catalog.test.ts && bun run typecheck`

- [ ] **Step 5: Commit** — `git commit -am "feat(redis): built-in command catalog"`

---

### Task 6: Autocomplete

**Files:**
- Create: `datasources/redis/autocomplete.ts`
- Test: `datasources/redis/autocomplete.test.ts`

**Interfaces:**
- Consumes: `commandCatalog`, `CommandDoc`.
- Produces:
```ts
export interface Completion { label: string; kind: "command" | "enum" | "key" | "literal"; detail?: string; insert: string }
export function completeCommand(input: string, opts: { keys?: string[]; max?: number }): Completion[]
export function argumentHint(input: string): { doc: CommandDoc | null; position: number; hint: string }
// argumentHint returns doc=null (hint="") for empty/unknown first token.
```

- [ ] **Step 1: Failing tests** — cases: prefix completion at token 0 (`"ZR"` → ZRANGE/ZRANK/ZADD? rank by prefix: ZRANGE, ZRANK, ZREMRANG…, detail = summary, insert = label + " "); case-insensitive (`"zra"`); keys at key position (`"GET " + keys ["user:1","user:2"]` prefix `"user:"`); enum tokens (`"ZRANGE leaderboard 0 9 "` → REV/WITHSCORES/BYSCORE/BYLEX/LIMIT options via modifier+WITHSCORES+LIMIT specs; `"SET k v EX 10 "` → NX/XX/GET/KEEPTTL); no completions past exact arity for non-multiple final specs; argumentHint positions (`"ZRANGE key 0 9 RE"` → position 3 hint naming REV/WITHSCORES; `""` → null doc).

- [ ] **Step 2–3: Implement** — tokenize the partial input with `tokenizeCommand` plus a trailing-partial token (`input` ends mid-token: last array element is the prefix; compute by checking `/\s$/.test(input)`): when input ends with whitespace, prefix = "" and we are "between tokens". Token 0 empty/whitespace-only input → command list (all, sorted by name, capped `max ?? 12`, each `{ label: d.name, kind: "command", detail: `${d.summary} · ${d.access} · arity ${d.arity}`, insert: d.name + " " }`). After token 0: doc = lookup(token0); walk `doc.args` mapping consumed token counts (each non-optional spec consumes 1; `multiple` specs repeat — for hint purposes map the current index to the nearest spec cycling the last multiple group); collect completions from that spec: enum values by prefix (kind "enum"), `type === "key"` → opts.keys filtered by prefix (kind "key", insert = the key), string/int/pattern → no value completions but argumentHint still names it. `argumentHint`: doc + current arg index → hint = `arg ${index + 1}: ${spec.name}${spec.optional ? " (optional)" : ""} — ${spec.description ?? spec.enum?.join(" | ") ?? spec.type ?? ""}`.

- [ ] **Step 4: Run** — `bun test datasources/redis/autocomplete.test.ts && bun run typecheck`

- [ ] **Step 5: Commit** — `feat(redis): deterministic command autocomplete`

---

### Task 7: Explain

**Files:**
- Create: `datasources/redis/explain.ts`
- Test: `datasources/redis/explain.test.ts`

**Interfaces:**
- Consumes: catalog, `tokenizeCommand`, `Capabilities` (only `cluster` used).
- Produces:
```ts
export interface CommandExplanation {
  name: string;
  known: boolean;
  summary: string;
  access: "read" | "write" | "read-write" | "admin" | "unknown";
  complexity?: string;
  blocking: boolean;
  ttlEffect: string;          // "none" | "clears the key TTL" | "sets a TTL" | doc.notes-based
  expected?: string;          // doc.returns
  args: { token: string; meaning: string }[];   // positional mapping, "?" when unmapped
  dangers: string[];          // human text from danger flags
  cluster: string[];          // slot guidance
  risks: string[];            // large-key/full-scan/indefinite-block notes incl. arity mismatch
}
export function explainCommand(input: string, capabilities: Pick<Capabilities, "cluster">): CommandExplanation
```

- [ ] **Step 1: Failing tests** — include the issue's example: `explainCommand("ZRANGE leaderboard 0 9 REV WITHSCORES", { cluster: false })` → name ZRANGE, access "read", complexity contains "O(log(N)+M)", args[0].meaning "key", blocking false, ttlEffect "none"; `KEYS *` → dangers mention full keyspace scan, risks suggest SCAN; `BLPOP a 0` → blocking true + indefinite-block risk; `DEL {a}k1 {a}k2` with cluster:true → cluster array empty (hash tags match); `DEL a b` with cluster:true → cluster warning mentioning hash tags; unknown command `FAKE x` → known false; arity mismatch `GET` (no args) → risk mentions expected arguments.

- [ ] **Step 2–3: Implement** — tokenize; doc = lookup(token0). Unknown → `{ name: token0.toUpperCase(), known: false, summary: "Not in the built-in catalog.", access: "unknown", blocking: false, ttlEffect: "none", args: [], dangers: [], cluster: [], risks: [] }`. Known: map args positionally walking specs (non-optional first; when tokens remain past specs and arity < 0, map extras as "additional arguments"); dangers: destructive → "Destructive: removes data.", full-scan → "Scans the entire keyspace and blocks the server.", admin → "Administrative command — affects server behavior.", config → "Changes server configuration."; cluster: when `capabilities.cluster` and keyPositions tokens ≥ 2 and their `{tag}` extracts (regex `/\{([^}]+)\}/` on each key, fallback whole key) are not all equal → `"Multi-key command across different hash slots — may fail with CROSSSLOT or require hash tags {…}."`; single key → `"Single key — slot-safe."`; risks: blocking && resolved timeout === 0 → "Blocks indefinitely with timeout 0."; danger full-scan → "Full keyspace scan — prefer SCAN with a cursor."; provided token count below arity minimum → `Expected at least N arguments including the command, got M.`.

- [ ] **Step 4: Run + commit** — `bun test datasources/redis/explain.test.ts && bun run typecheck`, then `git commit -am "feat(redis): command explain analysis"`.

---

### Task 8: Lint (safety warnings)

**Files:**
- Create: `datasources/redis/lint.ts`
- Test: `datasources/redis/lint.test.ts`

**Interfaces:**
- Produces:
```ts
export interface LintWarning { rule: string; severity: "info" | "warning" | "error"; message: string; suggestion?: string }
export function lintCommand(input: string, opts: { writable: boolean; cluster: boolean }): LintWarning[]
```
Rules (all deterministic, never mutate the command):
- `keys-full-scan`: first token `KEYS` → warning "KEYS scans the whole keyspace and blocks the server." suggestion "Use SCAN with a cursor instead."
- `flush-destructive`: `FLUSHALL`/`FLUSHDB` → error "Destructive: removes all keys…".
- `unbounded-read`: `SMEMBERS`, `HGETALL`, `HKEYS`, `HVALS`, `LRANGE key 0 -1`, `ZRANGE key 0 -1` (with or without WITHSCORES) → warning "Reads the entire collection; large keys can stall the server." suggestion "Page with SCAN-family commands or bounded indexes."
- `blocking-indefinite`: blocking doc with resolved timeout 0 → error "Blocks indefinitely (timeout 0); the console refuses this." suggestion "Pass a positive timeout in seconds."
- `admin-command`: access "admin" → warning "Administrative command — verify before running."
- `write-readonly`: `isWriteCommand(doc) && !opts.writable` → error "Write command on a read-only session." suggestion "Enable writes for this session to run it."
- `unclassified-readonly`: unknown first token && !writable → error "Command not in the catalog; read-only sessions only run known read commands."
- `cross-slot`: cluster && doc has ≥2 keyPositions && hash tags mismatch → warning "Keys hash to different cluster slots."
- `arity`: token count (incl. command) below `-arity` minimum (for arity > 0: must equal exactly; mismatch → info) → info "Arity mismatch: command expects …".

- [ ] **Step 1: Failing tests** covering each rule plus: `GET k` with writable → no warnings; empty input → `[]`; `lintCommand("KEYS *", { writable: true, cluster: false })` returns exactly the keys-full-scan warning; `lintCommand("SET k v", { writable: false, cluster: false })` has write-readonly error; no rewrite semantics (function returns warnings only — trivially true).

- [ ] **Step 2–3: Implement** using catalog + `blockingTimeoutSeconds` + hash-tag extraction (same regex as explain — export `hashTag(key: string): string` from `lint.ts` and reuse from there, or duplicate the one-line regex in `explain.ts`; prefer exporting from `explain.ts` as `hashTagOf(key)` and import in lint).

- [ ] **Step 4: Run + commit** — `bun test datasources/redis/lint.test.ts && bun run typecheck && git commit -am "feat(redis): command safety linting"`.

---

### Task 9: Redis driver — session, detection, test/connect

**Files:**
- Create: `datasources/redis/driver.ts`
- Test: `datasources/redis/driver.test.ts`

**Interfaces:**
- Consumes: contracts, capabilities, connection, resp, catalog.
- Produces:
```ts
export interface SessionTransport {
  send(command: string, args: string[]): Promise<unknown>;
  connect(): Promise<void>;
  close(): Promise<void>;
}
export type TransportFactory = (url: string) => SessionTransport;
export function makeRedisDriver(transportFactory?: TransportFactory): DataSourceDriver
```
Behavior:
- `validateUrl` → `validateRedisUrl`.
- `test({url, database})` → open transport on `sessionUrl(url, database)`, `connect()` with 10 s race → timeout error "Connection timed out"; `send("INFO")` → `detectDataSourceInfo`; close transport; return info.
- `connect(config)` → same, but keep transport open and return `{ info, console, explorer, close }` (console/explorer built in Tasks 10/11 — for this task, attach stubs typed as the contract and filled next tasks; simplest: build session object in one place `openSession(config, factory)` with `console: makeConsoleProvider(transport, info)` and `explorer: makeExplorerProvider(transport, info)` functions declared in this file from the start, bodies in Tasks 10/11).
- Transport errors thrown as `DbError` from `shared.ts` with codes: connect timeout → `"timeout"`, send failure → `"sql"` (message sanitized: strip anything that looks like `redis://…` credentials).
- `flavor` capability note: `test()`/`connect()` never assume RESP version; Bun negotiates.

Fake transport for tests:

```ts
const fakeFactory = () => {
  const calls: { command: string; args: string[] }[] = [];
  const transport: SessionTransport = {
    connected: false,
    async connect() { (transport as any).connected = true; },
    async close() { (transport as any).connected = false; },
    async send(command, args) { calls.push({ command, args }); return responder(command, args); },
  };
  return { transport, calls };
};
```
with `responder` returning fixture INFO strings for `INFO`, `{"OK"}`-style values for others, and throwing `new Error("ERR unknown command")` for unknown commands.

- [ ] **Step 1: Failing tests** — `test()` returns flavor/version/capabilities for fixture INFO; `connect()` returns info + providers + close; timeout: factory whose `connect()` never resolves → rejects with "timed out" within 100 ms (inject a small `timeoutMs` override via internal option `makeRedisDriver(factory, { connectTimeoutMs: 100 })`); unknown command during `exec` surfaces as `{ t: "err" }` reply (covered fully in Task 10; here assert `send` failure mapping by calling `driver.connect` then `session.console.exec("NOSUCH", { writable: true })` → err reply containing "unknown command").

- [ ] **Step 2–3: Implement** `makeRedisDriver` + `openSession` + providers skeleton (`makeConsoleProvider`/`makeExplorerProvider` bodies may be minimal this task: exec as specified below in "core exec" so the unknown-command test passes; explorer methods `throw new DbError("not_found", "not implemented")` until Task 11).

Core exec path (shared logic that Task 10 extends):
```ts
async function exec(command: string, ctx: ExecContext): Promise<CommandResult> {
  const tokens = tokenizeCommand(command);
  if (!tokens.length) return { reply: { t: "err", s: "ERR empty command" }, ms: 0 };
  const name = tokens[0]!.toUpperCase();
  const args = tokens.slice(1);
  const doc = lookupCommand(name);
  if ((!doc || doc.access !== "read") && !ctx.writable) {
    throw new DbError("not_read_only", doc ? `${name} is a ${doc.access} command; enable writes for this session` : `${name} is not in the command catalog; enable writes to allow unclassified commands`);
  }
  const started = performance.now();
  let reply: unknown;
  try { reply = await transport.send(name, args); }
  catch (error) { throw toDbError(error); }
  const ms = performance.now() - started;
  return { reply: encodeRESP(reply instanceof Error ? reply : reply), ms };
}
```
(`toDbError`: message matching `/^(ERR|WRONGTYPE|NOPERM|NOAUTH|BUSYGROUP|NOGROUP|MOVED|ASK|CROSSSLOT|EXECABORT|LOADING|BUSY|READONLY|MAXRETRIES)/i` → `DbError("sql", message)`; `/timeout/i` → `DbError("timeout", …)`; else `DbError("sql", sanitized)`.) Note: command-level errors that arrive as thrown `Error`s with `ERR …` messages still become `err` replies — so in `exec`'s catch, if the message matches the command-error prefixes, return `{ reply: { t: "err", s: message }, ms }` instead of throwing. Connection-level failures (ECONNREFUSED etc.) throw.

- [ ] **Step 4: Run** — `bun test datasources/redis/driver.test.ts && bun run typecheck`

- [ ] **Step 5: Commit** — `feat(redis): driver sessions over injected transport`

---

### Task 10: Console provider — classification, blocking guard, catalog enrichment

**Files:**
- Modify: `datasources/redis/driver.ts` (console provider)
- Modify: `datasources/redis/driver.test.ts`

**Interfaces:**
- Produces: full `ConsoleProvider` semantics; module-private `resolveBlockingSeconds(name, args): number | null` via `blockingTimeoutSeconds`; `mergedCatalog(info, transport): Promise<CommandDoc[]>`.

- [ ] **Step 1: Failing tests** (fake transport):
  1. read command with `writable: false` executes (`GET k` → `{ t: "str" }`).
  2. write command with `writable: false` throws `DbError` code `not_read_only`.
  3. write command with `writable: true` executes and measures `ms >= 0`, reply encoded (`SET k v` → `{ t: "str", s: "OK" }`).
  4. `BLPOP k 0` → err reply "refusing indefinite blocking command…" (message contains "timeout"); `BLPOP k 5` executes.
  5. catalog(): fake transport answers `COMMAND DOCS` with `{ zrange: { summary: "Runtime summary", since: "6.2.0", complexity: "O(log(N)+M)" } }` → returned docs contain ZRANGE with summary "Runtime summary"; when the transport throws on `COMMAND DOCS`, catalog() resolves to the static catalog.

- [ ] **Step 2–3: Implement** — extend exec with the blocking guard before send: `const seconds = doc ? blockingTimeoutSeconds(doc, args) : null; if (seconds === 0) return { reply: { t: "err", s: `ERR ${name} with timeout 0 blocks indefinitely; pass a positive timeout in seconds` }, ms: 0 };` Catalog merge: `send("COMMAND", ["DOCS"])` (Redis 7+; tolerate any error/shape), walk object entries: key (lowercase name) → uppercase, if `lookupCommand` knows it, shallow-merge known fields (`summary`, `complexity`, `since`, `notes`), keep static `access`/`danger` (runtime docs don't carry our safety model). Cache merged result per session.

- [ ] **Step 4: Run + commit** — `bun test datasources/redis/driver.test.ts && git commit -am "feat(redis): console exec with write classification and safety guards"`.

---

### Task 11: Explorer provider — scan, inspect, key ops

**Files:**
- Modify: `datasources/redis/driver.ts` (explorer provider)
- Modify: `datasources/redis/driver.test.ts`

**Interfaces:**
- Produces: full `KeyValueExplorerProvider` semantics against the transport.

Behavior spec (implement exactly; all through `transport.send`):
- `scan({cursor, match, count, type})`: args `[cursor, …(match ? ["MATCH", match] : []), …(count ? ["COUNT", String(count)] : []), …(type && info.version >= 6 ? ["TYPE", type] : [])]`; reply `[nextCursor, keys]`; then `TYPE` per key via `Promise.all` (errors → "unknown"); return `{ cursor: String(nextCursor), keys }`. When `type` requested and version < 6 → throw `DbError("sql", "Type filtering requires Redis 6 or newer")`.
- `inspect(key, cursor?)`:
  - `type = send("TYPE", [key])` → "none" → `{ …, ttlSeconds: -2, memoryBytes: null, size: null, value: { kind: "none" } }`; unrecognized server type → `{ kind: "unknown", note: "Server type '<t>' has no viewer" }`.
  - `ttl = send("TTL", [key])`, `memoryBytes` = `send("MEMORY", ["USAGE", key])` number or null on error (try/catch).
  - size per type: string `STRLEN`, list `LLEN`, set `SCARD`, zset `ZCARD`, hash `HLEN`, stream `XLEN`.
  - value pages (no cursor = first page):
    - string: if size > 1_000_000 → `{ kind: "string", value: "", truncated: true, lengthBytes: size }`; else `GET`, truncate to 64 000 chars with `truncated: true` when cut.
    - hash: `HSCAN key <cursor ?? 0> COUNT 50` → pair flat array into entries; `cursor` for next; `truncated: cursor !== "0"`.
    - set: `SSCAN` same shape.
    - zset: `ZSCAN` → pair into `{ member, score: Number(score) }`.
    - list: `start = Number(cursor ?? 0)`; `LRANGE key start start+49`; `truncated: start + items.length < size`.
    - stream: `XRANGE key <cursor ? `(${cursor}` : "-") + COUNT 50` — when version < 6.2 (no exclusive range syntax): fetch from cursor inclusive with COUNT 51 and drop the first when cursoring; entries `{ id, fields }` from flat pairs; `lastId` = last entry id; `truncated`: entries page reached COUNT and `lastId !== null` (client re-inspects with cursor=lastId; on empty page with cursor set, previous lastId stands).
- `keyOp(op)` mapping: rename→`RENAME from to`; delete→`DEL …keys`; expire→`EXPIRE key seconds`; persist→`PERSIST key`; setString→ version ≥ 6 ? `SET key value KEEPTTL` : `SET key value` (preserve TTL when the server supports it); hashSet→`HSET`; hashDelete→`HDEL`; setAdd→`SADD`; setRemove→`SREM`; zsetAdd→`ZADD key score member`; zsetRemove→`ZREM`; listSet→`LSET key index value`. Return `{ ok: true, n }` (n = numeric reply when number). Command errors (ERR/WRONGTYPE prefixed thrown Errors) → `{ ok: false, error: message }`; transport failures still throw `DbError`.

- [ ] **Step 1: Failing tests** with a scripted fake transport (assert exact command argv for each path): scan passes MATCH/COUNT and TYPE only on version ≥ 6 (use two fixture infos by swapping the INFO responder); scan attaches per-key types; inspect string small vs oversized (>1MB → truncated, no GET issued); hash first page + continued page via cursor; zset scores numeric; stream paging uses `(` prefix on 7.x and the skip-first fallback on 5.x fixtures; keyOp setString issues KEEPTTL on 7.x, plain SET on 5.x; keyOp delete returns n; keyOp rename on missing key (transport throws `ERR no such key`) → `{ ok: false, error: /no such key/ }`.

- [ ] **Step 2–3: Implement.**

- [ ] **Step 4: Run** — `bun test datasources/redis/driver.test.ts && bun run typecheck`

- [ ] **Step 5: Commit** — `feat(redis): SCAN explorer, type-aware inspection and key ops`.

---

### Task 12: Generic datasource router

**Files:**
- Create: `datasources/router.ts`
- Test: `datasources/router.test.ts`
- Modify: `server/routeHandlers.ts` — export `dbErrorResponse`.

**Interfaces:**
- Consumes: contracts, registry; `Connections`-shaped profile store subset `{ get(id): Promise<{ id: string; driver: string } | null>; resolveUrl(id): Promise<string | null> }` (structural — no import from server/).
- Produces:
```ts
export interface DatasourceRequest {
  path: string;                        // after "/datasource", e.g. "/exec"
  body: Record<string, unknown>;       // POST body or URL params object
  url: URL;
  writable(connKey: string): boolean;  // connKey = `${connId}/${database ?? ""}`
}
export interface DatasourceRouter {
  route(req: DatasourceRequest): Promise<Response>;
  invalidate(connId: string): Promise<void>;   // close + drop sessions for a deleted profile
}
export function makeDatasourceRouter(profiles: Profiles, registry: DriverRegistry): DatasourceRouter
```
Routing table (all JSON; unknown path → `fail("Not found", 404)`):
- `/test` POST `{driver, url, database?}` → `registry.get(driver)` (404 "Unknown driver") → `driver.test({url, database})` → `{ info }` shape: return the DataSourceInfo directly: `Response.json(info)`.
- `/session` POST `{connId, database?}` → cached or new session → `Response.json({ info })`.
- `/exec` POST `{connId, database?, command}` → `session.console` present else 404 "This source has no console" → validate command is a string ≤ 10 000 chars → `exec(command, { writable: req.writable(connKey) })` → `Response.json(result)`.
- `/catalog` GET `?connId&database?` → `{ commands: await session.console.catalog() }`.
- `/scan` POST `{connId, database?, cursor, match?, count?, type?}` → explorer.scan (cursor must be a string of digits, count ≤ 1000).
- `/key` POST `{connId, database?, key, cursor?}` → explorer.inspect(key, cursor) (key: string 1..512 chars).
- `/key/op` POST `{connId, database?, op}` → explorer.keyOp(op).
Session cache: `Map<string, DriverSession>` keyed connKey; on provider/transport throw with `DbError` code `"sql"|"timeout"`, drop the cached session so the next call reconnects. `DbError`s map through the exported `dbErrorResponse`; unexpected errors → `dbErrorResponse(error)` too (it already handles plain Errors).
`invalidate(connId)`: close all sessions whose key starts with `${connId}/`.

- [ ] **Step 1: Failing tests** with a fake driver registered in a fresh registry + in-memory profiles map: `/test` happy path; `/session` caches (factory called once for two calls); `/exec` without console provider → 404; `/exec` enforces `writable()` callback (false → driver throws not_read_only → response status 400 body code `not_read_only`); `/scan` passes through; `/key/op` passes through; `invalidate` closes the session (spy); unknown driver id → 404.

- [ ] **Step 2–3: Implement.**

- [ ] **Step 4: Run** — `bun test datasources/router.test.ts && bun run typecheck`

- [ ] **Step 5: Commit** — `feat(datasources): capability-driven /api/datasource router`.

---

### Task 13: Generalize connection profiles (migration v4)

**Files:**
- Modify: `server/migrations.ts` (add v4)
- Modify: `server/connections.ts`
- Modify: `shared.ts` (`PgConnection` → `ConnectionProfile` with `driver: string`)
- Modify: `server/routeHandlers.ts`, and every `PgConnection` reference (`grep -rn "PgConnection" server src shared.ts`)
- Test: update `server/connections.test.ts`, `server/routeHandlers.test.ts`, `server/app.test.ts`

**Interfaces:**
- `ConnectionProfile { id; label; driver: string; url; createdAt; lastUsedAt; environment; readOnly }`.
- `Connections.save(driver: string, label: string, url: string, options?: …)`; `makeConnections(db, secrets?, validators?)` where `validators: Record<string, (url: string) => void>` defaults to `{ postgres: validateConnectionUrl, redis: validateRedisUrl }`; save with an unknown driver throws `"Unknown driver"`.
- `connectionSave` reads `driver` from the request body (default `"postgres"`); response/list shapes gain `driver`.

- [ ] **Step 1: Failing tests first** — update `server/connections.test.ts`: table is `datasource_connections`; `save("postgres", …)` signature; new test "saves a redis profile with a redis url and rejects a postgres url for driver redis" (`save("redis", "r", "postgres://h/db")` throws); new test "migration v4 renames pg_connections and backfills driver='postgres'" (build a db, run migrations v1–v3 manually + insert row + run v4, assert table + column). Update `routeHandlers.test.ts` connectionSave expectations (`driver` round-trip, defaults to postgres).

- [ ] **Step 2: Implement** — migration v4 exactly:
```ts
{
  v: 4,
  up: (db) => {
    // Profiles are driver-generic since Redis/Valkey support; legacy table keeps its name in old files only.
    db.exec("ALTER TABLE pg_connections RENAME TO datasource_connections");
    db.exec("ALTER TABLE datasource_connections ADD COLUMN driver TEXT NOT NULL DEFAULT 'postgres'");
  },
},
```
`connections.ts`: rename table in all queries, add `driver` to row type + `toConnectionProfile`, `save(driver, …)` validates via `validators[driver]` (throw `Unknown driver "${driver}"` when absent), `INSERT` includes driver. Sweep `PgConnection` → `ConnectionProfile` across `shared.ts`, `server/*`, `src/*` (typecheck finds them all).

- [ ] **Step 3: Run full suite** — `bun test server && bun run typecheck` (expected: all pass; some tests may need driver args added to save calls).

- [ ] **Step 4: Commit** — `feat(server): driver-generic connection profiles (migration v4)`.

---

### Task 14: Wire the router into the app

**Files:**
- Modify: `server/app.ts` — create registry + router, dispatch `/api/datasource/*`, extend the app-state key regex to allow `redis:` prefixes.
- Test: `server/app.test.ts` additions.

**Interfaces:**
- In `makeApp`: `const registry = createDriverRegistry(); registry.register(makeRedisDriver()); const datasource = makeDatasourceRouter(connections, registry);`
- Dispatch placed after the existing `body` resolution and connId/profile validation, before the relational GET block: if `path.startsWith("/datasource")`:
```ts
if (path.startsWith("/datasource")) {
  const sub = path.slice("/datasource".length) || "/";
  if (sub !== "/test") {
    if (!body.connId) return fail("A connection is required");
    if (!await connections.get(body.connId)) return fail("Unknown connection", 404);
    connections.touch(body.connId);
  }
  return datasource.route({
    path: sub, body, url,
    writable: (connKey) => writable.has(`${session}:${connKey}`),
  });
}
```
- State-key regex: `/^(documents|sql:|redis:|layout|preferences)/`.

- [ ] **Step 1: Failing tests** in `server/app.test.ts` (pattern-follow existing tests there; register a fake driver via the module's registry — since `makeApp` builds its own registry, export a test seam: `makeApp(db, { secrets, appPath, drivers?: DataSourceDriver[] })` extra option, default `[makeRedisDriver()]`): POST `/api/datasource/session` with unknown connId → 404; with a saved redis profile (fake driver registered under id "redis" in the test) → 200 `{ info }`; `/api/state` accepts `redis:<docId>` keys; `/api/datasource/exec` with `writable` false and a write command → 400 code `not_read_only` (fake driver's exec consults ctx.writable like the real one — reuse `makeRedisDriver` with a fake factory returning fixture transports, mirroring Task 9's fake).

- [ ] **Step 2–3: Implement + run** — `bun test server/app.test.ts && bun test server && bun run typecheck`.

- [ ] **Step 4: Commit** — `feat(app): datasource router dispatch and redis console state keys`.

---

### Task 15: Client data layer — dbApi, documents, App shell

**Files:**
- Modify: `src/dbApi.ts`, `src/documents.ts`, `src/App.tsx`
- No new component files yet (Tasks 16–18); this task makes the shell compile and existing smokes pass with redis types wired but sidebar/`DocumentView` rendering only for existing kinds plus stub null renders for `'key' | 'console'` (replaced next tasks).

**Interfaces:**
- `DbSource` union gains `{ kind: "redis"; connId: string; database: string; label: string; url: string; environment: ConnectionProfile["environment"]; readOnly: boolean }` (database always present, default `"0"`). `selector()` maps redis → `{ connId, database }` (so `/access` works unchanged).
- `dbApi.datasource = { test(driver, url), session(src), exec(src, command), scan(src, q), inspect(src, key, cursor?), keyOp(src, op), catalog(src) }` posting to `/api/datasource/*` with `selector(src)` spread.
- `documents.ts`: `Document.kind` gains `'key' | 'console'`; `isDocuments` accepts redis sources (`connId`/`database` strings) and the new kinds; `sourceId` redis → `${connId}/${database}`; `sourceLabel` redis → `label`.
- `App.tsx`: `picker` state `'sqlite' | 'postgres' | 'redis'`; `infos` state `Record<string, DataSourceInfo>`; `connect()` redis branch (`dbApi.datasource.session`); sidebar swap placeholder; `open()` gate `schemas[id] || infos[id]`; console opens via `open('console')` (title "Console"); `open('key', key)` titles with the key name; status bar redis branch (`flavor` capitalized + version, `new URL(url).host`, `database`); `forget()` and document pruning treat redis like postgres (connId-keyed); `close()` also removes `redis:${doc.id}` state for console docs; ⌘N opens console when the active source is redis.

- [ ] **Step 1: Implement** (types + api are mechanical; App edits per above keeping existing formatting).
- [ ] **Step 2: Verify** — `bun run typecheck && bun test src && bun run build` (build catches client-side imports of server-only modules).
- [ ] **Step 3: Commit** — `feat(ui): redis sources in the app shell`.

---

### Task 16: Connection modal — Redis/Valkey tab

**Files:**
- Modify: `src/DatabaseOpenModal.tsx`
- Modify: `scripts/connection-modal-smoke.ts` (add a redis-tab render assertion, following the file's existing happy-dom pattern)

**Interfaces:**
- Third tab button "Redis / Valkey"; fields: Name, Host (`localhost`), Port (`6379`), Username (optional), Password, TLS checkbox, DB index number input (0–15, default 0), Environment select, Read-only checkbox (default checked). URL built with `buildRedisUrl` (import from `../datasources/redis/connection.ts` — pure module, client-safe).
- Test Connection → `dbApi.datasource.test("redis", url)` → message `Connected: ${info.flavor} ${info.version} · ${info.summary.tcpPort ?? ""} · ${info.ms? no}` — match existing postgres test message shape minus fields we don't have: `Connected: ${flavor} ${version} · ${msLabel}` where the endpoint returns info only; show `Connected: Redis 7.2.4`.
- Save & Connect → `dbApi.connections.save("redis", name || host, url, environment, readOnly)` → `onOpen({ kind: "redis", connId: c.id, database: String(dbIndex), label: c.label, url: c.url, environment: c.environment, readOnly: c.readOnly })`.

- [ ] **Step 1: Implement** (extend the existing `kind` union; reuse field markup/styles).
- [ ] **Step 2: Extend the smoke script** — load the modal with `initial: 'redis'` if the script constructs it directly, or click the tab; assert the form renders and Test Connection is wired (script style: follow existing assertions).
- [ ] **Step 3: Verify** — `bun scripts/connection-modal-smoke.ts && bun run typecheck && bun run build`.
- [ ] **Step 4: Commit** — `feat(ui): Redis/Valkey connection profiles in the connection manager`.

---

### Task 17: Redis key explorer (sidebar)

**Files:**
- Create: `src/RedisKeyExplorer.tsx`
- Modify: `src/App.tsx` (swap the placeholder for this component)
- Smoke: extend `scripts/object-explorer-smoke.ts` or add `scripts/redis-explorer-smoke.ts` following the same pattern

**Interfaces:**
- Props: `{ source: Extract<DbSource, { kind: "redis" }>; info: DataSourceInfo | null; activeKey: string | null; onOpenKey(key: string): void; refreshSignal?: number }`.
- Behavior: pattern input (default `*`), type filter select (`any` + string/list/set/zset/hash/stream), Load more (cursor), rows `{key, type, ttl}` (ttl fetched lazily? No — scan returns only types; TTL shown "—" in the list; TTL lives in the key view. Keep list columns: key + type badge). Row click → `onOpenKey(key)`. Per-row actions: Rename (inline prompt row), Delete (confirm + `keyOp delete`), Expire (inline seconds input + `keyOp expire`), Persist (`keyOp persist`). After a mutating op, re-run the current scan page. Empty state text mirrors the relational tree's tone.

- [ ] **Step 1: Implement** component with Tailwind classes reused from `ObjectTree` markup.
- [ ] **Step 2: Wire into App** — sidebar renders `RedisKeyExplorer` when `source?.kind === 'redis'`.
- [ ] **Step 3: Verify** — smoke script + `bun run typecheck && bun run build && bun test src`.
- [ ] **Step 4: Commit** — `feat(ui): SCAN-based Redis key explorer`.

---

### Task 18: Redis key viewer/editor

**Files:**
- Create: `src/RedisKeyView.tsx`
- Modify: `src/App.tsx` (`DocumentView` renders it for `doc.kind === 'key'` when `doc.source.kind === 'redis'`; schema-less documents must render without the `!schema` guard — adjust that guard to relational kinds only)

**Interfaces:**
- Props: `{ source; keyName: string; writable: boolean }`.
- Behavior: `inspect` on mount/key change (loading + error states); header shows key, type badge, TTL (humanized; `-1` → "no expiry"), size, memory; actions: Rename, Expire, Persist, Delete (with confirm); value rendering per `KeyValueView.kind` — string (pre-wrap text + byte length), hash (field/value table + add/edit field + delete field), list (index/value table + edit at index), set (members + add/remove), zset (member/score table + score edit + remove), stream (entries: id + field/value pairs, read-only); edits call `keyOp` and re-inspect; read-only session disables edit affordances (server still enforces).
- Paging: "Load more" when `truncated` (hash/set/zset/stream via cursor; list via start offset).

- [ ] **Step 1: Implement.** **Step 2: Verify** — `bun run typecheck && bun run build`. **Step 3: Commit** — `feat(ui): type-aware Redis key viewer and editor`.

---

### Task 19: Redis console

**Files:**
- Create: `src/RedisConsole.tsx`
- Modify: `src/App.tsx` (`DocumentView` renders it for `doc.kind === 'console'`)

**Interfaces:**
- Props: `{ docId: string; source: Extract<DbSource, { kind: "redis" }>; writable: boolean; onDirty(dirty: boolean): void; onLatency(ms: number): void }`.
- Behavior:
  - Saved state under app-state key `redis:${docId}`: `{ input: string; history: HistoryEntry[]; favorites: string[] }` (`HistoryEntry { command: string; at: number }`), bounded with `boundConsoleHistory` (reuse from `src/consoleHistory.ts`), debounced save like `SqlEditor`.
  - Editor: `@uiw/react-codemirror` plain text (no language), oneDark, `basicSetup: { lineNumbers: true, foldGutter: false, autocompletion: false }`; ⌘/Ctrl+Enter runs the whole input (commands may be single-line; multi-line input runs line-by-line sequentially, stopping at first error — mirroring `executionUnits` semantics but line-based via `tokenizeCommand`-safe split).
  - Execution: `dbApi.datasource.exec`; append output entry `{ command, reply, ms, at, error? }` (error from thrown DbError); `onLatency(ms)`.
  - Output pane: renders `RespValue` trees — strings quoted, ints bare, arrays as nested `1) 2)` numbered lists (redis-cli style via a small pure renderer `renderRESP(v: RespValue, indent: string): string[]` colocated in this file), errors in red, duration `X.X ms` per entry.
  - Autocomplete: pure UI — as the user types, compute `completeCommand(currentLineInput, { keys: knownKeys })` and render a dropdown of ≤ 12 suggestions below the input (keyboard: ↑/↓ select, Tab/Enter insert; Esc closes); `knownKeys` = keys seen from explorer? Console has none — send `/scan` with `MATCH prefix* COUNT 20` when completing a key-typed arg (debounced 150 ms, tolerate failure → empty list). Show `argumentHint(input)` in a hint bar above the editor.
  - Explain panel (right side, toggle): `explainCommand(input, info.capabilities)` rendered as labeled sections.
  - Lint bar: `lintCommand(input, { writable, cluster: info.capabilities.cluster })` warnings listed above the Run button; Run stays enabled (warnings never block; the server refuses what it refuses).
  - History/favorites: history panel like `SqlEditor` (click to recall); star button per output entry adds the command to favorites.

- [ ] **Step 1: Implement.** **Step 2: Verify** — `bun run typecheck && bun run build && bun test src`. **Step 3: Commit** — `feat(ui): Redis command console with autocomplete, explain and lint`.

---

### Task 20: Documentation

**Files:**
- Modify: `docs/architecture.md` — new "Datasource drivers" section: the contract (`datasources/contracts.ts`), capability providers over one-giant-interface, Bun client confined to the driver, how to add a backend (register in `server/app.ts`'s registry, implement `test`/`connect` + optional providers), read-only session model reuse.
- Modify: `README.md` — Features gains "### Redis and Valkey" bullets (SCAN key explorer, type-aware viewer, console with autocomplete/explain/lint, Bun runtime client, capability-driven); the intro line "direct SQLite and PostgreSQL support" becomes "direct SQLite, PostgreSQL, Redis and Valkey support".

- [ ] **Step 1: Write both.** **Step 2: Commit** — `docs: datasource driver architecture and Redis feature notes`.

---

### Task 21: Integration verification (real Redis + Valkey via Docker)

**Files:**
- Modify: `compose.verify.yml` — add `redis` (image `redis:7-alpine`, port `127.0.0.1:6380:6379`) and `valkey` (image `valkey/valkey:8`, port `127.0.0.1:6381:6379`) services.
- Create: `scripts/verify-redis.ts` — following `scripts/verify-postgres.ts` patterns; uses `makeRedisDriver()` with `Bun.RedisClient` factory (the default) directly (no HTTP layer):
  1. connect to `redis://127.0.0.1:6380` → flavor `redis`, capabilities sanity.
  2. connect to `redis://127.0.0.1:6381` → flavor `valkey`.
  3. On the redis instance: seed one key of each type (`SET/ RPUSH/ SADD/ ZADD/ HSET/ XADD`); `scan` finds all six with correct types; `inspect` each type (assert value kinds + sizes); `keyOp` rename/expire/persist/setString round-trips; console `exec("ZRANGE …")` returns encoded array; `exec("KEYS *")` executes (read, allowed) and `lintCommand` flags it; `exec("SET k v", { writable: false })` throws `not_read_only`.
  4. Print `PASS redis` / `PASS valkey` per phase; exit non-zero on failure; skip cleanly (exit 0 with message) when neither port answers.

- [ ] **Step 1: Write script + compose services.**
- [ ] **Step 2: Run** — `docker compose -f compose.verify.yml up -d redis valkey && bun scripts/verify-redis.ts` — expected: both PASS. Then `docker compose -f compose.verify.yml stop redis valkey` (leave the postgres service contract untouched).
- [ ] **Step 3: Full gates** — `make check` (typecheck, test, ui-smoke, build). Fix anything surfaced.
- [ ] **Step 4: Commit** — `test: redis/valkey driver integration verification`.

---

### Task 22: Review, PR

- [ ] **Step 1:** Run `code-review` at high effort on the branch; fix real findings; re-run `make check`.
- [ ] **Step 2:** Check acceptance criteria against the issue (all boxes) and cross-check spec sections → tasks.
- [ ] **Step 3:** Push `feat/redis` and open the PR to `main` (description summarizing the driver layer, Phase 1 scope, verification evidence; note the zero-dependency policy compliance).

## Self-Review

- **Spec coverage:** connection (T4,9,13,16), capability detection (T3,9), explorer SCAN (T11,17), type viewer (T11,18), TTL (T11,17,18), console (T10,19), autocomplete (T6,19), explain (T7,19), lint (T8,19), driver boundary/docs (T1,12,14,20), tests (T1–14,21), no-dependency policy (global constraints), Valkey same family (T3,21). Command builders/AI explicitly out of scope per spec.
- **Placeholders:** catalog data authoring is bounded by the exact name list + rules + integrity test; all other steps carry concrete code or exact behavioral specs.
- **Type consistency:** `RespValue` tags (`str/int/dbl/bool/err/big/verb/arr/map/set/nil`) used identically in contracts, resp, driver, console renderer; provider property names `console`/`explorer` match contracts and router; `ConnectionProfile.driver: string` (open union) consistent with registry ids.
