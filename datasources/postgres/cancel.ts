// Query cancellation: a client-side timeout/abort races the query while a
// second connection issues pg_cancel_backend so the server-side work stops too.
import { DbError } from "../../shared/types.ts";
import { open } from "./connect.ts";
import type { SQL } from "bun";

export interface CancellableQuery<T> extends PromiseLike<T> {
  cancel(): unknown;
}

export async function awaitControlled<T>(
  query: CancellableQuery<T>,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<T> {
  let timedOut = false;
  const cancel = () => { query.cancel(); };
  const timeout = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();

  try {
    return await query;
  } catch (error) {
    if (timedOut || (error instanceof Error && /statement timeout/i.test(error.message))) throw new DbError("timeout", `query exceeded ${timeoutMs}ms`);
    if (signal?.aborted) throw new DbError("cancelled", "query cancelled");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function controlledPg<T>(url: string, connection: Awaited<ReturnType<SQL['reserve']>>, query: CancellableQuery<T>, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
  if (signal?.aborted) throw new DbError('cancelled', 'Query cancelled');
  const rows = await connection.unsafe('SELECT pg_backend_pid() AS pid');
  const pid = Number(rows[0].pid);
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= (async () => {
      const control = await open(url);
      try { await control.unsafe('SELECT pg_cancel_backend($1)', [pid]); }
      finally { await control.close(); }
    })().catch(() => {});
  };
  // Some Bun releases reject the query promise before stopping the backend.
  // Cancel the reserved backend explicitly before releasing it or rolling back.
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  if (signal?.aborted) cancel();
  try { return await awaitControlled(query, signal, timeoutMs); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); await cancellation; }
}
