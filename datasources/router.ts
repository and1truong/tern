// Generic /api/datasource router: resolves a saved profile to its driver via
// the registry, caches sessions, and dispatches by capability provider. The
// core never names a backend — drivers appear only through DataSourceDriver.
import { DbError } from "../shared.ts";
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
  const sessions = new Map<string, DriverSession>();

  const connKey = (body: Record<string, unknown>) => {
    const connId = typeof body.connId === "string" ? body.connId : "";
    const database = body.database === undefined ? "" : String(body.database);
    return { connId, key: `${connId}/${database}`, database: body.database === undefined ? undefined : String(body.database) };
  };

  const resolveSession = async (connId: string, database?: string): Promise<DriverSession> => {
    const key = `${connId}/${database ?? ""}`;
    const cached = sessions.get(key);
    if (cached) return cached;
    const profile = await profiles.get(connId);
    if (!profile) throw new DbError("not_found", "Unknown connection");
    const driver = registry.get(profile.driver);
    if (!driver) throw new DbError("not_found", `Unknown driver "${profile.driver}"`);
    const url = await profiles.resolveUrl(connId);
    if (!url) throw new DbError("not_found", `No stored url for connection "${profile.id}"`);
    const config = { url, database };
    const session = await catchDb(() => driver.connect(config));
    sessions.set(key, session);
    return session;
  };

  const withSession = async (body: Record<string, unknown>, fn: (session: DriverSession) => Promise<unknown>): Promise<Response> => {
    const { connId, key, database } = connKey(body);
    try {
      const session = await resolveSession(connId, database);
      return Response.json(await fn(session));
    } catch (error) {
      // Only transport-level failures break the session; logical errors (a
      // read-only rejection, a refused key op) keep the healthy session.
      // Evicted sessions are closed, never just dropped.
      if (error instanceof DbError && (error.code === "sql" || error.code === "timeout")) {
        const evicted = sessions.get(key);
        sessions.delete(key);
        await evicted?.close().catch(() => {});
      }
      return dbErrorResponse(error);
    }
  };

  const str = (value: unknown, what: string, min = 1, max = 512): string => {
    if (typeof value !== "string" || value.length < min || value.length > max) throw new DbError("not_found", `Invalid ${what}`);
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
            if (!/^\d+$/.test(cursor)) throw new DbError("not_found", "Invalid cursor");
            const count = body.count === undefined ? undefined : Number(body.count);
            if (count !== undefined && (!Number.isFinite(count) || count < 1 || count > 1000)) throw new DbError("not_found", "Invalid count");
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
            if (!op || typeof op !== "object") throw new DbError("not_found", "Invalid key operation");
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
        await session.close().catch(() => {});
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
