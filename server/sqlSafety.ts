import { DbError } from "../shared.ts";

const READ_VERBS = new Set(["SELECT", "WITH", "EXPLAIN", "VALUES", "PRAGMA"]);
const READ_PRAGMAS = new Set([
  "APPLICATION_ID", "COLLATION_LIST", "COMPILE_OPTIONS", "DATABASE_LIST", "ENCODING",
  "FOREIGN_KEY_LIST", "FOREIGN_KEYS", "FREELIST_COUNT", "FUNCTION_LIST", "INDEX_INFO",
  "INDEX_LIST", "INDEX_XINFO", "INTEGRITY_CHECK", "JOURNAL_MODE", "MODULE_LIST", "PAGE_COUNT",
  "PAGE_SIZE", "PRAGMA_LIST", "QUICK_CHECK", "SCHEMA_VERSION", "SYNCHRONOUS", "TABLE_INFO",
  "TABLE_LIST", "TABLE_XINFO", "USER_VERSION",
]);
const WRITE_TOKENS = new Set([
  "ALTER", "ATTACH", "CREATE", "DELETE", "DETACH", "DROP", "GRANT", "INSERT",
  "MERGE", "REINDEX", "REPLACE", "REVOKE", "TRUNCATE", "UPDATE", "VACUUM",
]);

// Tokenize only the SQL structure needed for safety checks. Quoted values,
// identifiers, and comments are deliberately excluded from the token stream.
interface SqlToken { value: string; start: number; end: number }

function scanSqlTokens(sql: string): SqlToken[] {
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
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++;
          break;
        }
        if (sql[i] === "\\" && quote !== '"') i += 2;
        else i++;
      }
      continue;
    }
    if (ch === "[") {
      const end = sql.indexOf("]", i + 1);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === "$") {
      const tag = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
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

export function sqlTokens(sql: string): string[] {
  return scanSqlTokens(sql).map((token) => token.value).filter(value => !["(", ")", ","].includes(value));
}

export function normalizeSingleStatement(sql: string): string {
  const trimmed = sql.trim();
  const scanned = scanSqlTokens(trimmed);
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

export function assertReadOnlySql(sql: string): string {
  const normalized = normalizeSingleStatement(sql);
  const tokens = sqlTokens(normalized);
  const verb = tokens[0] ?? "";
  if (!READ_VERBS.has(verb)) {
    throw new DbError("not_read_only", `statement must start with SELECT/WITH/EXPLAIN/VALUES or a read PRAGMA (got "${verb}")`);
  }
  if (verb === "PRAGMA") {
    const name = tokens[1] ?? "";
    if (!READ_PRAGMAS.has(name) || normalized.includes("=")) throw new DbError("not_read_only", `PRAGMA ${name || "statement"} is not an approved read`);
  }
  const structure = scanSqlTokens(normalized).map(token => token.value);
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
  return normalized;
}

export function boundReadSql(sql: string, limit: number, offset = 0): string {
  const normalized = assertReadOnlySql(sql);
  const verb = sqlTokens(normalized)[0];
  if (verb === "EXPLAIN" || verb === "PRAGMA") return normalized;
  return `SELECT * FROM (${normalized}\n) AS "__dbm_query" LIMIT ${limit + 1} OFFSET ${offset}`;
}
