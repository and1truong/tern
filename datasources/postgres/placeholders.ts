// The client's filter compiler (dbFilter.ts) emits SQLite-style `?` placeholders;
// Postgres needs `$1,$2,…`. Rewrite positionally, skipping `?` inside single- or
// double-quoted string/identifier literals so SQL-pane queries stay intact.
export function toPgPlaceholders(sql: string, parameterCount = Number.POSITIVE_INFINITY): string {
  if (parameterCount === 0) return sql;
  let out = "";
  let n = 0;
  let quote: '"' | "'" | null = null;
  let backslashEscapes = false;
  let lineComment = false;
  let blockCommentDepth = 0;
  let dollarTag: string | null = null;
  const placeholderPrefixes = new Set([
    "AND", "AS", "BETWEEN", "BY", "CASE", "ELSE", "HAVING", "ILIKE", "IN", "IS",
    "LIKE", "LIMIT", "NOT", "OFFSET", "ON", "OR", "RETURNING", "SELECT", "SET", "THEN",
    "VALUES", "WHEN", "WHERE",
  ]);
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (lineComment) { out += ch; if (ch === "\n") lineComment = false; continue; }
    if (blockCommentDepth) {
      out += ch;
      if (ch === "/" && sql[i + 1] === "*") { out += sql[++i]; blockCommentDepth++; }
      else if (ch === "*" && sql[i + 1] === "/") { out += sql[++i]; blockCommentDepth--; }
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { out += dollarTag; i += dollarTag.length - 1; dollarTag = null; }
      else out += ch;
      continue;
    }
    if (quote) {
      out += ch;
      if (backslashEscapes && ch === "\\" && i + 1 < sql.length) {
        out += sql[++i];
        continue;
      }
      if (ch === quote) {
        // A doubled quote is an escaped quote, not a terminator.
        if (sql[i + 1] === quote) { out += sql[++i]; } else { quote = null; backslashEscapes = false; }
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") { out += "--"; i++; lineComment = true; continue; }
    if (ch === "/" && sql[i + 1] === "*") { out += "/*"; i++; blockCommentDepth = 1; continue; }
    if (ch === '"' || ch === "'") {
      quote = ch;
      backslashEscapes = ch === "'"
        && (sql[i - 1] === "E" || sql[i - 1] === "e")
        && (i < 2 || !/[A-Za-z0-9_$]/.test(sql[i - 2]));
      out += ch;
      continue;
    }
    if (ch === "$") {
      const tag = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) { out += tag; i += tag.length - 1; dollarTag = tag; continue; }
    }
    if (ch === "?" && n < parameterCount) {
      if (sql[i - 1] === "@") { out += ch; continue; }
      if (sql[i + 1] === "|" || sql[i + 1] === "&") { out += ch; continue; }
      const before = sql.slice(0, i);
      const previousChar = before.match(/\S(?=\s*$)/)?.[0] ?? "";
      const previousWord = before.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/)?.[1]?.toUpperCase() ?? "";
      const looksLikeOperator = /[A-Za-z0-9_$\])'"`]/.test(previousChar) && !placeholderPrefixes.has(previousWord);
      if (looksLikeOperator) { out += ch; continue; }
      out += "$" + ++n;
      continue;
    }
    out += ch;
  }
  return out;
}
