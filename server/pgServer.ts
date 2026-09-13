import { validateMigrationSql } from "./migrationSafety.ts";
// Postgres counterpart to dbServer.ts for the database views. Mirrors
// its exported shape (readPgSchema / runPgQuery / runPgExec) so routes.ts can
// dispatch on source kind. Uses Bun's built-in Postgres client (Bun.SQL); no
// extra dependency. Connections are opened per request and closed in a finally,
// matching dbServer.ts's open-on-each-call SQLite pattern — no pool to manage.
import { SQL } from "bun";
import { assertReadOnlySql, boundReadSql, sqlTokens } from "./sqlSafety.ts";
import { awaitControlled, type CancellableQuery } from "./queryControl.ts";
import { compileRowChanges, toPostgresMutationSql } from "./rowMutations.ts";
import type { DbSchema, DbTable, DbColumn, QueryResult, ExecResult, RowChange, RowMutationResult, ConnectionTestResult, DatabaseInsights, MigrationResult } from "../shared.ts";
import { DbError } from "../shared.ts";
import { encodeDbValue } from "../binaryValues.ts";

const DEFAULT_LIMIT = 1000;
const HARD_LIMIT = 10000;

async function open(url: string): Promise<SQL> {
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

async function controlledPg<T>(url: string, connection: Awaited<ReturnType<SQL['reserve']>>, query: CancellableQuery<T>, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
  if (signal?.aborted) throw new DbError('cancelled', 'Query cancelled');
  const rows = await connection.unsafe('SELECT pg_backend_pid() AS pid');
  const pid = Number(rows[0].pid);
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= (async () => {
      const control = await open(url);
      try { await control.unsafe('SELECT pg_cancel_backend($1)', [pid]); }
      finally { await control.close(); }
    })().catch(() => {});
  };
  // Some Bun releases reject the query promise before stopping the backend.
  // Cancel the reserved backend explicitly before releasing it or rolling back.
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  if (signal?.aborted) cancel();
  try { return await awaitControlled(query, signal, timeoutMs); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); await cancellation; }
}

function affectedOf(rows: unknown[]): number {
  const n = (rows as unknown as { count?: number }).count;
  return typeof n === "number" ? n : 0;
}

export function collectPgKeyMetadata(rows: Record<string, unknown>[]) {
  const primary = new Set<string>();
  const foreign = new Map<string, string[]>();
  const uniqueGroups = new Map<string, string[]>();
  for (const row of rows) {
    const schema = String(row.table_schema);
    const table = String(row.table_name);
    const column = String(row.column_name);
    const key = `${schema}\0${table}\0${column}`;
    if (row.constraint_type === "PRIMARY KEY") primary.add(key);
    else if (row.constraint_type === "FOREIGN KEY" && row.ref_table) {
      const refSchema = String(row.ref_schema ?? "");
      const target = String(row.ref_table);
      const refTable = refSchema.includes('.') || target.includes('.')
        ? [refSchema, target].filter(Boolean).map(part => `"${part.replace(/"/g, '""')}"`).join('.')
        : `${refSchema ? `${refSchema}.` : ""}${target}`;
      foreign.set(key, [...(foreign.get(key) ?? []), `${refTable}(${String(row.ref_column)})`]);
    } else if (row.constraint_type === "UNIQUE") {
      const group = `${schema}\0${table}\0${String(row.constraint_name)}`;
      uniqueGroups.set(group, [...(uniqueGroups.get(group) ?? []), column]);
    }
  }
  return { primary, foreign, uniqueGroups };
}

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

export async function readPgSchema(url: string): Promise<DbSchema> {
  const db = await open(url);
  try {
    // Tables + views in user schemas, with column lists in one shot.
    const cols = await db.unsafe(
      `SELECT t.table_schema, t.table_name, c.column_name, format_type(a.atttypid, a.atttypmod) AS data_type,
              c.is_nullable, c.ordinal_position, c.column_default, a.attislocal,
              CASE WHEN a.attcollation <> typ.typcollation THEN format('%I.%I', cn.nspname, coll.collname) END AS collation,
              pg_get_serial_sequence(format('%I.%I', t.table_schema, t.table_name), c.column_name) AS owned_sequence,
              c.is_identity, c.is_generated, c.identity_generation, c.identity_start, c.identity_increment, c.generation_expression,
              t.table_type, rel.relpersistence, rel.relrowsecurity, rel.relforcerowsecurity,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = rel.oid) AS has_policies,
              seq.seqmin, seq.seqmax, seq.seqcache, seq.seqcycle, pg_get_partkeydef(rel.oid) AS partition_key,
              CASE WHEN rel.relispartition THEN pg_get_expr(rel.relpartbound, rel.oid) END AS partition_bound,
              (SELECT string_agg(format('%I.%I', pn.nspname, parent.relname), ', ' ORDER BY inh.inhseqno) FROM pg_inherits inh
                JOIN pg_class parent ON parent.oid = inh.inhparent
                JOIN pg_namespace pn ON pn.oid = parent.relnamespace
                WHERE inh.inhrelid = rel.oid) AS parent_relation
         FROM information_schema.tables t
         JOIN pg_namespace n ON n.nspname = t.table_schema
         JOIN pg_class rel ON rel.relnamespace = n.oid AND rel.relname = t.table_name
         LEFT JOIN information_schema.columns c ON c.table_schema = t.table_schema AND c.table_name = t.table_name
         LEFT JOIN pg_attribute a ON a.attrelid = rel.oid AND a.attname = c.column_name
         LEFT JOIN pg_sequence seq ON seq.seqrelid = pg_get_serial_sequence(format('%I.%I', t.table_schema, t.table_name), c.column_name)::regclass
         LEFT JOIN pg_type typ ON typ.oid = a.atttypid
         LEFT JOIN pg_collation coll ON coll.oid = a.attcollation
         LEFT JOIN pg_namespace cn ON cn.oid = coll.collnamespace
        WHERE t.table_schema NOT IN ('pg_catalog','information_schema')
          AND t.table_type IN ('BASE TABLE','VIEW','FOREIGN')
        ORDER BY t.table_schema, t.table_name, c.ordinal_position`,
    ) as Record<string, unknown>[];

    const materializedColumns = await db.unsafe(
      `SELECT n.nspname AS table_schema, c.relname AS table_name,
              a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type,
              CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
              a.attnum AS ordinal_position, pg_get_expr(d.adbin, d.adrelid) AS column_default,
              'NO' AS is_identity, 'NEVER' AS is_generated,
              'MATERIALIZED VIEW' AS table_type
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE c.relkind = 'm' AND n.nspname NOT IN ('pg_catalog','information_schema')
        ORDER BY n.nspname, c.relname, a.attnum`,
    ) as Record<string, unknown>[];
    cols.push(...materializedColumns);

    const materializedDefinitions = await db.unsafe(
      `SELECT schemaname AS table_schema, matviewname AS table_name, definition, ispopulated
         FROM pg_matviews
        WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
    ) as Record<string, unknown>[];
    const materializedDdl = new Map(materializedDefinitions.map((row) => [
      `${row.table_schema}\0${row.table_name}`,
      `CREATE MATERIALIZED VIEW "${String(row.table_schema).replace(/"/g, '""')}"."${String(row.table_name).replace(/"/g, '""')}" AS\n${String(row.definition ?? "").trim().replace(/;$/, "")}${row.ispopulated === false ? "\nWITH NO DATA" : ""};`,
    ]));
    const viewDefinitions = await db.unsafe(
      `SELECT v.schemaname AS table_schema, v.viewname AS table_name, v.definition,
              (SELECT string_agg(format('%I = %L', option_name, option_value), ', ' ORDER BY option_name)
                FROM pg_options_to_table(c.reloptions)) AS options
         FROM pg_views v
         JOIN pg_namespace n ON n.nspname = v.schemaname
         JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = v.viewname
        WHERE v.schemaname NOT IN ('pg_catalog','information_schema')`,
    ) as Record<string, unknown>[];
    const viewDdl = new Map(viewDefinitions.map((row) => [
      `${row.table_schema}\0${row.table_name}`,
      `CREATE VIEW "${String(row.table_schema).replace(/"/g, '""')}"."${String(row.table_name).replace(/"/g, '""')}"${row.options ? ` WITH (${row.options})` : ""} AS\n${String(row.definition ?? "")}`,
    ]));

    const comparableRows = await db.unsafe(
      `WITH directly_comparable AS (
         SELECT candidate.oid
           FROM pg_type candidate
          WHERE EXISTS (
                  SELECT 1
                    FROM pg_operator o
                   WHERE o.oprname = '=' AND o.oprkind = 'b' AND o.oprresult = 'boolean'::regtype
                     AND (o.oprleft = candidate.oid OR EXISTS (
                       SELECT 1 FROM pg_cast c
                        WHERE c.castsource = candidate.oid AND c.casttarget = o.oprleft AND c.castcontext = 'i'
                     ))
                     AND (o.oprright = candidate.oid OR EXISTS (
                       SELECT 1 FROM pg_cast c
                        WHERE c.castsource = candidate.oid AND c.casttarget = o.oprright AND c.castcontext = 'i'
                     ))
                )
             OR (candidate.typtype IN ('e','r','m') AND EXISTS (
                  SELECT 1
                    FROM pg_operator o
                    JOIN pg_type l ON l.oid = o.oprleft
                    JOIN pg_type r ON r.oid = o.oprright
                   WHERE o.oprname = '=' AND (
                     (candidate.typtype = 'e' AND l.typname = 'anyenum' AND r.typname = 'anyenum')
                     OR (candidate.typtype = 'r' AND l.typname IN ('anyrange','anycompatiblerange') AND r.typname IN ('anyrange','anycompatiblerange'))
                     OR (candidate.typtype = 'm' AND l.typname IN ('anymultirange','anycompatiblemultirange') AND r.typname IN ('anymultirange','anycompatiblemultirange'))
                   )
                ))
       ), array_element_comparable AS (
         SELECT candidate.oid
           FROM pg_type candidate
          WHERE EXISTS (
            SELECT 1
              FROM pg_opclass opc
              JOIN pg_am am ON am.oid = opc.opcmethod
              JOIN pg_type input_type ON input_type.oid = opc.opcintype
             WHERE opc.opcdefault AND am.amname IN ('btree','hash') AND (
               opc.opcintype = candidate.oid
               OR EXISTS (
                 SELECT 1 FROM pg_cast c
                  WHERE c.castsource = candidate.oid AND c.casttarget = opc.opcintype
                    AND c.castcontext = 'i' AND c.castmethod = 'b'
               )
               OR (candidate.typtype = 'e' AND input_type.typname = 'anyenum')
               OR (candidate.typtype = 'r' AND input_type.typname IN ('anyrange','anycompatiblerange'))
               OR (candidate.typtype = 'm' AND input_type.typname IN ('anymultirange','anycompatiblemultirange'))
             )
          )
       )
       SELECT n.nspname AS table_schema, rel.relname AS table_name, a.attname AS column_name,
              directly_comparable.oid IS NOT NULL OR (
                effective.typcategory = 'A' AND effective.typelem <> 0 AND element_comparable.oid IS NOT NULL AND EXISTS (
                  SELECT 1
                    FROM pg_operator o
                    JOIN pg_type l ON l.oid = o.oprleft
                    JOIN pg_type r ON r.oid = o.oprright
                   WHERE o.oprname = '='
                     AND l.typname IN ('anyarray','anycompatiblearray')
                     AND r.typname IN ('anyarray','anycompatiblearray')
                )
              ) AS is_comparable
         FROM pg_class rel
         JOIN pg_namespace n ON n.oid = rel.relnamespace
         JOIN pg_attribute a ON a.attrelid = rel.oid AND a.attnum > 0 AND NOT a.attisdropped
         JOIN pg_type t ON t.oid = a.atttypid
         JOIN pg_type effective ON effective.oid = COALESCE(NULLIF(t.typbasetype, 0), t.oid)
         LEFT JOIN directly_comparable ON directly_comparable.oid = effective.oid
         LEFT JOIN pg_type element ON element.oid = effective.typelem
         LEFT JOIN pg_type effective_element ON effective_element.oid = COALESCE(NULLIF(element.typbasetype, 0), element.oid)
         LEFT JOIN array_element_comparable element_comparable ON element_comparable.oid = effective_element.oid
        WHERE rel.relkind IN ('r','p','v','m','f')
          AND n.nspname NOT IN ('pg_catalog','information_schema')`,
    ) as Record<string, unknown>[];
    const comparable = new Map(comparableRows.map((row) => [
      `${row.table_schema}\0${row.table_name}\0${row.column_name}`,
      row.is_comparable === true,
    ]));

    // Primary keys and foreign-key targets, keyed by table+column.
    const keys = await db.unsafe(
      `SELECT n.nspname AS table_schema, rel.relname AS table_name, con.conname AS constraint_name,
              src.attname AS column_name,
              CASE con.contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'f' THEN 'FOREIGN KEY' ELSE 'UNIQUE' END AS constraint_type,
              ref_n.nspname AS ref_schema, ref_rel.relname AS ref_table, ref.attname AS ref_column
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
         JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS src_key(attnum, ord) ON true
         JOIN pg_attribute src ON src.attrelid = con.conrelid AND src.attnum = src_key.attnum
         LEFT JOIN pg_class ref_rel ON ref_rel.oid = con.confrelid
         LEFT JOIN pg_namespace ref_n ON ref_n.oid = ref_rel.relnamespace
         LEFT JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS ref_key(attnum, ord) ON ref_key.ord = src_key.ord
         LEFT JOIN pg_attribute ref ON ref.attrelid = con.confrelid AND ref.attnum = ref_key.attnum
        WHERE con.contype IN ('p','f','u') AND n.nspname NOT IN ('pg_catalog','information_schema')
        ORDER BY n.nspname, rel.relname, con.conname, src_key.ord`,
    ) as Record<string, unknown>[];

    const { primary: pk, foreign: fk, uniqueGroups } = collectPgKeyMetadata(keys);

    // Row-count estimates from the planner stats (fast; exact COUNT(*) is slow
    // on large tables). -1 where unknown, matching SQLite views.
    const counts = await db.unsafe(
      `SELECT n.nspname AS table_schema, c.relname AS table_name,
              c.reltuples::bigint AS est
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p')`,
    ) as Record<string, unknown>[];
    const rowCount = new Map<string, number>();
    for (const r of counts) {
      const est = Number(r.est);
      rowCount.set(`${r.table_schema}\0${r.table_name}`, Number.isFinite(est) && est >= 0 ? est : -1);
    }

    // Group columns into tables, preserving information_schema order.
    const byTable = new Map<string, DbTable>();
    for (const c of cols) {
      // PostgreSQL identifiers cannot contain NUL; keep identity separate from display.
      const schema = String(c.table_schema);
      const bare = String(c.table_name);
      const name = `${schema}\0${bare}`;
      let tbl = byTable.get(name);
      if (!tbl) {
        const isView = c.table_type === "VIEW";
        const isMaterialized = c.table_type === "MATERIALIZED VIEW";
        tbl = {
          name: bare,
          schema,
          type: isMaterialized ? "materialized_view" : isView ? "view" : "table",
          columns: [],
          rowCount: isView || isMaterialized ? -1 : (rowCount.get(`${schema}\0${bare}`) ?? -1),
          ddl: "",
        };
        byTable.set(name, tbl);
      }
      if (c.column_name == null) continue;
      const keyId = `${schema}\0${bare}\0${c.column_name}`;
      const col: DbColumn = {
        name: String(c.column_name),
        type: String(c.data_type ?? ""),
        notNull: c.is_nullable === "NO",
        pk: pk.has(keyId),
        fk: fk.get(keyId) ?? null,
        defaultValue: c.column_default == null ? null : String(c.column_default),
        identity: c.is_identity === "YES",
        identityGeneration: c.identity_generation === "ALWAYS" ? "ALWAYS" : c.identity_generation === "BY DEFAULT" ? "BY DEFAULT" : undefined,
        ownedSequence: c.owned_sequence != null,
        generated: c.is_generated != null && c.is_generated !== "NEVER",
        comparable: comparable.get(keyId) ?? false,
      };
      tbl.columns.push(col);
    }
    const tables = [...byTable.values()];
    for (const table of tables) {
      const prefix = `${table.schema}\0${table.name}\0`;
      table.uniqueKeys = [...uniqueGroups.entries()].filter(([key]) => key.startsWith(prefix)).map(([, columns]) => columns);
    }
    // Synthesize a minimal CREATE statement per table for the Structure pane's
    const idx = await db.unsafe(
      `SELECT p.schemaname AS schema, p.tablename AS table_name, p.indexname AS name, p.indexdef AS sql,
              CASE WHEN i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
                THEN ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                  WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) END AS identity_columns
         FROM pg_indexes p
         JOIN pg_namespace n ON n.nspname = p.schemaname
         JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = p.indexname
         JOIN pg_index i ON i.indexrelid = c.oid
        WHERE p.schemaname NOT IN ('pg_catalog','information_schema')
        ORDER BY p.indexname`,
    ) as Record<string, unknown>[];
    for (const index of idx) {
      const columns = Array.isArray(index.identity_columns) ? index.identity_columns.map(String) : [];
      const table = tables.find(t => t.schema === index.schema && t.name === index.table_name);
      if (table && columns.length && !table.uniqueKeys!.some(key => key.join("\0") === columns.join("\0"))) table.uniqueKeys!.push(columns);
    }
    const indexes = idx.map((r) => ({
      name: String(r.name), schema: String(r.schema), table: String(r.table_name),
      unique: /\bUNIQUE\b/i.test(String(r.sql ?? "")), sql: String(r.sql ?? ""),
    }));

    const trg = await db.unsafe(
      `SELECT DISTINCT trigger_schema AS schema, event_object_table AS table_name,
              trigger_name AS name, action_timing AS timing, event_manipulation AS event,
              action_statement AS sql
         FROM information_schema.triggers
        WHERE trigger_schema NOT IN ('pg_catalog','information_schema')
        ORDER BY trigger_name`,
    ) as Record<string, unknown>[];
    const triggers = trg.map((r) => ({
      name: String(r.name), schema: String(r.schema), table: String(r.table_name),
      timing: String(r.timing), event: String(r.event), sql: String(r.sql ?? ""),
    }));

    const constraintRows = await db.unsafe(
      `SELECT n.nspname AS schema, c.relname AS table_name, con.conname AS name, con.conislocal,
              CASE con.contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'f' THEN 'FOREIGN KEY'
                WHEN 'u' THEN 'UNIQUE' WHEN 'c' THEN 'CHECK' WHEN 'x' THEN 'EXCLUDE' ELSE con.contype::text END AS type,
              pg_get_constraintdef(con.oid, true) AS definition,
              COALESCE(ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key.attnum ORDER BY key.ord), ARRAY[]::name[]) AS columns
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema')
        ORDER BY n.nspname, c.relname, con.conname`,
    ) as Record<string, unknown>[];
    const constraints = constraintRows.map((row) => ({
      name: String(row.name), schema: String(row.schema), table: String(row.table_name), type: String(row.type),
      columns: Array.isArray(row.columns) ? row.columns.map(String) : [], definition: String(row.definition ?? ""),
    }));

    // DDL block (Postgres has no sqlite_master.sql equivalent).
    for (const t of tables) {
      if (t.type === "materialized_view") {
        t.ddl = materializedDdl.get(`${t.schema}\0${t.name}`) ?? "";
        continue;
      }
      if (t.type === "view") {
        t.ddl = viewDdl.get(`${t.schema}\0${t.name}`) ?? "";
        continue;
      }
      // Foreign tables need FDW server/options; local CREATE TABLE would misrepresent them.
      if (cols.some(row => row.table_schema === t.schema && row.table_name === t.name && row.table_type === "FOREIGN")) continue;
      const metadata = cols.find(row => row.table_schema === t.schema && row.table_name === t.name)!;
      // RLS policies are not synthesized; do not offer DDL that drops their protection.
      if (metadata.relrowsecurity || metadata.relforcerowsecurity || metadata.has_policies) continue;
      const inherits = metadata.parent_relation && !metadata.partition_bound ? ` INHERITS (${metadata.parent_relation})` : "";
      const definitions = t.columns.flatMap(c => {
        const metadata = cols.find(row => row.table_schema === t.schema && row.table_name === t.name && row.column_name === c.name)!;
        if (inherits && metadata.attislocal === false) return [];
        const serialType = !c.identity && metadata.owned_sequence && c.defaultValue?.startsWith('nextval(')
          ? ({ smallint: 'smallserial', integer: 'serial', bigint: 'bigserial' } as Record<string, string>)[c.type] : undefined;
        const generation = serialType ? '' : c.identity
          ? ` GENERATED ${metadata.identity_generation} AS IDENTITY (START WITH ${metadata.identity_start} INCREMENT BY ${metadata.identity_increment} MINVALUE ${metadata.seqmin} MAXVALUE ${metadata.seqmax} CACHE ${metadata.seqcache} ${metadata.seqcycle ? "CYCLE" : "NO CYCLE"})`
          : c.generated ? ` GENERATED ALWAYS AS (${metadata.generation_expression}) STORED`
          : c.defaultValue != null ? ` DEFAULT ${c.defaultValue}` : '';
        return `  "${c.name.replace(/"/g, '""')}" ${serialType ?? c.type}${metadata.collation ? ` COLLATE ${metadata.collation}` : ""}${generation}${c.notNull ? " NOT NULL" : ""}`;
      });
      for (const constraint of constraints.filter(c => c.schema === t.schema && c.table === t.name)) {
        if (inherits && constraintRows.some(row => row.schema === t.schema && row.table_name === t.name && row.name === constraint.name && row.conislocal === false)) continue;
        definitions.push(`  CONSTRAINT "${constraint.name.replace(/"/g, '""')}" ${constraint.definition}`);
      }
      const body = definitions.join(",\n");
      const relation = `"${t.schema!.replace(/"/g, '""')}"."${t.name.replace(/"/g, '""')}"`;
      t.ddl = `CREATE ${metadata.relpersistence === "u" ? "UNLOGGED " : ""}TABLE ${relation} (\n${body}\n)${inherits}${metadata.partition_key ? ` PARTITION BY ${metadata.partition_key}` : ""};`;
      if (metadata.partition_bound) t.ddl += `\nALTER TABLE ${metadata.parent_relation} ATTACH PARTITION ${relation} ${metadata.partition_bound};`;
    }

    const sequenceRows = await db.unsafe(
      `SELECT sequence_schema AS schema, sequence_name AS name, data_type,
              start_value, minimum_value, maximum_value, increment
         FROM information_schema.sequences
        WHERE sequence_schema NOT IN ('pg_catalog','information_schema')
        ORDER BY sequence_schema, sequence_name`,
    ) as Record<string, unknown>[];
    const sequences = sequenceRows.map((row) => ({
      name: String(row.name), schema: String(row.schema),
      definition: `${row.data_type} · start ${row.start_value} · increment ${row.increment}`,
    }));

    const routineRows = await db.unsafe(
      `SELECT n.nspname AS schema,
              p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
              CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS type,
              pg_get_functiondef(p.oid) AS definition
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema')
          AND p.prokind IN ('f', 'p', 'w')
        ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)`,
    ) as Record<string, unknown>[];
    const routines = routineRows.map((row) => ({
      name: String(row.name), schema: String(row.schema), type: String(row.type), definition: String(row.definition ?? ""),
    }));

    const extensionRows = await db.unsafe(
      `SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname`,
    ) as Record<string, unknown>[];
    const extensions = extensionRows.map((row) => ({ name: String(row.name), definition: String(row.version ?? "") }));

    // Postgres has no pragmas; surface server metadata in the same kv shape so
    // the existing PragmasPane renders it unchanged.
    const meta = await db.unsafe(
      `SELECT version() AS version, current_database() AS database,
              current_user AS "user",
              current_setting('server_encoding') AS encoding,
              current_setting('server_version') AS server_version`,
    ) as Record<string, unknown>[];
    const m = meta[0] ?? {};
    const pragmas: Record<string, string> = {
      version: String(m.version ?? ""),
      database: String(m.database ?? ""),
      user: String(m.user ?? ""),
      encoding: String(m.encoding ?? ""),
      server_version: String(m.server_version ?? ""),
    };

    const schemas = [...new Set(tables.map((table) => table.schema).filter((value): value is string => !!value))].sort();
    return { tables, schemas, indexes, triggers, constraints, sequences, routines, extensions, pragmas };
  } catch (e) {
    if (e instanceof DbError) throw e;
    throw new DbError("not_a_database", e instanceof Error ? e.message : String(e));
  } finally {
    await db.close().catch(() => {});
  }
}

export async function runPgQuery(
  url: string,
  sql: string,
  params: unknown[],
  limitRaw?: number,
  offsetRaw?: number,
  signal?: AbortSignal,
  timeoutRaw?: number,
  exportAll = false,
): Promise<QueryResult> {
  const limit = exportAll ? 100_000 : Math.min(Math.max(limitRaw ?? DEFAULT_LIMIT, 1), HARD_LIMIT);
  const offset = exportAll ? 0 : Math.max(Math.floor(offsetRaw ?? 0), 0);
  const timeoutMs = Math.min(Math.max(Math.floor(timeoutRaw ?? 30_000), 1_000), 300_000);
  const boundedSql = boundReadSql(sql, limit, offset);
  const db = await open(url);
  const connection = await db.reserve();
  let inTransaction = false;
  try {
    await connection.unsafe("BEGIN READ ONLY");
    inTransaction = true;
    await connection.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    const t0 = performance.now();
    let rows: unknown[][];
    const explain = sqlTokens(boundedSql)[0] === "EXPLAIN";
    // Bun values() preserves native values but exposes no column names. Carry
    // labels alongside positional values; json_object_keys retains duplicate keys.
    const positionalSql = explain ? boundedSql : `SELECT ARRAY(SELECT json_object_keys(row_to_json((SELECT "__tern_shape" FROM (SELECT "__tern_result".*) AS "__tern_shape")))), "__tern_result".* FROM (VALUES (1)) AS "__tern_seed" LEFT JOIN LATERAL (SELECT TRUE AS "__tern_present", "__tern_rows".* FROM (${boundedSql}) AS "__tern_rows") AS "__tern_result" ON TRUE`;
    try {
      if (sqlTokens(boundedSql)[0] === "SHOW") {
        const result = await controlledPg(url, connection, connection.unsafe(boundedSql, params), signal, timeoutMs) as Record<string, unknown>[];
        return {
          columns: Object.keys(result[0] ?? {}),
          rows: result.slice(offset, offset + limit),
          ms: Math.round((performance.now() - t0) * 10) / 10,
          hasMore: result.length > offset + limit, offset,
        };
      }
      const query = connection.unsafe(toPgPlaceholders(positionalSql, params.length), params).values();
      rows = await controlledPg(url, connection, query, signal, timeoutMs) as unknown[][];
    } catch (e) {
      if (e instanceof DbError) throw e;
      throw new DbError("sql", e instanceof Error ? e.message : String(e));
    }
    const labels = explain ? ['QUERY PLAN'] : ((rows[0]?.[0] ?? []) as string[]).slice(1);
    if (!explain) rows = rows.filter(row => row[1] === true);
    const used = new Set(labels);
    const seen = new Set<string>();
    const columns = labels.map(label => {
      let key = label;
      for (let suffix = 2; seen.has(key); suffix++) {
        key = `${label} (${suffix})`;
        if (used.has(key)) { seen.add(key); continue; }
      }
      seen.add(key);
      return key;
    });
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    const wireRows = rows.slice(0, limit).map(row => Object.fromEntries(columns.map((column, i) => [column, encodeDbValue(row[i + (explain ? 0 : 2)])])));
    return { columns, rows: wireRows, ms, hasMore: rows.length > limit, offset };
  } finally {
    if (inTransaction) await connection.unsafe("ROLLBACK").catch(() => {});
    connection.release();
    await db.close().catch(() => {});
  }
}

export async function explainPgQuery(
  url: string,
  sql: string,
  params: unknown[],
  signal?: AbortSignal,
  timeoutRaw?: number,
): Promise<QueryResult> {
  const normalized = assertReadOnlySql(sql);
  const timeoutMs = Math.min(Math.max(Math.floor(timeoutRaw ?? 30_000), 1_000), 300_000);
  const db = await open(url);
  const connection = await db.reserve();
  let inTransaction = false;
  try {
    await connection.unsafe("BEGIN READ ONLY");
    inTransaction = true;
    await connection.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    const t0 = performance.now();
    const result = await controlledPg(url, connection,
      connection.unsafe(`EXPLAIN (FORMAT JSON, ANALYZE FALSE, COSTS TRUE) ${toPgPlaceholders(normalized, params.length)}`, params),
      signal,
      timeoutMs,
    ) as Record<string, unknown>[];
    const rows = result.map((row) => ({ plan: JSON.stringify(row["QUERY PLAN"] ?? row, null, 2) }));
    return { columns: ["plan"], rows, ms: Math.round((performance.now() - t0) * 10) / 10, hasMore: false, offset: 0 };
  } catch (error) {
    if (error instanceof DbError) throw error;
    throw new DbError("sql", error instanceof Error ? error.message : String(error));
  } finally {
    if (inTransaction) await connection.unsafe("ROLLBACK").catch(() => {});
    connection.release();
    await db.close().catch(() => {});
  }
}

export async function runPgExec(url: string, sql: string, signal?: AbortSignal, timeoutMs = 30_000): Promise<ExecResult> {
  const db = await open(url);
  const connection = await db.reserve();
  try {
    const t0 = performance.now();
    let rowsAffected = 0;
    let result: QueryResult | undefined;
    try {
      const rows = await controlledPg(url, connection, connection.unsafe(sql).values(), signal, timeoutMs) as unknown[][];
      rowsAffected = affectedOf(rows);
      if (rows.length > 0 || sqlTokens(sql)[0] === "EXPLAIN") {
        // Bun values() retains duplicate labels' values but exposes no column metadata.
        const columns = sqlTokens(sql)[0] === "EXPLAIN" ? ["QUERY PLAN"] : (rows[0] ?? []).map((_, index) => `Column ${index + 1}`);
        result = { columns, rows: rows.map(row => Object.fromEntries(columns.map((column, index) => [column, encodeDbValue(row[index])]))), ms: 0, hasMore: false, offset: 0 };
      }
    } catch (e) {
      throw new DbError("sql", e instanceof Error ? e.message : String(e));
    }
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    if (result) result.ms = ms;
    return { rowsAffected, ms, ...(result ? { result } : {}) };
  } finally {
    connection.release();
    await db.close().catch(() => {});
  }
}

export async function runPgMigration(url: string, sql: string, apply: boolean, timeoutRaw?: number): Promise<MigrationResult> {
  const script = validateMigrationSql(sql);
  const timeoutMs = Math.min(Math.max(Math.floor(timeoutRaw ?? 30_000), 1_000), 300_000);
  const db = await open(url);
  const connection = await db.reserve();
  const t0 = performance.now();
  let transaction = false;
  try {
    await connection.unsafe("BEGIN");
    transaction = true;
    await connection.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await connection.unsafe(script);
    await connection.unsafe(apply ? "COMMIT" : "ROLLBACK");
    transaction = false;
    return { validated: true, applied: apply, ms: Math.round((performance.now() - t0) * 10) / 10 };
  } catch (error) {
    if (error instanceof DbError) throw error;
    throw new DbError("sql", error instanceof Error ? error.message : String(error));
  } finally {
    if (transaction) await connection.unsafe("ROLLBACK").catch(() => {});
    connection.release();
    await db.close().catch(() => {});
  }
}

export async function testPgConnection(url: string, signal?: AbortSignal): Promise<ConnectionTestResult> {
  const db = await open(url);
  const connection = await db.reserve();
  const t0 = performance.now();
  try {
    const rows = await controlledPg(url, connection, connection.unsafe(
      `SELECT current_database() AS database, current_user AS "user",
              current_setting('server_version') AS server_version`,
    ), signal, 10_000) as Record<string, unknown>[];
    const row = rows[0] ?? {};
    return {
      database: String(row.database ?? ""),
      user: String(row.user ?? ""),
      serverVersion: String(row.server_version ?? ""),
      ms: Math.round((performance.now() - t0) * 10) / 10,
    };
  } catch (error) {
    if (error instanceof DbError) throw error;
    throw new DbError("not_a_database", error instanceof Error ? error.message : String(error));
  } finally {
    connection.release();
    await db.close().catch(() => {});
  }
}

export async function readPgInsights(url: string): Promise<DatabaseInsights> {
  const db = await open(url);
  try {
    const stats = await db.unsafe(
      `SELECT pg_database_size(current_database())::bigint AS database_bytes,
              numbackends AS connections, xact_commit, xact_rollback,
              blks_read, blks_hit, temp_bytes::bigint, deadlocks
         FROM pg_stat_database WHERE datname = current_database()`,
    ) as Record<string, unknown>[];
    const active = await db.unsafe(
      `SELECT pid::text AS id, COALESCE(usename, '') AS "user", state,
              COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000, 0)::bigint AS duration_ms,
              COALESCE(wait_event_type || ':' || wait_event, '') AS wait,
              LEFT(query, 500) AS query, application_name AS application, COALESCE(xact_start::text, '') AS transaction,
              (SELECT count(*)::int FROM pg_locks l WHERE l.pid = pg_stat_activity.pid) AS locks
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
        ORDER BY query_start NULLS LAST`,
    ) as Record<string, unknown>[];
    const tables = await db.unsafe(`SELECT schemaname || '.' || relname AS name,
      pg_total_relation_size(relid)::bigint AS bytes, n_live_tup AS live, n_dead_tup AS dead, seq_scan + idx_scan AS scans
      FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 500`) as Record<string, unknown>[];
    const row = stats[0] ?? {};
    const metrics = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? Number(value) : value as string | number]));
    return {
      metrics,
      tables: tables.map(t => ({ name: String(t.name), bytes: Number(t.bytes), live: Number(t.live), dead: Number(t.dead), scans: Number(t.scans ?? 0) })),
      activity: active.map((item) => ({
        id: String(item.id), user: String(item.user ?? ""), state: String(item.state ?? ""),
        application: String(item.application ?? ""), transaction: String(item.transaction ?? ""), locks: Number(item.locks ?? 0),
        durationMs: Number(item.duration_ms ?? 0), wait: String(item.wait ?? ""), query: String(item.query ?? ""),
      })),
    };
  } catch (error) {
    throw new DbError("sql", error instanceof Error ? error.message : String(error));
  } finally { await db.close().catch(() => {}); }
}

export async function runPgRowChanges(
  url: string,
  changes: RowChange[],
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<RowMutationResult> {
  const statements = compileRowChanges(changes);
  const db = await open(url);
  const connection = await db.reserve();
  const t0 = performance.now();
  let inTransaction = false;
  try {
    await connection.unsafe("BEGIN");
    inTransaction = true;
    await connection.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    let rowsAffected = 0;
    for (const statement of statements) {
      let rows: unknown[];
      try {
        rows = await controlledPg(url, connection,
          connection.unsafe(toPostgresMutationSql(statement.sql), statement.params),
          signal,
          timeoutMs,
        ) as unknown[];
      } catch (error) {
        if (error instanceof DbError) throw error;
        throw new DbError("sql", error instanceof Error ? error.message : String(error));
      }
      const affected = affectedOf(rows);
      if (affected !== 1) {
        throw new DbError("conflict", `${statement.kind} expected one row but matched ${affected}`);
      }
      rowsAffected += affected;
    }
    await connection.unsafe("COMMIT");
    inTransaction = false;
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    return { applied: statements.length, rowsAffected, ms };
  } finally {
    if (inTransaction) await connection.unsafe("ROLLBACK").catch(() => {});
    connection.release();
    await db.close().catch(() => {});
  }
}
