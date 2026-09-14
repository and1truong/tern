import { READ_PRAGMAS } from "../server/sqlSafety.ts";
type Dialect = "sqlite" | "postgres";
export interface SqlSelection { from: number; to: number }

function structuralWords(sql: string, dialect: Dialect = "sqlite", keepQuoted = false): string[] {
  const words: string[] = [];
  let quoteStart = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escapeString = false;
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
      if (escapeString && ch === "\\") { i++; continue; }
      if (ch === quote) {
        if (sql[i + 1] === quote) i++;
        else {
          if (keepQuoted) words.push(sql.slice(quoteStart + 1, i).replaceAll(quote + quote, quote).toUpperCase());
          quote = null;
        }
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") { lineComment = true; i++; continue; }
    if (ch === "/" && sql[i + 1] === "*") { blockComment = 1; i++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") {
      quoteStart = i;
      quote = ch;
      escapeString = dialect === "postgres" && ch === "'" && /[eE]/.test(sql[i - 1] ?? "") && (i < 2 || !/[A-Za-z0-9_$]/.test(sql[i - 2]));
      continue;
    }
    if (ch === "[" && dialect === "sqlite") {
      const end = sql.indexOf("]", i + 1);
      if (keepQuoted) words.push(sql.slice(i + 1, end < 0 ? sql.length : end).toUpperCase());
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (ch === "$" && dialect === "postgres") {
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
  let escapeString = false;
  let lineComment = false;
  let blockComment = 0;
  let dollarTag: string | null = null;
  let trigger = false;
  let bodyDepth = 0;
  let triggerBegins = 0;
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
      if (escapeString && ch === "\\") { i++; continue; }
      if (ch === quote) {
        if (sql[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") { lineComment = true; i++; continue; }
    if (ch === "/" && sql[i + 1] === "*") { blockComment = 1; i++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      escapeString = dialect === "postgres" && ch === "'" && /[eE]/.test(sql[i - 1] ?? "") && (i < 2 || !/[A-Za-z0-9_$]/.test(sql[i - 2]));
      continue;
    }
    if (ch === "[" && dialect === "sqlite") {
      const end = sql.indexOf("]", i + 1);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (ch === "$" && dialect === "postgres") {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) { dollarTag = match[0]; i += match[0].length - 1; continue; }
    }
    if (/[A-Za-z_]/.test(ch)) {
      const wordStart = i++;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      const word = sql.slice(wordStart, i).toUpperCase();
      i--;
      leadingWords.push(word);
      if (word === "TRIGGER" && leadingWords.length <= 4 && (/^CREATE (?:(?:TEMP|TEMPORARY) )?TRIGGER$/.test(leadingWords.join(" ")) || (dialect === "postgres" && leadingWords.join(" ") === "CREATE OR REPLACE TRIGGER"))) trigger = true;
      if (trigger && dialect === "sqlite" && word === "BEGIN" && ++triggerBegins > 1) throw new Error("Ambiguous trigger BEGIN: quote identifiers named begin before executing this script");
      if (trigger && (word === "BEGIN" || word === "CASE")) bodyDepth++;
      if (trigger && word === "END") bodyDepth--;
      continue;
    }
    if (ch === ";" && bodyDepth === 0) {
      const statement = sql.slice(start, i).trim();
      if (structuralWords(statement, dialect).length) statements.push({ sql: statement, from: start, to: i });
      start = i + 1;
      trigger = false;
      triggerBegins = 0;
      leadingWords.length = 0;
    }
  }
  const statement = sql.slice(start).trim();
  if (structuralWords(statement, dialect).length) statements.push({ sql: statement, from: start, to: sql.length });
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
  const trailing = last && selection.from > last.to && !structuralWords(sql.slice(last.to), dialect).length;
  return current ? [current.sql] : trailing ? [last.sql] : [];
}

export function firstSqlVerb(sql: string, dialect: Dialect = "sqlite"): string {
  return structuralWords(sql, dialect)[0] ?? "";
}

export function isWriteSql(sql: string, dialect: Dialect = "sqlite"): boolean {
  const words = structuralWords(sql, dialect);
  if (dialect === "postgres") {
    const named = structuralWords(sql, dialect, true);
    if (named.some((word, i) => ["NEXTVAL", "SETVAL"].includes(word) && named[i + 1] === "(")) return true;
  }
  return isWriteWords(words, dialect);
}

function isWriteWords(words: string[], dialect: Dialect): boolean {
  if (!words.length) return false;
  if (words[0] === "EXPLAIN" && dialect === "postgres") {
    let depth = 0;
    for (let i = 1; i < words.length; i++) {
      if (words[i] === "(") depth++;
      if (words[i] === ")") depth--;
      if (depth === 0 && ["SELECT", "TABLE", "WITH", "VALUES", "INSERT", "UPDATE", "DELETE", "MERGE", "EXECUTE"].includes(words[i])) return isWriteWords(words.slice(i), dialect);
    }
  }
  if (words[0] === "PRAGMA") {
    if (words.includes("=")) return true;
    const argument = words.indexOf("(");
    if (argument === -1) return !READ_PRAGMAS.has(words.at(-1)!);
    return !["TABLE_INFO", "TABLE_XINFO", "INDEX_INFO", "INDEX_XINFO", "INDEX_LIST", "FOREIGN_KEY_LIST", "INTEGRITY_CHECK", "QUICK_CHECK", "FOREIGN_KEY_CHECK"].includes(words[argument - 1]);
  }
  if (!["SELECT", "WITH", "EXPLAIN", "VALUES", "PRAGMA", "SHOW"].includes(words[0]) && !(dialect === "postgres" && words[0] === "TABLE")) return true;
  if (dialect === "postgres" && ["SELECT", "WITH", "TABLE"].includes(words[0])) {
    let depth = 0;
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (word === "(") depth++;
      if (word === ")") depth--;
      if ((depth === 0 && word === "INTO") || (word === "FOR" && /^(UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)( |$)/.test(words.slice(i + 1).join(" ")))) return true;
    }
  }
  if (words[0] !== "WITH") return false;
  let depth = 0;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === "(") depth++;
    if (word === ")") depth--;
    const startsBody = words[i - 1] === "(" && ["AS", "MATERIALIZED"].includes(words[i - 2]);
    const startsMain = depth === 0 && words[i - 1] === ")";
    if ((startsBody || startsMain) && ["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE"].includes(word)) return true;
  }
  return false;
}


export function executionUnits(statements: string[], dialect: Dialect): { statements: string[]; transaction: boolean; readOnly: boolean } {
  let open = false;
  let transaction = false;
  let explicitBegin = false;
  let wrote = false;
  const savepoints: string[] = [];
  const control = ['BEGIN', 'START', 'COMMIT', 'END', 'ABORT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'];
  for (const statement of statements) {
    const words = structuralWords(statement, dialect);
    const namedWords = structuralWords(statement, dialect, true);
    const verb = words[0];
    if (!control.includes(verb) && isWriteSql(statement, dialect)) wrote = true;
    if (verb === 'BEGIN' || verb === 'START') { open = true; explicitBegin = true; transaction = true; }
    if (['COMMIT', 'END', 'ABORT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'].includes(verb)) {
      transaction = true;
      if (dialect === 'sqlite' && verb === 'SAVEPOINT') { open = true; savepoints.push(namedWords[1]); }
      if (!open) throw new Error('Run the complete transaction together using Run all or a selection.');
      if (dialect === 'sqlite' && (verb === 'RELEASE' || (verb === 'ROLLBACK' && words.includes('TO')))) {
        const nameIndex = verb === 'RELEASE' ? 1 : words.indexOf('TO') + 1;
        const name = namedWords[nameIndex + (words[nameIndex] === 'SAVEPOINT' ? 1 : 0)];
        const index = savepoints.lastIndexOf(name);
        if (index < 0) throw new Error('Include the matching SAVEPOINT in this transaction.');
        savepoints.splice(index + (verb === 'ROLLBACK' ? 1 : 0));
        if (!explicitBegin && !savepoints.length) open = false;
      }
      if (['COMMIT', 'END', 'ABORT'].includes(verb) || (verb === 'ROLLBACK' && !words.includes('TO'))) {
        open = words.includes('CHAIN') && !words.includes('NO');
        explicitBegin = open;
        savepoints.length = 0;
      }
    }
  }
  if (open) throw new Error('Include COMMIT or ROLLBACK and run the complete transaction together.');
  const batch = transaction || (statements.length > 1 && statements.some(statement => isWriteSql(statement, dialect)));
  return { statements: batch ? [statements.join(';\n') + ';'] : statements, transaction: batch, readOnly: !wrote };
}
