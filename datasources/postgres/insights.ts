// Database Insights for PostgreSQL: pg_stat_database metrics plus live
// pg_stat_activity rows for the activity pane.
import { open } from "./connect.ts";
import { DbError } from "../../shared/types.ts";
import type { DatabaseInsights } from "../../shared/types.ts";

export async function readPgInsights(url: string): Promise<DatabaseInsights> {
  const db = await open(url);
  try {
    const stats = await db.unsafe(
      `SELECT pg_database_size(current_database())::bigint AS database_bytes,
              numbackends AS connections, xact_commit, xact_rollback,
              blks_read, blks_hit, temp_bytes::bigint, deadlocks
         FROM pg_stat_database WHERE datname = current_database()`,
    ) as Record<string, unknown>[];
    const active = await db.unsafe(
      `SELECT pid::text AS id, COALESCE(usename, '') AS "user", state,
              COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000, 0)::bigint AS duration_ms,
              COALESCE(wait_event_type || ':' || wait_event, '') AS wait,
              LEFT(query, 500) AS query, application_name AS application, COALESCE(xact_start::text, '') AS transaction,
              (SELECT count(*)::int FROM pg_locks l WHERE l.pid = pg_stat_activity.pid) AS locks
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
        ORDER BY query_start NULLS LAST`,
    ) as Record<string, unknown>[];
    const tables = await db.unsafe(`SELECT schemaname || '.' || relname AS name,
      pg_total_relation_size(relid)::bigint AS bytes, n_live_tup AS live, n_dead_tup AS dead, seq_scan + idx_scan AS scans
      FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 500`) as Record<string, unknown>[];
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
    throw new DbError("sql", error instanceof Error ? error.message : String(error));
  } finally { await db.close().catch(() => {}); }
}
