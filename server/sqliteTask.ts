import { DbError } from "../shared.ts";
import type { QueryResult, ExecResult, MigrationResult, RowMutationResult } from "../shared.ts";
import { runQuery, explainQuery, runExec, runMigration, runRowChanges } from "./dbServer.ts";

type Task = { operation: 'query' | 'explain' | 'exec' | 'migration' | 'rows'; args: unknown[] };
// SQLite is synchronous. A short-lived Bun subprocess makes cancellation interrupt
// native SQL too; the OS closes the connection and rolls back unfinished writes.
export async function sqliteTask<T extends QueryResult | ExecResult | MigrationResult | RowMutationResult>(task: Task, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
  if (signal?.aborted) throw new DbError('cancelled', 'Query cancelled');
  const child = Bun.spawn([process.execPath, import.meta.path, '--execute'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
  child.stdin.write(JSON.stringify(task));
  child.stdin.end();
  let timedOut = false;
  const cancel = () => child.kill();
  const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const text = await new Response(child.stdout).text();
    const code = await child.exited;
    if (timedOut) throw new DbError('timeout', `Query exceeded ${timeoutMs}ms`);
    if (signal?.aborted) throw new DbError('cancelled', 'Query cancelled');
    if (code !== 0) throw new DbError('sql', 'SQLite operation failed');
    const value = JSON.parse(text);
    if (value.error) throw new DbError(value.code ?? 'sql', value.error);
    return value.result;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

if (import.meta.main && process.argv.includes('--execute')) {
  try {
    const task = await Bun.stdin.json() as Task;
    const runners = { query: runQuery, explain: explainQuery, exec: runExec, migration: runMigration, rows: runRowChanges };
    const result = (runners[task.operation] as (...args: any[]) => unknown)(...task.args);
    console.log(JSON.stringify({ result }));
  } catch (e) { console.log(JSON.stringify({ error: e instanceof Error ? e.message : 'SQLite error', code: e instanceof DbError ? e.code : 'sql' })); }
}
