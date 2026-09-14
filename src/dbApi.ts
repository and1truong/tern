import type { DbFile, DbSchema, QueryResult, ExecResult, ConnectionProfile, RowChange, RowChangeStatement, RowMutationResult, ConnectionTestResult, DatabaseInsights, MigrationResult, DataSourceInfo, CommandResult, ScanPage, KeyInspection, KeyOp, KeyOpResult } from "../shared.ts";
import type { CommandDoc } from "../datasources/redis/catalog.ts";

const API = "/api";
const session = crypto.randomUUID();

export type RedisSource = { kind: "redis"; connId: string; database: string; label: string; url: string; environment: ConnectionProfile["environment"]; readOnly: boolean };

export type DbSource =
  | { kind: "sqlite"; path: string }
  | { kind: "postgres"; connId: string; database?: string; label: string; url: string; environment: ConnectionProfile["environment"]; readOnly: boolean }
  | RedisSource;

function selector(src: DbSource): { path?: string; connId?: string; database?: string } {
  return src.kind === "sqlite" ? { path: src.path } : { connId: src.connId, database: src.database };
}
function selectorQuery(src: DbSource): string {
  return src.kind === "sqlite"
    ? `path=${encodeURIComponent(src.path)}`
    : `connId=${encodeURIComponent(src.connId)}${src.database ? `&database=${encodeURIComponent(src.database)}` : ""}`;
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status}`;
    try { const j = await res.json(); msg = (j as { error?: string }).error ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tern-session": session },
    body: JSON.stringify(body),
    signal,
  }).then(asJson<T>);
}

// Serialize the tiny local state writes so an older request cannot overwrite a newer edit.
let stateWrite: Promise<unknown> = Promise.resolve();
const removedState = new Set<string>();
function saveState(key: string, value: unknown) {
  if (removedState.has(key)) return stateWrite;
  stateWrite = stateWrite.catch(() => {}).then(() => post(`${API}/state`, { key, value }));
  return stateWrite;
}

export const dbApi = {
  databases: (src: DbSource) => fetch(`${API}/databases?${selectorQuery(src)}`).then(asJson<{ databases: string[] }>),
  access: (src: DbSource, writable: boolean) => post(`${API}/access`, { ...selector(src), writable }),
  forget: (path: string) => fetch(`${API}/recent?path=${encodeURIComponent(path)}`, { method: "DELETE" }).then(asJson),
  recent: () => fetch(`${API}/recent`).then(asJson<{ databases: DbFile[] }>),
  open: (path: string) => post<{ path: string }>(`${API}/open`, { path }),
  state: {
    get: <T>(key: string) => fetch(`${API}/state?key=${encodeURIComponent(key)}`).then(asJson<T | null>),
    set: saveState,
    remove: (key: string) => {
      // Closing a document is permanent; ignore its unmount flush and late query saves.
      removedState.add(key);
      stateWrite = stateWrite.catch(() => {}).then(() => fetch(`${API}/state?key=${encodeURIComponent(key)}`, { method: "DELETE" }).then(asJson)).catch(error => {
        removedState.delete(key);
        throw error;
      });
      return stateWrite;
    },
  },
  create: (path: string) => post<{ path: string; created: true }>(`${API}/create`, { path }),
  schema: (src: DbSource) =>
    fetch(`${API}/schema?${selectorQuery(src)}`).then(asJson<DbSchema>),
  insights: (src: DbSource) => fetch(`${API}/insights?${selectorQuery(src)}`).then(asJson<DatabaseInsights>),
  query: (src: DbSource, sql: string, params: unknown[], limit: number, offset = 0, signal?: AbortSignal, timeoutMs = 30_000) =>
    post<QueryResult>(`${API}/query`, { ...selector(src), sql, params, limit, offset, timeoutMs }, signal),
  exportAll: (src: DbSource, sql: string, params: unknown[], signal?: AbortSignal) =>
    post<QueryResult>(`${API}/query`, { ...selector(src), sql, params, exportAll: true }, signal),
  explain: (src: DbSource, sql: string, params: unknown[] = [], signal?: AbortSignal, timeoutMs = 30_000) =>
    post<QueryResult>(`${API}/explain`, { ...selector(src), sql, params, timeoutMs }, signal),
  migration: {
    preview: (src: DbSource, sql: string) => post<MigrationResult>(`${API}/migration/preview`, { ...selector(src), sql }),
    apply: (src: DbSource, sql: string) => post<MigrationResult>(`${API}/migration/apply`, { ...selector(src), sql, allowWrite: true }),
  },
  exec: (src: DbSource, sql: string, allowWrite: boolean, signal?: AbortSignal, timeoutMs = 30_000) =>
    post<ExecResult>(`${API}/exec`, { ...selector(src), sql, allowWrite, timeoutMs }, signal),
  rows: {
    preview: (changes: RowChange[]) =>
      post<{ statements: RowChangeStatement[] }>(`${API}/rows/preview`, { changes }),
    apply: (src: DbSource, changes: RowChange[], signal?: AbortSignal) =>
      post<RowMutationResult>(`${API}/rows/apply`, { ...selector(src), changes, allowWrite: true }, signal),
  },
  connections: {
    list: () => fetch(`${API}/connections`).then(asJson<{ connections: ConnectionProfile[] }>),
    save: (driver: string, label: string, url: string, environment: ConnectionProfile["environment"], readOnly: boolean) =>
      post<ConnectionProfile>(`${API}/connections`, { driver, label, url, environment, readOnly }),
    test: (url: string, signal?: AbortSignal) => post<ConnectionTestResult>(`${API}/connections/test`, { url }, signal),
    delete: (id: string) =>
      fetch(`${API}/connections?id=${encodeURIComponent(id)}`, { method: "DELETE" }).then(asJson<{ ok: boolean }>),
  },
  // Key-value datasources (capability-provided; only drivers with console/explorer
  // providers answer these).
  datasource: {
    test: (driver: string, url: string) => post<DataSourceInfo>(`${API}/datasource/test`, { driver, url }),
    session: (src: RedisSource) => post<{ info: DataSourceInfo }>(`${API}/datasource/session`, selector(src)),
    exec: (src: RedisSource, command: string) => post<CommandResult>(`${API}/datasource/exec`, { ...selector(src), command }),
    scan: (src: RedisSource, q: { cursor: string; match?: string; count?: number; type?: string }) =>
      post<ScanPage>(`${API}/datasource/scan`, { ...selector(src), ...q }),
    inspect: (src: RedisSource, key: string, cursor?: string) =>
      post<KeyInspection>(`${API}/datasource/key`, { ...selector(src), key, ...(cursor !== undefined ? { cursor } : {}) }),
    keyOp: (src: RedisSource, op: KeyOp) => post<KeyOpResult>(`${API}/datasource/key/op`, { ...selector(src), op }),
    catalog: (src: RedisSource) =>
      fetch(`${API}/datasource/catalog?${selectorQuery(src)}`).then(asJson<{ commands: CommandDoc[] }>),
  },
};
