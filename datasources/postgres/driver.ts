// PostgreSQL datasource driver. The engine opens a connection per call, so a
// session is a resolved-config handle: connect() probes once for session info,
// and every provider method opens/closes its own connection.
import type { ConnectionConfig, DataSourceDriver, RelationalProvider } from "../contracts.ts";
import { validatePgUrl } from "./connection.ts";
import { readPgSchema } from "./schema.ts";
import { readPgInsights } from "./insights.ts";
import { explainPgQuery, runPgExec, runPgMigration, runPgQuery, runPgRowChanges, testPgConnection } from "./run.ts";

// Database selection on a shared profile rewrites the URL path — the credential-
// bearing url never rides on a request (mirrors the old resolvePgUrl).
function databaseUrl(url: string, database?: string): string {
  if (!database) return url;
  const selected = new URL(url);
  selected.pathname = `/${encodeURIComponent(database)}`;
  return selected.toString();
}

export function makePostgresDriver(): DataSourceDriver {
  return {
    id: "postgres",
    displayName: "PostgreSQL",
    kind: "relational",
    validateUrl: validatePgUrl,
    async test(config: ConnectionConfig) {
      const t = await testPgConnection(databaseUrl(config.url, config.database));
      return { version: t.serverVersion, summary: { database: t.database, user: t.user, "ping ms": t.ms } };
    },
    async connect(config: ConnectionConfig) {
      const url = databaseUrl(config.url, config.database);
      const probed = await testPgConnection(url);
      const relational: RelationalProvider = {
        async databases() {
          const result = await runPgQuery(url, "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname", [], 1000);
          return result.rows.map(row => String(row.datname));
        },
        schema: (signal) => readPgSchema(url, signal),
        insights: (signal) => readPgInsights(url, signal),
        query: (q, signal) => runPgQuery(url, q.sql, q.params ?? [], q.limit, q.offset, signal, q.timeoutMs, q.exportAll === true),
        explain: (q, signal) => explainPgQuery(url, q.sql, q.params ?? [], signal, q.timeoutMs),
        exec: (sql, writable, signal, timeoutMs) => runPgExec(url, sql, signal, timeoutMs, !writable),
        migrate: (sql, apply, signal, timeoutMs) => runPgMigration(url, sql, apply, timeoutMs, signal),
        applyRows: (changes, signal, timeoutMs) => runPgRowChanges(url, changes, signal, timeoutMs),
      };
      return {
        info: { version: probed.serverVersion, summary: { database: probed.database, user: probed.user } },
        relational,
        stateless: true,
        async close() {},
      };
    },
  };
}
