type Dialect = "sqlite" | "postgres";
export interface SqlSelection { from: number; to: number }

function structuralWords(sql: string, dialect: Dialect = "sqlite"): string[] {
  const words: string[] = [];
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = 0;
  let dollarTag: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (lineComment) { if (ch === "\n") lineComment = false; continue; }
    if (blockComment) {
      if (dialect === "postgres" && ch === "/" && sql[i + 1] === "*") { blockComment++; i++; }
      else if (ch === "*" && sql[i + 1] === "/") { blockComment--; i++; }
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { i += dollarTag.length - 1; dollarTag = null; }
      continue;
    }
    if (quote) {
      if (ch === quote) { if (sql[i + 1] === quote) i++; else quote = null; }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") { lineComment = true; i++; continue; }
    if (ch === "/" && sql[i + 1] === "*") { blockComment = 1; i++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) { dollarTag = match[0]; i += match[0].length - 1; continue; }
    }
    if (ch === "(" || ch === ")" || ch === "," || ch === "=") words.push(ch);
    if (/[A-Za-z_]/.test(ch)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      words.push(sql.slice(start, i).toUpperCase());
      i--;
    }
  }
  return words;
}

export function splitSqlStatements(sql: string, dialect: Dialect = "sqlite"): { sql: string; from: number; to: number }[] {
  const statements: { sql: string; from: number; to: number }[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = 0;
  let dollarTag: string | null = null;
  let trigger = false;
  let bodyDepth = 0;
  const leadingWords: string[] = [];
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (lineComment) { if (ch === "\n") lineComment = false; continue; }
    if (blockComment) {
      if (dialect === "postgres" && ch === "/" && sql[i + 1] === "*") { blockComment++; i++; }
      else if (ch === "*" && sql[i + 1] === "/") { blockComment--; i++; }
      continue;
    }
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
    if (ch === "/" && sql[i + 1] === "*") { blockComment = 1; i++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) { dollarTag = match[0]; i += match[0].length - 1; continue; }
    }
    if (/[A-Za-z_]/.test(ch)) {
      const wordStart = i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      const word = sql.slice(wordStart, i).toUpperCase();
      i--;
      leadingWords.push(word);
      if (leadingWords[0] === "CREATE" && leadingWords.length <= 3 && word === "TRIGGER") trigger = true;
      if (trigger && (word === "BEGIN" || word === "CASE")) bodyDepth++;
      if (trigger && word === "END") bodyDepth--;
      continue;
    }
    if (ch === ";" && bodyDepth === 0) {
      const statement = sql.slice(start, i).trim();
      if (statement) statements.push({ sql: statement, from: start, to: i });
      start = i + 1;
      trigger = false;
      leadingWords.length = 0;
    }
  }
  const statement = sql.slice(start).trim();
  if (statement) statements.push({ sql: statement, from: start, to: sql.length });
  return statements;
}

export function sqlToRun(sql: string, selection: SqlSelection, all: boolean, dialect: Dialect = "sqlite"): string[] {
  if (all) return splitSqlStatements(sql, dialect).map((statement) => statement.sql);
  if (selection.from !== selection.to) {
    return splitSqlStatements(sql.slice(selection.from, selection.to), dialect).map((statement) => statement.sql);
  }
  const statements = splitSqlStatements(sql, dialect);
  const current = statements.find((statement) =>
    selection.from >= statement.from && selection.from <= statement.to,
  );
  const last = statements.at(-1);
  const trailing = last && selection.from > last.to && /^;\s*$/.test(sql.slice(last.to));
  return current ? [current.sql] : trailing ? [last.sql] : [];
}

export function firstSqlVerb(sql: string, dialect: Dialect = "sqlite"): string {
  return structuralWords(sql, dialect)[0] ?? "";
}

export function isWriteSql(sql: string, dialect: Dialect = "sqlite"): boolean {
  const words = structuralWords(sql, dialect);
  if (!words.length) return false;
  if (words[0] === "PRAGMA") {
    if (words.includes("=")) return true;
    const argument = words.indexOf("(");
    return argument !== -1 && !["TABLE_INFO", "TABLE_XINFO", "INDEX_INFO", "INDEX_XINFO", "INDEX_LIST", "FOREIGN_KEY_LIST", "INTEGRITY_CHECK", "QUICK_CHECK", "FOREIGN_KEY_CHECK"].includes(words[argument - 1]);
  }
  if (!["SELECT", "WITH", "EXPLAIN", "VALUES", "PRAGMA", "SHOW"].includes(words[0])) return true;
  if (words[0] !== "WITH") return false;
  let depth = 0;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "(") depth++;
    if (word === ")") depth--;
    const startsBody = words[i - 1] === "(" && ["AS", "MATERIALIZED"].includes(words[i - 2]);
    const startsMain = depth === 0 && words[i - 1] === ")";
    if ((startsBody || startsMain) && ["INSERT", "UPDATE", "DELETE", "MERGE"].includes(word)) return true;
  }
  return false;
}
