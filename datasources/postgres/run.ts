// Statement runners: read queries in a READ ONLY transaction with bounded
// limits, batch exec (optionally engine-enforced read-only), transactional
// migrations and staged row changes. All open per call and close in a finally.
import type { SQL } from "bun";
import { open } from "./connect.ts";
import { controlledPg } from "./cancel.ts";
import { toPgPlaceholders } from "./placeholders.ts";
import { assertReadOnlyScript, assertReadOnlySql, boundReadSql, sqlTokens } from "../../shared/sqlSafety.ts";
import { validateMigrationSql } from "../../shared/migrationSafety.ts";
import { compileRowChanges, toPostgresMutationSql } from "../../shared/rowMutations.ts";
import { encodeDbValue } from "../../shared/binaryValues.ts";
import { DbError } from "../../shared/types.ts";
import type { QueryResult, ExecResult, RowChange, RowMutationResult, ConnectionTestResult, MigrationResult } from "../../shared/types.ts";

const DEFAULT_LIMIT = 1000;
const HARD_LIMIT = 10000;

// Each runner owns and closes its connection. Session-level configuration also
// survives explicit COMMIT/ROLLBACK inside scripts; it never reaches another request.
export async function applyPgSchema(connection: Pick<Awaited<ReturnType<SQL['reserve']>>, 'unsafe'>, schema?: string) {
  if (schema === undefined) return; // Preserve the server default for legacy documents.
  if (typeof schema !== 'string' || !schema || schema.includes('\0') || new TextEncoder().encode(schema).length > 63) {
    throw new DbError('sql', 'Invalid schema name');
  }
  const rows = await connection.unsafe(`SELECT nspname FROM pg_catalog.pg_namespace
    WHERE nspname = $1 AND pg_catalog.has_schema_privilege(oid, 'USAGE')`, [schema]);
  if (!rows.length) throw new DbError('sql', `Schema "${schema}" does not exist or is not accessible. Select another schema.`);
  // pg_catalog remains implicitly first. pg_temp is explicitly last so temporary
  // relations cannot shadow the selected schema. No fallback to public/$user.
  const path = `"${schema.replace(/"/g, '""')}", pg_temp`;
  await connection.unsafe("SELECT pg_catalog.set_config('search_path', $1, false)", [path]);
}

function affectedOf(rows: unknown[]): number {
  const n = (rows as unknown as { count?: number }).count;
  return typeof n === "number" ? n : 0;
}

export async function runPgQuery(
  url: string,
  sql: string,
  params: unknown[],
  limitRaw?: number,
  offsetRaw?: number,
  signal?: AbortSignal,
  timeoutRaw?: number,
  exportAll = false,
  schema?: string,
): Promise<QueryResult> {
  const limit = exportAll ? 100_000 : Math.min(Math.max(Math.floor(limitRaw ?? DEFAULT_LIMIT), 1), HARD_LIMIT);
  const offset = exportAll ? 0 : Math.max(Math.floor(offsetRaw ?? 0), 0);
  const timeoutMs = Math.min(Math.max(Math.floor(timeoutRaw ?? 30_000), 1_000), 300_000);
  const boundedSql = boundReadSql(sql, limit, offset);
  const db = await open(url);
  // A failed reservation must not leak the freshly opened client.
  const connection = await db.reserve().catch(async (error) => { await db.close().catch(() => {}); throw error; });
  let inTransaction = false;
  try {
    await applyPgSchema(connection, schema);
    await connection.unsafe("BEGIN READ ONLY");
    inTransaction = true;
    await connection.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    const t0 = performance.now();
    let rows: unknown[][];
    const explain = sqlTokens(boundedSql)[0] === "EXPLAIN";
    // Bun values() preserves native values but exposes no column names. Carry
    // labels alongside positional values; json_object_keys retains duplicate keys.
    // The bare composite identifier would collide with a user column of the
    // same name (Postgres resolves the column first) — pick an unguessable
    // alias per query.
    const shape = `__tern_shape_${crypto.randomUUID().replaceAll("-", "")}`;
    const positionalSql = explain ? boundedSql : `SELECT ARRAY(SELECT json_object_keys(row_to_json((SELECT "${shape}" FROM (SELECT "__tern_result".*) AS "${shape}")))), "__tern_result".* FROM (VALUES (1)) AS "__tern_seed" LEFT JOIN LATERAL (SELECT TRUE AS "__tern_present", "__tern_rows".* FROM (${boundedSql}) AS "__tern_rows") AS "__tern_result" ON TRUE`;
    try {
      if (sqlTokens(boundedSql)[0] === "SHOW") {
        const result = await controlledPg(url, connection, () => connection.unsafe(boundedSql, params), signal, timeoutMs) as Record<string, unknown>[];
        return {
          columns: Object.keys(result[0] ?? {}),
          rows: result.slice(offset, offset + limit),
          ms: Math.round((performance.now() - t0) * 10) / 10,
          hasMore: result.length > offset + limit, offset,
        };
      }
      rows = await controlledPg(url, connection, () => connection.unsafe(toPgPlaceholders(positionalSql, params.length), params).values(), signal, timeoutMs) as unknown[][];
    } catch (e) {
      if (e instanceof DbError) throw e;
      throw new DbError("sql", e instanceof Error ? e.message : String(e));
    }
    const labels = explain ? ['QUERY PLAN'] : ((rows[0]?.[0] ?? []) as string[]).slice(1);
    if (!explain) rows = rows.filter(row => row[1] === true);
    const used = new Set(labels);
    const seen = new Set<string>();
    const columns = labels.map(label => {
      let key = label;
      for (let suffix = 2; seen.has(key); suffix++) {
        key = `${label} (${suffix})`;
        if (used.has(key)) { seen.add(key); continue; }
      }
      seen.add(key);
      return key;
    });
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    const wireRows = rows.slice(0, limit).map(row => Object.fromEntries(columns.map((column, i) => [column, encodeDbValue(row[i + (explain ? 0 : 2)])])));
    return { columns, rows: wireRows, ms, hasMore: rows.length > limit, offset };
  } finally {
    if (inTransaction) await connection.unsafe("ROLLBACK").catch(() => {});
    connection.release();
    await db.close().catch(() => {});
  }
}

export async function explainPgQuery(
  url: string,
  sql: string,
  params: unknown[],
  signal?: AbortSignal,
  timeoutRaw?: number,
  schema?: string,
): Promise<QueryResult> {
  const normalized = assertReadOnlySql(sql);
  const timeoutMs = Math.min(Math.max(Math.floor(timeoutRaw ?? 30_000), 1_000), 300_000);
  const db = await open(url);
  // A failed reservation must not leak the freshly opened client.
  const connection = await db.reserve().catch(async (error) => { await db.close().catch(() => {}); throw error; });
  let inTransaction = false;
  try {
    await applyPgSchema(connection, schema);
    await connection.unsafe("BEGIN READ ONLY");
    inTransaction = true;
    await connection.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    const t0 = performance.now();
    const result = await controlledPg(url, connection,
      () => connection.unsafe(`EXPLAIN (FORMAT JSON, ANALYZE FALSE, COSTS TRUE) ${toPgPlaceholders(normalized, params.length)}`, params),
      signal,
      timeoutMs,
    ) as Record<string, unknown>[];
    const rows = result.map((row) => ({ plan: JSON.stringify(row["QUERY PLAN"] ?? row, null, 2) }));
    return { columns: ["plan"], rows, ms: Math.round((performance.now() - t0) * 10) / 10, hasMore: false, offset: 0 };
  } catch (error) {
    if (error instanceof DbError) throw error;
    throw new DbError("sql", error instanceof Error ? error.message : String(error));
  } finally {
    if (inTransaction) await connection.unsafe("ROLLBACK").catch(() => {});
    connection.release();
    await db.close().catch(() => {});
  }
}

export async function runPgExec(url: string, sql: string, signal?: AbortSignal, timeoutRaw = 30_000, readOnly = false, schema?: string): Promise<ExecResult> {
  if (readOnly) assertReadOnlyScript(sql);
  const timeoutMs = Math.min(Math.max(Math.floor(timeoutRaw ?? 30_000), 1_000), 300_000);
  const db = await open(url);
  // A failed reservation must not leak the freshly opened client.
  const connection = await db.reserve().catch(async (error) => { await db.close().catch(() => {}); throw error; });
  try {
    await applyPgSchema(connection, schema);
    if (readOnly) await connection.unsafe("SET default_transaction_read_only = on");
    // Server-side backstop — a failed cancel-control connection must not
    // leave the exec running on the pooled socket indefinitely.
    await connection.unsafe(`SET statement_timeout = ${timeoutMs}`);
    const t0 = performance.now();
    let rowsAffected = 0;
    let result: QueryResult | undefined;
    try {
      const rows = await controlledPg(url, connection, () => connection.unsafe(sql).values(), signal, timeoutMs) as unknown[][];
      rowsAffected = affectedOf(rows);
      // Bun SQL exposes no row cursor — statement_timeout bounds duration and
      // this cap bounds what we encode and serialize (the driver buffer is
      // transient). Same convention as runPgQuery: fetch cap + hasMore.
      const truncated = rows.length > HARD_LIMIT;
      const shown = truncated ? rows.slice(0, HARD_LIMIT) : rows;
      if (shown.length > 0 || sqlTokens(sql)[0] === "EXPLAIN") {
        // Bun values() retains duplicate labels' values but exposes no column metadata.
        const columns = sqlTokens(sql)[0] === "EXPLAIN" ? ["QUERY PLAN"] : (shown[0] ?? []).map((_, index) => `Column ${index + 1}`);
        result = { columns, rows: shown.map(row => Object.fromEntries(columns.map((column, index) => [column, encodeDbValue(row[index])]))), ms: 0, hasMore: truncated, offset: 0 };
      }
    } catch (e) {
      if (e instanceof DbError) throw e;
      throw new DbError("sql", e instanceof Error ? e.message : String(e));
    }
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    if (result) result.ms = ms;
    return { rowsAffected, ms, ...(result ? { result } : {}) };
  } finally {
    connection.release();
    await db.close().catch(() => {});
  }
}

export async function runPgMigration(url: string, sql: string, apply: boolean, timeoutRaw?: number, signal?: AbortSignal, schema?: string): Promise<MigrationResult> {
  const script = validateMigrationSql(sql);
  const timeoutMs = Math.min(Math.max(Math.floor(timeoutRaw ?? 30_000), 1_000), 300_000);
  const db = await open(url);
  // A failed reservation must not leak the freshly opened client.
  const connection = await db.reserve().catch(async (error) => { await db.close().catch(() => {}); throw error; });
  const t0 = performance.now();
  let transaction = false;
  try {
    await applyPgSchema(connection, schema);
    await connection.unsafe("BEGIN");
    transaction = true;
    await connection.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await controlledPg(url, connection, () => connection.unsafe(script), signal, timeoutMs);
    await connection.unsafe(apply ? "COMMIT" : "ROLLBACK");
    transaction = false;
    return { validated: true, applied: apply, ms: Math.round((performance.now() - t0) * 10) / 10 };
  } catch (error) {
    if (error instanceof DbError) throw error;
    throw new DbError("sql", error instanceof Error ? error.message : String(error));
  } finally {
    if (transaction) await connection.unsafe("ROLLBACK").catch(() => {});
    connection.release();
    await db.close().catch(() => {});
  }
}

export async function testPgConnection(url: string, signal?: AbortSignal): Promise<ConnectionTestResult> {
  const db = await open(url);
  // A failed reservation must not leak the freshly opened client.
  const connection = await db.reserve().catch(async (error) => { await db.close().catch(() => {}); throw error; });
  const t0 = performance.now();
  try {
    const rows = await controlledPg(url, connection, () => connection.unsafe(
      `SELECT current_database() AS database, current_user AS "user",
              current_setting('server_version') AS server_version`,
    ), signal, 10_000) as Record<string, unknown>[];
    const row = rows[0] ?? {};
    return {
      database: String(row.database ?? ""),
      user: String(row.user ?? ""),
      serverVersion: String(row.server_version ?? ""),
      ms: Math.round((performance.now() - t0) * 10) / 10,
    };
  } catch (error) {
    if (error instanceof DbError) throw error;
    throw new DbError("not_a_database", error instanceof Error ? error.message : String(error));
  } finally {
    connection.release();
    await db.close().catch(() => {});
  }
}

export async function runPgRowChanges(
  url: string,
  changes: RowChange[],
  signal?: AbortSignal,
  timeoutRaw = 30_000,
): Promise<RowMutationResult> {
  const timeoutMs = Math.min(Math.max(Math.floor(timeoutRaw ?? 30_000), 1_000), 300_000);
  const statements = compileRowChanges(changes);
  const db = await open(url);
  // A failed reservation must not leak the freshly opened client.
  const connection = await db.reserve().catch(async (error) => { await db.close().catch(() => {}); throw error; });
  const t0 = performance.now();
  let inTransaction = false;
  try {
    await connection.unsafe("BEGIN");
    inTransaction = true;
    await connection.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    let rowsAffected = 0;
    for (const statement of statements) {
      let rows: unknown[];
      try {
        rows = await controlledPg(url, connection,
          () => connection.unsafe(toPostgresMutationSql(statement.sql), statement.params),
          signal,
          timeoutMs,
        ) as unknown[];
      } catch (error) {
        if (error instanceof DbError) throw error;
        throw new DbError("sql", error instanceof Error ? error.message : String(error));
      }
      const affected = affectedOf(rows);
      if (affected !== 1) {
        throw new DbError("conflict", `${statement.kind} expected one row but matched ${affected}`);
      }
      rowsAffected += affected;
    }
    await connection.unsafe("COMMIT");
    inTransaction = false;
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    return { applied: statements.length, rowsAffected, ms };
  } finally {
    if (inTransaction) await connection.unsafe("ROLLBACK").catch(() => {});
    connection.release();
    await db.close().catch(() => {});
  }
}
