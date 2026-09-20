// HTTP JSON shapes shared by the application's server endpoints and client.

export interface DbFile {
  path: string;        // absolute
  name: string;        // basename
  sizeBytes: number;
}

export type DbObjectType = "table" | "view" | "materialized_view";

export interface DbColumn {
  name: string;
  type: string;        // declared type, "" if none
  notNull: boolean;
  pk: boolean;
  fk: string | string[] | null;   // One or more "refsTable(refsCol)" targets
  defaultValue?: string | null;
  identity?: boolean;
  identityGeneration?: "ALWAYS" | "BY DEFAULT";
  ownedSequence?: boolean;
  generated?: boolean;
  comparable?: boolean;
  orderable?: boolean;
}

export interface DbTable {
  name: string;
  schema?: string;            // Postgres schema; absent for SQLite
  type: DbObjectType;
  columns: DbColumn[];
  uniqueKeys?: string[][];     // candidate row identities when no primary key exists
  rowCount: number;    // -1 if unknown
  ddl: string;         // sqlite_master.sql
}

export interface DbSchema {
  tables: DbTable[];          // tables + views, sqlite_master order
  schemas?: string[];
  indexes: { name: string; sql: string; schema?: string; table?: string; unique?: boolean; columns?: string[] }[];
  triggers: { name: string; sql: string; schema?: string; table?: string; timing?: string; event?: string }[];
  constraints?: { name: string; schema?: string; table: string; type: string; columns: string[]; definition: string }[];
  sequences?: { name: string; schema?: string; definition?: string }[];
  routines?: { name: string; schema?: string; type?: string; definition?: string }[];
  extensions?: { name: string; definition?: string }[];
  pragmas: Record<string, string>; // journal_mode, foreign_keys, encoding, user_version, synchronous
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  ms: number;
  hasMore: boolean;
  offset: number;
}

export interface ExecResult {
  result?: QueryResult;
  rowsAffected: number | null;
  ms: number;
}

export interface DbTableRef {
  name: string;
  schema?: string;
}

export type RowChange =
  | { kind: "insert"; table: DbTableRef; values: Record<string, unknown> }
  | { kind: "update"; table: DbTableRef; key: Record<string, unknown>; expected: Record<string, unknown>; values: Record<string, unknown> }
  | { kind: "delete"; table: DbTableRef; key: Record<string, unknown>; expected: Record<string, unknown> };

export interface RowChangeStatement {
  kind: RowChange["kind"];
  sql: string;
  params: unknown[];
}

export interface RowMutationResult {
  applied: number;
  rowsAffected: number;
  ms: number;
}

// A remembered connection profile for any registered datasource driver.
// `url` is always credential-redacted; full credential URLs are stored in the
// OS credential manager.
export interface ConnectionProfile {
  id: string;
  label: string;
  driver: string;      // registry id, e.g. "postgres" | "redis"
  url: string;
  createdAt: number;
  lastUsedAt: number | null;
  environment: "local" | "development" | "staging" | "production";
  readOnly: boolean;
}

export interface ConnectionTestResult {
  database: string;
  user: string;
  serverVersion: string;
  ms: number;
}

export interface DatabaseInsights {
  metrics: Record<string, string | number>;
  activity: { id: string; user: string; state: string; durationMs: number; wait: string; query: string; application?: string; transaction?: string; locks?: number }[];
  tables?: { name: string; bytes: number; live: number; dead: number; scans: number }[];
}

export interface MigrationResult {
  validated: boolean;
  applied: boolean;
  ms: number;
}

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
  flavor?: RedisFlavor;      // redis-family drivers only
  version: string;
  capabilities?: Capabilities;  // redis-family drivers only
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
  | { t: "map"; entries: [RespValue, RespValue][] }
  | { t: "set"; items: RespValue[] }
  | { t: "arr"; items: RespValue[] };

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

// Thrown by dbServer on bad path / non-read query / SQL error. HTTP layer maps
// it to a 4xx with { error }.
export class DbError extends Error {
  constructor(public code: "not_found" | "not_a_database" | "not_read_only" | "multi_statement" | "sql" | "cancelled" | "timeout" | "invalid_change" | "conflict" | "command_error", message: string) {
    super(message);
    this.name = "DbError";
  }
}
