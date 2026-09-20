// Generic /api/datasource router: resolves a saved profile to its driver via
// the registry, caches sessions, and dispatches by capability provider. The
// core never names a backend — drivers appear only through DataSourceDriver.
import { DbError } from "../shared/types.ts";
import type { DataSourceDriver, DriverRegistry, DriverSession } from "./contracts.ts";
import { dbErrorResponse } from "../server/routeHandlers.ts";

// Structural subset of the server's Connections store.
export interface Profiles {
  get(id: string): Promise<{ id: string; driver: string } | null>;
  resolveUrl(id: string): Promise<string | null>;
}

export interface DatasourceRequest {
  path: string;                        // after "/datasource", e.g. "/exec"
  body: Record<string, unknown>;
  url: URL;
  writable(connKey: string): boolean;  // connKey = `${connId}/${database ?? ""}`
}

export interface DatasourceRouter {
  route(req: DatasourceRequest): Promise<Response>;
  invalidate(connId: string): Promise<void>;   // close + drop sessions for a deleted profile
}

const fail = (error: string, status = 400) => Response.json({ error }, { status });

export function makeDatasourceRouter(profiles: Profiles, registry: DriverRegistry): DatasourceRouter {
  // Sessions are stored as promises so concurrent first-requests share one
  // in-flight connect instead of racing transports.
  const sessions = new Map<string, Promise<DriverSession>>();

  const connKey = (body: Record<string, unknown>) => {
    const connId = typeof body.connId === "string" ? body.connId : "";
    const database = body.database === undefined ? "" : String(body.database);
    if (database.length > 64) throw new DbError("invalid_change", "Invalid database");
    return { connId, key: `${connId}/${database}`, database: body.database === undefined ? undefined : String(body.database) };
  };

  const resolveSession = (connId: string, database?: string): Promise<DriverSession> => {
    const key = `${connId}/${database ?? ""}`;
    const cached = sessions.get(key);
    if (cached) return cached;
    const connecting = (async () => {
      const profile = await profiles.get(connId);
      if (!profile) throw new DbError("not_found", "Unknown connection");
      const driver = registry.get(profile.driver);
      if (!driver) throw new DbError("not_found", `Unknown driver "${profile.driver}"`);
      const url = await profiles.resolveUrl(connId);
      if (!url) throw new DbError("not_found", `No stored url for connection "${profile.id}"`);
      return catchDb(() => driver.connect({ url, database }));
    })();
    sessions.set(key, connecting);
    // A failed connect must not poison the cache for later requests.
    connecting.catch(() => { if (sessions.get(key) === connecting) sessions.delete(key); });
    return connecting;
  };

  const withSession = async (body: Record<string, unknown>, fn: (session: DriverSession) => Promise<unknown>): Promise<Response> => {
    const { connId, key, database } = connKey(body);
    const pending = resolveSession(connId, database);
    try {
      return Response.json(await fn(await pending));
    } catch (error) {
      // Only transport-level failures break the session; logical errors (a
      // read-only rejection, a refused key op, a command error) keep the
      // healthy session. Evicted sessions are closed, never just dropped,
      // and only when the map still holds this exact session.
      if (error instanceof DbError && (error.code === "sql" || error.code === "timeout") && sessions.get(key) === pending) {
        sessions.delete(key);
        void pending.then(session => session.close()).catch(() => {});
      }
      return dbErrorResponse(error);
    }
  };

  const str = (value: unknown, what: string, min = 1, max = 512): string => {
    if (typeof value !== "string" || value.length < min || value.length > max) throw new DbError("invalid_change", `Invalid ${what}`);
    return value;
  };

  return {
    async route(req: DatasourceRequest): Promise<Response> {
      const body = req.body;
      try {
        switch (req.path) {
          case "/test": {
            const driver = requireDriver(registry, typeof body.driver === "string" ? body.driver : "");
            const url = str(body.url, "connection url", 1, 1024);
            const database = body.database === undefined ? undefined : str(body.database, "database", 0, 64);
            return Response.json(await catchDb(() => driver.test({ url, database })));
          }
          case "/session": {
            const { connId, database } = connKey(body);
            str(connId, "connection id", 1, 128);
            const session = await resolveSession(connId, database);
            return Response.json({ info: session.info });
          }
          case "/exec": {
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
            const cursor = str(body.cursor ?? "0", "cursor", 1, 64);
            if (!/^\d+$/.test(cursor)) throw new DbError("invalid_change", "Invalid cursor");
            const count = body.count === undefined ? undefined : Number(body.count);
            if (count !== undefined && (!Number.isFinite(count) || count < 1 || count > 1000)) throw new DbError("invalid_change", "Invalid count");
            return await withSession(body, async (session) => {
              if (!session.explorer) throw new DbError("not_found", "This source has no key explorer");
              return session.explorer.scan({
                cursor,
                match: typeof body.match === "string" ? body.match.slice(0, 256) : undefined,
                count,
                type: typeof body.type === "string" ? body.type.slice(0, 64) : undefined,
              });
            });
          }
          case "/key": {
            const key = str(body.key, "key", 1, 512);
            const cursor = body.cursor === undefined ? undefined : str(body.cursor, "cursor", 0, 128);
            return await withSession(body, async (session) => {
              if (!session.explorer) throw new DbError("not_found", "This source has no key explorer");
              return session.explorer.inspect(key, cursor);
            });
          }
          case "/key/op": {
            const op = body.op;
            if (!op || typeof op !== "object") throw new DbError("invalid_change", "Invalid key operation");
            // EXPIRE with 0 or a negative value deletes the key immediately —
            // keep that behind the explicit delete flow, never the expire one.
            if ((op as { op?: string }).op === "expire") {
              const seconds = (op as { seconds?: unknown }).seconds;
              if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 1) {
                throw new DbError("invalid_change", "Expire requires a positive number of seconds");
              }
            }
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

function requireDriver(registry: DriverRegistry, id: string): DataSourceDriver {
  const driver = registry.get(id);
  if (!driver) throw new DbError("not_found", `Unknown driver "${id}"`);
  return driver;
}

async function catchDb<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (error) {
    if (error instanceof DbError) throw error;
    throw new DbError("sql", error instanceof Error ? error.message.replace(/rediss?:\/\/\S+/gi, "[connection]") : "connection failed");
  }
}
