// Database Insights for PostgreSQL: pg_stat_database metrics plus live
// pg_stat_activity rows for the activity pane.
import { open } from "./connect.ts";
import { awaitControlled, type CancellableQuery } from "./cancel.ts";
import { DbError } from "../../shared/types.ts";
import type { DatabaseInsights } from "../../shared/types.ts";

// pg_database_size walks every relation file — bound it like any other
// request so a huge database or stuck backend cannot hang forever.
const INTROSPECT_TIMEOUT_MS = 60_000;

export async function readPgInsights(url: string, signal?: AbortSignal): Promise<DatabaseInsights> {
  const db = await open(url);
  const connection = await db.reserve();
  const query = (sql: string) => awaitControlled(connection.unsafe(sql) as CancellableQuery<Record<string, unknown>[]>, signal, INTROSPECT_TIMEOUT_MS);
  try {
    await query(`SET statement_timeout = ${INTROSPECT_TIMEOUT_MS}`);
    const stats = await query(
      `SELECT pg_database_size(current_database())::bigint AS database_bytes,
              numbackends AS connections, xact_commit, xact_rollback,
              blks_read, blks_hit, temp_bytes::bigint, deadlocks
         FROM pg_stat_database WHERE datname = current_database()`,
    ) as Record<string, unknown>[];
    const active = await query(
      `SELECT pid::text AS id, COALESCE(usename, '') AS "user", state,
              COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000, 0)::bigint AS duration_ms,
              COALESCE(wait_event_type || ':' || wait_event, '') AS wait,
              LEFT(query, 500) AS query, application_name AS application, COALESCE(xact_start::text, '') AS transaction,
              (SELECT count(*)::int FROM pg_locks l WHERE l.pid = pg_stat_activity.pid) AS locks
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
        ORDER BY query_start NULLS LAST`,
    ) as Record<string, unknown>[];
    const tables = await query(`SELECT schemaname || '.' || relname AS name,
      pg_total_relation_size(relid)::bigint AS bytes, n_live_tup AS live, n_dead_tup AS dead, seq_scan + idx_scan AS scans
      FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 500`);
    const row = stats[0] ?? {};
    const metrics = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? Number(value) : value as string | number]));
    return {
      metrics,
      tables: tables.map(t => ({ name: String(t.name), bytes: Number(t.bytes), live: Number(t.live), dead: Number(t.dead), scans: Number(t.scans ?? 0) })),
      activity: active.map((item) => ({
        id: String(item.id), user: String(item.user ?? ""), state: String(item.state ?? ""),
        application: String(item.application ?? ""), transaction: String(item.transaction ?? ""), locks: Number(item.locks ?? 0),
        durationMs: Number(item.duration_ms ?? 0), wait: String(item.wait ?? ""), query: String(item.query ?? ""),
      })),
    };
  } catch (error) {
    if (error instanceof DbError) throw error;
    throw new DbError("sql", error instanceof Error ? error.message : String(error));
  } finally { connection.release(); await db.close().catch(() => {}); }
}
