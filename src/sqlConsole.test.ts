import { describe, expect, test } from "bun:test";
import { firstSqlVerb, isWriteSql, splitSqlStatements, sqlToRun, executionUnits } from "./sqlConsole.ts";

describe("SQL console statement selection", () => {
  test("splits scripts without breaking quoted or commented semicolons", () => {
    const sql = `SELECT ';'; -- keep ;\nSELECT $$a;b$$; /* ; */ UPDATE t SET n = 1;`;
    expect(splitSqlStatements(sql, "postgres").map((statement) => statement.sql)).toEqual([
      `SELECT ';'`,
      `-- keep ;\nSELECT $$a;b$$`,
      `/* ; */ UPDATE t SET n = 1`,
    ]);
  });

  test("runs selection, current statement, or all", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    expect(sqlToRun(sql, { from: 12, to: 12 }, false)).toEqual(["SELECT 2"]);
    expect(sqlToRun(sql, { from: 0, to: 8 }, false)).toEqual(["SELECT 1"]);
    expect(sqlToRun(sql, { from: 0, to: 0 }, true)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  test("runs the final statement after its terminating semicolon", () => {
    for (const sql of ["SELECT 1;", "SELECT 1; SELECT 2;", "SELECT 1; SELECT 2;\n  "]) {
      expect(sqlToRun(sql, { from: sql.length, to: sql.length }, false)).toEqual([sql.includes("SELECT 2") ? "SELECT 2" : "SELECT 1"]);
    }
  });

  test("routes procedural and metadata commands through writable execution", () => {
    for (const sql of ["CALL refresh_data()", "DO $$ BEGIN NULL; END $$", "COMMENT ON TABLE users IS 'Users'"]) {
      expect(isWriteSql(sql)).toBe(true);
    }
    expect(isWriteSql("SELECT 'CALL DO COMMENT'")).toBe(false);
  });

  test("finds the first verb after comments", () => {
    expect(firstSqlVerb("-- note\n/* plan */ UPDATE users SET n=1")).toBe("UPDATE");
  });

  test("detects writes inside CTEs without matching comments or strings", () => {
    expect(isWriteSql("WITH changed AS (UPDATE users SET active = 1 RETURNING *) SELECT * FROM changed")).toBe(true);
    expect(isWriteSql("SELECT 'DELETE', \"UPDATE\" FROM users -- DROP TABLE users")).toBe(false);
  });
});

test('read-query identifiers are not metadata commands', () => {
  expect(isWriteSql('SELECT comment FROM posts')).toBe(false);
  expect(isWriteSql('WITH rows AS (SELECT merge FROM posts) SELECT merge FROM rows')).toBe(false);
  expect(isWriteSql('WITH rows AS (SELECT 1) UPDATE posts SET comment = 1')).toBe(true);
  expect(isWriteSql('WITH rows AS (SELECT comment FROM posts) SELECT comment FROM rows')).toBe(false);
});

test('SQLite trigger bodies stay intact for Run and Run all', () => {
  const trigger = `CREATE TEMP TRIGGER audit AFTER INSERT ON posts BEGIN
    UPDATE posts SET comment = CASE WHEN new.id = 1 THEN 'a;b' ELSE 'c' END;
    INSERT INTO logs VALUES ('done');
  END`;
  const script = `${trigger}; SELECT 1;`;
  expect(splitSqlStatements(script).map(s => s.sql)).toEqual([trigger, 'SELECT 1']);
  expect(sqlToRun(script, { from: script.indexOf('INSERT INTO logs'), to: script.indexOf('INSERT INTO logs') }, false)).toEqual([trigger]);
});

test('non-read operations use writable execution without a verb allowlist', () => {
  for (const sql of ['ANALYZE users', 'CLUSTER users', 'REFRESH MATERIALIZED VIEW summary', 'SET search_path TO public', 'REASSIGN OWNED BY old TO new']) expect(isWriteSql(sql)).toBe(true);
  for (const sql of ['SHOW search_path', 'SELECT analyze FROM users', 'VALUES (1)', '-- empty']) expect(isWriteSql(sql)).toBe(false);
});

test('PRAGMA mutations use exec while catalog argument forms remain reads', () => {
  for (const sql of ['PRAGMA user_version = 7', 'PRAGMA journal_mode = WAL', 'PRAGMA main.user_version(7)', 'PRAGMA foreign_keys(ON)']) expect(isWriteSql(sql)).toBe(true);
  for (const sql of ['PRAGMA user_version', "PRAGMA table_info('users')", 'PRAGMA main.index_list(users)', "PRAGMA table_info('a=b')"]) expect(isWriteSql(sql)).toBe(false);
});

test('PostgreSQL nested comments preserve statement boundaries and operation classification', () => {
  const query = '/* outer /* inner */ still ; commented */ SELECT 1';
  expect(splitSqlStatements(`${query}; SELECT 2;`, 'postgres').map(s => s.sql)).toEqual([query, 'SELECT 2']);
  expect(sqlToRun(`${query};`, { from: query.length, to: query.length }, false, 'postgres')).toEqual([query]);
  expect(isWriteSql(query, 'postgres')).toBe(false);
  expect(splitSqlStatements('SELECT 1; /* outer /* inner */ SELECT 2;', 'sqlite')).toHaveLength(2);
});


test('transaction scripts remain one execution unit and incomplete transactions fail before execution', () => {
  const script = 'BEGIN; UPDATE t SET v=2; SELECT missing FROM t; ROLLBACK;';
  expect(executionUnits(sqlToRun(script, { from: 0, to: 0 }, true), 'sqlite')).toEqual({ statements: ['BEGIN;\nUPDATE t SET v=2;\nSELECT missing FROM t;\nROLLBACK;'], transaction: true, readOnly: false });
  for (const sql of ['BEGIN', 'COMMIT', 'SAVEPOINT s']) expect(() => executionUnits([sql], 'postgres')).toThrow('transaction');
});

test('read-only transaction batches skip the writable requirement', () => {
  expect(executionUnits(['BEGIN READ ONLY', 'SELECT 1', 'COMMIT'], 'postgres')).toEqual({ statements: ['BEGIN READ ONLY;\nSELECT 1;\nCOMMIT;'], transaction: true, readOnly: true });
  expect(executionUnits(['BEGIN', 'SELECT 1', 'COMMIT'], 'sqlite')).toEqual({ statements: ['BEGIN;\nSELECT 1;\nCOMMIT;'], transaction: true, readOnly: true });
  expect(executionUnits(['BEGIN', "SELECT replace('abc', 'a', 'z')", 'COMMIT'], 'sqlite').readOnly).toBe(true);
  expect(executionUnits(['BEGIN', 'UPDATE t SET v=1', 'COMMIT'], 'sqlite').readOnly).toBe(false);
  expect(executionUnits(['BEGIN', 'PRAGMA user_version = 7', 'COMMIT'], 'sqlite').readOnly).toBe(false);
});

test('PostgreSQL escape strings retain escaped quotes and semicolons', () => {
  const first = "SELECT E'it\\'s; ok'";
  expect(splitSqlStatements(`${first}; SELECT 1;`, 'postgres').map(s => s.sql)).toEqual([first, 'SELECT 1']);
  expect(isWriteSql(first, 'postgres')).toBe(false);
});


test('transaction chains require a final terminator', () => {
  expect(() => executionUnits(['BEGIN', 'COMMIT AND CHAIN', 'SELECT 1'], 'postgres')).toThrow('complete transaction');
  expect(executionUnits(['BEGIN', 'COMMIT AND CHAIN', 'SELECT 1', 'COMMIT'], 'postgres').transaction).toBe(true);
  expect(executionUnits(['BEGIN', 'ROLLBACK AND NO CHAIN'], 'postgres').transaction).toBe(true);
});

test('PostgreSQL EXPLAIN routes underlying writes through writable execution', () => {
  expect(isWriteSql('EXPLAIN ANALYZE UPDATE t SET n=n+1', 'postgres')).toBe(true);
  expect(isWriteSql('EXPLAIN (ANALYZE TRUE, FORMAT JSON) DELETE FROM t', 'postgres')).toBe(true);
  expect(isWriteSql('EXPLAIN ANALYZE WITH changed AS (DELETE FROM t RETURNING *) SELECT * FROM changed', 'postgres')).toBe(true);
  expect(isWriteSql('EXPLAIN ANALYZE SELECT "update" FROM t', 'postgres')).toBe(false);
  expect(isWriteSql('EXPLAIN QUERY PLAN UPDATE t SET n=1', 'sqlite')).toBe(false);
});

test("comment-only fragments never execute, including trailing cursor comments", () => {
  for (const dialect of ["sqlite", "postgres"] as const) {
    const sql = "SELECT 1; -- explanation\n/* trailing */";
    expect(sqlToRun(sql, { from: sql.length, to: sql.length }, true, dialect)).toEqual(["SELECT 1"]);
    expect(sqlToRun(sql, { from: sql.length, to: sql.length }, false, dialect)).toEqual(["SELECT 1"]);
    expect(splitSqlStatements("-- only\n/* comment */;", dialect)).toEqual([]);
    expect(splitSqlStatements("SELECT 1; /* comment */; SELECT 2;", dialect).map(s => s.sql)).toEqual(["SELECT 1", "SELECT 2"]);
  }
});

test("WITH-prefixed SQLite REPLACE uses the write route", () => {
  expect(isWriteSql("WITH x AS (SELECT 2) REPLACE INTO t SELECT * FROM x", "sqlite")).toBe(true);
});

test("PostgreSQL SELECT INTO uses writable execution including CTE and EXPLAIN", () => {
  for (const sql of ["SELECT * INTO archive FROM users", "WITH x AS (SELECT 1) SELECT * INTO archive FROM x", "EXPLAIN ANALYZE SELECT * INTO archive FROM users"]) {
    expect(isWriteSql(sql, "postgres")).toBe(true);
  }
  expect(isWriteSql('SELECT "INTO", \'INTO\' FROM users /* INTO */', "postgres")).toBe(false);
  expect(isWriteSql("SELECT (SELECT 1 AS x) FROM users", "postgres")).toBe(false);
});

test("PostgreSQL locking SELECT clauses require writable execution", () => {
  for (const lock of ["UPDATE", "NO KEY UPDATE", "SHARE", "KEY SHARE"]) {
    expect(isWriteSql("SELECT * FROM jobs FOR " + lock, "postgres")).toBe(true);
    expect(isWriteSql("WITH x AS (SELECT 1) SELECT * FROM jobs FOR " + lock, "postgres")).toBe(true);
  }
  expect(isWriteSql("WITH locked AS (SELECT * FROM jobs FOR UPDATE) SELECT * FROM locked", "postgres")).toBe(true);
  expect(isWriteSql("EXPLAIN ANALYZE SELECT * FROM jobs FOR UPDATE", "postgres")).toBe(true);
  expect(isWriteSql("SELECT 'FOR UPDATE' /* FOR SHARE */", "postgres")).toBe(false);
});

test('SQLite dollar parameters do not swallow statement boundaries', () => {
  const sql = 'SELECT $a$; DELETE FROM users; SELECT $a$;';
  expect(splitSqlStatements(sql, 'sqlite').map(s => s.sql)).toEqual(['SELECT $a$', 'DELETE FROM users', 'SELECT $a$']);
  expect(splitSqlStatements(sql, 'postgres')).toHaveLength(1);
});

test('stateful writable batches stay on one execution connection', () => {
  expect(executionUnits(['CREATE TEMP TABLE t(id integer)', 'SELECT * FROM t'], 'sqlite')).toEqual({ statements: ['CREATE TEMP TABLE t(id integer);\nSELECT * FROM t;'], transaction: true, readOnly: false });
  expect(executionUnits(['SET search_path TO app', 'SELECT * FROM t'], 'postgres').statements).toHaveLength(1);
  expect(executionUnits(['SELECT 1', 'SELECT 2'], 'postgres').transaction).toBe(false);
});

test('tables named trigger are not parsed as trigger bodies', () => {
  expect(splitSqlStatements('CREATE TABLE trigger (begin integer); INSERT INTO trigger VALUES(1); COMMIT;', 'sqlite').map(s => s.sql))
    .toEqual(['CREATE TABLE trigger (begin integer)', 'INSERT INTO trigger VALUES(1)', 'COMMIT']);
});

test("routes bare maintenance PRAGMAs and sequence calls to writable execution", () => {
  for (const name of ['incremental_vacuum', 'optimize', 'wal_checkpoint', 'shrink_memory']) {
    expect(isWriteSql(`PRAGMA ${name}`)).toBe(true);
    expect(isWriteSql(`PRAGMA main.${name}`)).toBe(true);
  }
  for (const sql of ["SELECT nextval('seq')", "SELECT pg_catalog.setval('seq', 10)", `SELECT pg_catalog."nextval"('seq')`, "WITH n AS (SELECT nextval('seq')) SELECT * FROM n"]) expect(isWriteSql(sql, 'postgres')).toBe(true);
  expect(isWriteSql("SELECT 'nextval(seq)'", 'postgres')).toBe(false);
  expect(isWriteSql("SELECT currval('seq')", 'postgres')).toBe(false);
});

test('ambiguous BEGIN identifiers in trigger headers cannot swallow following statements', () => {
  for (const header of ['CREATE TRIGGER begin AFTER INSERT ON t', 'CREATE TRIGGER tr AFTER INSERT ON begin', 'CREATE TRIGGER tr AFTER INSERT ON t WHEN new.begin > 0']) {
    expect(() => splitSqlStatements(`${header} BEGIN SELECT 1; END; COMMIT;`, 'sqlite')).toThrow('Ambiguous trigger BEGIN');
  }
  expect(splitSqlStatements('CREATE TRIGGER "begin" AFTER INSERT ON "begin" BEGIN SELECT CASE WHEN 1 THEN 1 END; END; SELECT 1;', 'sqlite')).toHaveLength(2);
});

test("PostgreSQL TABLE shorthand is read-only unless it locks rows", () => {
  expect(isWriteSql('TABLE public.users', 'postgres')).toBe(false);
  expect(isWriteSql('TABLE public.users FOR UPDATE', 'postgres')).toBe(true);
  expect(isWriteSql('TABLE public.users', 'sqlite')).toBe(true);
});
