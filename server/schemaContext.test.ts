import { expect, test } from 'bun:test';
import { applyPgSchema, readPgSchema, runPgQuery, runPgExec, explainPgQuery, runPgMigration } from './pgServer.ts';

test('schema context is parameterized and validates existence and USAGE before setting search_path', async () => {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const connection = { unsafe: async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return [{ nspname: 'x' }]; } } as unknown as Parameters<typeof applyPgSchema>[0];
  await applyPgSchema(connection, 'Odd " Schema');
  expect(calls[0].params).toEqual(['Odd " Schema']);
  expect(calls[0].sql).toContain('has_schema_privilege');
  expect(calls[1].sql).toBe("SELECT pg_catalog.set_config('search_path', $1, false)");
  expect(calls[1].params).toEqual(['"Odd "" Schema", pg_temp']);
  await applyPgSchema(connection);
  expect(calls).toHaveLength(2);
  for (const schema of ['', '\0', 'a'.repeat(64), '界'.repeat(22)]) await expect(applyPgSchema(connection, schema)).rejects.toThrow('Invalid schema');
  const unavailable = { unsafe: async () => [] } as unknown as Parameters<typeof applyPgSchema>[0];
  await expect(applyPgSchema(unavailable, 'missing')).rejects.toThrow('not accessible');
});

const PG = process.env.TEST_PG_URL;
const live = PG ? test : test.skip;
live('schema discovery, concurrent execution, scripts, explain, pagination, export and migrations keep their schema', async () => {
  const url = PG!;
  const a = 'tern_schema_a', b = 'tern_schema_b', empty = 'tern_schema_empty', odd = 'Tern " Odd';
  const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
  const query = (schema: string, sql = 'SELECT value FROM items ORDER BY value', limit = 10, offset = 0, exportAll = false) => runPgQuery(url, sql, [], limit, offset, undefined, undefined, exportAll, schema);
  await runPgExec(url, [a, b, empty, odd].map(s => `CREATE SCHEMA ${quote(s)}`).join(';'));
  try {
    for (const [name, value] of [[a, 1], [b, 10], [odd, 100]] as const) {
      await runPgExec(url, `CREATE TABLE items(value int); INSERT INTO items VALUES (${value}), (${value + 1})`, undefined, undefined, false, name);
    }
    const catalog = await readPgSchema(url);
    for (const name of [a, b, empty, odd]) expect(catalog.schemas).toContain(name);
    expect(catalog.tables.some(t => t.schema === 'pg_catalog')).toBe(false);
    expect((await readPgSchema(url, true)).tables.some(t => t.schema === 'pg_catalog')).toBe(true);
    const results = await Promise.all([query(a), query(b), query(odd), query(a)]);
    expect(results.map(r => r.rows[0].value)).toEqual([1, 10, 100, 1]);
    expect((await query(b, undefined, 1, 1)).rows).toEqual([{ value: 11 }]);
    expect((await query(b, undefined, 1, 0, true)).rows).toHaveLength(2);
    expect((await query(a, `SELECT value FROM ${b}.items ORDER BY value`)).rows[0].value).toBe(10);
    await expect(query(empty)).rejects.toThrow();
    await expect(query('tern_schema_missing')).rejects.toThrow('not accessible');
    expect((await explainPgQuery(url, 'SELECT * FROM items', [], undefined, undefined, b)).rows).toHaveLength(1);
    await runPgExec(url, 'BEGIN; INSERT INTO items VALUES(99); ROLLBACK; INSERT INTO items VALUES(3)', undefined, undefined, false, a);
    expect((await query(a)).rows.map(r => r.value)).toEqual([1, 2, 3]);
    const migration = 'CREATE TABLE migrated(id int)';
    await runPgMigration(url, migration, false, undefined, b);
    expect((await query(b, "SELECT to_regclass('migrated')::text AS name")).rows[0].name).toBeNull();
    await runPgMigration(url, migration, true, undefined, b);
    expect((await query(b, "SELECT to_regclass('migrated')::text AS name")).rows[0].name).toBe('migrated');
    expect((await query(a, "SELECT to_regclass('migrated')::text AS name")).rows[0].name).toBeNull();
    await expect(runPgExec(url, 'INSERT INTO items VALUES(9)', undefined, undefined, true, b)).rejects.toThrow();
    await expect(query(a, 'SELECT * FROM nonexistent')).rejects.toThrow();
    expect((await query(b)).rows[0].value).toBe(10);
  } finally { await runPgExec(url, [a, b, empty, odd].map(s => `DROP SCHEMA ${quote(s)} CASCADE`).join(';')); }
}, 30000);
