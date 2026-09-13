export interface SqlSelection { from: number; to: number }

const WRITE_VERBS = new Set([
  "ALTER", "ATTACH", "CREATE", "DELETE", "DETACH", "DROP", "GRANT", "INSERT",
  "MERGE", "REINDEX", "REPLACE", "REVOKE", "TRUNCATE", "UPDATE", "VACUUM",
]);

function structuralWords(sql: string): string[] {
  const words: string[] = [];
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  let dollarTag: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (lineComment) { if (ch === "\n") lineComment = false; continue; }
    if (blockComment) { if (ch === "*" && sql[i + 1] === "/") { blockComment = false; i++; } continue; }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { i += dollarTag.length - 1; dollarTag = null; }
      continue;
    }
    if (quote) {
      if (ch === quote) { if (sql[i + 1] === quote) i++; else quote = null; }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") { lineComment = true; i++; continue; }
    if (ch === "/" && sql[i + 1] === "*") { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) { dollarTag = match[0]; i += match[0].length - 1; continue; }
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      words.push(sql.slice(start, i).toUpperCase());
      i--;
    }
  }
  return words;
}

export function splitSqlStatements(sql: string): { sql: string; from: number; to: number }[] {
  const statements: { sql: string; from: number; to: number }[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  let dollarTag: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (lineComment) { if (ch === "\n") lineComment = false; continue; }
    if (blockComment) { if (ch === "*" && sql[i + 1] === "/") { blockComment = false; i++; } continue; }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { i += dollarTag.length - 1; dollarTag = null; }
      continue;
    }
    if (quote) {
      if (ch === quote) {
        if (sql[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") { lineComment = true; i++; continue; }
    if (ch === "/" && sql[i + 1] === "*") { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) { dollarTag = match[0]; i += match[0].length - 1; continue; }
    }
    if (ch === ";") {
      const statement = sql.slice(start, i).trim();
      if (statement) statements.push({ sql: statement, from: start, to: i });
      start = i + 1;
    }
  }
  const statement = sql.slice(start).trim();
  if (statement) statements.push({ sql: statement, from: start, to: sql.length });
  return statements;
}

export function sqlToRun(sql: string, selection: SqlSelection, all: boolean): string[] {
  if (all) return splitSqlStatements(sql).map((statement) => statement.sql);
  if (selection.from !== selection.to) {
    return splitSqlStatements(sql.slice(selection.from, selection.to)).map((statement) => statement.sql);
  }
  const statements = splitSqlStatements(sql);
  const current = statements.find((statement) =>
    selection.from >= statement.from && selection.from <= statement.to,
  );
  const last = statements.at(-1);
  const trailing = last && selection.from > last.to && /^;\s*$/.test(sql.slice(last.to));
  return current ? [current.sql] : trailing ? [last.sql] : [];
}

export function firstSqlVerb(sql: string): string {
  return structuralWords(sql)[0] ?? "";
}

export function isWriteSql(sql: string): boolean {
  return structuralWords(sql).some((word) => WRITE_VERBS.has(word));
}
