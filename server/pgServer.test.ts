import { executionUnits, splitSqlStatements, isWriteSql } from "../src/sqlConsole.ts";
import { buildRowChanges, editKey } from "../src/dataGrid.ts";
import { serializeRows } from "../src/dataTransfer.ts";
import { compileGroup } from "../src/dbFilter.ts";
import { describe, test, expect } from "bun:test";
import { collectPgKeyMetadata, toPgPlaceholders, readPgSchema, runPgQuery, runPgExec, runPgRowChanges, runPgMigration } from "./pgServer.ts";
import { DbError } from "../shared.ts";

describe("toPgPlaceholders", () => {
  test("numbers ? positionally", () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
  });

  test("leaves ? inside string literals alone", () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE name = 'a?b' AND id = ?")).toBe(
      "SELECT * FROM t WHERE name = 'a?b' AND id = $1",
    );
  });

  test("leaves ? inside quoted identifiers alone", () => {
    expect(toPgPlaceholders('SELECT "we?rd" FROM t WHERE id = ?')).toBe(
      'SELECT "we?rd" FROM t WHERE id = $1',
    );
  });

  test("handles doubled-quote escapes", () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE x = 'it''s ? here' AND y = ?")).toBe(
      "SELECT * FROM t WHERE x = 'it''s ? here' AND y = $1",
    );
  });

  test("keeps backslash escapes inside PostgreSQL E-strings", () => {
    expect(toPgPlaceholders("SELECT E'it\\'s ? literal', ?::int", 1)).toBe(
      "SELECT E'it\\'s ? literal', $1::int",
    );
  });

  test("tracks nested PostgreSQL block comments", () => {
    expect(toPgPlaceholders("SELECT /* outer /* inner */ ? still outer */ ?::int", 1)).toBe(
      "SELECT /* outer /* inner */ ? still outer */ $1::int",
    );
  });

  test("no placeholders is a no-op", () => {
    expect(toPgPlaceholders("SELECT 1")).toBe("SELECT 1");
  });

  test("preserves PostgreSQL JSON operators and dollar-quoted content", () => {
    expect(toPgPlaceholders("SELECT payload ? 'key', payload ?| array['a'], payload ?& array['b'] FROM events", 0)).toBe(
      "SELECT payload ? 'key', payload ?| array['a'], payload ?& array['b'] FROM events",
    );
    expect(toPgPlaceholders("SELECT $$ ? $$, $body$ ?| ?& $body$, ?::int", 1)).toBe(
      "SELECT $$ ? $$, $body$ ?| ?& $body$, $1::int",
    );
    expect(toPgPlaceholders("SELECT * FROM events WHERE payload ? 'key' AND id = ?", 1)).toBe(
      "SELECT * FROM events WHERE payload ? 'key' AND id = $1",
    );
    expect(toPgPlaceholders("SELECT * FROM events WHERE id = ? AND payload ? 'key'", 1)).toBe(
      "SELECT * FROM events WHERE id = $1 AND payload ? 'key'",
    );
    expect(toPgPlaceholders("SELECT payload @? '$.key', id = ? FROM events", 1)).toBe(
      "SELECT payload @? '$.key', id = $1 FROM events",
    );
  });
});

test("pairs composite foreign-key columns by catalog ordinal", () => {
  const metadata = collectPgKeyMetadata([
    { table_schema: "audit", table_name: "events", constraint_name: "events_tenant_actor_fkey", constraint_type: "FOREIGN KEY", column_name: "tenant_id", ref_schema: "core", ref_table: "users", ref_column: "tenant_id" },
    { table_schema: "audit", table_name: "events", constraint_name: "events_tenant_actor_fkey", constraint_type: "FOREIGN KEY", column_name: "actor_id", ref_schema: "core", ref_table: "users", ref_column: "id" },
  ]);
  expect(metadata.foreign.get("audit\0events\0tenant_id")).toEqual(["core.users(tenant_id)"]);
  expect(metadata.foreign.get("audit\0events\0actor_id")).toEqual(["core.users(id)"]);
});

// Integration tests require a live Postgres. Set TEST_PG_URL to enable, e.g.
//   TEST_PG_URL=postgres://postgres:pw@localhost:5432/postgres bun test pgServer
const PG = process.env.TEST_PG_URL;
const pgDescribe = PG ? describe : describe.skip;

pgDescribe("pgServer (live)", () => {
  const url = PG!;
  const T = "pgserver_test_t";

  test("unique indexes provide row identity without partial, expression or INCLUDE columns", async () => {
    await runPgExec(url, 'CREATE SCHEMA pgserver_unique_index_test');
    try {
      await runPgExec(url, `CREATE TABLE pgserver_unique_index_test.items (tenant integer NOT NULL, code text NOT NULL, note text, other text NOT NULL UNIQUE);
        CREATE UNIQUE INDEX items_identity ON pgserver_unique_index_test.items (tenant, code) INCLUDE (note);
        CREATE UNIQUE INDEX items_partial ON pgserver_unique_index_test.items (note) WHERE note IS NOT NULL;
        CREATE UNIQUE INDEX items_expression ON pgserver_unique_index_test.items (lower(code));
        INSERT INTO pgserver_unique_index_test.items VALUES (1, 'a', 'old', 'one');`);
      const table = (await readPgSchema(url)).tables.find(t => t.schema === 'pgserver_unique_index_test' && t.name === 'items')!;
      expect(table.uniqueKeys).toEqual([['other'], ['tenant', 'code']]);
      // Exercise the standalone index independently of the constraint-backed key.
      const rows = (await runPgQuery(url, 'SELECT tenant, code, note, other FROM pgserver_unique_index_test.items', [])).rows;
      const changes = buildRowChanges({ ...table, uniqueKeys: table.uniqueKeys!.filter(key => key.includes('tenant')) }, rows, { [editKey(0, 'note')]: 'new' }, new Set(), []);
      expect(changes[0]).toMatchObject({ kind: 'update', key: { tenant: 1, code: 'a' } });
      await runPgRowChanges(url, changes);
      expect((await runPgQuery(url, 'SELECT note FROM pgserver_unique_index_test.items', [])).rows).toEqual([{ note: 'new' }]);
    } finally { await runPgExec(url, 'DROP SCHEMA pgserver_unique_index_test CASCADE'); }
  });

  test("DDL preserves default, serial, identity and generated behavior", async () => {
    await runPgExec(url, 'CREATE SCHEMA pgserver_defaults_test');
    try {
      await runPgExec(url, `CREATE TABLE pgserver_defaults_test.original (
        id integer GENERATED ALWAYS AS IDENTITY (START WITH 10 INCREMENT BY 2),
        serial_id serial, amount integer DEFAULT 7,
        doubled integer GENERATED ALWAYS AS (amount * 2) STORED
      )`);
      const table = (await readPgSchema(url)).tables.find(t => t.schema === 'pgserver_defaults_test' && t.name === 'original')!;
      await runPgExec(url, 'INSERT INTO pgserver_defaults_test.original DEFAULT VALUES');
      await runPgExec(url, 'DROP TABLE pgserver_defaults_test.original');
      await runPgExec(url, table.ddl!.replace('"original"', '"copy"'));
      await runPgExec(url, 'INSERT INTO pgserver_defaults_test.copy DEFAULT VALUES');
      await runPgExec(url, 'INSERT INTO pgserver_defaults_test.copy DEFAULT VALUES');
      expect((await runPgQuery(url, 'SELECT * FROM pgserver_defaults_test.copy ORDER BY id', [])).rows).toEqual([
        { id: 10, serial_id: 1, amount: 7, doubled: 14 },
        { id: 12, serial_id: 2, amount: 7, doubled: 14 },
      ]);
    } finally { await runPgExec(url, 'DROP SCHEMA pgserver_defaults_test CASCADE'); }
  });

  test("console transaction scripts roll back on failure on one connection", async () => {
    await runPgExec(url, 'CREATE TABLE public.pgserver_transaction_test(v integer); INSERT INTO public.pgserver_transaction_test VALUES(1)');
    try {
      const script = 'BEGIN; UPDATE public.pgserver_transaction_test SET v=2; SELECT missing FROM public.pgserver_transaction_test; ROLLBACK;';
      const units = executionUnits(splitSqlStatements(script, 'postgres').map(s => s.sql), 'postgres');
      await expect(runPgExec(url, units.statements[0])).rejects.toThrow();
      expect((await runPgQuery(url, 'SELECT v FROM public.pgserver_transaction_test', [])).rows).toEqual([{ v: 1 }]);
    } finally { await runPgExec(url, 'DROP TABLE public.pgserver_transaction_test'); }
  });

  test("dotted relation names stay separate and noncomparable filters execute", async () => {
    await runPgExec(url, 'CREATE SCHEMA pgserver_dot_test');
    await runPgExec(url, 'CREATE TABLE public."pgserver_dot_test.logs" (id integer PRIMARY KEY)');
    try {
      await runPgExec(url, 'CREATE TABLE pgserver_dot_test.logs (message text, document json, point_value point)');
      const schema = await readPgSchema(url);
      expect(schema.tables.find(t => t.schema === 'public' && t.name === 'pgserver_dot_test.logs')!.columns.map(c => c.name)).toEqual(['id']);
      const table = schema.tables.find(t => t.schema === 'pgserver_dot_test' && t.name === 'logs')!;
      expect(table.columns.map(c => c.name)).toEqual(['message', 'document', 'point_value']);
      await runPgExec(url, `INSERT INTO pgserver_dot_test.logs VALUES ('ok', '{"a":1}', '(1,2)')`);
      for (const [name, value] of [['document', '{"a":1}'], ['point_value', '(1,2)']]) {
        const filter = compileGroup({ id: 'g', combinator: 'AND', rules: [{ id: 'r', col: table.columns.findIndex(c => c.name === name), op: 'equals', value }] }, table.columns, 'postgres');
        expect((await runPgQuery(url, `SELECT message FROM pgserver_dot_test.logs WHERE ${filter.where}`, filter.params)).rows).toEqual([{ message: 'ok' }]);
      }
    } finally {
      await runPgExec(url, 'DROP TABLE public."pgserver_dot_test.logs"');
      await runPgExec(url, 'DROP SCHEMA pgserver_dot_test CASCADE');
    }
  });

  test("quoted mutation identifiers and migration rollback guard", async () => {
    const table = { schema: 'public', name: 'pgserver_question_test' };
    await runPgExec(url, 'CREATE TABLE public.pgserver_question_test (id integer PRIMARY KEY, "why?" text)');
    try {
      await runPgRowChanges(url, [{ kind: 'insert', table, values: { id: 1, 'why?': 'before' } }]);
      await runPgRowChanges(url, [{ kind: 'update', table, key: { id: 1 }, expected: { 'why?': 'before' }, values: { 'why?': 'after' } }]);
      expect((await runPgQuery(url, 'SELECT "why?" FROM public.pgserver_question_test', [])).rows).toEqual([{ 'why?': 'after' }]);
      await expect(runPgMigration(url, "INSERT INTO public.pgserver_question_test VALUES (2, 'bad'); SELECT '\\'; COMMIT; SELECT '';", false)).rejects.toThrow();
      expect((await runPgQuery(url, 'SELECT id FROM public.pgserver_question_test ORDER BY id', [])).rows).toEqual([{ id: 1 }]);
    } finally { await runPgExec(url, 'DROP TABLE public.pgserver_question_test'); }
  });

  test("DDL replay enforces unique, foreign key, check and exclusion constraints", async () => {
    await runPgExec(url, 'CREATE SCHEMA pgserver_constraints_test');
    try {
      await runPgExec(url, 'CREATE TABLE pgserver_constraints_test.parent (id integer PRIMARY KEY)');
      await runPgExec(url, `CREATE TABLE pgserver_constraints_test.original (
        id integer PRIMARY KEY, code text UNIQUE, parent_id integer REFERENCES pgserver_constraints_test.parent(id),
        amount integer CONSTRAINT "custom check" CHECK (amount > 0), span int4range, EXCLUDE USING gist (span WITH &&)
      )`);
      const table = (await readPgSchema(url)).tables.find(t => t.schema === 'pgserver_constraints_test' && t.name === 'original')!;
      await runPgExec(url, 'DROP TABLE pgserver_constraints_test.original');
      await runPgExec(url, table.ddl!.replace('"original"', '"copy"'));
      expect((await readPgSchema(url)).constraints?.some(c => c.table === 'copy' && c.name === 'custom check')).toBe(true);
      await runPgExec(url, 'INSERT INTO pgserver_constraints_test.parent VALUES (1)');
      await runPgExec(url, "INSERT INTO pgserver_constraints_test.copy VALUES (1, 'one', 1, 1, '[1,5)')");
      for (const values of ["(2, 'one', 1, 1, '[6,9)')", "(2, 'two', 99, 1, '[6,9)')", "(2, 'two', 1, -1, '[6,9)')", "(2, 'two', 1, 1, '[2,6)')"]) {
        await expect(runPgExec(url, `INSERT INTO pgserver_constraints_test.copy VALUES ${values}`)).rejects.toThrow();
      }
    } finally { await runPgExec(url, 'DROP SCHEMA pgserver_constraints_test CASCADE'); }
  });

  test("SHOW returns named read-only results with paging", async () => {
    const path = await runPgQuery(url, '/* inspect */ SHOW search_path', []);
    expect(path.columns).toEqual(['search_path']);
    expect(typeof path.rows[0].search_path).toBe('string');
    const isolation = await runPgQuery(url, 'SHOW transaction_isolation', []);
    expect(isolation.columns).toEqual(['transaction_isolation']);
    const all = await runPgQuery(url, 'SHOW ALL', [], 1, 1);
    expect(all.columns).toEqual(['name', 'setting', 'description']);
    expect(all.rows).toHaveLength(1);
    expect(all.hasMore).toBe(true);
  });

  test("empty results retain duplicate column headers and catalog types replay", async () => {
    const empty = await runPgQuery(url, 'SELECT 1 AS id, 2 AS id WHERE false', []);
    expect(empty.columns).toEqual(['id', 'id (2)']);
    expect(empty.rows).toEqual([]);
    await runPgExec(url, 'CREATE SCHEMA pgserver_types_test');
    try {
      await runPgExec(url, "CREATE TYPE pgserver_types_test.mood AS ENUM ('ok')");
      await runPgExec(url, 'CREATE DOMAIN pgserver_types_test.positive AS numeric CHECK (VALUE > 0)');
      await runPgExec(url, 'CREATE TABLE pgserver_types_test.original (tags text[], mood pgserver_types_test.mood, amount pgserver_types_test.positive)');
      const table = (await readPgSchema(url)).tables.find(t => t.schema === 'pgserver_types_test' && t.name === 'original')!;
      expect(table.columns.map(c => c.type)).toEqual(['text[]', 'pgserver_types_test.mood', 'pgserver_types_test.positive']);
      await runPgExec(url, table.ddl!.replace('"original"', '"copy"'));
    } finally { await runPgExec(url, 'DROP SCHEMA pgserver_types_test CASCADE'); }
  });

  test("duplicate labels, exact numeric filters and array exports round-trip", async () => {
    const duplicate = await runPgQuery(url, 'SELECT 11 AS id, 22 AS id, 33 AS "id (2)"', []);
    expect(new Set(duplicate.columns).size).toBe(3);
    expect(duplicate.columns.map(c => duplicate.rows[0][c])).toEqual([11, 22, 33]);
    await runPgExec(url, 'CREATE TABLE public.pgserver_transfer_test (id bigint, amount numeric, tags text[], nums integer[], matrix integer[][], document jsonb)');
    try {
      await runPgExec(url, `INSERT INTO public.pgserver_transfer_test VALUES (9007199254740993, 1.1234567890123456789, ARRAY['a,b', 'NULL', NULL, ''], ARRAY[1,2], ARRAY[[1,2],[3,4]], '[1,2]')`);
      const schema = await readPgSchema(url);
      const table = schema.tables.find(t => t.name === 'pgserver_transfer_test')!;
      for (const [name, value] of [['id', '9007199254740993'], ['amount', '1.1234567890123456789']]) {
        const filter = compileGroup({ id: 'g', combinator: 'AND', rules: [{ id: 'r', col: table.columns.findIndex(c => c.name === name), op: 'equals', value }] }, table.columns, 'postgres');
        const result = await runPgQuery(url, `SELECT id::text FROM public.pgserver_transfer_test WHERE ${filter.where}`, filter.params);
        expect(result.rows).toEqual([{ id: '9007199254740993' }]);
      }
      const before = await runPgQuery(url, 'SELECT tags, nums, matrix, document FROM public.pgserver_transfer_test', []);
      await runPgExec(url, serializeRows('sql', before.columns, before.rows, table));
      const after = await runPgQuery(url, 'SELECT tags, nums, matrix, document FROM public.pgserver_transfer_test', []);
      expect(after.rows).toEqual([before.rows[0], before.rows[0]]);
      const special = { tags: ['quote"', "apostrophe'", 'back\\slash', 'NULL', null, ''], nums: [], matrix: [], document: [1, 2] };
      await runPgExec(url, serializeRows('sql', before.columns, [special], table));
      const restored = await runPgQuery(url, 'SELECT tags, nums, matrix, document FROM public.pgserver_transfer_test WHERE cardinality(nums) = 0', []);
      expect(restored.rows).toEqual([special]);
    } finally { await runPgExec(url, 'DROP TABLE public.pgserver_transfer_test'); }
  });

  test("composite primary key DDL replays in catalog key order", async () => {
    await runPgExec(url, 'CREATE SCHEMA pgserver_ddl_test');
    try {
      await runPgExec(url, 'CREATE TABLE pgserver_ddl_test.original (a integer, b integer, PRIMARY KEY (b, a))');
      const schema = await readPgSchema(url);
      const ddl = schema.tables.find(t => t.schema === 'pgserver_ddl_test' && t.name === 'original')!.ddl!;
      expect(ddl).toContain('PRIMARY KEY (b, a)');
      await runPgExec(url, 'DROP TABLE pgserver_ddl_test.original');
      await runPgExec(url, ddl.replace('"original"', '"copy"'));
    } finally { await runPgExec(url, 'DROP SCHEMA pgserver_ddl_test CASCADE'); }
  });

  test("catalog skips aggregates while retaining functions and procedures", async () => {
    await runPgExec(url, 'CREATE SCHEMA pgserver_aggregate_test');
    try {
      await runPgExec(url, `CREATE AGGREGATE pgserver_aggregate_test.total(integer) (SFUNC = int4pl, STYPE = integer, INITCOND = '0')`);
      await runPgExec(url, `CREATE FUNCTION pgserver_aggregate_test.answer() RETURNS integer LANGUAGE sql AS 'SELECT 42'`);
      await runPgExec(url, `CREATE PROCEDURE pgserver_aggregate_test.noop() LANGUAGE sql AS 'SELECT 1'`);
      const schema = await readPgSchema(url);
      expect(schema.routines?.filter(r => r.schema === 'pgserver_aggregate_test').map(r => r.name).sort()).toEqual(['answer()', 'noop()']);
    } finally { await runPgExec(url, 'DROP SCHEMA pgserver_aggregate_test CASCADE'); }
  });

  test("exec rejects nothing / read+schema round-trip", async () => {
    await runPgExec(url, `DROP TABLE IF EXISTS ${T}`);
    await runPgExec(url, `DROP TYPE IF EXISTS ${T}_mood`);
    await runPgExec(url, `CREATE TYPE ${T}_mood AS ENUM ('active', 'paused')`);
    await runPgExec(url, `CREATE TABLE ${T} (
      id serial PRIMARY KEY, email text NOT NULL, age int, document xml,
      mood ${T}_mood, tags text[], labels varchar[], active_period int4range, raw_documents xml[]
    )`);
    const ins = await runPgExec(url, `INSERT INTO ${T} (email, age) VALUES ('a@x', 21), ('b@x', 9)`);
    expect(ins.rowsAffected).toBe(2);

    const schema = await readPgSchema(url);
    const tbl = schema.tables.find((t) => t.name === T);
    expect(tbl).toBeTruthy();
    expect(tbl!.schema).toBe("public");
    expect(tbl!.columns.map((c) => c.name)).toEqual(["id", "email", "age", "document", "mood", "tags", "labels", "active_period", "raw_documents"]);
    expect(tbl!.columns.find((c) => c.name === "id")!.pk).toBe(true);
    expect(tbl!.columns.find((c) => c.name === "email")!.notNull).toBe(true);
    expect(tbl!.columns.find((c) => c.name === "email")!.comparable).toBe(true);
    expect(tbl!.columns.find((c) => c.name === "document")!.comparable).toBe(false);
    expect(tbl!.columns.find((c) => c.name === "mood")!.comparable).toBe(true);
    expect(tbl!.columns.find((c) => c.name === "tags")!.comparable).toBe(true);
    expect(tbl!.columns.find((c) => c.name === "labels")!.comparable).toBe(true);
    expect(tbl!.columns.find((c) => c.name === "active_period")!.comparable).toBe(true);
    expect(tbl!.columns.find((c) => c.name === "raw_documents")!.comparable).toBe(false);
    expect(schema.pragmas.database).toBeTruthy();

    await runPgExec(url, `DROP TABLE ${T}`);
    await runPgExec(url, `DROP TYPE ${T}_mood`);
  });

  test("query rewrites ? params and returns rows", async () => {
    await runPgExec(url, `DROP TABLE IF EXISTS ${T}`);
    await runPgExec(url, `CREATE TABLE ${T} (id int, email text)`);
    await runPgExec(url, `INSERT INTO ${T} VALUES (1, 'a@x'), (2, 'b@x')`);

    const r = await runPgQuery(url, `SELECT email FROM ${T} WHERE id = ?`, [2], 100);
    expect(r.columns).toEqual(["email"]);
    expect(r.rows).toEqual([{ email: "b@x" }]);

    await runPgExec(url, `DROP TABLE ${T}`);
  });

  test("writable EXPLAIN ANALYZE returns a plan and executes exactly once", async () => {
    await runPgExec(url, 'CREATE TABLE public.pgserver_explain_test(v integer); INSERT INTO public.pgserver_explain_test VALUES(0)');
    try {
      const sql = 'EXPLAIN (ANALYZE TRUE, FORMAT JSON) UPDATE public.pgserver_explain_test SET v=v+1';
      await expect(runPgQuery(url, sql, [])).rejects.toBeInstanceOf(DbError);
      const executed = await runPgExec(url, sql);
      expect(executed.result?.columns).toEqual(['QUERY PLAN']);
      expect(executed.result?.rows).toHaveLength(1);
      expect((await runPgQuery(url, 'SELECT v FROM public.pgserver_explain_test', [])).rows).toEqual([{ v: 1 }]);
    } finally { await runPgExec(url, 'DROP TABLE public.pgserver_explain_test'); }
  });

  test("catalog retains multiple foreign keys on the same column", async () => {
    await runPgExec(url, 'CREATE TABLE public.fk_target_a(id integer PRIMARY KEY); CREATE TABLE public.fk_target_b(id integer PRIMARY KEY); CREATE TABLE public.fk_source(id integer REFERENCES public.fk_target_a(id) REFERENCES public.fk_target_b(id))');
    try {
      const schema = await readPgSchema(url);
      expect(schema.tables.find(t => t.name === 'fk_source')?.columns[0].fk).toEqual(['public.fk_target_a(id)', 'public.fk_target_b(id)']);
    } finally { await runPgExec(url, 'DROP TABLE public.fk_source, public.fk_target_a, public.fk_target_b'); }
  });

  test("DML RETURNING preserves requested rows", async () => {
    await runPgExec(url, 'CREATE TABLE public.pgserver_returning_test(id integer)');
    try {
      const inserted = await runPgExec(url, 'INSERT INTO public.pgserver_returning_test VALUES(7) RETURNING id');
      expect(inserted.result?.columns).toEqual(['Column 1']);
      expect(inserted.result?.rows).toEqual([{ 'Column 1': 7 }]);
      expect((await runPgExec(url, 'DELETE FROM public.pgserver_returning_test RETURNING id AS x, id+1 AS x')).result?.rows).toEqual([{ 'Column 1': 7, 'Column 2': 8 }]);
    } finally { await runPgExec(url, 'DROP TABLE public.pgserver_returning_test'); }
  });

  test("foreign tables appear in the catalog and can be queried", async () => {
    const location = (await runPgQuery(url, 'SELECT current_database() AS db, current_user AS username, inet_server_port() AS port', [])).rows[0];
    const literal = (value: unknown) => String(value).replaceAll("'", "''");
    await runPgExec(url, `CREATE EXTENSION IF NOT EXISTS postgres_fdw; CREATE SERVER pgserver_fdw_test FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host '127.0.0.1', dbname '${literal(location.db)}', port '${literal(location.port)}'); CREATE USER MAPPING FOR CURRENT_USER SERVER pgserver_fdw_test OPTIONS (user '${literal(location.username)}'); CREATE FOREIGN TABLE public.pgserver_foreign_test(relname name) SERVER pgserver_fdw_test OPTIONS (schema_name 'pg_catalog', table_name 'pg_class')`);
    try {
      const table = (await readPgSchema(url)).tables.find(t => t.name === 'pgserver_foreign_test');
      expect(table?.type).toBe('table');
      expect(table?.ddl).toBe('');
      expect(table?.columns.map(c => c.name)).toEqual(['relname']);
      expect((await runPgQuery(url, 'SELECT * FROM public.pgserver_foreign_test', [], 1)).rows).toHaveLength(1);
    } finally { await runPgExec(url, 'DROP SERVER pgserver_fdw_test CASCADE'); }
  });

  test("DDL replay retains view security, check options and column collations", async () => {
    await runPgExec(url, `CREATE SCHEMA tern_ddl_options;
      CREATE COLLATION tern_ddl_options."Case Collation" FROM "C";
      CREATE TABLE tern_ddl_options.items (name text COLLATE tern_ddl_options."Case Collation");
      CREATE VIEW tern_ddl_options.visible WITH (security_invoker=true, security_barrier=true) AS
        SELECT name FROM tern_ddl_options.items WHERE name <> '' WITH LOCAL CHECK OPTION`);
    try {
      const schema = await readPgSchema(url);
      const table = schema.tables.find(t => t.schema === 'tern_ddl_options' && t.name === 'items')!;
      const view = schema.tables.find(t => t.schema === 'tern_ddl_options' && t.name === 'visible')!;
      expect(table.ddl).toContain('COLLATE tern_ddl_options."Case Collation"');
      await runPgExec(url, 'DROP VIEW tern_ddl_options.visible; DROP TABLE tern_ddl_options.items');
      await runPgExec(url, table.ddl + view.ddl);
      const options = await runPgQuery(url, `SELECT option_name, option_value FROM pg_class c,
        LATERAL pg_options_to_table(c.reloptions) WHERE c.oid = 'tern_ddl_options.visible'::regclass`, []);
      expect(Object.fromEntries(options.rows.map(r => [r.option_name, r.option_value]))).toEqual({
        security_invoker: 'true', security_barrier: 'true', check_option: 'local',
      });
      const collation = await runPgQuery(url, `SELECT a.attcollation = 'tern_ddl_options."Case Collation"'::regcollation AS retained
        FROM pg_attribute a WHERE a.attrelid = 'tern_ddl_options.items'::regclass AND a.attname = 'name'`, []);
      expect(collation.rows[0]?.retained).toBe(true);
      await expect(runPgExec(url, "INSERT INTO tern_ddl_options.visible VALUES ('')")).rejects.toThrow();
    } finally { await runPgExec(url, 'DROP SCHEMA tern_ddl_options CASCADE'); }
  });

  test("DDL replay preserves unlogged table persistence", async () => {
    await runPgExec(url, 'CREATE UNLOGGED TABLE public.tern_unlogged_test(id integer)');
    try {
      const table = (await readPgSchema(url)).tables.find(t => t.schema === 'public' && t.name === 'tern_unlogged_test')!;
      expect(table.ddl).toStartWith('CREATE UNLOGGED TABLE');
      await runPgExec(url, 'DROP TABLE public.tern_unlogged_test');
      await runPgExec(url, table.ddl);
      const result = await runPgQuery(url, "SELECT relpersistence FROM pg_class WHERE oid = 'public.tern_unlogged_test'::regclass", []);
      expect(result.rows[0]?.relpersistence).toBe('u');
    } finally { await runPgExec(url, 'DROP TABLE public.tern_unlogged_test'); }
  });

  test("SQL exports preserve identity keys and advance owned sequences", async () => {
    for (const definition of ['bigserial', 'bigint GENERATED ALWAYS AS IDENTITY', 'bigint GENERATED BY DEFAULT AS IDENTITY', 'bigint GENERATED ALWAYS AS IDENTITY (INCREMENT BY -1 START WITH -1)']) {
      await runPgExec(url, `CREATE TABLE public.tern_export_keys(id ${definition} PRIMARY KEY)`);
      try {
        const descending = definition.includes('INCREMENT BY -1');
        const ids = descending ? [-7, -8] : [7, 8];
        await runPgExec(url, `INSERT INTO public.tern_export_keys OVERRIDING SYSTEM VALUE VALUES (${ids[0]}), (${ids[1]})`);
        const table = (await readPgSchema(url)).tables.find(t => t.schema === 'public' && t.name === 'tern_export_keys')!;
        const rows = (await runPgQuery(url, 'SELECT * FROM public.tern_export_keys', [])).rows;
        const sql = serializeRows('sql', ['id'], rows, table);
        await runPgExec(url, 'TRUNCATE public.tern_export_keys RESTART IDENTITY');
        for (const unit of splitSqlStatements(sql, 'postgres')) {
          expect(isWriteSql(unit.sql, 'postgres')).toBe(true);
          await runPgExec(url, unit.sql);
        }
        expect((await runPgQuery(url, 'SELECT id FROM public.tern_export_keys ORDER BY id', [])).rows.map(r => Number(r.id))).toEqual([...ids].sort((a,b) => a-b));
        await runPgExec(url, 'INSERT INTO public.tern_export_keys DEFAULT VALUES');
        expect((await runPgQuery(url, 'SELECT id FROM public.tern_export_keys WHERE id NOT IN (?, ?)', ids)).rows[0]?.id).toBe(descending ? "-9" : "9");
      } finally { await runPgExec(url, 'DROP TABLE public.tern_export_keys'); }
    }
  });

  test("DDL replay preserves multiple inheritance and inherited columns", async () => {
    await runPgExec(url, 'CREATE SCHEMA tern_inherits; CREATE TABLE tern_inherits.a(id integer CHECK(id > 0)); CREATE TABLE tern_inherits.b(note text); CREATE TABLE tern_inherits.child(extra boolean) INHERITS(tern_inherits.a, tern_inherits.b)');
    try {
      const child = (await readPgSchema(url)).tables.find(t => t.schema === 'tern_inherits' && t.name === 'child')!;
      expect(child.ddl).toContain('INHERITS (tern_inherits.a, tern_inherits.b)');
      await runPgExec(url, 'DROP TABLE tern_inherits.child');
      await runPgExec(url, child.ddl);
      await runPgExec(url, "INSERT INTO tern_inherits.child VALUES(1, 'test', true)");
      expect((await runPgQuery(url, 'SELECT id FROM tern_inherits.a', [])).rows).toEqual([{ id: 1 }]);
      await runPgExec(url, 'ALTER TABLE tern_inherits.a ADD COLUMN inherited integer');
      expect((await readPgSchema(url)).tables.find(t => t.name === 'child' && t.schema === 'tern_inherits')?.columns.some(c => c.name === 'inherited')).toBe(true);
      await runPgExec(url, 'ALTER TABLE tern_inherits.a DROP COLUMN id');
      expect((await readPgSchema(url)).tables.find(t => t.name === 'child' && t.schema === 'tern_inherits')?.columns.some(c => c.name === 'id')).toBe(false);
    } finally { await runPgExec(url, 'DROP SCHEMA tern_inherits CASCADE'); }
  });

  test("writable scripts retain temporary tables and search_path on one session", async () => {
    await runPgExec(url, 'CREATE SCHEMA tern_session_test');
    try {
      await runPgExec(url, 'SET search_path = tern_session_test; CREATE TEMP TABLE scratch(id integer); INSERT INTO scratch VALUES(42); CREATE TABLE saved AS SELECT * FROM scratch');
      expect((await runPgQuery(url, 'SELECT * FROM tern_session_test.saved', [])).rows).toEqual([{ id: 42 }]);
    } finally { await runPgExec(url, 'DROP SCHEMA tern_session_test CASCADE'); }
  });

  test("sequence-changing SELECTs execute after writable classification", async () => {
    await runPgExec(url, 'CREATE SEQUENCE public.tern_route_sequence');
    try {
      for (const sql of ["SELECT nextval('public.tern_route_sequence')", "SELECT setval('public.tern_route_sequence', 10)"]) {
        expect(isWriteSql(sql, 'postgres')).toBe(true);
        await runPgExec(url, sql);
      }
      expect((await runPgQuery(url, 'SELECT last_value::integer AS n FROM public.tern_route_sequence', [])).rows).toEqual([{ n: 10 }]);
    } finally { await runPgExec(url, 'DROP SEQUENCE public.tern_route_sequence'); }
  });

  test("DDL withholds RLS tables and preserves complete identity options", async () => {
    await runPgExec(url, `CREATE SCHEMA tern_security_ddl;
      CREATE TABLE tern_security_ddl.protected(id integer);
      ALTER TABLE tern_security_ddl.protected ENABLE ROW LEVEL SECURITY;
      ALTER TABLE tern_security_ddl.protected FORCE ROW LEVEL SECURITY;
      CREATE POLICY visible ON tern_security_ddl.protected USING (id > 0);
      CREATE TABLE tern_security_ddl.ids(id bigint GENERATED ALWAYS AS IDENTITY (START WITH 7 INCREMENT BY 2 MINVALUE 3 MAXVALUE 99 CACHE 5 CYCLE))`);
    try {
      const schema = await readPgSchema(url);
      expect(schema.tables.find(t => t.schema === 'tern_security_ddl' && t.name === 'protected')?.ddl).toBe('');
      await runPgExec(url, 'ALTER TABLE tern_security_ddl.protected DISABLE ROW LEVEL SECURITY; ALTER TABLE tern_security_ddl.protected NO FORCE ROW LEVEL SECURITY');
      expect((await readPgSchema(url)).tables.find(t => t.schema === 'tern_security_ddl' && t.name === 'protected')?.ddl).toBe('');
      const ddl = schema.tables.find(t => t.schema === 'tern_security_ddl' && t.name === 'ids')!.ddl;
      await runPgExec(url, 'DROP TABLE tern_security_ddl.ids');
      await runPgExec(url, ddl);
      const result = await runPgQuery(url, `SELECT seqstart::text, seqincrement::text, seqmin::text, seqmax::text, seqcache::text, seqcycle FROM pg_sequence WHERE seqrelid = pg_get_serial_sequence('tern_security_ddl.ids','id')::regclass`, []);
      expect(result.rows).toEqual([{ seqstart: '7', seqincrement: '2', seqmin: '3', seqmax: '99', seqcache: '5', seqcycle: true }]);
    } finally { await runPgExec(url, 'DROP SCHEMA tern_security_ddl CASCADE'); }
  });

  test("partition DDL restores bounds and routing", async () => {
    await runPgExec(url, 'CREATE SCHEMA tern_partition_test; CREATE TABLE tern_partition_test.parent(id integer) PARTITION BY RANGE(id); CREATE TABLE tern_partition_test.child PARTITION OF tern_partition_test.parent FOR VALUES FROM(0) TO(10)');
    try {
      const schema = await readPgSchema(url);
      const parent = schema.tables.find(t => t.schema === 'tern_partition_test' && t.name === 'parent')!;
      const child = schema.tables.find(t => t.schema === 'tern_partition_test' && t.name === 'child')!;
      await runPgExec(url, 'DROP TABLE tern_partition_test.parent CASCADE');
      await runPgExec(url, parent.ddl + child.ddl);
      await runPgExec(url, 'INSERT INTO tern_partition_test.parent VALUES(5)');
      expect((await runPgQuery(url, 'SELECT id FROM tern_partition_test.child', [])).rows).toEqual([{ id: 5 }]);
      await expect(runPgExec(url, 'INSERT INTO tern_partition_test.child VALUES(20)')).rejects.toThrow();
    } finally { await runPgExec(url, 'DROP SCHEMA tern_partition_test CASCADE'); }
  });

  test("catalog preserves empty relations and unpopulated materialized views", async () => {
    await runPgExec(url, 'CREATE SCHEMA tern_empty_test; CREATE TABLE tern_empty_test.marker (); INSERT INTO tern_empty_test.marker DEFAULT VALUES; CREATE MATERIALIZED VIEW tern_empty_test.pending AS SELECT 1 AS n WITH NO DATA');
    try {
      const schema = await readPgSchema(url);
      const marker = schema.tables.find(t => t.schema === 'tern_empty_test' && t.name === 'marker')!;
      expect(marker.columns).toEqual([]);
      expect((await runPgQuery(url, 'SELECT * FROM tern_empty_test.marker', [])).rows).toEqual([{}]);
      const pending = schema.tables.find(t => t.schema === 'tern_empty_test' && t.name === 'pending')!;
      expect(pending.ddl).toContain('WITH NO DATA');
      await runPgExec(url, 'DROP TABLE tern_empty_test.marker; DROP MATERIALIZED VIEW tern_empty_test.pending');
      await runPgExec(url, marker.ddl + pending.ddl);
      expect((await runPgQuery(url, "SELECT ispopulated FROM pg_matviews WHERE schemaname='tern_empty_test' AND matviewname='pending'", [])).rows).toEqual([{ ispopulated: false }]);
    } finally { await runPgExec(url, 'DROP SCHEMA tern_empty_test CASCADE'); }
  });

  test("query refuses write statements", async () => {
    await expect(runPgQuery(url, `DELETE FROM ${T}`, [], 100)).rejects.toBeInstanceOf(DbError);
  });

  test("bad connection surfaces a DbError", async () => {
    await expect(readPgSchema("postgres://nobody:nobody@127.0.0.1:1/none")).rejects.toBeInstanceOf(DbError);
  });
});


test('public foreign-key targets remain schema-qualified', () => {
  const metadata = collectPgKeyMetadata([{ table_schema: 'audit', table_name: 'events', column_name: 'actor_id', constraint_type: 'FOREIGN KEY', ref_schema: 'public', ref_table: 'users', ref_column: 'id' }]);
  expect(metadata.foreign.get('audit\0events\0actor_id')).toEqual(['public.users(id)']);
});

test('dotted foreign-key targets use the same quoted identity as documents', () => {
  const metadata = collectPgKeyMetadata([{ table_schema: 'audit', table_name: 'events', column_name: 'actor_id', constraint_type: 'FOREIGN KEY', ref_schema: 'a.b', ref_table: 'c', ref_column: 'id' }]);
  expect(metadata.foreign.get('audit\0events\0actor_id')).toEqual(['"a.b"."c"(id)']);
});

test.skipIf(!process.env.TEST_PG_URL)("PostgreSQL export uses one bounded result beyond the page cap", async () => {
  const url = process.env.TEST_PG_URL!;
  const sql = 'SELECT generate_series(1, ?::integer) AS n';
  const result = await runPgQuery(url, sql, [100_000], undefined, undefined, undefined, undefined, true);
  expect(result.rows).toHaveLength(100_000);
  expect(result.rows[99_999]).toEqual({ n: 100_000 });
  expect(result.hasMore).toBe(false);
  expect((await runPgQuery(url, sql, [100_001], undefined, undefined, undefined, undefined, true)).hasMore).toBe(true);
});
