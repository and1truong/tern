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

// Serialize the tiny local state writes so an older request cannot overwrite
// a newer edit. Every request is time-bounded: a blackholed fetch would
// otherwise wedge the queue and hang close() on state.remove forever.
const STATE_TIMEOUT_MS = 15_000;
let stateWrite: Promise<unknown> = Promise.resolve();
const removedState = new Set<string>();
function saveState(key: string, value: unknown) {
  if (removedState.has(key)) return stateWrite;
  // Check again at execution — a save queued before a remove() must land,
  // but one queued after must not resurrect the deleted key.
  stateWrite = stateWrite.catch(() => {}).then(() =>
    removedState.has(key) ? undefined : post(`${API}/state`, { key, value }, AbortSignal.timeout(STATE_TIMEOUT_MS)));
  return stateWrite;
}

// A caller-supplied abort must compose with the bound, not replace it —
// otherwise a mounted-but-wedged fetch (e.g. export while the tab stays
// open) waits forever. AbortSignal.any is Baseline-2024 — fall back to a
// manual composite on older engines.
const bounded = (signal: AbortSignal | undefined, ms: number): AbortSignal => {
  const bound = AbortSignal.timeout(ms);
  if (!signal) return bound;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, bound]);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.aborted ? signal.reason : bound.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  bound.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted || bound.aborted) onAbort();
  return controller.signal;
};

let accessWrite: Promise<unknown> = Promise.resolve();

const DS = `${API}/datasource`;

export const dbApi = {
  databases: (src: DbSource) => fetch(`${DS}/databases?${selectorQuery(src)}`, { signal: AbortSignal.timeout(STATE_TIMEOUT_MS) }).then(asJson<{ databases: string[] }>),
  // Bounded like the state queue — a blackholed POST must not wedge the
  // access dialog (and with it the whole app) behind accessBusy forever.
  // Serialized too: a connect re-assert racing an explicit toggle must hit
  // the server in call order or the flag desyncs from the UI.
  // `writable` may be a thunk — requests are serialized, so a queued
  // re-assert must read intent at dispatch time, not capture it at call.
  access: (src: DbSource, writable: boolean | (() => boolean)) => {
    accessWrite = accessWrite.catch(() => {}).then(() => post<{ writable: boolean }>(`${API}/access`, { ...selector(src), writable: typeof writable === "function" ? writable() : writable }, AbortSignal.timeout(STATE_TIMEOUT_MS)));
    return accessWrite as Promise<{ writable: boolean }>;
  },
  forget: (path: string) => fetch(`${API}/recent?path=${encodeURIComponent(path)}`, { method: "DELETE", signal: AbortSignal.timeout(STATE_TIMEOUT_MS) }).then(asJson),
  recent: () => fetch(`${API}/recent`, { signal: AbortSignal.timeout(STATE_TIMEOUT_MS) }).then(asJson<{ databases: DbFile[] }>),
  open: (path: string) => post<{ path: string }>(`${API}/open`, { path }, AbortSignal.timeout(STATE_TIMEOUT_MS)),
  state: {
    get: <T>(key: string) => fetch(`${API}/state?key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(STATE_TIMEOUT_MS) }).then(asJson<T | null>),
    set: saveState,
    remove: (key: string) => {
      // Closing a document is permanent; ignore its unmount flush and late
      // query saves. The suppression only arms when the DELETE is next in
      // line — a save already queued behind a slow write must land first.
      stateWrite = stateWrite.catch(() => {}).then(() => {
        removedState.add(key);
        return fetch(`${API}/state?key=${encodeURIComponent(key)}`, { method: "DELETE", signal: AbortSignal.timeout(STATE_TIMEOUT_MS) }).then(asJson);
      }).catch(error => {
        removedState.delete(key);
        throw error;
      });
      return stateWrite;
    },
  },
  create: (path: string) => post<{ path: string; created: true }>(`${API}/create`, { path }, AbortSignal.timeout(STATE_TIMEOUT_MS)),
  schema: (src: DbSource) =>
    fetch(`${DS}/schema?${selectorQuery(src)}`, { signal: AbortSignal.timeout(STATE_TIMEOUT_MS) }).then(asJson<DbSchema>),
  insights: (src: DbSource) => fetch(`${DS}/insights?${selectorQuery(src)}`, { signal: AbortSignal.timeout(STATE_TIMEOUT_MS) }).then(asJson<DatabaseInsights>),
  query: (src: DbSource, sql: string, params: unknown[], limit: number, offset = 0, signal?: AbortSignal, timeoutMs = 30_000) =>
    post<QueryResult>(`${DS}/query`, { ...selector(src), sql, params, limit, offset, timeoutMs }, signal),
  exportAll: (src: DbSource, sql: string, params: unknown[], signal?: AbortSignal) =>
    post<QueryResult>(`${DS}/query`, { ...selector(src), sql, params, exportAll: true, timeoutMs: 120_000 }, bounded(signal, 125_000)),
  explain: (src: DbSource, sql: string, params: unknown[] = [], signal?: AbortSignal, timeoutMs = 30_000) =>
    post<QueryResult>(`${DS}/explain`, { ...selector(src), sql, params, timeoutMs }, signal),
  migration: {
    // Preview and apply run the same script — the budgets must match or a
    // migration previewable in 15s could never finish validating. The
    // client budget sits 5s above the server statement_timeout so the
    // server's own error arrives first.
    preview: (src: DbSource, sql: string) => post<MigrationResult>(`${DS}/migration/preview`, { ...selector(src), sql, timeoutMs: 120_000 }, AbortSignal.timeout(125_000)),
    apply: (src: DbSource, sql: string) => post<MigrationResult>(`${DS}/migration/apply`, { ...selector(src), sql, allowWrite: true, timeoutMs: 120_000 }, AbortSignal.timeout(125_000)),
  },
  exec: (src: DbSource, sql: string, allowWrite: boolean, signal?: AbortSignal, timeoutMs = 30_000) =>
    post<ExecResult>(`${DS}/exec`, { ...selector(src), sql, allowWrite, timeoutMs }, signal),
  rows: {
    preview: (changes: RowChange[]) =>
      post<{ statements: RowChangeStatement[] }>(`${DS}/rows/preview`, { changes }, AbortSignal.timeout(STATE_TIMEOUT_MS)),
    apply: (src: DbSource, changes: RowChange[], signal?: AbortSignal) =>
      post<RowMutationResult>(`${DS}/rows/apply`, { ...selector(src), changes, allowWrite: true, timeoutMs: 60_000 }, bounded(signal, 65_000)),
  },
  connections: {
    list: () => fetch(`${API}/connections`, { signal: AbortSignal.timeout(STATE_TIMEOUT_MS) }).then(asJson<{ connections: ConnectionProfile[] }>),
    save: (driver: string, label: string, url: string, environment: ConnectionProfile["environment"], readOnly: boolean) =>
      post<ConnectionProfile>(`${API}/connections`, { driver, label, url, environment, readOnly }, AbortSignal.timeout(STATE_TIMEOUT_MS)),
    test: async (url: string, signal?: AbortSignal): Promise<ConnectionTestResult> => {
      const info = await post<DataSourceInfo>(`${DS}/test`, { driver: "postgres", url }, bounded(signal, 30_000));
      return { serverVersion: info.version, database: String(info.summary.database ?? ""), user: String(info.summary.user ?? ""), ms: Number(info.summary["ping ms"] ?? 0) };
    },
    delete: (id: string) =>
      fetch(`${API}/connections?id=${encodeURIComponent(id)}`, { method: "DELETE", signal: AbortSignal.timeout(STATE_TIMEOUT_MS) }).then(asJson<{ ok: boolean }>),
  },
  // Key-value datasources (capability-provided; only drivers with console/explorer
  // providers answer these).
  datasource: {
    test: (driver: string, url: string, signal?: AbortSignal) => post<DataSourceInfo>(`${DS}/test`, { driver, url }, bounded(signal, 30_000)),
    // These ops are never blocking, so an unanswered request is a wedged
    // one — bound it rather than leaving a caller's busy flag set forever.
    // exec stays caller-controlled: blocking commands may legitimately wait.
    session: (src: RedisSource) => post<{ info: DataSourceInfo }>(`${DS}/session`, selector(src), AbortSignal.timeout(30_000)),
    exec: (src: RedisSource, command: string, signal?: AbortSignal) => post<CommandResult>(`${DS}/command`, { ...selector(src), command }, signal),
    scan: (src: RedisSource, q: { cursor: string; match?: string; count?: number; type?: string }, signal?: AbortSignal) =>
      post<ScanPage>(`${DS}/scan`, { ...selector(src), ...q }, bounded(signal, 30_000)),
    inspect: (src: RedisSource, key: string, cursor?: string, signal?: AbortSignal) =>
      post<KeyInspection>(`${DS}/key`, { ...selector(src), key, ...(cursor !== undefined ? { cursor } : {}) }, bounded(signal, 30_000)),
    keyOp: (src: RedisSource, op: KeyOp, signal?: AbortSignal) =>
      post<KeyOpResult>(`${DS}/key/op`, { ...selector(src), op }, bounded(signal, 30_000)),
  },
};
