import { DbError } from "../shared/types.ts";

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
