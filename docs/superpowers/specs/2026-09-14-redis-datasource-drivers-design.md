# Redis/Valkey support via pluggable datasource drivers

Implements https://github.com/and1truong/tern/issues/2 (Phase 1 vertical slice).

## Decisions inherited from the issue

- One Redis-compatible driver family (`flavor: "redis" | "valkey" | "unknown"`); UI/capability decisions come from detected capabilities, never the product name.
- Bun's runtime `RedisClient` is the transport. Its raw `send(command, args)` covers every command (streams included), so no `ioredis`/`redis` dependency is added and no capability gap exists.
- No runtime third-party plugin loading; a static registry is enough for now.
- Out of scope for this pass: command builders, pub/sub monitor, cluster topology UI, module UIs, AI features.

## Adaptation to the existing codebase

The issue's suggested `src/datasources/` tree predates inspection. In this repo `src/` is the browser bundle, and the Bun Redis client cannot run there. The layout becomes:

```text
datasources/               # isomorphic: imported by both server and client bundle
  contracts.ts             # DataSourceDriver, provider interfaces, wire value types
  registry.ts              # static register/get
  redis/                   # pure modules: catalog, autocomplete, explain, lint, resp, capabilities, connection
datasources/redis/
  driver.ts                # server-only: Bun RedisClient transport, sessions, providers
```

Wire types (HTTP JSON shapes) follow the existing convention and live in `shared.ts`; driver contracts (not serialized) live in `datasources/contracts.ts`. `tsconfig.json` `include` gains `datasources/**/*.ts`.

Client code imports only pure modules from `datasources/redis/` (catalog, autocomplete, explain, lint, resp rendering). Only `datasources/redis/driver.ts` imports `Bun.RedisClient`.

## Driver contract

```ts
interface DataSourceDriver {
  id: string;                       // "redis"
  displayName: string;              // "Redis / Valkey"
  kind: string;                     // "key-value"
  validateUrl(url: string): void;
  test(config: ConnectionConfig): Promise<DataSourceInfo>;
  connect(config: ConnectionConfig): Promise<DriverSession>;
}

interface DriverSession {
  info: DataSourceInfo;             // flavor, version, capabilities
  close(): Promise<void>;
}

interface DataSourceInfo {
  flavor: string;                   // "redis" | "valkey" | "unknown"
  version: string;
  capabilities: Capabilities;       // streams, acl, functions, cluster, modules, search
  summary: Record<string, string | number | boolean>;
}
```

Composition over one giant interface — optional providers the generic layer discovers by presence:

```ts
interface ConsoleProvider {
  exec(session, input: { command: string }, ctx: ExecContext): Promise<CommandResult>;
  catalog(session): Promise<CommandDoc[]>;   // built-in catalog + runtime enrichment when available
}
interface KeyValueExplorerProvider {
  scan(session, q: { cursor: string; match?: string; count?: number; type?: string }): Promise<ScanPage>;
  inspect(session, key: string): Promise<KeyInspection>;
  keyOp(session, op: KeyOp): Promise<KeyOpResult>;
}
```

The generic layer never mentions Redis; it checks `driver.console` / `driver.explorer` and serves `/api/datasource/*` through a generic router (`datasources/router.ts`). The router resolves a saved profile's driver via the registry, enforces the existing session-writability model (`x-tern-session` + `/access`, reused unchanged), and delegates. Exec classification (read vs write) comes from the driver's catalog so read-only enforcement matches Redis semantics.

## Transport injection (testability)

The driver is built around `interface RespTransport { send(command: string, args: string[]): Promise<unknown> }`. Production wires `Bun.RedisClient` into it; unit tests inject a fake. Bun types never appear in contracts.

## Connection profiles

Generalize the store so profiles are a core concept owned by the datasource layer:

- Migration v4: `ALTER TABLE pg_connections RENAME TO datasource_connections` + `ADD COLUMN driver TEXT NOT NULL DEFAULT 'postgres'`.
- `server/connections.ts` queries the renamed table; wire type `PgConnection` becomes `ConnectionProfile { driver: "postgres" | "redis", ... }` in `shared.ts`. Credential handling (keychain via `Bun.secrets`, redacted url over the wire, fail-save-never-plaintext) is unchanged and stays generic.
- Redis URLs: `redis://[user:pass@]host:port[/db]`, `rediss://` for TLS — covers host/port, username/password, TLS, and logical db selection in one validated string, mirroring the Postgres URL approach.
- Flavor detection: `INFO` → `valkey_version` present ⇒ valkey, else `redis_version` ⇒ redis, else unknown. Capabilities parsed from INFO sections (`cluster_enabled`, modules block) + version gates (streams ≥5, acl ≥6, functions ≥7).

## HTTP surface (all under /api/datasource, dispatched by capability)

| Route | Body → Response |
|---|---|
| POST /test | `{driver, url, database?}` → `DataSourceInfo` |
| POST /session | `{connId, database?}` → `{info}` (connect/refresh; also feeds toolbar db list via `summary.databases`) |
| POST /exec | `{connId, database?, command}` → `{reply, ms, error?}` |
| GET /catalog | `?connId` → `{commands}` (static + `COMMAND DOCS` enrichment, cached per session) |
| POST /scan | `{connId, database?, cursor, match?, count?, type?}` → `{cursor, keys:[{key,type}]}` |
| POST /key | `{connId, database?, key}` → `KeyInspection` |
| POST /key/op | `{connId, database?, op}` → `KeyOpResult` (rename/delete/expire/persist/edit ops) |

`KeyInspection.value` is type-specific: string (GET with 64KB preview + truncation flag), hash/list/set/zset/stream via cursor-style pages (`HSCAN`/`LRANGE`/`SSCAN`/`ZSCAN`/`XRANGE`), plus type, TTL, size (`MEMORY USAGE` best-effort, `LLEN`/`HLEN`/`SCARD`/`ZCARD`/`XLEN`). Key browsing is `SCAN`-only; `KEYS` never runs.

RESP results are JSON-encoded losslessly (`datasources/redis/resp.ts`): tagged values (`simple/bulk/int/double/bool/nil/array/map/set/verbatim/error/big`) so the console can render nested RESP verbatim.

## Command catalog, autocomplete, explain, lint (all pure, offline, deterministic)

`CommandDoc`: name, group, arity (Redis semantics), summary, args (name/type/optional/multiple/enum + key positions), since, access (`read|write|read-write|admin`), complexity, blocking, ttlEffect, danger (`destructive|blocking|full-scan|admin`), notes (cluster guidance).

- **Catalog**: built-in curated set (~100 common commands across string/hash/list/set/zset/stream/keys/connection/server/scripting/pubsub/transactions). At connect, if the server supports `COMMAND DOCS` (7.0+/valkey), merge runtime docs for known commands; failures tolerated, cache per session.
- **Autocomplete**: token 0 completes command names (with summary/arity/access hints); later positions suggest arg definitions, enum values, and keys (client-side cache from scans/inspections; field/member suggestions from the open key's data). No AI, works offline.
- **Explain**: parsed command + doc + capabilities → what it does, argument meanings (positional mapping), read/write, complexity, blocking, TTL side effects, cluster implications (multi-key without `{hashtags}` when cluster detected), large-key/full-scan risk, danger flags. Rendered in a side panel.
- **Lint**: warnings only, never rewrites — `KEYS` → suggest `SCAN`; `FLUSHALL`/`FLUSHDB` destructive; unbounded reads (`SMEMBERS`, `HGETALL`, `LRANGE 0 -1`, `ZRANGE 0 -1 WITHSCORES`); blocking commands with 0 timeout; admin/config commands; write against read-only session; cross-slot multi-key when cluster capability is on.

## UI

- `DbSource` gains `{ kind: "redis", connId, database?, label, url, environment, readOnly }`; `sourceId`/`sourceLabel` extended. `Document.kind` gains `'key' | 'console'`; `Document.table` carries the Redis key name for `'key'` docs. `isDocuments` validation updated (survives reload with old saved tabs).
- App shell: redis sources connect via `/datasource/session` (storing `DataSourceInfo`, not `DbSchema`); sidebar renders `RedisKeyExplorer` instead of `ObjectTree` when a redis source is selected — capability-driven by provider availability, no `if (redis)` outside this choice; toolbar gains logical-db selector (from `CONFIG GET databases`, tolerant to failure → 16); status bar shows flavor/version/db.
- `DatabaseOpenModal`: third tab "Redis / Valkey" (name, host, port, username, password, TLS checkbox, db index, environment, read-only default ON) with Test Connection and Save & Connect through the same profile endpoints with `driver: "redis"`.
- `RedisKeyExplorer`: `SCAN` cursor pagination + pattern filter + optional type filter; rows show key, type, TTL; actions open (→ `'key'` doc), rename, delete, expire, persist; "Load more" advances the cursor.
- `RedisKeyView`: type-aware rendering (string preview; hash table; list index table; set members; zset member/score; stream id/fields) with safe edits: string SET, hash HSET/HDEL, set SADD/SREM, zset ZADD score/ZREM, list LSET. Stream is read-only in this pass.
- `RedisConsole` (`'console'` doc): CodeMirror input (multi-line, ⌘Enter executes), history + favorites persisted under `redis:<docId>` app state (removed on close like `sql:`), output pane renders RESP trees with duration/error, autocomplete + inline docs, explain and lint panels. Writes require the same explicit writable toggle as SQL.

## Error handling & lifecycle

- Driver errors map to the existing `DbError` codes (`not_found`, `not_read_only`, `timeout`, `sql` for command errors) so HTTP statuses stay consistent.
- Sessions cached per `${connId}/${db}` in the app process; closed on profile delete and process exit; `onclose` marks state disconnected; the next call reconnects lazily (autoReconnect enabled).
- Connect timeout bounded (connectionTimeout 10s → `timeout`).

## Testing

- Unit (bun test, colocated): capabilities parsing (redis 5/7/valkey/cluster/modules fixtures), RESP tokenizer (quotes/escapes) + JSON encoder (all RESP shapes), catalog integrity (unique names, arity sanity, known fields), autocomplete, explain (issue's ZRANGE example), lint rules, connection URL build/validate/redact, driver behavior against a fake transport (scan/inspect/ops/exec/write-enforcement/session reuse), registry + generic router dispatch (fake driver; 404 when a provider is absent), profiles migration v3→v4.
- Integration (docker available locally): `scripts/verify-redis.ts` drives the real driver against `redis:7-alpine` **and** `valkey/valkey` containers — connect, detect flavor/capabilities, SCAN browse, inspect every type, console exec, lint on a `KEYS` command, rename/expire/persist. Compose file gains redis + valkey services; the verify script skips cleanly when containers are unreachable.

## Documentation

`docs/architecture.md` gains a "Datasource drivers" section documenting the boundary and how to add a backend; README gains a short Redis/Valkey feature paragraph.
