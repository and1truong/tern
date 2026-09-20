// PostgreSQL catalog introspection: information_schema + pg_catalog queries
// assembled into the shared DbSchema shape, plus CREATE-statement synthesis for
// the Structure pane (Postgres has no sqlite_master.sql equivalent).
import { open } from "./connect.ts";
import { awaitControlled, type CancellableQuery } from "./cancel.ts";
import { DbError } from "../../shared/types.ts";
import type { DbSchema, DbTable, DbColumn } from "../../shared/types.ts";

// Introspection queries are fixed SQL but still bounded — a stuck backend or
// a huge catalog must not hang the request (or its pooled socket) forever.
const INTROSPECT_TIMEOUT_MS = 60_000;

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

export async function readPgSchema(url: string, signal?: AbortSignal): Promise<DbSchema> {
  const db = await open(url);
  // A failed reservation must not leak the freshly opened client.
  const connection = await db.reserve().catch(async (error) => { await db.close().catch(() => {}); throw error; });
  const query = (sql: string) => awaitControlled(connection.unsafe(sql) as CancellableQuery<Record<string, unknown>[]>, signal, INTROSPECT_TIMEOUT_MS);
  try {
    await query(`SET statement_timeout = ${INTROSPECT_TIMEOUT_MS}`);
    // Tables + views in user schemas, with column lists in one shot.
    const cols = await query(
      `SELECT t.table_schema, t.table_name, c.column_name, format_type(a.atttypid, a.atttypmod) AS data_type,
              c.is_nullable, c.ordinal_position, c.column_default, a.attislocal,
              CASE WHEN a.attcollation <> typ.typcollation THEN format('%I.%I', cn.nspname, coll.collname) END AS collation,
              pg_get_serial_sequence(format('%I.%I', t.table_schema, t.table_name), c.column_name) AS owned_sequence,
              c.is_identity, c.is_generated, c.identity_generation, c.identity_start, c.identity_increment, c.generation_expression,
              t.table_type, rel.relpersistence, rel.relrowsecurity, rel.relforcerowsecurity,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = rel.oid) AS has_policies,
              seqrel.relpersistence AS sequence_persistence, seq.seqmin, seq.seqmax, seq.seqcache, seq.seqcycle, seq.seqstart, seq.seqincrement, format_type(seq.seqtypid, NULL) AS sequence_type, pg_get_partkeydef(rel.oid) AS partition_key,
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
         LEFT JOIN pg_class seqrel ON seqrel.oid = seq.seqrelid
         LEFT JOIN pg_type typ ON typ.oid = a.atttypid
         LEFT JOIN pg_collation coll ON coll.oid = a.attcollation
         LEFT JOIN pg_namespace cn ON cn.oid = coll.collnamespace
        WHERE t.table_schema NOT IN ('pg_catalog','information_schema')
          AND t.table_type IN ('BASE TABLE','VIEW','FOREIGN')
        ORDER BY t.table_schema, t.table_name, c.ordinal_position`,
    ) as Record<string, unknown>[];

    const materializedColumns = await query(
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

    const materializedDefinitions = await query(
      `SELECT schemaname AS table_schema, matviewname AS table_name, definition, ispopulated
         FROM pg_matviews
        WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
    ) as Record<string, unknown>[];
    const materializedDdl = new Map(materializedDefinitions.map((row) => [
      `${row.table_schema}\0${row.table_name}`,
      `CREATE MATERIALIZED VIEW "${String(row.table_schema).replace(/"/g, '""')}"."${String(row.table_name).replace(/"/g, '""')}" AS\n${String(row.definition ?? "").trim().replace(/;$/, "")}${row.ispopulated === false ? "\nWITH NO DATA" : ""};`,
    ]));
    const viewDefinitions = await query(
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

    const comparableRows = await query(
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
               OR (candidate.typtype = 'r' AND input_type.typname IN ('anyrange','anycompatiblerange') AND input_type.typname IN ('anyrange','anycompatiblerange'))
               OR (candidate.typtype = 'm' AND input_type.typname = 'anymultirange')
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
              ) AS is_comparable,
              EXISTS (
                SELECT 1 FROM pg_opclass opc
                  JOIN pg_am am ON am.oid = opc.opcmethod
                  JOIN pg_type input_type ON input_type.oid = opc.opcintype
                WHERE opc.opcdefault AND am.amname = 'btree' AND (
                  opc.opcintype = effective.oid
                  OR EXISTS (SELECT 1 FROM pg_cast c WHERE c.castsource = effective.oid AND c.casttarget = opc.opcintype AND c.castcontext = 'i' AND c.castmethod = 'b')
                  OR (effective.typtype = 'e' AND input_type.typname = 'anyenum')
                  OR (effective.typtype = 'r' AND input_type.typname = 'anyrange')
                  OR (effective.typtype = 'm' AND input_type.typname = 'anymultirange')
                )
              ) AS is_orderable
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
    const orderable = new Map(comparableRows.map(row => [`${row.table_schema}\0${row.table_name}\0${row.column_name}`, row.is_orderable === true]));
    const comparable = new Map(comparableRows.map((row) => [
      `${row.table_schema}\0${row.table_name}\0${row.column_name}`,
      row.is_comparable === true,
    ]));

    // Primary keys and foreign-key targets, keyed by table+column.
    const keys = await query(
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
    const counts = await query(
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
        orderable: orderable.get(keyId) ?? false,
      };
      tbl.columns.push(col);
    }
    const tables = [...byTable.values()];
    for (const table of tables) {
      const prefix = `${table.schema}\0${table.name}\0`;
      table.uniqueKeys = [...uniqueGroups.entries()].filter(([key]) => key.startsWith(prefix)).map(([, columns]) => columns);
    }
    // Synthesize a minimal CREATE statement per table for the Structure pane's
    const idx = await query(
      `SELECT p.schemaname AS schema, p.tablename AS table_name, p.indexname AS name, p.indexdef AS sql,
              EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid AND con.contype IN ('p','u','x')) AS constraint_backed,
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

    const trg = await query(
      `SELECT n.nspname AS schema, c.relname AS table_name, t.tgname AS name,
              CASE WHEN t.tgtype & 2 <> 0 THEN 'BEFORE' WHEN t.tgtype & 64 <> 0 THEN 'INSTEAD OF' ELSE 'AFTER' END AS timing,
              concat_ws(' OR ', CASE WHEN t.tgtype & 4 <> 0 THEN 'INSERT' END, CASE WHEN t.tgtype & 16 <> 0 THEN 'UPDATE' END,
                CASE WHEN t.tgtype & 8 <> 0 THEN 'DELETE' END, CASE WHEN t.tgtype & 32 <> 0 THEN 'TRUNCATE' END) AS event,
              pg_get_triggerdef(t.oid) AS sql, t.tgenabled AS enabled, t.tgparentid = 0 AS local
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog','information_schema')
        ORDER BY t.tgname`,
    ) as Record<string, unknown>[];
    const triggers = trg.map((r) => ({
      name: String(r.name), schema: String(r.schema), table: String(r.table_name),
      timing: String(r.timing), event: String(r.event), sql: String(r.sql ?? ""),
    }));

    const constraintRows = await query(
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
        // Unique indexes carry CONCURRENTLY refresh; plain indexes carry reads.
        for (const index of idx.filter(index => index.schema === t.schema && index.table_name === t.name && !index.constraint_backed)) t.ddl += `\n${index.sql};`;
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
      const sequenceDdl: string[] = [];
      const ownershipDdl: string[] = [];
      const definitions = t.columns.flatMap(c => {
        const metadata = cols.find(row => row.table_schema === t.schema && row.table_name === t.name && row.column_name === c.name)!;
        if (inherits && metadata.attislocal === false) return [];
        if (!c.identity && metadata.owned_sequence) {
          sequenceDdl.push(`CREATE ${metadata.sequence_persistence === "u" ? "UNLOGGED " : metadata.sequence_persistence === "t" ? "TEMPORARY " : ""}SEQUENCE ${metadata.owned_sequence} AS ${metadata.sequence_type} START WITH ${metadata.seqstart} INCREMENT BY ${metadata.seqincrement} MINVALUE ${metadata.seqmin} MAXVALUE ${metadata.seqmax} CACHE ${metadata.seqcache} ${metadata.seqcycle ? "CYCLE" : "NO CYCLE"};`);
          ownershipDdl.push(`ALTER SEQUENCE ${metadata.owned_sequence} OWNED BY "${t.schema!.replace(/"/g, '""')}"."${t.name.replace(/"/g, '""')}"."${c.name.replace(/"/g, '""')}";`);
        }
        const generation = c.identity
          ? ` GENERATED ${metadata.identity_generation} AS IDENTITY (START WITH ${metadata.identity_start} INCREMENT BY ${metadata.identity_increment} MINVALUE ${metadata.seqmin} MAXVALUE ${metadata.seqmax} CACHE ${metadata.seqcache} ${metadata.seqcycle ? "CYCLE" : "NO CYCLE"})`
          : c.generated ? ` GENERATED ALWAYS AS (${metadata.generation_expression}) STORED`
          : c.defaultValue != null ? ` DEFAULT ${c.defaultValue}` : '';
        return `  "${c.name.replace(/"/g, '""')}" ${c.type}${metadata.collation ? ` COLLATE ${metadata.collation}` : ""}${generation}${c.notNull ? " NOT NULL" : ""}`;
      });
      for (const constraint of constraints.filter(c => c.schema === t.schema && c.table === t.name)) {
        if (inherits && constraintRows.some(row => row.schema === t.schema && row.table_name === t.name && row.name === constraint.name && row.conislocal === false)) continue;
        definitions.push(`  CONSTRAINT "${constraint.name.replace(/"/g, '""')}" ${constraint.definition}`);
      }
      const body = definitions.join(",\n");
      const relation = `"${t.schema!.replace(/"/g, '""')}"."${t.name.replace(/"/g, '""')}"`;
      t.ddl = `CREATE ${metadata.relpersistence === "u" ? "UNLOGGED " : ""}TABLE ${relation} (\n${body}\n)${inherits}${metadata.partition_key ? ` PARTITION BY ${metadata.partition_key}` : ""};`;
      t.ddl = [...sequenceDdl, t.ddl, ...ownershipDdl].join("\n");
      if (metadata.partition_bound) t.ddl += `\nALTER TABLE ${metadata.parent_relation} ATTACH PARTITION ${relation} ${metadata.partition_bound};`;
      for (const index of idx.filter(index => index.schema === t.schema && index.table_name === t.name && !index.constraint_backed)) t.ddl += `\n${index.sql};`;
      for (const trigger of trg.filter(trigger => trigger.schema === t.schema && trigger.table_name === t.name)) {
        if (trigger.local) t.ddl += `\n${trigger.sql};`;
        if (trigger.enabled !== 'O' || !trigger.local) {
          const mode = trigger.enabled === 'D' ? 'DISABLE' : trigger.enabled === 'R' ? 'ENABLE REPLICA' : trigger.enabled === 'A' ? 'ENABLE ALWAYS' : 'ENABLE';
          t.ddl += `\nALTER TABLE ${relation} ${mode} TRIGGER "${String(trigger.name).replace(/"/g, '""')}";`;
        }
      }
    }

    const sequenceRows = await query(
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

    const routineRows = await query(
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

    const extensionRows = await query(
      `SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname`,
    ) as Record<string, unknown>[];
    const extensions = extensionRows.map((row) => ({ name: String(row.name), definition: String(row.version ?? "") }));

    // Postgres has no pragmas; surface server metadata in the same kv shape so
    // the existing PragmasPane renders it unchanged.
    const meta = await query(
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
    connection.release();
    await db.close().catch(() => {});
  }
}
