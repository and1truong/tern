// PostgreSQL connection open: URL validation, TLS `prefer` handling and the
// Bun.SQL client. Connections are opened per request and closed in a finally,
// matching the sqlite engine's open-on-each-call pattern — no pool to manage.
import { SQL } from "bun";
import { DbError } from "../../shared/types.ts";

export async function open(url: string): Promise<SQL> {
  let parsed: URL;
  try { parsed = new URL(url.trim()); }
  catch { throw new DbError('not_a_database', 'Invalid PostgreSQL connection URL'); }
  const prefer = parsed.searchParams.get('sslmode') === 'prefer';
  if (prefer) parsed.searchParams.set('sslmode', 'require');
  const db = new SQL(parsed.toString(), { connectionTimeout: 10, max: 1 });
  try { await db.connect(); return db; }
  catch (error) {
    await db.close({ timeout: 0 }).catch(() => {});
    // Bun's prefer negotiation can stall on non-TLS servers. A require probe
    // preserves the preference without downgrading certificate/auth failures.
    if (prefer && (error as { code?: string }).code === 'ERR_POSTGRES_TLS_NOT_AVAILABLE') {
      parsed.searchParams.set('sslmode', 'disable');
      return open(parsed.toString());
    }
    throw new DbError('not_a_database', error instanceof Error ? error.message : 'Could not connect');
  }
}
