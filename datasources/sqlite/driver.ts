// SQLite datasource driver. Files are opened by absolute path (never saved as
// credential profiles); each provider call runs the engine in a short-lived
// subprocess so cancellation interrupts native SQL too.
import { isAbsolute } from "node:path";
import type { ConnectionConfig, DataSourceDriver, RelationalProvider } from "../contracts.ts";
import { readSchema } from "./engine.ts";
import { sqliteTask } from "./task.ts";

export function makeSqliteDriver(): DataSourceDriver {
  return {
    id: "sqlite",
    displayName: "SQLite",
    kind: "relational",
    validateUrl(url: string) {
      if (!isAbsolute(url.trim())) throw new Error("An absolute database file path is required");
    },
    async test(config: ConnectionConfig) {
      const schema = readSchema(config.url);
      return { version: schema.pragmas.sqlite_version ?? "", summary: { engine: "SQLite", tables: schema.tables.length } };
    },
    async connect(config: ConnectionConfig) {
      const path = config.url;
      const probed = readSchema(path);
      const relational: RelationalProvider = {
        schema: async () => readSchema(path),
        insights: (signal) => sqliteTask({ operation: "insights", args: [path] }, signal),
        query: (q, signal) => sqliteTask({ operation: "query", args: [path, q.sql, q.params ?? [], q.limit, q.offset, q.exportAll === true] }, signal, q.timeoutMs),
        explain: (q, signal) => sqliteTask({ operation: "explain", args: [path, q.sql, q.params ?? []] }, signal, q.timeoutMs),
        exec: (sql, writable, signal, timeoutMs) => sqliteTask({ operation: "exec", args: [path, sql, !writable] }, signal, timeoutMs),
        migrate: (sql, apply, signal, timeoutMs) => sqliteTask({ operation: "migration", args: [path, sql, apply] }, signal, timeoutMs),
        applyRows: (changes, signal, timeoutMs) => sqliteTask({ operation: "rows", args: [path, changes] }, signal, timeoutMs),
      };
      return {
        info: { version: probed.pragmas.sqlite_version ?? "", summary: { engine: "SQLite", tables: probed.tables.length } },
        relational,
        stateless: true,
        async close() {},
      };
    },
  };
}
