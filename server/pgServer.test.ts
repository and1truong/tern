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
  expect(metadata.foreign.get("audit\0events\0tenant_id")).toBe("core.users(tenant_id)");
  expect(metadata.foreign.get("audit\0events\0actor_id")).toBe("core.users(id)");
});

// Integration tests require a live Postgres. Set TEST_PG_URL to enable, e.g.
//   TEST_PG_URL=postgres://postgres:pw@localhost:5432/postgres bun test pgServer
const PG = process.env.TEST_PG_URL;
const pgDescribe = PG ? describe : describe.skip;

pgDescribe("pgServer (live)", () => {
  const url = PG!;
  const T = "pgserver_test_t";

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
        amount integer CHECK (amount > 0), span int4range, EXCLUDE USING gist (span WITH &&)
      )`);
      const table = (await readPgSchema(url)).tables.find(t => t.schema === 'pgserver_constraints_test' && t.name === 'original')!;
      await runPgExec(url, table.ddl!.replace('"original"', '"copy"'));
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

  test("query refuses write statements", async () => {
    await expect(runPgQuery(url, `DELETE FROM ${T}`, [], 100)).rejects.toBeInstanceOf(DbError);
  });

  test("bad connection surfaces a DbError", async () => {
    await expect(readPgSchema("postgres://nobody:nobody@127.0.0.1:1/none")).rejects.toBeInstanceOf(DbError);
  });
});


test('public foreign-key targets remain schema-qualified', () => {
  const metadata = collectPgKeyMetadata([{ table_schema: 'audit', table_name: 'events', column_name: 'actor_id', constraint_type: 'FOREIGN KEY', ref_schema: 'public', ref_table: 'users', ref_column: 'id' }]);
  expect(metadata.foreign.get('audit\0events\0actor_id')).toBe('public.users(id)');
});

test('dotted foreign-key targets use the same quoted identity as documents', () => {
  const metadata = collectPgKeyMetadata([{ table_schema: 'audit', table_name: 'events', column_name: 'actor_id', constraint_type: 'FOREIGN KEY', ref_schema: 'a.b', ref_table: 'c', ref_column: 'id' }]);
  expect(metadata.foreign.get('audit\0events\0actor_id')).toBe('"a.b"."c"(id)');
});
