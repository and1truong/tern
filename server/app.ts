import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
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

// Writable/validated keys are `${session}:${connId}/${database}` — the
// connId is the segment between the last ':' before the first '/' and that
// '/', so a session or database containing ':id/' cannot spoof a match.
function keyIsForConn(key: string, connId: string): boolean {
  const head = key.split("/")[0];
  return head.slice(head.lastIndexOf(":") + 1) === connId;
}

// Anchored on both ends — `documents_evil` must not satisfy the prefix check.
const validStateKey = (key: string) => /^(documents|layout|preferences|schemaPreferences|sql:\S+|redis:\S+)$/.test(key);

export function makeApp(db: Database, options: { secrets?: SecretStore; appPath?: string; drivers?: DataSourceDriver[] } = {}) {
  // Fail closed: without appPath the guard would silently drop, letting
  // /open accept the app database itself as a user sqlite source.
  const appPath = options.appPath ?? (db.filename !== ":memory:" ? db.filename : undefined);
  const appFile = appPath ? statSync(appPath, { bigint: true }) : null;
  const registry = createDriverRegistry();
  for (const driver of options.drivers ?? [makeRedisDriver(), makePostgresDriver(), makeSqliteDriver()]) registry.register(driver);
  // Connection profiles are credential-backed (postgres, redis, …). SQLite
  // files are never profiles: they go through the /open gate with realpath
  // normalization and the app-database self-open guard — a saved "sqlite"
  // profile would bypass all three.
  const connections = makeConnections(db, options.secrets, Object.fromEntries(registry.list().filter(d => d.id !== "sqlite").map(d => [d.id, d.validateUrl])));
  const writable = new Set<string>();
  const opened = new Set<string>();
  // Hashes, not scripts — a 1 MB script per never-applied preview would grow
  // the map unboundedly; the digest preserves exact-match semantics.
  const validated = new Map<string, string>();
  const scriptHash = (sql: string) => createHash("sha256").update(sql).digest("hex");
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
    // '/' in the session would let it forge writable/validated keys of the
    // `${session}:${connId}/${db}` shape that keyIsForConn parses.
    if (!/^[\w.:-]{1,100}$/.test(session)) return fail("Invalid session");
    const h = makeHandlers(connections, {
      // Deleting or overwriting a profile must also drop its cached driver
      // sessions and any writable/validated flags keyed on it — an upserted
      // row may carry different credentials than the cached session holds.
      onConnectionDeleted: async (id) => {
        for (const key of [...writable]) if (keyIsForConn(key, id)) writable.delete(key);
        for (const key of [...validated.keys()]) if (keyIsForConn(key, id)) validated.delete(key);
        await datasource.invalidate(id);
      },
      onConnectionSaved: async (id) => {
        for (const key of [...writable]) if (keyIsForConn(key, id)) writable.delete(key);
        for (const key of [...validated.keys()]) if (keyIsForConn(key, id)) validated.delete(key);
        await datasource.invalidate(id);
      },
    });
    try {
      const path = url.pathname.replace(/^\/api/, "");
      if (path === "/state") {
        if (req.method === "GET") {
          const key = url.searchParams.get("key") ?? "";
          if (!validStateKey(key)) return fail("Invalid state key");
          const row = db.query<{ value: string }, [string]>("SELECT value FROM app_state WHERE key = ?").get(key);
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
          if (typeof key !== "string" || key.length > 200 || !validStateKey(key)) return fail("Invalid state key");
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
        // The dev/ino guard above is check-then-open — a file swapped for an
        // app-db hardlink in the gap would have passed readSchema already.
        if (appFile) {
          const now = statSync(path, { bigint: true });
          if (now.dev === appFile.dev && now.ino === appFile.ino) return fail("The application database cannot be opened as a user connection");
        }
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
        const profile = await connections.get(body.connId);
        if (!profile) return fail("Unknown connection", 404);
        if (body.database !== undefined && (typeof body.database !== "string" || body.database.length > 64)) return fail("Invalid database");
        // Session keys and writable grants must key on the canonical
        // database selector — the rule belongs to the driver (Redis's "0"
        // and "00" are the same db; postgres names pass verbatim).
        if (typeof body.database === "string") {
          body.database = registry.get(profile.driver)?.canonicalizeDatabase?.(body.database) ?? body.database;
        }
        if (body.schema !== undefined && (typeof body.schema !== "string" || !body.schema || body.schema.includes("\0") || new TextEncoder().encode(body.schema).length > 63)) return fail("Invalid schema name");
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
      // The dry-run grant binds the schema too — a preview in one schema must
      // not authorize applying the same script under another search_path.
      const migrationDigest = () => scriptHash(JSON.stringify([body.schema ?? null, body.sql]));
      if (path.startsWith("/datasource")) {
        const sub = path.slice("/datasource".length) || "/";
        if (!["GET", "POST"].includes(req.method) || (req.method !== "POST" && !GET_ROUTES.has(sub))) return fail("Not found", 404);
        if (!SOURCELESS_ROUTES.has(sub) && !key) return fail("A connection is required");
        if (sub === "/migration/preview") {
          if (body.connId !== undefined && !writable.has(accessKey)) return fail("Connection is read-only", 403);
          validated.delete(accessKey);
        } else if (sub === "/migration/apply") {
          if (!writable.has(accessKey)) return fail("Connection is read-only", 403);
          if (typeof body.sql !== "string" || validated.get(accessKey) !== migrationDigest()) return fail("Run a successful dry run of this exact script before applying");
          validated.delete(accessKey);
        }
        const result = await datasource.route({
          path: sub, body, url, signal: req.signal,
          writable: connKey => writable.has(`${session}:${connKey}`),
        });
        if (sub === "/migration/preview" && result.ok && typeof body.sql === "string") validated.set(accessKey, migrationDigest());
        return result;
      }
      return fail("Not found", 404);
    } catch { return fail("Request failed. Check the connection settings, file path and credential store."); }
  };
}
