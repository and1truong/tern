import type { DbFile, DbSchema, QueryResult, ExecResult, PgConnection, RowChange, RowChangeStatement, RowMutationResult, ConnectionTestResult, DatabaseInsights, MigrationResult } from "../shared.ts";

const API = "/api";
const session = crypto.randomUUID();

export type DbSource =
  | { kind: "sqlite"; path: string }
  | { kind: "postgres"; connId: string; database?: string; label: string; url: string; environment: PgConnection["environment"]; readOnly: boolean };

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
    headers: { "content-type": "application/json", "x-dbm-session": session },
    body: JSON.stringify(body),
    signal,
  }).then(asJson<T>);
}

// Serialize the tiny local state writes so an older request cannot overwrite a newer edit.
let stateWrite: Promise<unknown> = Promise.resolve();
function saveState(key: string, value: unknown) {
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
  },
  create: (path: string) => post<{ path: string; created: true }>(`${API}/create`, { path }),
  schema: (src: DbSource) =>
    fetch(`${API}/schema?${selectorQuery(src)}`).then(asJson<DbSchema>),
  insights: (src: DbSource) => fetch(`${API}/insights?${selectorQuery(src)}`).then(asJson<DatabaseInsights>),
  query: (src: DbSource, sql: string, params: unknown[], limit: number, offset = 0, signal?: AbortSignal, timeoutMs = 30_000) =>
    post<QueryResult>(`${API}/query`, { ...selector(src), sql, params, limit, offset, timeoutMs }, signal),
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
    list: () => fetch(`${API}/connections`).then(asJson<{ connections: PgConnection[] }>),
    save: (label: string, url: string, environment: PgConnection["environment"], readOnly: boolean) =>
      post<PgConnection>(`${API}/connections`, { label, url, environment, readOnly }),
    test: (url: string, signal?: AbortSignal) => post<ConnectionTestResult>(`${API}/connections/test`, { url }, signal),
    delete: (id: string) =>
      fetch(`${API}/connections?id=${encodeURIComponent(id)}`, { method: "DELETE" }).then(asJson<{ ok: boolean }>),
  },
};
