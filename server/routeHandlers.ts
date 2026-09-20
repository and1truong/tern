import { sqliteTask } from "./sqliteTask.ts";
import { validateConnectionUrl, type Connections } from "./connections.ts";
import { createDatabase, readSchema } from "./dbServer.ts";
import { explainPgQuery, readPgInsights, readPgSchema, runPgMigration, runPgQuery, runPgExec, runPgRowChanges, testPgConnection } from "./pgServer.ts";
import { compileRowChanges } from "../shared/rowMutations.ts";
import type { RowChange } from "../shared/types.ts";
import { DbError } from "../shared/types.ts";

const safeMessage = (message: string) => message.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[PostgreSQL connection]");

// Shared with the datasource router so driver errors map to the same statuses.
export const dbErrorResponse = (e: unknown): Response => {
  if (e instanceof DbError) {
    const status = e.code === "not_found" ? 404
      : e.code === "timeout" || e.code === "cancelled" ? 408
      : e.code === "conflict" ? 409
      : 400;
    return Response.json({ error: safeMessage(e.message), code: e.code }, { status });
  }
  return Response.json({ error: e instanceof Error ? safeMessage(e.message) : "db error" }, { status: 400 });
};

// A request targets either a SQLite file (`path`) or a saved Postgres
// connection (`connId`). For Postgres the full url — which may carry a password
// — is resolved server-side from pg_connections, so it never rides on a request.
export function makeHandlers(conns: Connections, sessionWritable?: (id: string, database?: string) => boolean, hooks?: {
  onConnectionDeleted?: (id: string) => Promise<void>;   // lets the datasource layer drop cached sessions
}) {
  const environments = new Set(["local", "development", "staging", "production"]);
  const resolvePgUrl = async (connId: string, database?: string): Promise<string> => {
    const url = await conns.resolveUrl(connId);
    if (!url) throw new DbError("not_found", "unknown postgres connection");
    if (!database) return url;
    const selected = new URL(url); selected.pathname = `/${encodeURIComponent(database)}`; return selected.toString();
  };
  const assertPgWritable = async (connId: string, database?: string) => {
    const connection = await conns.get(connId);
    if (!connection) throw new DbError("not_found", "unknown postgres connection");
    if (sessionWritable ? !sessionWritable(connId, database) : connection.readOnly) throw new DbError("not_read_only", `connection "${connection.label}" is read-only`);
  };

  // Strip the password from a connection url for display, keeping host/db visible.
  const redactUrl = (url: string): string => {
    try {
      const u = new URL(url);
      if (u.password) u.password = "***";
      return u.toString();
    } catch { return url; }
  };

  return {
    async create(req: Request): Promise<Response> {
      let b: { path?: string };
      try { b = await req.json() as typeof b; } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
      try { return Response.json(createDatabase(b.path ?? "")); }
      catch (error) { return dbErrorResponse(error); }
    },

    // GET /schema?path=<abs> | ?connId=<id> -> DbSchema
    async schema(url: URL): Promise<Response> {
      const connId = url.searchParams.get("connId");
      try {
        if (connId) return Response.json(await readPgSchema(await resolvePgUrl(connId, url.searchParams.get("database") ?? undefined)));
        return Response.json(readSchema(url.searchParams.get("path") ?? ""));
      } catch (e) { return dbErrorResponse(e); }
    },

    async databases(url: URL): Promise<Response> {
      try {
        const result = await runPgQuery(await resolvePgUrl(url.searchParams.get("connId") ?? ""), "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname", [], 1000);
        return Response.json({ databases: result.rows.map(row => row.datname) });
      } catch (error) { return dbErrorResponse(error); }
    },

    async insights(url: URL, signal?: AbortSignal): Promise<Response> {
      const connId = url.searchParams.get("connId");
      try {
        if (connId) return Response.json(await readPgInsights(await resolvePgUrl(connId, url.searchParams.get("database") ?? undefined)));
        return Response.json(await sqliteTask({ operation: "insights", args: [url.searchParams.get("path") ?? ""] }, signal));
      } catch (error) { return dbErrorResponse(error); }
    },

    // POST /query  body { path? | connId?, sql, params?, limit? }
    async query(req: Request): Promise<Response> {
      let b: { path?: string; connId?: string; database?: string; sql?: string; params?: unknown[]; limit?: number; offset?: number; timeoutMs?: number; exportAll?: boolean };
      try { b = await req.json() as typeof b; } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
      try {
        if (b.connId) return Response.json(await runPgQuery(await resolvePgUrl(b.connId, b.database), b.sql ?? "", b.params ?? [], b.limit, b.offset, req.signal, b.timeoutMs, b.exportAll === true));
        return Response.json(await sqliteTask({ operation: "query", args: [b.path ?? "", b.sql ?? "", b.params ?? [], b.limit, b.offset, b.exportAll === true] }, req.signal, b.timeoutMs));
      } catch (e) { return dbErrorResponse(e); }
    },

    async explain(req: Request): Promise<Response> {
      let b: { path?: string; connId?: string; database?: string; sql?: string; params?: unknown[]; timeoutMs?: number };
      try { b = await req.json() as typeof b; } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
      try {
        if (b.connId) return Response.json(await explainPgQuery(await resolvePgUrl(b.connId, b.database), b.sql ?? "", b.params ?? [], req.signal, b.timeoutMs));
        return Response.json(await sqliteTask({ operation: "explain", args: [b.path ?? "", b.sql ?? "", b.params ?? []] }, req.signal, b.timeoutMs));
      } catch (error) { return dbErrorResponse(error); }
    },

    async migration(req: Request, apply: boolean): Promise<Response> {
      let b: { path?: string; connId?: string; database?: string; sql?: string; allowWrite?: boolean; timeoutMs?: number };
      try { b = await req.json() as typeof b; } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
      try {
        if (apply && b.allowWrite !== true) throw new DbError("not_read_only", "migration apply requires explicit confirmation");
        if (b.connId) {
          if (apply) await assertPgWritable(b.connId, b.database);
          return Response.json(await runPgMigration(await resolvePgUrl(b.connId, b.database), b.sql ?? "", apply, b.timeoutMs));
        }
        return Response.json(await sqliteTask({ operation: "migration", args: [b.path ?? "", b.sql ?? "", apply] }, req.signal, b.timeoutMs));
      } catch (error) { return dbErrorResponse(error); }
    },

    // POST /exec  body { path? | connId?, sql }
    // allowWrite !== true runs the script as a read-only batch without write access.
    async exec(req: Request): Promise<Response> {
      let b: { path?: string; connId?: string; database?: string; sql?: string; allowWrite?: boolean; timeoutMs?: number };
      try { b = await req.json() as typeof b; } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
      try {
        const readOnly = b.allowWrite !== true;
        if (b.connId) {
          if (!readOnly) await assertPgWritable(b.connId, b.database);
          return Response.json(await runPgExec(await resolvePgUrl(b.connId, b.database), b.sql ?? "", req.signal, b.timeoutMs, readOnly));
        }
        return Response.json(await sqliteTask({ operation: "exec", args: [b.path ?? "", b.sql ?? "", readOnly] }, req.signal, b.timeoutMs));
      } catch (e) { return dbErrorResponse(e); }
    },

    async rowPreview(req: Request): Promise<Response> {
      let b: { changes?: RowChange[] };
      try { b = await req.json() as typeof b; } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
      try {
        return Response.json({ statements: compileRowChanges(b.changes ?? []) });
      } catch (e) { return dbErrorResponse(e); }
    },

    async rowApply(req: Request): Promise<Response> {
      let b: { path?: string; connId?: string; database?: string; changes?: RowChange[]; allowWrite?: boolean; timeoutMs?: number };
      try { b = await req.json() as typeof b; } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
      try {
        if (b.allowWrite !== true) throw new DbError("not_read_only", "row changes require explicit confirmation");
        const changes = b.changes ?? [];
        if (b.connId) {
          await assertPgWritable(b.connId, b.database);
          return Response.json(await runPgRowChanges(await resolvePgUrl(b.connId, b.database), changes, req.signal, b.timeoutMs));
        }
        return Response.json(await sqliteTask({ operation: "rows", args: [b.path ?? "", changes] }, req.signal, b.timeoutMs));
      } catch (e) { return dbErrorResponse(e); }
    },

    // GET /connections -> { connections: ConnectionProfile[] } (passwords redacted)
    async connectionsList(): Promise<Response> {
      const connections = (await conns.list()).map((c) => ({ ...c, url: redactUrl(c.url) }));
      return Response.json({ connections });
    },

    // POST /connections  body { driver?, label, url } -> ConnectionProfile (redacted)
    async connectionSave(req: Request): Promise<Response> {
      let b: { driver?: string; label?: string; url?: string; environment?: string; readOnly?: boolean };
      try { b = await req.json() as typeof b; } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
      const url = (b.url ?? "").trim();
      const label = (b.label ?? "").trim() || redactUrl(url);
      if (!url) return Response.json({ error: "url is required" }, { status: 400 });
      const environment = environments.has(b.environment ?? "")
        ? b.environment as "local" | "development" | "staging" | "production"
        : "development";
      const saved = await conns.save(b.driver ?? "postgres", label, url, { environment, readOnly: b.readOnly !== false });
      conns.touch(saved.id);
      return Response.json({ ...saved, url: redactUrl(saved.url) });
    },

    async connectionTest(req: Request): Promise<Response> {
      let b: { url?: string; connId?: string; database?: string };
      try { b = await req.json() as typeof b; } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
      try {
        const url = b.connId ? await resolvePgUrl(b.connId, b.database) : (b.url ?? "").trim();
        if (!url) throw new DbError("not_found", "connection url is required");
        validateConnectionUrl(url);
        return Response.json(await testPgConnection(url, req.signal));
      } catch (e) { return dbErrorResponse(e); }
    },

    // DELETE /connections?id=<id> -> { ok }
    async connectionDelete(url: URL): Promise<Response> {
      const id = url.searchParams.get("id") ?? "";
      const ok = await conns.delete(id);
      if (ok) await hooks?.onConnectionDeleted?.(id);
      return Response.json({ ok });
    },
  };
}
