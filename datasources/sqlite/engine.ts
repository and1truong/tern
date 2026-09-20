import { splitSqlStatements } from "../../shared/sqlConsole.ts";
import { validateMigrationSql } from "../../shared/migrationSafety.ts";
import { Database } from "bun:sqlite";
import { closeSync, fstatSync, openSync, statSync, unlinkSync } from "node:fs";
import { join, isAbsolute, normalize } from "node:path";
import { homedir } from "node:os";
import type { DbSchema, DbTable, DbColumn, QueryResult, ExecResult, RowChange, RowMutationResult, DatabaseInsights, MigrationResult } from "../../shared/types.ts";
import { DbError } from "../../shared/types.ts";
import { assertReadOnlyScript, assertReadOnlySql, boundReadSql, normalizeSingleStatement, sqlTokens } from "../../shared/sqlSafety.ts";
import { compileRowChanges } from "../../shared/rowMutations.ts";
import { encodeDbValue } from "../../shared/binaryValues.ts";
export { DbError } from "../../shared/types.ts";

const DEFAULT_LIMIT = 1000;
const HARD_LIMIT = 10000;

function resolvePath(raw: string): string {
  let p = raw.trim();
  if (!p || p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  if (!isAbsolute(p)) throw new DbError("not_found", "path must be absolute");
  return normalize(p);
}

function openRead(path: string, safeIntegers = false): Database {
  let st;
  try { st = statSync(path); } catch { throw new DbError("not_found", "database file not found"); }
  if (!st.isFile()) throw new DbError("not_found", "not a file");
  try {
    const db = new Database(path, { readonly: true, safeIntegers });
    db.exec("PRAGMA foreign_keys = ON");
    return db;
  }
  catch { throw new DbError("not_a_database", "could not open as sqlite (read-only)"); }
}
function openWrite(path: string, safeIntegers = false): Database {
  let st;
  try { st = statSync(path); } catch { throw new DbError("not_found", "database file not found"); }
  if (!st.isFile()) throw new DbError("not_found", "not a file");
  let db: Database;
  try { db = new Database(path, { safeIntegers }); }
  catch { throw new DbError("not_a_database", "could not open as sqlite (read/write)"); }
  try {
    // The stat above is check-then-open — a file deleted in the gap would
    // have been recreated empty at a different inode than the one gated.
    const now = statSync(path);
    if (now.dev !== st.dev || now.ino !== st.ino) {
      throw new DbError("conflict", "the file at this path changed while the database was being opened");
    }
    db.exec("PRAGMA foreign_keys = ON");
    return db;
  }
  catch (error) {
    db.close();
    if (error instanceof DbError) throw error;
    // A file deleted between open and re-stat reports ENOENT — the same
    // swap conflict, not a malformed database.
    const enoent = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw new DbError(enoent ? "conflict" : "not_a_database",
      enoent ? "the file at this path changed while the database was being opened" : "could not open as sqlite (read/write)");
  }
}

export function createDatabase(pathRaw: string): { path: string; created: true } {
  const path = resolvePath(pathRaw);
  // Reserve the path exclusively — an existsSync check followed by a normal
  // create would silently open (and report "created" for) a file that
  // materialized in between.
  let reserved: { dev: number; ino: number };
  try {
    const fd = openSync(path, "wx", 0o600);
    try { const st = fstatSync(fd); reserved = { dev: st.dev, ino: st.ino }; }
    finally { closeSync(fd); }
  }
  catch (error) {
    throw (error as NodeJS.ErrnoException).code === "EEXIST"
      ? new DbError("conflict", "a file already exists at this path")
      : new DbError("not_found", error instanceof Error ? error.message : "could not create database");
  }
  // Only our own reservation may be unlinked — a foreign file swapped into
  // the gap must be re-verified before removal (or left alone).
  const cleanupReservation = () => {
    try { const st = statSync(path); if (st.dev === reserved.dev && st.ino === reserved.ino) unlinkSync(path); }
    catch { /* best-effort cleanup */ }
  };
  let db: Database;
  try { db = new Database(path); }
  catch (error) {
    // Don't leave the 0-byte reservation behind — it would report "conflict"
    // on retry although no valid database exists.
    cleanupReservation();
    throw new DbError("not_found", error instanceof Error ? error.message : "could not create database");
  }
  // The exclusivity ended at closeSync — if a different file was swapped into
  // the gap, refuse to adopt it (and never unlink someone else's file).
  let now;
  try { now = statSync(path); }
  catch {
    db.close();
    throw new DbError("conflict", "the file at this path changed while the database was being created");
  }
  if (now.dev !== reserved.dev || now.ino !== reserved.ino) {
    db.close();
    throw new DbError("conflict", "the file at this path changed while the database was being created");
  }
  try { db.exec("PRAGMA foreign_keys = ON"); }
  catch (error) {
    db.close();
    cleanupReservation();
    throw error;
  }
  db.close();
  return { path, created: true };
}

function readCols(db: Database, name: string, isView: boolean): DbColumn[] {
  const info = db.query<{ name: string; type: string; notnull: number; pk: number; dflt_value: unknown; hidden: number }, []>(
    `PRAGMA table_xinfo(${quoteIdent(name)})`,
  ).all().filter((column) => column.hidden !== 1);
  // foreign keys (tables only; views have none)
  const fkMap: Record<string, string[]> = Object.create(null);
  if (!isView) {
    for (const row of db.query<{ table: string; from: string; to: string }, []>(
      `PRAGMA foreign_key_list(${quoteIdent(name)})`,
    ).all()) {
      fkMap[row.from] = [...(fkMap[row.from] ?? []), `${row.table}(${row.to})`];
    }
  }
  return info.map((c) => ({
    name: c.name,
    type: c.type ?? "",
    notNull: c.notnull === 1,
    pk: c.pk > 0,
    fk: fkMap[c.name] ?? null,
    defaultValue: c.dflt_value == null ? null : String(c.dflt_value),
    generated: c.hidden === 2 || c.hidden === 3,
  }));
}

export function readSchema(pathRaw: string): DbSchema {
  const path = resolvePath(pathRaw);
  const db = openRead(path);
  try {
    const objs = db.query<{ name: string; type: string; sql: string; tbl_name: string }, []>(
      "SELECT name, type, sql, tbl_name FROM sqlite_master WHERE type IN ('table','view','index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name",
    ).all();
    const tables: DbTable[] = [];
    const indexes: DbSchema["indexes"] = [];
    const triggers: DbSchema["triggers"] = [];
    for (const o of objs) {
      if (o.type === "table" || o.type === "view") {
        const isView = o.type === "view";
        tables.push({
          name: o.name,
          type: o.type,
          columns: readCols(db, o.name, isView),
          // Exact counts can scan every row. Load them on demand instead of
          // blocking schema refresh once per table.
          rowCount: -1,
          ddl: o.sql ?? "",
        });
      } else if (o.type === "index") {
        const flags = db.query<{ unique: number; origin: string; partial: number }, [string, string]>("SELECT `unique`, origin, partial FROM pragma_index_list(?) WHERE name = ?").get(o.tbl_name, o.name);
        const columns = db.query<{ name: string }, []>(`PRAGMA index_info(${quoteIdent(o.name)})`).all().map((column) => column.name);
        indexes.push({ name: o.name, table: o.tbl_name, unique: flags?.unique === 1, columns, sql: o.sql ?? "" });
        if (flags?.unique === 1 && flags.partial === 0 && columns.length && columns.every(column => column != null)) {
          const table = tables.find((candidate) => candidate.name === o.tbl_name);
          if (table) table.uniqueKeys = [...(table.uniqueKeys ?? []), columns];
        }
      } else if (o.type === "trigger") triggers.push({ name: o.name, table: o.tbl_name, sql: o.sql ?? "" });
    }
    for (const table of tables.filter((candidate) => candidate.type === "table")) {
      const listed = db.query<{ name: string; unique: number; partial: number }, []>(`PRAGMA index_list(${quoteIdent(table.name)})`).all();
      for (const item of listed) {
        const columns = db.query<{ name: string }, []>(`PRAGMA index_info(${quoteIdent(item.name)})`).all().map((column) => column.name);
        if (item.unique === 1 && item.partial === 0 && columns.length && columns.every(column => column != null) && !(table.uniqueKeys ?? []).some((key) => key.join("\0") === columns.join("\0"))) {
          table.uniqueKeys = [...(table.uniqueKeys ?? []), columns];
        }
        if (!indexes.some((index) => index.name === item.name)) indexes.push({ name: item.name, table: table.name, unique: item.unique === 1, columns, sql: "" });
      }
    }
    const pragma = (k: string) => {
      const row = db.query<Record<string, unknown>, []>(`PRAGMA ${k}`).get();
      return String((row && Object.values(row)[0]) ?? "");
    };
    const pragmas: Record<string, string> = {
      sqlite_version: String(db.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()?.version ?? ""),
      journal_mode: pragma("journal_mode"),
      foreign_keys: pragma("foreign_keys"),
      encoding: pragma("encoding"),
      user_version: pragma("user_version"),
      synchronous: pragma("synchronous"),
    };
    const constraints: NonNullable<DbSchema["constraints"]> = [];
    for (const table of tables.filter((candidate) => candidate.type === "table")) {
      const primary = table.columns.filter((column) => column.pk).map((column) => column.name);
      if (primary.length) constraints.push({ name: `pk_${table.name}`, table: table.name, type: "PRIMARY KEY", columns: primary, definition: `PRIMARY KEY (${primary.join(", ")})` });
      for (const unique of table.uniqueKeys ?? []) {
        if (unique.join("\0") === primary.join("\0")) continue;
        const index = indexes.find((candidate) => candidate.table === table.name && candidate.columns?.join("\0") === unique.join("\0"));
        constraints.push({ name: index?.name ?? `uq_${table.name}_${unique.join("_")}`, table: table.name, type: "UNIQUE", columns: unique, definition: `UNIQUE (${unique.join(", ")})` });
      }
      for (const column of table.columns) for (const [index, target] of [column.fk ?? []].flat().entries()) {
        constraints.push({ name: `fk_${table.name}_${column.name}_${index}`, table: table.name, type: "FOREIGN KEY", columns: [column.name], definition: `${column.name} → ${target}` });
      }
    }
    return { tables, schemas: ["main"], indexes, triggers, constraints, sequences: [], routines: [], extensions: [], pragmas };
  } finally {
    db.close();
  }
}

export function readInsights(pathRaw: string): DatabaseInsights {
  const path = resolvePath(pathRaw);
  const db = openRead(path);
  try {
    const scalar = (sql: string) => Number(Object.values(db.query<Record<string, unknown>, []>(sql).get() ?? { value: 0 })[0] ?? 0);
    const pageCount = scalar("PRAGMA page_count");
    const pageSize = scalar("PRAGMA page_size");
    const freePages = scalar("PRAGMA freelist_count");
    const objects = db.query<{ type: string; count: number }, []>(
      "SELECT type, COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' GROUP BY type",
    ).all();
    const counts = Object.fromEntries(objects.map((row) => [`${row.type}s`, row.count]));
    const check = String(Object.values(db.query<Record<string, unknown>, []>("PRAGMA quick_check").get() ?? { value: "unknown" })[0]);
    return {
      metrics: {
        engine: "SQLite", file_bytes: statSync(path).size, allocated_bytes: pageCount * pageSize,
        free_bytes: freePages * pageSize, integrity: check, ...counts,
      },
      activity: [],
    };
  } finally { db.close(); }
}

// A single read-only statement: first verb must be SELECT/WITH/EXPLAIN/PRAGMA-select,
// and the body must not contain a statement-separating ";" followed by more SQL.
export function assertReadOnly(sql: string): void {
  assertReadOnlySql(sql, "sqlite");
}

export function runQuery(pathRaw: string, sql: string, params: unknown[], limitRaw?: number, offsetRaw?: number, exportAll = false): QueryResult {
  const limit = exportAll ? 100_000 : Math.min(Math.max(limitRaw ?? DEFAULT_LIMIT, 1), HARD_LIMIT);
  const offset = exportAll ? 0 : Math.max(Math.floor(offsetRaw ?? 0), 0);
  const boundedSql = boundReadSql(sql, limit, offset, "sqlite");
  const db = openRead(resolvePath(pathRaw), true);
  try {
    const t0 = performance.now();
    const stmt = db.prepare(boundedSql);
    const columns = stmt.columnNames;
    let rows: unknown[][];
    try { rows = stmt.values(...(params as never[])); }
    catch (e) { throw new DbError("sql", e instanceof Error ? e.message : String(e)); }
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    const wireRows = rows.slice(0, limit).map(row => Object.fromEntries(columns.map((column, i) => [column, encodeDbValue(row[i])])));
    return { columns, rows: wireRows, ms, hasMore: rows.length > limit, offset };
  } finally {
    db.close();
  }
}

export function explainQuery(pathRaw: string, sql: string, params: unknown[]): QueryResult {
  const normalized = assertReadOnlySql(sql, "sqlite");
  const db = openRead(resolvePath(pathRaw));
  try {
    const t0 = performance.now();
    let rows: Record<string, unknown>[];
    try { rows = db.prepare(`EXPLAIN QUERY PLAN ${normalized}`).all(...(params as never[])) as Record<string, unknown>[]; }
    catch (error) { throw new DbError("sql", error instanceof Error ? error.message : String(error)); }
    return {
      columns: rows.length ? Object.keys(rows[0]) : ["id", "parent", "notused", "detail"],
      rows,
      ms: Math.round((performance.now() - t0) * 10) / 10,
      hasMore: false,
      offset: 0,
    };
  } finally { db.close(); }
}

export function runExec(pathRaw: string, sql: string, readOnly = false): ExecResult {
  if (readOnly) assertReadOnlyScript(sql, "sqlite");
  const db = openWrite(resolvePath(pathRaw), true);
  try {
    if (readOnly) db.exec("PRAGMA query_only = on");
    const t0 = performance.now();
    let rowsAffected: number | null = 0;
    let result: QueryResult | undefined;
    try {
      let returning = false;
      let multiple = false;
      try { returning = sqlTokens(normalizeSingleStatement(sql, "sqlite"), "sqlite").includes("RETURNING"); }
      catch (error) { if (!(error instanceof DbError) || error.code !== "multi_statement") throw error; multiple = true; }
      if (returning || multiple) {
        const statements = multiple ? splitSqlStatements(sql, "sqlite").map(s => s.sql) : [sql];
        for (const text of statements) {
          const statement = db.prepare(text);
          const labels = statement.columnNames;
          const rows = labels.length ? statement.values() as unknown[][] : (statement.run(), []);
          const width = rows[0]?.length ?? labels.length;
          const columns = width === labels.length && new Set(labels).size === labels.length ? labels : Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
          if (columns.length || returning) result = { columns, rows: rows.map(row => Object.fromEntries(columns.map((column, index) => [column, encodeDbValue(row[index])]))), ms: 0, offset: 0, hasMore: false };
        }
      } else db.exec(sql);
      rowsAffected = multiple ? null : Number(db.query<{ c: bigint }, []>("SELECT changes() AS c").get()?.c ?? 0);
    }
    catch (e) { if (e instanceof DbError) throw e; throw new DbError("sql", e instanceof Error ? e.message : String(e)); }
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    if (result) result.ms = ms;
    return { rowsAffected, ms, ...(result ? { result } : {}) };
  } finally {
    db.close();
  }
}

export function runMigration(pathRaw: string, sql: string, apply: boolean): MigrationResult {
  const script = validateMigrationSql(sql, "sqlite");
  const db = openWrite(resolvePath(pathRaw));
  const t0 = performance.now();
  let transaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transaction = true;
    db.exec(script);
    db.exec(apply ? "COMMIT" : "ROLLBACK");
    transaction = false;
    return { validated: true, applied: apply, ms: Math.round((performance.now() - t0) * 10) / 10 };
  } catch (error) {
    if (transaction) try { db.exec("ROLLBACK"); } catch { /* original error wins */ }
    if (error instanceof DbError) throw error;
    throw new DbError("sql", error instanceof Error ? error.message : String(error));
  } finally { db.close(); }
}

export function runRowChanges(pathRaw: string, changes: RowChange[]): RowMutationResult {
  const statements = compileRowChanges(changes);
  const db = openWrite(resolvePath(pathRaw));
  const t0 = performance.now();
  try {
    let rowsAffected = 0;
    const apply = db.transaction(() => {
      for (const statement of statements) {
        const affected = db.prepare(statement.sql).run(...(statement.params as never[])).changes;
        if (affected !== 1) {
          throw new DbError("conflict", `${statement.kind} expected one row but matched ${affected}`);
        }
        rowsAffected += affected;
      }
    });
    try { apply(); }
    catch (error) {
      if (error instanceof DbError) throw error;
      throw new DbError("sql", error instanceof Error ? error.message : String(error));
    }
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    return { applied: statements.length, rowsAffected, ms };
  } finally {
    db.close();
  }
}

// Quote an identifier for safe interpolation into PRAGMA table_info(<ident>) etc.
function quoteIdent(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  return '"' + name.replace(/"/g, '""') + '"';
}
