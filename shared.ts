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

// A remembered Postgres connection. `url` is always credential-redacted;
// full credential URLs are stored in the OS credential manager.
export interface PgConnection {
  id: string;
  label: string;
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

// Thrown by dbServer on bad path / non-read query / SQL error. HTTP layer maps
// it to a 4xx with { error }.
export class DbError extends Error {
  constructor(public code: "not_found" | "not_a_database" | "not_read_only" | "multi_statement" | "sql" | "cancelled" | "timeout" | "invalid_change" | "conflict", message: string) {
    super(message);
    this.name = "DbError";
  }
}
