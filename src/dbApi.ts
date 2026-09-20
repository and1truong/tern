import type { DbFile, DbSchema, QueryResult, ExecResult, ConnectionProfile, RowChange, RowChangeStatement, RowMutationResult, ConnectionTestResult, DatabaseInsights, MigrationResult, DataSourceInfo, CommandResult, ScanPage, KeyInspection, KeyOp, KeyOpResult } from "../shared/types.ts";

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

const DS = `${API}/datasource`;

export const dbApi = {
  databases: (src: DbSource) => fetch(`${DS}/databases?${selectorQuery(src)}`).then(asJson<{ databases: string[] }>),
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
    fetch(`${DS}/schema?${selectorQuery(src)}`).then(asJson<DbSchema>),
  insights: (src: DbSource) => fetch(`${DS}/insights?${selectorQuery(src)}`).then(asJson<DatabaseInsights>),
  query: (src: DbSource, sql: string, params: unknown[], limit: number, offset = 0, signal?: AbortSignal, timeoutMs = 30_000) =>
    post<QueryResult>(`${DS}/query`, { ...selector(src), sql, params, limit, offset, timeoutMs }, signal),
  exportAll: (src: DbSource, sql: string, params: unknown[], signal?: AbortSignal) =>
    post<QueryResult>(`${DS}/query`, { ...selector(src), sql, params, exportAll: true }, signal),
  explain: (src: DbSource, sql: string, params: unknown[] = [], signal?: AbortSignal, timeoutMs = 30_000) =>
    post<QueryResult>(`${DS}/explain`, { ...selector(src), sql, params, timeoutMs }, signal),
  migration: {
    preview: (src: DbSource, sql: string) => post<MigrationResult>(`${DS}/migration/preview`, { ...selector(src), sql }),
    apply: (src: DbSource, sql: string) => post<MigrationResult>(`${DS}/migration/apply`, { ...selector(src), sql, allowWrite: true }),
  },
  exec: (src: DbSource, sql: string, allowWrite: boolean, signal?: AbortSignal, timeoutMs = 30_000) =>
    post<ExecResult>(`${DS}/exec`, { ...selector(src), sql, allowWrite, timeoutMs }, signal),
  rows: {
    preview: (changes: RowChange[]) =>
      post<{ statements: RowChangeStatement[] }>(`${DS}/rows/preview`, { changes }),
    apply: (src: DbSource, changes: RowChange[], signal?: AbortSignal) =>
      post<RowMutationResult>(`${DS}/rows/apply`, { ...selector(src), changes, allowWrite: true }, signal),
  },
  connections: {
    list: () => fetch(`${API}/connections`).then(asJson<{ connections: ConnectionProfile[] }>),
    save: (driver: string, label: string, url: string, environment: ConnectionProfile["environment"], readOnly: boolean) =>
      post<ConnectionProfile>(`${API}/connections`, { driver, label, url, environment, readOnly }),
    test: async (url: string, signal?: AbortSignal): Promise<ConnectionTestResult> => {
      const info = await post<DataSourceInfo>(`${DS}/test`, { driver: "postgres", url }, signal);
      return { serverVersion: info.version, database: String(info.summary.database ?? ""), user: String(info.summary.user ?? ""), ms: Number(info.summary["ping ms"] ?? 0) };
    },
    delete: (id: string) =>
      fetch(`${API}/connections?id=${encodeURIComponent(id)}`, { method: "DELETE" }).then(asJson<{ ok: boolean }>),
  },
  // Key-value datasources (capability-provided; only drivers with console/explorer
  // providers answer these).
  datasource: {
    test: (driver: string, url: string, signal?: AbortSignal) => post<DataSourceInfo>(`${DS}/test`, { driver, url }, signal),
    session: (src: RedisSource) => post<{ info: DataSourceInfo }>(`${DS}/session`, selector(src)),
    exec: (src: RedisSource, command: string, signal?: AbortSignal) => post<CommandResult>(`${DS}/command`, { ...selector(src), command }, signal),
    scan: (src: RedisSource, q: { cursor: string; match?: string; count?: number; type?: string }) =>
      post<ScanPage>(`${DS}/scan`, { ...selector(src), ...q }),
    inspect: (src: RedisSource, key: string, cursor?: string) =>
      post<KeyInspection>(`${DS}/key`, { ...selector(src), key, ...(cursor !== undefined ? { cursor } : {}) }),
    keyOp: (src: RedisSource, op: KeyOp) => post<KeyOpResult>(`${DS}/key/op`, { ...selector(src), op }),
  },
};
