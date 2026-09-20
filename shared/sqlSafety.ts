import { DbError } from "./types.ts";

const READ_VERBS = new Set(["SELECT", "WITH", "EXPLAIN", "VALUES", "PRAGMA", "SHOW"]);
export const READ_PRAGMAS = new Set([
  "APPLICATION_ID", "COLLATION_LIST", "COMPILE_OPTIONS", "DATABASE_LIST", "ENCODING",
  "FOREIGN_KEY_LIST", "FOREIGN_KEY_CHECK", "FOREIGN_KEYS", "FREELIST_COUNT", "FUNCTION_LIST", "INDEX_INFO",
  "INDEX_LIST", "INDEX_XINFO", "INTEGRITY_CHECK", "JOURNAL_MODE", "MODULE_LIST", "PAGE_COUNT",
  "PAGE_SIZE", "PRAGMA_LIST", "QUICK_CHECK", "SCHEMA_VERSION", "SYNCHRONOUS", "TABLE_INFO",
  "TABLE_LIST", "TABLE_XINFO", "USER_VERSION",
]);
// Read-only pragmas that legitimately take a function-style argument —
// PRAGMA table_info(t). Every other approved pragma is a bare read, so
// PRAGMA x(y) is the SET form and must be refused (user_version(123) writes
// the database header; the `=` check alone misses it).
const PRAGMA_FUNCTION_READS = new Set([
  "TABLE_INFO", "TABLE_XINFO", "INDEX_INFO", "INDEX_LIST", "INDEX_XINFO",
  "FOREIGN_KEY_LIST", "FOREIGN_KEY_CHECK", "TABLE_LIST", "QUICK_CHECK", "INTEGRITY_CHECK",
]);
const WRITE_TOKENS = new Set([
  "ALTER", "ATTACH", "CREATE", "DELETE", "DETACH", "DROP", "GRANT", "INSERT",
  "MERGE", "REINDEX", "REPLACE", "REVOKE", "TRUNCATE", "UPDATE", "VACUUM",
]);

// Tokenize only the SQL structure needed for safety checks. Quoted values,
// identifiers, and comments are deliberately excluded from the token stream.
interface SqlToken { value: string; start: number; end: number }

// Routine bodies still decode server-side: E'…' takes \xHH/\ooo/\uXXXX/
// \UXXXXXXXX and U&'…' takes \XXXX/\+XXXXXX — a denylisted name must not
// hide behind an escape. Invalid escapes are server-side errors anyway, so
// undecodable input is fine left raw.
function decodeRoutineBody(raw: string, prefix?: string): string {
  const body = raw.replace(/''/g, "'");
  try {
    if (prefix === "E") {
      return body.replace(/\\x[0-9a-fA-F]{1,2}|\\[0-7]{1,3}|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}/g,
        m => String.fromCodePoint(m[1] === "x" || m[1] === "u" || m[1] === "U" ? parseInt(m.slice(2), 16) : parseInt(m.slice(1), 8)));
    }
    if (prefix === "U") {
      return body.replace(/\\\+[0-9a-fA-F]{6}|\\[0-9a-fA-F]{4}/g,
        m => String.fromCodePoint(parseInt(m.slice(m[1] === "+" ? 2 : 1), 16)));
    }
  } catch { /* out-of-range code points are server-side errors anyway */ }
  return body;
}

function scanSqlTokens(sql: string, dialect: "sqlite" | "postgres" = "postgres", bodies?: string[]): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (dialect === "postgres" && sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      const backslashEscapes = dialect === "postgres" && quote === "'"
        && /[eE]/.test(sql[i - 1] ?? "") && (i < 2 || !/[A-Za-z0-9_$]/.test(sql[i - 2]));
      const contentStart = ++i;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          break;
        }
        if (sql[i] === "\\" && backslashEscapes) i += 2;
        else i++;
      }
      const contentEnd = i++;
      if (bodies && quote === "'" && dialect === "postgres") {
        // DO/AS routine bodies are single-quoted just as often as
        // dollar-quoted — collect them for the migration function scan.
        // Gating on the preceding token keeps 'pg_sleep' data literals from
        // false-positiving (AS 'label' aliases are the contrived residue).
        // E/N/U& are legal SCONST prefixes — DO U&'…' lexes U as a word.
        const last = tokens.at(-1)?.value;
        const prev = tokens.at(-2)?.value;
        const prefix = (last === "E" || last === "N" || last === "U") && (prev === "DO" || prev === "AS") ? last : undefined;
        if (last === "DO" || last === "AS" || prefix) {
          bodies.push(decodeRoutineBody(sql.slice(contentStart, contentEnd), prefix));
        }
      }
      // "name"( — a double-quoted identifier immediately calling — is a real
      // function call in Postgres; emit it so the side-effect denylist sees
      // it. Content inside string literals never reaches this branch.
      if (quote === '"' && dialect === "postgres") {
        // Comments count as whitespace between the name and the paren
        // ("pg_sleep"/*…*/(5) is a real call).
        let j = i;
        const skipSpace = () => {
          for (;;) {
            while (j < sql.length && /\s/.test(sql[j]!)) j++;
            if (sql[j] === "-" && sql[j + 1] === "-") { while (j < sql.length && sql[j] !== "\n") j++; continue; }
            if (sql[j] === "/" && sql[j + 1] === "*") {
              let cdepth = 1; j += 2;
              while (j < sql.length && cdepth) {
                if (sql[j] === "/" && sql[j + 1] === "*") { cdepth++; j += 2; }
                else if (sql[j] === "*" && sql[j + 1] === "/") { cdepth--; j += 2; }
                else j++;
              }
              continue;
            }
            break;
          }
        };
        skipSpace();
        const isUIdent = contentStart >= 3 && sql[contentStart - 2] === "&" && /[uU]/.test(sql[contentStart - 3]!);
        // U&"name" UESCAPE 'c' is a single identifier — the clause sits
        // between the closing quote and the call's paren, and comments are
        // whitespace between its three tokens (base_yylex folds them into
        // one identifier).
        let uescape = "\\";
        if (isUIdent) {
          const kw = sql.slice(j).match(/^UESCAPE\b/i);
          if (kw) {
            j += kw[0].length;
            skipSpace();
            // The clause accepts any SCONST — 'c', E'c', N'c', or
            // $$c$$/$tag$c$tag$ (base_yylex checks the token kind, not the
            // quoting form). A clause that can't be consumed errors
            // server-side, so leaving j there is still safe.
            const dollar = sql.slice(j).match(/^\$([A-Za-z_0-9]*)\$[\s\S]*?\$\1\$/);
            const quoted = dollar ? null : sql.slice(j).match(/^[eEnN]?'(?:[^'\\]|\\.|'')*'/);
            if (dollar) {
              uescape = dollar[0].slice(2 + dollar[1].length, dollar[0].length - 2 - dollar[1].length);
              j += dollar[0].length; skipSpace();
            } else if (quoted) {
              uescape = quoted[0].replace(/^[eEnN]?'/, "").slice(0, -1).replace(/''/g, "'").replace(/\\(.)/g, "$1");
              j += quoted[0].length; skipSpace();
            }
          }
        }
        if (sql[j] === "(") {
          let name = sql.slice(contentStart, contentEnd);
          // U&"…" decodes cXXXX and c+XXXXXX escapes (c defaults to \ but
          // UESCAPE can redefine it) — a denylisted name must not hide
          // behind either form. Postgres rejects a multi-char or
          // out-of-range escape anyway, so decode only the single-char case.
          if (isUIdent && uescape.length === 1) {
            const esc = uescape.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            try {
              name = name.replace(new RegExp(`${esc}\\+[0-9a-fA-F]{6}|${esc}[0-9a-fA-F]{4}`, "g"), m => String.fromCodePoint(parseInt(m.slice(1), 16)));
            } catch { /* out-of-range escapes are server-side errors anyway */ }
          }
          tokens.push({ value: name.replace(/""/g, '"').toUpperCase(), start: contentStart - 1, end: i });
        }
      }
      continue;
    }
    // [name] is a quoted identifier only in sqlite; in Postgres '[' opens an
    // array subscript and must not swallow the rest of the statement.
    if (ch === "[" && dialect === "sqlite") {
      const end = sql.indexOf("]", i + 1);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === "$" && dialect === "postgres") {
      const tag = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        // Same DO/AS gate as the '…' path — a dollar-quoted data literal
        // (INSERT ... VALUES ($$called pg_sleep at 3am$$)) is not a routine
        // body and must not trip the migration function scan.
        if (bodies && end !== -1 && ["DO", "AS"].includes(tokens.at(-1)?.value ?? "")) {
          bodies.push(sql.slice(i + tag.length, end));
        }
        i = end === -1 ? sql.length : end + tag.length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      tokens.push({ value: sql.slice(start, i).toUpperCase(), start, end: i });
      continue;
    }
    if ([";", "(", ")", ","].includes(ch)) tokens.push({ value: ch, start: i, end: i + 1 });
    i++;
  }
  return tokens;
}

export function sqlTokens(sql: string, dialect: "sqlite" | "postgres" = "postgres", bodies?: string[]): string[] {
  return scanSqlTokens(sql, dialect, bodies).map((token) => token.value).filter(value => !["(", ")", ","].includes(value));
}

export function normalizeSingleStatement(sql: string, dialect: "sqlite" | "postgres" = "postgres"): string {
  const trimmed = sql.trim();
  const scanned = scanSqlTokens(trimmed, dialect);
  const tokens = scanned.map((token) => token.value);
  const semicolons = tokens.reduce<number[]>((out, token, i) => {
    if (token === ";") out.push(i);
    return out;
  }, []);
  const content = tokens.filter((token) => token !== ";");
  if (semicolons.some((i) => i < tokens.length - 1) || semicolons.length > 1) {
    throw new DbError("multi_statement", "only a single statement is allowed");
  }
  if (!content.length) throw new DbError("not_read_only", "statement is empty");
  const terminator = semicolons.length ? scanned[semicolons[0]] : null;
  return terminator
    ? trimmed.slice(0, terminator.start) + trimmed.slice(terminator.end)
    : trimmed;
}

export function assertReadOnlySql(sql: string, dialect: "sqlite" | "postgres" = "postgres"): string {
  const normalized = normalizeSingleStatement(sql, dialect);
  const tokens = sqlTokens(normalized, dialect);
  const verb = tokens[0] ?? "";
  if (!READ_VERBS.has(verb) && !(dialect === "postgres" && verb === "TABLE")) {
    throw new DbError("not_read_only", `statement must start with SELECT/WITH/EXPLAIN/VALUES or SHOW/read PRAGMA (got "${verb}")`);
  }
  if (verb === "PRAGMA") {
    const name = tokens[1] ?? "";
    if (!READ_PRAGMAS.has(name) || normalized.includes("=")) throw new DbError("not_read_only", `PRAGMA ${name || "statement"} is not an approved read`);
  }
  const structure = scanSqlTokens(normalized, dialect).map(token => token.value);
  if (verb === "PRAGMA" && structure[2] === "(" && !PRAGMA_FUNCTION_READS.has(tokens[1] ?? "")) {
    throw new DbError("not_read_only", `PRAGMA ${tokens[1] ?? "statement"}(…) is the write form`);
  }
  let depth = 0;
  let explainOperation = verb === "EXPLAIN";
  let withMain = verb === "WITH" || (verb === "EXPLAIN" && structure.includes("WITH"));
  const write = structure.find((token, i) => {
    if (token === "(") depth++;
    if (token === ")") depth--;
    const body = structure[i - 1] === "(" && ["AS", "MATERIALIZED"].includes(structure[i - 2]);
    const main = withMain && depth === 0 && structure[i - 1] === ")";
    if (main && (READ_VERBS.has(token) || WRITE_TOKENS.has(token))) withMain = false;
    const operation = i === 0 || body || main || explainOperation;
    if (explainOperation && i > 0 && (READ_VERBS.has(token) || WRITE_TOKENS.has(token))) explainOperation = false;
    return operation && WRITE_TOKENS.has(token);
  });
  if (write) throw new DbError("not_read_only", `read-only query contains ${write}`);
  if (dialect === "postgres") {
    const fn = tokens.find(token => PG_SIDE_EFFECT_FUNCTIONS.has(token));
    if (fn) throw new DbError("not_read_only", `read-only query cannot call ${fn}`);
  }
  return normalized;
}

// A read transaction still allows SELECT to reach functions with server-side
// effects — kills other backends, holds advisory locks past the transaction,
// changes session GUCs, burns the statement, writes large objects / WAL /
// remote rows, or reads server-local files back to the client. Quoted
// identifiers and string literals are excluded from the token stream, so
// matching a token means an actual function call.
export const PG_SIDE_EFFECT_FUNCTIONS = new Set([
  "PG_TERMINATE_BACKEND", "PG_CANCEL_BACKEND", "PG_SLEEP",
  "PG_ADVISORY_LOCK", "PG_ADVISORY_LOCK_SHARED", "PG_ADVISORY_UNLOCK",
  "PG_ADVISORY_UNLOCK_SHARED", "PG_ADVISORY_UNLOCK_ALL",
  "PG_TRY_ADVISORY_LOCK", "PG_TRY_ADVISORY_LOCK_SHARED",
  "PG_ADVISORY_XACT_LOCK", "PG_ADVISORY_XACT_LOCK_SHARED",
  "PG_TRY_ADVISORY_XACT_LOCK", "PG_TRY_ADVISORY_XACT_LOCK_SHARED",
  "SET_CONFIG", "PG_RELOAD_CONF", "PG_LOG_ROTATE", "PG_ROTATE_LOGFILE",
  "PG_CREATE_RESTORE_POINT", "PG_SWITCH_WAL", "PG_SWITCH_LSN",
  "PG_LOGICAL_EMIT_MESSAGE", "PG_PROMOTE",
  "PG_FILE_WRITE", "PG_FILE_UNLINK", "PG_FILE_RENAME", "PG_FILE_SYNC",
  "PG_EXECUTE_SERVER_PROGRAM",
  // Server-filesystem readers exfiltrate files the DB role can reach —
  // confidential, not just side-effecting. The *_FILE_SETTINGS / hba/ident
  // views expose postgresql.conf (archive_command/ssl_passphrase_command
  // routinely carry credentials); pg_test_* write files server-side; the
  // adminpack aliases predate PG10.
  "PG_READ_FILE", "PG_READ_BINARY_FILE", "PG_STAT_FILE",
  "PG_LS_DIR", "PG_LS_LOGDIR", "PG_LS_WALDIR", "PG_LS_TMPDIR",
  "PG_LS_ARCHIVE_STATUSDIR", "PG_LS_REPLSLOTDIR",
  "PG_FILE_SETTINGS", "PG_SHOW_ALL_FILE_SETTINGS",
  "PG_HBA_FILE_RULES", "PG_IDENT_FILE_MAPPINGS",
  "PG_TEST_FSYNC", "PG_TEST_TIMING_TARGETS",
  "PG_FILE_LENGTH", "PG_LOGDIR_LS",
  // pg_backup_start writes backup_label outside the transaction; the
  // walinspect family exposes raw WAL (same exfiltration class as the file
  // readers); pg_log_backend_memory_contexts writes server logs.
  "PG_BACKUP_START", "PG_BACKUP_STOP", "PG_LOG_BACKEND_MEMORY_CONTEXTS",
  "PG_GET_WAL_RECORDS_INFO", "PG_GET_WAL_RECORD_INFO", "PG_GET_WAL_STATS",
  "PG_GET_WAL_BLOCK_INFO", "PG_GET_WAL_FPI_INFO",
  // Replication slots/origins and snapshot export persist catalog or file
  // state outside the transaction; wal-replay pause and index maintenance
  // are superuser side effects.
  "PG_EXPORT_SNAPSHOT",
  "PG_CREATE_PHYSICAL_REPLICATION_SLOT", "PG_CREATE_LOGICAL_REPLICATION_SLOT",
  "PG_COPY_PHYSICAL_REPLICATION_SLOT", "PG_COPY_LOGICAL_REPLICATION_SLOT",
  "PG_DROP_REPLICATION_SLOT", "PG_REPLICATION_SLOT_ADVANCE",
  "PG_REPLICATION_ORIGIN_CREATE", "PG_REPLICATION_ORIGIN_DROP",
  "PG_REPLICATION_ORIGIN_ADVANCE", "PG_REPLICATION_ORIGIN_SESSION_SETUP",
  "PG_REPLICATION_ORIGIN_XACT_SETUP",
  "PG_WAL_REPLAY_PAUSE", "PG_WAL_REPLAY_RESUME",
  "BRIN_SUMMARIZE_NEW_VALUES", "BRIN_SUMMARIZE_RANGE", "BRIN_DESUMMARIZE_RANGE",
  "GIN_CLEAN_PENDING_LIST",
  "PG_STAT_RESET", "PG_STAT_RESET_SHARED", "PG_STAT_RESET_SLRU",
  "PG_STAT_RESET_SINGLE_TABLE_COUNTERS", "PG_STAT_RESET_SINGLE_FUNCTION_COUNTERS",
  "PG_STAT_RESET_REPLICATION_SLOT", "PG_STAT_RESET_SUBSCRIPTION",
  "LO_IMPORT", "LO_EXPORT", "LO_UNLINK", "LO_CREAT", "LO_CREATE", "LO_PUT", "LO_FROM_BYTEA",
  // `dblink(...)` itself runs arbitrary SQL on a separate remote session the
  // local read-only transaction does not cover; the connect/exec helpers
  // above are its siblings.
  "DBLINK", "DBLINK_CONNECT", "DBLINK_CONNECT_U", "DBLINK_EXEC", "DBLINK_SEND_QUERY",
  "PG_NOTIFY", "PG_LOGICAL_SLOT_GET_CHANGES", "PG_LOGICAL_SLOT_GET_BINARY_CHANGES",
]);

const TRANSACTION_VERBS = new Set(["BEGIN", "START", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE", "ABORT"]);

// A multi-statement script whose every statement is a read or plain
// transaction control; the write path of /exec runs these without write access.
export function assertReadOnlyScript(sql: string, dialect: "sqlite" | "postgres" = "postgres"): void {
  const trimmed = sql.trim();
  const scanned = scanSqlTokens(trimmed, dialect);
  const statements: string[] = [];
  let start = 0;
  for (const token of scanned) {
    if (token.value !== ";") continue;
    if (trimmed.slice(start, token.start).trim()) statements.push(trimmed.slice(start, token.start));
    start = token.end;
  }
  if (trimmed.slice(start).trim()) statements.push(trimmed.slice(start));
  if (!statements.length) throw new DbError("not_read_only", "statement is empty");
  for (const statement of statements) {
    const tokens = sqlTokens(statement, dialect);
    if (TRANSACTION_VERBS.has(tokens[0] ?? "")) {
      if ((tokens[0] === "BEGIN" || tokens[0] === "START") && tokens.includes("WRITE")) {
        throw new DbError("not_read_only", "read-only script contains BEGIN READ WRITE");
      }
      continue;
    }
    assertReadOnlySql(statement, dialect);
  }
}

export function boundReadSql(sql: string, limit: number, offset = 0, dialect: "sqlite" | "postgres" = "postgres"): string {
  const normalized = assertReadOnlySql(sql, dialect);
  const verb = sqlTokens(normalized, dialect)[0];
  if (verb === "EXPLAIN" || verb === "PRAGMA" || verb === "SHOW") return normalized;
  return `SELECT * FROM (${normalized}\n) AS "__tern_query" LIMIT ${limit + 1} OFFSET ${offset}`;
}
