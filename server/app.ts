import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { makeConnections, type SecretStore } from "./connections.ts";
import { makeHandlers } from "./routeHandlers.ts";
import { recentFiles, sqlitePath } from "./appDatabase.ts";
import { readSchema } from "../datasources/sqlite/engine.ts";
import { createDriverRegistry } from "../datasources/registry.ts";
import { GET_ROUTES, makeDatasourceRouter, SOURCELESS_ROUTES } from "../datasources/router.ts";
import { makeRedisDriver } from "../datasources/redis/driver.ts";
import { makePostgresDriver } from "../datasources/postgres/driver.ts";
import { makeSqliteDriver } from "../datasources/sqlite/driver.ts";
import type { DataSourceDriver } from "../datasources/contracts.ts";

export function makeApp(db: Database, options: { secrets?: SecretStore; appPath?: string; drivers?: DataSourceDriver[] } = {}) {
  const appFile = options.appPath ? statSync(options.appPath, { bigint: true }) : null;
  const registry = createDriverRegistry();
  for (const driver of options.drivers ?? [makeRedisDriver(), makePostgresDriver(), makeSqliteDriver()]) registry.register(driver);
  const connections = makeConnections(db, options.secrets, Object.fromEntries(registry.list().map(d => [d.id, d.validateUrl])));
  const writable = new Set<string>();
  const opened = new Set<string>();
  const validated = new Map<string, unknown>();
  const datasource = makeDatasourceRouter(connections, registry);

  const fail = (error: string, status = 400) => Response.json({ error }, { status });
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    // Loopback binding plus Host/Origin validation prevents remote sites and DNS rebinding.
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return fail("Invalid host", 403);
    const origin = req.headers.get("origin");
    if ((origin && origin !== url.origin) || req.headers.get("sec-fetch-site") === "cross-site") return fail("Cross-origin request denied", 403);
    if (req.method === "POST" && req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return fail("JSON required", 415);
    const session = req.headers.get("x-tern-session") ?? "api";
    if (session.length > 100) return fail("Invalid session");
    const h = makeHandlers(connections, {
      // Deleting a profile must also drop its cached driver sessions and any
      // writable/validated flags keyed on it.
      onConnectionDeleted: async (id) => {
        for (const key of [...writable]) if (key.includes(`:${id}/`)) writable.delete(key);
        for (const key of [...validated.keys()]) if (key.includes(`:${id}/`)) validated.delete(key);
        await datasource.invalidate(id);
      },
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
          if (typeof key !== "string" || key.length > 200 || !/^(documents|layout|preferences|sql:|redis:)/.test(key)) return fail("Invalid state key");
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
      const body: Record<string, unknown> = req.method === "POST" ? await req.clone().json() : Object.fromEntries(url.searchParams);
      // A request targets either a saved connection profile (`connId`) or an
      // opened SQLite file (`path`). The resolved key feeds the writable set,
      // the migration dry-run map, and the datasource session cache.
      let key = "";
      if (body.connId) {
        if (typeof body.connId !== "string" || body.connId.length > 128) return fail("A valid connection is required");
        if (!await connections.get(body.connId)) return fail("Unknown connection", 404);
        if (body.database !== undefined && String(body.database).length > 64) return fail("Invalid database");
        key = `${body.connId}/${body.database ?? ""}`;
        connections.touch(body.connId);
      } else if (body.path) {
        key = sqlitePath(body.path);
        if (!opened.has(key)) return fail("Open this SQLite file before querying it", 403);
        body.path = key;
      }
      for (const field of ['timeoutMs', 'limit', 'offset']) {
        if (body[field] !== undefined && (typeof body[field] !== 'number' || !Number.isFinite(body[field]) || body[field] < 0)) return fail(`Invalid ${field}`);
      }
      if (body.timeoutMs !== undefined) body.timeoutMs = Math.max(1000, Math.min(300000, Number(body.timeoutMs)));
      if (body.sql !== undefined && (typeof body.sql !== 'string' || body.sql.length > 1_000_000)) return fail('Invalid SQL');
      if (body.params !== undefined && !Array.isArray(body.params)) return fail('Invalid parameters');
      const accessKey = `${session}:${key}`;
      if (path === "/access" && req.method === "POST") {
        if (!key) return fail("A connection is required");
        if (body.writable === true) writable.add(accessKey); else writable.delete(accessKey);
        return Response.json({ writable: writable.has(accessKey) });
      }
      // All data endpoints dispatch through the datasource router; the app
      // keeps only the session policy (writable flag, opened files, and the
      // migration dry-run-before-apply contract).
      if (path.startsWith("/datasource")) {
        const sub = path.slice("/datasource".length) || "/";
        if (req.method !== "POST" && !GET_ROUTES.has(sub)) return fail("Not found", 404);
        if (!SOURCELESS_ROUTES.has(sub) && !key) return fail("A connection is required");
        if (sub === "/migration/preview") {
          if (body.connId !== undefined && !writable.has(accessKey)) return fail("Connection is read-only", 403);
          validated.delete(accessKey);
        } else if (sub === "/migration/apply") {
          if (!writable.has(accessKey)) return fail("Connection is read-only", 403);
          if (validated.get(accessKey) !== body.sql) return fail("Run a successful dry run of this exact script before applying");
          validated.delete(accessKey);
        }
        const result = await datasource.route({
          path: sub, body, url, signal: req.signal,
          writable: connKey => writable.has(`${session}:${connKey}`),
        });
        if (sub === "/migration/preview" && result.ok) validated.set(accessKey, body.sql);
        return result;
      }
      return fail("Not found", 404);
    } catch { return fail("Request failed. Check the connection settings, file path and credential store."); }
  };
}
