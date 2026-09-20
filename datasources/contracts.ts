// Datasource driver contracts. Isomorphic: imported by the Bun server and the
// browser bundle. No runtime-specific imports (Bun clients stay inside driver
// implementations, e.g. datasources/redis/driver.ts).
import type {
  CommandResult, DatabaseInsights, DataSourceInfo, DbSchema, ExecResult, KeyInspection,
  KeyOp, KeyOpResult, MigrationResult, QueryResult, RowChange, RowMutationResult, ScanPage,
} from "../shared/types.ts";
import type { CommandDoc } from "./redis/catalog.ts";

export interface ConnectionConfig {
  url: string;              // credential-bearing; resolved server-side, never sent to the client
  database?: string;        // logical database (Redis db index as string)
}

export interface ExecContext {
  writable: boolean;        // session writes explicitly enabled via /api/access
}

export interface ConsoleProvider {
  exec(command: string, ctx: ExecContext): Promise<CommandResult>;
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

export interface RelationalQuery {
  sql: string;
  params?: unknown[];
  limit?: number;
  offset?: number;
  timeoutMs?: number;
  exportAll?: boolean;
}

// Relational engines (sqlite, postgres). Sessions hold resolved config, not a
// live connection — engines open per call (pg) or per subprocess (sqlite).
export interface RelationalProvider {
  databases?(): Promise<string[]>;                     // postgres only
  schema(signal?: AbortSignal): Promise<DbSchema>;
  insights(signal?: AbortSignal): Promise<DatabaseInsights>;
  query(q: RelationalQuery, signal?: AbortSignal): Promise<QueryResult>;
  explain(q: RelationalQuery, signal?: AbortSignal): Promise<QueryResult>;
  exec(sql: string, writable: boolean, signal?: AbortSignal, timeoutMs?: number): Promise<ExecResult>;
  migrate(sql: string, apply: boolean, signal?: AbortSignal, timeoutMs?: number): Promise<MigrationResult>;
  applyRows(changes: RowChange[], signal?: AbortSignal, timeoutMs?: number): Promise<RowMutationResult>;
}

export interface DriverSession {
  info: DataSourceInfo;
  console?: ConsoleProvider;
  explorer?: KeyValueExplorerProvider;
  relational?: RelationalProvider;
  // Sessions without a live transport (relational engines open connections
  // per call) are never invalidated by provider errors.
  stateless?: boolean;
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
