import { DbError } from "./types.ts";
import { sqlTokens, PG_SIDE_EFFECT_FUNCTIONS } from "./sqlSafety.ts";

// Transaction-scoped advisory locks release at the runner's ROLLBACK and
// are a legitimate migration idiom — the rest of the denylist carries
// effects (file writes, replication state, backend kills) that would
// outlive a "dry run".
const XACT_LOCKS = new Set([
  "PG_ADVISORY_XACT_LOCK", "PG_ADVISORY_XACT_LOCK_SHARED",
  "PG_TRY_ADVISORY_XACT_LOCK", "PG_TRY_ADVISORY_XACT_LOCK_SHARED",
]);

export function validateMigrationSql(sql: string, dialect: "sqlite" | "postgres" = "postgres"): string {
  const script = sql.trim();
  if (!script || script.length > 1_000_000) throw new DbError('sql', 'Migration must contain SQL and fit within 1 MB');
  const bodies: string[] = [];
  const tokens = sqlTokens(script, dialect, bodies);
  if (dialect === 'postgres') {
    const deny = (list: string[]) => list.find(token => PG_SIDE_EFFECT_FUNCTIONS.has(token) && !XACT_LOCKS.has(token));
    // A DO / CREATE FUNCTION body is a dollar-quoted literal the top-level
    // scan skips — PERFORM pg_terminate_backend inside one must still be
    // denied. (Nested dollar quotes and EXECUTE'd dynamic strings stay
    // opaque; closing that needs a real parser.)
    const fn = deny(tokens) ?? bodies.map(body => deny(sqlTokens(body, dialect))).find(Boolean);
    if (fn) throw new DbError('sql', `Migration scripts cannot call ${fn.toLowerCase()} — its effects outlive the preview transaction`);
  }
  let first = true;
  let trigger = false;
  let depth = 0;
  let triggerBegins = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // Transaction commands are invalid inside SQLite triggers too; do not let body depth hide them.
    // depth === 0 keeps the trigger body's own closing END (which follows an
    // inner ';') from tripping the check.
    if (dialect === 'sqlite' && depth === 0 && tokens[i - 1] === ';' && ['BEGIN', 'COMMIT', 'END', 'ABORT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'].includes(token)) {
      throw new DbError('sql', `Transaction control (${token}) is managed by the migration runner`);
    }
    if (first && token !== ';') {
      // COPY writes server files / runs programs, LOAD links a shared
      // library, and CHECKPOINT forces a server-wide checkpoint (Postgres
      // allows it inside a transaction) — nontransactional effects the
      // preview ROLLBACK can't undo.
      if (['BEGIN', 'START', 'COMMIT', 'END', 'ABORT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'PREPARE', 'ATTACH', 'DETACH', 'VACUUM', 'PRAGMA', 'SET', 'RESET', 'COPY', 'LOAD', 'CHECKPOINT'].includes(token)) {
        throw new DbError('sql', `Transaction control and nontransactional operations (${token}) are managed by the migration runner`);
      }
      // Depth tracking exists for SQLite trigger BEGIN…END bodies only —
      // Postgres triggers have no inline body, and BEGIN/END are unreserved
      // keywords there (`ON begin`, `EXECUTE FUNCTION end()`), so counting
      // them would let a ';'-terminated COMMIT slip the first-token check.
      trigger = dialect === 'sqlite' && token === 'CREATE' && /^(?:(?:TEMP|TEMPORARY) )?TRIGGER(?: |$)/.test(tokens.slice(i + 1, i + 4).join(' '));
      triggerBegins = 0;
      first = false;
    }
    if (trigger && dialect === 'sqlite' && token === 'BEGIN' && ++triggerBegins > 1) throw new DbError('sql', 'Ambiguous trigger BEGIN: quote identifiers named begin before executing this script');
    if (trigger && (token === 'BEGIN' || token === 'CASE')) depth++;
    // `end` is a keyword-fallback identifier in SQLite — an unquoted column
    // named end (e.g. WHEN old.end <> new.end) must not underflow the body
    // depth, or no ';' ever ends the trigger and first-token checks stop.
    if (trigger && token === 'END' && depth > 0) depth--;
    if (token === ';' && depth === 0) { first = true; trigger = false; }
  }
  return script;
}
