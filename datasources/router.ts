// Generic /api/datasource router: resolves a saved profile or SQLite path to
// its driver via the registry, caches sessions, and dispatches by capability
// provider. The core never names a backend — drivers appear only through
// DataSourceDriver.
import { DbError } from "../shared/types.ts";
import type { RowChange } from "../shared/types.ts";
import type { DataSourceDriver, DriverRegistry, DriverSession, RelationalProvider } from "./contracts.ts";
import { compileRowChanges } from "../shared/rowMutations.ts";
import { dbErrorResponse } from "../shared/httpError.ts";

// Structural subset of the server's Connections store.
export interface Profiles {
  get(id: string): Promise<{ id: string; driver: string } | null>;
  resolveUrl(id: string): Promise<string | null>;
}

export interface DatasourceRequest {
  path: string;                        // after "/datasource", e.g. "/exec"
  body: Record<string, unknown>;
  url: URL;
  signal: AbortSignal;
  writable(connKey: string): boolean;  // connKey = `${connId}/${database ?? ""}` or the sqlite path
}

export interface DatasourceRouter {
  route(req: DatasourceRequest): Promise<Response>;
  invalidate(connId: string): Promise<void>;   // close + drop sessions for a deleted profile
}

const fail = (error: string, status = 400) => Response.json({ error }, { status });

// Sub-paths a client may call with GET (selector rides on query params).
export const GET_ROUTES = new Set(["/catalog", "/schema", "/databases", "/insights"]);

// Sub-paths that do not resolve a session/selector.
export const SOURCELESS_ROUTES = new Set(["/test", "/rows/preview"]);

export function makeDatasourceRouter(profiles: Profiles, registry: DriverRegistry): DatasourceRouter {
  // Sessions are stored as promises so concurrent first-requests share one
  // in-flight connect instead of racing transports.
  const sessions = new Map<string, Promise<DriverSession>>();

  const connKey = (body: Record<string, unknown>) => {
    // connId wins over path — the app resolves the writable/session key the
    // same way, so both layers always agree on which source a request means.
    const connId = typeof body.connId === "string" ? body.connId : "";
    if (connId) {
      // `null`, `undefined` and `""` all mean "no database" — the app's key
      // computation uses `?? ""`, so the two layers must agree here. An
      // explicit "" must not reach sessionUrl either: it would reset a
      // profile whose URL selects db 5 back to db 0 under the same key.
      const database = body.database == null || body.database === "" ? "" : String(body.database);
      if (database.length > 64) throw new DbError("invalid_change", "Invalid database");
      return { connId, key: `${connId}/${database}`, database: body.database == null || body.database === "" ? undefined : String(body.database), path: undefined };
    }
    if (typeof body.path === "string" && body.path) {
      return { connId: "", key: body.path, database: undefined as string | undefined, path: body.path };
    }
    return { connId: "", key: "/", database: undefined, path: undefined };
  };

  const resolveSession = (connId: string, database?: string, path?: string): Promise<DriverSession> => {
    const key = path ?? `${connId}/${database ?? ""}`;
    const cached = sessions.get(key);
    if (cached) return cached;
    const connect = async (): Promise<DriverSession> => {
      let driver: DataSourceDriver;
      let url: string;
      if (path !== undefined) {
        // SQLite files are addressed by path; the app's open-gate runs before
        // dispatch, so a path reaching here is already opened this session.
        driver = requireDriver(registry, "sqlite");
        url = path;
      } else {
        const profile = await profiles.get(connId);
        if (!profile) throw new DbError("not_found", "Unknown connection");
        driver = requireDriver(registry, profile.driver);
        // A profile row must never reach the sqlite driver — /open's file
        // gate (realpath, opened-set, app-db guard) only applies to paths.
        if (driver.id === "sqlite") throw new DbError("invalid_change", "SQLite files open through the file picker");
        const resolved = await profiles.resolveUrl(connId);
        if (!resolved) throw new DbError("not_found", `No stored url for connection "${profile.id}"`);
        url = resolved;
      }
      const session = await catchDb(() => driver.connect({ url, database }));
      // invalidate() may have swept this key while the connect was in
      // flight — the session can never be served again, so close it rather
      // than leak the transport.
      if (sessions.get(key) !== connecting) {
        await session.close().catch(() => {});
        throw new DbError("not_found", "Connection was removed");
      }
      return session;
    };
    const connecting = connect();
    sessions.set(key, connecting);
    // A failed connect must not poison the cache for later requests.
    connecting.catch(() => { if (sessions.get(key) === connecting) sessions.delete(key); });
    return connecting;
  };

  const withSession = async (body: Record<string, unknown>, fn: (session: DriverSession) => Promise<unknown>): Promise<Response> => {
    const { connId, key, database, path } = connKey(body);
    const pending = resolveSession(connId, database, path);
    try {
      return Response.json(await fn(await pending));
    } catch (error) {
      // Only transport-level failures break a live session; logical errors (a
      // read-only rejection, a refused key op, a command error, a SQL error on
      // a stateless session) keep it. Evicted sessions are closed, never just
      // dropped, and only when the map still holds this exact session.
      if (error instanceof DbError && (error.code === "sql" || error.code === "timeout") && sessions.get(key) === pending) {
        void pending.then(session => {
          if (!session.stateless && sessions.get(key) === pending) {
            sessions.delete(key);
            void session.close().catch(() => {});
          }
        }).catch(() => {});
      }
      return dbErrorResponse(error);
    }
  };

  const withRelational = (body: Record<string, unknown>, fn: (provider: RelationalProvider) => Promise<unknown>): Promise<Response> =>
    withSession(body, session => {
      if (!session.relational) throw new DbError("not_found", "This source has no relational provider");
      return fn(session.relational);
    });

  const str = (value: unknown, what: string, min = 1, max = 512): string => {
    if (typeof value !== "string" || value.length < min || value.length > max) throw new DbError("invalid_change", `Invalid ${what}`);
    return value;
  };
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const sql = (body: Record<string, unknown>) => typeof body.sql === "string" ? body.sql : "";
  const params = (body: Record<string, unknown>) => Array.isArray(body.params) ? body.params : undefined;

  return {
    async route(req: DatasourceRequest): Promise<Response> {
      const body = req.body;
      try {
        switch (req.path) {
          case "/test": {
            const driver = requireDriver(registry, typeof body.driver === "string" ? body.driver : "");
            // SQLite files open through /open only — /test must not probe
            // arbitrary filesystem paths or the app database itself.
            if (driver.id === "sqlite") return fail("SQLite files open through the file picker", 400);
            const url = str(body.url, "connection url", 1, 1024);
            // "" means "no database override", matching connKey — sessionUrl
            // must preserve the URL's embedded db, not reset to db 0.
            const database = body.database === undefined || body.database === "" ? undefined : str(body.database, "database", 0, 64);
            driver.validateUrl(url);
            return Response.json(await catchDb(() => driver.test({ url, database })));
          }
          case "/session": {
            const { connId, database, path } = connKey(body);
            if (path === undefined) str(connId, "connection id", 1, 128);
            const session = await resolveSession(connId, database, path);
            return Response.json({ info: session.info });
          }
          // Relational provider routes — sqlite paths and connId profiles alike.
          case "/schema":
            return await withRelational(body, r => r.schema(req.signal));
          case "/databases":
            return await withRelational(body, r => {
              if (!r.databases) throw new DbError("not_found", "This source lists no databases");
              return r.databases().then(databases => ({ databases }));
            });
          case "/insights":
            return await withRelational(body, r => r.insights(req.signal));
          case "/query":
            return await withRelational(body, r => r.query({
              sql: sql(body), params: params(body), limit: num(body.limit), offset: num(body.offset),
              timeoutMs: num(body.timeoutMs), exportAll: body.exportAll === true,
            }, req.signal));
          case "/explain":
            return await withRelational(body, r => r.explain({ sql: sql(body), params: params(body), timeoutMs: num(body.timeoutMs) }, req.signal));
          // /exec with allowWrite !== true is the read-only batch path: the
          // engine validates the script and enforces read-only execution.
          case "/exec": {
            const allowWrite = body.allowWrite === true;
            const { key } = connKey(body);
            if (allowWrite && !req.writable(key)) return fail("Connection is read-only", 403);
            return await withRelational(body, r => r.exec(sql(body), allowWrite, req.signal, num(body.timeoutMs)));
          }
          case "/migration/preview": {
            // A preview still executes the script inside a rolled-back
            // transaction — profiled connections need the writable session.
            const { key } = connKey(body);
            if (body.connId !== undefined && !req.writable(key)) return fail("Connection is read-only", 403);
            return await withRelational(body, r => r.migrate(sql(body), false, req.signal, num(body.timeoutMs)));
          }
          case "/migration/apply": {
            const { key } = connKey(body);
            if (!req.writable(key)) return fail("Connection is read-only", 403);
            if (body.allowWrite !== true) throw new DbError("not_read_only", "migration apply requires explicit confirmation");
            return await withRelational(body, r => r.migrate(sql(body), true, req.signal, num(body.timeoutMs)));
          }
          case "/rows/preview": {
            if (!Array.isArray(body.changes)) throw new DbError("invalid_change", "Invalid changes");
            return Response.json({ statements: compileRowChanges(body.changes as RowChange[]) });
          }
          case "/rows/apply": {
            const { key } = connKey(body);
            if (!req.writable(key)) return fail("Connection is read-only", 403);
            if (body.allowWrite !== true) throw new DbError("not_read_only", "row changes require explicit confirmation");
            if (!Array.isArray(body.changes)) throw new DbError("invalid_change", "Invalid changes");
            return await withRelational(body, r => r.applyRows(body.changes as RowChange[], req.signal, num(body.timeoutMs)));
          }
          // Command-console and key-explorer providers (redis-family drivers).
          case "/command": {
            const command = str(body.command, "command", 1, 10_000);
            const { key } = connKey(body);
            return await withSession(body, async (session) => {
              if (!session.console) throw new DbError("not_found", "This source has no command console");
              return session.console.exec(command, { writable: req.writable(key) });
            });
          }
          case "/catalog": {
            return await withSession(body, async (session) => {
              if (!session.console) throw new DbError("not_found", "This source has no command console");
              return { commands: await session.console.catalog() };
            });
          }
          case "/scan": {
            const cursor = body.cursor === undefined || body.cursor === "" ? "0" : str(body.cursor, "cursor", 1, 64);
            if (!/^\d+$/.test(cursor)) throw new DbError("invalid_change", "Invalid cursor");
            const count = num(body.count);
            if (body.count !== undefined && (count === undefined || count < 1 || count > 1000)) throw new DbError("invalid_change", "Invalid count");
            return await withSession(body, async (session) => {
              if (!session.explorer) throw new DbError("not_found", "This source has no key explorer");
              return session.explorer.scan({
                cursor,
                // Reject rather than truncate or drop — a changed glob or a
                // silently discarded match scans a different key set than
                // the caller asked for.
                match: body.match === undefined ? undefined : str(body.match, "match", 1, 256),
                count,
                type: body.type === undefined ? undefined : str(body.type, "type", 1, 64),
              });
            });
          }
          case "/key": {
            const key = str(body.key, "key", 0, 64 * 1024);
            const cursor = body.cursor === undefined || body.cursor === "" ? undefined : str(body.cursor, "cursor", 1, 128);
            return await withSession(body, async (session) => {
              if (!session.explorer) throw new DbError("not_found", "This source has no key explorer");
              return session.explorer.inspect(key, cursor);
            });
          }
          case "/key/op": {
            const op = body.op;
            if (!op || typeof op !== "object") throw new DbError("invalid_change", "Invalid key operation");
            validateKeyOp(op as Record<string, unknown>);
            // Every key mutation is a write: require the enabled-write session.
            const { key: opKey } = connKey(body);
            if (!req.writable(opKey)) throw new DbError("not_read_only", "Connection is read-only");
            return await withSession(body, async (session) => {
              if (!session.explorer) throw new DbError("not_found", "This source has no key explorer");
              return session.explorer.keyOp(op as never);
            });
          }
          default:
            return fail("Not found", 404);
        }
      } catch (error) {
        return dbErrorResponse(error);
      }
    },

    async invalidate(connId: string): Promise<void> {
      const prefix = `${connId}/`;
      for (const [key, session] of sessions) {
        if (!key.startsWith(prefix)) continue;
        sessions.delete(key);
        await session.then(s => s.close()).catch(() => {});
      }
    },
  };
}

// Shape-check a key operation before it reaches the driver — a malformed op
// (e.g. `members: "admin"` char-splitting into SREM arguments) must fail here,
// never mutate members the caller never named.
function validateKeyOp(op: Record<string, unknown>): void {
  // Redis keys, fields and members can far exceed a short buffer — RESP
  // bulk strings carry them, so the cap is only a sanity bound. SET "" v is
  // legal too — empty names round-trip fine.
  const key = (v: unknown): v is string => typeof v === "string" && v.length <= 64 * 1024;
  const keys = (v: unknown): v is string[] => Array.isArray(v) && v.length >= 1 && v.length <= 100 && v.every(key);
  const items = (v: unknown): v is string[] => Array.isArray(v) && v.length >= 1 && v.length <= 100 && v.every(i => typeof i === "string" && i.length <= 64 * 1024);
  // Values are capped too — a multi-hundred-MB body has no business flowing
  // into a workbench key edit.
  const value = (v: unknown): v is string => typeof v === "string" && v.length <= 1024 * 1024;
  const bad = (): never => { throw new DbError("invalid_change", `Invalid "${String(op.op)}" key operation`); };
  switch (op.op) {
    case "rename": if (!key(op.from) || !key(op.to)) bad(); break;
    case "delete": if (!keys(op.keys)) bad(); break;
    // EXPIRE with 0 or a negative value deletes the key immediately — keep
    // that behind the explicit delete flow, never the expire one. Non-safe
    // integers would stringify into forms Redis cannot parse (1e21 → "1e+21").
    case "expire":
      if (!key(op.key)) bad();
      if (typeof op.seconds !== "number" || !Number.isSafeInteger(op.seconds) || op.seconds < 1) {
        throw new DbError("invalid_change", "Expire requires a positive integer number of seconds");
      }
      break;
    case "persist": if (!key(op.key)) bad(); break;
    case "setString": if (!key(op.key) || !value(op.value)) bad(); break;
    case "hashSet": if (!key(op.key) || typeof op.field !== "string" || op.field.length > 64 * 1024 || !value(op.value)) bad(); break;
    case "hashDelete": if (!key(op.key) || !items(op.fields)) bad(); break;
    case "setAdd": case "setRemove": case "zsetRemove": if (!key(op.key) || !items(op.members)) bad(); break;
    case "zsetAdd": if (!key(op.key) || typeof op.member !== "string" || op.member.length > 64 * 1024 || typeof op.score !== "number" || !Number.isFinite(op.score)) bad(); break;
    case "listSet": if (!key(op.key) || typeof op.index !== "number" || !Number.isSafeInteger(op.index) || !value(op.value)) bad(); break;
    default: bad();
  }
}

function requireDriver(registry: DriverRegistry, id: string): DataSourceDriver {
  const driver = registry.get(id);
  if (!driver) throw new DbError("not_found", `Unknown driver "${id}"`);
  return driver;
}

async function catchDb<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (error) {
    if (error instanceof DbError) throw error;
    throw new DbError("sql", error instanceof Error ? error.message.replace(/(?:rediss?|postgres(?:ql)?):\/\/\S+/gi, "[connection]") : "connection failed");
  }
}
