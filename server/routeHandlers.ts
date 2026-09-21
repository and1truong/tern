import type { Connections } from "./connections.ts";
import { createDatabase } from "../datasources/sqlite/engine.ts";
import { dbErrorResponse } from "../shared/httpError.ts";

// App-level handlers: file creation and connection-profile CRUD. All data
// endpoints route through datasources/router.ts.
export function makeHandlers(conns: Connections, hooks?: {
  onConnectionDeleted?: (id: string) => Promise<void>;   // lets the datasource layer drop cached sessions
  onConnectionSaved?: (id: string) => Promise<void>;     // an overwrite must not keep sessions on stale credentials
}) {
  const environments = new Set(["local", "development", "staging", "production"]);

  // Strip the password from a connection url for display, keeping host/db
  // visible. Fail closed: an unparseable stored url is credential-suspect and
  // must not reach the client verbatim.
  const redactUrl = (url: string): string => {
    try {
      const u = new URL(url);
      if (u.password) u.password = "***";
      return u.toString();
    } catch { return "(invalid url)"; }
  };

  return {
    async create(req: Request): Promise<Response> {
      let b: { path?: string };
      try { b = await req.json() as typeof b; } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
      try { return Response.json(createDatabase(b.path ?? "")); }
      catch (error) { return dbErrorResponse(error); }
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
      try {
        const saved = await conns.save(b.driver ?? "postgres", label, url, { environment, readOnly: b.readOnly !== false });
        conns.touch(saved.id);
        await hooks?.onConnectionSaved?.(saved.id);
        return Response.json({ ...saved, url: redactUrl(saved.url) });
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
