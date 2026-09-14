import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { makeConnections, type SecretStore } from "./connections.ts";
import { makeHandlers } from "./routeHandlers.ts";
import { recentFiles, sqlitePath } from "./appDatabase.ts";
import { readSchema } from "./dbServer.ts";
import { createDriverRegistry } from "../datasources/registry.ts";
import { makeDatasourceRouter } from "../datasources/router.ts";
import { makeRedisDriver } from "../datasources/redis/driver.ts";
import type { DataSourceDriver } from "../datasources/contracts.ts";

export function makeApp(db: Database, options: { secrets?: SecretStore; appPath?: string; drivers?: DataSourceDriver[] } = {}) {
  const appFile = options.appPath ? statSync(options.appPath, { bigint: true }) : null;
  const connections = makeConnections(db, options.secrets);
  const writable = new Set<string>();
  const opened = new Set<string>();
  const validated = new Map<string, string>();
  const registry = createDriverRegistry();
  for (const driver of options.drivers ?? [makeRedisDriver()]) registry.register(driver);
  const datasource = makeDatasourceRouter(connections, registry);

  const fail = (error: string, status = 400) => Response.json({ error }, { status });
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    // Loopback binding plus Host/Origin validation prevents remote sites and DNS rebinding.
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return fail("Invalid host", 403);
    const origin = req.headers.get("origin");
    if ((origin && origin !== url.origin) || req.headers.get("sec-fetch-site") === "cross-site") return fail("Cross-origin request denied", 403);
    if (req.method === "POST" && req.headers.get("content-type")?.split(";")[0] !== "application/json") return fail("JSON required", 415);
    const session = req.headers.get("x-tern-session") ?? "api";
    if (session.length > 100) return fail("Invalid session");
    const h = makeHandlers(connections, (id, database) => writable.has(`${session}:${id}/${database ?? ""}`), {
      // Deleting a profile must also drop its cached driver sessions.
      onConnectionDeleted: (id) => datasource.invalidate(id),
    });
    try {
      const path = url.pathname.replace(/^\/api/, "");
      if (path === "/state") {
        if (req.method === "GET") {
          const row = db.query<{ value: string }, [string]>("SELECT value FROM app_state WHERE key = ?").get(url.searchParams.get("key") ?? "");
          return Response.json(row ? JSON.parse(row.value) : null);
        }
        if (req.method === "DELETE") {
          const key = url.searchParams.get("key");
          if (!key || !/^(sql:|redis:)/.test(key) || key.length > 200) return fail("Invalid state key");
          db.query("DELETE FROM app_state WHERE key = ?").run(key);
          return Response.json({ ok: true });
        }
        if (req.method === "POST") {
          const { key, value } = await req.json();
          if (typeof key !== "string" || key.length > 200 || !/^(documents|sql:|redis:|layout|preferences)/.test(key)) return fail("Invalid state key");
          const json = JSON.stringify(value);
          if (!json || json.length > 2_000_000) return fail("State exceeds size limit");
          db.query("INSERT INTO app_state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, json);
          return Response.json({ ok: true });
        }
      }
      if (path === "/recent" && req.method === "GET") return Response.json({ databases: recentFiles(db) });
      if (path === "/recent" && req.method === "DELETE") {
        db.query("DELETE FROM recent_files WHERE path = ?").run(url.searchParams.get("path") ?? "");
        return Response.json({ ok: true });
      }
      if (path === "/open" && req.method === "POST") {
        const path = sqlitePath((await req.json()).path);
        if (appFile) {
          const file = statSync(path, { bigint: true });
          if (file.dev === appFile.dev && file.ino === appFile.ino) return fail("The application database cannot be opened as a user connection");
        }
        readSchema(path);
        opened.add(path);
        db.query("INSERT INTO recent_files VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET opened_at = excluded.opened_at").run(path, Date.now());
        return Response.json({ path });
      }
      if (path === "/create" && req.method === "POST") return h.create(req);
      if (path === "/connections") {
        if (req.method === "GET") return h.connectionsList();
        if (req.method === "POST") return await h.connectionSave(req);
        if (req.method === "DELETE") {  return await h.connectionDelete(url); }
      }
      if (path === "/connections/test" && req.method === "POST") return h.connectionTest(req);
      const body = req.method === "POST" ? await req.clone().json() : Object.fromEntries(url.searchParams);
      if (path.startsWith("/datasource")) {
        const sub = path.slice("/datasource".length) || "/";
        if (sub !== "/test") {
          if (!body.connId) return fail("A connection is required");
          if (!await connections.get(body.connId)) return fail("Unknown connection", 404);
          connections.touch(body.connId);
        }
        return datasource.route({
          path: sub, body, url,
          writable: (connKey) => writable.has(`${session}:${connKey}`),
        });
      }
      let key: string;
      if (body.connId) {
        if (!await connections.get(body.connId)) return fail("Unknown connection", 404);
        if (body.database !== undefined && (typeof body.database !== "string" || body.database.length > 256)) return fail("Invalid database name");
        key = `${body.connId}/${body.database ?? ""}`;
        connections.touch(body.connId);
      } else if (body.path) {
        key = sqlitePath(body.path);
        if (!opened.has(key)) return fail("Open this SQLite file before querying it", 403);
        body.path = key;
        url.searchParams.set("path", key);
      } else if (path !== "/rows/preview") return fail("A connection is required");
      else key = "";
      for (const field of ['timeoutMs', 'limit', 'offset']) {
        if (body[field] !== undefined && (typeof body[field] !== 'number' || !Number.isFinite(body[field]) || body[field] < 0)) return fail(`Invalid ${field}`);
      }
      if (body.timeoutMs !== undefined) body.timeoutMs = Math.max(1000, Math.min(300000, body.timeoutMs));
      if (body.sql !== undefined && (typeof body.sql !== 'string' || body.sql.length > 1_000_000)) return fail('Invalid SQL');
      if (body.params !== undefined && !Array.isArray(body.params)) return fail('Invalid parameters');
      const accessKey = `${session}:${key}`;
      if (path === "/access" && req.method === "POST") {
        if (body.writable === true) writable.add(accessKey); else writable.delete(accessKey);
        return Response.json({ writable: writable.has(accessKey) });
      }
      if (req.method === "GET") {
        if (path === "/databases" && body.connId) return h.databases(url);
        if (path === "/schema") return h.schema(url);
        if (path === "/insights") return h.insights(url, req.signal);
      }
      if (req.method !== "POST") return fail("Not found", 404);
      // /exec with allowWrite !== true is the read-only batch path: the runner
      // validates the script and enforces read-only execution in the engine.
      if ((["/rows/apply", "/migration/apply"].includes(path) || (path === "/migration/preview" && body.connId) || (path === "/exec" && body.allowWrite === true)) && !writable.has(accessKey)) return fail("Connection is read-only", 403);
      const forwarded = new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(body), signal: req.signal });
      if (path === "/migration/preview") {
        validated.delete(accessKey);
        const result = await h.migration(forwarded, false);
        if (result.ok) validated.set(accessKey, body.sql);
        return result;
      }
      if (path === "/migration/apply") {
        if (validated.get(accessKey) !== body.sql) return fail("Run a successful dry run of this exact script before applying");
        validated.delete(accessKey);
        return h.migration(forwarded, true);
      }
      switch (path) {
        case "/query": return h.query(forwarded);
        case "/explain": return h.explain(forwarded);
        case "/exec": return h.exec(forwarded);
        case "/rows/preview": return h.rowPreview(forwarded);
        case "/rows/apply": return h.rowApply(forwarded);
        default: return fail("Not found", 404);
      }
    } catch { return fail("Request failed. Check the connection settings, file path and credential store."); }
  };
}
